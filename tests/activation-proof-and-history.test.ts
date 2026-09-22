import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivationProofKernel } from "../src/activation-proof.ts";
import { ComponentHistoryMigrationKernel } from "../src/component-history-migration.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-activation-proof-"));
  return { root, store: await new CraftStore(craftPaths(root)).open() };
}
async function dispose(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

test("activation proof distinguishes observed execution, stale evidence and absent Host activity", async () => {
  const f = await fixture();
  try {
    const proof = new ActivationProofKernel(f.store);
    const context = f.store.create("context_resolution_receipt", "ctx", { identity_digest: "ctx" });
    const first = proof.record({ receipt_id: "known", host: "codex", component: "knowledge", event: "UserPromptSubmit", session_id: "s", context_receipt_id: context.id, hook_trusted: true, mcp_reachable: true });
    assert.equal((first.receipt as JsonObject).plugin_release, "0.12.37");
    assert.equal(proof.record({ receipt_id: "known", host: "codex", component: "knowledge", event: "UserPromptSubmit", session_id: "s", context_receipt_id: context.id, hook_trusted: true, mcp_reachable: true }).idempotent, true);
    assert.throws(() => proof.record({ receipt_id: "known", host: "codex", component: "knowledge", event: "Stop", session_id: "s", hook_trusted: true, mcp_reachable: true }), /idempotency/);
    proof.record({ host: "claude", component: "memory", event: "UserPromptSubmit", session_id: "s", memory_written: true, plugin_release: "0.0.1", hook_trusted: true, mcp_reachable: true });
    const doctor = proof.doctor({ session_id: "s" });
    const components = doctor.components as JsonObject[];
    assert.equal(components.find((x) => x.component === "knowledge")!.status, "executed");
    assert.equal(components.find((x) => x.component === "knowledge")!.context_receipt_id, "ctx");
    assert.equal(components.find((x) => x.component === "memory")!.status, "stale_plugin_or_receipt");
    assert.equal(components.find((x) => x.component === "experience")!.status, "not_observed");
    proof.record({ host: "codex", component: "memory", event: "Stop", session_id: "s", hook_trusted: false, mcp_reachable: true });
    proof.record({ host: "codex", component: "experience", event: "Stop", session_id: "s", hook_trusted: true, mcp_reachable: false });
    proof.record({ host: "codex", component: "knowledge", event: "Stop", session_id: "all", turn_id: null, hook_trusted: true, mcp_reachable: true });
    proof.record({ host: "codex", component: "memory", event: "Stop", session_id: "all", turn_id: "t", hook_trusted: true, mcp_reachable: true });
    proof.record({ host: "codex", component: "experience", event: "Stop", session_id: "all", context_receipt_id: null, observation_written: true, hook_trusted: true, mcp_reachable: true });
    proof.record({ host: "codex", component: "knowledge", event: "SessionStart", hook_trusted: true, mcp_reachable: true });
    const current = proof.doctor({ session_id: "s" });
    assert.equal((current.components as JsonObject[]).find((x) => x.component === "memory")!.status, "hook_not_trusted");
    assert.equal((current.components as JsonObject[]).find((x) => x.component === "experience")!.status, "mcp_not_reachable");
    assert.equal(current.next_action, "run_one_real_host_turn_then_recheck_this_session");
    assert.equal(proof.doctor({ session_id: "all" }).next_action, "inspect_the_component_receipts_and_evidence");
    assert.equal(proof.doctor().session_id, null);
    assert.throws(() => proof.record({ host: "other", component: "memory", event: "x", session_id: "s" }), /host/);
    assert.throws(() => proof.record({ host: "codex", component: "other", event: "x", session_id: "s" }), /component/);
    assert.throws(() => proof.record({ host: "codex", component: "memory", event: "", session_id: "s" }), /event/);
  } finally { await dispose(f); }
});

test("legacy reviewed Knowledge and workflow evolution migrate only through explicit apply and fail closed on missing provenance", async () => {
  const f = await fixture();
  try {
    const migration = new ComponentHistoryMigrationKernel(f.store);
    const evidence = f.store.create("evidence", "bounded", { confidence: "bounded" });
    f.store.create("knowledge_claim", "legacy", { status: "reviewed", evidence_ids: [evidence.id] });
    f.store.create("knowledge_claim", "no-evidence", { status: "reviewed", source_revision_id: "rev" });
    f.store.create("knowledge_claim", "fragment-only", { status: "reviewed", source_revision_id: "rev", fragment_id: "frag", evidence_ids: [evidence.id] });
    f.store.create("knowledge_claim", "semantic-only", { status: "reviewed", evidence_ids: [evidence.id], semantic_review_id: "review" });
    f.store.create("knowledge_claim", "complete", { status: "reviewed", source_revision_id: "rev", fragment_id: "frag", evidence_ids: [evidence.id], semantic_review_id: "review" });
    f.store.create("knowledge_claim", "model-review", { status: "reviewed", source_revision_id: "rev", fragment_id: "frag", evidence_ids: [evidence.id], model_review_id: "review" });
    f.store.create("knowledge_claim", "human-review", { status: "reviewed", source_revision_id: "rev", fragment_id: "frag", evidence_ids: [evidence.id], review: { reviewer: "human" } });
    const knowledgePlan = migration.knowledgeReviewed();
    assert.equal(knowledgePlan.mode, "dry_run");
    const legacyPlan = (knowledgePlan.revalidation_required as JsonObject[]).find((item) => item.claim_id === "legacy")!;
    assert.deepEqual(legacyPlan.missing, ["source_revision", "fragment", "semantic_review"]);
    const knowledgeApply = migration.knowledgeReviewed({ apply: true });
    assert.equal(knowledgeApply.writes, 4);
    assert.equal(f.store.get("knowledge_claim", "legacy").status, "revalidation_required");
    assert.equal(f.store.count("knowledge_semantic_review_link"), 3);

    f.store.create("workflow_evolution_observation", "trusted", { outcome: "passed", scenario_key: "retry", evidence_ids: [evidence.id], identity_digest: "trusted" });
    f.store.create("workflow_evolution_observation", "failed", { outcome: "failed", scenario_key: "retry", source: { scope: "project:demo" }, evidence_ids: [evidence.id], identity_digest: "failed" });
    f.store.create("workflow_evolution_observation", "untrusted", { outcome: "inconclusive", scenario_key: "retry", evidence_ids: ["missing"], identity_digest: "untrusted" });
    f.store.create("workflow_evolution_observation", "empty", { outcome: "passed", scenario_key: "retry", identity_digest: "empty" });
    f.store.create("workflow_evolution_observation", "fallback", { outcome: "passed", scenario_key: "retry", evidence_ids: [evidence.id] });
    const experiencePlan = migration.experienceWorkflowEvolution();
    assert.deepEqual([...(experiencePlan.migratable as string[])].sort(), ["failed", "fallback", "trusted"]);
    assert.equal((experiencePlan.revalidation_required as JsonObject[]).some((item) => item.observation_id === "untrusted"), true);
    const applied = migration.experienceWorkflowEvolution({ apply: true });
    assert.equal(applied.writes, 5);
    assert.equal(applied.idempotent, 0);
    const records = f.store.list("experience_observation", 10);
    assert.deepEqual(records.map((item) => item.status).sort(), ["recorded", "recorded", "recorded", "revalidation_required", "revalidation_required"]);
    assert.equal(migration.experienceWorkflowEvolution({ apply: true }).writes, 0);
    assert.equal(migration.experienceWorkflowEvolution({ apply: true }).idempotent, 5);
  } finally { await dispose(f); }
});
