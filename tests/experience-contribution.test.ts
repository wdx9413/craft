import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExperienceContribution } from "../capability/craft-experience/contribution.ts";
import { ExperienceLedgerKernel } from "../capability/craft-experience/experience-ledger.ts";
import { CRAFT_CAPABILITIES } from "../src/capability-catalog.ts";
import { buildCapabilityRegistry, CORE_KERNELS } from "../src/capability-protocol.ts";
import { ContextResolutionKernel } from "../src/context-resolution.ts";
import { CraftStore } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { PROVIDER_CATALOG } from "../src/model-gateway.ts";

/**
 * The experience read side, and the two ways it could go wrong.
 *
 * One is **leaking instructions**: the ledger is `content_free` and `execution_visible: false`, so
 * a contribution that carried a hypothesis would be handing a Host guidance the module says it
 * must not receive. The other is **having no caller**: a provider nothing invokes is the same
 * defect `runPhase` had before it was wired, so the last test goes through `resolve` and asserts the
 * contribution appears in the receipt.
 */

/** A pattern's identity is digests, and the prose is never stored — that is the module's design. */
function pattern(store: CraftStore, args: { id: string; scenario: string; kind?: string; evidence?: number; scope?: { kind: string; id: string } }): void {
  const observationRefs = Array.from({ length: args.evidence ?? 2 }, (_, index) => ({ id: `${args.id}-obs-${index}`, version: 1 }));
  store.create("experience_pattern", args.id, {
    scenario_key: args.scenario,
    kind: args.kind ?? "failure_pattern",
    observation_refs: observationRefs,
    hypothesis_digest: `sha256:hypothesis-${args.id}`,
    applicability_digest: `sha256:applicability-${args.id}`,
    counterexample_digest: `sha256:counterexample-${args.id}`,
    evidence_ids: ["confirmed"],
    ...(args.scope === undefined ? { scope: { kind: "project", id: "p" } } : { scope: args.scope }),
    status: "diagnostic_only",
    execution_visible: false,
    content_free: true,
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-contribution-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const core: Record<string, unknown> = { [CORE_KERNELS.store]: store, [CORE_KERNELS.modelProviders]: PROVIDER_CATALOG };
  return { root, store, core, contribution: new ExperienceContribution(store) };
}
async function close(f: { store: CraftStore; root: string }) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}
const request = (query: string, overrides: Partial<{ max_items: number; max_chars: number }> = {}) => ({
  query, scope_kind: "project" as const, scope_id: "p", max_items: 5, max_chars: 4_000, ...overrides,
});

test("v0.12.43 contributes which experience applies, and never what it says", async () => {
  const f = await fixture();
  try {
    pattern(f.store, { id: "p1", scenario: "coding.verification" });
    const contributed = await f.contribution.contribute(request("verification"));
    assert.equal(contributed.member, "experience");
    assert.equal(contributed.items.length, 1);
    const item = contributed.items[0]!;
    // A reference, a kind, and provenance. Every field here is either an identifier, a count, or a
    // digest of text that Craft does not hold.
    assert.equal(item.pattern_id, "p1");
    assert.equal(item.pattern_version, 1);
    assert.equal(item.scenario_key, "coding.verification");
    assert.equal(item.pattern_kind, "failure_pattern");
    assert.equal(item.observation_count, 2);
    assert.equal(item.evidence_count, 1);
    assert.equal(item.requires_governed_route, true);
    // The two flags are read from the record rather than asserted, so if the ledger ever marks a
    // pattern execution-visible this reflects it instead of contradicting it.
    assert.equal(item.status, "diagnostic_only");
    assert.equal(item.execution_visible, false);
    assert.deepEqual(item.accepted_intervention_ids, []);
    // The digests travel; the text they digest does not exist.
    assert.equal(item.hypothesis_digest, "sha256:hypothesis-p1");
    assert.equal(item.applicability_digest, "sha256:applicability-p1");

    // The assertion that matters, written as an absence: no item may carry the prose, and none of
    // the three fields a compiler supplied may appear under its own name.
    const serialized = JSON.stringify(contributed.items);
    for (const forbidden of ["hypothesis", "applicability", "counterexample", "diff_summary"]) {
      assert.equal(Object.keys(item).some((key) => key === forbidden), false, `${forbidden} must not be a field`);
      assert.equal(serialized.includes(`"${forbidden}"`), false, `${forbidden} must not be serialized`);
    }
    // And nothing the ledger does not hold can appear: the record itself has no such keys.
    const stored = f.store.get("experience_pattern", "p1");
    for (const key of ["hypothesis", "applicability", "counterexample"]) assert.equal(stored[key], undefined, `${key} is not stored`);
    assert.equal(stored.content_free, true);
  } finally { await close(f); }
});

test("v0.12.43 matches on the scenario and reports what the budget dropped", async () => {
  const f = await fixture();
  try {
    pattern(f.store, { id: "a", scenario: "deploy.rollback" });
    pattern(f.store, { id: "b", scenario: "deploy.rollback" });
    pattern(f.store, { id: "c", scenario: "deploy.rollback" });
    pattern(f.store, { id: "unrelated", scenario: "unrelated.scenario" });

    // A scenario is matched by term, and the unrelated one is not selected at all — it is neither
    // in the items nor counted as omitted, because the budget did not drop it.
    const all = await f.contribution.contribute(request("rollback"));
    assert.deepEqual(all.items.map((item) => item.pattern_id), ["a", "b", "c"]);
    assert.equal(all.omitted_count, 0);

    // The budget drops by stopping, not by truncating: a partial reference would be one that does
    // not resolve, and `omitted_count` is how a caller tells "nothing matched" from "too small".
    const bounded = await f.contribution.contribute(request("rollback", { max_items: 2 }));
    assert.equal(bounded.items.length, 2);
    assert.equal(bounded.omitted_count, 1);
    const charBound = await f.contribution.contribute(request("rollback", { max_chars: 1 }));
    assert.deepEqual(charBound.items, []);
    assert.equal(charBound.omitted_count, 3);

    // The receipt id is derived from what was selected, so it is reproducible and content-free.
    assert.equal((await f.contribution.contribute(request("rollback"))).receipt_id, all.receipt_id);
    assert.match(all.receipt_id, /^experience_contribution_a@1\+b@1\+c@1$/u);
    // The query itself is not carried. `scenario_key` is, because that is what the contribution is
    // *about* — and its text happens to contain the query term, which is why this asserts on the
    // absence of a query field rather than on the absence of the substring.
    assert.equal(Object.keys(all).includes("query"), false);
    assert.equal((all.items as Array<Record<string, unknown>>).every((item) => !("query" in item)), true);
    assert.equal(JSON.stringify(all).includes('"query"'), false);

    // A query with no word characters selects nothing rather than everything: an empty term list
    // must not be read as "matches any scenario", which would put the whole ledger in context.
    const noTerms = await f.contribution.contribute(request("!!!"));
    assert.deepEqual(noTerms.items, []);
    assert.equal(noTerms.omitted_count, 0);
  } finally { await close(f); }
});

test("v0.12.43 reports the accepted intervention rather than handing over its diff", async () => {
  const f = await fixture();
  try {
    pattern(f.store, { id: "signed", scenario: "deploy.rollback" });
    f.store.create("experience_intervention", "intervention-1", {
      pattern_refs: [{ id: "signed", version: 1 }],
      lifecycle: "accepted",
      diff_digest: "sha256:diff",
      hypothesis_digest: "sha256:hypothesis",
      execution_visible: false,
    });
    // An intervention for a *different* version is not this pattern's, so version is compared rather
    // than id alone — a reference that ignored the version would claim a signoff that is not there.
    f.store.create("experience_intervention", "intervention-other", {
      pattern_refs: [{ id: "signed", version: 2 }], lifecycle: "accepted", execution_visible: false,
    });
    f.store.create("experience_intervention", "intervention-draft", {
      pattern_refs: [{ id: "signed", version: 1 }], lifecycle: "draft", execution_visible: false,
    });

    const contributed = await f.contribution.contribute(request("rollback"));
    const item = contributed.items[0]!;
    // The consumer learns that something reached Signoff — which is what it needs in order to route
    // through a governed path — and not what the intervention changes.
    assert.deepEqual(item.accepted_intervention_ids, ["intervention-1"]);
    assert.equal(JSON.stringify(item).includes("diff_digest"), false);
    assert.equal(JSON.stringify(item).includes("sha256:diff"), false);
  } finally { await close(f); }
});

test("v0.12.43 reaches the contribution through resolve, so the read side has a caller", async () => {
  const f = await fixture();
  try {
    pattern(f.store, { id: "reachable", scenario: "deploy.rollback" });
    // Assembled the way the foundation assembles it: the provider comes from the capability, and the
    // resolver is handed it. A contribution nothing invokes would be the defect this test exists for.
    const { contributed } = buildCapabilityRegistry(CRAFT_CAPABILITIES, f.core);
    assert.deepEqual(contributed.map((provider) => provider.member), ["knowledge", "experience"]);
    const kernel = new ContextResolutionKernel(f.store, contributed);
    const resolved = await kernel.resolve({ query: "rollback", scope_kind: "project", scope_id: "p" });
    // Two different shapes, deliberately: `contributions` on the result is the **material** (the
    // items a caller may use), while the receipt keeps only a content-free summary of what was
    // selected. A receipt that carried the items would be storing retrieved content.
    const material = resolved.contributions as Array<{ member: string; receipt_id: string; items: unknown[] }>;
    assert.equal(material.length, 2);
    const experienceMaterial = material.find((item) => item.member === "experience")!;
    assert.equal(experienceMaterial.items.length, 1);
    const receipt = resolved.receipt as { contributions: Array<{ member: string; item_count: number }>; content_free: boolean };
    assert.equal(receipt.contributions.length, 2);
    assert.equal(receipt.contributions.find((item) => item.member === "experience")!.item_count, 1);
    assert.equal(receipt.content_free, true);
    assert.equal(JSON.stringify(receipt).includes("scenario_key"), false, "the receipt carries no material");

    // A core assembled without contributors resolves exactly as it did before contributions existed.
    const bare = await new ContextResolutionKernel(f.store).resolve({ query: "rollback", scope_kind: "project", scope_id: "p" });
    assert.deepEqual(bare.contributions, []);

    // Changing the compiled experience changes the selection, and asking for the same receipt again
    // is then a conflict rather than a stale replay.
    const first = await kernel.resolve({ receipt_id: "pinned", query: "rollback", scope_kind: "project", scope_id: "p" });
    assert.equal((first.contributions as unknown[]).length, 2);
    pattern(f.store, { id: "added", scenario: "deploy.rollback" });
    await assert.rejects(
      () => kernel.resolve({ receipt_id: "pinned", query: "rollback", scope_kind: "project", scope_id: "p" }),
      /idempotency conflict/u,
    );
  } finally { await close(f); }
});

test("v0.12.43 reflects an execution-visible pattern rather than asserting otherwise", async () => {
  const f = await fixture();
  try {
    // The two flags are read from the record, not hardcoded. A contribution that always reported
    // `execution_visible: false` would be right today by luck, and wrong the moment the ledger
    // changes its mind — which is the difference between reading a fact and restating a belief.
    pattern(f.store, { id: "visible", scenario: "deploy.rollback" });
    f.store.save("experience_pattern", "visible", { ...f.store.get("experience_pattern", "visible"), execution_visible: true });
    const item = (await f.contribution.contribute(request("rollback"))).items[0]!;
    assert.equal(item.execution_visible, true);
    // A pattern with no observation refs and no evidence is described as such rather than crashing:
    // the counts are the provenance, and zero is a real answer.
    f.store.create("experience_pattern", "bare", {
      scenario_key: "deploy.rollback", scope: { kind: "project", id: "p" }, kind: "success_strategy", status: "diagnostic_only", execution_visible: false,
    });
    const items = (await f.contribution.contribute(request("rollback"))).items;
    const bare = items.find((entry) => entry.pattern_id === "bare")!;
    assert.equal(bare.observation_count, 0);
    assert.equal(bare.evidence_count, 0);
    assert.deepEqual(bare.accepted_intervention_ids, []);
  } finally { await close(f); }
});

test("v0.12.43 keeps the ledger kernel and the contribution as separate surfaces", async () => {
  const f = await fixture();
  try {
    // Writing experience and reading it back are different capabilities' jobs by design: the ledger
    // produces diagnostics, and the contribution points at them. Both are part of the same package,
    // so nothing here may depend on the ledger's private helpers — only on what it stores.
    const ledger = new ExperienceLedgerKernel(f.store);
    assert.equal(typeof ledger.observe, "function");
    assert.equal(f.contribution.store, f.store);
    assert.equal(f.contribution.member, "experience");
    // A store with no patterns produces an empty contribution rather than an error, so a Host can
    // resolve context on a fresh install.
    const empty = await f.contribution.contribute(request("anything"));
    assert.deepEqual(empty, { member: "experience", items: [], receipt_id: "experience_contribution_none", omitted_count: 0 });
  } finally { await close(f); }
});

test("unscoped legacy experience stays diagnostic and never crosses into a project Context", async () => {
  const f = await fixture();
  try {
    pattern(f.store, { id: "legacy", scenario: "deploy.rollback", scope: undefined });
    // Explicitly remove scope after the helper's safe current default: this models a record
    // created before the scope field existed.
    f.store.save("experience_pattern", "legacy", { ...f.store.get("experience_pattern", "legacy"), scope: undefined });
    assert.deepEqual((await f.contribution.contribute(request("rollback"))).items, []);
  } finally { await close(f); }
});
