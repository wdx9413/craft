import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { contextFeedbackWeights } from "../core/context-feedback-weight.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-design-capture-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  return { root, store, service };
}

/** A completed delivery: trial → outcome(verdict) → evidence(confirmed). */
function seedDelivery(f: Awaited<ReturnType<typeof fixture>>, taskId: string, verdict = "succeeded") {
  const trial = f.store.create("trial", `trial_${taskId}`, { task_id: taskId, status: "completed" });
  const evidence = f.store.create("evidence", `ev_${taskId}`, { confidence: "confirmed", claim: "delivered", locator: "fixture://artifact" });
  const outcome = f.store.create("outcome", `outcome_${taskId}`, { trial_id: trial.id, verdict, summary: "交付了设计稿", evidence_ids: [evidence.id] });
  return { trial, evidence, outcome };
}

test("capture prefills a workflow design draft from real delivery evidence", async () => {
  const f = await fixture();
  try {
    const task = (f.service.taskOpen({ title: "产品设计", goal: "完成一次产品设计" }).task as JsonObject);
    seedDelivery(f, String(task.id));
    const result = f.service.workbenchWorkflowDesignCapture({
      task_id: task.id, name: "产品设计复用", scenario_key: "product design pass",
    }) as JsonObject;
    const design = result.design as JsonObject;
    assert.equal(design.lifecycle, "draft");
    assert.equal(design.routeable, false);
    assert.equal(design.execution_authorized, false);
    assert.equal(result.kind, "success");
    const answers = design.answers as Record<string, string>;
    assert.ok(answers.example.includes("交付了设计稿"));
    assert.ok(!JSON.stringify(answers).includes("api_key=secret"));
    // The service wires the Experience ledger, so a capture must produce a real
    // content-free observation rather than silently dropping the seed.
    const observation = result.observation as JsonObject;
    assert.equal(observation.content_free, true);
    assert.equal(observation.status, "recorded");
    assert.equal(observation.scenario_key, "product_design_pass");
    assert.equal(result.observation_error, null);
    // The observation must carry the scope the ledger expects, otherwise it is
    // invisible to every scoped reader.
    assert.deepEqual(observation.scope, { kind: "task", id: String(task.id) });
    assert.ok((result.evidence_ids as string[]).length >= 1);
    // The design is retrievable under its scope like any other draft.
    const listed = f.service.workbenchWorkflowDesignList({ scope: String(design.scope) }) as JsonObject;
    assert.ok((listed.designs as JsonObject[]).some((item) => (item.design as JsonObject).id === design.id));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("capture refuses a delivery without evidence and does not create a draft", async () => {
  const f = await fixture();
  try {
    const task = (f.service.taskOpen({ title: "空交付", goal: "没有证据" }).task as JsonObject);
    assert.throws(() => f.service.workbenchWorkflowDesignCapture({ task_id: task.id, name: "x", scenario_key: "s" }), /requires at least one Evidence/);
    const designs = f.service.workbenchWorkflowDesignList({ scope: `task:${task.id}` }) as JsonObject;
    assert.equal((designs.designs as JsonObject[]).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a failed delivery captures as a correction and stays non-executable", async () => {
  const f = await fixture();
  try {
    const task = (f.service.taskOpen({ title: "故障诊断", goal: "修好它" }).task as JsonObject);
    seedDelivery(f, String(task.id), "failed");
    const result = f.service.workbenchWorkflowDesignCapture({ task_id: task.id, name: "故障复盘", scenario_key: "diagnosis" }) as JsonObject;
    assert.equal(result.kind, "correction");
    const design = result.design as JsonObject;
    assert.equal(design.routeable, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("overview reports the scoped drafts, observations, patterns and procedures", async () => {
  const f = await fixture();
  try {
    const task = (f.service.taskOpen({ title: "分层", goal: "g" }).task as JsonObject);
    seedDelivery(f, String(task.id));
    const captured = f.service.workbenchWorkflowDesignCapture({ task_id: task.id, name: "分层草稿", scenario_key: "layer" }) as JsonObject;
    const design = captured.design as JsonObject;
    const scope = String(design.scope);
    // A ledger pattern at the object scope proves both scope shapes are matched.
    f.store.create("experience_observation", "obs-other", { kind: "success", scenario_key: "s", scope: { kind: "task", id: String(task.id) }, status: "recorded", evidence_ids: ["ev"] });
    const overview = f.service.workbenchExperienceOverview({ scope }) as JsonObject;
    assert.equal(overview.scope, scope);
    assert.ok(Number((overview.counts as JsonObject).drafts) >= 1);
    assert.ok((overview.observations as JsonObject[]).length >= 1);
    assert.ok((overview.drafts as JsonObject[]).every((item) => (item.design as JsonObject).lifecycle === "draft"));
    // Procedures are only listed, never mutated here.
    assert.equal(Array.isArray(overview.procedures), true);
    assert.throws(() => f.service.workbenchExperienceOverview({}), /scope/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("experience recall feedback writes a verified weight for the experience member", async () => {
  const f = await fixture();
  try {
    const scope = { kind: "task", id: "t1" };
    f.store.create("context_resolution_receipt", "receipt-1", {
      asset_refs: [{ member: "experience", id: "proc-1", version: 1, digest: "sha256:ref" }],
      members: ["experience"], scope, identity_digest: "sha256:receipt",
    });
    f.store.create("evidence", "ev-1", { source_type: "program", confidence: "confirmed", record_origin: "host",
      metadata: { context_receipt_id: "receipt-1", verdict: "passed" } });
    const result = f.service.workbenchExperienceFeedback({
      receipt_id: "receipt-1", outcome: "helpful", usage_stage: "verified",
      evidence_ids: ["ev-1"], members: ["experience"],
    }) as JsonObject;
    assert.equal((result.feedback as JsonObject).evidence_verified, true);
    assert.equal(((result.feedback as JsonObject).verified_evidence_refs as JsonObject[]).length, 1);
    const weight = contextFeedbackWeights(f.store, "experience", ["proc-1"]).get("proc-1");
    assert.ok(weight && weight.weight > 1);
    assert.equal(weight!.positive, 1);
    // A stale/incorrect recall creates a correction task and demotes the weight.
    const stale = f.service.workbenchExperienceFeedback({ receipt_id: "receipt-1", outcome: "stale", members: ["experience"] }) as JsonObject;
    assert.equal((stale.corrections as JsonObject[]).length, 1);
    assert.ok(contextFeedbackWeights(f.store, "experience", ["proc-1"]).get("proc-1")!.penalty < 1);
    assert.throws(() => f.service.workbenchExperienceFeedback({ receipt_id: "missing", outcome: "helpful" }), /missing|not found/i);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a workspace-bound capture scopes the design and the observation consistently", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "ws"); await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    const workspace = (f.service.workspaceResolveOrCreate({ root_path: dir }) as JsonObject).workspace as JsonObject;
    const task = (f.service.taskOpen({ title: "W", goal: "g", workspace_id: workspace.id }).task as JsonObject);
    seedDelivery(f, String(task.id));
    const captured = f.service.workbenchWorkflowDesignCapture({ task_id: task.id, name: "W设计", scenario_key: "w" }) as JsonObject;
    const design = captured.design as JsonObject;
    assert.equal(design.scope, `workspace:${workspace.id}`);
    const observation = captured.observation as JsonObject;
    assert.deepEqual(observation.scope, { kind: "workspace", id: String(workspace.id) });
    // The scoped overview therefore sees both the draft and the observation.
    const overview = f.service.workbenchExperienceOverview({ scope: `workspace:${workspace.id}` }) as JsonObject;
    assert.ok((overview.drafts as JsonObject[]).length >= 1);
    assert.ok((overview.observations as JsonObject[]).length >= 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
