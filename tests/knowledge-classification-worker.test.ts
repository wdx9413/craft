import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_CATALOG, type ChatResult, type ModelProviderSpec, type ModelTransport } from "../core/model-gateway.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { runKnowledgeScenarioClassificationOnce, type KnowledgeClassificationClient } from "../deploy/experience-learning/knowledge-classification.ts";

const provider: ModelProviderSpec = { provider: "test", label: "test", protocol: "openai-compatible", base_url: "https://example.invalid/v1",
  api_key_env: "TEST_KEY", chat_path: "/chat/completions", models: { standard: "test-model" }, cost_hint: 0, supports_tools: false };
const claim: JsonObject = { id: "claim-1", version: 1, status: "candidate", scope: "project:demo", kind: "fact", content: "Builds run with pnpm.",
  content_digest: "sha256:claim", source_id: "source-1", evidence_ids: ["evidence-1"], tags: ["build"] };

function fixture(modelText = '{"decision":"classified","scenario_key":"build.validation","scenario_definition":{"summary":"构建验证规则","applies_when":"适用于项目构建验收","excludes":"与构建无关的事实"},"coarse_scenario_key":"engineering","coarse_scenario_definition":{"summary":"工程主题","applies_when":"属于项目工程实践","excludes":"业务领域事实"}}', claimStatus = "candidate", claimScope: string = String(claim.scope)) {
  const calls: Array<{ name: string; args: JsonObject }> = [];
  const scopeKind = claimScope === "global" ? "global" : "project";
  const scopeId = scopeKind === "global" ? "global" : claimScope.split(":").slice(1).join(":");
  const scopeEnvelope = { applicability: { kind: scopeKind, id: scopeId },
    custody: { kind: scopeKind, id: scopeId }, audience: { mode: scopeKind === "global" ? "public" : "scoped", principal_ids: [] }, purpose: "fact", retention: "long_term", tenant_id: null };
  const client: KnowledgeClassificationClient = { async call(name, args = {}) {
    calls.push({ name, args });
    if (name === "craft_knowledge_claim_list") return { claims: [{ ...claim, status: claimStatus, scope: claimScope, scope_envelope: scopeEnvelope }] };
    if (name === "craft_evaluation_model_profile_ensure_single") return { status: "ready_for_adapter", profile: { id: "profile-1", version: 1,
      provider: "test", model: "test-model", max_attempts: 1, max_output_tokens: 256, temperature: 0 } };
    if (name === "craft_evaluation_model_profile_get") return { profile: { id: "profile-1", version: 1, provider: "test", model: "test-model",
      max_attempts: 1, max_output_tokens: 256, temperature: 0 }, readiness: { status: "ready_for_adapter" } };
    if (name === "craft_knowledge_scenario_list") return { catalog_version: 3, scenarios: [{ scenario_key: "engineering", tier: "coarse", lifecycle: "active",
      definition: { summary: "工程主题", applies_when: "属于项目工程实践", excludes: "业务领域事实" } }] };
    if (name === "craft_evaluation_model_ticket_issue") return { ticket: { id: "ticket-1", status: "ready_for_adapter" } };
    if (name === "craft_knowledge_claim_save") return { claim: { id: "claim-1", version: 2 } };
    if (name === "craft_evaluation_model_ticket_complete") return { ticket: { id: "ticket-1", status: "completed" } };
    throw new Error(`unexpected tool ${name}`);
  } };
  const transport: ModelTransport = { async complete(_spec, request): Promise<ChatResult> {
    const content = String((request.body.messages as JsonObject[])[1]?.content);
    assert.match(content, /Builds run with pnpm/u);
    assert.match(content, /engineering/u);
    const packet = JSON.parse(content) as JsonObject;
    assert.equal(packet.scope, claimScope);
    assert.match(JSON.stringify(packet.taxonomy), /definition/u);
    return { text: modelText, model: "test-model", usage: { input_tokens: 10, output_tokens: 8 } };
  } };
  return { client, calls, transport };
}

