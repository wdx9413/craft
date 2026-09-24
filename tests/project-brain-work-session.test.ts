import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { ProjectBrainKernel } from "../capability/craft-knowledge/project-brain.ts";
import { WorkSessionKernel } from "../core/work-session.ts";
import { WorkbenchExperienceKernel } from "../core/workbench-experience.ts";
import { LongTaskWorkerKernel } from "../core/long-task-worker.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";

async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "craft-v129-")); const store = await new CraftStore(craftPaths(root)).open(); return { store, brain: new ProjectBrainKernel(store) }; }

test("v0.12.12 Project Brain joins goals, decisions, materials, outcomes and experience", async () => {
  const f = await fixture(); const brain = f.brain;
  const opened = brain.open({ project_id: "p1", name: "Video project", description: "private material" }); assert.equal(opened.idempotent, false);
  assert.equal(brain.open({ project_id: "p1", name: "Video project", description: "private material" }).idempotent, true);
  assert.throws(() => brain.open({ project_id: "p1", name: "Video project", description: "changed" }), /idempotency/);
  const goal = brain.goalSave({ project_id: "p1", goal_id: "goal", title: "Ship", constraint_digests: ["sha256:c"], metric: "accepted" }); assert.equal((goal.goal as Record<string, unknown>).status, "active");
  assert.throws(() => brain.goalSave({ project_id: "missing", title: "x" }), /Unknown/);
  brain.decisionSave({ project_id: "p1", decision_id: "decision", title: "Use workflow", rationale: "evidence", chosen_ref: "workflow:one", excluded_refs: ["workflow:two"] });
  brain.materialBind({ project_id: "p1", material_id: "material", name: "brief", uri: "file:///brief.md", content_digest: "sha256:brief" });
  f.store.create("task", "task", { project_id: "p1", title: "Task", goal: "Ship", status: "active" });
  const session = new WorkSessionKernel(f.store).prepare({ project_id: "p1", task_id: "task", session_id: "session", goal: "Ship", knowledge_refs: [{ id: "bundle", version: 1, digest: "sha256:b" }], capability_refs: [{ id: "cap", version: 1 }], workflow_refs: [{ id: "wf", version: 1 }], excluded_refs: ["wf:other"], selection_rationale: ["exact evidence"], model: "gpt", host: "internal", acceptance_ref: "acceptance" });
  assert.equal((session.session as Record<string, unknown>).status, "prepared"); assert.equal(brain.snapshot({ project_id: "p1" }).content_free, true);
  const outcome = brain.outcomeRecord({ project_id: "p1", session_id: "session", verdict: "passed", summary: "done", evidence_ids: [], artifact_ids: [] }); assert.equal((outcome.outcome as Record<string, unknown>).status, "recorded");
  const experience = brain.experienceRecord({ project_id: "p1", name: "Reusable", pattern: "pattern", source_outcome_id: (outcome.outcome as Record<string, unknown>).id }); assert.equal((experience.experience as Record<string, unknown>).status, "candidate");
  const refreshed = brain.refresh({ project_id: "p1" }); assert.equal(typeof refreshed.snapshot_digest, "string"); f.store.close();
});

