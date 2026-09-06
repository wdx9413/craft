import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore } from "../src/store.ts";

test("service persists capabilities, tasks, feedback, artifacts, evidence, and versioned assets", async () => {
  const root = join(tmpdir(), `craft-service-${process.pid}-${Date.now()}`);
  const skills = join(root, "skills");
  await mkdir(skills, { recursive: true });
  await writeFile(join(skills, "SKILL.md"), "---\nname: diagnose\ndescription: trace failures\n---\nUse evidence.");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const source = await service.sourceAdd({ path: skills });
    assert.equal(service.sourceList().sources instanceof Array, true);
    assert.equal(service.capabilitySearch({ query: "trace" }).capabilities instanceof Array, true);
    const capability = (service.capabilitySearch({ query: "trace" }).capabilities as Record<string, unknown>[])[0];
    assert.equal(service.capabilityGet({ asset_id: capability.id }).name, "diagnose");
    service.sourceUpdate({ source_id: source.id, label: "Skills" });
    await service.sourceScan({ source_id: source.id });

    const opened = service.taskOpen({ title: "Fix", goal: "Find cause", project_id: "p" });
    const taskId = String((opened.task as Record<string, unknown>).id);
    assert.equal((service.taskOpen({ task_id: taskId }).task as Record<string, unknown>).status, "active");
    assert.equal((service.taskList({ project_id: "p", status: "active" }).tasks as unknown[]).length, 1);
    assert.throws(() => service.taskList({ status: "bad" }), /Unsupported task status/);
    assert.throws(() => service.taskCheckpoint({ task_id: taskId, summary: "x", status: "bad" }), /Unsupported task status/);
    service.feedbackRecord({ corrected: "Prefer proof", task_id: taskId });
    service.taskCheckpoint({ task_id: taskId, summary: "Done", status: "completed" });
    assert.equal((service.taskOpen({ task_id: taskId }).feedback as unknown[]).length, 1);
    assert.throws(() => service.feedbackRecord({ corrected: "x" }), /task_id/);
    assert.throws(() => service.feedbackRecord({ corrected: "x", scope: "bad" }), /scope/);
    service.feedbackRecord({ corrected: "global", scope: "user" });

    const artifact = service.artifactRegister({ kind: "report", name: "R", uri: "file:///r" });
    const evidence = service.evidenceRecord({ source_type: "test", claim: "passes", confidence: "confirmed",
      artifact_id: artifact.id });
    assert.equal(service.get("artifact", "artifact_id", { artifact_id: artifact.id }).name, "R");
    assert.equal(service.get("evidence", "evidence_id", { evidence_id: evidence.id }).claim, "passes");
    assert.throws(() => service.evidenceRecord({ source_type: "x", claim: "y", confidence: "bad" }), /confidence/);
    assert.throws(() => service.evidenceRecord({ source_type: "x", claim: "y", artifact_id: "missing" }), /Unknown artifact/);
    service.evidenceRecord({ source_type: "model", claim: "maybe" });
    assert.equal((service.list("evidence", "items", { query: "passes", limit: 5 }).items as unknown[]).length, 1);
    assert.equal((service.list("evidence", "items", {}).items as unknown[]).length, 2);

    const workflow = service.saveVersioned("workflow", "workflow", { name: "Review" }, ["name"]);
    service.saveVersioned("workflow", "workflow", { workflow_id: workflow.id, name: "Review v2" }, ["name"]);
    assert.equal(service.get("workflow", "workflow_id", { workflow_id: workflow.id, version: 1 }).name, "Review");
    const runnable = service.saveVersioned("workflow", "workflow", { name: "Runnable",
      inputs: [{ name: "file", required: true }], steps: [{ id: "exists", type: "assertion",
        evaluator: "file_exists", path: "{{file}}" }] }, ["name"]);
    const plan = service.workflowPlan({ workflow_id: runnable.id, inputs: { file: "skills/SKILL.md" } });
    assert.equal(plan.executable, true);
    const run = service.workflowRun({ workflow_id: runnable.id, inputs: { file: "skills/SKILL.md" }, project_root: root });
    assert.equal(run.status, "passed");
    assert.equal(service.workflowRun({ workflow_id: runnable.id, inputs: { file: "missing" }, project_root: root }).status, "failed");
    const orchestration = service.orchestrationCreate({ goal: "Build", max_concurrency: 2, nodes: [
      { id: "work", role: "worker", objective: "do", profile_ids: ["p"] },
    ] });
    const dispatched = service.orchestrationDispatch({ plan_id: orchestration.id, claimed_by: "host", capacity: 9 });
    const leaseId = String(((dispatched.leases as Record<string, unknown>[])[0]).lease_id);
    assert.equal(service.orchestrationSubmit({ plan_id: orchestration.id, lease_id: leaseId, verdict: "passed" }).status, "completed");
    assert.throws(() => service.orchestrationDispatch({ plan_id: orchestration.id, claimed_by: "host" }), /not running/);
    assert.throws(() => service.orchestrationCreate({ goal: "x", max_concurrency: 0, nodes: [
      { id: "x", role: "r", objective: "o", profile_ids: ["p"] },
    ] }), /max_concurrency/);
    assert.throws(() => service.orchestrationCreate({ goal: "x" }), /At least one/);
    assert.throws(() => service.saveVersioned("workflow", "workflow", {}, ["name"]), /name/);
    assert.equal((service.info().counts as Record<string, number>).workflow, 2);
    service.sourceRemove({ source_id: source.id });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("service validates required text", async () => {
  const root = join(tmpdir(), `craft-service-invalid-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    assert.throws(() => service.taskOpen({ title: "", goal: "x" }), /title/);
    assert.throws(() => service.sourceAdd({ path: "" }), /path/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
