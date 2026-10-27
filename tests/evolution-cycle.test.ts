import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { McpServer } from "../core/mcp.ts";
import { payload, stableDigest } from "../core/digest.ts";
import { adjudicateKnowledgeCase } from "./helpers/knowledge-evaluation-adjudication.ts";
import { attachVerifiedPromotionFixture } from "./helpers/knowledge-promotion-proof.ts";

function terminalHostSession(service: CraftService, taskId: string, sessionId: string): void {
  service.hostSessionOpen({ session_id: sessionId, task_id: taskId, host_id: "codex", environment_fingerprint: "test-env",
    policy_fingerprint: "test-policy", capability_fingerprint: "test-capability" });
  service.hostSessionAppend({ session_id: sessionId, kind: "session.completed" });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-evolution-cycle-")), dataRoot = join(root, "data"), projectRoot = join(root, "project");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(projectRoot, "src", "b.ts"), "export const b = 2;\n");
  execFileSync("git", ["init", "-q", projectRoot]);
  const store = await new CraftStore(craftPaths(dataRoot)).open(), service = new CraftService(store);
  const task = store.create("task", "task", { title: "Verified task", status: "active" });
  const identity = service.scopeIdentityResolveProject({ project_root: projectRoot }).identity as JsonObject;
  const projectScopeId = String((identity.canonical_scope as JsonObject).id);
  service.workspaceOpen({ workspace_id: "workspace", name: "Project", root_path: projectRoot, include_paths: ["src"] });
  const checkpoint = service.workspaceCheckpoint({ workspace_id: "workspace", checkpoint_id: "checkpoint", label: "baseline" }).checkpoint as JsonObject;
  service.traceStart({ trace_id: "trace-session", task_id: task.id });
  store.create("host_session", "session", { task_id: task.id, host_id: "codex", trace_id: "trace-session", status: "running", identity_digest: "session-identity", raw_content_stored: false });
  store.create("evidence", "observed", { confidence: "confirmed", source_type: "receipt",
    metadata: { source_task_id: task.id, source_session_id: "session" } });
  store.create("knowledge_source", "candidate-source", { status: "active", trust: "verified", content_digest: "candidate-source-digest",
    scope: { kind: "project", id: projectScopeId }, kind: "test_fixture", label: "Candidate source" });
  store.create("knowledge_claim", "candidate", { status: "candidate", content_digest: "candidate-digest", identity_digest: "candidate-identity",
    source_id: "candidate-source", evidence_ids: ["observed"], scope: `project:${projectScopeId}` });
  store.create("task", "held-out-task", { title: "Independent held-out task", session_id: "held-out-session", host_session_id: "held-out-session" });
  terminalHostSession(service, "held-out-task", "held-out-session");
  store.create("trial", "held-out-trial", { task_id: "held-out-task", case_id: "held-out-case", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1 });
  store.create("outcome", "outcome_held-out-trial", { trial_id: "held-out-trial", verdict: "passed" });
  store.create("evaluation_run", "held-out", { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: ["held-out-trial"] });
  store.create("knowledge_auto_review", "promotion-authority", { claim_id: "candidate", claim_version: 1, verdict: "eligible" });
  const startArgs = { cycle_id: "cycle", task_id: task.id, project_scope_id: projectScopeId, session_host: "codex", session_id: "session",
    workspace_id: "workspace", checkpoint_id: checkpoint.id, trigger: "verified_task_completion", allowed_paths: ["src/a.ts"], trigger_refs: [{ kind: "task", id: task.id, version: task.version }] };
  return { root, projectRoot, store, service, task, identity, projectScopeId, checkpoint, startArgs,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Evolution Cycle binds a real project snapshot and records a safe append-only lifecycle", async () => {
  const f = await fixture();
  try {
    const started = f.service.evolutionCycleStart(f.startArgs), initial = started.cycle as JsonObject;
    const candidateWorkspace = started.candidate_workspace as JsonObject;
    const indexedRow = f.store.database.prepare("SELECT payload_json FROM records WHERE kind='evolution_cycle' AND id=?").get(String(initial.id)) as { payload_json: string };
    const partition = (JSON.parse(indexedRow.payload_json) as JsonObject)._evolution_partition as JsonObject;
    assert.equal(String(partition.file).startsWith(join(f.root, "data", "projects")), true);
    assert.equal(String(partition.file).endsWith(join("evolution", "evolution.db")), true);
    assert.equal(initial.stage, "observe"); assert.equal(initial.status, "active"); assert.equal(initial.sequence, 1);
    assert.equal((initial.snapshot as JsonObject).revision, "(unborn)");
    assert.equal((initial.snapshot as JsonObject).project_path_digest !== undefined, true);
    assert.equal(JSON.stringify(started).includes(f.projectRoot), false);
    assert.deepEqual(((started.events as JsonObject[])[0]!.payload as JsonObject).metrics,
      { input_tokens: null, output_tokens: null, duration_ms: null, cost_usd: null });
    assert.equal((f.service.evolutionCycleStart(f.startArgs) as JsonObject).idempotent, true);
    assert.equal(String(candidateWorkspace.path).startsWith(join(f.store.paths.root, "projects")), true);
    assert.equal(await readFile(join(String(candidateWorkspace.path), "src", "a.ts"), "utf8"), "export const a = 1;\n");
    await writeFile(join(String(candidateWorkspace.path), "src", "a.ts"), "export const candidate = true;\n");
    assert.equal(await readFile(join(f.projectRoot, "src", "a.ts"), "utf8"), "export const a = 1;\n");

    let cycle = initial;
    const advance = (stage: string, transitionId: string, extra: JsonObject = {}) => {
      const result = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: transitionId, stage, ...extra });
      cycle = result.cycle as JsonObject; return result;
    };
    advance("retrieve", "retrieve"); advance("act", "act", { metrics: { input_tokens: 100, output_tokens: 25, duration_ms: 300, cost_usd: 0.01 } });
    advance("feedback", "feedback", { outcome: "failed", evidence_refs: [{ kind: "evidence", id: "observed" }] });
    assert.equal(cycle.outcome, "failed");
    const environment = advance("attribute", "environment", { failure_class: "environment", next_stage: "replan", reason: "Git provider unavailable" });
    assert.equal(cycle.stage, "replan"); assert.equal(cycle.failure_class, "environment");
    assert.equal(((environment.event as JsonObject).stage), "attribute");
    assert.throws(() => advance("candidate", "forbidden-candidate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] }), /Invalid Evolution Cycle transition/u);
    advance("observe", "retry"); assert.equal(cycle.failure_class, null); assert.equal(cycle.outcome, null);
    advance("retrieve", "retrieve-2"); advance("act", "act-2"); advance("feedback", "feedback-2", { outcome: "failed" });
    advance("attribute", "task-failure", { failure_class: "execution" });
    advance("candidate", "candidate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] });
    await writeFile(join(String(candidateWorkspace.path), "src", "a.ts"), "post-freeze mutation\n");
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
      transition_id: "evaluate-mutated-candidate", stage: "evaluate", artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
      evaluation_refs: [{ kind: "evaluation_run", id: "held-out" }] }), /changed after its version was frozen/u);
    await writeFile(join(String(candidateWorkspace.path), "src", "a.ts"), "export const candidate = true;\n");
    advance("evaluate", "evaluate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evaluation_refs: [{ kind: "evaluation_run", id: "held-out" }], metrics: { input_tokens: 80, duration_ms: 100 } });
    const promotedClaim = attachVerifiedPromotionFixture(f.store, f.store.get("knowledge_claim", "candidate"));
    const promotionReviewId = String((promotedClaim.review as JsonObject).promotion_review_id);
    const promotionReview = f.store.get("knowledge_auto_review", promotionReviewId);
    advance("promote", "promote", { authority_refs: [{ kind: "knowledge_auto_review", id: promotionReview.id, version: promotionReview.version }] });
    const complete = advance("replan", "complete", { terminal: true }); assert.equal(cycle.status, "completed");
    assert.equal((f.store.findMany("evolution_cycle", [String(cycle.id)])[0] as JsonObject).version, cycle.version);
    assert.equal((f.store.list("evolution_cycle").find(item => item.id === cycle.id) as JsonObject).version, cycle.version);
    assert.equal(f.store.get("evolution_cycle", String(cycle.id), Number(initial.version)).version, initial.version);
    assert.equal((f.service.info({ include_zero_counts: true }).counts as JsonObject).evolution_cycle, 1);
    const events = f.service.evolutionCycleGet({ cycle_id: "cycle" }).events as JsonObject[];
    assert.equal(events.length, 14); assert.equal((events.at(-1)!.payload as JsonObject).terminal, true);
    assert.equal((events.find(event => (event.payload as JsonObject).transition_id === "feedback")!.payload as JsonObject).outcome, "failed");
    assert.equal((events.find(event => (event.payload as JsonObject).transition_id === "retry")!.payload as JsonObject).outcome, null);
    const repeated = f.service.evolutionCycleAdvance({ cycle_id: "cycle", expected_version: initial.version, transition_id: "complete", stage: "replan", terminal: true });
    assert.equal(repeated.idempotent, true);
    const promoted = events.find(event => event.event_type === "promote")!;
    assert.deepEqual(((promoted.payload as JsonObject).authority_refs), [{ kind: "knowledge_auto_review", id: promotionReviewId, version: promotionReview.version }]);
    const mcp = new McpServer(f.service);
    const mcpStart = await mcp.handle({ id: 0, method: "tools/call", params: { name: "craft_evolution_cycle_start", arguments: f.startArgs } });
    assert.equal(((mcpStart?.result as JsonObject).isError), false);
    assert.equal(typeof (((mcpStart?.result as JsonObject).structuredContent as JsonObject).candidate_workspace as JsonObject).path, "string");
    const result = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_evolution_cycle_get", arguments: { cycle_id: "cycle" } } });
    assert.equal((result?.result as JsonObject).isError, false);
    assert.equal(typeof ((((result?.result as JsonObject).structuredContent as JsonObject).candidate_workspace as JsonObject).path), "string");
  } finally { await f.close(); }
});