test("Work Session, Workbench projection and durable long-task wake/resume are fail-closed", async () => {
  const f = await fixture(); const brain = f.brain; brain.open({ project_id: "p2" }); f.store.create("task", "task2", { project_id: "p2", title: "Task", goal: "Goal", status: "active" });
  const sessions = new WorkSessionKernel(f.store); const prepared = sessions.prepare({ project_id: "p2", task_id: "task2", session_id: "s2" }); assert.equal(sessions.refresh({ session_id: "s2" }).ready, true); assert.equal(sessions.prepare({ project_id: "p2", task_id: "task2", session_id: "s2" }).idempotent, true);
  f.store.create("internal_dispatch", "dispatch2", { task_id: "task2", status: "prepared", request_digest: "sha256:d" }); assert.equal((sessions.bindDispatch({ session_id: "s2", dispatch_id: "dispatch2" }).dispatch as Record<string, unknown>).session_id, "s2");
  f.store.create("work_launch", "launch2", { task_id: "task2", status: "prepared" }); assert.equal((sessions.bindLaunch({ session_id: "s2", launch_id: "launch2" }).session as Record<string, unknown>).status, "running");
  f.store.save("task", "task2", { project_id: "p2", title: "Task", goal: "Goal changed", status: "active" }); const refreshed = sessions.refresh({ session_id: "s2" }); assert.equal(refreshed.ready, false); assert.equal((refreshed.session as Record<string, unknown>).status, "needs_replan");
  assert.equal((sessions.complete({ session_id: "s2", summary: "review", status: "needs_review" }).session as Record<string, unknown>).status, "needs_review"); assert.throws(() => sessions.complete({ session_id: "s2", summary: "x", status: "bad" }), /unsupported/);
  const worker = new LongTaskWorkerKernel(f.store); const checkpoint = worker.suspend({ session_id: "s2", checkpoint_id: "cp2", wait_condition: "approval", resume_action: "resume" }); assert.equal((checkpoint.checkpoint as Record<string, unknown>).status, "waiting"); assert.equal(worker.suspend({ session_id: "s2", checkpoint_id: "cp2", wait_condition: "approval", resume_action: "resume" }).idempotent, true); assert.throws(() => worker.suspend({ session_id: "s2", checkpoint_id: "cp2", wait_condition: "other", resume_action: "resume" }), /idempotency/);
  assert.equal((worker.wake({ checkpoint_id: "cp2", signal: "human-approved" }).checkpoint as Record<string, unknown>).status, "wake_requested"); const resumed = worker.resume({ checkpoint_id: "cp2" }); assert.equal(resumed.ready, true); assert.equal((resumed.checkpoint as Record<string, unknown>).status, "ready");
  const cp3 = worker.suspend({ session_id: "s2", checkpoint_id: "cp3", wait_condition: "event" }); f.store.save("work_session", "s2", { ...(f.store.get("work_session", "s2")), context_digest: "sha256:changed" }); worker.wake({ checkpoint_id: "cp3", signal: "event" }); const replanned = worker.resume({ checkpoint_id: "cp3" }); assert.equal(replanned.ready, false); assert.equal((replanned.checkpoint as Record<string, unknown>).status, "needs_replan"); assert.deepEqual((worker.list({ session_id: "s2" }).checkpoints as object[]).length, 2); assert.equal(worker.get({ checkpoint_id: "cp2" }).checkpoint !== undefined, true);
  const expiring = worker.suspend({ session_id: "s2", checkpoint_id: "cp4", wait_condition: "timer", expires_at: "2020-01-01T00:00:00.000Z" }); assert.equal((expiring.checkpoint as Record<string, unknown>).status, "waiting"); const wakeExpiring = worker.suspend({ session_id: "s2", checkpoint_id: "cp5", wait_condition: "event", expires_at: "2020-01-01T00:00:00.000Z" }); worker.wake({ checkpoint_id: "cp5", signal: "event" }); assert.equal((wakeExpiring.checkpoint as Record<string, unknown>).status, "waiting"); const tick = worker.tick({ now: "2020-01-02T00:00:00.000Z" }); assert.equal(tick.count, 2); assert.equal((worker.get({ checkpoint_id: "cp4" }).checkpoint as Record<string, unknown>).status, "needs_replan"); assert.equal((worker.get({ checkpoint_id: "cp5" }).checkpoint as Record<string, unknown>).status, "ready");
  const experience = new WorkbenchExperienceKernel(f.store); const projection = experience.query({ project_id: "p2" }); assert.equal(projection.content_free, true); assert.equal(experience.get({ session_id: "s2" }).content_free, true); assert.equal(experience.review({ project_id: "p2" }).evidence_required, true);
  f.store.create("trace", "trace2", { task_id: "task2", status: "running", model_fingerprint: "m", environment_fingerprint: "e" }); f.store.create("trace_event", "trace2:1", { trace_id: "trace2", sequence: 1, event_kind: "step", action_contract: { action: "read" }, input_refs: [], output_refs: [] }); const replay = experience.replayPlan({ trace_id: "trace2" }); assert.equal(replay.replayable, true); f.store.close();
});

