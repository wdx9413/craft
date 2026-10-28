import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, default as test } from "node:test";
import type { ChatResult, ModelProviderSpec, ModelTransport } from "../core/model-gateway.ts";
import { PROVIDER_CATALOG } from "../core/model-gateway.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { McpStdioClient, boundedPollInterval, learningComponents, learningMcpRequestTimeoutMs, learningPollInterval, learningWorkFound, mcpCommandOptions, runDistillationOnce, runEvaluationOnce, runLearningTick, runOnce, type ExperienceLearningClient } from "../deploy/experience-learning/worker.ts";
import { CRAFT_RELEASE_VERSION } from "../core/version.ts";
import { learningFailureKind, learningTickStatus } from "../deploy/experience-learning/learning-tick.ts";

test("reports unknown Experience classification results in continuous and one-shot runs", () => {
  const result = { scenario_classification: { processed: 1, reconciliation_pending: true } };
  const diagnostics = "Craft Experience classification requires reconciliation (model_result_unknown).\n";
  assert.deepEqual(learningTickStatus(result, false), { diagnostics, exit_code: null });
  assert.deepEqual(learningTickStatus(result, true), { diagnostics, exit_code: 1 });
  assert.match(learningTickStatus({ scenario_classification: { reconciliation_pending: true, reconciliation_checkpoint_failed: true } }, true).diagnostics,
    /checkpoint could not be saved or verified/u);
});
import { acquireLearningWorkerLocks } from "../core/interfaces/learning-worker-supervisor.ts";

const provider: ModelProviderSpec = { provider: "test", label: "test", protocol: "openai-compatible", base_url: "https://example.invalid/v1",
  api_key_env: "TEST_KEY", chat_path: "/chat/completions", models: { standard: "test-model" }, cost_hint: 0, supports_tools: false };
const directWorkerDataDir = mkdtempSync(join(tmpdir(), "craft-learning-worker-unit-data-"));
const directWorkerEnv = { ...process.env, CRAFT_DATA_DIR: directWorkerDataDir };
after(() => rmSync(directWorkerDataDir, { recursive: true, force: true }));

function fixture(modelText = JSON.stringify({ name: "Verified flow", description: "A bounded verified flow", inputs: ["project_root"],
  steps: [{ id: "inspect", type: "assertion", evaluator: "file_exists", path: ".", side_effect: "read_only" }] })) {
  const calls: Array<{ name: string; args: JsonObject }> = [];
  const systemPrompts: string[] = [];
  let queued = true;
  const client: ExperienceLearningClient = { async call(name, args = {}) {
    calls.push({ name, args });
    if (name === "craft_evaluation_model_ticket_list") return { tickets: queued ? [{ id: "ticket-1", purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
      target: { kind: "workflow_evolution_request", id: "request-1", version: 1 }, readiness: { status: "ready_for_adapter" } }] : [] };
    if (name === "craft_evaluation_model_profile_get") return { profile: { provider: "test", model: "test-model", version: 1, max_attempts: 1, max_output_tokens: 512, temperature: 0 }, readiness: { status: "ready_for_adapter" } };
    if (name === "craft_experience_learning_request_get") return { request: { id: "request-1", version: 1, lifecycle: "awaiting_model", procedure_kind: "workflow", scenario_key: "build-check", hypothesis: "Distill a reusable Workflow. Summary: repair TypeScript validation. Applies when: a code change requires a focused test. Excludes: documentation-only work.", design_axes: ["orchestration"], output_contract_ref: "acceptance:build" },
      observations: [{ outcome: "passed", sanitized: true, content_stored: false, execution_shape: ["inspect", "verify"], verification: { outcome: "passed" } },
        { outcome: "passed", sanitized: true, content_stored: false, execution_shape: ["inspect", "verify"], verification: { outcome: "passed" } }] };
    if (name === "craft_trace_start") return { trace: { id: "trace-1" } };
    if (name === "craft_trace_append") return { event: { id: `event-${calls.length}` } };
    if (name === "craft_trace_finalize") return { trace: { id: args.trace_id, status: args.status } };
    if (name === "craft_experience_procedure_submit") { queued = false; return { proposal: { id: "proposal-1" }, procedure: { id: "procedure-1" } }; }
    if (name === "craft_evaluation_model_ticket_complete") return { ticket: { id: args.ticket_id, status: "completed" } };
    if (name === "craft_experience_learning_evaluation_dispatch") return { dispatch: { id: "dispatch-1", stage: "shadow" } };
    throw new Error(`unexpected tool ${name}`);
  } };
  const transport: ModelTransport = { async complete(_spec, request): Promise<ChatResult> {
    const systemMessage = request.body.messages instanceof Array ? request.body.messages[0] as JsonObject : {};
    systemPrompts.push(String(systemMessage.content));
    const userMessage = request.body.messages instanceof Array ? request.body.messages[1] as JsonObject : {};
    assert.match(String(userMessage.content), /build-check/u);
    assert.match(String(userMessage.content), /repair TypeScript validation/u);
    assert.match(String(userMessage.content), /documentation-only work/u);
    return { text: modelText, model: "test-model", usage: { input_tokens: 10, output_tokens: 20 } };
  } };
  return { client, transport, calls, systemPrompts };
}

function emptySessionCollection(dataDir: string) {
  return { status: "source_unavailable", sessions_seen: 0, sessions_pending: 0, sessions_processed: 0, bytes_processed: 0,
    tasks_indexed: 0, tasks_completed: 0, tasks_aborted: 0, tasks_candidate_generation: 0, tasks_held_out: 0, tasks_with_user_input: 0, tasks_verified: 0, tasks_with_test_evidence: 0, malformed_lines: 0,
    raw_content_stored: false, state_file: join(dataDir, "runtime", "codex-session-collection.json") };
}

test("distillation worker turns a ready ticket into a candidate and retries from the queue idempotently", async () => {
  const f = fixture();
  const deps = { client: f.client, providers: [provider], transport: f.transport };
  const first = await runDistillationOnce(deps);
  assert.equal(first.processed, 1);
  assert.deepEqual((first.outcomes as JsonObject[])[0], { ticket_id: "ticket-1", request_id: "request-1", trace_id: "trace-1", status: "candidate_submitted", proposal_id: "proposal-1", procedure_id: "procedure-1", evaluation_dispatch_id: "dispatch-1", evaluation_stage: "shadow" });
  const submit = f.calls.find(call => call.name === "craft_experience_procedure_submit");
  assert.ok(submit);
  assert.equal(submit.args.model_ticket_id, "ticket-1");
  assert.equal(submit.args.workflow_id, "experience_" + (await import("../core/digest.ts")).stableDigest("request-1").slice(-20));
  assert.equal(submit.args.inputs instanceof Array && submit.args.inputs[0], "project_root");
  const completion = f.calls.find(call => call.name === "craft_evaluation_model_ticket_complete");
  assert.equal(completion?.args.ticket_id, "ticket-1");
  assert.equal(completion?.args.trace_id, "trace-1");
  assert.match(String(completion?.args.result_digest), /^sha256:[a-f0-9]{64}$/u);
  const traceEvents = f.calls.filter(call => call.name === "craft_trace_append").map(call => call.args.event_kind);
  assert.deepEqual(traceEvents, ["model.request", "model.completed", "experience.candidate_submitted", "experience.evaluation_dispatched"]);
  const submissionIndex = f.calls.findIndex(call => call.name === "craft_experience_procedure_submit");
  const dispatchIndex = f.calls.findIndex(call => call.name === "craft_experience_learning_evaluation_dispatch");
  const completionIndex = f.calls.findIndex(call => call.name === "craft_evaluation_model_ticket_complete");
  assert.ok(submissionIndex < dispatchIndex && dispatchIndex < completionIndex, "the Ticket completes only after candidate submission and evaluation dispatch");
  assert.deepEqual(f.calls.find(call => call.name === "craft_trace_finalize")?.args, { trace_id: "trace-1", status: "completed", summary: "Experience 流程候选提交与评测分发完成" });
  assert.equal((await runDistillationOnce(deps)).processed, 0);
  assert.equal(f.calls.filter(call => call.name === "craft_experience_procedure_submit").length, 1);
});

test("distillation records a safe failed Trace and leaves the model Ticket retryable", async () => {
  const f = fixture();
  const transport: ModelTransport = { async complete() { throw Object.assign(new Error("private model response"), { name: "TransportError" }); } };
  await assert.rejects(runDistillationOnce({ client: f.client, providers: [provider], transport }), /private model response/u);
  const failure = f.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.failed");
  const data = failure?.args.data as JsonObject;
  assert.equal(data.failure_kind, "TransportError");
  assert.equal(data.failure_stage, "model_request");
  assert.match(String(data.input_digest), /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(failure), /private model response/u);
  assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_ticket_complete"), false);
  assert.deepEqual(f.calls.find(call => call.name === "craft_trace_finalize")?.args, { trace_id: "trace-1", status: "failed", summary: "Experience 流程候选链路未完成" });
});