test("Evolution Cycle refuses new execution after its Host Session ends but keeps retries idempotent", async () => {
  const f = await fixture();
  try {
    let cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "closed-session" }).cycle as JsonObject;
    const retrieve = { cycle_id: cycle.id, expected_version: cycle.version, transition_id: "retrieve-before-close", stage: "retrieve" };
    cycle = (f.service.evolutionCycleAdvance(retrieve).cycle as JsonObject);
    const session = f.store.get("host_session", "session");
    f.store.save("host_session", "session", { ...payload(session), status: "terminal" });

    const retry = f.service.evolutionCycleAdvance(retrieve);
    assert.equal(retry.idempotent, true);
    assert.equal((retry.cycle as JsonObject).version, cycle.version);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
      transition_id: "act-after-close", stage: "act" }), /original live Host Session/u);
    const history = f.service.evolutionCycleGet({ cycle_id: cycle.id }).events as JsonObject[];
    assert.equal(history.length, 2);
    assert.equal((f.service.evolutionCycleGet({ cycle_id: cycle.id }).cycle as JsonObject).stage, "retrieve");
  } finally { await f.close(); }
});

test("Evolution Cycle learns from a completed Host task without reopening execution", async () => {
  const f = await fixture();
  try {
    let cycle = f.service.evolutionCycleStart(f.startArgs).cycle as JsonObject;
    const advance = (stage: string, extra: JsonObject = {}) => {
      cycle = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
        transition_id: `completed-${stage}`, stage, ...extra }).cycle as JsonObject;
    };
    advance("retrieve"); advance("act");
    const session = f.store.get("host_session", "session");
    f.store.save("host_session", "session", { ...payload(session), next_sequence: 0 });
    f.service.hostSessionAppend({ session_id: "session", kind: "session.completed" });
    const terminal = f.store.get("host_session", "session");
    for (const patch of [{ host_id: "other" }, { task_id: "other" }, { identity_digest: "changed" }, { trace_id: "other" }]) {
      f.store.save("host_session", "session", { ...payload(terminal), ...patch });
      assert.throws(() => advance("feedback", { outcome: "passed" }), /original Host Session identity/u);
    }
    f.store.save("host_session", "session", { ...payload(terminal), status: "paused" });
    assert.throws(() => advance("feedback", { outcome: "passed" }), /original live Host Session/u);
    f.store.save("host_session", "session", payload(terminal));
    advance("feedback", { outcome: "passed" }); advance("attribute"); advance("replan");
    assert.equal(cycle.stage, "replan");
    assert.throws(() => advance("observe"), /original live Host Session/u);
    assert.equal(f.store.get("host_session", "session").status, "terminal");
  } finally { await f.close(); }
});

test("Evolution Cycle refuses a Host Session whose Trace changes task ownership", async () => {
  const f = await fixture();
  try {
    const cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "trace-task-change" }).cycle as JsonObject;
    const trace = f.store.get("trace", "trace-session");
    f.store.save("trace", "trace-session", { ...payload(trace), task_id: "held-out-task" });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
      transition_id: "retrieve-invalid-trace", stage: "retrieve" }), /Trace belongs to another task/u);
    assert.equal((f.service.evolutionCycleGet({ cycle_id: cycle.id }).events as JsonObject[]).length, 1);
  } finally { await f.close(); }
});

test("Evolution Cycle defaults to no writable paths and reads older snapshots without an allowlist", async () => {
  const f = await fixture();
  try {
    const { allowed_paths: _ignored, ...legacyArgs } = f.startArgs;
    let cycle = f.service.evolutionCycleStart({ ...legacyArgs, cycle_id: "legacy-allowlist" }).cycle as JsonObject;
    const snapshot = { ...(cycle.snapshot as JsonObject) };
    delete snapshot.candidate_allowed_paths;
    cycle = f.store.save("evolution_cycle", String(cycle.id), { ...payload(cycle), snapshot });
    const advance = (stage: string, transitionId: string, extra: JsonObject = {}) => {
      cycle = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: transitionId, stage, ...extra }).cycle as JsonObject;
    };
    advance("retrieve", "legacy-retrieve"); advance("act", "legacy-act");
    advance("feedback", "legacy-feedback", { outcome: "failed" });
    advance("attribute", "legacy-attribute", { failure_class: "execution" });
    advance("candidate", "legacy-candidate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] });
    assert.equal(typeof cycle.candidate_workspace_revision_digest, "string");
  } finally { await f.close(); }
});

test("Evolution Cycle cannot promote against a changed project baseline", async () => {
  const f = await fixture();
  try {
    let cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "stale-promotion" }).cycle as JsonObject;
    const advance = (stage: string, extra: JsonObject = {}) => {
      cycle = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
        transition_id: `stale-${stage}-${cycle.version}`, stage, ...extra }).cycle as JsonObject;
    };
    advance("retrieve"); advance("act"); advance("feedback", { outcome: "passed", evidence_refs: [{ kind: "evidence", id: "observed" }] });
    advance("attribute");
    advance("candidate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] });
    advance("evaluate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evaluation_refs: [{ kind: "evaluation_run", id: "held-out" }] });
    f.store.save("workspace_checkpoint", String(f.checkpoint.id), { ...payload(f.checkpoint), label: "changed after evaluation" });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "stale-promote",
      stage: "promote", authority_refs: [{ kind: "knowledge_auto_review", id: "promotion-authority" }] }), /baseline changed/u);
    assert.equal((f.service.evolutionCycleGet({ cycle_id: cycle.id }).cycle as JsonObject).stage, "evaluate");
    assert.equal((f.service.evolutionCycleGet({ cycle_id: cycle.id }).events as JsonObject[]).length, 7);
  } finally { await f.close(); }
});

test("Evolution Cycle rejects a dirty tree at start and immediately before promotion", async () => {
  const f = await fixture();
  const source = join(f.projectRoot, "src", "a.ts"), baseline = await readFile(source, "utf8");
  try {
    await writeFile(source, "export const a = 99;\n");
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "dirty-at-start" }), /current project working tree/u);
    await writeFile(source, baseline);
    let cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "dirty-before-candidate" }).cycle as JsonObject;
    const advance = (stage: string, transitionId: string, extra: JsonObject = {}) => {
      cycle = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: transitionId, stage, ...extra }).cycle as JsonObject;
    };
    advance("retrieve", "dirty-retrieve"); advance("act", "dirty-act");
    advance("feedback", "dirty-feedback", { outcome: "failed" });
    advance("attribute", "dirty-attribute", { failure_class: "execution" });
    advance("candidate", "dirty-candidate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
      evidence_refs: [{ kind: "evidence", id: "observed" }] });
    advance("evaluate", "dirty-evaluate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
      evaluation_refs: [{ kind: "evaluation_run", id: "held-out" }] });
    await writeFile(source, "export const a = 100;\n");
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
      transition_id: "dirty-promote", stage: "promote" }), /working tree changed/u);
  } finally { await f.close(); }
});

test("Evolution Cycle refuses candidate creation or evaluation after the source snapshot moves", async () => {
  const f = await fixture();
  try {
    const start = (id: string) => {
      const workspace = f.store.get("workspace", "workspace");
      return f.service.evolutionCycleStart({ ...f.startArgs, checkpoint_id: workspace.latest_checkpoint_id, cycle_id: id }).cycle as JsonObject;
    };
    const advance = (cycle: JsonObject, stage: string, transitionId: string, extra: JsonObject = {}) => f.service.evolutionCycleAdvance({
      cycle_id: cycle.id, expected_version: cycle.version, transition_id: transitionId, stage, ...extra,
    }).cycle as JsonObject;
    const prepareCandidate = (id: string) => {
      let cycle = start(id);
      cycle = advance(cycle, "retrieve", `${id}:retrieve`);
      cycle = advance(cycle, "act", `${id}:act`);
      cycle = advance(cycle, "feedback", `${id}:feedback`, { outcome: "passed", evidence_refs: [{ kind: "evidence", id: "observed" }] });
      return advance(cycle, "attribute", `${id}:attribute`);
    };

    const beforeCandidate = prepareCandidate("stale-before-candidate");
    f.service.workspaceCheckpoint({ workspace_id: "workspace", checkpoint_id: "checkpoint-before-candidate", label: "moved before candidate" });
    assert.throws(() => advance(beforeCandidate, "candidate", "stale-candidate", {
      artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }],
    }), /baseline changed/u);
    assert.equal((f.service.evolutionCycleGet({ cycle_id: beforeCandidate.id }).cycle as JsonObject).stage, "attribute");

    const beforeEvaluation = prepareCandidate("stale-before-evaluation");
    let candidate = advance(beforeEvaluation, "candidate", "candidate-ready", {
      artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }],
    });
    f.service.workspaceCheckpoint({ workspace_id: "workspace", checkpoint_id: "checkpoint-before-evaluation", label: "moved before evaluation" });
    assert.throws(() => advance(candidate, "evaluate", "stale-evaluate", {
      artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evaluation_refs: [{ kind: "evaluation_run", id: "held-out" }],
    }), /baseline changed/u);
    assert.equal((f.service.evolutionCycleGet({ cycle_id: candidate.id }).cycle as JsonObject).stage, "candidate");
  } finally { await f.close(); }
});

test("Evolution Cycle read rejects a candidate manifest whose source digest was changed", async () => {
  const f = await fixture();
  try {
    const started = f.service.evolutionCycleStart(f.startArgs), cycle = started.cycle as JsonObject;
    const candidate = started.candidate_workspace as JsonObject;
    const manifestPath = join(String(candidate.path), "..", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as JsonObject;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, source_digest: "sha256:forged" }));
    assert.throws(() => f.service.evolutionCycleGet({ cycle_id: cycle.id }), /idempotency conflict/u);
    const clean = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "snapshot-digest-mismatch" }).cycle as JsonObject;
    const snapshot = { ...(clean.snapshot as JsonObject), candidate_workspace_digest: "sha256:forged" };
    f.store.save("evolution_cycle", String(clean.id), { ...payload(clean), snapshot });
    assert.throws(() => f.service.evolutionCycleGet({ cycle_id: clean.id }), /baseline digest is invalid/u);
  } finally { await f.close(); }
});