test("Long Task checkpoints validate task-run ownership, expiry and malformed state", async () => {
  const f = await fixture();
  try {
    f.brain.open({ project_id: "p-long" });
    f.store.create("task", "task-long", { project_id: "p-long", title: "Long", goal: "Wait" });
    f.store.create("work_session", "session-long", { task_id: "task-long", project_id: "p-long", context_digest: "sha256:ctx" });
    f.store.create("work_launch", "launch-long", { task_id: "task-long" });
    f.store.create("task_run", "run-long", { task_id: "task-long", contract_id: "contract", launch_id: "launch-long" });
    const worker = new LongTaskWorkerKernel(f.store);
    const checkpoint = worker.suspend({ session_id: "session-long", task_run_id: "run-long", wait_condition: "approval", expires_at: "2030-01-01T00:00:00.000Z", now: "2029-01-01T00:00:00.000Z" });
    assert.equal((checkpoint.checkpoint as Record<string, unknown>).task_run_id, "run-long");
    worker.wake({ checkpoint_id: String((checkpoint.checkpoint as Record<string, unknown>).id), signal: "approved" });
    worker.resume({ checkpoint_id: String((checkpoint.checkpoint as Record<string, unknown>).id) });
    assert.throws(() => worker.wake({ checkpoint_id: String((checkpoint.checkpoint as Record<string, unknown>).id), signal: "again" }), /waiting/);
    assert.throws(() => worker.list({ limit: 0 }), /between/);
    const missingSession = worker.suspend({ session_id: "session-long", checkpoint_id: "missing-session-cp", wait_condition: "event" });
    f.store.save("long_task_checkpoint", "missing-session-cp", { ...missingSession.checkpoint as Record<string, unknown>, session_id: "deleted-session" });
    const replanned = worker.resume({ checkpoint_id: "missing-session-cp", now: "2030-01-01T00:00:00.000Z" });
    assert.equal(replanned.ready, false);
    assert.equal((replanned.checkpoint as Record<string, unknown>).failure instanceof Array, true);
  } finally { f.store.close(); }
});

test("legacy memory consolidation covers default scope, source, confidence and search filters", async () => {
  const f = await fixture();
  try {
    const memory = new (await import("../core/memory-consolidation.ts")).MemoryConsolidationKernel(f.store);
    const first = memory.remember({ memory_id: "legacy-memory", content: "A bounded observation" });
    assert.equal((first.memory as Record<string, unknown>).scope, "task");
    assert.equal((first.memory as Record<string, unknown>).source, "work");
    const second = memory.remember({ memory_id: "legacy-memory-2", scope: "task", content: "A second observation", source: "test", confidence: 0.9 });
    const consolidated = memory.consolidate({ memory_ids: ["legacy-memory", "legacy-memory-2"], semantic_id: "legacy-semantic" });
    assert.equal((consolidated.memory as Record<string, unknown>).status, "active");
    assert.equal((memory.search({ query: "bounded" }).results as unknown[]).length, 1);
    assert.equal((memory.search({ query: "bounded", scope: "other" }).results as unknown[]).length, 0);
    assert.throws(() => memory.remember({ content: "token=secret-value" }), /credentials/);
    assert.throws(() => memory.consolidate({ memory_ids: ["legacy-memory"], content: "password=secret-value" }), /secrets/);
  } finally { f.store.close(); }
});

