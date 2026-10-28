import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResult, ModelProviderSpec, ModelTransport } from "../core/model-gateway.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { runExperienceScenarioClassificationOnce, type ExperienceScenarioClassificationClient } from "../deploy/experience-learning/experience-scenario-classification.ts";
import { readExperienceClassificationCursor, recordExperienceClassificationCursor, recordExperienceClassificationFailure, shouldSuppressExperienceClassification } from "../deploy/experience-learning/experience-classification-state.ts";

const provider: ModelProviderSpec = { provider: "test", label: "Test", protocol: "openai-compatible", base_url: "https://example.invalid/v1",
  api_key_env: "TEST_KEY", chat_path: "/chat/completions", models: { standard: "test-model" }, cost_hint: 0, supports_tools: false };
const context: JsonObject = { sanitized: true, content_stored: false, task_goal: "Repair validation", effect_summary: "TypeScript checks pass",
  outcome: "passed", observed_paths: ["src/validation.ts"], verification_ref: "test:focused", host: "codex", task_id: "task-1", turn_id: "turn-1", source_session_id: "session-1",
  context_receipt_id: "receipt-1", observation_id: "workflow_evolution_observation_123", scenario_verifier_digest: "sha256:" + "a".repeat(64) };
const definition = { summary: "Focused validation repair", applies_when: "A code change needs focused validation", excludes: "Documentation-only changes" };
const classified = JSON.stringify({ decision: "classified", scenario_key: "validation.repair", scenario_definition: definition });

function fixture(options: { response?: string; ticket?: JsonObject | null; request?: JsonObject; taxonomy?: JsonObject; profile?: JsonObject;
  profileReadiness?: JsonObject; provider?: JsonObject | null; finalizeStatus?: string; throwOn?: string; throwName?: string;
  ticketResult?: JsonObject; completionEmpty?: boolean; throwRaw?: boolean; acquire?: boolean } = {}) {
  const calls: Array<{ name: string; args: JsonObject }> = [];
  const requests: unknown[] = [];
  const client: ExperienceScenarioClassificationClient = { async call(name, args = {}) {
    calls.push({ name, args });
    if (options.throwOn === name) { if (options.throwRaw) throw "controlled failure"; throw Object.assign(new Error("controlled failure"), { name: options.throwName ?? "TypeError" }); }
    if (name === "craft_evaluation_model_ticket_list") {
      const result = options.ticketResult ?? { tickets: options.ticket === null ? [] : [options.ticket ?? { id: "ticket-1", purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
        target: { kind: "experience_scenario_classification_request", id: "scenario_classification_1", version: 1, scope: "project:craft" },
        readiness: { status: "ready_for_adapter" } }] };
      return args.after_id === undefined ? result : { ...result, has_more: false, next_cursor: null };
    }
    if (name === "craft_evaluation_model_profile_get") return { profile: options.profile ?? { provider: "test", model: "test-model", version: 1, max_attempts: 1,
      max_output_tokens: 256, temperature: 0 }, readiness: options.profileReadiness ?? { status: "ready_for_adapter" }, ...(options.provider ? { provider: options.provider } : {}) };
    if (name === "craft_experience_scenario_classification_request_get") return { request: options.request ?? { id: "scenario_classification_1", version: 1, status: "awaiting_model",
      context, identity_digest: "sha256:" + "b".repeat(64) }, taxonomy: options.taxonomy ?? { catalog_version: 0, scenarios: [] } };
    if (name === "craft_learning_cycle_finalize") return { status: options.finalizeStatus ?? "observed",
      observation: { id: context.observation_id, scenario_signature: { schema: "craft.scenario-signature.v1", project: { kind: "project", id: "project:craft" } } },
      scenario_catalog: { scenario_key: "validation.repair", status: "candidate", catalog_version: 1 } };
    if (name === "craft_experience_scenario_classification_request_complete") return options.completionEmpty ? {} : { request: { id: "scenario_classification_1", version: 2, status: "classified" } };
    if (name === "craft_evaluation_model_ticket_complete" || name.startsWith("craft_trace_")) return {};
    throw new Error(`Unexpected tool ${name}`);
  } };
  const transport: ModelTransport = { acquireCall: () => options.acquire ?? true,
    async complete(_spec, request): Promise<ChatResult> {
      if (options.throwOn === "transport.complete") { if (options.throwRaw) throw "controlled failure"; throw Object.assign(new Error("controlled failure"), { name: options.throwName ?? "TypeError" }); }
      requests.push(request);
      return { text: options.response ?? classified, model: "test-model", usage: { input_tokens: 10, output_tokens: 20 } };
    } };
  return { client, transport, calls, requests };
}

test("classifies a verified task and links the model decision through the normal finalize path", async () => {
  const f = fixture();
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal(result.processed, 1);
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
  const completion = f.calls.find(call => call.name === "craft_evaluation_model_ticket_complete");
  assert.equal(completion?.args.trace_id, (result.outcomes as JsonObject[])[0]?.trace_id);
  const finalize = f.calls.find(call => call.name === "craft_learning_cycle_finalize");
  assert.equal(finalize?.args.scenario_key, "validation.repair");
  assert.equal(finalize?.args.session_id, "session-1");
  assert.equal(finalize?.args.expected_scenario_catalog_version, 0);
  assert.equal(f.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.request")?.args.source, "model-transport:test");
  const modelCompleted = f.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.completed");
  assert.equal(modelCompleted?.args.source, "model-transport:test");
  assert.deepEqual(modelCompleted?.args.usage, { input_tokens: 10, output_tokens: 20 });
  assert.match(String((modelCompleted?.args.data as JsonObject | undefined)?.response_digest), /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(modelCompleted?.args ?? {}, "text"), false);
  assert.deepEqual(f.calls.filter(call => call.name === "craft_trace_finalize").map(call => call.args.status), ["completed"]);
});

test("Experience scenario descriptions follow the configured output language", async () => {
  const f = fixture();
  await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport, contentLanguage: "en-US" });
  const messages = ((f.requests[0] as { body: { messages: JsonObject[] } }).body.messages);
  assert.match(String(messages[0]?.content), /English \(en-US\)/u);
});