test("Evolution Cycle supports historical records created before candidate workspaces were materialized", async () => {
  const f = await fixture();
  try {
    const cycle = f.service.evolutionCycleStart(f.startArgs).cycle as JsonObject;
    const snapshot = { ...(cycle.snapshot as JsonObject) };
    delete snapshot.candidate_workspace_id; delete snapshot.candidate_workspace_digest;
    f.store.save("evolution_cycle", String(cycle.id), { ...payload(cycle), snapshot });
    assert.equal((f.service.evolutionCycleGet({ cycle_id: cycle.id }).candidate_workspace), null);
  } finally { await f.close(); }
});

test("Evolution Cycle derives reported cost and latency only from exact observed Trace events", async () => {
  const f = await fixture();
  try {
    const appendMetric = (traceId: string, trust: string, usage?: JsonObject, duration_ms?: number, cost_usd?: number, taskId = f.task.id) => {
      f.service.traceStart({ trace_id: traceId, task_id: taskId });
      return f.service.traceAppend({ trace_id: traceId, event_kind: "model.final", trust, ...(usage ? { usage } : {}), duration_ms, cost_usd }).event as JsonObject;
    };
    const first = appendMetric("trace-session", "observed", { input_tokens: 17, output_tokens: 4 }, 80, 0.002);
    const second = appendMetric("trace-session", "verified", { input_tokens: 3 }, 20);
    const cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "trace-metrics" }).cycle as JsonObject;
    const result = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "trace-metrics-retrieve",
      stage: "retrieve", trace_refs: [{ kind: "trace_event", id: first.id, version: first.version }, { kind: "trace_event", id: second.id, version: second.version }] });
    const event = result.event as JsonObject;
    assert.deepEqual(event.metrics, { input_tokens: 20, output_tokens: 4, duration_ms: 100, cost_usd: 0.002 });
    assert.equal(event.metrics_source, "trace_event");
    assert.equal((event.trace_refs as JsonObject[]).length, 2);
    const empty = appendMetric("trace-session", "observed");
    const noMetrics = f.service.evolutionCycleAdvance({ cycle_id: (result.cycle as JsonObject).id, expected_version: (result.cycle as JsonObject).version,
      transition_id: "empty-trace-metrics", stage: "act", trace_refs: [{ kind: "trace_event", id: empty.id }] });
    assert.deepEqual((noMetrics.event as JsonObject).metrics, { input_tokens: null, output_tokens: null, duration_ms: null, cost_usd: null });
    const current = noMetrics.cycle as JsonObject;
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: current.id, expected_version: current.version,
      transition_id: "bad-ref-kind", stage: "act", trace_refs: [{ kind: "evidence", id: "observed" }] }), /trace_event records/u);
    const otherTask = f.store.create("task", "metrics-other-task", { title: "Other task" });
    const foreignTaskEvent = appendMetric("foreign-task-metric-trace", "observed", { input_tokens: 1 }, undefined, undefined, otherTask.id);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: current.id, expected_version: current.version,
      transition_id: "foreign-task-metrics", stage: "act", trace_refs: [{ kind: "trace_event", id: foreignTaskEvent.id }] }), /another task/u);
    const unrelatedSameTask = appendMetric("unrelated-same-task-trace", "observed", { input_tokens: 1 });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: current.id, expected_version: current.version,
      transition_id: "unrelated-same-task-metrics", stage: "act", trace_refs: [{ kind: "trace_event", id: unrelatedSameTask.id }] }), /belong to its Host Session/u);
    const untrusted = appendMetric("untrusted-metric-trace", "untrusted", { input_tokens: 10 });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: current.id, expected_version: current.version,
      transition_id: "untrusted-metrics", stage: "act", trace_refs: [{ kind: "trace_event", id: untrusted.id }] }), /observed Trace events/u);
    const malformed = appendMetric("trace-session", "observed", { input_tokens: -1 });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: current.id, expected_version: current.version,
      transition_id: "malformed-metrics", stage: "act", trace_refs: [{ kind: "trace_event", id: malformed.id }] }), /non-negative integer/u);
    const malformedDuration = appendMetric("trace-session", "observed", {}, 0);
    const originalGet = f.store.get.bind(f.store);
    f.store.get = ((kind: string, id: string, version?: number) => {
      const record = originalGet(kind, id, version);
      return kind === "trace_event" && id === malformedDuration.id ? { ...record, duration_ms: -1 } : record;
    }) as typeof f.store.get;
    try {
      assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: current.id, expected_version: current.version,
        transition_id: "malformed-duration", stage: "act", trace_refs: [{ kind: "trace_event", id: malformedDuration.id }] }), /finite number/u);
      const maximum = appendMetric("trace-session", "observed", { input_tokens: Number.MAX_SAFE_INTEGER });
      const extra = appendMetric("trace-session", "observed", { input_tokens: 1 });
      assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: current.id, expected_version: current.version,
        transition_id: "overflow-metrics", stage: "act", trace_refs: [{ kind: "trace_event", id: maximum.id }, { kind: "trace_event", id: extra.id }] }), /numeric range/u);
    } finally { f.store.get = originalGet as typeof f.store.get; }
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: current.id, expected_version: current.version,
      transition_id: "mixed-metrics", stage: "act", trace_refs: [{ kind: "trace_event", id: first.id }], metrics: { input_tokens: 1 } }), /not both/u);
  } finally { await f.close(); }
});

test("Evolution Cycle rejects stale or cross-scope snapshots and invalid stage evidence", async () => {
  const f = await fixture();
  try {
    const otherRoot = join(f.root, "other-project"); await mkdir(otherRoot);
    const otherIdentity = f.service.scopeIdentityResolveProject({ project_root: otherRoot }).identity as JsonObject;
    const wrongScope = { ...f.startArgs, cycle_id: "wrong-scope", project_scope_id: String((otherIdentity.canonical_scope as JsonObject).id) };
    assert.throws(() => f.service.evolutionCycleStart(wrongScope), /does not match the workspace root/u);
    f.service.workspaceCheckpoint({ workspace_id: "workspace", checkpoint_id: "new-checkpoint", label: "newer" });
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "stale" }), /latest checkpoint/u);
  } finally { await f.close(); }
});

test("Evolution Cycle refuses a Host Session Trace owned by another task", async () => {
  const f = await fixture();
  try {
    const otherTask = f.store.create("task", "wrong-trace-task", { title: "Unrelated task" });
    f.service.traceStart({ trace_id: "wrong-session-trace", task_id: otherTask.id });
    const session = f.store.get("host_session", "session");
    f.store.save("host_session", "session", { ...payload(session), trace_id: "wrong-session-trace" });
    assert.throws(() => f.service.evolutionCycleStart(f.startArgs), /Host Session Trace belongs to another task/u);
  } finally { await f.close(); }
});

test("Evolution Cycle resolves a concurrent duplicate inside the write transaction", async () => {
  const f = await fixture();
  try {
    const seed = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "seed" }).cycle as JsonObject;
    const originalFind = f.store.find.bind(f.store); let first = true;
    f.store.find = ((kind: string, id: string, version?: number, hydrate?: boolean) => {
      if (first && kind === "evolution_cycle" && id === "seed") { first = false; return null; }
      return originalFind(kind, id, version, hydrate);
    }) as typeof f.store.find;
    try {
      const result = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "seed" });
      assert.equal(result.idempotent, true); assert.equal((result.cycle as JsonObject).identity_digest, seed.identity_digest);
    } finally { f.store.find = originalFind as typeof f.store.find; }
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, trigger: "changed", cycle_id: "seed" }), /idempotency conflict/u);

    const conflictSeed = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "race-conflict-seed" }).cycle as JsonObject;
    let reads = 0;
    f.store.find = ((kind: string, id: string, version?: number, hydrate?: boolean) => {
      if (kind === "evolution_cycle" && id === "race-conflict") {
        if (reads++ === 0) return null;
        return { ...conflictSeed, id: "race-conflict", identity_digest: "different-identity" };
      }
      return originalFind(kind, id, version, hydrate);
    }) as typeof f.store.find;
    try { assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "race-conflict" }), /idempotency conflict/u); }
    finally { f.store.find = originalFind as typeof f.store.find; }
  } finally { await f.close(); }
});

test("Evolution Cycle partition write atomically resolves an identical retry and rejects a conflicting retry", async () => {
  const f = await fixture();
  try {
    const cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "partition-retry" }).cycle as JsonObject;
    const stream = `evolution:${cycle.id}`, firstEvent = f.store.events(stream)[0]!;
    assert.equal(f.store.appendEvent(stream, String(firstEvent.event_type), firstEvent.payload as JsonObject).sequence, 1);
    assert.throws(() => f.store.appendEvent(stream, String(firstEvent.event_type), { ...(firstEvent.payload as JsonObject), retry_conflict: true }), /sequence conflicts/u);
    const original = f.store.advanceEvolutionCycle.bind(f.store);
    f.store.advanceEvolutionCycle = ((id: string, expected: number, next: JsonObject, eventType: string, event: JsonObject) => {
      const committed = original(id, expected, next, eventType, event);
      assert.equal(original(id, expected, next, eventType, event).idempotent, true);
      assert.throws(() => original(id, expected, next, eventType, { ...event, request_digest: "sha256:conflict" }), /idempotency conflict/u);
      return committed;
    }) as typeof f.store.advanceEvolutionCycle;
    try {
      const result = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "retrieve-once", stage: "retrieve" });
      assert.equal((result.cycle as JsonObject).stage, "retrieve");
    } finally { f.store.advanceEvolutionCycle = original; }
  } finally { await f.close(); }
});