test("work session rejects drift, cross-project bindings and malformed references", async () => {
  const f = await fixture();
  try {
    const brain = f.brain;
    brain.open({ project_id: "edge-project" });
    f.store.create("task", "edge-task", { project_id: "edge-project", title: "Edge", goal: "Goal" });
    const sessions = new WorkSessionKernel(f.store);
    assert.throws(() => sessions.prepare({ project_id: "edge-project", task_id: "edge-task", knowledge_refs: [{ id: "bad" }, null] }), /items/);
    assert.throws(() => sessions.prepare({ project_id: "edge-project", task_id: "edge-task", excluded_refs: ["x", "x"] }), /unique/);
    const prepared = sessions.prepare({ project_id: "edge-project", task_id: "edge-task", session_id: "edge-session", selection_rationale: [], knowledge_refs: [], capability_refs: [], workflow_refs: [], excluded_refs: [] });
    assert.equal(sessions.refresh({ session_id: "edge-session" }).ready, true);
    f.store.save("task", "edge-task", { ...f.store.get("task", "edge-task"), title: "Changed" });
    assert.equal(sessions.refresh({ session_id: "edge-session" }).ready, false);
    assert.throws(() => sessions.prepare({ project_id: "edge-project", task_id: "edge-task", session_id: "edge-session", goal: "different" }), /idempotency/);
    f.store.create("work_launch", "edge-launch", { task_id: "other" });
    assert.throws(() => sessions.bindLaunch({ session_id: "edge-session", launch_id: "edge-launch" }), /belong/);
    f.store.create("internal_dispatch", "edge-dispatch", { task_id: "other", status: "prepared" });
    assert.throws(() => sessions.bindDispatch({ session_id: "edge-session", dispatch_id: "edge-dispatch" }), /belong/);
    f.store.save("task", "edge-task", { ...f.store.get("task", "edge-task"), project_id: null, version: 1 });
    const fresh = sessions.prepare({ project_id: "edge-project", task_id: "edge-task", session_id: "edge-session-2" });
    f.store.create("work_launch", "edge-launch-2", { task_id: "edge-task" });
    assert.equal((sessions.bindLaunch({ session_id: "edge-session-2", launch_id: "edge-launch-2" }).session as Record<string, unknown>).status, "running");
    const edgeBrain = f.store.list("project_brain").find((item) => item.project_id === "edge-project")!;
    f.store.save("project_brain", String(edgeBrain.id), { ...edgeBrain, name: "changed" });
    assert.equal(sessions.refresh({ session_id: String((fresh.session as Record<string, unknown>).id) }).ready, false);
    assert.equal((sessions.complete({ session_id: "edge-session-2", status: "failed", summary: "failed", outcome_id: "outcome" }).session as Record<string, unknown>).status, "failed");
    f.store.create("work_session", "missing-refs", { task_id: "missing-task", project_id: "missing-project", task_version: 1, brain_version: 1, status: "running", context_digest: "sha256:x" });
    const missingRefresh = sessions.refresh({ session_id: "missing-refs" });
    assert.equal(missingRefresh.ready, false);
    f.store.create("task", "null-project-task", { project_id: null, title: "Null", goal: "Goal" });
    brain.open({ project_id: "null-project" });
    const nullSession = sessions.prepare({ project_id: "null-project", task_id: "null-project-task", session_id: "null-session" });
    assert.equal((nullSession.session as Record<string, unknown>).status, "prepared");
    f.store.create("internal_dispatch", "unbound-dispatch", { task_id: "null-project-task", status: "prepared" });
    assert.equal((sessions.bindDispatch({ session_id: "null-session", dispatch_id: "unbound-dispatch" }).dispatch as Record<string, unknown>).session_id, "null-session");
  } finally { f.store.close(); }
});

test("project brain covers default identities, revisions and projection limits", async () => {
  const f = await fixture();
  try {
    const brain = f.brain;
    const opened = brain.open({ project_id: "defaults", brain_id: "brain-defaults" });
    assert.equal((opened.brain as Record<string, unknown>).name, "defaults");
    assert.equal(brain.open({ project_id: "defaults", brain_id: "brain-defaults" }).idempotent, true);
    assert.throws(() => brain.open({ project_id: "defaults", brain_id: "brain-defaults", description: "changed" }), /idempotency/);
    assert.throws(() => brain.get({ project_id: "missing" }), /Unknown/);
    assert.throws(() => brain.goalSave({ project_id: "defaults", title: "Bad", constraint_digests: "bad" as never }), /array/);
    assert.throws(() => brain.goalSave({ project_id: "defaults", title: "Dup", constraint_digests: ["x", "x"] }), /unique/);
    assert.throws(() => brain.snapshot({ project_id: "defaults", limit: 0 }), /between/);
    brain.goalSave({ project_id: "defaults", goal_id: "goal-default", title: "Ship" });
    brain.goalSave({ project_id: "defaults", goal_id: "goal-default", title: "Ship v2", metric: "quality" });
    brain.decisionSave({ project_id: "defaults", decision_id: "decision-default", title: "Use", rationale: "reason", chosen_ref: "ref" });
    brain.decisionSave({ project_id: "defaults", decision_id: "decision-default", title: "Use v2", rationale: "reason2", chosen_ref: "ref2", excluded_refs: [] });
    brain.materialBind({ project_id: "defaults", material_id: "material-default", name: "Brief", uri: "file:///brief", content_digest: "sha256:brief" });
    brain.outcomeRecord({ project_id: "defaults", outcome_id: "outcome-default", verdict: "passed", summary: "done" });
    assert.throws(() => brain.outcomeRecord({ project_id: "defaults", verdict: "passed", summary: "done", evidence_ids: "bad" as never }), /array/);
    const experience = brain.experienceRecord({ project_id: "defaults", experience_id: "experience-default", name: "Pattern", pattern: "pattern" });
    assert.equal((experience.experience as Record<string, unknown>).source_outcome_id, null);
    assert.equal(brain.snapshot({ project_id: "defaults", limit: 10 }).content_free, true);
  } finally { f.store.close(); }
});

