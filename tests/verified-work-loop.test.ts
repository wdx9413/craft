import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

const hash = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-work-loop-")); await writeFile(join(root, "note.txt"), "before");
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` });
  const workspace = service.workspaceOpen({ workspace_id: "workspace", name: "Workspace", root_path: root, include_paths: ["note.txt"] }).workspace as JsonObject;
  return { root, store, service, workspace };
}

function observedRun(store: CraftStore, id: string, delivery: string, environment: JsonObject = { image: "same" }, budget: JsonObject = { usd: 1 }): void {
  const launchId = `launch-${id}`; store.create("task_run", id, { launch_id: launchId, environment_digest: hash(environment), budget_digest: hash(budget) });
  store.create("work_launch", launchId, { trial_id: `trial-${id}` }); store.create("outcome", `outcome_trial-${id}`, { verdict: delivery === "host_failed" ? "failed" : "passed", costs: {} }); store.create("work_delivery", `delivery-${id}`, { launch_id: launchId, status: delivery });
}
function unobservedRun(store: CraftStore, id: string, environment: JsonObject = {}, budget: JsonObject = {}): void {
  const launchId = `launch-${id}`; store.create("task_run", id, { launch_id: launchId, environment_digest: hash(environment), budget_digest: hash(budget) }); store.create("work_launch", launchId, { trial_id: `trial-${id}` });
}

test("Verified Work Loop is the small public seam over launch, observed state, approval, acceptance, human changes and replan", async () => {
  const f = await fixture();
  try {
    const prepared = f.service.verifiedWorkLoopPrepare({ work_loop_id: "read-loop", workspace_id: f.workspace.id, title: "Read", goal: "inspect", host: "codex-cli", prompt: "inspect private details", sandbox: "read-only", environment: { image: "same" }, budget: { usd: 1 } });
    const run = prepared.task_run as JsonObject; const launch = prepared.launch as JsonObject; const loop = prepared.work_loop as JsonObject;
    assert.equal(JSON.stringify(loop).includes("private details"), false); await f.service.hostRuns.wait(String(launch.run_id));
    const advanced = f.service.verifiedWorkLoopAdvance({ work_loop_id: loop.id, environment: { image: "same" }, budget: { usd: 1 } }); assert.equal((advanced.state as JsonObject).status, "ready_for_delivery");
    assert.equal((f.service.verifiedWorkLoopGet({ work_loop_id: loop.id }).receipts as JsonObject[]).length, 1);
    const changed = f.service.verifiedWorkLoopDecide({ work_loop_id: loop.id, decision: "human_change", actor: "user", summary: "adjusted", affected_paths: ["note.txt"] }); assert.equal(((changed.advance as JsonObject).state as JsonObject).status, "needs_replan");
    assert.throws(() => f.service.verifiedWorkLoopResume({ work_loop_id: loop.id }), /fresh prepare/);
    assert.throws(() => f.service.verifiedWorkLoopDecide({ work_loop_id: loop.id, decision: "bad", actor: "user", summary: "no" }), /unsupported/);
    const written = f.service.verifiedWorkLoopPrepare({ work_loop_id: "write-loop", workspace_id: f.workspace.id, title: "Write", goal: "edit", host: "codex-cli", prompt: "edit", sandbox: "workspace-write", acceptance_name: "review", acceptance_criteria: [{ id: "human", name: "Human", method: "human", required: true }] });
    const writeLoop = written.work_loop as JsonObject; const writeLaunch = written.launch as JsonObject; assert.equal((f.service.verifiedWorkLoopAdvance({ work_loop_id: writeLoop.id }).state as JsonObject).status, "awaiting_approval");
    assert.throws(() => f.service.verifiedWorkLoopDecide({ work_loop_id: writeLoop.id, decision: "approve", actor: "user", summary: "go", approved: false, prompt: "edit" }), /approved/);
    const approved = f.service.verifiedWorkLoopDecide({ work_loop_id: writeLoop.id, decision: "approve", actor: "user", summary: "go", approved: true, prompt: "edit" }); assert.equal(((approved.launch as JsonObject).launch as JsonObject).status, "running"); await f.service.hostRuns.wait(String((f.service.workLaunchGet({ launch_id: writeLaunch.id }).launch as JsonObject).run_id));
    assert.equal((f.service.verifiedWorkLoopAdvance({ work_loop_id: writeLoop.id }).state as JsonObject).status, "awaiting_acceptance");
    assert.throws(() => f.service.verifiedWorkLoopDecide({ work_loop_id: writeLoop.id, decision: "accept", actor: "user", summary: "missing" }), /criterion/);
    f.service.verifiedWorkLoopDecide({ work_loop_id: writeLoop.id, decision: "accept", actor: "user", summary: "checked", criterion_id: "human" }); assert.equal((f.service.verifiedWorkLoopAdvance({ work_loop_id: writeLoop.id }).state as JsonObject).status, "ready_for_delivery");
    const paused = f.service.verifiedWorkLoopPrepare({ work_loop_id: "paused-loop", workspace_id: f.workspace.id, title: "Pause", goal: "read", host: "codex-cli", prompt: "read", sandbox: "read-only" }); const pausedLoop = paused.work_loop as JsonObject; const pausedRun = paused.task_run as JsonObject; await f.service.hostRuns.wait(String((paused.launch as JsonObject).run_id)); f.service.taskRunPause({ task_run_id: pausedRun.id, reason: "handoff" }); assert.equal((f.service.verifiedWorkLoopResume({ work_loop_id: pausedLoop.id }).resumed as JsonObject).idempotent, false);
    const replanned = f.service.verifiedWorkLoopDecide({ work_loop_id: pausedLoop.id, decision: "replan", actor: "user", summary: "changed input" }); assert.ok((replanned.decision as JsonObject).id); assert.equal(f.service.verifiedWorkLoopDecide({ work_loop_id: pausedLoop.id, decision: "replan", actor: "user", summary: "changed input" }).idempotent, true);
    const noPaths = f.service.verifiedWorkLoopPrepare({ work_loop_id: "no-paths", workspace_id: f.workspace.id, title: "No paths", goal: "read", host: "codex-cli", prompt: "read" }); await f.service.hostRuns.wait(String((noPaths.launch as JsonObject).run_id)); assert.ok((f.service.verifiedWorkLoopDecide({ work_loop_id: (noPaths.work_loop as JsonObject).id, decision: "human_change", actor: "user", summary: "external edit" }).human_state_event as JsonObject).id);
    const rejection = f.service.verifiedWorkLoopPrepare({ work_loop_id: "reject-loop", workspace_id: f.workspace.id, title: "Reject", goal: "read", host: "codex-cli", prompt: "read", acceptance_name: "manual", acceptance_criteria: [{ id: "manual", name: "Manual", method: "human", required: true }] }); assert.ok((f.service.verifiedWorkLoopDecide({ work_loop_id: (rejection.work_loop as JsonObject).id, decision: "reject", actor: "user", summary: "not acceptable", criterion_id: "manual" }).decision as JsonObject).id); await f.service.hostRuns.wait(String((rejection.launch as JsonObject).run_id));
    const resumeDrift = f.service.verifiedWorkLoopPrepare({ work_loop_id: "resume-drift", workspace_id: f.workspace.id, title: "Resume drift", goal: "read", host: "codex-cli", prompt: "read" }); const resumeRun = resumeDrift.task_run as JsonObject; f.service.taskRunPause({ task_run_id: resumeRun.id, reason: "wait" }); await writeFile(join(f.root, "note.txt"), "resume drift"); assert.throws(() => f.service.verifiedWorkLoopResume({ work_loop_id: (resumeDrift.work_loop as JsonObject).id }), /fresh prepare/); await f.service.hostRuns.wait(String((resumeDrift.launch as JsonObject).run_id));
    assert.equal(VERSION, "0.11.60");
  } finally { await Promise.all(f.store.list("host_run", 100).map((run) => f.service.hostRuns.wait(String(run.id)))); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("State Workspace adapters retain only hashes, reject unsafe selections, and compare file tree and file artifact observations", async () => {
  const f = await fixture();
  try {
    const first = f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, snapshot_id: "first" }).snapshot as JsonObject;
    assert.equal(f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, snapshot_id: "first" }).idempotent, true);
    await writeFile(join(f.root, "note.txt"), "after"); const artifact = f.service.artifactRegister({ artifact_id: "artifact", kind: "file", name: "note", uri: "file://note.txt", producer_type: "test", producer_id: "test" }) as JsonObject;
    const second = f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, snapshot_id: "second" }).snapshot as JsonObject;
    assert.deepEqual((f.service.stateWorkspaceCompare({ before_snapshot_id: first.id, after_snapshot_id: second.id }).difference as JsonObject).modified_paths, ["note.txt"]);
    const file = f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: ["note.txt"], artifact_ids: [artifact.id] }).snapshot as JsonObject; assert.deepEqual(file.artifact_ids, [artifact.id]);
    await mkdir(join(f.root, "dir")); await writeFile(join(f.root, "dir", "nested.txt"), "nested"); await writeFile(join(f.root, "dir", "second.txt"), "second"); const directory = f.service.workspaceOpen({ workspace_id: "directory", name: "Directory", root_path: f.root, include_paths: ["dir"] }).workspace as JsonObject; assert.equal(((f.service.stateWorkspaceObserve({ workspace_id: directory.id }).snapshot as JsonObject).entries as JsonObject[]).length, 2);
    const rootArtifact = f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: ["./"] }).snapshot as JsonObject; assert.ok((rootArtifact.entries as JsonObject[]).length > 0); execFileSync("mkfifo", [join(f.root, "pipe")]);
    await symlink(join(f.root, "note.txt"), join(f.root, "link")); const linked = f.service.workspaceOpen({ workspace_id: "linked", name: "Linked", root_path: f.root, include_paths: ["link"] }).workspace as JsonObject;
    assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "other" }), /unsupported/); assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact" }), /requires/); assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: ["../x"] }), /relative/); assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: ["note.txt", "note.txt"] }), /unique/); assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: ["pipe"] }), /regular files/); assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: linked.id }), /symbolic/); assert.throws(() => f.service.stateWorkspaceCompare({ before_snapshot_id: first.id, after_snapshot_id: f.store.create("state_snapshot", "other", { workspace_id: "other", entries: [], snapshot_digest: "x" }).id }), /one workspace/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Eval Campaign plans held-out repeated pairs, binds only comparable observed runs, and keeps candidate evolution gated", async () => {
  const f = await fixture();
  try {
    f.service.deliveryEvaluationCaseSave({ case_id: "held", name: "held", domain: "software", partition: "held_out", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" }); f.service.deliveryEvaluationCaseSave({ case_id: "dev", name: "dev", domain: "software", partition: "development", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" });
    assert.throws(() => f.service.evalCampaignCreate({ case_ids: ["dev"], baseline_harness: "single", candidate_harness: "retrieval", trials_per_case: 2, acceptance_ref: "contract" }), /held_out/);
    const campaign = f.service.evalCampaignCreate({ campaign_id: "campaign", case_ids: ["held"], baseline_harness: "single", candidate_harness: "retrieval", trials_per_case: 2, acceptance_ref: "contract", environment: { image: "same" }, budget: { usd: 1 } }).campaign as JsonObject; assert.equal(f.service.evalCampaignCreate({ campaign_id: "campaign", case_ids: ["held"], baseline_harness: "single", candidate_harness: "retrieval", trials_per_case: 2, acceptance_ref: "contract", environment: { image: "same" }, budget: { usd: 1 } }).idempotent, true); assert.equal((f.service.evalCampaignAdvance({ campaign_id: campaign.id }) as JsonObject).status, "collecting");
    const slots = f.service.evalCampaignGet({ campaign_id: campaign.id }).slots as JsonObject[]; for (const slot of slots) observedRun(f.store, `run-${slot.id}`, slot.arm === "baseline" ? "host_failed" : "accepted");
    assert.throws(() => f.service.evalCampaignBind({ slot_id: slots[0].id, task_run_id: f.store.create("task_run", "wrong", { launch_id: "wrong", environment_digest: hash({ image: "wrong" }), budget_digest: hash({ usd: 1 }) }).id }), /environment/);
    for (const slot of slots) f.service.evalCampaignBind({ slot_id: slot.id, task_run_id: `run-${slot.id}` }); assert.equal(f.service.evalCampaignBind({ slot_id: slots[0].id, task_run_id: `run-${slots[0].id}` }).idempotent, true); assert.throws(() => f.service.evalCampaignBind({ slot_id: slots[0].id, task_run_id: `run-${slots[1].id}` }), /already/);
    const advanced = f.service.evalCampaignAdvance({ campaign_id: campaign.id }); assert.equal((advanced.campaign as JsonObject).lifecycle, "eligible"); assert.equal((advanced.evaluation as JsonObject).status, "eligible_for_signoff");
    assert.throws(() => f.service.evalCampaignCreate({ campaign_id: "campaign", case_ids: ["held"], baseline_harness: "single", candidate_harness: "different", trials_per_case: 2, acceptance_ref: "contract", environment: { image: "same" }, budget: { usd: 1 } }), /conflict/); assert.throws(() => f.service.evalCampaignCreate({ case_ids: ["held", "held"], baseline_harness: "single", candidate_harness: "retrieval", trials_per_case: 2, acceptance_ref: "contract" }), /unique/); assert.throws(() => f.service.evalCampaignCreate({ case_ids: ["held"], baseline_harness: "single", candidate_harness: "retrieval", trials_per_case: 1, acceptance_ref: "contract" }), /between/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Project Knowledge reads only trusted Serena project memories, pins selection, and proposes but never writes updates", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, ".serena", "memories"), { recursive: true }); await writeFile(join(f.root, ".serena", "memories", "build.md"), "run the unit suite"); await writeFile(join(f.root, ".serena", "memories", "style.md"), "keep modules small");
    assert.throws(() => f.service.projectKnowledgeDiscover({ project_root: f.root, trusted: false }), /trusted/); const discovery = f.service.projectKnowledgeDiscover({ discovery_id: "knowledge", project_root: f.root, trusted: true }).discovery as JsonObject; assert.equal((discovery.descriptors as JsonObject[]).length, 2); assert.equal(f.service.projectKnowledgeDiscover({ discovery_id: "knowledge", project_root: f.root, trusted: true }).idempotent, true);
    const resolved = f.service.projectKnowledgeResolve({ resolution_id: "resolution", discovery_id: discovery.id, memory_ids: ["serena:build", "serena:style"] }); assert.equal((resolved.memories as JsonObject[]).length, 2); assert.equal(f.service.projectKnowledgeResolve({ resolution_id: "resolution", discovery_id: discovery.id, memory_ids: ["serena:build", "serena:style"] }).idempotent, true); assert.equal(JSON.stringify(resolved.resolution).includes("unit suite"), false); assert.throws(() => f.service.projectKnowledgeResolve({ discovery_id: discovery.id, memory_ids: [] }), /one to three/); assert.throws(() => f.service.projectKnowledgeResolve({ discovery_id: discovery.id, memory_ids: ["serena:missing"] }), /not in/); assert.throws(() => f.service.projectKnowledgeResolve({ discovery_id: discovery.id, memory_ids: ["serena:build"], max_chars: 0 }), /integer/); assert.throws(() => f.service.projectKnowledgeResolve({ discovery_id: discovery.id, memory_ids: ["serena:build"], max_chars: 1 }), /exceeds/);
    const evidence = f.service.evidenceRecord({ evidence_id: "evidence", source_type: "program", confidence: "confirmed", claim: "unit suite passed", locator: "test" }) as JsonObject; const proposal = f.service.projectKnowledgeProposeUpdate({ proposal_id: "proposal", discovery_id: discovery.id, memory_id: "serena:build", evidence_ids: [evidence.id], summary: "refresh command" }).proposal as JsonObject; assert.equal(f.service.projectKnowledgeProposeUpdate({ proposal_id: "proposal", discovery_id: discovery.id, memory_id: "serena:build", evidence_ids: [evidence.id], summary: "refresh command" }).idempotent, true); assert.equal(proposal.writes_external_memory, false); assert.throws(() => f.service.projectKnowledgeProposeUpdate({ discovery_id: discovery.id, memory_id: "serena:build", evidence_ids: [], summary: "x" }), /requires/); assert.throws(() => f.service.projectKnowledgeProposeUpdate({ discovery_id: discovery.id, memory_id: "serena:missing", evidence_ids: [evidence.id], summary: "x" }), /not in/);
    await writeFile(join(f.root, ".serena", "memories", "build.md"), "changed"); assert.throws(() => f.service.projectKnowledgeResolve({ discovery_id: discovery.id, memory_ids: ["serena:build"] }), /changed/);
    const full = new McpServer(f.service, "full"); const core = new McpServer(f.service, "core"); assert.ok(full.tools.some((tool) => tool.name === "craft_verified_work_loop_prepare")); assert.ok(core.tools.some((tool) => tool.name === "craft_verified_work_loop_get")); assert.ok(core.tools.some((tool) => tool.name === "craft_verified_work_loop_prepare")); assert.equal(((await full.handlers.craft_project_knowledge_discover({ project_root: f.root, trusted: true, discovery_id: "mcp" })).discovery as JsonObject).id, "mcp"); await full.handlers.craft_project_knowledge_resolve({ discovery_id: "mcp", memory_ids: ["serena:style"] }); await full.handlers.craft_project_knowledge_propose_update({ discovery_id: "mcp", memory_id: "serena:style", evidence_ids: [evidence.id], summary: "mcp" });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Verified Work Loop kernels reject mixed facts, retain idempotent receipts, and expose every MCP command through the full surface", async () => {
  const f = await fixture();
  try {
    const full = new McpServer(f.service, "full");
    const prepared = await full.handlers.craft_verified_work_loop_prepare({ work_loop_id: "mcp-loop", workspace_id: f.workspace.id, title: "MCP", goal: "read", host: "codex-cli", prompt: "read", sandbox: "read-only" }) as JsonObject;
    const loop = prepared.work_loop as JsonObject; const launch = prepared.launch as JsonObject; const taskRun = prepared.task_run as JsonObject;
    await f.service.hostRuns.wait(String(launch.run_id));
    const advanced = await full.handlers.craft_verified_work_loop_advance({ work_loop_id: loop.id }) as JsonObject;
    assert.equal((advanced.state as JsonObject).status, "ready_for_delivery");
    assert.ok((await full.handlers.craft_verified_work_loop_get({ work_loop_id: loop.id })).loop);
    const firstReceipt = f.store.get("verified_work_loop_receipt", String((advanced.receipt as JsonObject).id));
    assert.equal((f.service.verifiedWorkLoops.advance({ work_loop_id: loop.id, task_run_state_id: firstReceipt.task_run_state_id, snapshot_id: firstReceipt.snapshot_id, receipt_id: firstReceipt.id }).receipt as JsonObject).id, firstReceipt.id);
    assert.throws(() => f.service.verifiedWorkLoops.advance({ work_loop_id: loop.id, task_run_state_id: firstReceipt.task_run_state_id, snapshot_id: f.store.create("state_snapshot", "wrong-snapshot", { workspace_id: "other", entries: [], snapshot_digest: "x", workspace_state_revision: 0 }).id }), /does not belong/);
    const idempotent = f.service.verifiedWorkLoops.decide({ work_loop_id: loop.id, decision: "replan", actor: "user", summary: "same", decision_id: "direct-decision" });
    assert.equal(f.service.verifiedWorkLoops.decide({ work_loop_id: loop.id, decision: "replan", actor: "user", summary: "same", decision_id: "direct-decision" }).idempotent, true);
    assert.throws(() => f.service.verifiedWorkLoops.decide({ work_loop_id: loop.id, decision: "replan", actor: "user", summary: "other", decision_id: "direct-decision" }), /conflict/);
    assert.throws(() => f.service.verifiedWorkLoops.create({ work_loop_id: loop.id, task_id: (prepared.task as JsonObject).id, contract_id: (prepared.contract as JsonObject).id, task_run_id: taskRun.id, snapshot_id: "wrong-snapshot" }), /conflict/);
    const snapshot = await full.handlers.craft_state_workspace_observe({ workspace_id: f.workspace.id, snapshot_id: "mcp-state" }) as JsonObject;
    const mcpSnapshot = snapshot.snapshot as JsonObject;
    assert.equal(((await full.handlers.craft_state_workspace_compare({ before_snapshot_id: mcpSnapshot.id, after_snapshot_id: mcpSnapshot.id }) as JsonObject).difference as JsonObject).changed, false);
    await full.handlers.craft_verified_work_loop_decide({ work_loop_id: loop.id, decision: "human_change", actor: "user", summary: "replan", affected_paths: ["note.txt"] });
    assert.throws(() => full.handlers.craft_verified_work_loop_resume({ work_loop_id: loop.id }), /fresh prepare/);

    f.service.deliveryEvaluationCaseSave({ case_id: "mcp-held", name: "MCP held", domain: "software", partition: "held_out", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" });
    const campaign = await full.handlers.craft_eval_campaign_create({ campaign_id: "mcp-campaign", case_ids: ["mcp-held"], baseline_harness: "single", candidate_harness: "retrieval", trials_per_case: 2, acceptance_ref: "contract" }) as JsonObject;
    const mcpCampaign = campaign.campaign as JsonObject;
    assert.equal(((await full.handlers.craft_eval_campaign_get({ campaign_id: mcpCampaign.id }) as JsonObject).slots as JsonObject[]).length, 4);
    assert.equal((await full.handlers.craft_eval_campaign_advance({ campaign_id: mcpCampaign.id }) as JsonObject).status, "collecting");
    const slot = (campaign.slots as JsonObject[])[0]; observedRun(f.store, "mcp-bound", "accepted", {}, {});
    await full.handlers.craft_eval_campaign_bind({ slot_id: slot.id, task_run_id: "mcp-bound" });
    assert.equal((await full.handlers.craft_eval_campaign_advance({ campaign_id: mcpCampaign.id }) as JsonObject).status, "collecting");
    assert.equal(idempotent.idempotent, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("State, campaign, and project-knowledge failures remain explicit instead of silently widening execution", async () => {
  const f = await fixture();
  try {
    const empty = f.service.workspaceOpen({ workspace_id: "empty", name: "Empty", root_path: f.root, include_paths: ["missing.txt"] }).workspace as JsonObject;
    assert.deepEqual((f.service.stateWorkspaceObserve({ workspace_id: empty.id }).snapshot as JsonObject).entries, []);
    assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: ["/tmp/nope"] }), /relative/);
    await mkdir(join(f.root, "overlap")); await writeFile(join(f.root, "overlap", "child.txt"), "child");
    assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: ["overlap", "overlap/child.txt"] }), /overlap/);
    const before = f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: ["note.txt"], snapshot_id: "before-file" }).snapshot as JsonObject;
    await writeFile(join(f.root, "added.txt"), "added");
    const after = f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: ["added.txt"], snapshot_id: "after-file" }).snapshot as JsonObject;
    const diff = f.service.stateWorkspaceCompare({ before_snapshot_id: before.id, after_snapshot_id: after.id }).difference as JsonObject;
    assert.deepEqual(diff.added_paths, ["added.txt"]); assert.deepEqual(diff.deleted_paths, ["note.txt"]);
    assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, snapshot_id: "before-file" }), /conflict/);

    f.service.deliveryEvaluationCaseSave({ case_id: "awaiting", name: "Awaiting", domain: "files", partition: "held_out", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" });
    const awaiting = f.service.evalCampaignCreate({ campaign_id: "awaiting", case_ids: ["awaiting"], baseline_harness: "single", candidate_harness: "evaluator", trials_per_case: 2, acceptance_ref: "contract" }).campaign as JsonObject;
    for (const slot of f.service.evalCampaignGet({ campaign_id: awaiting.id }).slots as JsonObject[]) { unobservedRun(f.store, `await-${slot.id}`, {}, {}); f.service.evalCampaignBind({ slot_id: slot.id, task_run_id: `await-${slot.id}` }); }
    assert.equal((f.service.evalCampaignAdvance({ campaign_id: awaiting.id }) as JsonObject).status, "awaiting_delivery");
    f.service.deliveryEvaluationCaseSave({ case_id: "bad", name: "Bad", domain: "files", partition: "held_out", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" });
    const bad = f.service.evalCampaignCreate({ campaign_id: "bad", case_ids: ["bad"], baseline_harness: "single", candidate_harness: "evaluator", trials_per_case: 2, acceptance_ref: "contract" }).campaign as JsonObject;
    for (const slot of f.service.evalCampaignGet({ campaign_id: bad.id }).slots as JsonObject[]) { observedRun(f.store, `bad-${slot.id}`, slot.arm === "baseline" ? "accepted" : "host_failed", {}, {}); f.service.evalCampaignBind({ slot_id: slot.id, task_run_id: `bad-${slot.id}` }); }
    assert.equal((f.service.evalCampaignAdvance({ campaign_id: bad.id }) as JsonObject).status, "inconclusive");

    assert.equal(((f.service.projectKnowledgeDiscover({ discovery_id: "none", project_root: join(f.root, "no-memories"), trusted: true }).discovery as JsonObject).descriptors as JsonObject[]).length, 0);
    await mkdir(join(f.root, ".serena", "memories"), { recursive: true }); await writeFile(join(f.root, ".serena", "memories", "secret.md"), "api_key=supersecretvalue");
    const secrets = f.service.projectKnowledgeDiscover({ discovery_id: "secrets", project_root: f.root, trusted: true }).discovery as JsonObject;
    assert.throws(() => f.service.projectKnowledgeResolve({ discovery_id: secrets.id, memory_ids: ["serena:secret"] }), /secret/);
    await writeFile(join(f.root, ".serena", "memories", "secret.md"), "safe");
    assert.throws(() => f.service.projectKnowledgeDiscover({ discovery_id: "secrets", project_root: f.root, trusted: true }), /conflict/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.11.60 retains deterministic rejection and idempotency branches", async () => {
  const f = await fixture();
  let directHostRunId = "";
  try {
    const prepared = f.service.verifiedWorkLoopPrepare({ work_loop_id: "direct-loop", workspace_id: f.workspace.id, title: "Direct", goal: "read", host: "codex-cli", prompt: "read" });
    const task = prepared.task as JsonObject; const contract = prepared.contract as JsonObject; const taskRun = prepared.task_run as JsonObject; const baseline = prepared.baseline_snapshot as JsonObject; directHostRunId = String((prepared.launch as JsonObject).run_id);
    assert.equal(f.service.verifiedWorkLoops.create({ work_loop_id: "direct-loop", task_id: task.id, contract_id: contract.id, task_run_id: taskRun.id, snapshot_id: baseline.id }).idempotent, true);
    const state = f.service.taskRunRefresh({ task_run_id: taskRun.id }).state as JsonObject;
    const foreignTask = f.store.create("task", "foreign-task", { title: "Foreign", goal: "foreign", status: "open" });
    assert.throws(() => f.service.verifiedWorkLoops.create({ work_loop_id: "different", task_id: foreignTask.id, contract_id: contract.id, task_run_id: taskRun.id, snapshot_id: baseline.id }), /bound/);
    assert.throws(() => f.service.verifiedWorkLoops.advance({ work_loop_id: "direct-loop", task_run_state_id: "missing", snapshot_id: baseline.id }), /Unknown/);
    const runDrift = f.store.create("task_run_state", "run-drift", { task_run_id: taskRun.id, status: "needs_replan", action: "replan", actor: "human" }); assert.equal(((f.service.verifiedWorkLoops.advance({ work_loop_id: "direct-loop", task_run_state_id: runDrift.id, snapshot_id: baseline.id }).receipt as JsonObject).reason), "task_run_drift");
    const drifted = f.store.create("state_snapshot", "drifted", { workspace_id: f.workspace.id, workspace_state_revision: 1, entries: [], snapshot_digest: "drift" });
    assert.equal(((f.service.verifiedWorkLoops.advance({ work_loop_id: "direct-loop", task_run_state_id: state.id, snapshot_id: drifted.id }).state as JsonObject).status), "needs_replan");
    assert.equal((f.service.verifiedWorkLoops.decide({ work_loop_id: "direct-loop", decision: "reject", actor: "user", summary: "reject" }).idempotent), false);
    assert.equal((f.service.verifiedWorkLoops.get({ work_loop_id: "direct-loop" }).decisions as JsonObject[]).length, 1); assert.throws(() => f.service.verifiedWorkLoops.get({ work_loop_id: 1 as unknown as string }), /must not be empty/);
    const generated = f.service.verifiedWorkLoopPrepare({ workspace_id: f.workspace.id, title: "Generated", goal: "read", host: "codex-cli", prompt: "read" }); assert.match(String((generated.work_loop as JsonObject).id), /^work_loop_/); await f.service.hostRuns.wait(String((generated.launch as JsonObject).run_id));
    const existingTask = f.store.create("task", "existing-task", { title: "Existing", goal: "read", status: "open" }); const existingLoop = f.service.verifiedWorkLoopPrepare({ work_loop_id: "existing-loop", task_id: existingTask.id, contract_id: "existing-contract", workspace_id: f.workspace.id, title: "ignored", goal: "read", host: "codex-cli", prompt: "read" }); await f.service.hostRuns.wait(String((existingLoop.launch as JsonObject).run_id));
    const driftLoop = f.service.verifiedWorkLoopPrepare({ work_loop_id: "fresh-drift", workspace_id: f.workspace.id, title: "Drift", goal: "read", host: "codex-cli", prompt: "read" }); const driftRun = driftLoop.task_run as JsonObject; const driftState = f.service.taskRunRefresh({ task_run_id: driftRun.id }).state as JsonObject; const driftSnapshot = f.store.create("state_snapshot", "fresh-drift-snapshot", { workspace_id: f.workspace.id, workspace_state_revision: 2, entries: [], snapshot_digest: "new" }); assert.equal(((f.service.verifiedWorkLoops.advance({ work_loop_id: "fresh-drift", task_run_state_id: driftState.id, snapshot_id: driftSnapshot.id }).state as JsonObject).status), "needs_replan"); await f.service.hostRuns.wait(String((driftLoop.launch as JsonObject).run_id));

    assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: ["note.txt"], artifact_ids: ["missing"] }), /Unknown/);
    await mkdir(join(f.root, "fifo")); await writeFile(join(f.root, "fifo", "not-a-file"), "file");
    assert.throws(() => f.service.stateWorkspaceObserve({ workspace_id: f.workspace.id, adapter: "file_artifact", paths: [""] }), /must not be empty/);

    f.service.deliveryEvaluationCaseSave({ case_id: "rejected", name: "Rejected", domain: "software", partition: "held_out", acceptance_contract_ref: "contract", sanitized: true, approved_by: "curator" });
    const campaign = f.service.evalCampaignCreate({ campaign_id: "rejected", case_ids: ["rejected"], baseline_harness: "single", candidate_harness: "judge", trials_per_case: 2, acceptance_ref: "contract" }).campaign as JsonObject;
    for (const slot of f.service.evalCampaignGet({ campaign_id: campaign.id }).slots as JsonObject[]) { observedRun(f.store, `rejected-${slot.id}`, "accepted", {}, {}); f.service.evalCampaignBind({ slot_id: slot.id, task_run_id: `rejected-${slot.id}` }); }
    const aggregate = f.service.evalCampaigns.benchmarks.aggregate; f.service.evalCampaigns.benchmarks.aggregate = () => ({ evaluation: { id: "manual", version: 1, status: "rejected" } });
    assert.equal((f.service.evalCampaignAdvance({ campaign_id: campaign.id }) as JsonObject).status, "rejected"); f.service.evalCampaigns.benchmarks.aggregate = aggregate;
    f.service.evalCampaigns.benchmarks.aggregate = () => ({ evaluation: { id: "manual-inconclusive", version: 1, status: "inconclusive" } }); f.store.save("eval_campaign", campaign.id as string, { ...(campaign as object), lifecycle: "collecting" }); assert.equal((f.service.evalCampaignAdvance({ campaign_id: campaign.id }) as JsonObject).status, "inconclusive"); f.service.evalCampaigns.benchmarks.aggregate = aggregate;
    assert.throws(() => f.service.evalCampaignCreate({ case_ids: [], baseline_harness: "single", candidate_harness: "judge", trials_per_case: 2, acceptance_ref: "contract" }), /unique non-empty/);
    assert.throws(() => f.service.evalCampaignCreate({ case_ids: "rejected" as unknown as string[], baseline_harness: "single", candidate_harness: "judge", trials_per_case: 2, acceptance_ref: "contract" }), /unique non-empty/);
    assert.throws(() => f.service.evalCampaignCreate({ case_ids: [1 as unknown as string], baseline_harness: "single", candidate_harness: "judge", trials_per_case: 2, acceptance_ref: "contract" }), /must not be empty/);
    const generatedCampaign = f.service.evalCampaignCreate({ case_ids: ["rejected"], baseline_harness: "single", candidate_harness: "judge", trials_per_case: 2, acceptance_ref: "contract" }).campaign as JsonObject; assert.match(String(generatedCampaign.id), /^eval_campaign_/);
    f.store.create("eval_campaign", "incomplete", { lifecycle: "collecting" }); f.store.create("eval_campaign_slot", "incomplete-baseline", { campaign_id: "incomplete", case_id: "rejected", trial: 1, arm: "baseline", status: "bound", task_run_id: "rejected-eval_slot_rejected_rejected_1_baseline" });
    assert.throws(() => f.service.evalCampaignAdvance({ campaign_id: "incomplete" }), /incomplete/);

    await mkdir(join(f.root, ".serena", "memories"), { recursive: true }); await writeFile(join(f.root, ".serena", "memories", "one.md"), "one"); await writeFile(join(f.root, ".serena", "memories", "two.md"), "two"); await writeFile(join(f.root, ".serena", "memories", "ignore.txt"), "ignore");
    const discovery = f.service.projectKnowledgeDiscover({ discovery_id: "branches", project_root: f.root, trusted: true }).discovery as JsonObject;
    assert.match(String((f.service.projectKnowledgeDiscover({ project_root: f.root, trusted: true }).discovery as JsonObject).id), /^project_knowledge_/);
    assert.throws(() => f.service.projectKnowledgeDiscover({ project_root: 1 as unknown as string, trusted: true }), /must not be empty/);
    assert.throws(() => f.service.projectKnowledgeResolve({ discovery_id: discovery.id, memory_ids: ["serena:one", "serena:one"] }), /unique/);
    assert.throws(() => f.service.projectKnowledgeResolve({ discovery_id: discovery.id, memory_ids: ["serena:one", "serena:one", "serena:one", "serena:one"] }), /one to three/);
    assert.throws(() => f.service.projectKnowledgeResolve({ discovery_id: discovery.id, memory_ids: "serena:one" as unknown as string[] }), /one to three/);
    const resolution = f.service.projectKnowledgeResolve({ resolution_id: "resolution-conflict", discovery_id: discovery.id, memory_ids: ["serena:one"] }); assert.equal(f.service.projectKnowledgeResolve({ resolution_id: "resolution-conflict", discovery_id: discovery.id, memory_ids: ["serena:one"] }).idempotent, true); assert.throws(() => f.service.projectKnowledgeResolve({ resolution_id: "resolution-conflict", discovery_id: discovery.id, memory_ids: ["serena:two"] }), /conflict/); assert.ok((resolution.memories as JsonObject[])[0].content);
    const evidence = f.service.evidenceRecord({ evidence_id: "branches-evidence", source_type: "program", confidence: "confirmed", claim: "done", locator: "test" }) as JsonObject;
    f.service.projectKnowledgeProposeUpdate({ proposal_id: "proposal-conflict", discovery_id: discovery.id, memory_id: "serena:one", evidence_ids: [evidence.id], summary: "one" });
    assert.throws(() => f.service.projectKnowledgeProposeUpdate({ proposal_id: "proposal-conflict", discovery_id: discovery.id, memory_id: "serena:one", evidence_ids: [evidence.id], summary: "two" }), /conflict/);
    assert.throws(() => f.service.projectKnowledgeProposeUpdate({ discovery_id: discovery.id, memory_id: "serena:one", evidence_ids: "branches-evidence" as unknown as string[], summary: "bad" }), /requires/);
    await rm(join(f.root, ".serena", "memories", "two.md")); await symlink(join(f.root, ".serena", "memories", "one.md"), join(f.root, ".serena", "memories", "two.md"));
    assert.throws(() => f.service.projectKnowledgeResolve({ discovery_id: discovery.id, memory_ids: ["serena:two"] }), /symbolic/);
    await symlink(join(f.root, ".serena", "memories", "one.md"), join(f.root, ".serena", "memories", "link.md"));
    assert.throws(() => f.service.projectKnowledgeDiscover({ discovery_id: "symlink", project_root: f.root, trusted: true }), /symbolic/);
  } finally { await f.service.hostRuns.wait(String(directHostRunId)); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