test("Evolution Cycle stage validation rejects missing refs, unsafe metrics and stale revisions", async () => {
  const f = await fixture();
  try {
    const cycle = f.service.evolutionCycleStart(f.startArgs).cycle as JsonObject;
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "bad-stage", stage: "unknown" }), /stage is unsupported/u);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: 0, transition_id: "bad-version", stage: "retrieve" }), /positive integer/u);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "bad-metric", stage: "retrieve", metrics: { input_tokens: -1 } }), /non-negative integer/u);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "bad-ref", stage: "retrieve", evidence_refs: [{ kind: "evidence", id: "missing" }] }), /Unknown evidence/u);
    const moved = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "retrieve", stage: "retrieve" }).cycle as JsonObject;
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "stale", stage: "act" }), /version conflict/u);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: moved.version, transition_id: "wrong-order", stage: "candidate" }), /Invalid Evolution Cycle transition/u);
    const act = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: moved.version, transition_id: "act", stage: "act" }).cycle as JsonObject;
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: act.version, transition_id: "missing-feedback-outcome", stage: "feedback" }), /Feedback requires a terminal outcome/u);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: act.version, transition_id: "bad-outcome", stage: "feedback", outcome: "unknown" }), /outcome is unsupported/u);
    const feedback = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: act.version, transition_id: "feedback", stage: "feedback", outcome: "passed" }).cycle as JsonObject;
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: feedback.version, transition_id: "passed-with-failure", stage: "attribute", failure_class: "execution" }), /must not include/u);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: act.version, transition_id: "outcome-on-act", stage: "act", outcome: "passed" }), /only valid for the feedback/u);
    const attributed = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: feedback.version, transition_id: "attribute", stage: "attribute" }).cycle as JsonObject;
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: attributed.version, transition_id: "missing-candidate", stage: "candidate" }), /Candidate requires/u);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: attributed.version, transition_id: "missing-evidence", stage: "candidate", artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }] }), /Candidate requires/u);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: attributed.version, transition_id: "wrong-evidence-kind", stage: "candidate",
      artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "task", id: f.task.id }] }), /must reference Evidence records/u);
  } finally { await f.close(); }
});

test("Evolution Cycle refuses incomplete provenance, duplicate refs, stale snapshots and invalid decisions", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, session_host: "claude" }), /matching live Host Session/u);
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, trigger_refs: [] }), /trigger_refs must contain/u);
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, trigger_refs: [f.startArgs.trigger_refs[0], f.startArgs.trigger_refs[0]] }), /unique references/u);
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, trigger_refs: [{ kind: "task", id: "task", version: 0 }] }), /positive integer/u);
    const generated = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: undefined }).cycle as JsonObject;
    assert.match(String(generated.id), /^evolution_cycle_/u);

    const cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "validation" }).cycle as JsonObject;
    const beforeIdentity = f.store.get("project_identity", f.projectScopeId);
    f.store.save("project_identity", f.projectScopeId, { ...payload(beforeIdentity), canonical_scope: null });
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "bad-identity" }), /does not match the workspace root/u);
    f.store.save("project_identity", f.projectScopeId, payload(beforeIdentity));

    const checkpoint = f.store.get("workspace_checkpoint", String(f.checkpoint.id));
    f.store.save("workspace_checkpoint", String(checkpoint.id), { ...payload(checkpoint), repository_state: { root: f.projectRoot } });
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "bad-repository-state" }), /repository_state.branch is required/u);
    f.store.save("workspace_checkpoint", String(checkpoint.id), payload(checkpoint));
    const currentCheckpoint = f.store.get("workspace_checkpoint", String(checkpoint.id));
    f.store.save("workspace_checkpoint", String(currentCheckpoint.id), { ...payload(currentCheckpoint), entries: [{ path: "src/index.ts", digest: "bad" }] });
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "bad-entry" }), /checkpoint entries are invalid/u);
    f.store.save("workspace_checkpoint", String(currentCheckpoint.id), payload(currentCheckpoint));
    const validCheckpoint = f.store.get("workspace_checkpoint", String(checkpoint.id));
    f.store.save("workspace_checkpoint", String(validCheckpoint.id), { ...payload(validCheckpoint), repository_state: { ...(validCheckpoint.repository_state as JsonObject), working_tree_digest: "bad" } });
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "bad-working-tree-digest" }), /repository identity is invalid/u);
    f.store.save("workspace_checkpoint", String(validCheckpoint.id), payload(validCheckpoint));
    f.store.save("workspace_checkpoint", String(validCheckpoint.id), { ...payload(validCheckpoint), entries: "bad" as never });
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "bad-entry-array" }), /checkpoint entries are invalid/u);
    f.store.save("workspace_checkpoint", String(validCheckpoint.id), payload(validCheckpoint));

    const start = (id: string) => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: id }).cycle as JsonObject;
    const advance = (item: JsonObject, stage: string, extra: JsonObject = {}) => f.service.evolutionCycleAdvance({ cycle_id: item.id, expected_version: item.version, transition_id: `${item.id}-${stage}`, stage, ...extra });
    const attribution = start("bad-attribution");
    const retrieved = advance(attribution, "retrieve").cycle as JsonObject, acted = advance(retrieved, "act").cycle as JsonObject, feedback = advance(acted, "feedback", { outcome: "failed" }).cycle as JsonObject;
    assert.throws(() => advance(feedback, "attribute"), /Failed outcome attribution requires/u);
    assert.throws(() => advance(feedback, "attribute", { failure_class: "not-a-class" }), /failure_class is unsupported/u);
    assert.throws(() => advance(feedback, "attribute", { failure_class: "environment" }), /must replan/u);
    const environment = advance(feedback, "attribute", { failure_class: "environment", next_stage: "replan" }).cycle as JsonObject;
    assert.equal(environment.stage, "replan");
    const resumed = advance(environment, "observe").cycle as JsonObject;
    const nextRetrieval = advance(resumed, "retrieve").cycle as JsonObject;
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: nextRetrieval.id, expected_version: nextRetrieval.version, transition_id: "bad-metrics", stage: "act", metrics: { cost_usd: -1 } }), /metrics.cost_usd must be non-negative finite/u);
  } finally { await f.close(); }
});

test("Evolution Cycle rejects evaluation drift and requires existing capability decision evidence", async () => {
  const f = await fixture();
  try {
    const candidate = { kind: "knowledge_claim", id: "candidate", version: 1 };
    const start = (id: string) => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: id }).cycle as JsonObject;
    const setEvaluate = (cycle: JsonObject, evaluationRefs: JsonObject[]) => f.store.save("evolution_cycle", String(cycle.id), {
      ...payload(cycle), stage: "evaluate", candidate_refs: [candidate], evaluation_refs: evaluationRefs,
    });
    const noEvaluation = start("no-evaluation"); setEvaluate(noEvaluation, []);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: noEvaluation.id, expected_version: 2, transition_id: "promote", stage: "promote", authority_refs: [{ kind: "knowledge_auto_review", id: "promotion-authority" }] }), /previously recorded evaluation/u);

    const noAuthority = start("no-authority"); setEvaluate(noAuthority, [{ kind: "evaluation_run", id: "held-out", version: 1 }]);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: noAuthority.id, expected_version: 2, transition_id: "promote", stage: "promote" }), /capability authority references/u);
    const multipleCandidates = start("multiple-promotion-candidates");
    const second = f.store.create("knowledge_claim", "promotion-candidate-two", { status: "candidate", scope: `project:${f.projectScopeId}`, content_digest: "two" });
    f.store.save("evolution_cycle", String(multipleCandidates.id), { ...payload(multipleCandidates), stage: "evaluate",
      candidate_refs: [{ kind: "knowledge_claim", id: "candidate", version: 1 }, { kind: "knowledge_claim", id: second.id, version: second.version }],
      evaluation_refs: [{ kind: "evaluation_run", id: "held-out", version: 1 }] });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: multipleCandidates.id, expected_version: 2, transition_id: "multiple-promote", stage: "promote",
      authority_refs: [{ kind: "knowledge_auto_review", id: "promotion-authority" }] }), /one exact candidate/u);
    const unsupported = start("unsupported-promotion-kind");
    const unsupportedCandidate = { kind: "workflow_design", id: "workflow-candidate", version: 1 };
    f.store.create("task", "unsupported-held-out-task", { title: "Independent held-out task", session_id: "unsupported-held-out-session", host_session_id: "unsupported-held-out-session" });
    terminalHostSession(f.service, "unsupported-held-out-task", "unsupported-held-out-session");
    f.store.create("trial", "unsupported-held-out-trial", { task_id: "unsupported-held-out-task", case_id: "unsupported-held-out-case",
      subject_type: unsupportedCandidate.kind, subject_id: unsupportedCandidate.id, subject_version: unsupportedCandidate.version });
    f.store.create("outcome", "outcome_unsupported-held-out-trial", { trial_id: "unsupported-held-out-trial", verdict: "passed" });
    f.store.create("evaluation_run", "unsupported-held-out", { split: "held_out", verdict: "passed", subject_type: unsupportedCandidate.kind,
      subject_id: unsupportedCandidate.id, subject_version: unsupportedCandidate.version, trial_ids: ["unsupported-held-out-trial"] });
    f.store.save("evolution_cycle", String(unsupported.id), { ...payload(unsupported), stage: "evaluate", candidate_refs: [unsupportedCandidate],
      evaluation_refs: [{ kind: "evaluation_run", id: "unsupported-held-out", version: 1 }] });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: unsupported.id, expected_version: 2, transition_id: "unsupported-promote", stage: "promote",
      authority_refs: [{ kind: "knowledge_auto_review", id: "promotion-authority", version: 1 }] }), /verifier is unavailable for candidate kind/u);
    const noDecisionEvidence = start("no-decision-evidence"); setEvaluate(noDecisionEvidence, [{ kind: "evaluation_run", id: "held-out", version: 1 }]);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: noDecisionEvidence.id, expected_version: 2, transition_id: "reject", stage: "reject" }), /requires evidence references/u);

    const prepared = start("prepared"); setEvaluate(prepared, [{ kind: "evaluation_run", id: "held-out", version: 1 }]);
    const rejected = f.service.evolutionCycleAdvance({ cycle_id: prepared.id, expected_version: 2, transition_id: "reject-ok", stage: "reject", evidence_refs: [{ kind: "evidence", id: "observed" }] });
    assert.equal((rejected.cycle as JsonObject).stage, "reject");
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: prepared.id, expected_version: 3, transition_id: "reject-conflict", stage: "reject", evidence_refs: [{ kind: "evidence", id: "observed" }] }), /Invalid Evolution Cycle transition/u);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: prepared.id, expected_version: 1, transition_id: "reject-ok", stage: "reject", evidence_refs: [{ kind: "evidence", id: "observed" }], reason: "different transition payload" }), /idempotency conflict/u);

    const authorityVariants = [
      ["subject_id", "subject_version"], ["memory_id", "memory_version"], ["procedure_id", "procedure_version"],
      ["candidate_id", "candidate_version"], ["index_id", "index_version"],
    ];
    for (const [idField, versionField] of authorityVariants) {
      const cycle = start(`authority-${idField}`); setEvaluate(cycle, [{ kind: "evaluation_run", id: "held-out", version: 1 }]);
      const authorityId = `authority-${idField}`;
      f.store.create("authority_fixture", authorityId, { [idField!]: "candidate", [versionField!]: 1 });
      const current = f.store.get("evolution_cycle", String(cycle.id));
      assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: current.version, transition_id: `promote-${idField}`, stage: "promote",
        authority_refs: [{ kind: "authority_fixture", id: authorityId }] }), /eligible Knowledge review/u);
      assert.equal((f.service.evolutionCycleGet({ cycle_id: cycle.id }).cycle as JsonObject).stage, "evaluate");
    }
    const unpromoted = start("unpromoted-candidate"); setEvaluate(unpromoted, [{ kind: "evaluation_run", id: "held-out", version: 1 }]);
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: unpromoted.id, expected_version: 2, transition_id: "unpromoted",
      stage: "promote", authority_refs: [{ kind: "knowledge_auto_review", id: "promotion-authority", version: 1 }] }), /no verified formal promotion/u);
  } finally { await f.close(); }
});