test("classification uses the current project catalog, writes a candidate label, and completes its ticket", async () => {
  const f = fixture();
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal(result.processed, 1);
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
  assert.equal(f.calls.find(call => call.name === "craft_evaluation_model_ticket_issue")?.args.input_ref, "craft-knowledge://claim/claim-1/v1/catalog/3");
  const saved = f.calls.find(call => call.name === "craft_knowledge_claim_save")?.args;
  assert.equal(saved?.claim_id, "claim-1");
  assert.equal(saved?.scenario_key, "build.validation");
  assert.deepEqual(saved?.scenario_definition, { summary: "构建验证规则", applies_when: "适用于项目构建验收", excludes: "与构建无关的事实" });
  assert.equal(f.calls.at(-1)?.name, "craft_evaluation_model_ticket_complete");
});

test("classification adds taxonomy metadata to reviewed Knowledge without changing review status", async () => {
  const f = fixture(undefined, "reviewed");
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
  const saved = f.calls.find(call => call.name === "craft_knowledge_claim_save")?.args;
  assert.equal(saved?.claim_id, "claim-1");
  assert.equal("status" in (saved ?? {}), false, "classification must not rewrite the independent review decision");
  assert.deepEqual(saved?.scope_envelope, { applicability: { kind: "project", id: "demo" },
    custody: { kind: "project", id: "demo" }, audience: { mode: "scoped", principal_ids: [] }, purpose: "fact", retention: "long_term", tenant_id: null });
  assert.equal((result.outcomes as JsonObject[])[0]?.scenario_key, "build.validation");
});

test("classification uses the normalized project id for canonical scope model input", async () => {
  const f = fixture(undefined, "reviewed", "project:project:canonical-project");
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
  assert.equal(f.calls.find(call => call.name === "craft_knowledge_scenario_list")?.args.scope, "project:project:canonical-project");
});

test("classification routes global Claims through the isolated global Knowledge taxonomy", async () => {
  const f = fixture(undefined, "candidate", "global");
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
  assert.equal(f.calls.find(call => call.name === "craft_knowledge_scenario_list")?.args.scope, "global");
  assert.equal(f.calls.find(call => call.name === "craft_knowledge_claim_save")?.args.scope, "global");
});

test("uncertain output completes a content-free ticket without mutating the Claim", async () => {
  const f = fixture('{"decision":"unclassified"}');
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "unclassified");
  assert.equal(f.calls.some(call => call.name === "craft_knowledge_claim_save"), false);
  assert.equal(f.calls.at(-1)?.name, "craft_evaluation_model_ticket_complete");
});

test("completed classification tickets are not sent to the model again", async () => {
  const f = fixture();
  let modelCalls = 0;
  const resolvedClient: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_evaluation_model_ticket_issue") return { ticket: { id: "ticket-1", status: "completed" } };
    return f.client.call(name, args);
  } };
  const transport: ModelTransport = { async complete(): Promise<ChatResult> { modelCalls++; return { text: "{}", model: "test-model", usage: null }; } };
  const result = await runKnowledgeScenarioClassificationOnce({ client: resolvedClient, providers: [provider], transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "already_resolved");
  assert.equal(modelCalls, 0);
});

