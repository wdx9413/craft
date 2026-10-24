import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatResult, ModelProviderSpec, ModelTransport } from "../core/model-gateway.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../core/digest.ts";
import { codexSessionTaskBatch, readCodexSessionTaskExcerpt, reconcileCodexSessionTaskEvidence, runCodexSessionCollectionOnce } from "../core/codex-session-archive.ts";
import { runSessionKnowledgeCandidateOnce } from "../deploy/experience-learning/session-knowledge-candidates.ts";
import { runSessionKnowledgeEvaluationOnce } from "../deploy/experience-learning/session-knowledge-evaluation.ts";
import type { ExperienceLearningClient } from "../deploy/experience-learning/worker.ts";

const provider: ModelProviderSpec = { provider: "test", label: "test", protocol: "openai-compatible", base_url: "https://example.invalid/v1",
  api_key_env: "TEST_KEY", chat_path: "/chat/completions", models: { standard: "test-model" }, cost_hint: 0, supports_tools: false };

async function setup(partition: "candidate_generation" | "held_out" = "candidate_generation", includeVerification = true,
  includeContextEvidence = true, transcriptCommand = false) {
  const root = await mkdtemp(join(tmpdir(), "craft-session-knowledge-"));
  const project = join(root, "project"), sessions = join(root, "sessions"), state = join(root, "runtime", "sessions.json");
  const workerState = join(root, "knowledge", "session-candidates.json"), source = join(sessions, "session.jsonl");
  await mkdir(project, { recursive: true }); await mkdir(sessions, { recursive: true });
  execFileSync("git", ["init", "--quiet", project]);
  let sessionId = "candidate-session-1";
  while ((Number.parseInt(createHash("sha256").update(sessionId).digest("hex").slice(0, 8), 16) % 5 === 0) !== (partition === "held_out")) sessionId += "x";
  const event = (payload: JsonObject) => JSON.stringify({ type: "event_msg", payload });
  const response = (payload: JsonObject) => JSON.stringify({ type: "response_item", payload });
  const verification = includeVerification ? [
    response({ type: "custom_tool_call", call_id: "verification-call", name: "exec", input: "pnpm test" }),
    response({ type: "custom_tool_call_output", call_id: "verification-call", output: [
      { type: "text", text: "Process exited with code 0" }, { type: "text", text: "Tests 1 passed (1)" },
    ] }),
  ] : [];
  const transcriptVerification = transcriptCommand ? [event({ type: "item_completed", turn_id: "turn-1", item: { type: "CommandExecution", id: "command-1",
    command: ["/bin/zsh", "-lc", `cd '${project}' && pnpm test`], aggregated_output: [{ type: "text", text: "Tests 1 passed (1)" }],
    exit_code: 0, status: "completed" } })] : [];
  const lines = [JSON.stringify({ type: "session_meta", payload: { session_id: sessionId, cwd: project } }),
    event({ type: "task_started", turn_id: "turn-1", started_at: "2026-10-20T00:00:00Z" }),
    response({ type: "message", role: "user", content: [{ type: "input_text", text: "整理项目依赖升级的验证流程" }] }),
    ...verification, ...transcriptVerification,
    response({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "本次已验证依赖升级后运行单测并检查锁文件" }] }),
    event({ type: "task_complete", turn_id: "turn-1", completed_at: "2026-10-20T00:01:00Z" })];
  await writeFile(source, `${lines.join("\n")}\n`);
  await runCodexSessionCollectionOnce({ sessions_root: sessions, state_file: state });
  const index = JSON.parse(await readFile(state, "utf8")) as JsonObject;
  const task = Object.values(index.tasks as Record<string, JsonObject>)[0]!;
  const evidence = { evidence_id: "evidence-session-task", host: "codex-cli", session_id: sessionId, turn_id: "turn-1", task_id: task.task_id,
    context_receipt_id: "context-receipt", verification_ref_digest: `sha256:${"a".repeat(64)}`,
    terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false };
  if (includeContextEvidence) await reconcileCodexSessionTaskEvidence([evidence], { sessions_root: sessions, state_file: state });
  return { root, project, sessions, state, workerState, source, task, sessionId };
}

async function mutateIndexedTask(f: Awaited<ReturnType<typeof setup>>, changes: JsonObject) {
  const index = JSON.parse(await readFile(f.state, "utf8")) as JsonObject;
  const tasks = index.tasks as Record<string, JsonObject>;
  tasks[String(f.task.task_id)] = { ...tasks[String(f.task.task_id)]!, ...changes };
  await writeFile(f.state, JSON.stringify(index));
}

function workerClient(overrides: Record<string, (args: JsonObject) => JsonObject> = {}) {
  const calls: Array<{ name: string; args: JsonObject }> = [];
  const client: ExperienceLearningClient = { async call(name, args = {}) {
    calls.push({ name, args });
    if (overrides[name]) return overrides[name]!(args);
    if (name === "craft_evaluation_model_profile_ensure_single") return { status: "ready_for_adapter", profile: { id: "profile", version: 1, provider: "test", model: "test-model", max_attempts: 1 } };
    if (name === "craft_evaluation_model_profile_get") return { readiness: { status: "ready_for_adapter" } };
    if (name === "craft_trace_start") return { trace: { id: "trace-session-task" } };
    if (name === "craft_trace_append" || name === "craft_trace_finalize") return {};
    if (name === "craft_knowledge_session_evidence_record") return { evidence: { id: "evidence-session-program", source_id: "source-session", fragment_id: "fragment-session" },
      source_id: "source-session", fragment_id: "fragment-session", sanitized_content_stored: true, raw_content_stored: false };
    if (name === "craft_knowledge_claim_save") return { claim: { id: args.claim_id, status: "candidate" } };
    throw new Error(`unexpected tool ${name}`);
  } };
  return { client, calls };
}

function modelTransport(text: string, seen: string[] = []): ModelTransport {
  return { acquireCall: () => true, async complete(_provider, request): Promise<ChatResult> {
    const messages = request.body.messages as JsonObject[];
    const system = String(messages[0]?.content ?? ""), input = String(messages[1]?.content ?? "");
    seen.push(input);
    assert.match(system, /中文/u);
    assert.match(input, /项目依赖升级/u);
    return { text, model: "test-model", usage: { input_tokens: 20, output_tokens: 10 } };
  } };
}

function candidateClaimClient(scope: unknown, extra?: Record<string, (args: JsonObject) => JsonObject>) {
  return workerClient({ craft_knowledge_claim_list: () => ({ claims: [{ id: "candidate-claim", status: "candidate", scope }] }),
    craft_knowledge_semantic_review_packet: () => ({ status: "ready", claim_status: "candidate", packet: { claim: { id: "candidate-claim", version: 1,
      identity_digest: "candidate-identity", content_digest: "candidate-content", title: "依赖升级验证", content: "依赖升级后运行单测。", tags: [] } } }),
    ...extra });
}

