import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("control-plane budgets reserve and settle resources idempotently", async () => {
  const root = join(tmpdir(), `craft-budget-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    assert.equal(VERSION, "0.11.38");
    const task = service.taskOpen({ title: "Budget trace", goal: "Trace control costs" }).task as JsonObject;
    const workflow = service.workflowSave({ workflow_id: "budget_workflow", name: "Budget workflow" });
    const trial = service.trialStart({ trial_id: "budget_trial", task_id: task.id, subject_type: "workflow",
      subject_id: workflow.id, subject_version: workflow.version });
    const opened = service.budgetOpen({ budget_id: "budget", owner_type: "task", owner_id: "task", limits: { usd: 2, tokens: 1000 } });
    assert.deepEqual(opened.available, { usd: 2, tokens: 1000 });
    const reserved = service.budgetReserve({ budget_id: "budget", reservation_id: "r1", resources: { usd: 1, tokens: 400 }, purpose: "explore" });
    assert.equal(reserved.idempotent, false); assert.deepEqual(reserved.available, { usd: 1, tokens: 600 });
    assert.equal(service.budgetReserve({ budget_id: "budget", reservation_id: "r1", resources: { usd: 1, tokens: 400 } }).idempotent, true);
    assert.throws(() => service.budgetReserve({ budget_id: "budget", reservation_id: "r1", resources: { usd: 1 } }), /idempotency/);
    assert.throws(() => service.budgetReserve({ budget_id: "budget", resources: { usd: 2 } }), /exceeds/);
    const r2 = service.budgetReserve({ budget_id: "budget", reservation_id: "r2", resources: { usd: 0.5 }, trial_id: trial.id });
    assert.throws(() => service.budgetSettle({ reservation_id: "r2", actual: { usd: 0.6 } }), /exceed/);
    const settled = service.budgetSettle({ reservation_id: "r1", actual: { usd: 0.8, tokens: 300 } });
    assert.equal(settled.idempotent, false); assert.deepEqual((settled.account as JsonObject).used, { usd: 0.8, tokens: 300 });
    assert.equal(service.budgetSettle({ reservation_id: "r1" }).idempotent, true);
    service.budgetSettle({ reservation_id: (r2.reservation as JsonObject).id, trial_id: trial.id });
    assert.deepEqual((service.trialGet({ trial_id: trial.id }).trace as JsonObject[]).map((item) => item.event_type), ["budget_reserved", "budget_settled"]);
    store.save("budget_account", "budget", { ...store.get("budget_account", "budget"), status: "closed" });
    assert.throws(() => service.budgetReserve({ budget_id: "budget", resources: { usd: 0 } }), /not active/);
    assert.throws(() => service.budgetOpen({ owner_type: "task", owner_id: "x", limits: { usd: -1 } }), /non-negative/);
    assert.throws(() => service.budgetOpen({ owner_type: "task", owner_id: "x", limits: [] }), /object/);
    assert.throws(() => service.budgetOpen({ budget_id: "bad id", owner_type: "task", owner_id: "x", limits: {} }), /letters/);
    assert.throws(() => service.budgetOpen({ owner_type: " ", owner_id: "x", limits: {} }), /empty/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.10.2 prevents hierarchical budget oversell and settles child actuals into the parent", async () => {
  const root = join(tmpdir(), `craft-budget-tree-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    service.budgetOpen({ budget_id: "parent", owner_type: "task", owner_id: "root", limits: { usd: 10, tokens: 100 } });
    const child = service.budgetOpen({ budget_id: "child", parent_budget_id: "parent", owner_type: "subagent", owner_id: "worker",
      limits: { usd: 4, tokens: 40 } });
    assert.deepEqual((child.parent as JsonObject).reserved, { usd: 4, tokens: 40 });
    assert.throws(() => service.budgetOpen({ budget_id: "too_large", parent_budget_id: "parent", owner_type: "subagent",
      owner_id: "large", limits: { usd: 7 } }), /exceed parent/);
    assert.throws(() => service.budgetOpen({ budget_id: "child", owner_type: "task", owner_id: "duplicate", limits: {} }), /already exists/);
    assert.throws(() => service.budgetClose({ budget_id: "parent" }), /active child/);
    const reservation = service.budgetReserve({ budget_id: "child", reservation_id: "child_work", resources: { usd: 4, tokens: 40 } }).reservation as JsonObject;
    assert.throws(() => service.budgetClose({ budget_id: "child" }), /unsettled/);
    service.budgetSettle({ reservation_id: reservation.id, actual: { usd: 3, tokens: 30 } });
    const closed = service.budgetClose({ budget_id: "child" });
    assert.deepEqual((closed.parent as JsonObject).used, { usd: 3, tokens: 30 });
    assert.deepEqual((closed.parent as JsonObject).reserved, { usd: 0, tokens: 0 });
    assert.equal(service.budgetClose({ budget_id: "child" }).idempotent, true);
    assert.equal(service.budgetClose({ budget_id: "parent" }).idempotent, false);
    assert.equal(service.budgetClose({ budget_id: "parent" }).idempotent, true);
    assert.throws(() => service.budgetOpen({ budget_id: "late_child", parent_budget_id: "parent", owner_type: "subagent",
      owner_id: "late", limits: {} }), /Parent budget/);

    service.budgetOpen({ budget_id: "broken_parent", owner_type: "task", owner_id: "root", limits: { usd: 1 } });
    service.budgetOpen({ budget_id: "broken_child", parent_budget_id: "broken_parent", owner_type: "subagent", owner_id: "worker", limits: { usd: 1 } });
    store.save("budget_reservation", "budget_allocation_broken_child", {
      ...store.get("budget_reservation", "budget_allocation_broken_child"), status: "settled" });
    assert.throws(() => service.budgetClose({ budget_id: "broken_child" }), /allocation is not reserved/);

    const mcp = new McpServer(service, "full");
    const response = await mcp.handle({ id: 3, method: "tools/call", params: { name: "craft_budget_close", arguments: { budget_id: "broken_parent" } } });
    assert.equal((response?.result as JsonObject).isError, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.10.2 releases waiting environments and revalidates state before resume", async () => {
  const root = join(tmpdir(), `craft-wait-${process.pid}-${Date.now()}`); const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open(); const service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true }); const task = service.taskOpen({ title: "Wait", goal: "Wait safely" }).task as JsonObject;
    service.workspaceOpen({ workspace_id: "ws", name: "WS", root_path: worktree, include_paths: ["docs"] });
    const workflow = service.workflowSave({ workflow_id: "wait_workflow", name: "Wait workflow" });
    const trial = service.trialStart({ trial_id: "wait_trial", task_id: task.id, subject_type: "workflow",
      subject_id: workflow.id, subject_version: workflow.version });
    const approval = service.durableWaitCreate({ wait_id: "approval", task_id: task.id, workspace_id: "ws", condition: "approval",
      snapshot_refs: ["checkpoint"], policy_fingerprint: "p1", trial_id: trial.id });
    assert.equal(approval.execution_environment, "releasable");
    assert.throws(() => service.durableWaitResume({ wait_id: "approval", signal: "event" }), /does not satisfy/);
    assert.equal((service.durableWaitResume({ wait_id: "approval", signal: "approval", policy_fingerprint: "p1" }).wait as JsonObject).status, "resumed");
    assert.equal(service.durableWaitResume({ wait_id: "approval", signal: "approval" }).idempotent, true);
    assert.deepEqual((service.trialGet({ trial_id: trial.id }).trace as JsonObject[]).map((item) => item.event_type), ["execution_waiting", "execution_resumed"]);
    const otherTask = service.taskOpen({ title: "Other", goal: "Other" }).task as JsonObject;
    assert.throws(() => service.durableWaitCreate({ task_id: otherTask.id, condition: "event", trial_id: trial.id }), /does not belong/);

    service.durableWaitCreate({ wait_id: "changed", task_id: task.id, workspace_id: "ws", condition: "event", event_key: "file" });
    service.workspaceHumanChange({ workspace_id: "ws", summary: "human changed" });
    assert.throws(() => service.durableWaitResume({ wait_id: "changed", signal: "event", signal_key: "other" }), /event key/);
    const changed = service.durableWaitResume({ wait_id: "changed", signal: "event", signal_key: "file" }).wait as JsonObject;
    assert.equal(changed.status, "needs_replan"); assert.equal(changed.resume_reason, "workspace_revision_changed");
    service.durableWaitCreate({ wait_id: "policy", task_id: task.id, condition: "event", policy_fingerprint: "old" });
    assert.equal((service.durableWaitResume({ wait_id: "policy", signal: "event", policy_fingerprint: "new" }).wait as JsonObject).resume_reason, "policy_fingerprint_changed");
    service.durableWaitCreate({ wait_id: "timer", task_id: task.id, condition: "time", resume_after: "2030-01-01T00:00:00.000Z" });
    assert.throws(() => service.durableWaitResume({ wait_id: "timer", signal: "time", now: "2029-01-01T00:00:00.000Z" }), /does not satisfy/);
    assert.equal((service.durableWaitResume({ wait_id: "timer", signal: "time", now: "2031-01-01T00:00:00.000Z" }).wait as JsonObject).status, "resumed");
    assert.throws(() => service.durableWaitCreate({ task_id: task.id, condition: "unknown" }), /unsupported/);
    assert.throws(() => service.durableWaitCreate({ task_id: task.id, condition: "time" }), /valid resume_after/);
    service.durableWaitCreate({ wait_id: "bad-now", task_id: task.id, condition: "event" });
    assert.throws(() => service.durableWaitResume({ wait_id: "bad-now", signal: "event", now: "never" }), /ISO/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.10.2 ingests untrusted external events idempotently and wakes only exact waits", async () => {
  const root = join(tmpdir(), `craft-events-${process.pid}-${Date.now()}`); const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open(); const service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    const firstTask = service.taskOpen({ title: "First", goal: "Wait" }).task as JsonObject;
    const secondTask = service.taskOpen({ title: "Second", goal: "Wait" }).task as JsonObject;
    service.workspaceOpen({ workspace_id: "events_ws", name: "Events", root_path: worktree, include_paths: ["events"] });
    service.durableWaitCreate({ wait_id: "matching", task_id: firstTask.id, workspace_id: "events_ws", condition: "event",
      event_key: "monitor.alert", policy_fingerprint: "old" });
    service.durableWaitCreate({ wait_id: "other_task", task_id: secondTask.id, condition: "event", event_key: "monitor.alert" });
    service.durableWaitCreate({ wait_id: "other_key", task_id: firstTask.id, condition: "event", event_key: "mail.received" });
    const ingested = service.externalEventIngest({ event_id: "evt_1", event_key: "monitor.alert", task_id: firstTask.id,
      source: "webhook", observed_at: "2030-01-01T00:00:00.000Z", payload: { instruction: "do unsafe thing" }, policy_fingerprint: "new" });
    assert.equal(ingested.idempotent, false); assert.equal((ingested.deliveries as JsonObject[]).length, 1);
    assert.equal((ingested.deliveries as JsonObject[])[0].status, "needs_replan");
    assert.equal((ingested.event as JsonObject).trust, "untrusted_data");
    assert.equal((service.externalEventIngest({ event_id: "evt_1", event_key: "monitor.alert", task_id: firstTask.id,
      source: "webhook", payload: { instruction: "do unsafe thing" } }).deliveries as JsonObject[]).length, 1);
    assert.throws(() => service.externalEventIngest({ event_id: "evt_1", event_key: "different", task_id: firstTask.id }), /idempotency/);
    assert.throws(() => service.externalEventIngest({ event_id: "evt_1", event_key: "monitor.alert", task_id: firstTask.id,
      source: "webhook", payload: { changed: true } }), /idempotency/);
    assert.throws(() => service.externalEventIngest({ event_id: "evt_2", event_key: "x", task_id: "missing" }), /Unknown task/);
    assert.throws(() => service.externalEventIngest({ event_id: "evt_3", event_key: "x", observed_at: "never" }), /ISO/);
    const broadcast = service.externalEventIngest({ event_id: "evt_4", event_key: "monitor.alert" });
    assert.equal((broadcast.deliveries as JsonObject[])[0].wait_id, "other_task");
    assert.equal(service.externalEventIngest({ event_id: "evt_4", event_key: "monitor.alert" }).idempotent, true);
    const mcp = new McpServer(service, "full");
    const response = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_external_event_ingest",
      arguments: { event_id: "evt_mcp", event_key: "none" } } });
    assert.equal((response?.result as JsonObject).isError, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.10.2 sweeps due time waits in bounded batches and fails closed without current policy", async () => {
  const root = join(tmpdir(), `craft-time-sweep-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Timers", goal: "Wake safely" }).task as JsonObject;
    service.durableWaitCreate({ wait_id: "due_policy", task_id: task.id, condition: "time",
      resume_after: "2029-01-01T00:00:00.000Z", policy_fingerprint: "policy-v1" });
    service.durableWaitCreate({ wait_id: "future", task_id: task.id, condition: "time", resume_after: "2031-01-01T00:00:00.000Z" });
    const first = service.durableWaitSweep({ now: "2030-01-01T00:00:00.000Z", limit: 1, policy_fingerprints: {} });
    assert.equal(first.due, 1); assert.equal((first.deliveries as JsonObject[])[0].status, "needs_replan");
    assert.equal((first.deliveries as JsonObject[])[0].reason, "policy_fingerprint_unavailable");
    service.durableWaitCreate({ wait_id: "due_plain", task_id: task.id, condition: "time", resume_after: "2029-01-01T00:00:00.000Z" });
    const second = service.durableWaitSweep({ now: "2030-01-01T00:00:00.000Z", policy_fingerprints: {} });
    assert.equal((second.deliveries as JsonObject[])[0].status, "resumed");
    assert.throws(() => service.durableWaitSweep({ now: "never" }), /ISO/);
    assert.throws(() => service.durableWaitSweep({ limit: 0 }), /limit/);
    service.durableWaitCreate({ wait_id: "past_default", task_id: task.id, condition: "time", resume_after: "2000-01-01T00:00:00.000Z" });
    assert.equal(service.durableWaitSweep({}).due, 1);
    const mcp = new McpServer(service, "full");
    const response = await mcp.handle({ id: 2, method: "tools/call", params: { name: "craft_durable_wait_sweep",
      arguments: { now: "2030-01-01T00:00:00.000Z" } } });
    assert.equal((response?.result as JsonObject).isError, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.10.2 bounds fallback by trigger, attempts, and reserved budget through MCP", async () => {
  const root = join(tmpdir(), `craft-fallback-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Fallback", goal: "Recover" }).task as JsonObject;
    const workflow = service.workflowSave({ workflow_id: "wf", name: "Fallback workflow" });
    service.budgetOpen({ budget_id: "budget", owner_type: "task", owner_id: "task", limits: { usd: 1 } });
    service.fallbackContractSave({ contract_id: "contract", subject_type: "workflow", subject_id: "wf", subject_version: 1,
      triggers: ["schema_drift", "http_5xx"], strategy: "model_replan", max_attempts: 1, budget_id: "budget", estimated_resources: { usd: 0.6 } });
    assert.deepEqual(service.fallbackEvaluate({ contract_id: "contract", trigger: "other" }), { decision: "continue", trigger_matched: false });
    const fallback = service.fallbackEvaluate({ contract_id: "contract", event_id: "first", trigger: "schema_drift", task_id: "task", observation: { code: 500 } });
    assert.equal(fallback.decision, "fallback"); assert.equal((fallback.reservation as JsonObject).status, "reserved");
    const blocked = service.fallbackEvaluate({ contract_id: "contract", trigger: "http_5xx", event_id: "blocked_event" });
    assert.equal(blocked.decision, "blocked");
    assert.throws(() => service.fallbackComplete({ event_id: "blocked_event", verdict: "failed", summary: "Blocked" }), /running fallback/);
    service.fallbackContractSave({ contract_id: "expensive", subject_type: "workflow", subject_id: "wf", subject_version: 1,
      triggers: ["drift"], strategy: "human", budget_id: "budget", estimated_resources: { usd: 0.6 } });
    assert.equal(service.fallbackEvaluate({ contract_id: "expensive", trigger: "drift" }).decision, "await_budget");
    service.fallbackContractSave({ contract_id: "free", subject_type: "workflow", subject_id: "wf", subject_version: 1,
      triggers: ["drift"], strategy: "workflow_replan" });
    const started = service.fallbackEvaluate({ contract_id: "free", trigger: "drift", start_trial: true, task_id: task.id,
      case_id: "runtime-drift" });
    assert.equal(started.decision, "fallback"); assert.equal((started.trial as JsonObject).subject_id, workflow.id);
    assert.equal((service.trialGet({ trial_id: (started.trial as JsonObject).id }).trace as JsonObject[])[0].event_type, "fallback_evaluated");
    assert.throws(() => service.fallbackComplete({ event_id: (started.event as JsonObject).id, verdict: "unknown", summary: "bad" }), /verdict/);
    const freeCompleted = service.fallbackComplete({ event_id: (started.event as JsonObject).id, verdict: "passed", summary: "Recovered" });
    assert.equal(freeCompleted.settlement, null);
    assert.equal(service.fallbackComplete({ event_id: (started.event as JsonObject).id, verdict: "passed", summary: "Recovered" }).idempotent, true);
    const mismatched = service.workflowSave({ workflow_id: "other_workflow", name: "Other workflow" });
    const wrongTrial = service.trialStart({ task_id: task.id, subject_type: "workflow", subject_id: mismatched.id, subject_version: mismatched.version });
    assert.throws(() => service.fallbackEvaluate({ contract_id: "free", trigger: "drift", trial_id: wrongTrial.id, task_id: task.id }), /subject does not match/);
    const nextWorkflow = service.workflowSave({ workflow_id: "wf", name: "Fallback workflow v2" });
    const wrongVersion = service.trialStart({ task_id: task.id, subject_type: "workflow", subject_id: nextWorkflow.id, subject_version: nextWorkflow.version });
    assert.throws(() => service.fallbackEvaluate({ contract_id: "free", trigger: "drift", trial_id: wrongVersion.id, task_id: task.id }), /subject does not match/);
    service.budgetOpen({ budget_id: "linked_budget", owner_type: "task", owner_id: task.id, limits: { usd: 1 } });
    service.fallbackContractSave({ contract_id: "linked", subject_type: "workflow", subject_id: "wf", subject_version: 1,
      triggers: ["drift"], strategy: "model_replan", budget_id: "linked_budget", estimated_resources: { usd: 0.1 } });
    const linkedTrial = service.trialStart({ task_id: task.id, subject_type: "workflow", subject_id: "wf", subject_version: 1 });
    const linked = service.fallbackEvaluate({ contract_id: "linked", trigger: "drift", trial_id: linkedTrial.id, task_id: task.id });
    const linkedTracePayload = (service.trialGet({ trial_id: linkedTrial.id }).trace as JsonObject[])[0].payload as JsonObject;
    assert.equal((linkedTracePayload.data as JsonObject).reservation_id, (linked.reservation as JsonObject).id);
    const evidence = service.evidenceRecord({ source_type: "program", claim: "Fallback verified", confidence: "confirmed" });
    const completed = service.fallbackComplete({ event_id: (linked.event as JsonObject).id, verdict: "passed", summary: "Recovered safely",
      evidence_ids: [evidence.id], costs: { usd: 0.08 }, actual_resources: { usd: 0.08 } });
    assert.equal((completed.outcome as JsonObject).verdict, "passed");
    assert.equal(((completed.settlement as JsonObject).reservation as JsonObject).status, "settled");
    assert.deepEqual((service.trialGet({ trial_id: linkedTrial.id }).trace as JsonObject[]).map((item) => item.event_type),
      ["fallback_evaluated", "budget_settled", "fallback_completed"]);
    service.fallbackContractSave({ contract_id: "duplicate_outcome", subject_type: "workflow", subject_id: "wf", subject_version: 1,
      triggers: ["drift"], strategy: "human" });
    const duplicateOutcome = service.fallbackEvaluate({ contract_id: "duplicate_outcome", trigger: "drift",
      trial_id: linkedTrial.id, task_id: task.id });
    assert.throws(() => service.fallbackComplete({ event_id: (duplicateOutcome.event as JsonObject).id,
      verdict: "passed", summary: "Duplicate" }), /Outcome already exists/);

    service.fallbackContractSave({ contract_id: "orphan", subject_type: "workflow", subject_id: "wf", subject_version: 1,
      triggers: ["drift"], strategy: "human" });
    const orphan = service.fallbackEvaluate({ contract_id: "orphan", trigger: "drift", event_id: "orphan_event", task_id: task.id });
    assert.throws(() => service.fallbackComplete({ event_id: (orphan.event as JsonObject).id, verdict: "failed", summary: "No trial" }), /trial_id/);

    service.fallbackContractSave({ contract_id: "mismatch_contract", subject_type: "workflow", subject_id: "wf", subject_version: 1,
      triggers: ["drift"], strategy: "human" });
    assert.throws(() => service.fallbackEvaluate({ contract_id: "mismatch_contract", trigger: "drift", event_id: "mismatch_event",
      trial_id: wrongTrial.id, task_id: task.id }), /subject does not match/);
    assert.throws(() => service.fallbackComplete({ event_id: "mismatch_event", verdict: "failed", summary: "Mismatch" }), /subject does not match/);

    service.budgetOpen({ budget_id: "actual_budget", owner_type: "task", owner_id: task.id, limits: { usd: 1 } });
    service.fallbackContractSave({ contract_id: "actual_contract", subject_type: "workflow", subject_id: "wf", subject_version: 1,
      triggers: ["drift"], strategy: "human", budget_id: "actual_budget", estimated_resources: { usd: 0.1 } });
    const actualTrial = service.trialStart({ task_id: task.id, subject_type: "workflow", subject_id: "wf", subject_version: 1 });
    const actualEvent = service.fallbackEvaluate({ contract_id: "actual_contract", trigger: "drift", trial_id: actualTrial.id, task_id: task.id });
    assert.throws(() => service.fallbackComplete({ event_id: (actualEvent.event as JsonObject).id, verdict: "failed", summary: "Too expensive",
      actual_resources: { usd: 0.2 } }), /actual resources/);
    assert.throws(() => service.fallbackComplete({ event_id: (actualEvent.event as JsonObject).id, verdict: "failed", summary: "Unknown resource",
      actual_resources: { tokens: 1 } }), /actual resources/);
    service.budgetSettle({ reservation_id: (actualEvent.reservation as JsonObject).id, actual: { usd: 0.05 } });
    assert.throws(() => service.fallbackComplete({ event_id: (actualEvent.event as JsonObject).id, verdict: "failed", summary: "Already settled",
      actual_resources: { usd: 0.05 } }), /actual resources/);
    service.budgetOpen({ budget_id: "closed_budget", owner_type: "task", owner_id: "task", limits: { usd: 1 } });
    service.fallbackContractSave({ contract_id: "closed_contract", subject_type: "workflow", subject_id: "wf", subject_version: 1,
      triggers: ["drift"], strategy: "human", budget_id: "closed_budget", estimated_resources: { usd: 0.1 } });
    store.save("budget_account", "closed_budget", { ...store.get("budget_account", "closed_budget"), status: "closed" });
    assert.throws(() => service.fallbackEvaluate({ contract_id: "closed_contract", trigger: "drift" }), /not active/);

    assert.throws(() => service.fallbackContractSave({ subject_type: "x", subject_id: "x", subject_version: 1, triggers: ["x"], strategy: "bad" }), /strategy/);
    assert.throws(() => service.fallbackContractSave({ subject_type: "x", subject_id: "x", subject_version: 0, triggers: ["x"], strategy: "human" }), /subject_version/);
    assert.throws(() => service.fallbackContractSave({ subject_type: "x", subject_id: "x", subject_version: 1, triggers: [], strategy: "human" }), /non-empty/);
    assert.throws(() => service.fallbackContractSave({ subject_type: "x", subject_id: "x", subject_version: 1, triggers: ["x", "x"], strategy: "human" }), /unique/);
    assert.throws(() => service.fallbackContractSave({ subject_type: "x", subject_id: "x", subject_version: 1, triggers: ["x"], strategy: "human", max_attempts: 0 }), /max_attempts/);
    assert.throws(() => service.fallbackContractSave({ subject_type: "x", subject_id: "x", subject_version: 1, triggers: ["x"], strategy: "human", budget_id: "missing" }), /Unknown/);

    const mcp = new McpServer(service, "full");
    const mcpTask = service.taskOpen({ title: "MCP", goal: "MCP" }).task as JsonObject;
    for (const [name, arguments_] of Object.entries({
      craft_budget_open: { budget_id: "mcp_budget", owner_type: "task", owner_id: "mcp", limits: { usd: 1 } },
      craft_budget_reserve: { budget_id: "mcp_budget", reservation_id: "mcp_reservation", resources: { usd: 0.2 } },
      craft_budget_settle: { reservation_id: "mcp_reservation", actual: { usd: 0.1 } },
      craft_durable_wait_create: { wait_id: "mcp_wait", task_id: mcpTask.id, condition: "event" },
      craft_durable_wait_resume: { wait_id: "mcp_wait", signal: "event" },
      craft_fallback_contract_save: { contract_id: "mcp_contract", subject_type: "workflow", subject_id: "wf", subject_version: 1, triggers: ["drift"], strategy: "human" },
      craft_fallback_evaluate: { contract_id: "mcp_contract", trigger: "drift" },
      craft_fallback_complete: { event_id: (linked.event as JsonObject).id, verdict: "passed", summary: "Recovered safely" },
    })) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as JsonObject).isError, false, name);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
