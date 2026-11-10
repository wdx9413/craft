import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { WorkflowDesignWorkbench } from "../core/application/coordinators/workflow-design.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-design-edges-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  return { root, store, service: new CraftService(store) };
}

function delivery(store: CraftStore, taskId: string, withEvidence: boolean, verdict = "succeeded", summary: string | null = "done") {
  const trial = store.create("trial", `trial-${taskId}-${withEvidence}`, { task_id: taskId });
  const evidence = withEvidence
    ? store.create("evidence", `ev-${taskId}`, { confidence: "confirmed", claim: "x" }) // no locator/artifact_id → falls back to id
    : null;
  return store.create("outcome", `outcome-${taskId}-${withEvidence}`,
    { trial_id: trial.id, verdict, ...(summary === null ? {} : { summary }), ...(evidence ? { evidence_ids: [evidence.id] } : {}) });
}

test("capture uses caller-supplied answers and tolerates a missing summary and locator", async () => {
  const f = await fixture();
  try {
    const task = (f.service.taskOpen({ title: "T", goal: "g" }).task as JsonObject);
    delivery(f.store, String(task.id), false, "succeeded", null);   // an outcome with no evidence_ids and no summary
    delivery(f.store, String(task.id), true, "succeeded", null);    // an evidence-backed outcome with no summary
    const result = f.service.workbenchWorkflowDesignCapture({ task_id: task.id, name: "n", scenario_key: "s",
      trigger: "t", inputs: "i", steps: "s", outputs: "o", limits: "l", failure: "f", samples: "x" }) as JsonObject;
    const answers = (result.design as JsonObject).answers as Record<string, string>;
    assert.equal(answers.trigger, "t");
    assert.equal(answers.inputs, "i");
    assert.equal(answers.outputs, "o");
    assert.match(answers.example, /真实交付记录/);
    assert.deepEqual(result.evidence_ids, ["ev-" + task.id]);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a whitespace scope falls back to the task scope", async () => {
  const f = await fixture();
  try {
    const task = (f.service.taskOpen({ title: "T", goal: "g" }).task as JsonObject);
    delivery(f.store, String(task.id), true);
    const result = f.service.workbenchWorkflowDesignCapture({ task_id: task.id, name: "n", scenario_key: "s", scope: "   " }) as JsonObject;
    assert.equal((result.design as JsonObject).scope, `task:${task.id}`);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("capture reports a ledger failure but still saves the draft", async () => {
  const f = await fixture();
  try {
    const task = (f.service.taskOpen({ title: "T", goal: "g" }).task as JsonObject);
    delivery(f.store, String(task.id), true);
    const wb = new WorkflowDesignWorkbench(f.store, { observe: () => { throw new Error("ledger offline"); } });
    const result = wb.capture({ task_id: task.id, name: "n", scenario_key: "s" }) as JsonObject;
    assert.equal(result.observation, null);
    assert.equal(result.observation_error, "ledger offline");
    assert.equal((result.design as JsonObject).lifecycle, "draft");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("capture without a ledger still saves the draft and says so", async () => {
  const f = await fixture();
  try {
    const task = (f.service.taskOpen({ title: "T", goal: "g" }).task as JsonObject);
    delivery(f.store, String(task.id), true);
    const wb = new WorkflowDesignWorkbench(f.store);
    const result = wb.capture({ task_id: task.id, name: "n", scenario_key: "s" }) as JsonObject;
    assert.equal(result.observation, null);
    assert.match(String(result.observation_error), /experience ledger unavailable/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("overview tolerates a scope without a colon", async () => {
  const f = await fixture();
  try {
    const result = f.service.workbenchExperienceOverview({ scope: "invalid" }) as JsonObject;
    assert.equal(result.scope, "invalid");
    assert.deepEqual(result.counts, { drafts: 0, observations: 0, patterns: 0, procedures: 0 });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("capture keeps an explicit scope string", async () => {
  const f = await fixture();
  try {
    const task = (f.service.taskOpen({ title: "T", goal: "g" }).task as JsonObject);
    delivery(f.store, String(task.id), true);
    const result = f.service.workbenchWorkflowDesignCapture({ task_id: task.id, name: "n", scenario_key: "s", scope: "project:p1" }) as JsonObject;
    assert.equal((result.design as JsonObject).scope, "project:p1");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("overview matches string scopes and skips non-object scopes, defaulting missing fields", async () => {
  const f = await fixture();
  try {
    const scope = "workspace:w1";
    f.store.create("experience_observation", "o-str", { kind: "success", scenario_key: "k", scope });
    f.store.create("experience_pattern", "p-str", { scope });
    f.store.create("experience_pattern", "p-none", {});
    f.store.create("experience_procedure", "proc", { scope });
    const overview = f.service.workbenchExperienceOverview({ scope }) as JsonObject;
    assert.equal((overview.observations as JsonObject[]).length, 1);
    assert.equal((overview.patterns as JsonObject[]).length, 1);
    assert.equal((overview.procedures as JsonObject[]).length, 1);
    const pattern = (overview.patterns as JsonObject[])[0]!;
    assert.equal(pattern.pattern_kind, undefined);
    assert.equal(pattern.failure_type, null);
    const procedure = (overview.procedures as JsonObject[])[0]!;
    assert.equal(procedure.procedure_kind, "workflow");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