test("Evolution Cycle promotes only current Experience, Memory and Codebase releases bound to its project snapshot", async () => {
  const f = await fixture();
  try {
    const start = (id: string) => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: id }).cycle as JsonObject;
    const prepare = (id: string, candidate: JsonObject) => {
      const cycle = start(id), taskId = `${id}-held-out-task`, sessionId = `${id}-held-out-session`;
      f.store.create("task", taskId, { title: "Independent held-out task", session_id: sessionId, host_session_id: sessionId });
      terminalHostSession(f.service, taskId, sessionId);
      const trialId = `${id}-held-out-trial`, evaluationId = `${id}-held-out-evaluation`;
      f.store.create("trial", trialId, { task_id: taskId, case_id: `${id}-case`, subject_type: candidate.kind,
        subject_id: candidate.id, subject_version: candidate.version });
      f.store.create("outcome", `outcome_${trialId}`, { trial_id: trialId, verdict: "passed" });
      f.store.create("evaluation_run", evaluationId, { split: "held_out", verdict: "passed", subject_type: candidate.kind,
        subject_id: candidate.id, subject_version: candidate.version, trial_ids: [trialId] });
      f.store.save("evolution_cycle", String(cycle.id), { ...payload(cycle), stage: "evaluate", candidate_refs: [candidate],
        evaluation_refs: [{ kind: "evaluation_run", id: evaluationId, version: 1 }] });
      return { cycle, evaluationId };
    };
    const verify = (id: string, candidate: JsonObject, authority: JsonObject) => {
      const { cycle } = prepare(id, candidate);
      const result = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: 2, transition_id: `${id}-promote`,
        stage: "promote", authority_refs: [authority] });
      assert.equal((result.cycle as JsonObject).stage, "promote");
    };
    const reject = (id: string, candidate: JsonObject, authority: JsonObject, reason: RegExp) => {
      const { cycle } = prepare(id, candidate);
      assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: 2, transition_id: `${id}-promote`,
        stage: "promote", authority_refs: [authority] }), reason);
    };

    const procedure = f.store.create("experience_procedure", "promoted-procedure", { lifecycle: "routeable", routeable: true,
      scope: `project:${f.projectScopeId}`, definition_digest: "procedure-definition" });
    const procedureRelease = f.store.create("experience_release", String(procedure.id), { record_version: procedure.version,
      definition_digest: procedure.definition_digest, status: "active" });
    verify("experience-promotion", { kind: "experience_procedure", id: procedure.id, version: procedure.version },
      { kind: "experience_release", id: procedureRelease.id, version: procedureRelease.version });
    const unReleasedProcedure = f.store.create("experience_procedure", "unreleased-procedure", { lifecycle: "candidate", routeable: false,
      scope: `project:${f.projectScopeId}`, definition_digest: "unreleased-definition" });
    reject("experience-unreleased", { kind: "experience_procedure", id: unReleasedProcedure.id, version: unReleasedProcedure.version },
      { kind: "knowledge_auto_review", id: "promotion-authority", version: 1 }, /no active release/u);
    const foreignRoot = join(f.root, "foreign-project"); await mkdir(foreignRoot, { recursive: true });
    await writeFile(join(foreignRoot, "README.md"), "foreign project\n"); execFileSync("git", ["init", "-q", foreignRoot]);
    const foreignIdentity = f.service.scopeIdentityResolveProject({ project_root: foreignRoot }).identity as JsonObject;
    const foreignScopeId = String((foreignIdentity.canonical_scope as JsonObject).id);
    const foreignProcedure = f.store.create("experience_procedure", "foreign-procedure", { lifecycle: "routeable", routeable: true,
      scope: `project:${foreignScopeId}`, definition_digest: "foreign-definition" });
    const foreignRelease = f.store.create("experience_release", String(foreignProcedure.id), { record_version: foreignProcedure.version,
      definition_digest: foreignProcedure.definition_digest, status: "active" });
    reject("experience-foreign-project", { kind: "experience_procedure", id: foreignProcedure.id, version: foreignProcedure.version },
      { kind: "experience_release", id: foreignRelease.id, version: foreignRelease.version }, /no active release/u);

    const contentDigest = stableDigest("稳定项目记忆");
    const observations = ["memory-session-a", "memory-session-b"].map((sessionDigest, index) => f.store.create("memory_observation", `memory-observation-${index}`, {
      status: "active", kind: "preference", topic: "locale", content_digest: contentDigest, project_id: f.projectScopeId,
      scope: { kind: "project", id: f.projectScopeId }, session_digest: sessionDigest,
    }));
    const memory = f.store.create("memory_ledger", "promoted-memory", { status: "active", kind: "preference", topic: "locale",
      content_digest: contentDigest, scope: { kind: "project", id: f.projectScopeId },
      promotion_support_refs: observations.map(item => ({ kind: "memory_observation", id: item.id, version: item.version })) });
    verify("memory-promotion", { kind: "memory_ledger", id: memory.id, version: memory.version },
      { kind: "memory_ledger", id: memory.id, version: memory.version });
    reject("memory-missing-authority", { kind: "memory_ledger", id: memory.id, version: memory.version },
      { kind: "knowledge_auto_review", id: "promotion-authority", version: 1 }, /not an active project promotion/u);
    const invalidSupport = [0, 1].map(index => f.store.create("memory_observation", `bad-memory-observation-${index}`, {
      status: "active", kind: "preference", topic: "locale", content_digest: contentDigest, project_id: f.projectScopeId,
      scope: { kind: "project", id: f.projectScopeId }, session_digest: "same-independent-session",
    }));
    const unsupportedMemory = f.store.create("memory_ledger", "unsupported-memory", { status: "active", kind: "preference", topic: "locale",
      content_digest: contentDigest, scope: { kind: "project", id: f.projectScopeId },
      promotion_support_refs: invalidSupport.map(item => ({ kind: "memory_observation", id: item.id, version: item.version })) });
    reject("memory-unsupported", { kind: "memory_ledger", id: unsupportedMemory.id, version: unsupportedMemory.version },
      { kind: "memory_ledger", id: unsupportedMemory.id, version: unsupportedMemory.version }, /verified automatic promotion support/u);

    const snapshot = start("codebase-promotion").snapshot as JsonObject;
    const indexIdentity = { workspace_id: snapshot.workspace_id, checkpoint_id: snapshot.checkpoint_id, snapshot_digest: "snapshot-digest", analyzer: "test-analyzer" };
    const index = f.store.create("codebase_index", "promoted-codebase-index", { ...indexIdentity,
      identity_digest: stableDigest(indexIdentity), status: "ready" });
    verify("codebase-promotion", { kind: "codebase_index", id: index.id, version: index.version },
      { kind: "codebase_index", id: index.id, version: index.version });
    reject("codebase-missing-authority", { kind: "codebase_index", id: index.id, version: index.version },
      { kind: "knowledge_auto_review", id: "promotion-authority", version: 1 }, /not a ready artifact/u);
    const staleIdentity = { ...indexIdentity, checkpoint_id: "older-checkpoint" };
    const staleIndex = f.store.create("codebase_index", "stale-codebase-index", { ...staleIdentity,
      identity_digest: stableDigest(staleIdentity), status: "ready" });
    reject("codebase-stale", { kind: "codebase_index", id: staleIndex.id, version: staleIndex.version },
      { kind: "codebase_index", id: staleIndex.id, version: staleIndex.version }, /does not match the evaluated project snapshot/u);
    const corruptedIndex = f.store.create("codebase_index", "corrupt-codebase-index", { ...indexIdentity,
      identity_digest: "corrupt-identity", status: "ready" });
    reject("codebase-corrupt", { kind: "codebase_index", id: corruptedIndex.id, version: corruptedIndex.version },
      { kind: "codebase_index", id: corruptedIndex.id, version: corruptedIndex.version }, /identity digest is invalid/u);
  } finally { await f.close(); }
});