test("v0.12.12 service and MCP expose the new surfaces", async () => {
  // The service now exposes the default bounded model tool surface and the dispatch/session binding.
  const f = await fixture(); const service = new CraftService(f.store); const opened = service.projectBrainOpen({ project_id: "p3" }); f.store.create("task", "task3", { project_id: "p3", title: "Task", goal: "Goal", status: "active" }); service.projectBrainGoalSave({ project_id: "p3", title: "Ship" }); service.projectBrainDecisionSave({ project_id: "p3", title: "Choose", rationale: "reason", chosen_ref: "wf" }); service.projectBrainMaterialBind({ project_id: "p3", name: "brief", uri: "file:///brief", content_digest: "sha256:b" }); const prepared = service.workSessionPrepare({ project_id: "p3", task_id: "task3", session_id: "s3" }); service.workSessionGet({ session_id: "s3" }); service.workSessionRefresh({ session_id: "s3" }); f.store.create("work_launch", "launch3", { task_id: "task3", status: "prepared" }); service.workSessionBindLaunch({ session_id: "s3", launch_id: "launch3" }); service.workSessionComplete({ session_id: "s3", summary: "done" }); service.projectBrainOutcomeRecord({ project_id: "p3", session_id: "s3", verdict: "passed", summary: "done" }); service.projectBrainExperienceRecord({ project_id: "p3", name: "pattern", pattern: "pattern" }); service.workbenchExperienceQuery({ project_id: "p3" }); service.workbenchExperienceGet({ session_id: "s3" }); service.workbenchExperienceReview({ project_id: "p3" }); const checkpoint = service.longTaskSuspend({ session_id: "s3", wait_condition: "approval" }); service.longTaskGet({ checkpoint_id: (checkpoint.checkpoint as Record<string, unknown>).id }); service.longTaskList({ session_id: "s3" }); service.longTaskWake({ checkpoint_id: (checkpoint.checkpoint as Record<string, unknown>).id, signal: "approved" }); service.longTaskResume({ checkpoint_id: (checkpoint.checkpoint as Record<string, unknown>).id }); service.longTaskTick({ now: "2020-01-01T00:00:00.000Z" });
  f.store.create("trace", "mcp-trace", { task_id: "task3", status: "running", model_fingerprint: "m", environment_fingerprint: "e" }); f.store.create("trace_event", "mcp-trace:1", { trace_id: "mcp-trace", sequence: 1, event_kind: "step", action_contract: { action: "read" }, input_refs: [], output_refs: [], created_at: "2030-01-01T00:00:01Z" }); f.store.create("trace_event", "mcp-trace:2", { trace_id: "mcp-trace", sequence: 2, event_kind: "step", action_contract: { action: "write" }, input_refs: [], output_refs: [], created_at: "2030-01-01T00:00:02Z" }); f.store.create("trial", "mcp-trial", { task_id: "task3" }); f.store.create("outcome", "mcp-outcome", { trial_id: "mcp-trial", verdict: "passed" }); f.store.create("artifact", "mcp-artifact", { task_id: "task3", kind: "file" });
  const server = new McpServer(service); const call = async (name: string, args: Record<string, unknown>) => { const result = await server.handle({ id: name, method: "tools/call", params: { name, arguments: args } }); assert.equal((result?.result as Record<string, unknown>).isError, false, name); return result; };
  await call("craft_project_brain_open", { project_id: "p3" }); await call("craft_project_brain_get", { project_id: "p3" }); await call("craft_project_brain_refresh", { project_id: "p3" }); await call("craft_project_goal_save", { project_id: "p3", goal_id: "mcp-goal", title: "Goal" }); await call("craft_project_decision_save", { project_id: "p3", decision_id: "mcp-decision", title: "Decision", rationale: "reason", chosen_ref: "wf" }); await call("craft_project_material_bind", { project_id: "p3", material_id: "mcp-material", name: "Material", uri: "file:///m", content_digest: "sha256:m" }); await call("craft_project_outcome_record", { project_id: "p3", outcome_id: "mcp-outcome", verdict: "passed", summary: "done" }); await call("craft_project_experience_record", { project_id: "p3", experience_id: "mcp-experience", name: "Experience", pattern: "pattern" }); await call("craft_work_session_prepare", { project_id: "p3", task_id: "task3", session_id: "mcp-session" }); await call("craft_work_session_get", { session_id: "mcp-session" }); await call("craft_work_session_refresh", { session_id: "mcp-session" }); f.store.create("internal_dispatch", "mcp-dispatch", { task_id: "task3", status: "prepared", request_digest: "sha256:mcp" }); await call("craft_work_session_bind_dispatch", { session_id: "mcp-session", dispatch_id: "mcp-dispatch" }); await call("craft_work_session_bind_launch", { session_id: "mcp-session", launch_id: "launch3" }); await call("craft_work_session_complete", { session_id: "mcp-session", summary: "done" }); await call("craft_workbench_experience_query", { project_id: "p3" }); await call("craft_workbench_experience_get", { session_id: "mcp-session" }); await call("craft_workbench_experience_review", { project_id: "p3" }); await call("craft_workbench_trace_replay_plan", { trace_id: "mcp-trace" }); const mcpCheckpoint = (await call("craft_long_task_suspend", { session_id: "mcp-session", checkpoint_id: "mcp-checkpoint", wait_condition: "event" }))?.result as Record<string, unknown>; await call("craft_long_task_get", { checkpoint_id: "mcp-checkpoint" }); await call("craft_long_task_list", { session_id: "mcp-session" }); await call("craft_long_task_wake", { checkpoint_id: "mcp-checkpoint", signal: "event" }); await call("craft_long_task_resume", { checkpoint_id: "mcp-checkpoint" }); await call("craft_long_task_tick", { now: "2020-01-01T00:00:00.000Z" });
  assert.equal((service.info().counts as Record<string, number>).project_brain, 1); const response = await server.handle({ id: 1, method: "tools/call", params: { name: "craft_project_brain_get", arguments: { project_id: "p3" } } }); assert.equal((response?.result as Record<string, unknown>).isError, false); assert.equal((opened.brain as Record<string, unknown>).project_id, "p3"); assert.equal((prepared.session as Record<string, unknown>).project_id, "p3"); assert.ok(mcpCheckpoint); f.store.close();
});