test("does not invent a session identifier for legacy classification requests", async () => {
  const legacyContext = { ...context };
  delete legacyContext.source_session_id;
  const f = fixture({ request: { id: "scenario_classification_1", version: 1, status: "awaiting_model", context: legacyContext,
    identity_digest: "sha256:" + "b".repeat(64) } });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
  const finalize = f.calls.find(call => call.name === "craft_learning_cycle_finalize");
  assert.equal(Object.hasOwn(finalize?.args ?? {}, "session_id"), false);
});

test("keeps ambiguous verified work unclassified and records completion", async () => {
  const f = fixture({ response: JSON.stringify({ decision: "unclassified" }) });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "unclassified");
  assert.equal(f.calls.some(call => call.name === "craft_learning_cycle_finalize"), false);
  assert.equal(f.calls.some(call => call.name === "craft_experience_scenario_classification_request_complete"), true);
});

test("reuses an existing parent scene and records the fine observation", async () => {
  const response = JSON.stringify({ decision: "classified", scenario_key: "validation.repair", scenario_definition: definition,
    coarse_scenario_key: "validation", coarse_scenario_definition: definition });
  const f = fixture({ response });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
  const finalize = f.calls.find(call => call.name === "craft_learning_cycle_finalize");
  assert.equal(finalize?.args.coarse_scenario_key, "validation");
  assert.equal((result.outcomes as JsonObject[])[0]?.observation_id, context.observation_id);
});

test("returns an empty result when no classification ticket is queued", async () => {
  const f = fixture({ ticket: null });
  assert.deepEqual(await runExperienceScenarioClassificationOnce({ client: f.client }), { processed: 0, outcomes: [] });
});

test("skips tickets that are not ready for the adapter", async () => {
  const f = fixture({ ticket: { id: "ticket-1", purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
    target: { kind: "experience_scenario_classification_request", id: "request-1", version: 1, scope: "project:craft" },
    readiness: { status: "waiting", next_action: "configure_profile" } } });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client });
  assert.equal(result.reason, "configure_profile");
  assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_profile_get"), false);
});

test("a ticket awaiting profile readiness does not block another ready ticket", async () => {
  const makeTicket = (id: string, status: string) => ({ id, purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
    target: { kind: "experience_scenario_classification_request", id: "scenario_classification_1", version: 1, scope: "project:craft" },
    readiness: { status } });
  const f = fixture({ ticketResult: { tickets: [makeTicket("waiting", "waiting"), makeTicket("ready", "ready_for_adapter")] } });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.ticket_id, "ready");
  assert.equal(f.requests.length, 1);
});

test("skips a profile that is not ready for the adapter", async () => {
  const f = fixture({ profileReadiness: { status: "waiting", next_action: "profile_incomplete" } });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider] });
  assert.equal(result.reason, "profile_incomplete");
});

test("reports a resolved request with a stale ticket as an unknown result without fabricating completion", async () => {
  const f = fixture({ request: { id: "scenario_classification_1", version: 2, status: "classified", result_digest: "sha256:" + "c".repeat(64) } });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider] });
  assert.equal(result.reason, "resolved_request_reference_stale");
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "model_result_unknown");
  assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_ticket_complete"), false);
  assert.equal(f.calls.some(call => call.name === "craft_trace_start"), false);
});