test("Evolution Cycle cannot promote a candidate with a failed held-out result", async () => {
  const f = await fixture();
  try {
    f.store.create("task", "failed-held-out-task", { title: "Independent failed task", session_id: "failed-held-out-session", host_session_id: "failed-held-out-session" });
    terminalHostSession(f.service, "failed-held-out-task", "failed-held-out-session");
    f.store.create("trial", "failed-held-out-trial", { task_id: "failed-held-out-task", case_id: "failed-case",
      subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1 });
    f.store.create("outcome", "outcome_failed-held-out-trial", { trial_id: "failed-held-out-trial", verdict: "failed" });
    f.store.create("evaluation_run", "failed-held-out", { split: "held_out", verdict: "failed", subject_type: "knowledge_claim",
      subject_id: "candidate", subject_version: 1, trial_ids: ["failed-held-out-trial"] });

    let cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "failed-promotion" }).cycle as JsonObject;
    const advance = (stage: string, extra: JsonObject = {}) => {
      cycle = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
        transition_id: `${stage}-${cycle.version}`, stage, ...extra }).cycle as JsonObject;
    };
    advance("retrieve"); advance("act"); advance("feedback", { outcome: "passed", evidence_refs: [{ kind: "evidence", id: "observed" }] });
    advance("attribute");
    advance("candidate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] });
    advance("evaluate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
      evaluation_refs: [{ kind: "evaluation_run", id: "failed-held-out" }] });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "blocked-promotion",
      stage: "promote", authority_refs: [{ kind: "knowledge_auto_review", id: "promotion-authority" }] }), /passing held-out evaluation/u);
    assert.equal(((f.service.evolutionCycleGet({ cycle_id: cycle.id }).cycle as JsonObject).stage), "evaluate");
  } finally { await f.close(); }
});

test("Evolution Cycle rejects held-out tasks copied from candidate-generation evidence", async () => {
  const f = await fixture();
  try {
    const sourceTask = f.store.create("task", "candidate-origin-task", { title: "Candidate source", session_id: "candidate-origin-session", host_session_id: "candidate-origin-session" });
    terminalHostSession(f.service, String(sourceTask.id), "candidate-origin-session");
    const evidence = f.store.get("evidence", "observed");
    f.store.save("evidence", "observed", { ...payload(evidence), metadata: { source_task_id: sourceTask.id, source_session_id: "candidate-origin-session" } });
    f.store.create("trial", "leaked-held-out-trial", { task_id: sourceTask.id, case_id: "same-source", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1 });
    f.store.create("outcome", "outcome_leaked-held-out-trial", { trial_id: "leaked-held-out-trial", verdict: "passed" });
    f.store.create("evaluation_run", "leaked-held-out", { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: ["leaked-held-out-trial"] });

    let cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "candidate-source-overlap" }).cycle as JsonObject;
    const advance = (stage: string, extra: JsonObject = {}) => {
      cycle = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
        transition_id: `${stage}-${cycle.version}`, stage, ...extra }).cycle as JsonObject;
    };
    advance("retrieve"); advance("act"); advance("feedback", { outcome: "passed", evidence_refs: [{ kind: "evidence", id: "observed" }] });
    advance("attribute"); advance("candidate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "overlapping-evaluation",
      stage: "evaluate", artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evaluation_refs: [{ kind: "evaluation_run", id: "leaked-held-out" }] }), /overlaps the candidate-generation evidence/u);
    assert.equal((f.service.evolutionCycleGet({ cycle_id: cycle.id }).cycle as JsonObject).stage, "candidate");
  } finally { await f.close(); }
});

test("Evolution Cycle evaluates non-session evidence without inventing candidate source identities", async () => {
  const f = await fixture();
  try {
    const evidence = f.store.get("evidence", "observed");
    const { metadata: _metadata, ...withoutMetadata } = payload(evidence);
    f.store.save("evidence", "observed", withoutMetadata);
    let cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "document-source-candidate" }).cycle as JsonObject;
    const advance = (stage: string, extra: JsonObject = {}) => {
      cycle = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
        transition_id: `${stage}-${cycle.version}`, stage, ...extra }).cycle as JsonObject;
    };
    advance("retrieve"); advance("act"); advance("feedback", { outcome: "passed", evidence_refs: [{ kind: "evidence", id: "observed" }] });
    advance("attribute"); advance("candidate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] });
    advance("evaluate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evaluation_refs: [{ kind: "evaluation_run", id: "held-out" }] });
    assert.equal(cycle.stage, "evaluate");
  } finally { await f.close(); }
});

test("Evolution Cycle requires held-out Host sessions to be terminal, content-free and task-bound", async () => {
  const f = await fixture();
  try {
    let cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "invalid-host-session-evaluation" }).cycle as JsonObject;
    const advance = (stage: string, extra: JsonObject = {}) => {
      cycle = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
        transition_id: `${stage}-${cycle.version}`, stage, ...extra }).cycle as JsonObject;
    };
    advance("retrieve"); advance("act"); advance("feedback", { outcome: "passed", evidence_refs: [{ kind: "evidence", id: "observed" }] });
    advance("attribute");
    advance("candidate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] });
    const assertEvaluationRejected = (id: string, taskId: string, sessionId: string) => {
      f.store.create("task", taskId, { title: "Held-out task", session_id: sessionId, host_session_id: sessionId });
      f.store.create("trial", `${id}-trial`, { task_id: taskId, subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1 });
      f.store.create("outcome", `outcome_${id}-trial`, { verdict: "passed" });
      f.store.create("evaluation_run", id, { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: [`${id}-trial`] });
      assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
        transition_id: `evaluate-${id}`, stage: "evaluate", artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evaluation_refs: [{ kind: "evaluation_run", id }] }), /terminal content-free Host Session/u);
    };
    const activeTask = f.store.create("task", "active-held-out-task", { title: "Active session evaluation", session_id: "active-session", host_session_id: "active-session" });
    f.service.hostSessionOpen({ session_id: "active-session", task_id: activeTask.id, host_id: "codex", environment_fingerprint: "env", policy_fingerprint: "policy", capability_fingerprint: "cap" });
    f.store.create("trial", "active-session-trial", { task_id: activeTask.id, subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1 });
    f.store.create("outcome", "outcome_active-session-trial", { verdict: "passed" });
    f.store.create("evaluation_run", "active-session-evaluation", { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: ["active-session-trial"] });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "evaluate-active-session", stage: "evaluate",
      artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evaluation_refs: [{ kind: "evaluation_run", id: "active-session-evaluation" }] }), /terminal content-free Host Session/u);
    terminalHostSession(f.service, "different-task", "misbound-session");
    assertEvaluationRejected("misbound-session-evaluation", "claimed-task", "misbound-session");
    terminalHostSession(f.service, "sensitive-task", "sensitive-session");
    const sensitive = f.store.get("host_session", "sensitive-session");
    f.store.save("host_session", "sensitive-session", { ...payload(sensitive), raw_content_stored: true });
    assertEvaluationRejected("sensitive-session-evaluation", "sensitive-task", "sensitive-session");

    const traceTask = f.store.create("task", "trace-mismatch-task", { title: "Trace mismatch task", session_id: "trace-mismatch-session", host_session_id: "trace-mismatch-session" });
    terminalHostSession(f.service, String(traceTask.id), "trace-mismatch-session");
    const traceSession = f.store.get("host_session", "trace-mismatch-session"), trace = f.store.get("trace", String(traceSession.trace_id));
    const otherTraceTask = f.store.create("task", "trace-mismatch-owner", { title: "Other Trace owner" });
    f.store.save("trace", String(trace.id), { ...payload(trace), task_id: otherTraceTask.id });
    f.store.create("trial", "trace-mismatch-trial", { task_id: traceTask.id, subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1 });
    f.store.create("outcome", "outcome_trace-mismatch-trial", { verdict: "passed" });
    f.store.create("evaluation_run", "trace-mismatch-evaluation", { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: ["trace-mismatch-trial"] });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: "evaluate-trace-mismatch", stage: "evaluate",
      artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evaluation_refs: [{ kind: "evaluation_run", id: "trace-mismatch-evaluation" }] }), /Host Session Trace belongs to another task/u);
  } finally { await f.close(); }
});

test("Evolution Cycle validates independent Knowledge cases and rejects same-session or misbound evaluation", async () => {
  const f = await fixture();
  try {
    const enterCandidate = (id: string) => {
      let cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: id }).cycle as JsonObject;
      const advance = (stage: string, extra: JsonObject = {}) => {
        const result = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: `${id}-${stage}-${cycle.version}`, stage, ...extra });
        cycle = result.cycle as JsonObject; return result;
      };
      advance("retrieve"); advance("act"); advance("feedback", { outcome: "passed", evidence_refs: [{ kind: "evidence", id: "observed" }] });
      advance("attribute");
      advance("candidate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] });
      return { cycle, advance };
    };
    const scope = `project:${f.projectScopeId}`;
    f.store.save("evidence", "observed", { ...payload(f.store.get("evidence", "observed")), metadata: { source_session_id: "claim-session", task_id: "claim-task" } });
    const candidateBefore = f.store.get("knowledge_claim", "candidate");
    const candidate = f.store.save("knowledge_claim", "candidate", { ...payload(candidateBefore), content: "Candidate fact.", evidence_ids: ["observed"] });
    f.store.create("evidence", "held-out-source", { confidence: "confirmed", source_type: "program",
      metadata: { source_session_id: "held-out-session", task_id: "held-out-task" } });
    const candidateRef = { claim_id: candidate.id, claim_version: candidate.version, identity_digest: candidate.identity_digest ?? null,
      content_digest: candidate.content_digest ?? null };
    const savedCase = f.service.knowledgeEvaluationCaseSave({ case_id: "knowledge-held-out-case", scope, query: "Candidate fact", expected_claim_ids: ["candidate"],
      candidate_claim_refs: [candidateRef], source_evidence_ids: ["held-out-source"], dataset_partition: "held_out", evaluation_channel: "real_session",
      sanitized: true, source_task_id: "held-out-task", source_session_id: "held-out-session", label_source: "model_candidate" }).case as JsonObject;
    adjudicateKnowledgeCase(f.service, savedCase, "accepted", ["candidate"]);
    const knowledgeRun = f.service.knowledgeEvaluationRun({ run_id: "knowledge-held-out-run", mode: "candidate_shadow", case_ids: [savedCase.id],
      candidate_claim_ids: ["candidate"], now: "2026-10-26T00:00:00.000Z" }).run as JsonObject;
    assert.equal((knowledgeRun.metrics as JsonObject).provenance_eligible, true);
    assert.equal((knowledgeRun.results as JsonObject[])[0]!.provenance_status, "verified_independent");
    const knowledge = enterCandidate("knowledge-evaluation");
    const evaluated = knowledge.advance("evaluate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
      evaluation_refs: [{ kind: "knowledge_evaluation_run", id: "knowledge-held-out-run" }] });
    assert.equal((evaluated.cycle as JsonObject).stage, "evaluate");

    const wrongBinding = enterCandidate("wrong-binding");
    const claim = f.store.get("knowledge_claim", "candidate");
    f.store.save("knowledge_claim", "candidate", { ...payload(claim), content_digest: "candidate-v2" });
    f.store.create("evaluation_run", "held-out-v3", { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: f.store.get("knowledge_claim", "candidate").version, trial_ids: ["held-out-trial"] });
    assert.throws(() => wrongBinding.advance("evaluate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate", version: 3 }],
      evaluation_refs: [{ kind: "evaluation_run", id: "held-out-v3" }] }), /differs from the recorded candidate/u);
    f.store.create("task", "same-session-task", { title: "Not independent", session_id: "session" });
    f.store.create("trial", "same-session-trial", { task_id: "same-session-task", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: f.store.get("knowledge_claim", "candidate").version });
    f.store.create("outcome", "outcome_same-session-trial", { verdict: "passed" });
    f.store.create("evaluation_run", "same-session-evaluation", { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: f.store.get("knowledge_claim", "candidate").version, trial_ids: ["same-session-trial"] });
    const sameSession = enterCandidate("same-session");
    assert.throws(() => sameSession.advance("evaluate", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
      evaluation_refs: [{ kind: "evaluation_run", id: "same-session-evaluation" }] }), /independent task and Host session/u);
  } finally { await f.close(); }
});