test("distillation requires a Trace ID before calling the model", async () => {
  const f = fixture();
  let modelCalls = 0;
  const client: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_trace_start") return { trace: {} };
    return f.client.call(name, args);
  } };
  const transport: ModelTransport = { async complete() { modelCalls += 1; return { text: "{}", model: "test-model", usage: null }; } };
  await assert.rejects(runDistillationOnce({ client, providers: [provider], transport }), /Trace has no id/u);
  assert.equal(modelCalls, 0);
  assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_ticket_complete"), false);
});

test("distillation marks Codex Host calls in Trace and tolerates sparse dispatch metadata", async () => {
  const f = fixture();
  const codexProvider = PROVIDER_CATALOG.find(item => item.provider === "codex-cli")!;
  const client: ExperienceLearningClient = { async call(name, args = {}) {
    if (name === "craft_evaluation_model_profile_get") return { profile: { provider: "codex-cli", model: "gpt-6-luna", version: 1,
      max_attempts: 1, max_output_tokens: 512, temperature: 0 }, readiness: { status: "ready_for_adapter" } };
    if (name === "craft_experience_learning_evaluation_dispatch") return { dispatch: {} };
    return f.client.call(name, args);
  } };
  const result = await runDistillationOnce({ client, providers: [codexProvider], transport: f.transport });
  assert.equal(((result.outcomes as JsonObject[])[0]!).trace_id, "trace-1");
  const request = f.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.request");
  assert.equal(request?.args.source, "codex-cli-learning-transport");
  const evaluationEvent = f.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "experience.evaluation_dispatched");
  assert.deepEqual(evaluationEvent?.args.data, { evaluation_dispatch_id: null, evaluation_stage: null });
  const completion = f.calls.find(call => call.name === "craft_evaluation_model_ticket_complete");
  assert.equal(completion?.args.trace_id, "trace-1");
});

test("Experience Workflow prose follows the configured output language", async () => {
  const f = fixture();
  await runDistillationOnce({ client: f.client, providers: [provider], transport: f.transport, contentLanguage: "en-US" });
  assert.match(f.systemPrompts[0] ?? "", /English \(en-US\)/u);
});

test("distillation completion binds a content-free digest when the adapter omits proposal metadata", async () => {
  const f = fixture();
  const client: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_experience_procedure_submit") return { procedure: { id: "procedure-no-proposal" } };
    return f.client.call(name, args);
  } };
  const result = await runDistillationOnce({ client, providers: [provider], transport: f.transport });
  assert.equal(((result.outcomes as JsonObject[])[0]!).status, "candidate_submitted");
  const complete = f.calls.find(call => call.name === "craft_evaluation_model_ticket_complete");
  assert.match(String(complete?.args.result_digest), /^sha256:[a-f0-9]{64}$/u);
});

test("evaluation worker drains ordered dispatches and stops on an unconfigured scenario", async () => {
  const calls: string[] = [];
  const client: ExperienceLearningClient = { async call(name, args = {}) {
    calls.push(name);
    if (name === "craft_experience_learning_evaluation_dispatch_list") return { dispatches: [{ id: "shadow", stage: "shadow" }] };
    if (name === "craft_experience_learning_evaluation_run" && args.dispatch_id === "shadow") return {
      dispatch: { id: "shadow", status: "passed" }, next_dispatch: { id: "heldout", stage: "held_out" },
    };
    if (name === "craft_experience_learning_evaluation_run" && args.dispatch_id === "heldout") return {
      dispatch: { id: "heldout", status: "awaiting_adapter" }, status: "awaiting_adapter", reason: "project_scenario_evaluator_not_configured",
    };
    throw new Error(`unexpected tool ${name}`);
  } };
  const result = await runEvaluationOnce(client);
  assert.deepEqual(result, { processed: 2, outcomes: [
    { dispatch_id: "shadow", stage: "shadow", status: "passed" },
    { dispatch_id: "heldout", stage: "held_out", status: "awaiting_adapter", reason: "project_scenario_evaluator_not_configured" },
  ] });
  assert.deepEqual(calls, ["craft_experience_learning_evaluation_dispatch_list", "craft_experience_learning_evaluation_run", "craft_experience_learning_evaluation_run"]);
});

test("evaluation worker ignores duplicate dispatches and uses safe result fallbacks", async () => {
  const seenCalls: string[] = [];
  const client: ExperienceLearningClient = { async call(name) {
    seenCalls.push(name);
    if (name === "craft_experience_learning_evaluation_dispatch_list") return { dispatches: [{ id: "same", stage: "shadow" }] };
    return { dispatch: {}, current: {}, next_dispatch: { id: "same", stage: "shadow" } };
  } };
  assert.deepEqual(await runEvaluationOnce(client), { processed: 1, outcomes: [
    { dispatch_id: "same", stage: "shadow", status: "unknown", current_procedure_id: null },
  ] });
  assert.deepEqual(seenCalls, ["craft_experience_learning_evaluation_dispatch_list", "craft_experience_learning_evaluation_run"]);
  assert.deepEqual(await runEvaluationOnce({ async call() { return { dispatches: [] }; } }), { processed: 0, outcomes: [] });
  await assert.rejects(runEvaluationOnce({ async call() { return { dispatches: [{ id: " " }] }; } }), /dispatch\.id/u);
  await assert.rejects(runEvaluationOnce({ async call() { return { dispatches: null }; } }), /must be an array/u);
});

test("distillation handles missing provider outputs and sparse sanitized evidence safely", async () => {
  const f = fixture();
  const dynamicProvider = { provider: "dynamic", protocol: "openai-compatible", api_key_env: "DYNAMIC_KEY", base_url: "https://example.invalid/v1",
    models: { standard: "dynamic-model" }, supports_tools: false } as unknown as JsonObject;
  const client: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_evaluation_model_profile_get") return { profile: { provider: "dynamic", model: "dynamic-model" }, readiness: { status: "ready_for_adapter" }, provider: dynamicProvider };
    if (name === "craft_experience_learning_request_get") return { request: { id: "request-1", version: 1, lifecycle: "awaiting_model", procedure_kind: "workflow",
      hypothesis: "bounded observations", design_axes: [], output_contract_ref: "contract" }, observations: [
      { outcome: "failed", sanitized: true, content_stored: false, failure_type: "assertion", execution_shape: ["inspect"], verification: null },
      { outcome: "passed", sanitized: true, content_stored: false, verification: { contract_ref: "contract", producer: "fixture", exit_code: 0 } },
    ] };
    if (name === "craft_experience_procedure_submit") return { proposal: {} };
    return f.client.call(name, args);
  } };
  const sparseTransport: ModelTransport = { async complete(_spec, request): Promise<ChatResult> {
    assert.equal(request.body.max_tokens, 4_096, "missing profile budgets must use the bounded default");
    const userMessage = request.body.messages instanceof Array ? request.body.messages[1] as JsonObject : {};
    const observations = JSON.parse(String(userMessage.content)).observations as JsonObject[];
    assert.equal((observations[0].verification as unknown), null);
    assert.equal((observations[0].failure_type as string), "assertion");
    assert.deepEqual(observations[1].verification, { contract_ref: "contract", producer: "fixture", exit_code: 0 });
    return { text: "```json\n{\"name\":\"Sparse result\",\"description\":\"No executable procedure returned\",\"inputs\":[],\"steps\":[{\"id\":\"inspect\",\"type\":\"assertion\",\"evaluator\":\"file_exists\",\"path\":\".\",\"side_effect\":\"read_only\"}]}\n```", model: "dynamic-model", usage: null };
  } };
  const result = await runDistillationOnce({ client, transport: sparseTransport });
  assert.deepEqual(result.outcomes, [{ ticket_id: "ticket-1", request_id: "request-1", trace_id: "trace-1", status: "candidate_submitted", proposal_id: null,
    procedure_id: null, evaluation_dispatch_id: null, evaluation_stage: null }]);

  const unavailable: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_evaluation_model_ticket_list") return { tickets: [{ id: "foreign", purpose: "other", target: { kind: "other" }, readiness: { status: "ready_for_adapter" } },
      { id: "wrong-target", purpose: "workflow_evolution", target: { kind: "other" }, readiness: { status: "ready_for_adapter" } }] };
    return f.client.call(name, args);
  } };
  assert.deepEqual(await runDistillationOnce({ client: unavailable, providers: [], transport: f.transport }), { processed: 0, outcomes: [] });

  const noProvider: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_evaluation_model_profile_get") return { profile: { provider: "not-in-catalog", model: "model" }, readiness: { status: "ready_for_adapter" } };
    return f.client.call(name, args);
  } };
  const noProviderResult = await runDistillationOnce({ client: noProvider, providers: [], transport: f.transport });
  assert.deepEqual(noProviderResult.outcomes, [{ ticket_id: "ticket-1", status: "skipped", reason: "provider_unavailable" }]);

  const noNextAction: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_evaluation_model_profile_get") return { profile: { provider: "test", model: "test-model" }, readiness: { status: "needs_credential" } };
    return f.client.call(name, args);
  } };
  const noNextActionResult = await runDistillationOnce({ client: noNextAction, providers: [provider], transport: f.transport });
  assert.deepEqual(noNextActionResult.outcomes, [{ ticket_id: "ticket-1", status: "skipped", reason: "profile_not_ready" }]);
});

