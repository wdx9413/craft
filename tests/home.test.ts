import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HomeKernel } from "../src/home.ts";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore } from "../src/store.ts";

async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "craft-home-")); const store = await new CraftStore(craftPaths(root)).open(); return { store, home: new HomeKernel(store) }; }

test("Workbench Home provides one bounded UI-safe projection without copying authoritative state", async () => {
  const f = await fixture();
  f.store.create("task", "active", { title: "Draft lesson", status: "active", secret: "hidden" }); f.store.create("task", "done", { goal: "Done", status: "completed" });
  f.store.create("workspace", "ws", { name: "Lesson", root: "C:/work", state_revision: 2 }); f.store.create("work_object", "slide", { workspace_id: "ws" }); f.store.create("work_object", "other", { workspace_id: "other" });
  f.store.create("attention_item", "attention", { status: "open", audience: "human", priority: 5, reason: "Review", action: "review", source_kind: "x", source_id: "x" });
  f.store.create("runtime_run", "runtime", { task_id: "active", status: "running", current_stage: "work" }); f.store.create("workflow_run", "workflow", { status: "completed" });
  f.store.create("orchestration_plan", "plan", { status: "failed" }); f.store.create("orchestration_plan", "plan2", { status: "cancelled" }); f.store.create("runtime_run", "terminal", { status: "terminal" });
  f.store.create("budget_account", "budget", { owner_type: "task", owner_id: "active", status: "active", limits: { usd: 10, token: 100, storage: 5 }, used: { usd: 2, storage: 1 }, reserved: { usd: 3, token: 10 } });
  f.store.create("budget_account", "closed", { status: "closed", limits: {}, used: {}, reserved: {} }); f.store.create("artifact", "deck", { task_id: "active", kind: "pptx", path: "deck.pptx", private: "hidden" });
  f.store.create("maintenance_status", "local", { status: "healthy", last_tick_at: "2030-01-01T00:00:00Z", attention_count: 1 });
  f.store.create("work_launch", "launch", { task_id: "active", host: "codex-cli", workspace: "C:/work", sandbox: "read-only", status: "running", run_id: "missing" });
  f.store.create("work_launch", "pending", { task_id: "active", host: "claude-code", workspace: "C:/work", sandbox: "workspace-write", status: "awaiting_approval", acceptance_plan_id: "pending-plan" });
  f.store.create("work_launch", "linked", { task_id: "active", host: "codex-cli", workspace: "C:/work", sandbox: "read-only", status: "running", run_id: "linked-run", acceptance_plan_id: "linked-plan" }); f.store.create("host_run", "linked-run", { status: "completed" }); f.store.create("acceptance_assessment", "assessment_linked-plan", { status: "passed" });
  const view = f.home.view({ now: "2030-01-01T00:00:00Z", limit: 10 }); const summary = view.summary as Record<string, unknown>;
  assert.deepEqual(summary, { active_tasks: 1, workspaces: 1, attention: 1, active_runs: 1, active_budgets: 1, health: "healthy" });
  assert.deepEqual((view.resources as Record<string, unknown>[])[0].remaining, { usd: 5, token: 90, storage: 4 });
  assert.equal((view.workspaces as Record<string, unknown>[])[0].object_count, 1); const launches = view.work_launches as Record<string, unknown>[]; const launchStates = Object.fromEntries(launches.map((item) => [item.id, [item.effective_status, item.acceptance_status]])); assert.deepEqual(launchStates, { launch: ["running", "not_configured"], pending: ["awaiting_approval", "pending"], linked: ["completed", "passed"] }); assert.equal(JSON.stringify(view).includes("hidden"), false); f.store.close();
});

test("Workbench projects Host runs and incremental content-free events", async () => {
  const f = await fixture(); f.store.create("host_run", "run", { host: "codex-cli", dispatch_id: "dispatch", owner_id: "runner", status: "running", event_count: 2, secret: "hidden" });
  f.store.appendEvent("host-run:run", "host.output", { stream: "stdout", bytes: 3, digest: "sha256:a", content: "hidden" }); f.store.appendEvent("host-run:run", "host.finished", { status: "completed", receipt_id: "receipt", private: "hidden" });
  const home = f.home.view({ now: "2030-01-01T00:00:00Z" }); assert.equal((home.summary as Record<string, unknown>).active_runs, 1); assert.equal((home.runs as Record<string, unknown>[])[0].run_kind, "host");
  assert.equal((f.home.hostRuns({}).runs as Record<string, unknown>[])[0].host, "codex-cli"); const first = f.home.hostRun({ run_id: "run", limit: 1 }); assert.equal((first.events as object[]).length, 1); assert.equal(first.next_sequence, 1); assert.equal(JSON.stringify(first).includes("hidden"), false);
  const next = f.home.hostRun({ run_id: "run", after_sequence: 1 }); assert.equal((next.events as object[]).length, 1); assert.equal(next.next_sequence, 2); assert.equal(f.home.hostRun({ run_id: "run", after_sequence: 2 }).next_sequence, 2); assert.throws(() => f.home.hostRun({ run_id: "run", after_sequence: -1 }), /non-negative/); assert.throws(() => f.home.hostRun({ run_id: "run", after_sequence: 1.5 }), /non-negative/); f.store.close();
});