test("profile, empty queue, packet bounds, malformed output, and MCP failures fail closed", async () => {
  const f = fixture();
  assert.deepEqual(await runKnowledgeScenarioClassificationOnce({ client: { async call() { return { claims: [] }; } } }), { processed: 0, outcomes: [] });
  const unavailable: KnowledgeClassificationClient = { async call(name) {
    if (name === "craft_knowledge_claim_list") return { claims: [claim] };
    return { status: "ambiguous", reason: "multiple_models_require_explicit_profile", profile: null };
  } };
  assert.equal((await runKnowledgeScenarioClassificationOnce({ client: unavailable })).reason, "multiple_models_require_explicit_profile");
  const noProvider = fixture();
  const dynamic: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_evaluation_model_profile_ensure_single") return { status: "ready_for_adapter", profile: { id: "p", provider: "missing", model: "x" } };
    return noProvider.client.call(name, args);
  } };
  assert.equal((await runKnowledgeScenarioClassificationOnce({ client: dynamic, providers: [], transport: noProvider.transport })).reason, "provider_unavailable");
  const malformed = fixture("[]");
  const malformedResult = await runKnowledgeScenarioClassificationOnce({ client: malformed.client, providers: [provider], transport: malformed.transport });
  assert.equal((malformedResult.outcomes as JsonObject[])[0]?.status, "failed");
  assert.equal(malformed.calls.some(call => call.name === "craft_evaluation_model_ticket_complete"), false);
  await assert.rejects(runKnowledgeScenarioClassificationOnce({ client: f.client, max_claims: 51 }), /between 1 and 50/u);
  await assert.rejects(runKnowledgeScenarioClassificationOnce({ client: { async call() { return { claims: null }; } } }), /must be an array/u);
});

test("oversized packets are closed without model calls and pre-ticket failures are isolated", async () => {
  const f = fixture();
  const largeClaim = { ...claim, content: "x".repeat(13_000) };
  const largeClient: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_claim_list") return { claims: [largeClaim] };
    return f.client.call(name, args);
  } };
  const large = await runKnowledgeScenarioClassificationOnce({ client: largeClient, providers: [provider], transport: f.transport });
  assert.equal((large.outcomes as JsonObject[])[0]?.status, "skipped");
  assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_ticket_complete"), true);
  const broken: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_claim_list") return { claims: [claim, { ...claim, id: "claim-2", scope: "project:demo" }] };
    if (name === "craft_knowledge_scenario_list") {
      if (args?.scope === "project:demo") throw new TypeError("private source locator");
    }
    return f.client.call(name, args);
  } };
  const isolated = await runKnowledgeScenarioClassificationOnce({ client: broken, providers: [provider], transport: f.transport });
  assert.deepEqual((isolated.outcomes as JsonObject[]).map(outcome => outcome.status), ["failed", "failed"]);
  assert.equal(JSON.stringify(isolated).includes("private source locator"), false);
});