test("distillation enforces request, observation and model input bounds before submission", async () => {
  const f = fixture();
  const withRequest = (request: JsonObject, observations: JsonObject[]) => ({ async call(name: string, args?: JsonObject) {
    if (name === "craft_experience_learning_request_get") return { request, observations };
    return f.client.call(name, args);
  } }) satisfies ExperienceLearningClient;
  const baseRequest = { id: "request-1", version: 1, lifecycle: "awaiting_model", procedure_kind: "workflow", scenario_key: "scenario" };
  const validObservations = [{ outcome: "passed", sanitized: true, content_stored: false }, { outcome: "passed", sanitized: true, content_stored: false }];
  await assert.rejects(runDistillationOnce({ client: withRequest(baseRequest, validObservations.slice(0, 1)), providers: [provider], transport: f.transport }), /at least two/u);
  await assert.rejects(runDistillationOnce({ client: withRequest({ ...baseRequest, hypothesis: "h".repeat(12_100) }, validObservations), providers: [provider], transport: f.transport }), /input limit/u);
  await assert.rejects(runDistillationOnce({ client: withRequest(baseRequest, [{ ...validObservations[0], outcome: "unknown" }, validObservations[1]]), providers: [provider], transport: f.transport }), /outcome is unsupported/u);
  await assert.rejects(runDistillationOnce({ client: withRequest(baseRequest, [{ ...validObservations[0], execution_shape: Array.from({ length: 17 }, (_, index) => `step-${index}`) }, validObservations[1]]), providers: [provider], transport: f.transport }), /at most 16/u);
  const longTicket: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_evaluation_model_ticket_list") return { tickets: [{ id: "long", purpose: "workflow_evolution", target: { kind: "workflow_evolution_request", id: "r".repeat(161), version: 1 }, readiness: { status: "ready_for_adapter" } }] };
    return f.client.call(name, args);
  } };
  await assert.rejects(runDistillationOnce({ client: longTicket, providers: [provider], transport: f.transport }), /at most 160/u);
  assert.equal(f.calls.some(call => call.name === "craft_experience_procedure_submit"), false);
});

test("poll intervals clamp numeric settings and fall back for nonnumeric values", () => {
  assert.equal(boundedPollInterval(undefined, 30, 1, 100), 30);
  assert.equal(boundedPollInterval("not-a-number", 30, 1, 100), 30);
  assert.equal(boundedPollInterval("0", 30, 1, 100), 1);
  assert.equal(boundedPollInterval("101", 30, 1, 100), 100);
  assert.equal(boundedPollInterval("45", 30, 1, 100), 45);
});

test("empty Experience passes back off to a bounded interval and any processed work resets it", () => {
  assert.equal(learningPollInterval(30_000, 0), 30_000);
  assert.equal(learningPollInterval(30_000, 1), 60_000);
  assert.equal(learningPollInterval(30_000, 10), 240_000);
  assert.equal(learningPollInterval(1_000, 20), 8_000);
  assert.equal(learningPollInterval(1_000, 20, 60_000), 60_000);
  assert.equal(learningWorkFound({ processed: 1 }), true);
  assert.equal(learningWorkFound({ processed: 0, evaluation: { processed: 1 } }), true);
  assert.equal(learningWorkFound({ processed: 0, scenario_classification: { processed: 1 } }), true);
  assert.equal(learningWorkFound({ evaluation: { processed: 0 }, scenario_classification: { processed: 1 } }), true);
  assert.equal(learningWorkFound({ scenario_classification: { scan_has_more: true } }), true);
  assert.equal(learningWorkFound({ processed: 0, evaluation: null, scenario_classification: {} }), false);
  assert.throws(() => learningPollInterval(0, 1), /bounds are invalid/u);
  assert.throws(() => learningPollInterval(30_000, -1), /bounds are invalid/u);
  assert.throws(() => learningPollInterval(30_000, 1, 29_999), /bounds are invalid/u);
});

test("continuous learning tick contains transient Experience and Knowledge failures and recovers on the next pass", async () => {
  let ticketAttempts = 0, sourceListAttempts = 0;
  const client: ExperienceLearningClient = { async call(name) {
    if (name === "craft_evaluation_model_ticket_list") {
      ticketAttempts += 1;
      if (ticketAttempts === 1) throw new TypeError("provider credential and response body must stay private");
      return { tickets: [], has_more: false, next_cursor: null };
    }
    if (name === "craft_experience_learning_evaluation_dispatch_list") return { dispatches: [] };
    if (name === "craft_knowledge_storage_reconcile") return { status: "completed", examined: 0, migrated: 0, skipped: 0, blocked: [], has_more: false, next_cursor: null };
    if (name === "craft_knowledge_source_list") {
      sourceListAttempts += 1;
      if (sourceListAttempts === 1) throw "source locator must stay private";
      return { sources: [] };
    }
    if (name === "craft_knowledge_claim_list") return { claims: [] };
    throw new Error(`unexpected tool ${name}`);
  } };
  const deps = { client, providers: [provider], transport: fixture().transport, env: directWorkerEnv };
  const first = await runLearningTick(deps, true);
  assert.deepEqual(first, { processed: 0, outcomes: [], scenario_classification: { status: "failed", failure_kind: "TypeError" },
    failure_kind: "TypeError", evaluation: { processed: 0, outcomes: [] }, knowledge: { status: "failed", failure_kind: "Error" } });
  assert.deepEqual(learningTickStatus(first, true), { diagnostics: "Craft Experience learning pass failed (TypeError).\nCraft Knowledge learning pass failed (Error).\n", exit_code: 1 });
  assert.equal(JSON.stringify(first).includes("credential"), false);
  assert.equal(JSON.stringify(first).includes("locator"), false);
  const second = await runLearningTick(deps, true);
  assert.deepEqual(second, { processed: 0, outcomes: [], evaluation: { processed: 0, outcomes: [] }, knowledge: { sources_seen: 0, sources_selected: 0, outcomes: [], skipped_sources: 0, classification: { processed: 0, outcomes: [] } } });
  assert.deepEqual(learningTickStatus(second, true), { diagnostics: "", exit_code: null });
  assert.equal(ticketAttempts, 4);
  assert.equal(sourceListAttempts, 2);
  const experienceOnly = await runLearningTick(deps, false, ["experience"]);
  assert.equal(experienceOnly.knowledge, null);
  assert.deepEqual(learningTickStatus(experienceOnly, false), { diagnostics: "", exit_code: null });
  const collected = await runLearningTick(deps, false, ["experience"], async () => ({ status: "completed", tasks_indexed: 2, raw_content_stored: false }));
  assert.deepEqual(collected.session_collection, { status: "completed", tasks_indexed: 2, raw_content_stored: false });
  const failedCollection = await runLearningTick(deps, false, ["experience"], async () => { throw new TypeError("private session path"); });
  assert.deepEqual(failedCollection.session_collection, { status: "failed", failure_kind: "TypeError" });
  assert.deepEqual(learningTickStatus(failedCollection, true), { diagnostics: "Craft Codex session collection failed (TypeError).\n", exit_code: 1 });
  assert.equal(JSON.stringify(failedCollection).includes("private"), false);
  assert.equal((await runLearningTick(deps, true, ["experience"])).knowledge, null, "an Experience-only tick must not request Knowledge even when the timer is due");
  assert.equal(sourceListAttempts, 2);
  const unusualError = new Error("internal failure");
  unusualError.name = "provider/path private";
  const invalidNameClient: ExperienceLearningClient = { async call() { throw unusualError; } };
  assert.equal((await runLearningTick({ client: invalidNameClient, env: directWorkerEnv })).failure_kind, "Error");
  const knowledgeOnlyFailure = await runLearningTick({ client: { async call(name) {
    if (name === "craft_evaluation_model_ticket_list" || name === "craft_experience_learning_evaluation_dispatch_list") return { tickets: [], dispatches: [], has_more: false, next_cursor: null };
    if (name === "craft_knowledge_storage_reconcile") return { status: "completed", examined: 0, migrated: 0, skipped: 0, blocked: [], has_more: false, next_cursor: null };
    if (name === "craft_knowledge_source_list") throw new Error("private");
    return {};
  } }, env: directWorkerEnv }, true);
  assert.deepEqual(learningTickStatus(knowledgeOnlyFailure, true), { diagnostics: "Craft Knowledge learning pass failed (Error).\n", exit_code: 1 });
  assert.deepEqual(learningTickStatus({ processed: 0, knowledge: "malformed" }, false), { diagnostics: "", exit_code: null });
});