test("empty Home and service/MCP surfaces remain deterministic and validate bounds", async () => {
  const f = await fixture(); const empty = f.home.view(); assert.equal((empty.summary as Record<string, unknown>).health, "not_started"); assert.equal(empty.maintenance, null);
  assert.throws(() => f.home.view({ now: "bad" }), /ISO/); assert.throws(() => f.home.view({ limit: 0 }), /between/); assert.throws(() => f.home.view({ limit: 51 }), /between/); assert.throws(() => f.home.view({ limit: 1.5 }), /between/);
  const service = new CraftService(f.store); assert.equal((service.homeView({}).summary as Record<string, unknown>).workspaces, 0);
  const response = await new McpServer(service).handle({ id: 1, method: "tools/call", params: { name: "craft_home_view", arguments: {} } }); assert.equal((response?.result as Record<string, unknown>).isError, false); f.store.close();
});

test("task detail joins exact task evidence and lineage into a bounded safe view", async () => {
  const f = await fixture(); f.store.create("task", "task", { title: "Video", goal: "Create storyboard", status: "active", private: "hidden" });
  f.store.create("checkpoint", "cp", { task_id: "task", summary: "Started", completed: [], pending: ["shots"] }); f.store.create("feedback", "fb", { task_id: "task", corrected: "blue", original: "red", kind: "correction", source: "human" });
  f.store.create("trial", "trial", { task_id: "task", subject_type: "workflow", subject_id: "wf", subject_version: 1, status: "running" }); f.store.create("trial", "trial2", { task_id: "task", status: "running" });
  f.store.create("outcome", "outcome_trial", { trial_id: "trial", verdict: "passed", summary: "ok", evidence_ids: ["ev", "missing"] }); f.store.create("outcome", "outcome_trial2", { trial_id: "trial2", verdict: "failed", summary: "bad", evidence_ids: "legacy" });
  f.store.create("artifact", "art", { kind: "image", name: "Frame", uri: "file:///frame.png", private: "hidden" }); f.store.create("evidence", "ev", { source_type: "human", claim: "Approved", confidence: "confirmed", artifact_id: "art" }); f.store.create("evidence", "ev2", { source_type: "program", claim: "Format", confidence: "bounded", artifact_id: null });
  f.store.appendEvent("trial:trial", "produced", { evidence_ids: ["ev2"], artifact_ids: ["art", "missing-art"] }); f.store.appendEvent("trial:trial2", "legacy", { evidence_ids: "x", artifact_ids: null });
  f.store.create("runtime_run", "run", { task_id: "task", status: "running" }); f.store.create("workflow_run", "wr", { task_id: "other", status: "passed" }); f.store.create("orchestration_plan", "plan", { task_id: "task", status: "running" });
  f.store.create("lineage_edge", "edge", { task_id: "task", workspace_id: "ws", summary: "derived" }); f.store.create("durable_wait", "wait", { task_id: "task", status: "waiting", condition: "approval" });
  f.store.create("attention_item", "open", { task_id: "task", status: "open", reason: "Review" }); f.store.create("attention_item", "resolved", { task_id: "task", status: "resolved" });
  const detail = f.home.task({ task_id: "task", limit: 20 }); assert.equal((detail.trials as object[]).length, 2); assert.equal((detail.evidence as object[]).length, 2); assert.equal((detail.artifacts as object[]).length, 1); assert.equal((detail.runs as object[]).length, 2); assert.equal((detail.attention as object[]).length, 1); assert.equal(JSON.stringify(detail).includes("hidden"), false);
  assert.throws(() => f.home.task({ task_id: " " }), /not be empty/); assert.throws(() => f.home.task({ task_id: "missing" }), /Unknown/); assert.throws(() => f.home.task({ task_id: "task", limit: 0 }), /between/);
  const service = new CraftService(f.store); assert.equal((service.homeTask({ task_id: "task" }).task as Record<string, unknown>).id, "task"); const response = await new McpServer(service).handle({ id: 1, method: "tools/call", params: { name: "craft_home_task", arguments: { task_id: "task" } } }); assert.equal((response?.result as Record<string, unknown>).isError, false); f.store.close();
});
