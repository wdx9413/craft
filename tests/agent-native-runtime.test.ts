import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { AgentEvalLabKernel } from "../src/agent-eval-lab.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { WorkbenchWebApp } from "../src/workbench-server.ts";
import { WorkCoordinatorKernel } from "../src/work-coordinator.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-native-runtime-")); await writeFile(join(root, "note.txt"), "one");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` });
  const workspace = service.workspaceOpen({ workspace_id: "workspace", name: "workspace", root_path: root, include_paths: ["note.txt"] }).workspace as JsonObject;
  return { root, store, service, workspace };
}

test("v0.11.62 distinguishes portable, guarded, isolated and external autonomy", async () => {
  const f = await fixture(); const { store, service } = f;
  assert.equal(VERSION, "0.11.62");
  assert.throws(() => service.autonomyLadderDecide({ effect: "nope" }), /unsupported/);
  const read = service.autonomyLadderDecide({ decision_id: "read", effect: "read_only" }); assert.equal((read.decision as JsonObject).mode, "portable_read"); assert.equal(service.autonomyLadderDecide({ decision_id: "read", effect: "read_only" }).idempotent, true);
  assert.throws(() => service.autonomyLadderDecide({ effect: "local_write" }), /Workspace and approval/);
  const local = service.autonomyLadderDecide({ decision_id: "local", effect: "local_write", workspace_id: "ws", approved: true }); assert.equal((local.decision as JsonObject).mode, "guarded_local_write");
  assert.throws(() => service.autonomyLadderDecide({ effect: "local_write", workspace_id: "ws", unattended: true }), /platform_profile_id/);
  store.create("platform_execution_conformance", "conformance", { platform: "darwin", status: "verified" });
  store.create("platform_execution_profile", "profile", { platform: "darwin", active: true, isolation: "verified", network: "deny" });
  assert.equal(((service.autonomyLadderDecide({ effect: "local_write", workspace_id: "ws", unattended: true, platform_profile_id: "profile" }).decision as JsonObject).mode), "isolated_local_write");
  assert.throws(() => service.autonomyLadderDecide({ effect: "external_write", platform_profile_id: "profile" }), /authorization_ref/);
  assert.equal(((service.autonomyLadderDecide({ effect: "external_write", platform_profile_id: "profile", authorization_ref: "approved", reobserve_required: true }).decision as JsonObject).mode), "external_gateway");
  assert.throws(() => service.autonomyLadderDecide({ effect: "destructive", platform_profile_id: "profile", authorization_ref: "approved" }), /compensation/);
  store.create("platform_execution_profile", "inactive", { platform: "darwin", active: false, isolation: "verified", network: "deny" });
  assert.throws(() => service.autonomyLadderDecide({ effect: "destructive", platform_profile_id: "inactive", authorization_ref: "approved", compensation_or_handoff: true, decision_id: "blocked-profile" }), /boundary/);
  assert.equal(((service.autonomyLadderDecide({ effect: "destructive", platform_profile_id: "profile", authorization_ref: "approved", compensation_or_handoff: true, decision_id: "destructive" }).decision as JsonObject).mode), "external_gateway");
  assert.throws(() => service.autonomyLadderDecide({ decision_id: "read", effect: "external_write", platform_profile_id: "profile", authorization_ref: "approved", reobserve_required: true }), /conflict/);
  assert.equal((service.autonomyLadderGet({ decision_id: "local" }).decision as JsonObject).id, "local"); store.close(); await rm(f.root, { recursive: true, force: true });
});

test("Workspace Observer remains content-free and classifies unattributed drift", async () => {
  const f = await fixture();
  try {
    const first = f.service.workspaceObserverObserve({ observation_id: "first", workspace_id: f.workspace.id }); assert.equal((first.observation as JsonObject).classification, "unchanged");
    await writeFile(join(f.root, "note.txt"), "two");
    const second = f.service.workspaceObserverObserve({ observation_id: "second", workspace_id: f.workspace.id, previous_snapshot_id: (first.snapshot as JsonObject).id }); assert.equal((second.observation as JsonObject).classification, "external_unattributed");
    assert.equal(f.service.workspaceObserverObserve({ observation_id: "second", workspace_id: f.workspace.id, previous_snapshot_id: (first.snapshot as JsonObject).id }).idempotent, true);
    assert.equal((f.service.workspaceObserverObserve({ workspace_id: f.workspace.id, previous_snapshot_id: (second.snapshot as JsonObject).id, source: "human" }).observation as JsonObject).classification, "unchanged");
    await writeFile(join(f.root, "note.txt"), "three");
    const host = f.service.workspaceObserverObserve({ workspace_id: f.workspace.id, previous_snapshot_id: (second.snapshot as JsonObject).id, source: "host" }); assert.equal((host.observation as JsonObject).classification, "host_observed");
    await writeFile(join(f.root, "note.txt"), "four");
    const human = f.service.workspaceObserverObserve({ workspace_id: f.workspace.id, previous_snapshot_id: (host.snapshot as JsonObject).id, source: "human" }); assert.equal((human.observation as JsonObject).classification, "human_observed");
    assert.throws(() => f.service.workspaceObserverObserve({ observation_id: "second", workspace_id: f.workspace.id, previous_snapshot_id: (host.snapshot as JsonObject).id, source: "host" }), /conflict/);
    const other = f.service.workspaceOpen({ workspace_id: "other", name: "other", root_path: f.root, include_paths: ["note.txt"] }).workspace as JsonObject;
    assert.throws(() => f.service.workspaceObserverObserve({ workspace_id: other.id, previous_snapshot_id: (host.snapshot as JsonObject).id }), /one Workspace/);
    assert.throws(() => f.service.workspaceObserverObserve({ workspace_id: f.workspace.id, source: "robot" }), /unsupported/);
    assert.throws(() => f.service.workspaceObserverGet({ observation_id: " " }), /must not be empty/);
    assert.equal(JSON.stringify(f.service.workspaceObserverGet({ observation_id: "second" })).includes("two"), false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Coordinator and Lab kernels retain idempotency while their live state advances", async () => {
  const f = await fixture();
  try {
    const makeLoop = (id: string) => {
      f.store.create("work_launch", `launch-${id}`, { dispatch_id: `dispatch-${id}`, host: "codex-cli" });
      f.store.create("task_run", `task-${id}`, { launch_id: `launch-${id}` });
      f.store.create("verified_work_loop", `loop-${id}`, { task_run_id: `task-${id}` });
      return f.store.create("execution_fabric", `fabric-${id}`, { work_loop_id: `loop-${id}`, identity_digest: `fabric-${id}` });
    };
    const fabric = makeLoop("one"); makeLoop("two");
    const managed = f.store.create("managed_run", "managed", { identity_digest: "managed" });
    let status = "active";
    const fakeManaged = {
      create: () => ({ run: managed }),
      observe: () => ({ run: managed, observation: f.store.create("managed_run_observation", `observation-${status}`, { status }) }),
      handoff: () => ({ run: managed, handoff: f.store.create("managed_run_handoff", "handoff", {}) }),
      get: () => ({ run: managed }),
    };
    const coordinator = new WorkCoordinatorKernel(f.store, fakeManaged as never);
    const prepared = coordinator.prepare({ coordinator_id: "coordinator", fabric_id: fabric.id });
    assert.equal(coordinator.prepare({ coordinator_id: "coordinator", fabric_id: fabric.id }).idempotent, true);
    assert.throws(() => coordinator.prepare({ coordinator_id: "coordinator", fabric_id: "fabric-two" }), /conflict/);
    f.store.create("host_run", "matching", { dispatch_id: "dispatch-one", host: "codex-cli" });
    f.store.create("host_run", "wrong", { dispatch_id: "wrong", host: "codex-cli" });
    f.store.create("host_run", "wrong-host", { dispatch_id: "dispatch-one", host: "claude-code" });
    f.store.create("host_run", "second", { dispatch_id: "dispatch-one", host: "codex-cli" });
    assert.throws(() => coordinator.attachHostRun({ coordinator_id: "coordinator", host_run_id: "wrong" }), /does not match/);
    assert.throws(() => coordinator.attachHostRun({ coordinator_id: "coordinator", host_run_id: "wrong-host" }), /does not match/);
    coordinator.attachHostRun({ coordinator_id: "coordinator", host_run_id: "matching" });
    assert.equal((coordinator.attachHostRun({ coordinator_id: "coordinator", host_run_id: "matching" }).coordinator as JsonObject).active_host_run_id, "matching");
    assert.throws(() => coordinator.attachHostRun({ coordinator_id: "coordinator", host_run_id: "second" }), /already owns/);
    for (const expected of ["active", "paused", "needs_replan"]) {
      status = expected;
      assert.equal((coordinator.observe({ coordinator_id: "coordinator", task_run_state_id: "state", snapshot_id: "snapshot", work_loop_receipt_id: "receipt", observation_id: `observation-${expected}` }).coordinator as JsonObject).lifecycle, expected === "active" ? "observed" : expected);
    }
    assert.throws(() => coordinator.attachHostRun({ coordinator_id: "coordinator", host_run_id: "matching" }), /requires replan/);
    assert.equal((coordinator.handoff({ coordinator_id: "coordinator", observation_id: "observation-needs_replan", reason: "review" }).coordinator as JsonObject).lifecycle, "paused");
    assert.equal(((coordinator.get({ coordinator_id: "coordinator" }).timeline as JsonObject[]).length > 0), true);
    assert.throws(() => coordinator.get({ coordinator_id: " " }), /must not be empty/);
    assert.equal((prepared.coordinator as JsonObject).id, "coordinator");

    f.store.create("eval_campaign", "campaign-one", { environment_digest: "env", budget_digest: "budget" });
    f.store.create("campaign_runner", "runner-one", { campaign_id: "campaign-one" });
    f.store.create("eval_campaign", "campaign-two", { environment_digest: "env", budget_digest: "budget" });
    f.store.create("campaign_runner", "runner-two", { campaign_id: "campaign-two" });
    const labKernel = new AgentEvalLabKernel(f.store); const lab = labKernel.create({ lab_id: "lab", runner_id: "runner-one" });
    assert.equal(labKernel.create({ lab_id: "lab", runner_id: "runner-one" }).idempotent, true);
    assert.throws(() => labKernel.create({ lab_id: "lab", runner_id: "runner-two" }), /conflict/);
    assert.match(String((labKernel.create({ runner_id: "runner-two" }).lab as JsonObject).id), /^agent_eval_lab_/);
    f.store.create("campaign_runner_dispatch", "dispatch-one", { runner_id: "runner-one", slot_id: "slot-one" });
    f.store.create("campaign_runner_dispatch", "dispatch-two", { runner_id: "runner-one", slot_id: "slot-two" });
    f.store.create("task_run", "eval-task-one", { task_id: "eval-task", environment_digest: "env", budget_digest: "budget" });
    f.store.create("task_run", "eval-task-wrong", { task_id: "eval-task", environment_digest: "wrong", budget_digest: "budget" });
    f.store.create("host_run", "eval-host-one", { task_id: "eval-task", status: "completed" });
    f.store.create("host_run", "eval-host-two", { task_id: "eval-task", status: "completed" });
    f.store.create("managed_run_observation", "eval-observed", { status: "active" });
    f.store.create("managed_run_observation", "eval-replan", { status: "needs_replan" });
    f.store.create("work_coordinator", "eval-coordinator-one", { active_host_run_id: "eval-host-one", latest_observation_id: "eval-observed", lifecycle: "observed", identity_digest: "one" });
    f.store.create("work_coordinator", "eval-coordinator-two", { active_host_run_id: "eval-host-two", latest_observation_id: "eval-replan", lifecycle: "needs_replan", identity_digest: "two" });
    const attempt = labKernel.attach({ lab_id: "lab", dispatch_id: "dispatch-one", task_run_id: "eval-task-one", host_run_id: "eval-host-one", coordinator_id: "eval-coordinator-one", attempt_id: "attempt" });
    assert.equal(labKernel.attach({ lab_id: "lab", dispatch_id: "dispatch-one", task_run_id: "eval-task-one", host_run_id: "eval-host-one", coordinator_id: "eval-coordinator-one", attempt_id: "attempt" }).idempotent, true);
    assert.throws(() => labKernel.attach({ lab_id: "lab", dispatch_id: "dispatch-one", task_run_id: "eval-task-wrong", host_run_id: "eval-host-one", coordinator_id: "eval-coordinator-one", attempt_id: "wrong" }), /comparable/);
    f.store.create("campaign_runner_dispatch", "foreign-dispatch", { runner_id: "runner-two", slot_id: "foreign" });
    assert.throws(() => labKernel.attach({ lab_id: "lab", dispatch_id: "foreign-dispatch", task_run_id: "eval-task-one", host_run_id: "eval-host-one", coordinator_id: "eval-coordinator-one", attempt_id: "foreign" }), /comparable/);
    f.store.create("task_run", "eval-task-budget", { task_id: "eval-task", environment_digest: "env", budget_digest: "wrong" });
    assert.throws(() => labKernel.attach({ lab_id: "lab", dispatch_id: "dispatch-one", task_run_id: "eval-task-budget", host_run_id: "eval-host-one", coordinator_id: "eval-coordinator-one", attempt_id: "wrong-budget" }), /comparable/);
    assert.throws(() => labKernel.attach({ lab_id: "lab", dispatch_id: "dispatch-one", task_run_id: "eval-task-one", host_run_id: "eval-host-two", coordinator_id: "eval-coordinator-one", attempt_id: "wrong-host" }), /exact coordinated/);
    f.store.create("host_run", "eval-host-wrong-task", { task_id: "wrong", status: "completed" }); f.store.create("work_coordinator", "eval-coordinator-wrong-task", { active_host_run_id: "eval-host-wrong-task", latest_observation_id: "eval-observed", lifecycle: "observed", identity_digest: "wrong-task" });
    assert.throws(() => labKernel.attach({ lab_id: "lab", dispatch_id: "dispatch-one", task_run_id: "eval-task-one", host_run_id: "eval-host-wrong-task", coordinator_id: "eval-coordinator-wrong-task", attempt_id: "wrong-task" }), /exact coordinated/);
    f.store.create("task_run", "eval-task-malformed", { environment_digest: "env", budget_digest: "budget", launch_identity: [] });
    assert.throws(() => labKernel.attach({ lab_id: "lab", dispatch_id: "dispatch-one", task_run_id: "eval-task-malformed", host_run_id: "eval-host-one", coordinator_id: "eval-coordinator-one", attempt_id: "malformed" }), /comparable|task_id/);
    assert.throws(() => labKernel.attach({ lab_id: "lab", dispatch_id: "dispatch-two", task_run_id: "eval-task-one", host_run_id: "eval-host-one", coordinator_id: "eval-coordinator-one", attempt_id: "attempt" }), /conflict/);
    assert.throws(() => labKernel.observe({ attempt_id: (attempt.attempt as JsonObject).id, observation_id: "wrong" }), /latest observation/);
    f.store.save("work_coordinator", "eval-coordinator-one", { ...f.store.get("work_coordinator", "eval-coordinator-one"), lifecycle: "running" });
    assert.throws(() => labKernel.observe({ attempt_id: (attempt.attempt as JsonObject).id, observation_id: "eval-observed" }), /terminal/);
    f.store.save("work_coordinator", "eval-coordinator-one", { ...f.store.get("work_coordinator", "eval-coordinator-one"), lifecycle: "observed" }); f.store.save("host_run", "eval-host-one", { ...f.store.get("host_run", "eval-host-one"), status: "running" });
    assert.throws(() => labKernel.observe({ attempt_id: (attempt.attempt as JsonObject).id, observation_id: "eval-observed" }), /terminal/);
    f.store.save("host_run", "eval-host-one", { ...f.store.get("host_run", "eval-host-one"), status: "completed" });
    assert.equal(labKernel.observe({ attempt_id: (attempt.attempt as JsonObject).id, observation_id: "eval-observed" }).eligible_for_campaign, true);
    const replan = labKernel.attach({ lab_id: "lab", dispatch_id: "dispatch-two", task_run_id: "eval-task-one", host_run_id: "eval-host-two", coordinator_id: "eval-coordinator-two", attempt_id: "replan" });
    assert.equal((labKernel.observe({ attempt_id: (replan.attempt as JsonObject).id, observation_id: "eval-replan" }).attempt as JsonObject).lifecycle, "inconclusive");
    assert.equal((labKernel.get({ lab_id: "lab" }).attempts as JsonObject[]).length, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Work Coordinator owns one Host Run and records re-observation after Fabric execution", async () => {
  const f = await fixture();
  try {
    const prepared = f.service.executionFabricPrepare({ fabric_id: "fabric", workspace_id: f.workspace.id, title: "Inspect", goal: "inspect", host: "codex-cli", prompt: "inspect", sandbox: "read-only" }); const fabric = prepared.execution_fabric as JsonObject; const coordinator = prepared.work_coordinator as JsonObject;
    assert.equal(f.service.workCoordinatorPrepare({ fabric_id: fabric.id }).idempotent, true);
    const execution = f.service.executionFabricExecute({ fabric_id: fabric.id, prompt: "inspect" }); await f.service.hostRuns.wait(String((execution.run as JsonObject).id));
    const state = f.service.workCoordinatorGet({ coordinator_id: coordinator.id }).coordinator as JsonObject; assert.equal(state.lifecycle, "observed");
    assert.throws(() => f.service.workCoordinatorAttachHostRun({ coordinator_id: coordinator.id, host_run_id: "missing" }), /Unknown/);
    const full = new McpServer(f.service, "full"); const core = new McpServer(f.service, "core"); assert.ok(full.tools.some((item) => item.name === "craft_work_coordinator_observe")); assert.ok(core.tools.some((item) => item.name === "craft_work_coordinator_get")); assert.equal(core.tools.some((item) => item.name === "craft_work_coordinator_observe"), false); const app = new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:1"); assert.equal(app.handle({ method: "GET", path: `/api/work-coordinators/${coordinator.id}`, token: "token" }).status, 200);
  } finally { await Promise.all(f.store.list("host_run", 20).map((run) => f.service.hostRuns.wait(String(run.id)))); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Agent Eval Lab rejects incomparable or unobserved Host attempts", async () => {
  const f = await fixture();
  try {
    f.store.create("eval_campaign", "campaign", { environment_digest: "env", budget_digest: "budget" }); f.store.create("campaign_runner", "runner", { campaign_id: "campaign" });
    const lab = f.service.agentEvalLabCreate({ lab_id: "lab", runner_id: "runner" }).lab as JsonObject; assert.equal(f.service.agentEvalLabCreate({ lab_id: "lab", runner_id: "runner" }).idempotent, true);
    f.store.create("campaign_runner_dispatch", "dispatch", { runner_id: "runner", slot_id: "slot" }); f.store.create("task_run", "task", { task_id: "task-id", environment_digest: "env", budget_digest: "budget" }); f.store.create("host_run", "host", { task_id: "task-id", status: "completed" }); f.store.create("managed_run_observation", "observation", { status: "active" }); f.store.create("work_coordinator", "coordinator", { active_host_run_id: "host", latest_observation_id: "observation", lifecycle: "observed" });
    const attached = f.service.agentEvalLabAttach({ lab_id: lab.id, dispatch_id: "dispatch", task_run_id: "task", host_run_id: "host", coordinator_id: "coordinator" }); assert.equal((attached.attempt as JsonObject).lifecycle, "running");
    assert.equal((f.service.agentEvalLabObserve({ attempt_id: (attached.attempt as JsonObject).id, observation_id: "observation" }).attempt as JsonObject).lifecycle, "observed");
    f.store.create("task_run", "wrong", { task_id: "task-id", environment_digest: "other", budget_digest: "budget" }); assert.throws(() => f.service.agentEvalLabAttach({ lab_id: lab.id, dispatch_id: "dispatch", task_run_id: "wrong", host_run_id: "host", coordinator_id: "coordinator", attempt_id: "wrong" }), /comparable/);
    assert.equal((f.service.agentEvalLabGet({ lab_id: lab.id }).attempts as JsonObject[]).length, 1); assert.equal(new WorkbenchWebApp(f.service, "token", "http://127.0.0.1:1").handle({ method: "GET", path: `/api/agent-eval-labs/${lab.id}`, token: "token" }).status, 200);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Full MCP starts one comparable Agent Eval attempt and exposes every v0.11.62 action", async () => {
  const f = await fixture();
  try {
    const full = new McpServer(f.service, "full");
    const observer = await full.handlers.craft_workspace_observer_observe({ workspace_id: f.workspace.id, observation_id: "mcp-observation" });
    await full.handlers.craft_workspace_observer_get({ observation_id: (observer.observation as JsonObject).id });
    const decision = await full.handlers.craft_autonomy_ladder_decide({ decision_id: "mcp-read", effect: "read_only" });
    await full.handlers.craft_autonomy_ladder_get({ decision_id: (decision.decision as JsonObject).id });
    const prepared = f.service.executionFabricPrepare({ fabric_id: "mcp-fabric", workspace_id: f.workspace.id, title: "Eval", goal: "eval", host: "codex-cli", prompt: "eval", sandbox: "read-only", environment: { image: "stable" }, budget: { tokens: 1 } });
    const fabric = prepared.execution_fabric as JsonObject; const coordinator = prepared.work_coordinator as JsonObject; const loop = prepared.work_loop as JsonObject;
    const legacy = f.service.executionFabricPrepare({ fabric_id: "legacy-fabric", workspace_id: f.workspace.id, title: "Legacy", goal: "legacy", host: "codex-cli", prompt: "legacy", sandbox: "read-only" }); const legacyFabric = legacy.execution_fabric as JsonObject;
    const storeInternals = f.store as unknown as { list: CraftStore["list"] }; const originalList = f.store.list.bind(f.store);
    storeInternals.list = ((kind: string, limit: number, predicate?: (item: JsonObject) => boolean) => kind === "work_coordinator" ? [] : originalList(kind, limit, predicate)) as CraftStore["list"];
    const legacyExecution = f.service.executionFabricExecute({ fabric_id: legacyFabric.id, prompt: "legacy" }); assert.equal(legacyExecution.coordinator, null); assert.equal(f.service.executionFabricGet({ fabric_id: legacyFabric.id }).coordinator, null);
    storeInternals.list = originalList as CraftStore["list"]; await f.service.hostRuns.wait(String((legacyExecution.run as JsonObject).id));
    storeInternals.list = ((kind: string, limit: number, predicate?: (item: JsonObject) => boolean) => kind === "work_coordinator" ? [] : originalList(kind, limit, predicate)) as CraftStore["list"];
    (f.service as unknown as { finishFabricHostBridge(run: JsonObject): void }).finishFabricHostBridge(f.store.get("host_run", String((legacyExecution.run as JsonObject).id)));
    storeInternals.list = originalList as CraftStore["list"];
    await full.handlers.craft_work_coordinator_prepare({ fabric_id: fabric.id });
    for (const name of ["craft_work_coordinator_attach_host_run", "craft_work_coordinator_observe", "craft_work_coordinator_handoff"] as const) {
      await assert.rejects(async () => { await full.handlers[name]({ coordinator_id: coordinator.id, host_run_id: "missing", task_run_state_id: "missing", snapshot_id: "missing", work_loop_receipt_id: "missing", observation_id: "missing", reason: "review" }); }, /Unknown/);
    }
    await full.handlers.craft_work_coordinator_get({ coordinator_id: coordinator.id });
    f.service.deliveryEvaluationCaseSave({ case_id: "case", name: "case", domain: "software", partition: "held_out", acceptance_contract_ref: "accept", sanitized: true, approved_by: "reviewer" });
    const campaign = f.service.evalCampaignCreate({ campaign_id: "campaign", case_ids: ["case"], baseline_harness: "minimal", candidate_harness: "retrieval", trials_per_case: 2, acceptance_ref: "accept", environment: { image: "stable" }, budget: { tokens: 1 } }).campaign as JsonObject;
    const runner = f.service.campaignRunnerCreate({ runner_id: "runner", campaign_id: campaign.id, evaluator_ref: "accept" }).runner as JsonObject;
    const lab = await full.handlers.craft_agent_eval_lab_create({ lab_id: "lab", runner_id: runner.id });
    assert.throws(() => f.service.agentEvalLabStart({ lab_id: (lab.lab as JsonObject).id, fabric_id: fabric.id, prompt: "eval", harness: "wrong" }), /Harness/);
    const internals = f.service as unknown as { campaignRunnerClaim(args: JsonObject): JsonObject };
    const originalClaim = internals.campaignRunnerClaim.bind(f.service); internals.campaignRunnerClaim = () => ({ dispatch: null });
    assert.throws(() => f.service.agentEvalLabStart({ lab_id: (lab.lab as JsonObject).id, fabric_id: fabric.id, prompt: "eval" }), /changed before claim/); internals.campaignRunnerClaim = originalClaim;
    let coordinatorLists = 0;
    storeInternals.list = ((kind: string, limit: number, predicate?: (item: JsonObject) => boolean) => kind === "work_coordinator" && ++coordinatorLists === 2 ? [] : originalList(kind, limit, predicate)) as CraftStore["list"];
    assert.throws(() => f.service.agentEvalLabStart({ lab_id: (lab.lab as JsonObject).id, fabric_id: fabric.id, prompt: "eval" }), /requires a Work Coordinator/); storeInternals.list = originalList as CraftStore["list"];
    const started = await full.handlers.craft_agent_eval_lab_start({ lab_id: (lab.lab as JsonObject).id, fabric_id: fabric.id, prompt: "eval", harness: "retrieval" });
    await f.service.hostRuns.wait(String(((started.execution as JsonObject).run as JsonObject).id));
    const observedCoordinator = f.service.workCoordinatorGet({ coordinator_id: coordinator.id }).coordinator as JsonObject;
    const observed = await full.handlers.craft_agent_eval_lab_observe({ attempt_id: (started.attempt as JsonObject).id, observation_id: observedCoordinator.latest_observation_id });
    assert.equal(observed.eligible_for_campaign, true);
    await full.handlers.craft_agent_eval_lab_get({ lab_id: (lab.lab as JsonObject).id });
    f.store.create("eval_campaign", "empty-campaign", { environment_digest: "env", budget_digest: "budget" }); f.store.create("campaign_runner", "empty-runner", { campaign_id: "empty-campaign", lifecycle: "ready", issued_slot_ids: [] });
    const empty = f.service.agentEvalLabCreate({ lab_id: "empty-lab", runner_id: "empty-runner" }).lab as JsonObject;
    assert.throws(() => f.service.agentEvalLabStart({ lab_id: empty.id, fabric_id: fabric.id, prompt: "eval" }), /no pending/);
    f.store.save("campaign_runner", "empty-runner", { ...f.store.get("campaign_runner", "empty-runner"), lifecycle: "completed" }); assert.throws(() => f.service.campaignRunners.preview({ runner_id: "empty-runner" }), /completed/);
    assert.equal((loop.task_id as string).length > 0, true);
  } finally { await Promise.all(f.store.list("host_run", 20).map((run) => f.service.hostRuns.wait(String(run.id)))); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
