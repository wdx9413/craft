import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertCurrentReleaseVersion } from "./release-version.ts";
import { McpServer } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService, VERSION } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
test("independent verification drives bounded retry, handoff, and terminal evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-iteration-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Fix", goal: "Repair a bounded failure" }).task as JsonObject;
    store.create("work_launch", "launch", { task_id: task.id }); store.create("acceptance_plan", "plan", { task_id: task.id, launch_id: "launch" });
    const makeAssessment = (id: string, planId = "plan", status = "failed") => store.create("acceptance_assessment", id, { plan_id: planId, plan_version: 1, status });
    assert.equal(typeof ((service.verifiedIterationCreate({ task_id: task.id, launch_id: "launch", acceptance_plan_id: "plan" }).iteration as JsonObject).id), "string");
    const retry = service.verifiedIterationCreate({ iteration_id: "retry", task_id: task.id, launch_id: "launch", acceptance_plan_id: "plan", max_attempts: 2, allowed_paths: ["src"] }).iteration as JsonObject;
    assert.equal((service.verifiedIterationCreate({ iteration_id: "retry", task_id: task.id, launch_id: "launch", acceptance_plan_id: "plan", max_attempts: 2, allowed_paths: ["src"] }) as JsonObject).idempotent, true);
    await assert.rejects(Promise.resolve().then(() => service.verifiedIterationCreate({ iteration_id: "retry", task_id: task.id, launch_id: "launch", acceptance_plan_id: "plan", max_attempts: 3, allowed_paths: ["src"] })), /idempotency/);
    const first = service.verifiedIterationAssess({ iteration_id: retry.id, attempt_id: "first-attempt", assessment_id: makeAssessment("failed-1").id, classification: "task_failure", feedback: "Test X expected Y" });
    assert.equal((first.next as JsonObject).action, "retry"); assert.equal((first.next as JsonObject).remaining_attempts, 1);
    assert.equal(((first.attempt as JsonObject).assessment_version), 1); assert.equal(((first.attempt as JsonObject).acceptance_plan_version), 1);
    assert.equal(typeof (first.attempt as JsonObject).assessment_digest, "string"); assert.equal(typeof (first.attempt as JsonObject).launch_digest, "string");
    await assert.rejects(Promise.resolve().then(() => service.verifiedIterationAssess({ iteration_id: retry.id, assessment_id: "failed-1", classification: "task_failure" })), /already consumed/u);
    const final = service.verifiedIterationAssess({ iteration_id: retry.id, assessment_id: makeAssessment("failed-2").id, classification: "task_failure" });
    assert.equal((final.iteration as JsonObject).status, "unresolved"); assert.equal(((final.next as JsonObject).reason), "attempt_budget_exhausted");
    assert.equal(((service.verifiedIterationGet({ iteration_id: retry.id }).attempts as JsonObject[]).length), 2);
    assert.equal((service.verifiedIterationAssess({ iteration_id: retry.id, assessment_id: "failed-2", classification: "task_failure" }) as JsonObject).idempotent, true);
    const make = (id: string) => service.verifiedIterationCreate({ iteration_id: id, task_id: task.id, launch_id: "launch", acceptance_plan_id: "plan" }).iteration as JsonObject;
    assert.equal(((service.verifiedIterationAssess({ iteration_id: make("pass").id, assessment_id: makeAssessment("pass-assessment", "plan", "passed").id, classification: "task_failure" }).iteration as JsonObject).status), "passed");
    assert.equal(((service.verifiedIterationAssess({ iteration_id: make("config").id, assessment_id: makeAssessment("config-assessment").id, classification: "verification_configuration" }).iteration as JsonObject).status), "blocked");
    assert.equal(((service.verifiedIterationAssess({ iteration_id: make("environment").id, assessment_id: makeAssessment("environment-assessment").id, classification: "environment" }).iteration as JsonObject).status), "blocked");
    assert.equal(((service.verifiedIterationAssess({ iteration_id: make("scope").id, assessment_id: makeAssessment("scope-assessment").id, classification: "scope_violation" }).iteration as JsonObject).status), "unresolved");
    assert.equal(((service.verifiedIterationAssess({ iteration_id: make("progress").id, assessment_id: makeAssessment("progress-assessment").id, classification: "no_progress" }).iteration as JsonObject).status), "unresolved");
    await assert.rejects(Promise.resolve().then(() => service.verifiedIterationAssess({ iteration_id: make("invalid").id, assessment_id: makeAssessment("invalid-assessment").id, classification: "other" })), /unsupported/);
    store.create("acceptance_plan", "other-plan", { task_id: task.id, launch_id: "launch" });
    await assert.rejects(Promise.resolve().then(() => service.verifiedIterationAssess({ iteration_id: make("mismatch").id, assessment_id: makeAssessment("mismatch-assessment", "other-plan").id, classification: "task_failure" })), /does not belong/);
    const other = service.taskOpen({ title: "Other", goal: "Other" }).task as JsonObject; store.create("work_launch", "other-launch", { task_id: other.id }); store.create("acceptance_plan", "other-task-plan", { task_id: other.id, launch_id: "other-launch" });
    await assert.rejects(Promise.resolve().then(() => service.verifiedIterationCreate({ task_id: task.id, launch_id: "launch", acceptance_plan_id: "other-task-plan" })), /same Task/);
    await assert.rejects(Promise.resolve().then(() => service.verifiedIterationCreate({ task_id: task.id, launch_id: "other-launch", acceptance_plan_id: "other-task-plan" })), /same Task/);
    store.create("work_launch", "same-task-other-launch", { task_id: task.id }); store.create("acceptance_plan", "wrong-launch-plan", { task_id: task.id, launch_id: "same-task-other-launch" });
    await assert.rejects(Promise.resolve().then(() => service.verifiedIterationCreate({ task_id: task.id, launch_id: "launch", acceptance_plan_id: "wrong-launch-plan" })), /same Task/);
    await assert.rejects(Promise.resolve().then(() => service.verifiedIterationCreate({ task_id: task.id, launch_id: "launch", acceptance_plan_id: "plan", allowed_paths: ["../outside"] })), /relative/);
    store.create("work_launch", "frozen-launch", { task_id: task.id });
    const frozenPlan = store.create("acceptance_plan", "frozen-plan", { task_id: task.id, launch_id: "frozen-launch" });
    const frozenIteration = service.verifiedIterationCreate({ iteration_id: "frozen-plan-iteration", task_id: task.id, launch_id: "frozen-launch", acceptance_plan_id: frozenPlan.id }).iteration as JsonObject;
    store.save("acceptance_plan", "frozen-plan", { ...frozenPlan, name: "changed after iteration start" });
    const postChangeAssessment = store.create("acceptance_assessment", "post-change-assessment", { plan_id: frozenPlan.id, plan_version: 2, status: "passed" });
    await assert.rejects(Promise.resolve().then(() => service.verifiedIterationAssess({ iteration_id: frozenIteration.id,
      assessment_id: postChangeAssessment.id, classification: "task_failure" })), /frozen plan version/u);
    const rollbackIteration = make("rollback"); const rollbackAssessment = makeAssessment("rollback-assessment");
    const originalSave = store.save.bind(store);
    store.save = ((kind: string, recordId: string, payload: JsonObject, version?: number) => {
      if (kind === "verified_iteration" && recordId === rollbackIteration.id) throw new Error("injected iteration settlement failure");
      return originalSave(kind, recordId, payload, version);
    }) as typeof store.save;
    try {
      await assert.rejects(Promise.resolve().then(() => service.verifiedIterationAssess({ iteration_id: rollbackIteration.id, attempt_id: "rolled-back-attempt",
        assessment_id: rollbackAssessment.id, classification: "task_failure" })), /injected iteration settlement failure/u);
    } finally { store.save = originalSave as typeof store.save; }
    assert.equal(store.find("iteration_attempt", "rolled-back-attempt"), null);
    assert.equal((service.verifiedIterationGet({ iteration_id: rollbackIteration.id }).iteration as JsonObject).attempts_started, 0);
    const racedIteration = make("raced-terminal"); const originalTransaction = store.transaction.bind(store);
    store.transaction = ((operation) => {
      store.transaction = originalTransaction as typeof store.transaction;
      store.save("verified_iteration", String(racedIteration.id), { ...racedIteration, status: "passed" });
      return originalTransaction(operation);
    }) as typeof store.transaction;
    try {
      const racedResult = service.verifiedIterationAssess({ iteration_id: racedIteration.id, assessment_id: "not-read-after-terminal-race", classification: "task_failure" });
      assert.equal(racedResult.action, "terminal"); assert.equal(racedResult.idempotent, true);
    } finally { store.transaction = originalTransaction as typeof store.transaction; }
    const mcp = new McpServer(service, "full");
    const created = await mcp.handle({ id: "iteration-create", method: "tools/call", params: { name: "craft_verified_iteration_create", arguments: { iteration_id: "mcp", task_id: task.id, launch_id: "launch", acceptance_plan_id: "plan" } } }); assert.equal((created?.result as JsonObject).isError, false);
    const result = await mcp.handle({ id: "iteration", method: "tools/call", params: { name: "craft_verified_iteration_get", arguments: { iteration_id: retry.id } } }); assert.equal((result?.result as JsonObject).isError, false);
    const mcpAssessment = makeAssessment("mcp-assessment"); const assessed = await mcp.handle({ id: "iteration-assess", method: "tools/call", params: { name: "craft_verified_iteration_assess", arguments: { iteration_id: "mcp", assessment_id: mcpAssessment.id, classification: "verification_configuration" } } }); assert.equal((assessed?.result as JsonObject).isError, false);
    assertCurrentReleaseVersion(VERSION);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