test("Evolution Cycle fails closed for malformed held-out evidence and stale decisions", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "non-array-refs", trigger_refs: "bad" as never }), /at most 50 references/u);
    assert.throws(() => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "too-many-refs", trigger_refs: Array(51).fill(f.startArgs.trigger_refs[0]) }), /at most 50 references/u);
    const start = (id: string) => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: id }).cycle as JsonObject;
    const evaluationCandidate = (id: string) => {
      let cycle = start(id);
      for (const stage of ["retrieve", "act", "feedback", "attribute", "candidate"]) {
        const extra: JsonObject = stage === "feedback" ? { outcome: "passed" }
          : stage === "attribute" ? {}
          : stage === "candidate" ? { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] } : {};
        cycle = (f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version,
          transition_id: `${id}-${stage}`, stage, ...extra }).cycle as JsonObject);
      }
      return (evaluationRef: JsonObject | null, artifactRef: JsonObject | null = { kind: "knowledge_claim", id: "candidate" }) =>
        f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: `${id}-evaluate`, stage: "evaluate",
          artifact_refs: artifactRef ? [artifactRef] : [], evaluation_refs: evaluationRef ? [evaluationRef] : [] });
    };
    const evaluateEmpty = evaluationCandidate("empty-trials");
    f.store.create("evaluation_run", "empty-held-out", { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: [] });
    assert.throws(() => evaluateEmpty({ kind: "evaluation_run", id: "empty-held-out" }), /independently sourced trials/u);
    assert.throws(() => evaluationCandidate("unsupported-evaluation")({ kind: "evidence", id: "observed" }), /unsupported for independent held-out/u);

    const scope = `project:${f.projectScopeId}`;
    f.store.create("knowledge_evaluation_case", "bad-partition-case", { scope, identity_digest: null, dataset_partition: "train", evaluation_channel: "real_session", sanitized: true,
      source_task_id: "held-out-task", source_session_id: "held-out-session" });
    f.store.create("knowledge_evaluation_run", "bad-partition-run", { scope, mode: "candidate_shadow", status: "eligible",
      metrics: { provenance_eligible: true }, results: [{ case_id: "bad-partition-case", evaluation_eligible: true, provenance_status: "verified_independent" }],
      case_refs: [{ case_id: "bad-partition-case", case_version: 1, identity_digest: null }], candidate_claim_refs: [{ claim_id: "candidate", claim_version: 1 }] });
    assert.throws(() => evaluationCandidate("bad-case")({ kind: "knowledge_evaluation_run", id: "bad-partition-run" }), /independent real-session provenance/u);
    const noCases = evaluationCandidate("missing-knowledge-case-list");
    f.store.create("knowledge_evaluation_run", "missing-case-list-run", { scope, mode: "candidate_shadow", status: "eligible", metrics: { provenance_eligible: true },
      case_refs: "invalid", candidate_claim_refs: [{ claim_id: "candidate", claim_version: 1 }] });
    assert.throws(() => noCases({ kind: "knowledge_evaluation_run", id: "missing-case-list-run" }), /bind the exact candidate/u);
    const noCandidates = evaluationCandidate("missing-knowledge-candidate-list");
    f.store.create("knowledge_evaluation_run", "missing-candidate-list-run", { scope, mode: "candidate_shadow", status: "eligible", metrics: { provenance_eligible: true },
      case_refs: [{ case_id: "bad-partition-case", case_version: 1, identity_digest: null }], candidate_claim_refs: "invalid" });
    assert.throws(() => noCandidates({ kind: "knowledge_evaluation_run", id: "missing-candidate-list-run" }), /bind the exact candidate/u);
    const noResults = evaluationCandidate("missing-knowledge-results-list");
    f.store.create("knowledge_evaluation_run", "missing-results-list-run", { scope, mode: "candidate_shadow", status: "eligible", metrics: { provenance_eligible: true },
      case_refs: [{ case_id: "bad-partition-case", case_version: 1, identity_digest: null }], candidate_claim_refs: [{ claim_id: "candidate", claim_version: 1 }], results: "invalid" });
    assert.throws(() => noResults({ kind: "knowledge_evaluation_run", id: "missing-results-list-run" }), /independent real-session provenance/u);

    const decided = start("authority-mismatch");
    f.store.save("evolution_cycle", String(decided.id), { ...payload(decided), stage: "evaluate",
      candidate_refs: [{ kind: "knowledge_claim", id: "candidate", version: 1 }], evaluation_refs: [{ kind: "evaluation_run", id: "held-out", version: 1 }] });
    f.store.create("knowledge_claim", "different-candidate", { status: "candidate", content_digest: "other", scope,
      source_id: null, evidence_ids: [] });
    f.store.create("knowledge_auto_review", "wrong-authority", { claim_id: "different-candidate", claim_version: 1, verdict: "eligible" });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: decided.id, expected_version: 2, transition_id: "mismatch-authority", stage: "promote",
      authority_refs: [{ kind: "knowledge_auto_review", id: "wrong-authority" }] }), /bind the exact candidate version/u);

    const terminal = start("terminal");
    f.store.save("evolution_cycle", String(terminal.id), { ...payload(terminal), status: "completed" });
    assert.throws(() => f.service.evolutionCycleAdvance({ cycle_id: terminal.id, expected_version: 2, transition_id: "after-terminal", stage: "retrieve" }), /terminal/u);

    const missingEvalParts = evaluationCandidate("missing-evaluation-parts");
    assert.throws(() => missingEvalParts(null, null), /candidate artifacts and evaluation references/u);
  } finally { await f.close(); }
});

test("Evolution Cycle binds exactly one candidate revision to an observed held-out outcome", async () => {
  const f = await fixture();
  try {
    const begin = (id: string) => f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: id }).cycle as JsonObject;
    const candidateStage = (id: string) => {
      let cycle = begin(id);
      for (const stage of ["retrieve", "act", "feedback", "attribute", "candidate"]) {
        const extra: JsonObject = stage === "feedback" ? { outcome: "passed" }
          : stage === "attribute" ? {}
          : stage === "candidate" ? { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }], evidence_refs: [{ kind: "evidence", id: "observed" }] } : {};
        cycle = f.service.evolutionCycleAdvance({ cycle_id: cycle.id, expected_version: cycle.version, transition_id: `${id}-${stage}`, stage, ...extra }).cycle as JsonObject;
      }
      return cycle;
    };
    const advance = (cycle: JsonObject, transition: string, args: JsonObject) => f.service.evolutionCycleAdvance({ cycle_id: cycle.id,
      expected_version: cycle.version, transition_id: transition, stage: "evaluate", ...args });
    const other = f.store.create("knowledge_claim", "candidate-other", { status: "candidate", content_digest: "other", scope: `project:${f.projectScopeId}` });
    const multi = candidateStage("multi-candidate");
    const twoRefs = [{ kind: "knowledge_claim", id: "candidate", version: 1 }, { kind: "knowledge_claim", id: other.id, version: other.version }]
      .sort((a, b) => `${a.kind}:${a.id}:${a.version}`.localeCompare(`${b.kind}:${b.id}:${b.version}`));
    f.store.save("evolution_cycle", String(multi.id), { ...payload(multi), candidate_refs: twoRefs });
    const multiSaved = f.store.get("evolution_cycle", String(multi.id));
    assert.throws(() => advance(multiSaved, "multi-candidate-eval", { artifact_refs: twoRefs, evaluation_refs: [{ kind: "evaluation_run", id: "held-out" }] }), /one exact candidate/u);

    const wrongVerdict = candidateStage("wrong-verdict");
    f.store.create("evaluation_run", "bad-verdict-run", { split: "held_out", verdict: "pending", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: ["held-out-trial"] });
    assert.throws(() => advance(wrongVerdict, "wrong-verdict-eval", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
      evaluation_refs: [{ kind: "evaluation_run", id: "bad-verdict-run" }] }), /observed held-out run/u);

    const missingTrials = candidateStage("malformed-trials");
    f.store.create("evaluation_run", "malformed-trials-run", { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: "not-an-array" });
    assert.throws(() => advance(missingTrials, "malformed-trials-eval", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
      evaluation_refs: [{ kind: "evaluation_run", id: "malformed-trials-run" }] }), /independently sourced trials/u);

    for (const [id, sessionField] of [["source-session-fallback", "source_session_id"], ["host-session-fallback", "host_session_id"]]) {
      const cycle = candidateStage(id);
      f.store.create("task", `${id}-task`, { title: "Independent evaluation", [sessionField]: `${id}-session`, host_session_id: `${id}-session` });
      terminalHostSession(f.service, `${id}-task`, `${id}-session`);
      f.store.create("trial", `${id}-trial`, { task_id: `${id}-task`, subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1 });
      f.store.create("outcome", `outcome_${id}-trial`, { verdict: "failed" });
      f.store.create("evaluation_run", `${id}-run`, { split: "held_out", verdict: "failed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: [`${id}-trial`] });
      assert.equal((advance(cycle, `${id}-evaluate`, { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
        evaluation_refs: [{ kind: "evaluation_run", id: `${id}-run` }] }).cycle as JsonObject).stage, "evaluate");
    }
    const noOutcome = candidateStage("missing-outcome");
    f.store.create("task", "no-outcome-task", { title: "Independent task", source_session_id: "independent-session" });
    terminalHostSession(f.service, "no-outcome-task", "independent-session");
    f.store.create("trial", "no-outcome-trial", { task_id: "no-outcome-task", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1 });
    f.store.create("evaluation_run", "no-outcome-run", { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: ["no-outcome-trial"] });
    assert.throws(() => advance(noOutcome, "missing-outcome-eval", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
      evaluation_refs: [{ kind: "evaluation_run", id: "no-outcome-run" }] }), /terminal outcome/u);

    const wrongTrial = candidateStage("misbound-trial");
    f.store.create("task", "misbound-trial-task", { title: "Independent task", session_id: "misbound-session", host_session_id: "misbound-session" });
    terminalHostSession(f.service, "misbound-trial-task", "misbound-session");
    f.store.create("trial", "misbound-trial", { task_id: "misbound-trial-task", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 2 });
    f.store.create("outcome", "outcome_misbound-trial", { verdict: "passed" });
    f.store.create("evaluation_run", "misbound-trial-run", { split: "held_out", verdict: "passed", subject_type: "knowledge_claim", subject_id: "candidate", subject_version: 1, trial_ids: ["misbound-trial"] });
    assert.throws(() => advance(wrongTrial, "misbound-trial-eval", { artifact_refs: [{ kind: "knowledge_claim", id: "candidate" }],
      evaluation_refs: [{ kind: "evaluation_run", id: "misbound-trial-run" }] }), /exact candidate version/u);
  } finally { await f.close(); }
});