async function evaluate(f: Awaited<ReturnType<typeof setup>>, client: ExperienceLearningClient, transport?: ModelTransport,
  extra: Record<string, unknown> = {}) {
  return runSessionKnowledgeEvaluationOnce({ client, providers: [provider], transport, state_file: f.workerState,
    archive_options: { sessions_root: f.sessions, state_file: f.state }, ...extra });
}

test("archived verified generation and held-out tasks remain usable once without mixing their roles", async () => {
  for (const partition of ["candidate_generation", "held_out"] as const) {
    const f = await setup(partition);
    try {
      const archive = join(f.root, "archived_sessions");
      await mkdir(archive);
      await rename(f.source, join(archive, "session.jsonl"));
      const archiveOptions = { sessions_root: f.sessions, archived_sessions_root: archive, state_file: f.state };
      const collection = await runCodexSessionCollectionOnce(archiveOptions);
      assert.equal(collection.tasks_verified, 1);
      const fixture = candidateClaimClient(f.task.project_scope_id, {
        craft_knowledge_evaluation_case_save: args => ({ case: { id: args.case_id, evaluation_eligible: false } }),
        craft_knowledge_evaluation_run: () => ({ run: { id: "run", metrics: { provenance_eligible: false } } }),
      });
      const seen: string[] = [];
      const transport = modelTransport(JSON.stringify(partition === "candidate_generation"
        ? { decision: "candidate", kind: "rule", title: "依赖升级验证", content: "依赖升级后运行单测并检查锁文件。", tags: ["验证"] }
        : { decision: "labeled", expected_claim_ids: ["candidate-claim"] }), seen);
      const deps = { client: fixture.client, providers: [provider], transport, state_file: f.workerState, archive_options: archiveOptions };
      const run = partition === "candidate_generation" ? runSessionKnowledgeCandidateOnce : runSessionKnowledgeEvaluationOnce;
      const result = await run(deps);
      assert.equal(result.status, partition === "candidate_generation" ? "candidate_created" : "case_candidate_created");
      assert.equal(seen.length, 1);
      const saved = fixture.calls.find(call => call.name === (partition === "candidate_generation" ? "craft_knowledge_claim_save" : "craft_knowledge_evaluation_case_save"))!;
      assert.equal(saved.args.scope, f.task.project_scope_id);
      const evidenceIds = (saved.args.evidence_ids ?? saved.args.source_evidence_ids) as string[];
      assert.equal(evidenceIds.length, 2);
      assert(evidenceIds.includes("evidence-session-task"));
      assert(fixture.calls.some(call => call.name === "craft_knowledge_session_evidence_record" && call.args.sanitized === true));
      assert.equal((await run(deps)).status, "idle");
      assert.equal(seen.length, 1, "a relocation must not cause repeated model calls");
      const other = partition === "candidate_generation" ? runSessionKnowledgeEvaluationOnce : runSessionKnowledgeCandidateOnce;
      assert.equal((await other({ ...deps, state_file: join(f.root, "knowledge", "other-partition.json") })).status, "idle");
      assert.equal(seen.length, 1, "generation and held-out roles remain isolated after archiving");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("creates one Chinese Knowledge candidate from a verified generation task and records a content-free Trace", async () => {
  const f = await setup();
  try {
    const fixture = workerClient(), modelInputs: string[] = [];
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport(
      JSON.stringify({ decision: "candidate", kind: "rule", title: "依赖升级验证", content: "依赖升级后应运行单测并检查锁文件。", tags: ["依赖", "验证"] }), modelInputs),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.deepEqual(result, { status: "candidate_created", processed: 1, task_id: f.task.task_id, claim_id: `knowledge_claim_${stableDigest(String(f.task.task_id)).slice(-24)}`,
      trace_id: "trace-session-task", independent_review_required: true, raw_content_stored: false });
    assert.equal(modelInputs.length, 1);
    const save = fixture.calls.find(call => call.name === "craft_knowledge_claim_save")!;
    assert.equal(save.args.scope, f.task.project_scope_id);
    assert.equal(save.args.source_id, "source-session");
    assert.equal((save.args.evidence_ids as string[]).length, 2);
    assert((save.args.evidence_ids as string[]).includes("evidence-session-task"));
    const programEvidence = fixture.calls.find(call => call.name === "craft_knowledge_session_evidence_record")!;
    assert.equal(programEvidence.args.sanitized, true);
    assert.equal(programEvidence.args.source_session_id, f.task.session_id);
    assert.equal((programEvidence.args.verification_artifacts as JsonObject[]).length, 1);
    assert.equal(save.args.content, "依赖升级后应运行单测并检查锁文件。");
    const traceCalls = fixture.calls.filter(call => call.name === "craft_trace_append");
    assert.equal(traceCalls.length, 3);
    assert((traceCalls.at(-1)!.args.output_refs as string[]).includes("evidence-session-program"));
    assert.equal(JSON.stringify(traceCalls).includes("本次已验证"), false);
    const savedState = await readFile(f.workerState, "utf8");
    assert.equal(savedState.includes("本次已验证"), false);
    assert.equal(savedState.includes(String(f.task.task_id)), true);
    const state = JSON.parse(savedState) as JsonObject;
    assert.equal((state.trace_ids_by_task as JsonObject)[String(f.task.task_id)], "trace-session-task");
    assert.deepEqual(await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport("{}"),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } }),
      { status: "idle", processed: 0, verified_candidates_pending: 0, raw_content_stored: false });
    assert.equal(modelInputs.length, 1, "an idle pass must not call the model");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("creates a candidate from a transcript test result without requiring a Context receipt", async () => {
  const f = await setup("candidate_generation", false, false, true);
  try {
    const fixture = workerClient(), modelInputs: string[] = [];
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport(
      JSON.stringify({ decision: "candidate", kind: "rule", title: "依赖升级验证", content: "升级后运行单测并检查锁文件。", tags: ["验证"] }), modelInputs),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.equal(result.status, "candidate_created");
    assert.equal(modelInputs.length, 1);
    const save = fixture.calls.find(call => call.name === "craft_knowledge_claim_save")!;
    assert.deepEqual(save.args.evidence_ids, ["evidence-session-program"]);
    const evidence = fixture.calls.find(call => call.name === "craft_knowledge_session_evidence_record")!;
    assert.equal(evidence.args.source_session_id, f.sessionId);
    assert.equal((evidence.args.verification_artifacts as JsonObject[]).length, 1);
    assert.equal(JSON.stringify(fixture.calls).includes("pnpm test"), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("held-out sessions are never passed to candidate generation", async () => {
  const f = await setup("held_out");
  try {
    let modelCalls = 0;
    const transport: ModelTransport = { async complete() { modelCalls++; return { text: "{}", model: "test-model", usage: { input_tokens: 0, output_tokens: 0 } }; } };
    const fixture = workerClient();
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport,
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.equal(result.status, "idle");
    assert.equal(modelCalls, 0);
    assert.equal(fixture.calls.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("task without a successful test transcript is skipped before profile or model calls", async () => {
  const f = await setup("candidate_generation", false);
  try {
    const fixture = workerClient(); let modelCalls = 0;
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider],
      transport: { async complete() { modelCalls++; return { text: "{}", model: "test-model", usage: { input_tokens: 0, output_tokens: 0 } }; } },
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.deepEqual(result, { status: "skipped", processed: 1, reason: "verifiable_test_result_unavailable", raw_content_stored: false });
    assert.equal(modelCalls, 0);
    assert.equal(fixture.calls.length, 0);
    const saved = JSON.parse(await readFile(f.workerState, "utf8")) as JsonObject;
    const skip = (saved.terminal_skips as Record<string, JsonObject>)[String(f.task.task_id)]!;
    assert.equal(skip.reason_code, "verifiable_test_result_unavailable");
    assert.equal(skip.source_ref_digest, stableDigest(f.task.source_ref));
    assert.equal(JSON.stringify(saved).includes("依赖升级"), false);
    assert.equal((await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], state_file: f.workerState,
      archive_options: { sessions_root: f.sessions, state_file: f.state } })).status, "idle");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("upgrades a legacy candidate state when recording a content-free terminal skip", async () => {
  const f = await setup("candidate_generation", false);
  try {
    await mkdir(join(f.root, "knowledge"), { recursive: true });
    await writeFile(f.workerState, JSON.stringify({ schema: "craft.knowledge-session-candidate-state.v1", processed_task_ids: [] }));
    const fixture = workerClient();
    assert.equal((await runSessionKnowledgeCandidateOnce({ client: fixture.client, state_file: f.workerState,
      archive_options: { sessions_root: f.sessions, state_file: f.state } })).status, "skipped");
    const saved = JSON.parse(await readFile(f.workerState, "utf8")) as JsonObject;
    assert.deepEqual(saved.processed_task_ids, [f.task.task_id]);
    assert.equal(((saved.terminal_skips as Record<string, JsonObject>)[String(f.task.task_id)]!).reason_code,
      "verifiable_test_result_unavailable");
    assert.equal(fixture.calls.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("records a terminal skip when the verified excerpt has no structured artifact list", async () => {
  const f = await setup();
  try {
    const fixture = workerClient();
    const task = ((await codexSessionTaskBatch("candidate_generation", { state_file: f.state })).tasks as JsonObject[])[0]!;
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, state_file: f.workerState,
      read_excerpt: async () => ({ status: "ready", session_id: task.session_id, turn_id: task.turn_id,
        project_scope_id: task.project_scope_id, verification_outcome: "passed", evidence_ids: task.verification_evidence_ids,
        verification_source: task.verification_source, source_ref: task.source_ref, task_goal: "已验证的任务目标", task_result: "已验证的结果" }),
      archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.equal(result.reason, "verifiable_test_result_unavailable");
    assert.equal(fixture.calls.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("held-out task creates a separately labeled evaluation case and preserves ineligible provenance", async () => {
  const f = await setup("held_out");
  try {
    const fixture = workerClient({
      craft_knowledge_claim_list: () => ({ claims: [{ id: "candidate-claim", status: "candidate", scope: f.task.project_scope_id }] }),
      craft_knowledge_semantic_review_packet: () => ({ status: "ready", claim_status: "candidate", packet: { claim: { id: "candidate-claim", version: 1,
        identity_digest: "candidate-identity", content_digest: "candidate-content", title: "依赖升级验证", content: "依赖升级后运行单测并检查锁文件。", tags: ["依赖"] } } }),
      craft_knowledge_evaluation_case_save: args => ({ case: { id: args.case_id, evaluation_eligible: false, status: "unverified_source_evidence" } }),
      craft_knowledge_evaluation_run: () => ({ run: { id: "run", metrics: { provenance_eligible: false } } }),
    });
    const result = await runSessionKnowledgeEvaluationOnce({ client: fixture.client, providers: [provider],
      transport: modelTransport(JSON.stringify({ decision: "labeled", expected_claim_ids: ["candidate-claim"] })),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.equal(result.status, "case_candidate_created"); assert.equal(result.evaluation_eligible, false);
    assert.equal(result.independent_adjudication_required, true); assert.equal(result.label_source, "model_candidate");
    const saved = fixture.calls.find(call => call.name === "craft_knowledge_evaluation_case_save")!;
    assert.deepEqual(saved.args.expected_claim_ids, ["candidate-claim"]);
    assert.deepEqual(saved.args.candidate_claim_refs, [{ claim_id: "candidate-claim", claim_version: 1,
      identity_digest: "candidate-identity", content_digest: "candidate-content" }]);
    const shadowRun = fixture.calls.find(call => call.name === "craft_knowledge_evaluation_run")!;
    assert.equal(shadowRun.args.mode, "candidate_shadow");
    assert.deepEqual(shadowRun.args.candidate_claim_ids, ["candidate-claim"]);
    assert.equal((saved.args.source_evidence_ids as string[]).length, 2);
    assert((saved.args.source_evidence_ids as string[]).includes("evidence-session-task"));
    assert.equal(saved.args.dataset_partition, "held_out"); assert.equal(saved.args.sanitized, true);
    assert.equal(saved.args.label_source, "model_candidate");
    const trace = fixture.calls.filter(call => call.name === "craft_trace_append");
    assert(trace.some(call => call.args.event_kind === "knowledge.evaluation_case_candidate"));
    assert((trace.at(-1)!.args.output_refs as string[]).includes("evidence-session-program"));
    assert.equal(JSON.stringify(trace).includes("本次已验证"), false);
    assert.equal((await runSessionKnowledgeEvaluationOnce({ client: fixture.client, providers: [provider], transport: modelTransport("{}"),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } })).status, "idle");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("held-out transcript evidence creates a separate evaluation case without mixing generation evidence", async () => {
  const f = await setup("held_out", false, false, true);
  try {
    const fixture = candidateClaimClient(f.task.project_scope_id, {
      craft_knowledge_evaluation_case_save: args => ({ case: { id: args.case_id, evaluation_eligible: false } }),
      craft_knowledge_evaluation_run: () => ({ run: { id: "run-session-test", metrics: { provenance_eligible: false } } }),
    });
    const result = await runSessionKnowledgeEvaluationOnce({ client: fixture.client, providers: [provider],
      transport: modelTransport(JSON.stringify({ decision: "labeled", expected_claim_ids: ["candidate-claim"] })),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.equal(result.status, "case_candidate_created");
    assert.equal(result.label_source, "model_candidate");
    assert.equal(result.trace_id, "trace-session-task");
    const state = JSON.parse(await readFile(f.workerState, "utf8")) as JsonObject;
    assert.equal((state.trace_ids_by_task as JsonObject)[String(f.task.task_id)], "trace-session-task");
    const saved = fixture.calls.find(call => call.name === "craft_knowledge_evaluation_case_save")!;
    assert.deepEqual(saved.args.source_evidence_ids, ["evidence-session-program"]);
    assert.equal(saved.args.dataset_partition, "held_out");
    assert.equal(saved.args.source_session_id, f.sessionId);
    assert.equal(fixture.calls.some(call => call.name === "craft_knowledge_session_evidence_record"), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("held-out task without successful test evidence does not call the model or create an evaluation case", async () => {
  const f = await setup("held_out", false);
  try {
    const fixture = workerClient(); let modelCalls = 0;
    const result = await runSessionKnowledgeEvaluationOnce({ client: fixture.client, providers: [provider],
      transport: { async complete() { modelCalls++; return { text: "{}", model: "test-model", usage: { input_tokens: 0, output_tokens: 0 } }; } },
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.deepEqual(result, { status: "skipped", processed: 1, reason: "verifiable_test_result_unavailable", raw_content_stored: false });
    assert.equal(modelCalls, 0);
    assert.equal(fixture.calls.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("held-out evaluation waits for current candidate Claims and rejects model labels outside the current candidate set", async () => {
  const f = await setup("held_out");
  try {
    const noClaims = workerClient({ craft_knowledge_claim_list: () => ({ claims: [] }) });
    assert.equal((await runSessionKnowledgeEvaluationOnce({ client: noClaims.client, providers: [provider], transport: modelTransport("{}"),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } })).status, "waiting_for_candidate_claims");
    const fixture = workerClient({
      craft_knowledge_claim_list: () => ({ claims: [{ id: "candidate-claim", status: "candidate", scope: f.task.project_scope_id }] }),
      craft_knowledge_semantic_review_packet: () => ({ status: "ready", claim_status: "candidate", packet: { claim: { id: "candidate-claim", version: 1,
        identity_digest: "candidate-identity", content_digest: "candidate-content", content: "稳定验证规则。" } } }),
    });
    await assert.rejects(runSessionKnowledgeEvaluationOnce({ client: fixture.client, providers: [provider], transport: modelTransport(
      JSON.stringify({ decision: "labeled", expected_claim_ids: ["not-candidate"] })), state_file: f.workerState,
      archive_options: { sessions_root: f.sessions, state_file: f.state } }), /selected from current candidate Claims/u);
    assert(fixture.calls.some(call => call.name === "craft_trace_finalize" && call.args.status === "failed"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("held-out evaluation records only terminal Trace references and leaves failed evidence work retryable", async () => {
  {
    const f = await setup("held_out");
    try {
      const fixture = workerClient(); let modelCalls = 0;
      const excerpt = await readCodexSessionTaskExcerpt(String(f.task.task_id), { sessions_root: f.sessions, state_file: f.state, expected_partition: "held_out" });
      const result = await runSessionKnowledgeEvaluationOnce({ client: fixture.client, providers: [provider],
        transport: { async complete() { modelCalls++; return { text: "{}", model: "test-model", usage: null }; } }, state_file: f.workerState,
        archive_options: { sessions_root: f.sessions, state_file: f.state }, read_excerpt: async () => ({ ...excerpt, verification_artifacts: undefined }) });
      assert.deepEqual(result, { status: "skipped", processed: 1, reason: "verifiable_test_result_unavailable", raw_content_stored: false });
      assert.equal(modelCalls, 0);
      const state = JSON.parse(await readFile(f.workerState, "utf8")) as JsonObject;
      assert.deepEqual(state.trace_ids_by_task, {});
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  {
    const f = await setup("held_out");
    try {
      const fixture = workerClient({ craft_knowledge_claim_list: () => ({ claims: [{ id: "candidate-claim", status: "candidate", scope: f.task.project_scope_id }] }),
        craft_knowledge_semantic_review_packet: () => ({ status: "ready", claim_status: "candidate", packet: { claim: { id: "candidate-claim", version: 1,
          identity_digest: "candidate-identity", content_digest: "candidate-content", content: "稳定规则" } } }) });
      const excerpt = await readCodexSessionTaskExcerpt(String(f.task.task_id), { sessions_root: f.sessions, state_file: f.state, expected_partition: "held_out" });
      const { task_goal: _taskGoal, ...missingGoal } = excerpt;
      await assert.rejects(runSessionKnowledgeEvaluationOnce({ client: fixture.client, providers: [provider],
        transport: { async complete() { return { text: JSON.stringify({ decision: "labeled", expected_claim_ids: ["candidate-claim"] }), model: "test-model", usage: null }; } }, state_file: f.workerState,
        archive_options: { sessions_root: f.sessions, state_file: f.state }, read_excerpt: async () => missingGoal }), /held-out test Evidence is unavailable/u);
      const state = JSON.parse(await readFile(f.workerState, "utf8"));
      assert.deepEqual(state.processed_task_ids, []);
      assert.deepEqual(state.trace_ids_by_task, {});
      assert.equal(state.last_attempted_task_id, f.task.task_id);
      assert(fixture.calls.some(call => call.name === "craft_trace_finalize" && call.args.status === "failed"));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("held-out evaluation is incremental across exact archive, readiness and source integrity gates", async () => {
  for (const changes of [{ project_scope_id: null }, { project_scope_id: "not-a-project-scope" }]) {
    const f = await setup("held_out");
    try { await mutateIndexedTask(f, changes); assert.equal((await evaluate(f, workerClient().client, modelTransport("{}"))).reason, "held_out_provenance_incomplete"); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  }
  {
    const f = await setup("held_out");
    try {
      await writeFile(f.source, "changed after verified indexing\n");
      assert.equal((await evaluate(f, workerClient().client, modelTransport("{}"))).reason, "held_out_excerpt_unavailable");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  {
    const f = await setup("held_out");
    try {
      await mkdir(join(f.root, "knowledge"), { recursive: true });
      await writeFile(f.workerState, JSON.stringify({ schema: "craft.knowledge-session-evaluation-state.v1", processed_task_ids: [f.task.task_id] }));
      assert.equal((await evaluate(f, workerClient().client, modelTransport("{}"))).status, "idle");
      await writeFile(f.workerState, "{}");
      await assert.rejects(evaluate(f, workerClient().client, modelTransport("{}")), /state is invalid/u);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  {
    const f = await setup("held_out");
    try {
      await mkdir(join(f.root, "knowledge"), { recursive: true });
      const target = join(f.root, "target-state.json"); await writeFile(target, "{}");
      await symlink(target, f.workerState);
      await assert.rejects(evaluate(f, workerClient().client, modelTransport("{}")), /state file is invalid/u);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  {
    const f = await setup("held_out");
    try {
      await mutateIndexedTask(f, { project_scope_id: null });
      const linked = join(f.root, "linked-knowledge"), target = join(f.root, "target-knowledge"); await mkdir(target);
      await symlink(target, linked);
      await assert.rejects(evaluate(f, workerClient().client, modelTransport("{}"), { state_file: join(linked, "state.json") }), /directory must not be a symbolic link/u);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("held-out evaluation waits safely for current candidate Claims, a ready profile, provider and Host budget", async () => {
  const defaultF = await setup("held_out");
  try {
    const defaultStateRoot = join(defaultF.root, "default-state-root");
    const defaultState = candidateClaimClient(defaultF.task.project_scope_id, { craft_knowledge_claim_list: () => ({ claims: [] }) });
    await mutateIndexedTask(defaultF, { project_scope_id: null });
    assert.equal((await evaluate(defaultF, defaultState.client, undefined, { state_file: undefined,
      env: { ...process.env, CRAFT_DATA_DIR: defaultStateRoot } })).reason, "held_out_provenance_incomplete");
    assert.equal((await readFile(join(defaultStateRoot, "knowledge", "session-evaluation-state.json"), "utf8")).includes("processed_task_ids"), true);
  } finally { await rm(defaultF.root, { recursive: true, force: true }); }
  const f = await setup("held_out");
  try {
    const filtered = workerClient({ craft_knowledge_claim_list: () => ({ claims: [
      { id: "other-project", status: "candidate", scope: "project:other" },
    ] }) });
    assert.equal((await evaluate(f, filtered.client, modelTransport("{}"))).status, "waiting_for_candidate_claims");
    const malformedList = workerClient({ craft_knowledge_claim_list: () => ({ claims: "bad" }) });
    assert.equal((await evaluate(f, malformedList.client, modelTransport("{}"))).status, "waiting_for_candidate_claims");
    const notReady = candidateClaimClient(f.task.project_scope_id, { craft_evaluation_model_profile_ensure_single: () => ({ status: "needs_enablement" }) });
    assert.equal((await evaluate(f, notReady.client, modelTransport("{}"))).status, "waiting_for_model");
    const missingProfile = candidateClaimClient(f.task.project_scope_id, { craft_evaluation_model_profile_ensure_single: () => ({ status: "ready_for_adapter" }) });
    assert.equal((await evaluate(f, missingProfile.client, modelTransport("{}"))).reason, "ready_for_adapter");
    const notReadyDetail = candidateClaimClient(f.task.project_scope_id, { craft_evaluation_model_profile_get: () => ({ readiness: {} }) });
    assert.equal((await evaluate(f, notReadyDetail.client, modelTransport("{}"))).reason, "model_profile_not_ready");
    const providerUnavailable = candidateClaimClient(f.task.project_scope_id);
    assert.equal((await evaluate(f, providerUnavailable.client, modelTransport("{}"), { providers: [] })).reason, "provider_unavailable");
    const builtinProviderUnavailable = candidateClaimClient(f.task.project_scope_id);
    assert.equal((await evaluate(f, builtinProviderUnavailable.client, modelTransport("{}"), { providers: undefined })).reason, "provider_unavailable");
    const providerFallback = candidateClaimClient(f.task.project_scope_id, { craft_evaluation_model_profile_get: () => ({ readiness: { status: "ready_for_adapter" }, provider }) });
    assert.equal((await evaluate(f, providerFallback.client, modelTransport(JSON.stringify({ decision: "skip", expected_claim_ids: [] })), { providers: [] })).reason, undefined,
      "a ready provider returned with its Host Profile is usable when the static catalog omits it");
    await rm(f.workerState, { force: true });
    const noTransport = candidateClaimClient(f.task.project_scope_id);
    assert.equal((await evaluate(f, noTransport.client)).reason, "model_transport_unavailable");
    const noBudget = candidateClaimClient(f.task.project_scope_id);
    const budgetTransport: ModelTransport = { acquireCall: () => false, async complete() { throw new Error("unreachable"); } };
    assert.equal((await evaluate(f, noBudget.client, budgetTransport)).reason, "model_call_budget_exhausted");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("held-out evaluation covers Codex output schema and safe retry diagnostics", async () => {
  for (const failure of ["private failure", Object.assign(new Error("private failure"), { name: "../../unsafe" })]) {
    const f = await setup("held_out");
    try {
      const claims = candidateClaimClient(f.task.project_scope_id, {
        craft_evaluation_model_profile_ensure_single: () => ({ status: "ready_for_adapter", profile: { id: "profile", version: 1, provider: "codex-cli", model: "gpt-6-luna" } }),
        craft_evaluation_model_profile_get: () => ({ readiness: { status: "ready_for_adapter" }, provider: { ...provider, provider: "codex-cli", host_managed_auth: true } as unknown as JsonObject }),
      });
      const transport: ModelTransport = { async complete(_spec, request): Promise<ChatResult> {
        assert.ok(request.body.codex_output_schema);
        throw failure;
      } };
      await assert.rejects(evaluate(f, claims.client, transport));
      const failed = claims.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.failed");
      assert.equal(failed?.args.data && (failed.args.data as JsonObject).failure_kind, "Error");
      assert.equal(claims.calls.some(call => call.name === "craft_trace_finalize" && call.args.status === "failed"), true);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }

  for (const metrics of [undefined, { provenance_eligible: true }]) {
    const f = await setup("held_out");
    try {
      const claims = candidateClaimClient(f.task.project_scope_id, {
        craft_knowledge_evaluation_case_save: args => ({ case: { id: args.case_id } }),
        craft_knowledge_evaluation_run: () => ({ run: { id: "run", metrics } }),
      });
      const result = await evaluate(f, claims.client, modelTransport(JSON.stringify({ decision: "labeled", expected_claim_ids: ["candidate-claim"] })));
      assert.equal(result.status, "case_candidate_created");
      assert.equal(result.evaluation_eligible, metrics?.provenance_eligible === true);
      assert.equal(result.independent_adjudication_required, true);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("held-out evaluator isolates exact Excerpt and candidate Claim identities", async () => {
  const f = await setup("held_out");
  const baseExcerpt = { status: "ready", session_id: f.task.session_id, turn_id: f.task.turn_id, project_scope_id: f.task.project_scope_id,
    evidence_ids: f.task.verification_evidence_ids } as JsonObject;
  try {
    for (const changes of [{ status: "ineligible" }, { session_id: "other" }, { turn_id: "other" }, { project_scope_id: "project:other" }, { evidence_ids: [] }]) {
      const result = await evaluate(f, workerClient().client, modelTransport("{}"), { read_excerpt: async () => ({ ...baseExcerpt, ...changes }) });
      assert.equal(result.reason, "held_out_excerpt_unavailable");
      await rm(f.workerState, { force: true });
    }
    const packetResults = [
      { status: "unavailable" },
      { status: "ready", packet: { claim: { id: "candidate-claim", content: "缺少当前状态。" } } },
      { status: "ready", claim_status: "revoked", packet: { claim: { id: "candidate-claim", status: "candidate", content: "旧状态不能覆盖撤销。" } } },
      { status: "ready", claim_status: "candidate", packet: { claim: { id: "other", content: "内容。" } } },
      { status: "ready", claim_status: "candidate", packet: { claim: { id: "candidate-claim", content: "内容。" } } },
      { status: "ready", claim_status: "candidate", packet: { claim: { id: "candidate-claim", content: " " } } },
    ];
    for (const packetResult of packetResults) {
      const claims = candidateClaimClient(f.task.project_scope_id, { craft_knowledge_semantic_review_packet: () => packetResult });
      assert.equal((await evaluate(f, claims.client, modelTransport("{}"))).status, "waiting_for_candidate_claims");
      await rm(f.workerState, { force: true });
    }
    const malformedPacket = candidateClaimClient(f.task.project_scope_id, { craft_knowledge_semantic_review_packet: () => ({ status: "ready", packet: [] }) });
    await assert.rejects(evaluate(f, malformedPacket.client, modelTransport("{}")), /candidate Claim packet must be an object/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("held-out evaluator records safe Trace failure for malformed profile and Trace receipts", async () => {
  const f = await setup("held_out");
  try {
    const noStatus = candidateClaimClient(f.task.project_scope_id, { craft_evaluation_model_profile_ensure_single: () => ({}) });
    assert.equal((await evaluate(f, noStatus.client, modelTransport("{}"))).reason, "model_profile_unavailable");
    const missingAction = candidateClaimClient(f.task.project_scope_id, { craft_evaluation_model_profile_get: () => ({ readiness: { status: "needs_enablement" } }) });
    assert.equal((await evaluate(f, missingAction.client, modelTransport("{}"))).reason, "model_profile_not_ready");
    const missingTraceId = candidateClaimClient(f.task.project_scope_id, { craft_trace_start: () => ({ trace: {} }) });
    await assert.rejects(evaluate(f, missingTraceId.client, modelTransport("{}")), /Trace has no id/u);
    let firstAppend = true;
    const appendClient = workerClient({
      craft_knowledge_claim_list: () => ({ claims: [{ id: "candidate-claim", status: "candidate", scope: f.task.project_scope_id }] }),
      craft_knowledge_semantic_review_packet: () => ({ status: "ready", claim_status: "candidate", packet: { claim: { id: "candidate-claim", version: 1,
        identity_digest: "candidate-identity", content_digest: "candidate-content", content: "有效内容" } } }),
      craft_trace_append: args => { if (firstAppend) { firstAppend = false; throw new Error("trace append unavailable"); } return {}; },
    });
    await assert.rejects(evaluate(f, appendClient.client, modelTransport("{}")), /trace append unavailable/u);
    assert(appendClient.calls.some(call => call.name === "craft_trace_finalize" && call.args.status === "failed"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("held-out evaluation handles valid skip labels and retries malformed model responses", async () => {
  const f = await setup("held_out");
  try {
    const claims = candidateClaimClient(f.task.project_scope_id);
    const skipped = await evaluate(f, claims.client, modelTransport(JSON.stringify({ decision: "skip", expected_claim_ids: [] })));
    assert.equal(skipped.status, "case_skipped"); assert.equal(skipped.case_id, null); assert.equal(skipped.evaluation_eligible, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
  const f2 = await setup("held_out");
  try {
    const invalid = candidateClaimClient(f2.task.project_scope_id);
    await assert.rejects(evaluate(f2, invalid.client, modelTransport("not-json")), /one JSON object/u);
    assert(invalid.calls.some(call => call.name === "craft_trace_finalize" && call.args.status === "failed"));
  } finally { await rm(f2.root, { recursive: true, force: true }); }
});

test("waits for model readiness without consuming the verified task", async () => {
  const f = await setup();
  try {
    const fixture = workerClient({ craft_evaluation_model_profile_ensure_single: () => ({ status: "needs_enablement", reason: "needs_enablement" }) });
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport("{}"),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.deepEqual(result, { status: "waiting_for_model", processed: 0, reason: "needs_enablement", raw_content_stored: false });
    await assert.rejects(readFile(f.workerState, "utf8"), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("records an explicit no-candidate decision without creating a Claim", async () => {
  const f = await setup();
  try {
    const fixture = workerClient();
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport(
      JSON.stringify({ decision: "skip", kind: "fact", title: "", content: "", tags: [] })), state_file: f.workerState,
      archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.equal(result.status, "candidate_skipped");
    assert.equal(fixture.calls.some(call => call.name === "craft_knowledge_claim_save"), false);
    assert.equal(fixture.calls.some(call => call.name === "craft_trace_finalize"), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects malformed or sensitive model candidates without advancing the task", async () => {
  for (const output of ["not json", JSON.stringify({ decision: "candidate", kind: "fact", title: "凭据", content: "api_key=abcdefghijklmnop", tags: [] })]) {
    const f = await setup();
    try {
      const fixture = workerClient();
      await assert.rejects(runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport(output),
        state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } }));
      await assert.rejects(readFile(f.workerState, "utf8"), { code: "ENOENT" });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("rejects a symlinked candidate state and invalid result structures", async () => {
  const f = await setup();
  try {
    await mkdir(join(f.root, "other"));
    await mkdir(join(f.root, "knowledge"));
    const linked = join(f.root, "knowledge", "link.json");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(f.root, "other"), linked);
    const fixture = workerClient();
    await assert.rejects(runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport("{}"), state_file: linked,
      archive_options: { sessions_root: f.sessions, state_file: f.state } }), /state file is invalid/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects malformed candidate state and refuses a symlinked state directory", async () => {
  const f = await setup();
  try {
    const fixture = workerClient();
    await mkdir(join(f.root, "knowledge"), { recursive: true });
    await writeFile(f.workerState, JSON.stringify({ schema: "wrong", processed_task_ids: [] }));
    await assert.rejects(runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport("{}"),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } }), /state is invalid/u);

    await writeFile(f.workerState, JSON.stringify({ schema: "craft.knowledge-session-candidate-state.v1", processed_task_ids: [], terminal_skips: { malformed: null } }));
    await assert.rejects(runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport("{}"),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } }), /state is invalid/u);

    const index = JSON.parse(await readFile(f.state, "utf8")) as JsonObject;
    const task = Object.values(index.tasks as Record<string, JsonObject>)[0]!;
    task.project_scope_id = null;
    await writeFile(f.state, JSON.stringify(index));
    const target = join(f.root, "target"); await mkdir(target);
    const parentLink = join(f.root, "knowledge-link");
    const { symlink } = await import("node:fs/promises");
    await symlink(target, parentLink);
    await assert.rejects(runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], state_file: join(parentLink, "state.json"),
      archive_options: { sessions_root: f.sessions, state_file: f.state } }), /must not be a symbolic link/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("skips a verified task missing project evidence metadata and returns bounded legacy task refs", async () => {
  const f = await setup();
  try {
    const index = JSON.parse(await readFile(f.state, "utf8")) as JsonObject;
    const task = Object.values(index.tasks as Record<string, JsonObject>)[0]!;
    delete task.context_receipt_id; delete task.verification_ref_digest; delete task.terminal_identity_digest;
    await writeFile(f.state, JSON.stringify(index));
    const batch = await codexSessionTaskBatch("candidate_generation", { state_file: f.state });
    assert.equal((batch.tasks as JsonObject[])[0]?.context_receipt_id, null);
    assert.equal((batch.tasks as JsonObject[])[0]?.verification_ref_digest, null);
    assert.equal((batch.tasks as JsonObject[])[0]?.terminal_identity_digest, null);
    const fixture = workerClient();
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, state_file: f.workerState,
      archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.deepEqual(result, { status: "skipped", processed: 1, reason: "verified_project_evidence_incomplete", raw_content_stored: false });
    assert.equal(fixture.calls.length, 0);
    const saved = JSON.parse(await readFile(f.workerState, "utf8")) as JsonObject;
    assert.deepEqual(saved.processed_task_ids, [f.task.task_id]);
    assert.equal(((saved.terminal_skips as Record<string, JsonObject>)[String(f.task.task_id)]!).reason_code,
      "verified_project_evidence_incomplete");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("skips a source that changes after indexing and leaves a content-free cursor", async () => {
  const f = await setup();
  try {
    const file = join(f.sessions, "session.jsonl");
    const current = await readFile(file, "utf8");
    await writeFile(file, current.replace("单测并检查锁文件", "单测并核对锁文件"));
    const fixture = workerClient();
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport("{}"),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.deepEqual(result, { status: "skipped", processed: 1, reason: "verified_task_excerpt_unavailable", raw_content_stored: false });
    assert.equal(fixture.calls.length, 0);
    const saved = JSON.parse(await readFile(f.workerState, "utf8")) as JsonObject;
    assert.deepEqual(saved.processed_task_ids, [f.task.task_id]);
    assert.equal(((saved.terminal_skips as Record<string, JsonObject>)[String(f.task.task_id)]!).reason_code,
      "verified_task_excerpt_unavailable");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("keeps pending tasks when model profile, provider, or shared call budget is unavailable", async () => {
  const scenarios: Array<{ client: Record<string, (args: JsonObject) => JsonObject>; providers?: readonly ModelProviderSpec[]; expected: string }> = [
    { client: { craft_evaluation_model_profile_get: () => ({ readiness: { status: "not_ready", next_action: "set_profile" } }) }, expected: "set_profile" },
    { client: { craft_evaluation_model_profile_get: () => ({ readiness: { status: "not_ready" } }) }, expected: "model_profile_not_ready" },
    { client: { craft_evaluation_model_profile_ensure_single: () => ({ status: "not_ready" }) }, expected: "model_profile_not_ready" },
    { client: { craft_evaluation_model_profile_ensure_single: () => ({ status: "ready_for_adapter" }) }, expected: "model_profile_unavailable" },
    { client: {}, providers: [], expected: "provider_unavailable" },
  ];
  for (const scenario of scenarios) {
    const f = await setup();
    try {
      const fixture = workerClient(scenario.client);
      const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: scenario.providers ?? [provider], transport: modelTransport("{}"),
        state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
      assert.equal(result.status, "waiting_for_model"); assert.equal(result.reason, scenario.expected);
      await assert.rejects(readFile(f.workerState, "utf8"), { code: "ENOENT" });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  const f = await setup();
  try {
    const fixture = workerClient();
    const budgetTransport: ModelTransport = { acquireCall: () => false, async complete() { throw new Error("must not call model"); } };
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: budgetTransport,
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.equal(result.status, "waiting_for_budget");
    assert.equal(fixture.calls.some(call => call.name === "craft_trace_start"), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("supports a provider returned with its ready Host Profile and sets structured output for Codex CLI", async () => {
  const f = await setup();
  try {
    const hostProvider = { ...provider, provider: "codex-cli", host_managed_auth: true } as ModelProviderSpec;
    const fixture = workerClient({ craft_evaluation_model_profile_ensure_single: () => ({ status: "ready_for_adapter",
      profile: { id: "profile", version: 1, provider: "codex-cli", model: "host-model" } }),
    craft_evaluation_model_profile_get: () => ({ readiness: { status: "ready_for_adapter" }, provider: hostProvider as unknown as JsonObject }) });
    let schema: unknown;
    const transport: ModelTransport = { async complete(_spec, request): Promise<ChatResult> {
      schema = request.body.codex_output_schema;
      return { text: JSON.stringify({ decision: "skip", kind: "fact", title: "", content: "", tags: [] }), model: "host-model", usage: { input_tokens: 1, output_tokens: 1 } };
    } };
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, transport, providers: [], state_file: f.workerState,
      archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.equal(result.status, "candidate_skipped");
    assert.deepEqual(schema, { type: "object", properties: {
      decision: { type: "string", enum: ["candidate", "skip"] }, kind: { type: "string", enum: ["fact", "rule", "decision", "term", "failure_mode"] },
      title: { type: "string", maxLength: 160 }, content: { type: "string", maxLength: 2_000 }, tags: { type: "array", items: { type: "string", maxLength: 48 }, maxItems: 8 },
    }, required: ["decision", "kind", "title", "content", "tags"], additionalProperties: false });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("uses Craft data root and built-in Host provider defaults, and waits when no transport is available", async () => {
  const f = await setup();
  try {
    const data = join(f.root, "craft-data");
    const fixture = workerClient({ craft_evaluation_model_profile_ensure_single: () => ({ status: "ready_for_adapter",
      profile: { id: "profile", version: 1, provider: "codex-cli", model: "gpt-6-luna" } }) });
    const defaultTransport: ModelTransport = { async complete(spec, request): Promise<ChatResult> {
      assert.equal(spec.provider, "codex-cli");
      assert.ok(request.body.codex_output_schema);
      return { text: JSON.stringify({ decision: "skip", kind: "fact", title: "", content: "", tags: [] }), model: "gpt-6-luna", usage: { input_tokens: 1, output_tokens: 1 } };
    } };
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, transport: defaultTransport, env: { CRAFT_DATA_DIR: data },
      archive_options: { sessions_root: f.sessions, state_file: f.state } });
    assert.equal(result.status, "candidate_skipped");
    assert.equal((await readFile(join(data, "knowledge", "session-candidate-state.json"), "utf8")).includes(String(f.task.task_id)), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }

  const missingTransport = await setup();
  try {
    const fixture = workerClient({ craft_evaluation_model_profile_ensure_single: () => ({ status: "ready_for_adapter",
      profile: { id: "profile", version: 1, provider: "test", model: "test-model" } }) });
    const result = await runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], state_file: missingTransport.workerState,
      archive_options: { sessions_root: missingTransport.sessions, state_file: missingTransport.state } });
    assert.deepEqual(result, { status: "waiting_for_model", processed: 0, reason: "model_transport_unavailable", raw_content_stored: false });
  } finally { await rm(missingTransport.root, { recursive: true, force: true }); }
});

test("rejects invalid structured candidates and malformed Trace responses", async () => {
  const invalidOutputs = ["[]", JSON.stringify({ decision: "unknown", kind: "fact", title: "标题", content: "正文足够长。", tags: [] }),
    JSON.stringify({ decision: "candidate", kind: "other", title: "标题", content: "正文足够长。", tags: [] }),
    JSON.stringify({ decision: "candidate", kind: "fact", title: "", content: "正文足够长。", tags: [] }),
    JSON.stringify({ decision: "candidate", kind: "fact", title: "标题", content: "正文足够长。", tags: "invalid" })];
  for (const output of invalidOutputs) {
    const f = await setup();
    try {
      const fixture = workerClient();
      await assert.rejects(runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport(output),
        state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } }));
      await assert.rejects(readFile(f.workerState, "utf8"), { code: "ENOENT" });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  const f = await setup();
  try {
    const fixture = workerClient({ craft_trace_start: () => ({ trace: {} }) });
    await assert.rejects(runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport: modelTransport("{}"),
      state_file: f.workerState, archive_options: { sessions_root: f.sessions, state_file: f.state } }), /Trace has no id/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("records a sanitized failed Trace and leaves the task available for retry", async () => {
  for (const errorName of ["TypeError", "private/path"]) {
    const f = await setup();
    try {
      const fixture = workerClient();
      const failure = new Error("private provider response"); failure.name = errorName;
      const transport: ModelTransport = { async complete() { throw failure; } };
      await assert.rejects(runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport, state_file: f.workerState,
        archive_options: { sessions_root: f.sessions, state_file: f.state } }));
      const failureEvent = fixture.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.failed");
      assert.equal((failureEvent?.args.data as JsonObject).failure_kind, errorName === "TypeError" ? "TypeError" : "Error");
      assert.equal(JSON.stringify(fixture.calls).includes("private provider response"), false);
      assert.equal(fixture.calls.some(call => call.name === "craft_trace_finalize" && call.args.status === "failed"), true);
      await assert.rejects(readFile(f.workerState, "utf8"), { code: "ENOENT" });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  const missingEvidenceCase = await setup();
  try {
    const missingEvidence = workerClient();
    await assert.rejects(runSessionKnowledgeCandidateOnce({ client: missingEvidence.client, providers: [provider],
      transport: modelTransport(JSON.stringify({ decision: "candidate", kind: "rule", title: "依赖升级验证", content: "依赖升级后运行单测并检查锁文件。", tags: [] })),
      record_verification_evidence: async () => null,
      state_file: missingEvidenceCase.workerState, archive_options: { sessions_root: missingEvidenceCase.sessions, state_file: missingEvidenceCase.state } }), /verified test Evidence is unavailable/u);
    assert.equal(missingEvidence.calls.some(call => call.name === "craft_trace_finalize" && call.args.status === "failed"), true);
    await assert.rejects(readFile(missingEvidenceCase.workerState, "utf8"), { code: "ENOENT" });
  } finally { await rm(missingEvidenceCase.root, { recursive: true, force: true }); }
  const f = await setup();
  try {
    const fixture = workerClient();
    const transport: ModelTransport = { async complete() { throw "private string failure"; } };
    await assert.rejects(runSessionKnowledgeCandidateOnce({ client: fixture.client, providers: [provider], transport, state_file: f.workerState,
      archive_options: { sessions_root: f.sessions, state_file: f.state } }));
    const failureEvent = fixture.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.failed");
    assert.equal((failureEvent?.args.data as JsonObject).failure_kind, "Error");
    assert.equal(JSON.stringify(fixture.calls).includes("private string failure"), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test("held-out tasks rotate past waiting projects without discarding pending work", async () => {
  const f = await setup("held_out", false, false, true);
  try {
    let secondSession = "held-out-fairness";
    while (Number.parseInt(createHash("sha256").update(secondSession).digest("hex").slice(0, 8), 16) % 5 !== 0) secondSession += "x";
    const second = (await readFile(f.source, "utf8")).replaceAll(f.sessionId, secondSession);
    await writeFile(join(f.sessions, "second.jsonl"), second);
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    const batch = await codexSessionTaskBatch("held_out", { state_file: f.state });
    const tasks = batch.tasks as JsonObject[];
    assert.equal(tasks.length, 2);
    const noClaims = workerClient({ craft_knowledge_claim_list: () => ({ claims: [] }) });
    const waiting = await evaluate(f, noClaims.client);
    assert.equal(waiting.status, "waiting_for_candidate_claims", JSON.stringify(waiting));
    let state = JSON.parse(await readFile(f.workerState, "utf8"));
    assert.equal(state.last_attempted_task_id, tasks[0]!.task_id);
    assert.deepEqual(state.processed_task_ids, []);
    const ready = candidateClaimClient(f.task.project_scope_id);
    const result = await evaluate(f, ready.client, modelTransport('{"decision":"skip","expected_claim_ids":[]}'));
    assert.equal(result.task_id, tasks[1]!.task_id);
    assert.equal(result.status, "case_skipped");
    state = JSON.parse(await readFile(f.workerState, "utf8"));
    assert.deepEqual(state.processed_task_ids, [tasks[1]!.task_id]);
    assert.equal((await evaluate(f, noClaims.client)).status, "waiting_for_candidate_claims");
    assert.equal(JSON.parse(await readFile(f.workerState, "utf8")).last_attempted_task_id, tasks[0]!.task_id);
    assert.equal(ready.calls.filter(call => call.name === "craft_trace_start").length, 1);
    assert.equal(noClaims.calls.some(call => call.name === "craft_evaluation_model_profile_ensure_single"), false);
    for (const cursor of [null, 1, "", " ", "x".repeat(161)]) {
      await writeFile(f.workerState, JSON.stringify({ schema: "craft.knowledge-session-evaluation-state.v1", processed_task_ids: [], last_attempted_task_id: cursor }));
      await assert.rejects(evaluate(f, noClaims.client), /state is invalid/u);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