test("v0.12.18 internal Host advertises only bounded Craft actions", async () => {
  const f = await fixture(); const service = new CraftService(f.store);
  // The loop now addresses the full canonical catalog, but only through the
  // read/candidate tiers: it can observe and propose, never approve its own work.
  const names = service.internalHost.tools.map((tool) => tool.function.name);
  assert.ok(names.length > 7, "the loop should see more than the legacy bounded table");
  for (const forbidden of ["capability_delete", "contract_publish", "credential_lease_issue", "docker_run"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be mounted on the loop`);
  }
  assert.ok(names.includes("knowledge_search"));
  assert.ok(names.includes("workspace_write"));
  assert.ok(service.internalHost.authorization.includes("read"));
  assert.ok(service.internalHost.authorization.includes("candidate"));
  assert.ok(!service.internalHost.authorization.includes("governed"));
  f.store.create("task", "task10", { project_id: null, title: "Task", goal: "Goal", status: "active" });
  f.store.create("project_brain", "brain10", { project_id: "local", name: "local", description_digest: "sha256:x", status: "active" });
  const session = service.workSessionPrepare({ project_id: "local", task_id: "task10", session_id: "session10" });
  f.store.create("internal_dispatch", "dispatch10", { task_id: "task10", status: "prepared", request_digest: "sha256:d" });
  const bound = service.workSessionBindDispatch({ session_id: (session.session as Record<string, unknown>).id, dispatch_id: "dispatch10" });
  assert.equal((bound.dispatch as Record<string, unknown>).session_id, "session10"); f.store.close();
});