test("persists an unknown classification checkpoint without rewriting it on retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "craft-reconciliation-"));
  try {
    const stateFile = join(directory, "attempts.json");
    const f = fixture({ request: { id: "scenario_classification_1", version: 2, status: "unclassified", result_digest: "sha256:" + "c".repeat(64) } });
    const deps = { client: f.client, providers: [provider], state_file: stateFile };
    await runExperienceScenarioClassificationOnce(deps);
    const entryDirectory = readdirSync(directory).find(name => name.includes(".reconciliation.") && name.endsWith(".entries"));
    assert.ok(entryDirectory);
    const checkpoint = join(directory, entryDirectory, readdirSync(join(directory, entryDirectory))[0]!);
    const first = readFileSync(checkpoint, "utf8");
    const failure = (JSON.parse(first) as { failure: { failure_code: string; reconciliation: JsonObject } }).failure;
    assert.equal(failure.failure_code, "model_result_unknown");
    assert.deepEqual(failure.reconciliation, { ticket_id: "ticket-1", request_id: "scenario_classification_1", scope: "project:craft",
      target_version: 1, request_version: 2, request_status: "unclassified", result_digest: "sha256:" + "c".repeat(64) });
    await runExperienceScenarioClassificationOnce(deps);
    assert.equal(readFileSync(checkpoint, "utf8"), first);
    assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_ticket_complete"), false);
    failure.reconciliation.scope = "project:other";
    writeFileSync(checkpoint, JSON.stringify({ ...JSON.parse(first), failure }));
    assert.equal((await runExperienceScenarioClassificationOnce(deps)).reconciliation_checkpoint_failed, true);
    failure.reconciliation.ticket_id = "ticket-other";
    writeFileSync(checkpoint, JSON.stringify({ ...JSON.parse(first), failure }));
    assert.equal((await runExperienceScenarioClassificationOnce(deps)).reconciliation_checkpoint_failed, true);
    const missingIdentity = JSON.parse(first) as { failure: { reconciliation?: JsonObject } };
    delete missingIdentity.failure.reconciliation;
    writeFileSync(checkpoint, JSON.stringify(missingIdentity));
    assert.equal((await runExperienceScenarioClassificationOnce(deps)).reconciliation_checkpoint_failed, true);
    const invalidStatus = JSON.parse(first) as { failure: { failure_code: string } };
    invalidStatus.failure.failure_code = "other";
    writeFileSync(checkpoint, JSON.stringify(invalidStatus));
    assert.equal((await runExperienceScenarioClassificationOnce(deps)).reconciliation_checkpoint_failed, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("does not write a reconciliation checkpoint with an invalid request version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "craft-reconciliation-invalid-"));
  try {
    const f = fixture({ request: { id: "scenario_classification_1", version: "invalid", status: "unclassified", result_digest: "sha256:" + "c".repeat(64) } });
    const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], state_file: join(directory, "state") });
    assert.equal(result.reconciliation_checkpoint_failed, true);
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("continues to a ready ticket while reporting a stale resolved request", async () => {
  const makeTicket = (id: string) => ({ id, purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
    target: { kind: "experience_scenario_classification_request", id, version: 1, scope: "project:craft" },
    readiness: { status: "ready_for_adapter" } });
  const f = fixture({ ticketResult: { tickets: [makeTicket("stale"), makeTicket("ready")] } });
  const client: ExperienceScenarioClassificationClient = { async call(name, args = {}) {
    if (name === "craft_experience_scenario_classification_request_get" && args.request_id === "stale") {
      return { request: { id: "stale", version: 2, status: "unclassified", result_digest: "sha256:" + "c".repeat(64) }, taxonomy: {} };
    }
    return f.client.call(name, args);
  } };
  const result = await runExperienceScenarioClassificationOnce({ client, providers: [provider], transport: f.transport });
  assert.equal(result.reconciliation_pending, true);
  assert.equal(result.processed, 1);
  assert.equal((result.outcomes as JsonObject[])[0]?.ticket_id, "ready");
  assert.equal(f.requests.length, 1);
  assert.equal(f.calls.filter(call => call.name === "craft_evaluation_model_ticket_complete").length, 1);
});

test("continues to another ticket when reconciliation checkpoint cannot be saved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "craft-reconciliation-skip-"));
  try {
    const makeTicket = (id: string) => ({ id, purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
      target: { kind: "experience_scenario_classification_request", id, version: 1, scope: "project:craft" }, readiness: { status: "ready_for_adapter" } });
    const f = fixture({ ticketResult: { tickets: [makeTicket("stale"), makeTicket("ready")], has_more: false, next_cursor: null } });
    const client: ExperienceScenarioClassificationClient = { async call(name, args = {}) {
      if (name === "craft_experience_scenario_classification_request_get" && args.request_id === "stale") {
        return { request: { id: "stale", version: "invalid", status: "unclassified", result_digest: "sha256:" + "c".repeat(64) }, taxonomy: {} };
      }
      return f.client.call(name, args);
    } };
    const result = await runExperienceScenarioClassificationOnce({ client, providers: [provider], transport: f.transport, state_file: join(directory, "state") });
    assert.equal(result.processed, 1);
    assert.equal(result.reconciliation_pending, true);
    assert.equal(result.reconciliation_checkpoint_failed, true);
    assert.equal(f.requests.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("leaves a request stale when its version changed without a result", async () => {
  const f = fixture({ request: { id: "scenario_classification_1", version: 2, status: "awaiting_model" } });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider] });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "stale");
});

test("stops before calling the model when the shared tick budget is exhausted", async () => {
  const f = fixture({ acquire: false });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal(result.reason, "model_call_budget_exhausted");
  assert.equal(f.calls.some(call => call.name === "craft_trace_start"), false);
});

test("reports model and finalize failures without leaking error messages", async () => {
  const transportFailure = fixture({ throwOn: "transport.complete" });
  const failedCall = await runExperienceScenarioClassificationOnce({ client: transportFailure.client, providers: [provider], transport: transportFailure.transport });
  assert.equal((failedCall.outcomes as JsonObject[])[0]?.failure_kind, "TypeError");
  assert.equal((failedCall.outcomes as JsonObject[])[0]?.failure_stage, "model_request");
  const modelFailure = transportFailure.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.failed");
  assert.equal(modelFailure?.args.source, "model-transport:test");
  assert.equal((modelFailure?.args.data as JsonObject).failure_stage, "model_request");
  assert.equal(JSON.stringify(modelFailure?.args).includes("controlled failure"), false);
  const finalizeFailure = fixture({ finalizeStatus: "rejected" });
  const rejected = await runExperienceScenarioClassificationOnce({ client: finalizeFailure.client, providers: [provider], transport: finalizeFailure.transport });
  assert.equal((rejected.outcomes as JsonObject[])[0]?.status, "failed");
  assert.equal((rejected.outcomes as JsonObject[])[0]?.failure_kind, "classification_link_rejected");
  assert.equal((rejected.outcomes as JsonObject[])[0]?.failure_stage, "classification_link");
  const classificationFailure = finalizeFailure.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "classification.failed");
  assert.equal((classificationFailure?.args.data as JsonObject).failure_stage, "classification_link");
});

test("keeps model request failures retryable when persistent classification state is enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-classification-request-retry-"));
  try {
    const f = fixture({ throwOn: "transport.complete" });
    const deps = { client: f.client, providers: [provider], transport: f.transport, state_file: join(root, "attempts.json") };
    const first = await runExperienceScenarioClassificationOnce(deps);
    const second = await runExperienceScenarioClassificationOnce(deps);
    assert.equal((first.outcomes as JsonObject[])[0]?.failure_stage, "model_request");
    assert.equal((second.outcomes as JsonObject[])[0]?.failure_stage, "model_request");
    assert.equal(f.calls.filter(call => call.name === "craft_trace_start").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retries a failed classification with a fresh trace", async () => {
  const f = fixture();
  let attempts = 0;
  const traces = new Set<string>();
  const traceIds: string[] = [];
  const client: ExperienceScenarioClassificationClient = { async call(name, args = {}) {
    if (name === "craft_trace_start") {
      const traceId = String(args.trace_id);
      traceIds.push(traceId);
      traces.add(traceId);
    }
    if (name === "craft_trace_append" && traces.has(String(args.trace_id)) && traceIds.lastIndexOf(String(args.trace_id)) !== traceIds.indexOf(String(args.trace_id))) {
      throw new Error("Cannot append to a terminal Trace");
    }
    if (name === "craft_trace_finalize") traces.delete(String(args.trace_id));
    return f.client.call(name, args);
  } };
  const transport: ModelTransport = { acquireCall: () => true, async complete(): Promise<ChatResult> {
    attempts++;
    if (attempts === 1) throw new Error("controlled model failure");
    return { text: classified, model: "test-model", usage: { input_tokens: 10, output_tokens: 20 } };
  } };

  const first = await runExperienceScenarioClassificationOnce({ client, providers: [provider], transport });
  const second = await runExperienceScenarioClassificationOnce({ client, providers: [provider], transport });
  assert.equal((first.outcomes as JsonObject[])[0]?.status, "failed");
  assert.equal((first.outcomes as JsonObject[])[0]?.failure_kind, "model_request_failed");
  assert.equal((second.outcomes as JsonObject[])[0]?.status, "classified");
  assert.equal(traceIds.length, 2);
  assert.notEqual(traceIds[0], traceIds[1]);
});