test("Knowledge source failures and partial pages are visible and make one-shot sync fail closed", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const result = { knowledge: { outcomes: [
    { status: "failed", source_ref: digest, failure_kind: "TypeError", failure_code: "ERR_MCP_INVALID_INPUT", reason: "/private/source/path" },
    { status: "failed", source_ref: "/private/source/path", failure_kind: "unsafe error name", failure_code: "/private/secret" },
    { status: "partial", source_ref: digest, reason: "/private/source/path" },
    { status: "completed", source_ref: digest }, null, [], "malformed",
  ] } } as JsonObject;
  const expected = `Craft Knowledge source ${digest} sync failed (TypeError) [ERR_MCP_INVALID_INPUT].\n`
    + "Craft Knowledge source unknown_source sync failed (Error).\n"
    + `Craft Knowledge source ${digest} sync is partial; remaining pages will resume in a later pass.\n`;
  assert.deepEqual(learningTickStatus(result, true), { diagnostics: expected, exit_code: 1 });
  assert.deepEqual(learningTickStatus(result, false), { diagnostics: expected, exit_code: null },
    "continuous workers should log per-source issues and keep their retry loop running");
  assert.equal(expected.includes("/private/source/path"), false, "source locations and free-form error reasons must not enter Host diagnostics");
  assert.deepEqual(learningTickStatus({ knowledge: { outcomes: [] } }, true), { diagnostics: "", exit_code: null });
});

test("learning failure diagnostics expose only safe error names", () => {
  assert.equal(learningFailureKind(new TypeError("private provider response")), "TypeError");
  assert.equal(learningFailureKind("private string failure"), "Error");
  const unsafe = new Error("private");
  unsafe.name = "path/private";
  assert.equal(learningFailureKind(unsafe), "Error");
});

test("Knowledge classification failures remain visible without dropping completed source sync", async () => {
  const client: ExperienceLearningClient = { async call(name) {
    if (name === "craft_experience_learning_evaluation_dispatch_list" || name === "craft_evaluation_model_ticket_list") return { dispatches: [], tickets: [], has_more: false, next_cursor: null };
    if (name === "craft_knowledge_storage_reconcile") return { status: "completed", examined: 0, migrated: 0, skipped: 0, blocked: [], has_more: false, next_cursor: null };
    if (name === "craft_knowledge_source_list") return { sources: [] };
    if (name === "craft_knowledge_claim_list") throw new TypeError("private classification failure");
    throw new Error(`unexpected tool ${name}`);
  } };
  const result = await runLearningTick({ client, env: directWorkerEnv }, true);
  assert.deepEqual(result.knowledge, { sources_seen: 0, sources_selected: 0, outcomes: [], skipped_sources: 0,
    classification: { status: "failed", failure_kind: "TypeError" } });
  assert.deepEqual(learningTickStatus(result, true), { diagnostics: "Craft Knowledge scenario classification failed (TypeError).\n", exit_code: 1 });
  assert.equal(JSON.stringify(result).includes("private classification failure"), false);
  assert.deepEqual(learningTickStatus({ knowledge: { classification: { status: "failed", failure_kind: "invalid/private" } } }, true),
    { diagnostics: "Craft Knowledge scenario classification failed (Error).\n", exit_code: 1 });
  assert.deepEqual(learningTickStatus({ knowledge: { classification: { outcomes: [
    { status: "failed", failure_stage: "claim_save" }, { status: "failed", failure_stage: "taxonomy_list" }, null, { status: "unclassified" },
  ] } } }, true),
    { diagnostics: "Craft Knowledge scenario classification failed for 2 Claim(s) at claim_save:1,taxonomy_list:1.\n", exit_code: 1 });
  assert.deepEqual(learningTickStatus({ knowledge: { classification: { outcomes: [
    { status: "failed", failure_stage: "response_validate", failure_code: "review_decision_invalid" },
  ] } } }, true),
    { diagnostics: "Craft Knowledge scenario classification failed for 1 Claim(s) at response_validate/review_decision_invalid:1.\n", exit_code: 1 });
  assert.deepEqual(learningTickStatus({ knowledge: { classification: { outcomes: [{ status: "failed" }] } } }, true),
    { diagnostics: "Craft Knowledge scenario classification failed for 1 Claim(s).\n", exit_code: 1 });
});

test("missing Knowledge model configuration is visible, safe, and fails one-shot learning", () => {
  const skipped = { knowledge: { classification: { processed: 0, outcomes: [], skipped: true, reason: "no_configured_model" } } } as JsonObject;
  const diagnostic = "Craft Knowledge scenario classification skipped (no_configured_model); configure one ready model profile to resume.\n";
  assert.deepEqual(learningTickStatus(skipped, false), { diagnostics: diagnostic, exit_code: null },
    "the continuous worker must report the blocker and keep polling for repaired configuration");
  assert.deepEqual(learningTickStatus(skipped, true), { diagnostics: diagnostic, exit_code: 1 },
    "a one-shot learning run must not report success when eligible Claims were left unclassified");
  const unsafe = { knowledge: { classification: { skipped: true, reason: "private/path?api_key=secret" } } } as JsonObject;
  assert.deepEqual(learningTickStatus(unsafe, false), {
    diagnostics: "Craft Knowledge scenario classification skipped (configuration_unavailable); configure one ready model profile to resume.\n", exit_code: null,
  }, "unrecognized provider details must not enter logs");
  const credential = { knowledge: { classification: { skipped: true, reason: "set_CRAFT_MODEL_KEY" } } } as JsonObject;
  assert.match(learningTickStatus(credential, false).diagnostics, /\(set_CRAFT_MODEL_KEY\)/u,
    "a safe environment-variable name can tell the operator how to repair readiness without exposing its value");
  assert.deepEqual(learningTickStatus({ knowledge: { classification: { processed: 0, outcomes: [] } } }, true),
    { diagnostics: "", exit_code: null }, "a pass with no eligible Claims must remain quiet");
});

test("standalone learning modes call only their mounted Knowledge or Experience tools", async () => {
  const calls: string[] = [];
  const client: ExperienceLearningClient = { async call(name) {
    calls.push(name);
    if (name === "craft_evaluation_model_ticket_list") return { tickets: [], has_more: false, next_cursor: null };
    if (name === "craft_experience_learning_evaluation_dispatch_list") return { dispatches: [] };
    if (name === "craft_knowledge_storage_reconcile") return { status: "completed", examined: 0, migrated: 0, skipped: 0, blocked: [], has_more: false, next_cursor: null };
    if (name === "craft_knowledge_source_list") return { sources: [] };
    if (name === "craft_knowledge_claim_list") return { claims: [] };
    throw new Error(`unexpected tool ${name}`);
  } };
  const deps = { client, providers: [provider], transport: fixture().transport, env: directWorkerEnv };
  const experience = await runLearningTick(deps, true, ["experience"]);
  assert.deepEqual(experience, { processed: 0, outcomes: [], evaluation: { processed: 0, outcomes: [] }, knowledge: null });
  assert.deepEqual(calls, ["craft_evaluation_model_ticket_list", "craft_evaluation_model_ticket_list", "craft_experience_learning_evaluation_dispatch_list"]);
  calls.length = 0;
  const knowledge = await runLearningTick(deps, true, ["knowledge"]);
  assert.deepEqual(knowledge, { processed: 0, outcomes: [], skipped: true,
    knowledge: { sources_seen: 0, sources_selected: 0, outcomes: [], skipped_sources: 0, classification: { processed: 0, outcomes: [] } } });
  assert.deepEqual(calls, ["craft_knowledge_storage_reconcile", "craft_knowledge_source_list", "craft_knowledge_claim_list"]);
  calls.length = 0;
  const knowledgeWithoutSync = await runLearningTick(deps, false, ["knowledge"]);
  assert.deepEqual(knowledgeWithoutSync, { processed: 0, outcomes: [], skipped: true,
    knowledge: { status: "not_due", processed: 0, content_stored: false, raw_content_stored: false,
      classification: { processed: 0, outcomes: [] } } });
  assert.deepEqual(calls, ["craft_knowledge_claim_list"]);
  assert.deepEqual(learningComponents({}), ["experience", "knowledge"]);
  assert.deepEqual(learningComponents({ CRAFT_LEARNING_COMPONENTS: "knowledge" }), ["knowledge"]);
  assert.deepEqual(learningComponents({ CRAFT_LEARNING_COMPONENTS: "experience,knowledge" }), ["experience", "knowledge"]);
  for (const invalid of ["", "memory", "experience,experience", "experience, memory"]) {
    assert.throws(() => learningComponents({ CRAFT_LEARNING_COMPONENTS: invalid }), /CRAFT_LEARNING_COMPONENTS/u);
  }
});