test("Evolution Cycle detects append-only history, digest and current-head corruption", async () => {
  const f = await fixture();
  try {
    const chain = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "broken-chain" }).cycle as JsonObject;
    assert.throws(() => f.store.appendEvent("evolution:broken-chain", "tampered", { event_id: "broken-chain:1", cycle_id: "broken-chain",
      sequence: 1, previous_event_digest: "wrong", event_digest: "wrong" }), /conflicts with an existing event/u);
    assert.throws(() => f.store.appendEvent("evolution:broken-chain", "tampered", { sequence: 9, previous_event_digest: "wrong", event_digest: "wrong" }), /sequence is stale/u);
    f.store.appendEvent("evolution:broken-chain", "tampered", { event_id: "broken-chain:2", cycle_id: "broken-chain", sequence: 2,
      previous_event_digest: "wrong", event_digest: "wrong" });
    assert.throws(() => f.service.evolutionCycleGet({ cycle_id: chain.id }), /event chain is invalid/u);

    const digestCycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "broken-digest" }).cycle as JsonObject;
    f.store.appendEvent("evolution:broken-digest", "tampered", { event_id: "broken-digest:2", cycle_id: "broken-digest", sequence: 2,
      previous_event_digest: digestCycle.last_event_digest, event_digest: "wrong" });
    assert.throws(() => f.service.evolutionCycleGet({ cycle_id: digestCycle.id }), /event digest is invalid/u);

    const head = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "broken-head" }).cycle as JsonObject;
    f.store.save("evolution_cycle", String(head.id), { ...payload(head), last_event_digest: "wrong-head" });
    assert.throws(() => f.service.evolutionCycleGet({ cycle_id: head.id }), /head does not match/u);
  } finally { await f.close(); }
});

test("Evolution Cycle storage is project-only and rejects an unregistered project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-evolution-scope-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    assert.throws(() => store.create("evolution_cycle", "global-cycle", { scope: { kind: "global", id: "global" } }), /requires project scope/u);
    assert.throws(() => store.create("evolution_cycle", "unbound-cycle", { scope: { kind: "project", id: "project:unregistered" } }), /storage root is not registered/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Evolution Cycle partition transactions fail closed on stale or incomplete storage state", async () => {
  const f = await fixture();
  try {
    const internals = f.store as unknown as { saveEvolutionPartition(id: string, value: JsonObject, version?: number): JsonObject };
    assert.throws(() => internals.saveEvolutionPartition("unavailable", {}), /project partition is unavailable/u);
    assert.throws(() => f.store.advanceEvolutionCycle("unavailable", 1, {}, "retrieve", { transition_id: "t" }), /project partition is unavailable/u);

    const noTransition = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "missing-transition" }).cycle as JsonObject;
    assert.throws(() => f.store.advanceEvolutionCycle(String(noTransition.id), 1, {}, "retrieve", { cycle_id: noTransition.id, sequence: 2 }), /requires a transition ID/u);
    assert.throws(() => f.store.advanceEvolutionCycle(String(noTransition.id), 0, {}, "retrieve",
      { cycle_id: noTransition.id, sequence: 2, transition_id: "stale-version" }), /version conflict/u);
    assert.throws(() => f.store.advanceEvolutionCycle(String(noTransition.id), 1, {}, "retrieve",
      { cycle_id: noTransition.id, sequence: 1, transition_id: "stale-sequence" }), /sequence is stale/u);
    assert.throws(() => f.store.appendEvent("evolution:unregistered-cycle", "observe", {}), /project partition is unavailable/u);
    assert.throws(() => f.store.events("evolution:unregistered-cycle"), /project partition is unavailable/u);

    const missingPartition = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "missing-partition-row" }).cycle as JsonObject;
    const pointerRow = f.store.database.prepare("SELECT payload_json FROM records WHERE kind='evolution_cycle' AND id=?").get(String(missingPartition.id)) as { payload_json: string };
    const pointer = (JSON.parse(pointerRow.payload_json) as JsonObject)._evolution_partition as JsonObject;
    const partition = new DatabaseSync(String(pointer.file));
    try { partition.prepare("DELETE FROM records WHERE kind='evolution_cycle' AND id=?").run(String(missingPartition.id)); }
    finally { partition.close(); }
    assert.throws(() => f.store.advanceEvolutionCycle(String(missingPartition.id), 1, {}, "retrieve",
      { cycle_id: missingPartition.id, sequence: 2, transition_id: "missing-row" }), /partition record is unavailable/u);

    const otherRoot = join(f.root, "other-project"); await mkdir(otherRoot);
    f.store.create("scope_alias", "other-project-root", { scope: { kind: "project", id: "other-project" }, alias_kind: "path", alias: otherRoot, status: "active" });
    const other = f.store.create("evolution_cycle", "other-project-cycle", { scope: { kind: "project", id: "other-project" }, sequence: 1 });
    f.store.appendEvent("evolution:other-project-cycle", "observe", { cycle_id: other.id, sequence: 1 });
    const blockedRow = f.store.database.prepare("SELECT payload_json FROM records WHERE kind='evolution_cycle' AND id=?").get(String(noTransition.id)) as { payload_json: string };
    const blockedPointer = (JSON.parse(blockedRow.payload_json) as JsonObject)._evolution_partition as JsonObject;
    const held = new DatabaseSync(String(blockedPointer.file));
    held.exec("BEGIN IMMEDIATE");
    try {
      const advanced = f.store.advanceEvolutionCycle(String(other.id), 1, { scope: other.scope, sequence: 2 }, "retrieve",
        { cycle_id: other.id, sequence: 2, transition_id: "independent-project-write", request_digest: "sha256:independent" });
      assert.equal((advanced.cycle as JsonObject).version, 2);
    } finally { held.exec("ROLLBACK"); held.close(); }

    const fallbackSequence = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "fallback-sequence" }).cycle as JsonObject;
    assert.equal(f.store.appendEvent(`evolution:${fallbackSequence.id}`, "supplemental", { sequence: 0 }).sequence, 2);
  } finally { await f.close(); }
});

test("Evolution Cycle storage validates version appends and derives project partition paths safely", async () => {
  const f = await fixture();
  try {
    const storage = f.store as unknown as { partitionDatabaseFile(domain: "evolution", scope: { kind: string; id: string }, create?: boolean): string };
    assert.throws(() => storage.partitionDatabaseFile("evolution", { kind: "global", id: "global" }, false), /requires project scope/u);
    assert.throws(() => storage.partitionDatabaseFile("evolution", { kind: "project", id: "missing-root" }, false), /root is not registered/u);
    assert.match(storage.partitionDatabaseFile("evolution", { kind: "project", id: f.projectScopeId }, false), /evolution[\\/]evolution\.db$/u);

    const cycle = f.service.evolutionCycleStart({ ...f.startArgs, cycle_id: "direct-partition-save" }).cycle as JsonObject;
    const withoutVersion = { ...payload(cycle), version: undefined, marker: "fallback-version" };
    const saved = f.store.save("evolution_cycle", String(cycle.id), withoutVersion);
    assert.equal(saved.version, 2);
    assert.throws(() => f.store.save("evolution_cycle", String(cycle.id), { ...payload(saved), version: 1 }), /Concurrent update detected/u);
    assert.throws(() => f.store.save("evolution_cycle", String(cycle.id), payload(saved), 4), /versions must be appended in order/u);

    const competingRoot = join(f.root, "competing-project-root"); await mkdir(competingRoot);
    f.store.create("scope_alias", "competing-evolution-root", { scope: { kind: "project", id: f.projectScopeId },
      alias_kind: "path", alias: competingRoot, status: "active" });
    assert.throws(() => storage.partitionDatabaseFile("evolution", { kind: "project", id: f.projectScopeId }, false), /root is ambiguous/u);
  } finally { await f.close(); }
});