test("rejects unsafe task paths before creating a model trace", async () => {
  const unsafe = { ...context, observed_paths: ["../.env"] };
  const f = fixture({ request: { id: "scenario_classification_1", version: 1, status: "awaiting_model", context: unsafe } });
  await assert.rejects(runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider] }), /unsafe paths/u);
  assert.equal(f.calls.some(call => call.name === "craft_trace_start"), false);
});

test("rejects malformed classifier decisions and logs the failure", async () => {
  const f = fixture({ response: JSON.stringify({ decision: "classified", scenario_key: "bad key", scenario_definition: definition }) });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "failed");
  assert.equal((result.outcomes as JsonObject[])[0]?.failure_stage, "model_response");
  assert.deepEqual(f.calls.filter(call => call.name === "craft_trace_finalize").map(call => call.args.status), ["failed"]);
});

test("rejects malformed JSON and scenario definitions", async () => {
  const invalidJson = fixture({ response: "not-json" });
  const invalidJsonResult = await runExperienceScenarioClassificationOnce({ client: invalidJson.client, providers: [provider], transport: invalidJson.transport });
  assert.equal((invalidJsonResult.outcomes as JsonObject[])[0]?.failure_kind, "model_response_rejected");
  assert.equal((invalidJsonResult.outcomes as JsonObject[])[0]?.failure_stage, "model_response");
  const invalidDefinition = fixture({ response: JSON.stringify({ decision: "classified", scenario_key: "valid.key",
    scenario_definition: { ...definition, excludes: "" } }) });
  const invalidDefinitionResult = await runExperienceScenarioClassificationOnce({ client: invalidDefinition.client, providers: [provider], transport: invalidDefinition.transport });
  assert.equal((invalidDefinitionResult.outcomes as JsonObject[])[0]?.status, "failed");
});

test("accepts an existing coarse parent without a new parent definition", async () => {
  const f = fixture({ response: JSON.stringify({ decision: "classified", scenario_key: "validation.repair", scenario_definition: definition,
    coarse_scenario_key: "validation" }), request: { id: "scenario_classification_1", version: 1, status: "awaiting_model",
    context: { ...context, project_root: "/repo" } }, taxonomy: { catalog_version: 1, scenarios: [
      { scenario_key: "validation", tier: "coarse", lifecycle: "active", definition },
    ] } });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
  assert.equal(f.calls.find(call => call.name === "craft_learning_cycle_finalize")?.args.project_root, "/repo");
});

test("rejects a coarse definition without a parent key and an identical parent key", async () => {
  for (const addition of [{ coarse_scenario_definition: definition }, { coarse_scenario_key: "validation.repair" }]) {
    const f = fixture({ response: JSON.stringify({ decision: "classified", scenario_key: "validation.repair", scenario_definition: definition, ...addition }) });
    const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
    assert.equal((result.outcomes as JsonObject[])[0]?.status, "failed");
  }
});

test("requires definitions for new coarse scenes and rejects conflicted or retired taxonomy keys", async () => {
  const newCoarse = fixture({ response: JSON.stringify({ decision: "classified", scenario_key: "validation.repair", scenario_definition: definition,
    coarse_scenario_key: "new-parent" }) });
  const newCoarseResult = await runExperienceScenarioClassificationOnce({ client: newCoarse.client, providers: [provider], transport: newCoarse.transport });
  assert.equal((newCoarseResult.outcomes as JsonObject[])[0]?.status, "failed");
  for (const lifecycle of ["conflicted", "retired"]) {
    const unavailable = fixture({ taxonomy: { catalog_version: 1, scenarios: [{ scenario_key: "validation.repair", tier: "fine", lifecycle, definition }] } });
    const result = await runExperienceScenarioClassificationOnce({ client: unavailable.client, providers: [provider], transport: unavailable.transport });
    assert.equal((result.outcomes as JsonObject[])[0]?.status, "failed");
    const unavailableParent = fixture({ response: JSON.stringify({ decision: "classified", scenario_key: "validation.repair", scenario_definition: definition,
      coarse_scenario_key: "validation" }), taxonomy: { catalog_version: 1, scenarios: [{ scenario_key: "validation", tier: "coarse", lifecycle, definition }] } });
    const parentResult = await runExperienceScenarioClassificationOnce({ client: unavailableParent.client, providers: [provider], transport: unavailableParent.transport });
    assert.equal((parentResult.outcomes as JsonObject[])[0]?.status, "failed");
  }
});

test("skips invalid scope and missing profile providers", async () => {
  const invalidScope = fixture({ ticket: { id: "ticket-1", purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
    target: { kind: "experience_scenario_classification_request", id: "request-1", version: 1, scope: "global" }, readiness: { status: "ready_for_adapter" } } });
  await assert.rejects(runExperienceScenarioClassificationOnce({ client: invalidScope.client, providers: [provider] }), /scope is invalid/u);
  const noProvider = fixture({ profile: { provider: "missing", model: "test-model", version: 1 }, profileReadiness: { status: "ready_for_adapter" } });
  const result = await runExperienceScenarioClassificationOnce({ client: noProvider.client, providers: [] });
  assert.equal(result.reason, "provider_unavailable");
});

test("reports resolved unclassified requests as unknown and skips unsupported queue entries", async () => {
  const resolved = fixture({ request: { id: "scenario_classification_1", version: 2, status: "unclassified", result_digest: "sha256:" + "c".repeat(64) } });
  assert.equal((await runExperienceScenarioClassificationOnce({ client: resolved.client, providers: [provider] })).reason, "resolved_request_reference_stale");
  const unsupported = fixture({ ticket: { id: "ticket-1", purpose: "other", profile_id: "profile-1", profile_version: 1,
    target: { kind: "other", id: "other", version: 1 }, readiness: { status: "ready_for_adapter" } } });
  assert.deepEqual(await runExperienceScenarioClassificationOnce({ client: unsupported.client }), { processed: 0, outcomes: [] });
});