test("Knowledge worker surfaces a storage page only when migration made progress", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "craft-learning-storage-progress-"));
  const calls: string[] = [];
  try {
    const client: ExperienceLearningClient = { async call(name) {
      calls.push(name);
      if (name === "craft_knowledge_storage_reconcile") return { status: "partial", phase: "records", examined: 1, migrated: 1,
        skipped: 0, blocked: [], has_more: true, next_cursor: "cGFnZTI" };
      if (name === "craft_knowledge_source_list") return { sources: [] };
      if (name === "craft_knowledge_claim_list") return { claims: [] };
      throw new Error(`unexpected tool ${name}`);
    } };
    const result = await runLearningTick({ client, env: { ...process.env, CRAFT_DATA_DIR: dataDir } }, true, ["knowledge"]);
    const knowledge = result.knowledge as JsonObject;
    assert.deepEqual(knowledge.storage_reconciliation, { status: "partial", examined: 1, migrated: 1, skipped: 0,
      phase: "records", blocked_count: 0, has_more: true, raw_content_stored: false });
    assert.equal(calls.filter(name => name === "craft_knowledge_storage_reconcile").length, 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("distillation worker fails closed on malformed model output and never submits it", async () => {
  const f = fixture("not-json");
  await assert.rejects(runDistillationOnce({ client: f.client, providers: [provider], transport: f.transport }), /one JSON object/u);
  assert.equal(f.calls.some(call => call.name === "craft_experience_procedure_submit"), false);
});

test("distillation worker rejects unsupported, effectful, and escaping workflow steps before submission", async () => {
  for (const step of [
    { id: "guide", type: "instruction", objective: "run tests", side_effect: "read_only" },
    { id: "shell", type: "command", command: ["sh", "-c", "echo unsafe"], side_effect: "read_only" },
    { id: "write", type: "assertion", evaluator: "file_exists", path: ".", side_effect: "local_write" },
    { id: "escape", type: "assertion", evaluator: "file_exists", path: "../outside" },
    { id: "invalid-threshold", type: "coverage_gate", branch_threshold: 101 },
    { id: "duplicate-input", type: "assertion", evaluator: "file_exists", path: ".", inputs: ["project_root", "project_root"] },
    { id: "invalid-input", type: "assertion", evaluator: "file_exists", path: ".", inputs: ["project-root"] },
  ]) {
    const f = fixture(JSON.stringify({ name: "Unsafe flow", description: "Must be rejected", inputs: (step.inputs as string[] | undefined) ?? [], steps: [{ ...step, inputs: undefined }] }));
    await assert.rejects(runDistillationOnce({ client: f.client, providers: [provider], transport: f.transport }));
    assert.equal(f.calls.some(call => call.name === "craft_experience_procedure_submit"), false);
  }
});

test("distillation worker skips tickets without current adapter readiness", async () => {
  const f = fixture();
  const client: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_evaluation_model_ticket_list") return { tickets: [{ id: "ticket-disabled", readiness: { status: "needs_enablement", next_action: "explicitly_enable_network_execution" } }] };
    return f.client.call(name, args);
  } };
  const result = await runDistillationOnce({ client, providers: [provider], transport: f.transport });
  assert.deepEqual((result.outcomes as JsonObject[])[0], { ticket_id: "ticket-disabled", status: "skipped", reason: "explicitly_enable_network_execution" });
  assert.equal(f.calls.some(call => call.name === "craft_experience_procedure_submit"), false);
});

test("distillation leaves a ready ticket untouched when the shared Host model-call budget is exhausted", async () => {
  const f = fixture();
  const transport = { acquireCall: () => false, async complete() { throw new Error("must not call model"); } };
  const result = await runDistillationOnce({ client: f.client, providers: [provider], transport });
  assert.deepEqual((result.outcomes as JsonObject[])[0], { ticket_id: "ticket-1", request_id: "request-1", status: "skipped", reason: "model_call_budget_exhausted" });
  assert.equal(f.calls.some(call => call.name === "craft_experience_procedure_submit"), false);
});

test("distillation worker skips stale and graph requests until a compatible adapter exists", async () => {
  const f = fixture();
  const stale: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_experience_learning_request_get") return { request: { id: "request-1", version: 2, lifecycle: "awaiting_model" }, observations: [] };
    return f.client.call(name, args);
  } };
  assert.equal((((await runDistillationOnce({ client: stale, providers: [provider], transport: f.transport })).outcomes as JsonObject[])[0]?.status), "stale");
  const graph: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_experience_learning_request_get") return { request: { id: "request-1", version: 1, lifecycle: "awaiting_model", procedure_kind: "graph" } };
    return f.client.call(name, args);
  } };
  assert.equal((((await runDistillationOnce({ client: graph, providers: [provider], transport: f.transport })).outcomes as JsonObject[])[0]?.reason), "graph_distillation_requires_graph_adapter");
});

test("distillation worker rechecks readiness and sanitized observations at execution time", async () => {
  const f = fixture();
  const client: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_evaluation_model_profile_get") return { profile: { provider: "test", model: "test-model" }, readiness: { status: "needs_credential", next_action: "set_TEST_KEY" } };
    return f.client.call(name, args);
  } };
  const skipped = await runDistillationOnce({ client, providers: [provider], transport: f.transport });
  assert.equal((skipped.outcomes as JsonObject[])[0]?.status, "skipped");
  assert.equal(f.calls.some(call => call.name === "craft_experience_learning_request_get"), false);
  const maliciousInputClient: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_evaluation_model_profile_get") return f.client.call(name, args);
    if (name === "craft_experience_learning_request_get") return { request: { id: "request-1", version: 1, lifecycle: "awaiting_model", procedure_kind: "workflow", scenario_key: "build-check", hypothesis: "Hypothesis", design_axes: ["orchestration"], output_contract_ref: "contract" }, observations: [{ sanitized: false, content_stored: true }] };
    return f.client.call(name, args);
  } };
  await assert.rejects(runDistillationOnce({ client: maliciousInputClient, providers: [provider], transport: f.transport }), /outside the sanitized content-free contract/u);
  assert.equal(f.calls.some(call => call.name === "craft_experience_procedure_submit"), false);
});

test("worker CLI negotiates real newline MCP stdio and completes one empty poll", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-learning-worker-cli-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CODEX_HOME: join(dataDir, "codex-home"), CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath, CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([fixturePath]),
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? -1));
  });
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout.trim()), { processed: 0, outcomes: [], evaluation: { processed: 0, outcomes: [] }, session_collection: emptySessionCollection(dataDir),
    knowledge: { sources_seen: 0, sources_selected: 0, outcomes: [], skipped_sources: 0, classification: { processed: 0, outcomes: [] } } });
  rmSync(dataDir, { recursive: true, force: true });
});

test("worker selects the Codex Host transport for an empty poll without starting a model call", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-learning-codex-host-empty-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CODEX_HOME: join(dataDir, "codex-home"), CRAFT_LEARNING_MODEL_HOST: "codex-cli",
    CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath, CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([fixturePath]),
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? -1));
  });
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout.trim()), { processed: 0, outcomes: [], evaluation: { processed: 0, outcomes: [] }, session_collection: emptySessionCollection(dataDir),
    knowledge: { sources_seen: 0, sources_selected: 0, outcomes: [], skipped_sources: 0, classification: { processed: 0, outcomes: [] } } });
  rmSync(dataDir, { recursive: true, force: true });
});

test("Knowledge-only worker CLI polls its mounted Knowledge product without Experience calls", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-knowledge-worker-cli-"));
  const runtimeDir = join(dataDir, "runtime"); mkdirSync(runtimeDir, { recursive: true });
  const lockPath = join(runtimeDir, "learning-worker-knowledge.lock.json");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner_id: "supervisor-owner" }));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CODEX_HOME: join(dataDir, "codex-home"), CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath,
    CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([fixturePath]), CRAFT_LEARNING_COMPONENTS: "knowledge", CRAFT_LEARNING_COMPONENT_LOCKS_HELD: "knowledge",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? -1));
  });
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout.trim()), { processed: 0, outcomes: [], skipped: true, session_collection: emptySessionCollection(dataDir),
    knowledge: { sources_seen: 0, sources_selected: 0, outcomes: [], skipped_sources: 0, classification: { processed: 0, outcomes: [] } } });
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).owner_id, "supervisor-owner", "the child must leave its supervisor-owned lock untouched");
  rmSync(dataDir, { recursive: true, force: true });
});