test("classifier validates every model and Claim boundary with safe defaults", async () => {
  const base = fixture();
  const variants: JsonObject[] = [
    { ...claim, id: "inactive-status", status: "rejected" },
    { ...claim, id: "already-classified", scenario_key: "existing" },
    { ...claim, id: "no-content", content: undefined },
    { ...claim, id: "unsupported-scope", scope: "session:one" },
    { ...claim, id: "missing-scope", scope: undefined },
  ];
  const filtering: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_claim_list") return { claims: [...variants, claim] };
    return base.client.call(name, args);
  } };
  const noCoarse = fixture('{"decision":"classified","scenario_key":"other.topic","scenario_definition":{"summary":"其他主题","applies_when":"该主题适用","excludes":"其他情况"}}');
  const result = await runKnowledgeScenarioClassificationOnce({ client: filtering, providers: [provider], transport: noCoarse.transport, max_claims: 1 });
  assert.equal((result.outcomes as JsonObject[])[0]?.coarse_scenario_key, null);

  const fallbackProfile: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_claim_list") return { claims: [{ ...claim, title: "Build rule", valid_until: "2030-01-01T00:00:00.000Z" }] };
    if (name === "craft_evaluation_model_profile_ensure_single") return { status: "ready_for_adapter", profile: { id: "p", version: 1, provider: "remote", model: "m" } };
    if (name === "craft_evaluation_model_profile_get") return { profile: { id: "p", version: 1, provider: "remote", model: "m" }, readiness: { status: "ready_for_adapter" },
      provider: { provider: "remote", label: "remote", protocol: "openai-compatible", base_url: "https://example.invalid/v1", api_key_env: "KEY", chat_path: "/chat/completions", models: { standard: "m" }, supports_tools: false } };
    return base.client.call(name, args);
  } };
  let defaultsSeen = false;
  const defaultTransport: ModelTransport = { async complete(_spec, request): Promise<ChatResult> {
    defaultsSeen = request.body.max_tokens === 2_048 && request.body.temperature === 0;
    return { text: '{"decision":"classified","scenario_key":"other.topic","scenario_definition":{"summary":"其他主题","applies_when":"该主题适用","excludes":"其他情况"},"coarse_scenario_key":"other.topic","coarse_scenario_definition":{"summary":"其他主题","applies_when":"该主题适用","excludes":"其他情况"}}', model: "m", usage: null };
  } };
  const result2 = await runKnowledgeScenarioClassificationOnce({ client: fallbackProfile, providers: [], transport: defaultTransport });
  assert.equal(defaultsSeen, true);
  assert.equal((result2.outcomes as JsonObject[])[0]?.status, "failed", "identical fine/coarse keys are rejected");

  const badDecision = fixture('{"decision":"maybe"}');
  assert.equal(((await runKnowledgeScenarioClassificationOnce({ client: badDecision.client, providers: [provider], transport: badDecision.transport }).then(r => r.outcomes as JsonObject[]))[0]?.status), "failed");
  const invalidJson = fixture("not json");
  assert.equal(((await runKnowledgeScenarioClassificationOnce({ client: invalidJson.client, providers: [provider], transport: invalidJson.transport }).then(r => r.outcomes as JsonObject[]))[0]?.status), "failed");
  const invalidKey = fixture('{"decision":"classified","scenario_key":"Bad Key","scenario_definition":{"summary":"其他主题","applies_when":"该主题适用","excludes":"其他情况"},"coarse_scenario_key":"other.topic","coarse_scenario_definition":{"summary":"其他主题","applies_when":"该主题适用","excludes":"其他情况"}}');
  assert.equal(((await runKnowledgeScenarioClassificationOnce({ client: invalidKey.client, providers: [provider], transport: invalidKey.transport }).then(r => r.outcomes as JsonObject[]))[0]?.status), "failed");
  for (const text of [
    '{"decision":"classified","scenario_key":"valid.topic","scenario_definition":null}',
    '{"decision":"classified","scenario_key":"valid.topic","scenario_definition":[]}',
    '{"decision":"classified","scenario_key":"valid.topic","scenario_definition":{"summary":"","applies_when":"a","excludes":"e"}}',
    '{"decision":"classified","scenario_key":"valid.topic","scenario_definition":{"summary":"s","applies_when":"a","excludes":"e"},"coarse_scenario_key":"engineering"}',
  ]) {
    const invalidDefinition = fixture(text);
    assert.equal(((await runKnowledgeScenarioClassificationOnce({ client: invalidDefinition.client, providers: [provider], transport: invalidDefinition.transport }).then(r => r.outcomes as JsonObject[]))[0]?.status), "failed");
  }
  const unready: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_claim_list") return { claims: [claim] };
    if (name === "craft_evaluation_model_profile_ensure_single") return { status: "ready_for_adapter", profile: { id: "p", provider: "test" } };
    if (name === "craft_evaluation_model_profile_get") return { profile: { provider: "test" }, readiness: { status: "needs_credential" } };
    return base.client.call(name, args);
  } };
  assert.equal((await runKnowledgeScenarioClassificationOnce({ client: unready })).reason, "model_profile_not_ready");
  const missingProfile: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_claim_list") return { claims: [claim] };
    if (name === "craft_evaluation_model_profile_ensure_single") return { status: "ready_for_adapter", profile: null, reason: "no_profile" };
    return base.client.call(name, args);
  } };
  assert.equal((await runKnowledgeScenarioClassificationOnce({ client: missingProfile })).reason, "no_profile");
  const absentReason: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_claim_list") return { claims: [claim] };
    if (name === "craft_evaluation_model_profile_ensure_single") return { status: "ready_for_adapter", profile: null };
    return base.client.call(name, args);
  } };
  assert.equal((await runKnowledgeScenarioClassificationOnce({ client: absentReason })).reason, "ready_for_adapter");
  const noReasonNoStatus: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_claim_list") return { claims: [claim] };
    if (name === "craft_evaluation_model_profile_ensure_single") return { profile: null };
    return base.client.call(name, args);
  } };
  assert.equal((await runKnowledgeScenarioClassificationOnce({ client: noReasonNoStatus })).reason, "model_profile_unavailable");

  const missingTicket: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_evaluation_model_ticket_issue") return { ticket: null };
    return base.client.call(name, args);
  } };
  assert.equal(((await runKnowledgeScenarioClassificationOnce({ client: missingTicket, providers: [provider], transport: base.transport }).then(r => r.outcomes as JsonObject[]))[0]?.status), "failed");

  const nullSave = fixture('{"decision":"classified","scenario_key":"one.topic","scenario_definition":{"summary":"单一主题","applies_when":"该主题适用","excludes":"其他情况"}}');
  const minimalClient: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_scenario_list") return { catalog_version: 0 };
    if (name === "craft_knowledge_claim_list") return { claims: [{ ...claim, tags: undefined, title: undefined, valid_until: undefined }] };
    if (name === "craft_knowledge_claim_save") return {};
    return nullSave.client.call(name, args);
  } };
  const nullVersionTransport: ModelTransport = { async complete(): Promise<ChatResult> { return { text: '{"decision":"classified","scenario_key":"one.topic","scenario_definition":{"summary":"单一主题","applies_when":"该主题适用","excludes":"其他情况"}}', model: "test-model", usage: null }; } };
  const nullVersion = await runKnowledgeScenarioClassificationOnce({ client: minimalClient, providers: [provider], transport: nullVersionTransport });
  assert.equal((nullVersion.outcomes as JsonObject[])[0]?.claim_version, null);

  const catalogProvider = PROVIDER_CATALOG[0]!;
  const defaultTransportClient: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_evaluation_model_profile_ensure_single") return { status: "ready_for_adapter", profile: { id: "p", provider: catalogProvider.provider, model: Object.values(catalogProvider.models)[0] } };
    if (name === "craft_evaluation_model_profile_get") return { profile: { provider: catalogProvider.provider, model: Object.values(catalogProvider.models)[0] }, readiness: { status: "ready_for_adapter" } };
    return base.client.call(name, args);
  } };
  const defaultTransportResult = await runKnowledgeScenarioClassificationOnce({ client: defaultTransportClient });
  assert.equal((defaultTransportResult.outcomes as JsonObject[])[0]?.status, "failed", "default transport is used and missing credentials are contained");
  const nonErrorTransport: ModelTransport = { async complete(): Promise<ChatResult> { throw "private provider detail"; } };
  const nonError = await runKnowledgeScenarioClassificationOnce({ client: base.client, providers: [provider], transport: nonErrorTransport });
  assert.equal((nonError.outcomes as JsonObject[])[0]?.failure_kind, "Error");
  const nonErrorTaxonomy: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_scenario_list") throw "private taxonomy detail";
    return base.client.call(name, args);
  } };
  const failedBeforeTicket = await runKnowledgeScenarioClassificationOnce({ client: nonErrorTaxonomy, providers: [provider], transport: base.transport });
  assert.equal((failedBeforeTicket.outcomes as JsonObject[])[0]?.failure_kind, "Error");
  assert.equal((failedBeforeTicket.outcomes as JsonObject[])[0]?.failure_stage, "taxonomy_list");

  for (const [failedTool, expectedStage] of [["craft_evaluation_model_ticket_issue", "ticket_issue"], ["craft_knowledge_claim_save", "claim_save"],
    ["craft_evaluation_model_ticket_complete", "ticket_complete"]] as const) {
    const failingClient: KnowledgeClassificationClient = { async call(name, args) {
      if (name === failedTool) throw new Error("private service diagnostic");
      return base.client.call(name, args);
    } };
    const failed = await runKnowledgeScenarioClassificationOnce({ client: failingClient, providers: [provider], transport: base.transport });
    assert.equal((failed.outcomes as JsonObject[])[0]?.failure_stage, expectedStage);
    assert.equal(JSON.stringify(failed).includes("private service diagnostic"), false);
  }
});
