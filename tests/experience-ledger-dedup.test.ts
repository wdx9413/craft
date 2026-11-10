import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import { ExperienceLedgerKernel } from "../capability/craft-experience/experience-ledger.ts";
import { ExperienceDeduplicationKernel } from "../core/experience-deduplication.ts";

test("propose is blocked when any pattern scenario combination has been refuted before", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-ledger-dedup-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const dedup = new ExperienceDeduplicationKernel(store);
    const ledger = new ExperienceLedgerKernel(store);
    store.create("workflow", "deploy", { name: "deploy workflow" });
    store.create("outcome", "outcome-one", { verdict: "failed" });
    store.create("outcome", "outcome-two", { verdict: "failed" });
    store.create("evidence", "confirmed", { confidence: "confirmed" });
    const first = ledger.observe({ source_ref: { kind: "outcome", id: "outcome-one", version: 1 }, kind: "failure", scenario_key: "deploy.retry", finding: "deploy stuck after retry", evidence_ids: ["confirmed"] }).observation as JsonObject;
    const second = ledger.observe({ source_ref: { kind: "outcome", id: "outcome-two", version: 1 }, kind: "correction", scenario_key: "deploy.retry", finding: "same stuck pattern again", evidence_ids: ["confirmed"] }).observation as JsonObject;
    const pattern = ledger.compile({ scenario_key: "deploy.retry", observation_ids: [first.id, second.id], kind: "failure_pattern", hypothesis: "retrying masks a deeper failure", applicability: "all deploy retries", counterexample: "none observed" }).pattern as JsonObject;

    dedup.record({ factors: ["deploy.retry"], pool: "workflow:deploy", verdict: "rejected", source: "pitfalls" });
    assert.throws(() => ledger.propose({ pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "deploy", version: 1 }, design_axes: ["context"], diff_summary: "retry once more", hypothesis: "another retry will pass" }), /refuted before/u);
    // The same pattern is allowed for a subject that has never been refuted.
    store.create("workflow", "build", { name: "build workflow" });
    const allowed = ledger.propose({ pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "build", version: 1 }, design_axes: ["context"], diff_summary: "retry once more", hypothesis: "another retry will pass" });
    assert.equal(allowed.idempotent, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("null scenario_key maps to default factor via nullish coalescing and is dedup-rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-ledger-dedup-null-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const dedup = new ExperienceDeduplicationKernel(store);
    const ledger = new ExperienceLedgerKernel(store);
    store.create("workflow", "deploy", { name: "deploy workflow" });
    // Insert a pattern record directly with null scenario_key to hit the
    // nullish-coalescing branch of p.scenario_key ?? "".
    const pattern = store.create("experience_pattern", "pattern-null-key", {
      scenario_key: null,
      kind: "failure_pattern",
      status: "diagnostic_only",
      execution_visible: false,
      hypothesis_digest: stableDigest("h"),
      applicability_digest: stableDigest("a"),
      counterexample_digest: stableDigest("c"),
      observation_refs: [{ id: "obs-1", version: 1 }],
      evidence_ids: [],
      identity_digest: stableDigest({ scenario_key: null, kind: "failure_pattern" }),
    }) as JsonObject;
    dedup.record({ factors: ["default"], pool: "workflow:deploy", verdict: "rejected", source: "pitfalls" });
    assert.throws(() => ledger.propose({ pattern_ids: [pattern.id], subject_ref: { kind: "workflow", id: "deploy", version: 1 }, design_axes: ["context"], diff_summary: "x", hypothesis: "x" }), /refuted before/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
