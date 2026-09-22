import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExperienceContribution } from "../capability/craft-experience/contribution.ts";
import { CRAFT_CAPABILITIES } from "../src/capability-catalog.ts";
import { buildCapabilityRegistry, CORE_KERNELS } from "../src/capability-protocol.ts";
import { ContextResolutionKernel } from "../src/context-resolution.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { PROVIDER_CATALOG } from "../src/model-gateway.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-contribution-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const core: Record<string, unknown> = { [CORE_KERNELS.store]: store, [CORE_KERNELS.modelProviders]: PROVIDER_CATALOG };
  return { root, store, core, contribution: new ExperienceContribution(store) };
}
async function close(f: { store: CraftStore; root: string }) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
const request = (query: string, overrides: Partial<{ max_items: number; max_chars: number }> = {}) => ({
  query, scope_kind: "project" as const, scope_id: "p", max_items: 5, max_chars: 4_000, ...overrides,
});

function procedure(store: CraftStore, args: { id: string; title: string; trigger: string; kind?: "workflow" | "graph" | "prompt"; lifecycle?: string; scope?: string }): JsonObject {
  const kind = args.kind ?? "workflow";
  const ref = store.contentStore.writeSync({
    kind: "experience", record_id: args.id, version: 1, title: args.title, folder: kind === "workflow" ? "workflows" : kind === "graph" ? "graphs" : "prompts",
    scope: args.scope ?? "project:p", status: args.lifecycle ?? "routeable", sensitivity: "internal", source_id: "fixture", body: `# ${args.title}\n\nUse this verified procedure.`,
  });
  return store.create("experience_procedure", args.id, {
    procedure_kind: kind, scope: args.scope ?? "project:p", trigger: args.trigger, title: args.title,
    acceptance_ref: "acceptance:fixture", scenario_signature: { project: "p", target_class: "fixture" },
    lifecycle: args.lifecycle ?? "routeable", routeable: (args.lifecycle ?? "routeable") === "routeable", content_ref: ref, content_digest: ref.digest,
  });
}

test("Experience is a Context member, but only routeable Procedure projections are injected", async () => {
  const f = await fixture();
  try {
    f.store.create("experience_pattern", "diagnostic", { scope: { kind: "project", id: "p" }, scenario_key: "coding.verification", status: "diagnostic_only", content_free: true });
    procedure(f.store, { id: "verified", title: "Terminal verification", trigger: "verification" });
    const contributed = await f.contribution.contribute(request("verification"));
    assert.equal(contributed.member, "experience");
    assert.equal(contributed.items.length, 1);
    const item = contributed.items[0]!;
    assert.equal(item.kind, "experience_procedure");
    assert.equal(item.procedure_id, "verified");
    assert.equal(item.content, undefined);
    assert.match(String(item.content_digest), /^sha256:/u);
    assert.equal(JSON.stringify(contributed).includes("diagnostic"), false);
  } finally { await close(f); }
});

test("Experience honors scope, query and budget without falling back to diagnostic history", async () => {
  const f = await fixture();
  try {
    procedure(f.store, { id: "a", title: "Rollback one", trigger: "rollback" });
    procedure(f.store, { id: "b", title: "Rollback two", trigger: "rollback" });
    procedure(f.store, { id: "other", title: "Other", trigger: "rollback", scope: "project:other" });
    const all = await f.contribution.contribute(request("rollback"));
    assert.deepEqual(all.items.map((item) => item.procedure_id), ["a", "b"]);
    assert.equal(all.omitted_count, 0);
    const bounded = await f.contribution.contribute(request("rollback", { max_items: 1 }));
    assert.equal(bounded.items.length, 1);
    assert.equal(bounded.omitted_count, 1);
    const tooSmall = await f.contribution.contribute(request("rollback", { max_chars: 1 }));
    assert.deepEqual(tooSmall.items, []);
    assert.equal(tooSmall.omitted_count, 2);
    assert.deepEqual((await f.contribution.contribute(request("!!!"))).items, []);
  } finally { await close(f); }
});

test("Experience reaches Context Resolution beside Knowledge and remains replayable", async () => {
  const f = await fixture();
  try {
    procedure(f.store, { id: "reachable", title: "Rollback", trigger: "rollback" });
    const { contributed } = buildCapabilityRegistry(CRAFT_CAPABILITIES, f.core);
    const kernel = new ContextResolutionKernel(f.store, contributed);
    const resolved = await kernel.resolve({ query: "rollback", scope_kind: "project", scope_id: "p" });
    const material = resolved.contributions as Array<{ member: string; items: JsonObject[] }>;
    assert.equal(material.find((item) => item.member === "experience")!.items[0]!.procedure_id, "reachable");
    const receipt = resolved.receipt as { contributions: Array<{ member: string; item_count: number }>; content_free: boolean };
    assert.equal(receipt.contributions.find((item) => item.member === "experience")!.item_count, 1);
    assert.equal(receipt.content_free, true);
    assert.equal(JSON.stringify(receipt).includes("Rollback"), false);
  } finally { await close(f); }
});

test("Fresh or candidate-only Experience produces an empty Context contribution", async () => {
  const f = await fixture();
  try {
    procedure(f.store, { id: "candidate", title: "Candidate", trigger: "anything", lifecycle: "candidate" });
    assert.deepEqual(await f.contribution.contribute(request("anything")), { member: "experience", items: [], receipt_id: "experience_contribution_none", omitted_count: 0 });
  } finally { await close(f); }
});