test("keeps classification retryable when finalize omits the exact observation and sanitizes error names", async () => {
  const noObservation = fixture();
  const client: ExperienceScenarioClassificationClient = { async call(name, args) {
    const result = await noObservation.client.call(name, args);
    return name === "craft_learning_cycle_finalize" ? { status: "observed", observation: {} } : result;
  } };
  const result = await runExperienceScenarioClassificationOnce({ client, providers: [provider], transport: noObservation.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "failed");
  assert.equal(noObservation.calls.some(call => call.name === "craft_experience_scenario_classification_request_complete"), false);
  const badName = fixture({ throwOn: "transport.complete", throwName: "bad name" });
  const failed = await runExperienceScenarioClassificationOnce({ client: badName.client, providers: [provider], transport: badName.transport });
  assert.equal((failed.outcomes as JsonObject[])[0]?.failure_kind, "Error");
});

test("rejects a classification receipt for another project or unavailable scene", async () => {
  for (const overrides of [
    { scenario_signature: { schema: "craft.scenario-signature.v1", project: { kind: "user", id: "project:craft" } } },
    { scenario_signature: { schema: "craft.scenario-signature.v1", project: { kind: "project", id: "project:other" } } },
    { scenario_signature: { schema: "craft.scenario-signature.v1", project: "project:other" } },
    { scenario_signature: { schema: "craft.scenario-signature.v1", project: null } },
    { scenario_signature: { schema: "craft.scenario-signature.v1", project: 42 } },
    { scenario_signature: { schema: "craft.scenario-signature.v1", project: [] } },
  ]) {
    const f = fixture();
    const client: ExperienceScenarioClassificationClient = { async call(name, args) {
      const result = await f.client.call(name, args);
      return name === "craft_learning_cycle_finalize" ? { ...result,
        observation: { id: context.observation_id, scenario_signature: overrides.scenario_signature } } : result;
    } };
    const result = await runExperienceScenarioClassificationOnce({ client, providers: [provider], transport: f.transport });
    assert.equal((result.outcomes as JsonObject[])[0]?.status, "failed");
  }
  const unavailable = fixture();
  const client: ExperienceScenarioClassificationClient = { async call(name, args) {
    const result = await unavailable.client.call(name, args);
    return name === "craft_learning_cycle_finalize" ? { ...result, scenario_catalog: { scenario_key: "validation.repair", status: "conflicted", catalog_version: 1 } } : result;
  } };
  const result = await runExperienceScenarioClassificationOnce({ client, providers: [provider], transport: unavailable.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "failed");
});

test("suppresses repeated model calls after deterministic rejection until the input changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-classification-state-"));
  try {
    const stateFile = join(root, "runtime", "experience-classification-attempts.json");
    const f = fixture();
    const client: ExperienceScenarioClassificationClient = { async call(name, args) {
      const result = await f.client.call(name, args);
      return name === "craft_learning_cycle_finalize" ? { ...result,
        observation: { id: context.observation_id, scenario_signature: { schema: "craft.scenario-signature.v1", project: { kind: "project", id: "project:other" } } } } : result;
    } };
    const deps = { client, providers: [provider], transport: f.transport, state_file: stateFile };
    const failed = await runExperienceScenarioClassificationOnce(deps);
    assert.equal((failed.outcomes as JsonObject[])[0]?.failure_kind, "classification_link_rejected");
    const attemptsBefore = f.requests.length;
    await recordExperienceClassificationCursor(stateFile, "");
    const suppressed = await runExperienceScenarioClassificationOnce(deps);
    assert.equal(suppressed.reason, "unchanged_input_failure_suppressed");
    assert.equal(f.requests.length, attemptsBefore);
    const entries = readdirSync(`${stateFile}.entries`);
    assert.equal(entries.length, 1);
    const persisted = JSON.parse(readFileSync(join(`${stateFile}.entries`, entries[0]!), "utf8")) as JsonObject;
    assert.equal(persisted.schema, "craft.experience-classification-attempt.v2");

    const changedClient: ExperienceScenarioClassificationClient = { async call(name, args) {
      const result = await client.call(name, args);
      if (name !== "craft_experience_scenario_classification_request_get") return result;
      return { ...result, taxonomy: { catalog_version: 1, scenarios: [] } };
    } };
    await runExperienceScenarioClassificationOnce({ ...deps, client: changedClient });
    assert.equal(f.requests.length, attemptsBefore + 1);
    await recordExperienceClassificationCursor(stateFile, "");
    const changedProfile: ExperienceScenarioClassificationClient = { async call(name, args) {
      const result = await client.call(name, args);
      if (name !== "craft_evaluation_model_profile_get") return result;
      return { ...result, profile: { ...(result.profile as JsonObject), max_output_tokens: 128 } };
    } };
    await runExperienceScenarioClassificationOnce({ ...deps, client: changedProfile });
    assert.equal(f.requests.length, attemptsBefore + 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a suppressed classification ticket does not starve the next ready ticket", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-classification-fairness-"));
  try {
    const stateFile = join(root, "attempts.json");
    const rejected = fixture({ response: "not-json" });
    await runExperienceScenarioClassificationOnce({ client: rejected.client, providers: [provider], transport: rejected.transport, state_file: stateFile });
    await recordExperienceClassificationCursor(stateFile, "");
    const ready = fixture();
    const tickets = ["ticket-1", "ticket-2"].map((id, index) => ({ id, purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
      target: { kind: "experience_scenario_classification_request", id: `scenario_classification_${index + 1}`, version: 1, scope: "project:craft" },
      readiness: { status: "ready_for_adapter" } }));
    const client: ExperienceScenarioClassificationClient = { async call(name, args = {}) {
      if (name === "craft_evaluation_model_ticket_list") return { tickets, has_more: false, next_cursor: null };
      const result = await ready.client.call(name, args);
      if (name === "craft_experience_scenario_classification_request_get") return { ...result, request: { ...(result.request as JsonObject), id: args.request_id } };
      return result;
    } };
    const result = await runExperienceScenarioClassificationOnce({ client, providers: [provider], transport: ready.transport, state_file: stateFile });
    assert.equal((result.outcomes as JsonObject[])[0]?.ticket_id, "ticket-2");
    assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
    assert.equal(ready.requests.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("classification advances through paged tickets and resumes its cursor after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-classification-pages-"));
  try {
    const stateFile = join(root, "attempts.json"), rejected = fixture({ response: "not-json" });
    await runExperienceScenarioClassificationOnce({ client: rejected.client, providers: [provider], transport: rejected.transport, state_file: stateFile });
    await recordExperienceClassificationCursor(stateFile, "");
    const ready = fixture({ response: JSON.stringify({ decision: "unclassified" }) });
    const ticket = (id: string) => ({ id, purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
      target: { kind: "experience_scenario_classification_request", id: `scenario_${id}`, version: 1, scope: "project:craft" },
      readiness: { status: "ready_for_adapter" } });
    const cursors: unknown[] = [];
    const client: ExperienceScenarioClassificationClient = { async call(name, args = {}) {
      if (name === "craft_evaluation_model_ticket_list") {
        cursors.push(args.after_id);
        if (args.after_id === "") return { tickets: [ticket("ticket-1")], has_more: true, next_cursor: "ticket-1" };
        if (args.after_id === "ticket-1") return { tickets: [ticket("ticket-2")], has_more: true, next_cursor: "ticket-2" };
        return { tickets: [ticket("ticket-3")], has_more: false, next_cursor: null };
      }
      return ready.client.call(name, args);
    } };
    const deps = { client, providers: [provider], transport: ready.transport, state_file: stateFile };
    const first = await runExperienceScenarioClassificationOnce(deps);
    assert.equal((first.outcomes as JsonObject[])[0]?.ticket_id, "ticket-2");
    assert.equal(ready.requests.length, 1);
    const second = await runExperienceScenarioClassificationOnce({ ...deps });
    assert.equal((second.outcomes as JsonObject[])[0]?.ticket_id, "ticket-3");
    assert.equal(ready.requests.length, 2);
    assert.deepEqual(cursors, ["", "ticket-1", "ticket-2"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("empty ticket pages advance within a bounded scan and resume on the next tick", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-empty-pages-"));
  try {
    const stateFile = join(root, "attempts.json"), seen: unknown[] = [];
    const client: ExperienceScenarioClassificationClient = { async call(name, args = {}) {
      assert.equal(name, "craft_evaluation_model_ticket_list");
      seen.push(args.after_id);
      const next = ({ "": "a", a: "b", b: "c", c: "d" } as Record<string, string>)[String(args.after_id)];
      return { tickets: [], has_more: next !== undefined, next_cursor: next ?? null };
    } };
    const first = await runExperienceScenarioClassificationOnce({ client, state_file: stateFile });
    assert.equal(first.reason, "ticket_scan_limit_reached");
    assert.equal(first.scan_has_more, true);
    assert.equal(readExperienceClassificationCursor(stateFile), "d");
    const second = await runExperienceScenarioClassificationOnce({ client, state_file: stateFile });
    assert.equal(second.processed, 0);
    assert.equal(readExperienceClassificationCursor(stateFile), "");
    assert.deepEqual(seen, ["", "a", "b", "c", "d"]);
    const invalid: ExperienceScenarioClassificationClient = { async call() { return { tickets: [], has_more: true, next_cursor: "" }; } };
    await assert.rejects(runExperienceScenarioClassificationOnce({ client: invalid, state_file: stateFile }), /cursor did not advance/u);
    const legacy: ExperienceScenarioClassificationClient = { async call() { return { tickets: [] }; } };
    await assert.rejects(runExperienceScenarioClassificationOnce({ client: legacy, state_file: stateFile }), /pagination is unavailable/u);

    const failed = fixture({ response: "not-json" }), otherState = join(root, "suppressed.json");
    await runExperienceScenarioClassificationOnce({ client: failed.client, providers: [provider], transport: failed.transport, state_file: otherState });
    await recordExperienceClassificationCursor(otherState, "");
    const pending = (await failed.client.call("craft_evaluation_model_ticket_list")).tickets;
    let page = 0;
    const withSuppressed: ExperienceScenarioClassificationClient = { async call(name, args = {}) {
      if (name === "craft_evaluation_model_ticket_list") {
        page++;
        return { tickets: page === 1 ? pending : [], has_more: true, next_cursor: `ticket-${page}` };
      }
      return failed.client.call(name, args);
    } };
    const bounded = await runExperienceScenarioClassificationOnce({ client: withSuppressed, providers: [provider], transport: failed.transport, state_file: otherState });
    assert.equal(bounded.scan_has_more, true);
    assert.equal((bounded.outcomes as JsonObject[])[0]?.ticket_id, "ticket-1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("keeps the classification failure visible when retry-state persistence is unsafe", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-classification-state-link-"));
  try {
    const runtimeDir = join(root, "runtime"), targetDir = join(root, "target");
    mkdirSync(targetDir);
    const f = fixture();
    const client: ExperienceScenarioClassificationClient = { async call(name, args) {
      const result = await f.client.call(name, args);
      if (name !== "craft_learning_cycle_finalize") return result;
      symlinkSync(targetDir, runtimeDir, "dir");
      return { ...result, observation: { id: context.observation_id,
        scenario_signature: { schema: "craft.scenario-signature.v1", project: { kind: "project", id: "project:other" } } } };
    } };
    await assert.rejects(runExperienceScenarioClassificationOnce({ client, providers: [provider], transport: f.transport,
      state_file: join(runtimeDir, "attempts.json") }), /directory must not be a symbolic link/u);
    assert.equal(f.calls.some(call => call.name === "craft_trace_finalize" && call.args.status === "failed"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validates persisted Experience classification retry state", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-classification-state-validation-"));
  try {
    const stateFile = join(root, "attempts.json"), digest = `sha256:${"a".repeat(64)}`;
    assert.equal(shouldSuppressExperienceClassification(stateFile, "ticket-1", digest, "0.12.123"), false);
    await recordExperienceClassificationFailure(stateFile, "ticket-1", { attempt_digest: digest, classifier_version: "0.12.123",
      failure_stage: "classification_link", failure_code: "classification_link_rejected", failed_at: new Date().toISOString() });
    await recordExperienceClassificationFailure(stateFile, "ticket-2", { attempt_digest: digest, classifier_version: "0.12.123",
      failure_stage: "classification_link", failure_code: "classification_link_rejected", failed_at: new Date().toISOString() });
    assert.equal(shouldSuppressExperienceClassification(stateFile, "ticket-1", digest, "0.12.123"), true);
    assert.equal(shouldSuppressExperienceClassification(stateFile, "ticket-1", digest, "0.12.124"), false);
    assert.equal(shouldSuppressExperienceClassification(stateFile, "ticket-1", `sha256:${"b".repeat(64)}`, "0.12.123"), false);
    assert.throws(() => shouldSuppressExperienceClassification(stateFile, "bad id", digest, "0.12.123"), /identity is invalid/u);
    await assert.rejects(recordExperienceClassificationFailure(stateFile, "bad id", { attempt_digest: digest, classifier_version: "0.12.123",
      failure_stage: "stage", failure_code: "failure", failed_at: new Date().toISOString() }), /identity is invalid/u);
    assert.equal(readExperienceClassificationCursor(stateFile), "");
    await recordExperienceClassificationCursor(stateFile, "项目 ticket");
    await recordExperienceClassificationCursor(stateFile, "项目 ticket");
    assert.equal(readExperienceClassificationCursor(stateFile), "项目 ticket");
    await assert.rejects(recordExperienceClassificationCursor(stateFile, "bad\0cursor"), /cursor identity is invalid/u);
    await recordExperienceClassificationFailure(stateFile, "ticket-3", { attempt_digest: digest, classifier_version: "0.12.123",
      failure_stage: "classification_link", failure_code: "classification_link_rejected", failed_at: new Date().toISOString() });
    assert.equal(readExperienceClassificationCursor(stateFile), "项目 ticket");

    const invalidFile = join(root, "invalid.json");
    writeFileSync(invalidFile, "{}");
    assert.throws(() => shouldSuppressExperienceClassification(invalidFile, "ticket-1", digest, "0.12.123"), /state is invalid/u);
    const linkedFile = join(root, "linked.json");
    symlinkSync(invalidFile, linkedFile);
    assert.throws(() => shouldSuppressExperienceClassification(linkedFile, "ticket-1", digest, "0.12.123"), /regular file/u);
    const linkedDir = join(root, "linked-dir");
    symlinkSync(root, linkedDir, "dir");
    assert.throws(() => shouldSuppressExperienceClassification(join(linkedDir, "attempts.json"), "ticket-1", digest, "0.12.123"), /directory must not be a symbolic link/u);

    const malformedFile = join(root, "malformed.json");
    writeFileSync(malformedFile, JSON.stringify({ schema: "craft.experience-classification-attempts.v1", attempts: { "ticket-1": { attempt_digest: "bad" } } }));
    assert.throws(() => shouldSuppressExperienceClassification(malformedFile, "ticket-1", digest, "0.12.123"), /state is invalid/u);
    writeFileSync(malformedFile, JSON.stringify({ schema: "craft.experience-classification-attempts.v1", attempts: { "ticket-1": null } }));
    assert.throws(() => shouldSuppressExperienceClassification(malformedFile, "ticket-1", digest, "0.12.123"), /state is invalid/u);
    const fullFile = join(root, "full.json"), many = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`ticket-${index}`, {
      attempt_digest: digest, classifier_version: "0.12.123", failure_stage: "classification_link", failure_code: "classification_link_rejected", failed_at: new Date().toISOString(),
    }]));
    writeFileSync(fullFile, JSON.stringify({ schema: "craft.experience-classification-attempts.v1", attempts: many }));
    assert.throws(() => shouldSuppressExperienceClassification(fullFile, "ticket-1", digest, "0.12.123"), /state is invalid/u);

    const legacyFile = join(root, "legacy.json"), failure = { attempt_digest: digest, classifier_version: "0.12.123",
      failure_stage: "classification_link", failure_code: "classification_link_rejected", failed_at: new Date().toISOString() };
    writeFileSync(legacyFile, JSON.stringify({ schema: "craft.experience-classification-attempts.v1", attempts: { "ticket-legacy": failure } }));
    assert.equal(shouldSuppressExperienceClassification(legacyFile, "ticket-legacy", digest, "0.12.123"), true);
    const replacement = `sha256:${"c".repeat(64)}`;
    await recordExperienceClassificationFailure(legacyFile, "ticket-legacy", { ...failure, attempt_digest: replacement });
    assert.equal(shouldSuppressExperienceClassification(legacyFile, "ticket-legacy", digest, "0.12.123"), false);
    assert.equal(shouldSuppressExperienceClassification(legacyFile, "ticket-legacy", replacement, "0.12.123"), true);

    const entryState = join(root, "entry-state.json");
    await recordExperienceClassificationFailure(entryState, "ticket-entry", failure);
    const entryDir = `${entryState}.entries`, entryFile = join(entryDir, readdirSync(entryDir)[0]!);
    writeFileSync(entryFile, "{}");
    assert.throws(() => shouldSuppressExperienceClassification(entryState, "ticket-entry", digest, "0.12.123"), /attempt is invalid/u);
    rmSync(entryFile);
    symlinkSync(invalidFile, entryFile);
    assert.throws(() => shouldSuppressExperienceClassification(entryState, "ticket-entry", digest, "0.12.123"), /attempt must be a regular file/u);
    rmSync(entryDir, { recursive: true });
    symlinkSync(root, entryDir, "dir");
    assert.throws(() => shouldSuppressExperienceClassification(entryState, "ticket-entry", digest, "0.12.123"), /directory must not be a symbolic link/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("classification suppression survives more than 500 distinct failed tickets", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-many-attempts-"));
  try {
    const stateFile = join(root, "attempts.json"), digest = `sha256:${"a".repeat(64)}`;
    for (let index = 0; index <= 500; index++) {
      await recordExperienceClassificationFailure(stateFile, `ticket-${index}`, { attempt_digest: digest, classifier_version: "0.12.123",
        failure_stage: "classification_link", failure_code: "classification_link_rejected", failed_at: new Date(1_700_000_000_000 + index).toISOString() });
    }
    assert.equal(shouldSuppressExperienceClassification(stateFile, "ticket-0", digest, "0.12.123"), true);
    assert.equal(shouldSuppressExperienceClassification(stateFile, "ticket-500", digest, "0.12.123"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("independent ticket checkpoints and the scan cursor survive concurrent writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-concurrent-attempts-"));
  try {
    const stateFile = join(root, "attempts.json"), digest = `sha256:${"b".repeat(64)}`;
    const failure = { attempt_digest: digest, classifier_version: "0.12.123", failure_stage: "classification_link",
      failure_code: "classification_link_rejected", failed_at: new Date().toISOString() };
    await Promise.all([
      ...Array.from({ length: 32 }, (_, index) => recordExperienceClassificationFailure(stateFile, `ticket-${index}`, failure)),
      recordExperienceClassificationCursor(stateFile, "ticket-31"),
    ]);
    for (let index = 0; index < 32; index++) assert.equal(shouldSuppressExperienceClassification(stateFile, `ticket-${index}`, digest, "0.12.123"), true);
    assert.equal(readExperienceClassificationCursor(stateFile), "ticket-31");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepts a legacy string project scope when linking a classified observation", async () => {
  const f = fixture();
  const client: ExperienceScenarioClassificationClient = { async call(name, args) {
    const result = await f.client.call(name, args);
    return name === "craft_learning_cycle_finalize" ? { ...result,
      observation: { id: context.observation_id, scenario_signature: { schema: "craft.scenario-signature.v1", project: "project:craft" } } } : result;
  } };
  const result = await runExperienceScenarioClassificationOnce({ client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
});

test("rejects malformed tool envelopes, identifiers, digests, and task context", async () => {
  const malformedTickets = fixture({ ticketResult: { tickets: [null] } });
  await assert.rejects(runExperienceScenarioClassificationOnce({ client: malformedTickets.client }), /must be an object/u);
  const missingTickets = fixture({ ticketResult: {} });
  await assert.rejects(runExperienceScenarioClassificationOnce({ client: missingTickets.client }), /must be an array/u);
  const invalidTicketId = fixture({ ticket: { id: "", purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
    target: { kind: "experience_scenario_classification_request", id: "request-1", version: 1, scope: "project:craft" }, readiness: { status: "ready_for_adapter" } } });
  await assert.rejects(runExperienceScenarioClassificationOnce({ client: invalidTicketId.client }), /bounded sanitized summary/u);
  const invalidDigest = fixture({ request: { id: "scenario_classification_1", version: 2, status: "classified", result_digest: "bad" } });
  assert.equal((await runExperienceScenarioClassificationOnce({ client: invalidDigest.client, providers: [provider] })).reconciliation_checkpoint_failed, true);
  const missingDigest = fixture({ request: { id: "scenario_classification_1", version: 2, status: "classified" } });
  assert.equal((await runExperienceScenarioClassificationOnce({ client: missingDigest.client, providers: [provider] })).reconciliation_pending, true);
  const unsanitized = fixture({ request: { id: "scenario_classification_1", version: 1, status: "awaiting_model", context: { ...context, sanitized: false } } });
  await assert.rejects(runExperienceScenarioClassificationOnce({ client: unsanitized.client, providers: [provider] }), /non-sanitized/u);
});

test("rejects invalid taxonomy versions and oversized classifier packets", async () => {
  const invalidVersion = fixture({ taxonomy: { catalog_version: "1", scenarios: [] } });
  await assert.rejects(runExperienceScenarioClassificationOnce({ client: invalidVersion.client, providers: [provider] }), /packet is invalid or oversized/u);
  const oversized = fixture({ taxonomy: { catalog_version: 1, scenarios: [{ scenario_key: "large", definition: "x".repeat(8_500) }] } });
  await assert.rejects(runExperienceScenarioClassificationOnce({ client: oversized.client, providers: [provider] }), /packet is invalid or oversized/u);
});

test("uses fallback readiness reasons and the built-in provider catalog", async () => {
  const ticketNotReady = fixture({ ticket: { id: "ticket-1", purpose: "workflow_evolution", profile_id: "profile-1", profile_version: 1,
    target: { kind: "experience_scenario_classification_request", id: "request-1", version: 1, scope: "project:craft" }, readiness: { status: "waiting" } } });
  assert.equal((await runExperienceScenarioClassificationOnce({ client: ticketNotReady.client })).reason, "model_profile_not_ready");
  const profileNotReady = fixture({ profileReadiness: { status: "waiting" } });
  assert.equal((await runExperienceScenarioClassificationOnce({ client: profileNotReady.client, providers: [provider] })).reason, "model_profile_not_ready");
  const builtInProvider = fixture({ profile: { provider: "codex-cli", model: "gpt-6-luna", version: 1 }, acquire: false });
  const skipped = await runExperienceScenarioClassificationOnce({ client: builtInProvider.client, transport: builtInProvider.transport });
  assert.equal(skipped.reason, "model_call_budget_exhausted");
});

test("constructs the default fetch transport when no transport was injected", async () => {
  const f = fixture({ profile: { provider: "test", model: "test-model", version: 1 } });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider] });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "failed");
  assert.equal((result.outcomes as JsonObject[])[0]?.failure_kind, "model_request_failed");
});

test("uses fallback output parameters and omits a missing completion version", async () => {
  const f = fixture({ profile: { provider: "test", model: "test-model", version: 1 }, completionEmpty: true });
  let maxTokens: unknown;
  const transport: ModelTransport = { async complete(_spec, request): Promise<ChatResult> {
    maxTokens = (request.body as JsonObject).max_tokens;
    return { text: classified, model: "test-model", usage: null };
  } };
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [provider], transport });
  assert.equal(maxTokens, 2_048);
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
});

test("uses an explicitly supplied provider declaration when the catalog does not contain it", async () => {
  const f = fixture({ profile: { provider: "custom", model: "custom-model", version: 1 }, provider: provider as unknown as JsonObject });
  const result = await runExperienceScenarioClassificationOnce({ client: f.client, providers: [], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
});

test("falls back to a safe class for non-Error exceptions and keeps absent output refs empty", async () => {
  const rawFailure = fixture({ throwOn: "transport.complete", throwRaw: true });
  const result = await runExperienceScenarioClassificationOnce({ client: rawFailure.client, providers: [provider], transport: rawFailure.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.failure_kind, "Error");
});