test("one-shot worker skips MCP and model work when another process owns its component lock", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-learning-worker-locked-"));
  const runtimeDir = join(dataDir, "runtime"); mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "learning-worker-knowledge.lock.json"), JSON.stringify({ pid: process.pid, owner_id: "test-owner" }));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CRAFT_LEARNING_COMPONENTS: "knowledge",
    CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath, CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify(["/missing/must-not-start.cjs"]),
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? -1));
    });
    assert.equal(exitCode, 0, stderr);
    assert.deepEqual(JSON.parse(stdout.trim()), { status: "skipped_locked", components: ["knowledge"] });
    assert.equal(stderr, "");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("worker exits safely when it cannot create its component lock", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-learning-worker-lock-error-"));
  writeFileSync(join(dataDir, "runtime"), "not-a-directory");
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CRAFT_LEARNING_COMPONENTS: "knowledge",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? -1));
    });
    assert.equal(exitCode, 1);
    assert.equal(stdout, "");
    assert.equal(stderr, "Craft learning worker lock failed (Error).\n");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("worker releases its component lock when MCP process construction fails", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-learning-worker-spawn-error-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CRAFT_LEARNING_COMPONENTS: "knowledge",
    CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath, CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify(["\0"]),
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? -1));
    });
    assert.equal(exitCode, 1);
    assert.equal(stdout, "");
    assert.equal(stderr, "Craft learning worker failed (TypeError).\n");
    assert.equal(existsSync(join(dataDir, "runtime", "learning-worker-knowledge.lock.json")), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("Worker links archived task indexes to exact Host verification Evidence", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-session-evidence-worker-"));
  const codexHome = join(dataDir, "codex-home"), sessions = join(codexHome, "sessions", "2026", "10");
  mkdirSync(sessions, { recursive: true });
  const sessionId = "session-evidence-worker", turnId = "turn-evidence-worker";
  const records = [
    { type: "session_meta", payload: { session_id: sessionId, cwd: dataDir } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "private source prompt" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "private result text" }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ];
  writeFileSync(join(sessions, "session.jsonl"), `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
  const evidence = [{ evidence_id: "evidence-hook", host: "codex", session_id: sessionId, turn_id: turnId, task_id: "hook-task",
    context_receipt_id: "receipt-hook", verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
    verification_outcome: "passed", verified: true, content_stored: false }];
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CODEX_HOME: codexHome, CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath,
    CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([fixturePath]), CRAFT_TEST_SESSION_EVIDENCE: JSON.stringify(evidence),
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? -1));
    });
    assert.equal(exitCode, 0, stderr);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.session_collection.tasks_verified, 1);
    assert.equal(result.session_collection.evidence_reconciliation.tasks_verified, 1);
    assert.deepEqual(result.session_collection.evidence_batch, { status: "advanced", sessions_queried: 1, cursor_stored: true, raw_content_stored: false });
    const state = readFileSync(join(dataDir, "runtime", "codex-session-collection.json"), "utf8");
    assert.match(state, /evidence-hook/u);
    assert.doesNotMatch(state, /private source prompt|private result text/u);
    assert.equal(JSON.parse(state).evidence_cursor_session_id, "session-evidence-worker");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("Worker skips Codex session collection while another worker owns its lock", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-session-collection-locked-"));
  const release = await acquireLearningWorkerLocks(join(dataDir, "runtime"), ["codex-session-collection"]);
  assert.ok(release);
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CODEX_HOME: join(dataDir, "codex-home"), CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath,
    CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([fixturePath]),
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? -1));
    });
    assert.equal(exitCode, 0, stderr);
    assert.deepEqual(JSON.parse(stdout.trim()).session_collection, { status: "skipped_locked", sessions_processed: 0, raw_content_stored: false });
  } finally {
    await release();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("worker CLI keeps polling components isolated, writes sanitized diagnostics and fails once mode", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-learning-worker-failure-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
    ...process.env, CRAFT_DATA_DIR: dataDir, CODEX_HOME: join(dataDir, "codex-home"), CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath, CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([fixturePath]),
    CRAFT_TEST_LEARNING_WORKER_FAILURES: "both",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? -1));
  });
  assert.equal(exitCode, 1);
  const result = JSON.parse(stdout.trim()) as JsonObject;
  assert.equal(result.failure_kind, "Error");
  assert.deepEqual(result.knowledge, { status: "failed", failure_kind: "Error" }, "Knowledge must still run after an Experience pass failure");
  assert.equal(stdout.includes("private fixture error"), false);
  assert.match(stderr, /Craft Experience learning pass failed \(Error\)\./u);
  assert.match(stderr, /Craft Knowledge learning pass failed \(Error\)\./u);
  assert.equal(stderr.includes("private fixture error"), false);
  rmSync(dataDir, { recursive: true, force: true });
});

test("worker CLI reports an individual Knowledge source failure on stderr and fails one-shot sync", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-knowledge-source-failure-"));
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
      ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CODEX_HOME: join(dataDir, "codex-home"), CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath,
      CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([fixturePath]), CRAFT_LEARNING_COMPONENTS: "knowledge",
      CRAFT_TEST_LEARNING_WORKER_FAILURES: "knowledge_source_failure",
    }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? -1));
    });
    const sourceRef = `sha256:${createHash("sha256").update("fixture-source").digest("hex")}`;
    assert.equal(exitCode, 1, "one-shot Knowledge sync must report a source it could not ingest");
    assert.deepEqual(JSON.parse(stdout.trim()).knowledge.outcomes, [{ source_ref: sourceRef, status: "failed", failure_kind: "Error", failure_code: "OPERATION_FAILED" }]);
    assert.match(stderr, /sync failed \(Error\) \[OPERATION_FAILED\]\./u);
    assert.equal(stderr.includes("private fixture error"), false, "source failures must be observable without exposing raw tool error text");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("long-lived worker survives one failed pass, completes the next pass, then stops on signal", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-learning-worker-recovery-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CODEX_HOME: join(dataDir, "codex-home"), CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath,
    CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([fixturePath]), CRAFT_TEST_LEARNING_WORKER_FAILURES: "recover_once",
    CRAFT_EXPERIENCE_POLL_MS: "1000", CRAFT_KNOWLEDGE_POLL_MS: "60000",
  }, stdio: ["ignore", "pipe", "pipe"] });
  const results: JsonObject[] = [];
  const resultTimes: number[] = [];
  let stdout = "", stderr = "", buffered = "";
  let firstFailure = false;
  let resolveRecovered!: () => void, rejectRecovered!: (error: Error) => void;
  const recoveredPass = new Promise<void>((resolve, reject) => { resolveRecovered = resolve; rejectRecovered = reject; });
  child.stdout.setEncoding("utf8").on("data", chunk => {
    stdout += chunk;
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const result = JSON.parse(line) as JsonObject;
      results.push(result);
      resultTimes.push(Date.now());
      const knowledge = result.knowledge as JsonObject | undefined;
      if (result.failure_kind === "Error" && knowledge?.failure_kind === "Error") firstFailure = true;
      if (firstFailure && results.length >= 2 && !result.failure_kind && knowledge?.sources_seen === 0) resolveRecovered();
    }
  });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const closed = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? -1));
  });
  const timeout = setTimeout(() => rejectRecovered(new Error("worker did not recover on its next poll")), 8_000);
  try {
    await recoveredPass;
    clearTimeout(timeout);
    assert.equal(results.length, 2, "a single transient error must not stop the long-lived poll loop");
    assert.equal(results[0]?.failure_kind, "Error");
    assert.equal((results[0]?.knowledge as JsonObject).failure_kind, "Error");
    assert.equal(results[1]?.failure_kind, undefined);
    assert.ok(resultTimes[1]! - resultTimes[0]! >= 1_500, "an empty failed pass must increase the next poll interval");
    assert.deepEqual(results[1]?.knowledge, { sources_seen: 0, sources_selected: 0, outcomes: [], skipped_sources: 0, classification: { processed: 0, outcomes: [] } });
    assert.equal(stdout.includes("private fixture error"), false);
    assert.match(stderr, /Craft Experience learning pass failed \(Error\)\./u);
    assert.match(stderr, /Craft Knowledge learning pass failed \(Error\)\./u);
    child.kill("SIGTERM");
    assert.equal(await closed, 0, stderr);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) { child.kill("SIGKILL"); await closed; }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("worker CLI sanitizes startup failures from a missing MCP executable", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, "--once"], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_EXPERIENCE_MCP_COMMAND: "/definitely/missing/craft-mcp", CRAFT_EXPERIENCE_POLL_MS: "1000",
    CRAFT_LEARNING_COMPONENT_LOCKS_HELD: "experience,knowledge",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? -1));
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "Craft learning worker failed (Error).\n");
});

test("worker exits when its MCP child dies so the supervisor can reconnect instead of retrying a dead pipe", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-learning-worker-dead-mcp-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath], { env: {
    ...process.env, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: dataDir, CODEX_HOME: join(dataDir, "codex-home"), CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath,
    CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([fixturePath]), CRAFT_TEST_LEARNING_WORKER_MCP_EXIT: "after_first_call",
    CRAFT_EXPERIENCE_POLL_MS: "1000",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? -1));
  });
  assert.equal(exitCode, 1);
  const result = JSON.parse(stdout.trim()) as JsonObject;
  assert.equal(result.failure_kind, "Error");
  assert.deepEqual(result.knowledge, { status: "failed", failure_kind: "Error" });
  assert.match(stderr, /Craft Experience learning pass failed \(Error\)\./u);
  assert.equal(stderr.includes("MCP exited with code"), false);
  rmSync(dataDir, { recursive: true, force: true });
});

test("MCP stdio client handles structured, text, tool-error and RPC-error responses", async () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const client = new McpStdioClient(process.execPath, [fixturePath]);
  try {
    await client.initialize();
    assert.deepEqual(await client.call("fixture_structured"), { tickets: [] });
    assert.deepEqual(await client.call("fixture_text"), { ok: true });
    await assert.rejects(client.call("fixture_bad_structured"), /structuredContent must be an object/u);
    await assert.rejects(client.call("fixture_invalid_text"), /no structured result/u);
    await assert.rejects(client.call("fixture_non_text"), /no structured result/u);
    await assert.rejects(client.call("fixture_empty"), /no structured result/u);
    await assert.rejects(client.call("fixture_tool_error"), /fixture tool error/u);
    await assert.rejects(client.call("fixture_tool_error_code"), (error: NodeJS.ErrnoException) => error.code === "ERR_MCP_INVALID_INPUT");
    await assert.rejects(client.call("fixture_tool_error_unsafe_code"), (error: NodeJS.ErrnoException) => error.code === undefined);

    await assert.rejects(client.call("fixture_tool_error_empty"), /fixture_tool_error_empty failed/u);
    await assert.rejects(client.call("fixture_tool_error_non_array"), /fixture_tool_error_non_array failed/u);
    await assert.rejects(client.call("fixture_bad_content"), /no structured result/u);
    await assert.rejects(client.call("fixture_rpc_error"), /fixture rpc error/u);
    await assert.rejects(client.call("fixture_rpc_error_empty"), /MCP request failed/u);
  } finally { client.close(); }
});

test("MCP stdio client stops a child that never responds to a request", async () => {
  const script = `const readline = require("node:readline");\nreadline.createInterface({ input: process.stdin }).on("line", line => {\n  const request = JSON.parse(line);\n  if (request.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }) + "\\n");\n});`;
  const client = new McpStdioClient(process.execPath, ["-e", script], { request_timeout_ms: 500 });
  try {
    await client.initialize();
    const childExited = new Promise<void>(resolve => client.child.once("exit", () => resolve()));
    const request = client.call("fixture_never_responds");
    await assert.rejects(Promise.race([request, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("test observation timed out")), 1_500))]),
      /MCP request timed out: tools\/call/u);
    await childExited;
    assert.equal(client.closed, true);
    assert.equal(client.pending.size, 0);
  } finally { client.close(); }
});

test("managed Knowledge adjudication has enough MCP time for the bounded Host deadline", () => {
  assert.equal(learningMcpRequestTimeoutMs("tools/call", { name: "craft_knowledge_evaluation_case_adjudicate" }, 60_000), 135_000);
  assert.equal(learningMcpRequestTimeoutMs("tools/call", { name: "craft_knowledge_evaluation_case_adjudicate" }, 200_000), 200_000);
  assert.equal(learningMcpRequestTimeoutMs("tools/call", { name: "craft_knowledge_evaluation_case_list" }, 60_000), 60_000);
  assert.equal(learningMcpRequestTimeoutMs("initialize", {}, 60_000), 60_000);
});

test("MCP diagnostics stay off stdout and a stdin stream error rejects pending work", async () => {
  const client = new McpStdioClient(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    client.child.stderr.emit("data", Buffer.from("fixture diagnostic"));
    const pending = client.initialize();
    client.child.stdin.emit("error", new Error("fixture stdin disconnected"));
    await assert.rejects(pending, /fixture stdin disconnected/u);
    assert.equal(client.pending.size, 0);
  } finally { client.close(); }
});

test("MCP stdio client refuses a stale Craft server before sending initialized notification", async () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const keys = ["CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_INFO", "CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_NAME", "CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_VERSION"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_NAME = "craft";
    process.env.CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_VERSION = CRAFT_RELEASE_VERSION;
    const matching = new McpStdioClient(process.execPath, [fixturePath]);
    try { await matching.initialize(); } finally { matching.close(); }

    process.env.CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_INFO = "missing";
    const legacy = new McpStdioClient(process.execPath, [fixturePath]);
    try { await legacy.initialize(); } finally { legacy.close(); }

    delete process.env.CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_INFO;
    process.env.CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_VERSION = "0.12.72";
    const stale = new McpStdioClient(process.execPath, [fixturePath]);
    try {
      await assert.rejects(stale.initialize(), new RegExp(`Craft MCP version mismatch: worker ${CRAFT_RELEASE_VERSION}, server 0\\.12\\.72`, "u"));
      await assert.rejects(stale.call("should_not_run"), /child is closed/u);
    } finally { stale.close(); }

    process.env.CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_VERSION = "missing";
    const unknownVersion = new McpStdioClient(process.execPath, [fixturePath]);
    try {
      await assert.rejects(unknownVersion.initialize(), new RegExp(`Craft MCP version mismatch: worker ${CRAFT_RELEASE_VERSION}, server unknown`, "u"));
    } finally { unknownVersion.close(); }
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("standalone learning worker disables the supervised loop in its MCP child", async () => {
  const previous = process.env.CRAFT_CONTINUOUS_LEARNING;
  process.env.CRAFT_CONTINUOUS_LEARNING = "1";
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const client = new McpStdioClient(process.execPath, [fixturePath]);
  try {
    await client.initialize();
    assert.deepEqual(await client.call("fixture_worker_environment"), { continuous_learning: "0" });
  } finally {
    client.close();
    if (previous === undefined) delete process.env.CRAFT_CONTINUOUS_LEARNING;
    else process.env.CRAFT_CONTINUOUS_LEARNING = previous;
  }
});

test("MCP stdio client rejects requests when the child command cannot start", async () => {
  const client = new McpStdioClient("/definitely/missing/craft-mcp-worker", []);
  await assert.rejects(client.initialize(), /ENOENT/u);
  await assert.rejects(client.call("after_closed"), /child is closed/u);
  (client as unknown as { failAll(error: Error): void }).failAll(new Error("second failure notification"));
});

test("MCP stdio client removes pending writes that fail and rejects requests when a child exits", async () => {
  const nonErrorWriteThrow = new McpStdioClient(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  nonErrorWriteThrow.child.stdin.write = (() => { throw "fixture write failure"; }) as typeof nonErrorWriteThrow.child.stdin.write;
  await assert.rejects(nonErrorWriteThrow.initialize(), /Craft MCP request write failed/u);
  assert.equal(nonErrorWriteThrow.pending.size, 0);
  nonErrorWriteThrow.close();

  const writeThrow = new McpStdioClient(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  writeThrow.child.stdin.write = (() => { throw new Error("fixture stdin write threw"); }) as typeof writeThrow.child.stdin.write;
  await assert.rejects(writeThrow.initialize(), /fixture stdin write threw/u);
  assert.equal(writeThrow.pending.size, 0);
  writeThrow.close();

  const writeFailure = new McpStdioClient(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const originalWrite = writeFailure.child.stdin.write.bind(writeFailure.child.stdin);
  writeFailure.child.stdin.write = ((chunk: string, callback?: (error?: Error | null) => void) => {
    if (callback) { callback(new Error("fixture stdin write failed")); return false; }
    return originalWrite(chunk);
  }) as typeof writeFailure.child.stdin.write;
  await assert.rejects(writeFailure.initialize(), /fixture stdin write failed/u);
  assert.equal(writeFailure.pending.size, 0, "failed writes must not leave a hanging pending request");
  (writeFailure as unknown as { failAll(error: Error): void }).failAll(new Error("second failure notification"));
  writeFailure.close();

  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const exited = new McpStdioClient(process.execPath, [fixturePath]);
  try {
    await exited.initialize();
    await assert.rejects(exited.call("fixture_child_exit"), /exited with code 7/u);
    await assert.rejects(exited.call("after_child_exit"), /child is closed/u);
  } finally { exited.close(); }
});

test("distillation default fetch transport stays credential gated before network access", async () => {
  const f = fixture();
  const coverageProvider: ModelProviderSpec = { ...provider, api_key_env: "CRAFT_WORKER_COVERAGE_MISSING_KEY" };
  const client: ExperienceLearningClient = { async call(name, args) {
    if (name === "craft_evaluation_model_profile_get") return { profile: { provider: "test", model: "test-model" }, readiness: { status: "ready_for_adapter" } };
    return f.client.call(name, args);
  } };
  const previousKey = process.env[coverageProvider.api_key_env];
  delete process.env[coverageProvider.api_key_env];
  try {
    await assert.rejects(runDistillationOnce({ client, providers: [coverageProvider] }), /set CRAFT_WORKER_COVERAGE_MISSING_KEY/u);
  } finally {
    if (previousKey === undefined) delete process.env[coverageProvider.api_key_env];
    else process.env[coverageProvider.api_key_env] = previousKey;
  }
});

test("worker MCP command configuration defaults safely and validates argument arrays", () => {
  assert.deepEqual(mcpCommandOptions({}), { command: "craft-mcp", args: ["--surface", "component-context-daily"] });
  assert.deepEqual(mcpCommandOptions({ CRAFT_EXPERIENCE_MCP_COMMAND: " custom-mcp ", CRAFT_EXPERIENCE_MCP_ARGS: "[\"--surface\",\"component-experience\"]" }),
    { command: "custom-mcp", args: ["--surface", "component-experience"] });
  assert.throws(() => mcpCommandOptions({ CRAFT_EXPERIENCE_MCP_ARGS: "not-json" }), /JSON/u);
  assert.throws(() => mcpCommandOptions({ CRAFT_EXPERIENCE_MCP_ARGS: "[1]" }), /string array/u);
});

test("polling worker exits cleanly after a termination signal", async () => {
  const workerPath = fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(new URL("./fixtures/experience-learning-mcp-fixture.cjs", import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), "craft-learning-worker-poll-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath], { env: {
    ...process.env, CRAFT_DATA_DIR: dataDir, CODEX_HOME: join(dataDir, "codex-home"), CRAFT_EXPERIENCE_MCP_COMMAND: process.execPath, CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([fixturePath]), CRAFT_EXPERIENCE_POLL_MS: "1000",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", stopping = false;
  child.stdout.setEncoding("utf8").on("data", chunk => {
    stdout += chunk;
    if (!stopping) { stopping = true; child.kill("SIGTERM"); }
  });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? -1));
  });
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout.trim()), { processed: 0, outcomes: [], evaluation: { processed: 0, outcomes: [] }, session_collection: emptySessionCollection(dataDir),
    knowledge: { sources_seen: 0, sources_selected: 0, outcomes: [], skipped_sources: 0, classification: { processed: 0, outcomes: [] } } });
  rmSync(dataDir, { recursive: true, force: true });
});

test("runOnce contains scenario-classification queue failures and continues evaluation", async () => {
  const client: ExperienceLearningClient = { async call(name) {
    if (name === "craft_evaluation_model_ticket_list") return { tickets: [{ id: "classification-ticket", purpose: "workflow_evolution",
      target: { kind: "experience_scenario_classification_request", id: "request-1", version: 1, scope: "project:craft" },
      readiness: { status: "ready_for_adapter" } }] };
    if (name === "craft_evaluation_model_profile_get") throw new Error("profile unavailable");
    if (name === "craft_experience_learning_evaluation_dispatch_list") return { dispatches: [] };
    throw new Error(`unexpected tool ${name}`);
  } };
  const result = await runOnce({ client });
  assert.equal(result.failure_kind, "Error");
  assert.deepEqual(result.scenario_classification, { status: "failed", failure_kind: "Error" });
  assert.equal((result.evaluation as JsonObject).processed, 0);
});

test("Knowledge worker incrementally executes session candidate, held-out evaluation and adjudication stages", async () => {
  for (const stage of ["session_candidate", "session_evaluation"] as const) {
    for (const malformedState of [false, true]) {
      const dataDir = mkdtempSync(join(tmpdir(), "craft-knowledge-stage-worker-"));
      const codexHome = join(dataDir, "codex-home");
      const knowledgeDir = join(dataDir, "knowledge");
      mkdirSync(join(codexHome, "sessions"), { recursive: true });
      mkdirSync(knowledgeDir, { recursive: true });
      const cursorPath = join(knowledgeDir, "learning-stage-cursor.json");
      const stageCursor = stage === "session_candidate" ? 1 : 2;
      writeFileSync(cursorPath, JSON.stringify({ schema: "craft.knowledge-learning-stage-cursor.v1", cursor: stageCursor }));
      const stageStatePath = join(knowledgeDir, stage === "session_candidate" ? "session-candidate-state.json" : "session-evaluation-state.json");
      if (malformedState) writeFileSync(stageStatePath, "invalid state");
      const client: ExperienceLearningClient = { async call(name) { throw new Error(`unexpected MCP call ${name}`); } };
      try {
        const result = await runLearningTick({ client, env: { ...process.env, CRAFT_DATA_DIR: dataDir, CODEX_HOME: codexHome },
          knowledge_stage_cursor_file: cursorPath }, false, ["knowledge"], async () => ({ status: "completed", tasks_indexed: 0 }));
        assert.deepEqual(result.session_collection, { status: "completed", tasks_indexed: 0 });
        const knowledge = result.knowledge as JsonObject;
        assert.ok(knowledge);
        if (malformedState) {
          assert.equal(stage === "session_candidate" ? knowledge.task_candidates && (knowledge.task_candidates as JsonObject).status : knowledge.evaluation_cases && (knowledge.evaluation_cases as JsonObject).status, "failed");
          assert.equal(knowledge.failure_kind, "SyntaxError");
        } else {
          assert.equal(knowledge.task_candidates, undefined);
          assert.equal(knowledge.evaluation_cases, undefined);
        }
      } finally { rmSync(dataDir, { recursive: true, force: true }); }
    }
  }
  const dataDir = mkdtempSync(join(tmpdir(), "craft-knowledge-adjudication-stage-"));
  const cursorPath = join(dataDir, "knowledge", "learning-stage-cursor.json");
  mkdirSync(join(dataDir, "knowledge"), { recursive: true });
  writeFileSync(cursorPath, JSON.stringify({ schema: "craft.knowledge-learning-stage-cursor.v1", cursor: 3 }));
  const idleClient: ExperienceLearningClient = { async call(name) {
    if (name === "craft_knowledge_evaluation_case_list") return { cases: [], has_more: false, next_cursor: null };
    if (name === "craft_knowledge_evaluation_run_list") return { runs: [] };
    throw new Error(`unexpected MCP call ${name}`);
  } };
  try {
    const result = await runLearningTick({ client: idleClient, env: { ...process.env, CRAFT_DATA_DIR: dataDir }, knowledge_stage_cursor_file: cursorPath }, false, ["knowledge"],
      async () => ({ status: "completed", tasks_indexed: 0 }));
    assert.equal((result.knowledge as JsonObject).session_adjudication, undefined, "idle adjudication stage avoids unnecessary model work");
    writeFileSync(cursorPath, JSON.stringify({ schema: "craft.knowledge-learning-stage-cursor.v1", cursor: 3 }));
    const failingClient: ExperienceLearningClient = { async call(name) {
      if (name === "craft_knowledge_evaluation_case_list") throw new TypeError("private failure detail");
      throw new Error(`unexpected MCP call ${name}`);
    } };
    const failed = await runLearningTick({ client: failingClient, env: { ...process.env, CRAFT_DATA_DIR: dataDir }, knowledge_stage_cursor_file: cursorPath }, false,
      ["knowledge"], async () => ({ status: "completed", tasks_indexed: 0 }));
    assert.deepEqual((failed.knowledge as JsonObject).session_adjudication, { status: "failed", failure_kind: "TypeError", raw_content_stored: false });
    assert.equal((failed.knowledge as JsonObject).failure_kind, "TypeError");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
  const noOp: ExperienceLearningClient = { async call() { throw new Error("no component should call the Host"); } };
  assert.equal((await runLearningTick({ client: noOp, contentLanguage: "en", env: directWorkerEnv }, false, [])).knowledge, null);
  const configuredDataDir = mkdtempSync(join(tmpdir(), "craft-learning-worker-language-config-"));
  try {
    mkdirSync(join(configuredDataDir, "config"), { recursive: true });
    writeFileSync(join(configuredDataDir, "config", "config.json"), JSON.stringify({ schemaVersion: 1, contentLanguage: "zh-CN", activeMode: "agent",
      initializedAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", runtime: { kind: "unconfigured" }, supervisor: { hosts: [] },
      storage: { database: join(configuredDataDir, "db", "craft.db"), capabilityIndex: join(configuredDataDir, "index", "capabilities.db") } }));
    assert.equal((await runLearningTick({ client: noOp, env: { ...process.env, CRAFT_DATA_DIR: configuredDataDir } }, false, [])).knowledge, null);
  } finally { rmSync(configuredDataDir, { recursive: true, force: true }); }
});

test("runOnce classifies a verified task before distillation while using one model call", async () => {
  let pending = true, modelCalls = 0;
  const context: JsonObject = { sanitized: true, content_stored: false, task_goal: "Repair validation", effect_summary: "Focused checks pass",
    outcome: "passed", observed_paths: ["src/validation.ts"], verification_ref: "test:focused", host: "codex", task_id: "task-1",
    turn_id: "turn-1", context_receipt_id: "receipt-1", observation_id: "workflow_evolution_observation_123" };
  const client: ExperienceLearningClient = { async call(name) {
    if (name === "craft_evaluation_model_ticket_list") return { tickets: pending ? [{ id: "scenario-ticket", purpose: "workflow_evolution", profile_id: "profile-1",
      profile_version: 1, target: { kind: "experience_scenario_classification_request", id: "scenario-request", version: 1, scope: "project:craft" },
      readiness: { status: "ready_for_adapter" } }] : [] };
    if (name === "craft_evaluation_model_profile_get") return { profile: { provider: "test", model: "test-model", version: 1, max_attempts: 1,
      max_output_tokens: 256, temperature: 0 }, readiness: { status: "ready_for_adapter" } };
    if (name === "craft_experience_scenario_classification_request_get") return { request: { id: "scenario-request", version: 1, status: "awaiting_model", context },
      taxonomy: { catalog_version: 0, scenarios: [] } };
    if (name === "craft_learning_cycle_finalize") return { status: "observed", observation: { id: context.observation_id,
      scenario_signature: { schema: "craft.scenario-signature.v1", project: "project:craft" } },
      scenario_catalog: { scenario_key: "validation.repair", status: "candidate", catalog_version: 1 } };
    if (name === "craft_experience_scenario_classification_request_complete") return { request: { version: 2 } };
    if (name === "craft_evaluation_model_ticket_complete") { pending = false; return {}; }
    if (name === "craft_experience_learning_evaluation_dispatch_list") return { dispatches: [] };
    if (name.startsWith("craft_trace_")) return {};
    throw new Error(`unexpected tool ${name}`);
  } };
  const transport: ModelTransport = { acquireCall: () => true, async complete(): Promise<ChatResult> {
    modelCalls += 1;
    return { text: JSON.stringify({ decision: "classified", scenario_key: "validation.repair", scenario_definition: {
      summary: "Validation repair", applies_when: "Code changes need validation", excludes: "Documentation-only work" } }),
      model: "test-model", usage: null };
  } };
  const result = await runOnce({ client, providers: [provider], transport });
  assert.equal(modelCalls, 1);
  assert.equal(((result.scenario_classification as JsonObject).outcomes as JsonObject[])[0]?.status, "classified");
  assert.equal((result.evaluation as JsonObject).processed, 0);
});
