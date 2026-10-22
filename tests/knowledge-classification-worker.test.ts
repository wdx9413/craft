import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROVIDER_CATALOG, type ChatRequest, type ChatResult, type ModelProviderSpec, type ModelTransport } from "../core/model-gateway.ts";
import { dataRoot } from "../core/infrastructure/paths.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { runKnowledgeScenarioClassificationOnce, type KnowledgeClassificationClient } from "../deploy/experience-learning/knowledge-classification.ts";

const provider: ModelProviderSpec = { provider: "test", label: "test", protocol: "openai-compatible", base_url: "https://example.invalid/v1",
  api_key_env: "TEST_KEY", chat_path: "/chat/completions", models: { standard: "test-model" }, cost_hint: 0, supports_tools: false };
const claimContent = "Builds run with pnpm.";
const claim: JsonObject = { id: "claim-1", version: 1, status: "reviewed", scope: "project:demo", kind: "fact",
  content_digest: "sha256:claim", source_id: "source-1", evidence_ids: ["evidence-1"], tags: ["build"] };

function fixture(modelText = '{"decision":"classified","scenario_key":"build.validation","scenario_definition":{"summary":"构建验证规则","applies_when":"适用于项目构建验收","excludes":"与构建无关的事实"},"coarse_scenario_key":"engineering","coarse_scenario_definition":{"summary":"工程主题","applies_when":"属于项目工程实践","excludes":"业务领域事实"}}', claimStatus = "reviewed", claimScope: string = String(claim.scope), profileProvider: ModelProviderSpec = provider, contentRefPath?: string) {
  const calls: Array<{ name: string; args: JsonObject }> = [];
  const requests: ChatRequest[] = [];
  const scopeKind = claimScope === "global" ? "global" : "project";
  const scopeId = scopeKind === "global" ? "global" : claimScope.split(":").slice(1).join(":");
  const scopeEnvelope = { applicability: { kind: scopeKind, id: scopeId },
    custody: { kind: scopeKind, id: scopeId }, audience: { mode: scopeKind === "global" ? "public" : "scoped", principal_ids: [] }, purpose: "fact", retention: "long_term", tenant_id: null };
  const client: KnowledgeClassificationClient = { async call(name, args = {}) {
    calls.push({ name, args });
    if (name === "craft_scope_identity_resolve_project") return { identity: { canonical_scope: { kind: "project", id: scopeId } } };
    if (name === "craft_knowledge_claim_list") return { claims: [{ ...claim, status: claimStatus, scope: claimScope, scope_envelope: scopeEnvelope,
      ...(contentRefPath ? { content_ref: { kind: "knowledge", path: contentRefPath } } : {}) }] };
    if (name === "craft_knowledge_semantic_review_packet") return { status: "ready", packet: { claim: { id: claim.id, version: claim.version,
      content_digest: claim.content_digest, content: claimContent }, evidence_fragments: [{ evidence_id: "evidence-1",
      content_digest: "sha256:evidence-1", content: claimContent }], source: { content_digest: "sha256:source" } }, packet_digest: "sha256:review-packet" };
    if (name === "craft_evaluation_model_profile_ensure_single") return { status: "ready_for_adapter", profile: { id: "profile-1", version: 1,
      provider: profileProvider.provider, model: profileProvider.models.small ?? profileProvider.models.standard ?? "test-model", max_attempts: 1, max_output_tokens: 256, temperature: 0 } };
    if (name === "craft_evaluation_model_profile_get") return { profile: { id: "profile-1", version: 1, provider: profileProvider.provider, model: profileProvider.models.small ?? profileProvider.models.standard ?? "test-model",
      max_attempts: 1, max_output_tokens: 256, temperature: 0 }, readiness: { status: "ready_for_adapter" } };
    if (name === "craft_knowledge_scenario_list") return { catalog_version: 3, scenarios: [{ scenario_key: "engineering", tier: "coarse", lifecycle: "active",
      definition: { summary: "工程主题", applies_when: "属于项目工程实践", excludes: "业务领域事实" } }] };
    if (name === "craft_evaluation_model_ticket_issue") return { ticket: { id: "ticket-1", status: "ready_for_adapter" } };
    if (name === "craft_knowledge_claim_save") return { claim: { id: "claim-1", version: 2 } };
    if (name === "craft_knowledge_host_review") return { status: args.decision === "supported" ? "reviewed" : args.decision,
      promoted: args.decision === "supported", claim: { id: claim.id, version: 2 } };
    if (name === "craft_knowledge_claim_review") return { claim: { id: claim.id, status: args.status } };
    if (name === "craft_evaluation_model_ticket_complete") return { ticket: { id: "ticket-1", status: "completed" } };
    if (name === "craft_trace_start") return { trace: { id: "trace-classification-1" } };
    if (name === "craft_trace_append" || name === "craft_trace_finalize") return {};
    throw new Error(`unexpected tool ${name}`);
  } };
  const transport: ModelTransport = { async complete(_spec, request): Promise<ChatResult> {
    requests.push(request);
    const content = String((request.body.messages as JsonObject[])[1]?.content);
    assert.match(content, /Builds run with pnpm/u);
    assert.match(content, /engineering/u);
    const packet = JSON.parse(content) as JsonObject;
    assert.equal(packet.scope, claimScope);
    assert.match(JSON.stringify(packet.taxonomy), /definition/u);
    assert.equal((packet.evidence as JsonObject).included_fragment_count, 1);
    assert.match(JSON.stringify((packet.evidence as JsonObject).fragments), /Builds run with pnpm\./u);
    return { text: modelText, model: "test-model", usage: { input_tokens: 10, output_tokens: 8 } };
  } };
  return { client, calls, requests, transport };
}

test("Knowledge Host requests attach strict response schemas for classification and Evidence review", async () => {
  const codexProvider: ModelProviderSpec = { ...provider, provider: "codex-cli", label: "Codex CLI Host", api_key_env: "CODEX_CLI_AUTH_STORE",
    models: { small: "gpt-6-luna" }, host_managed_auth: true };
  for (const candidate of [false, true]) {
    const f = fixture(candidate ? '{"review_decision":"supported"}' : undefined, candidate ? "candidate" : "reviewed", String(claim.scope), codexProvider);
    await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [codexProvider], transport: f.transport });
    const schema = f.requests[0]?.body.codex_output_schema as JsonObject | undefined;
    assert.equal(schema?.type, "object");
    const properties = schema?.properties as JsonObject;
    if (candidate) assert.deepEqual((properties.review_decision as JsonObject).enum, ["supported", "needs_evidence", "rejected"]);
    else assert.deepEqual((properties.decision as JsonObject).enum, ["classified", "unclassified"]);
    assert.equal(f.requests[0]?.body.output_schema, undefined);
  }
});

test("classification uses the current project catalog, writes a reviewed Claim label, and traces its ticket", async () => {
  const f = fixture();
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal(result.processed, 1);
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
  assert.equal((result.outcomes as JsonObject[])[0]?.trace_id, "trace-classification-1");
  assert.equal(f.calls.find(call => call.name === "craft_evaluation_model_ticket_issue")?.args.input_ref, "craft-knowledge://claim/claim-1/v1/catalog/3");
  const saved = f.calls.find(call => call.name === "craft_knowledge_claim_save")?.args;
  assert.equal(saved?.claim_id, "claim-1");
  assert.equal(saved?.content, claimContent, "content_ref-only Claims must reuse the exact trusted packet body when saving classification");
  assert.equal(saved?.scenario_key, "build.validation");
  assert.deepEqual(saved?.scenario_definition, { summary: "构建验证规则", applies_when: "适用于项目构建验收", excludes: "与构建无关的事实" });
  assert.equal(f.calls.find(call => call.name === "craft_evaluation_model_ticket_complete")?.args.ticket_id, "ticket-1");
  assert.equal(f.calls.find(call => call.name === "craft_evaluation_model_ticket_complete")?.args.trace_id, "trace-classification-1");
  const traceEvents = f.calls.filter(call => call.name === "craft_trace_append");
  assert.deepEqual(traceEvents.map(call => call.args.event_kind), ["model.request", "model.completed", "classification.saved", "model.result_bound"]);
  assert.equal(JSON.stringify(traceEvents).includes(claimContent), false, "Trace must not store the Claim body");
  assert.equal(JSON.stringify(traceEvents).includes("构建验证规则"), false, "Trace must not store the model response");
  assert.deepEqual(f.calls.filter(call => call.name === "craft_trace_finalize").map(call => call.args.status), ["completed"]);
});

test("Knowledge model prompt follows the configured output language", async () => {
  const f = fixture();
  await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport, contentLanguage: "en-US" });
  const messages = f.requests[0]?.body.messages as JsonObject[];
  assert.match(String(messages[0]?.content), /English \(en-US\)/u);
  assert.match(String(messages[0]?.content), /Keep JSON property names and stable keys unchanged/u);
});

test("candidate Claims receive an Evidence-bound Host review before scenario classification", async () => {
  const f = fixture('{"review_decision":"supported"}', "candidate");
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  const outcome = (result.outcomes as JsonObject[])[0]!;
  assert.equal(outcome.status, "reviewed");
  assert.equal(outcome.review_decision, "supported");
  assert.equal(outcome.promoted, true);
  assert.deepEqual(f.calls.find(call => call.name === "craft_knowledge_host_review")?.args, {
    claim_id: claim.id, host_kind: "codex-cli", host_run_key: "learning:ticket-1", model_ref: "test-model:knowledge-evidence-review",
    source_digest: "sha256:source", packet_digest: "sha256:review-packet", decision: "supported", reason_code: "evidence_supports_claim",
  });
  assert.equal(f.calls.some(call => call.name === "craft_knowledge_claim_save"), false);
  assert.equal(f.calls.find(call => call.name === "craft_evaluation_model_ticket_issue")?.args.output_contract_ref, "craft-knowledge-evidence-review-v1");
  assert.deepEqual(f.calls.filter(call => call.name === "craft_trace_append").map(call => call.args.event_kind),
    ["model.request", "model.completed", "knowledge.reviewed", "model.result_bound"]);
  assert.equal(f.calls.find(call => call.name === "craft_evaluation_model_ticket_complete")?.args.trace_id, "trace-classification-1");
});

test("completed but rejected classifier responses are not retried for unchanged inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-classification-"));
  try {
    const stateFile = join(root, "knowledge", "classification-attempts.json"), f = fixture("not json");
    let calls = 0;
    const transport: ModelTransport = { async complete(spec, request) { calls += 1; return f.transport.complete!(spec, request); } };
    const first = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport, state_file: stateFile });
    const firstOutcome = (first.outcomes as JsonObject[])[0]!;
    assert.equal(firstOutcome.failure_stage, "response_parse");
    assert.equal(firstOutcome.failure_code, "response_not_json");
    assert.equal(calls, 1);
    const failedTrace = f.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "classification.failed");
    assert.match(String(failedTrace?.args.summary), /response_parse \(response_not_json\)/u);
    assert.equal(JSON.stringify(failedTrace).includes("not json"), false);

    const second = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport, state_file: stateFile });
    assert.equal((second.outcomes as JsonObject[])[0]?.reason, "unchanged_failed_input");
    assert.equal(calls, 1, "the persisted failed digest suppresses another Host call after process restart");

    const originalCall = f.client.call.bind(f.client);
    f.client.call = async (name, args = {}) => {
      const result = await originalCall(name, args);
      if (name === "craft_knowledge_semantic_review_packet") {
        const packet = result.packet as JsonObject;
        const fragments = packet.evidence_fragments as JsonObject[];
        fragments[0] = { ...fragments[0], content: "The evidence changed." };
      }
      return result;
    };
    const changedTransport: ModelTransport = { async complete() {
      calls += 1;
      return { text: "not json", model: "test-model", usage: { input_tokens: 10, output_tokens: 2 } };
    } };
    const changed = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: changedTransport, state_file: stateFile });
    assert.equal((changed.outcomes as JsonObject[])[0]?.failure_code, "response_not_json", JSON.stringify((changed.outcomes as JsonObject[])[0]));
    assert.equal(calls, 2, "changed trusted evidence creates a new input digest and permits a fresh attempt");
    const saved = JSON.parse(await readFile(stateFile, "utf8")) as JsonObject;
    assert.equal(JSON.stringify(saved).includes(claimContent), false, "the retry ledger stores digests and safe codes, never Claim or Evidence text");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failure-state write errors are classified without exposing the Host response", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-classification-state-race-"));
  try {
    const stateDir = join(root, "knowledge"), backupDir = join(root, "knowledge-original"), targetDir = join(root, "replacement");
    await mkdir(stateDir); await mkdir(targetDir);
    const stateFile = join(stateDir, "classification-attempts.json");
    await writeFile(stateFile, JSON.stringify({ schema: "craft.knowledge-classification-attempts.v1", attempts: {} }));
    const f = fixture("not json");
    const transport: ModelTransport = { async complete() {
      await rename(stateDir, backupDir);
      await symlink(targetDir, stateDir);
      return { text: "not json", model: "test-model", usage: null };
    } };
    const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport, state_file: stateFile });
    const outcome = (result.outcomes as JsonObject[])[0]!;
    assert.equal(outcome.failure_stage, "attempt_state_save");
    assert.equal(outcome.failure_code, "response_not_json");
    assert.equal(JSON.stringify(result).includes("not json"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("candidate review rejects malformed decisions and incomplete review packets", async () => {
  for (const scenario of ["missing-decision", "missing-packet-digest"] as const) {
    const f = fixture(scenario === "missing-decision" ? "{}" : '{"review_decision":"supported"}', "candidate");
    if (scenario === "missing-packet-digest") {
      const originalCall = f.client.call.bind(f.client);
      f.client.call = async (name, args = {}) => {
        const result = await originalCall(name, args);
        if (name === "craft_knowledge_semantic_review_packet") {
          const packet = result as JsonObject;
          delete packet.packet_digest;
        }
        return result;
      };
    }
    const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
    assert.equal((result.outcomes as JsonObject[])[0]?.status, "failed", `${scenario} must leave the ticket retryable`);
    assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_ticket_complete"), false);
  }
});

test("candidate review maps source and packet drift to safe failure codes", async () => {
  for (const [message, code] of [
    ["source_digest must match the active Claim Source", "review_source_changed"],
    ["packet_digest must match the exact semantic review packet", "review_packet_changed"],
  ]) {
    const f = fixture('{"review_decision":"supported"}', "candidate"), originalCall = f.client.call.bind(f.client);
    f.client.call = async (name, args = {}) => {
      if (name === "craft_knowledge_host_review") throw new Error(message);
      return originalCall(name, args);
    };
    const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
    const outcome = (result.outcomes as JsonObject[])[0]!;
    assert.equal(outcome.failure_stage, "host_review");
    assert.equal(outcome.failure_code, code);
    const failure = f.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "classification.failed");
    assert.match(String(failure?.args.summary), new RegExp(code, "u"));
    assert.equal(JSON.stringify(failure).includes(message), false);
  }
});

test("candidate review tolerates Host review results without an embedded Claim or status", async () => {
  const f = fixture('{"review_decision":"supported"}', "candidate");
  const originalCall = f.client.call.bind(f.client);
  f.client.call = async (name, args = {}) => name === "craft_knowledge_host_review" ? { promoted: false } : originalCall(name, args);
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  const outcome = (result.outcomes as JsonObject[])[0]!;
  assert.equal(outcome.status, "supported");
  assert.equal(outcome.claim_status, "candidate");
  assert.equal(outcome.promoted, false);
  assert.equal(f.calls.some(call => call.name === "craft_knowledge_claim_review"), false);
});

test("uncertain and contradictory candidate reviews preserve non-promoted claim states", async () => {
  for (const decision of ["needs_evidence", "rejected"]) {
    const f = fixture(JSON.stringify({ review_decision: decision }), "candidate");
    const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
    const outcome = (result.outcomes as JsonObject[])[0]!;
    assert.equal(outcome.review_decision, decision);
    assert.equal(outcome.promoted, false);
    assert.equal(outcome.claim_status, decision === "rejected" ? "disputed" : "candidate");
    assert.equal(f.calls.some(call => call.name === "craft_knowledge_claim_review"), decision === "rejected");
  }
});

test("classification redacts credential-shaped text from Claim and taxonomy fields before model dispatch", async () => {
  const f = fixture();
  const privateKey = "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----";
  const syntheticEmail = ["alice.private", String.fromCharCode(64), "example", ".invalid"].join("");
  const syntheticIpv4 = [203, 0, 113, 42].join(".");
  const secretClaim = `${claimContent} api_key=claim-secret Authorization: Bearer bearer-secret-value ghp_${"a".repeat(32)} ${privateKey} `
    + `contact ${syntheticEmail} URL https://private.example/path?ref=private IP ${syntheticIpv4} IPv6 2001:db8::1 `
    + "Unix /Users/alice.private/Documents/private-note Windows C:\\Users\\Alice\\Documents\\private-note";
  const client: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_semantic_review_packet") return { status: "ready", packet: { claim: { id: claim.id, version: claim.version,
      content_digest: claim.content_digest, content: claimContent }, evidence_fragments: [{ evidence_id: "evidence-1",
      content_digest: "sha256:evidence-1", content: secretClaim }] } };
    if (name === "craft_knowledge_scenario_list") return { catalog_version: 3, scenarios: [{ scenario_key: "engineering", tier: "coarse", lifecycle: "active",
      definition: { summary: "password=\"taxonomy-secret value\"", applies_when: "项目工程实践", excludes: "业务事实" } }] };
    return f.client.call(name, args);
  } };
  let modelPacket: JsonObject | undefined;
  const transport: ModelTransport = { async complete(_spec, request): Promise<ChatResult> {
    modelPacket = JSON.parse(String((request.body.messages as JsonObject[])[1]?.content)) as JsonObject;
    return { text: '{"decision":"unclassified"}', model: "test-model", usage: null };
  } };
  const result = await runKnowledgeScenarioClassificationOnce({ client, providers: [provider], transport });
  const packetText = JSON.stringify(modelPacket);
  for (const secret of ["claim-secret", "bearer-secret-value", `ghp_${"a".repeat(32)}`, "private-key-material", "taxonomy-secret value",
    syntheticEmail, "https://private.example/path?ref=private", syntheticIpv4, "2001:db8::1",
    "/Users/alice.private/Documents/private-note", "C:\\Users\\Alice\\Documents\\private-note"])
    assert.equal(packetText.includes(secret), false, `model packet must omit ${secret}`);
  assert.match(packetText, /Builds run with pnpm\./u, "redaction preserves useful Knowledge content");
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "unclassified");
});

test("classification obtains Claim text only from the exact trusted evidence packet", async () => {
  for (const packet of [
    { status: "unavailable", packet: null },
    { status: "ready", packet: { claim: { id: "other-claim", version: claim.version, content_digest: claim.content_digest, content: claimContent } } },
    { status: "ready", packet: { claim: { id: claim.id, version: 2, content_digest: claim.content_digest, content: claimContent } } },
    { status: "ready", packet: { claim: { id: claim.id, version: claim.version, content_digest: claim.content_digest, content: "   " } } },
    { status: "ready", packet: { claim: { id: claim.id, version: claim.version, content_digest: "sha256:other", content: claimContent } } },
  ]) {
    const f = fixture();
    let modelCalls = 0;
    const client: KnowledgeClassificationClient = { async call(name, args) {
      if (name === "craft_knowledge_semantic_review_packet") return packet;
      return f.client.call(name, args);
    } };
    const transport: ModelTransport = { async complete(): Promise<ChatResult> {
      modelCalls++;
      return { text: '{"decision":"unclassified"}', model: "test-model", usage: null };
    } };
    const result = await runKnowledgeScenarioClassificationOnce({ client, providers: [provider], transport });
    assert.deepEqual(result.outcomes, [{ claim_id: "claim-1", status: "skipped", reason: "trusted_claim_content_unavailable" }]);
    assert.equal(modelCalls, 0);
    assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_ticket_issue"), false);
  }
});

test("classification skips when its trusted packet contains no identifiable Evidence fragment", async () => {
  for (const evidence_fragments of [[], [{ content_digest: "sha256:evidence-1", content: claimContent }],
    [{ evidence_id: "evidence-1", content: claimContent }]]) {
    const f = fixture();
    const client: KnowledgeClassificationClient = { async call(name, args) {
      if (name === "craft_knowledge_semantic_review_packet") return { status: "ready", packet: {
        claim: { id: claim.id, version: claim.version, content_digest: claim.content_digest, content: claimContent }, evidence_fragments } };
      return f.client.call(name, args);
    } };
    let modelCalls = 0;
    const transport: ModelTransport = { async complete(): Promise<ChatResult> {
      modelCalls++;
      return { text: "{}", model: "test-model", usage: null };
    } };
    const result = await runKnowledgeScenarioClassificationOnce({ client, providers: [provider], transport });
    assert.deepEqual(result.outcomes, [{ claim_id: "claim-1", status: "skipped", reason: "trusted_evidence_unavailable" }]);
    assert.equal(modelCalls, 0);
    assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_ticket_issue"), false);
  }
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

test("worker classification resolves and isolates project claims and passes the project root to its taxonomy", async () => {
  const f = fixture();
  const projectRoot = "/workspace/demo";
  const client: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_scope_identity_resolve_project") return { identity: { canonical_scope: { kind: "project", id: "demo" } } };
    if (name === "craft_knowledge_claim_list") return { claims: [claim, { ...claim, id: "a-other-project", scope: "project:other" },
      { ...claim, id: "z-global", scope: "global" }] };
    return f.client.call(name, args);
  } };
  const result = await runKnowledgeScenarioClassificationOnce({ client, providers: [provider], transport: f.transport, project_root: projectRoot, max_claims: 1 });
  assert.equal((result.outcomes as JsonObject[])[0]?.claim_id, claim.id);
  assert.equal((result.outcomes as JsonObject[]).some(outcome => outcome.claim_id === "a-other-project"), false);
  assert.deepEqual(f.calls.find(call => call.name === "craft_knowledge_scenario_list")?.args, { scope: claim.scope, project_root: projectRoot });
  assert.equal(f.calls.find(call => call.name === "craft_evaluation_model_ticket_issue")?.args.project_root, projectRoot);
  assert.equal(f.calls.find(call => call.name === "craft_knowledge_claim_save")?.args.project_root, projectRoot);
  for (const canonicalScope of [{ kind: "global", id: "demo" }, { kind: "project" }, { kind: "project", id: "  " }]) {
    const invalidIdentity: KnowledgeClassificationClient = { async call(name) {
      if (name === "craft_scope_identity_resolve_project") return { identity: { canonical_scope: canonicalScope } };
      throw new Error("invalid project identity must fail before queue access");
    } };
    await assert.rejects(runKnowledgeScenarioClassificationOnce({ client: invalidIdentity, providers: [provider], transport: f.transport, project_root: projectRoot }),
      /canonical project scope/u);
  }
});

test("worker classification accepts canonical project scopes and historical double-prefixed Claims", async () => {
  const f = fixture();
  const projectRoot = "/workspace/demo";
  const canonicalClaim = { ...claim, id: "a-canonical", scope: "project:demo" };
  const legacyClaim = { ...claim, id: "b-legacy", scope: "project:project:demo" };
  const client: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_scope_identity_resolve_project") return { identity: { canonical_scope: { kind: "project", id: "project:demo" } } };
    if (name === "craft_knowledge_claim_list") return { claims: [canonicalClaim, legacyClaim, { ...claim, id: "other", scope: "project:other" }] };
    if (name === "craft_knowledge_semantic_review_packet") return { status: "ready", packet: { claim: {
      id: args?.claim_id, version: claim.version, content_digest: claim.content_digest, content: claimContent }, evidence_fragments: [{ evidence_id: "evidence-1",
      content_digest: "sha256:evidence-1", content: claimContent }] } };
    return f.client.call(name, args);
  } };
  const modelCalls: string[] = [];
  const transport: ModelTransport = { async complete(_spec, request): Promise<ChatResult> {
    modelCalls.push(String((request.body.messages as JsonObject[])[1]?.content));
    return { text: '{"decision":"unclassified"}', model: "test-model", usage: null };
  } };
  const result = await runKnowledgeScenarioClassificationOnce({ client, providers: [provider], transport, project_root: projectRoot, max_claims: 2 });
  assert.deepEqual((result.outcomes as JsonObject[]).map(item => item.claim_id), ["a-canonical", "b-legacy"]);
  assert.equal(modelCalls.length, 2);
  assert.deepEqual(f.calls.filter(call => call.name === "craft_knowledge_scenario_list").map(call => call.args.scope),
    ["project:demo", "project:project:demo"]);
});

test("worker derives a project root from the exact project Knowledge content reference", async () => {
  const f = fixture();
  const projectRoot = "/workspace/derived-project";
  const projectClaim = { ...claim, content_ref: { kind: "knowledge", path: join(projectRoot, ".craft_data", "knowledge", "md", "claim.md") } };
  const client: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_claim_list") return { claims: [projectClaim] };
    if (name === "craft_knowledge_scenario_list") assert.equal(args?.project_root, projectRoot);
    return f.client.call(name, args);
  } };
  const result = await runKnowledgeScenarioClassificationOnce({ client, providers: [provider], transport: f.transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
  assert.equal(f.calls.find(call => call.name === "craft_knowledge_scenario_list")?.args.project_root, projectRoot);
  assert.equal(f.calls.find(call => call.name === "craft_evaluation_model_ticket_issue")?.args.project_root, projectRoot);
  assert.equal(f.calls.find(call => call.name === "craft_knowledge_claim_save")?.args.project_root, projectRoot);
});

test("background classification skips temporary project roots before profile or model calls", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "craft-knowledge-classification-project-"));
  try {
    const f = fixture('{"review_decision":"supported"}', "candidate", String(claim.scope), provider,
      join(temporaryRoot, ".craft_data", "knowledge", "md", "claim.md"));
    const client: KnowledgeClassificationClient = { async call(name, args) {
      if (name === "craft_knowledge_claim_list") return { claims: [
        { ...claim, id: "temporary-root", status: "candidate", content_ref: { kind: "knowledge", path: join(tmpdir(), ".craft_data", "knowledge", "md", "claim.md") } },
        { ...claim, id: "temporary-descendant", status: "candidate", content_ref: { kind: "knowledge", path: join(temporaryRoot, ".craft_data", "knowledge", "md", "claim.md") } },
      ] };
      return f.client.call(name, args);
    } };
    const result = await runKnowledgeScenarioClassificationOnce({ client, providers: [provider], transport: f.transport });
    assert.equal(result.processed, 0);
    assert.equal(result.skipped_temporary_count, 2);
    assert.deepEqual(result.outcomes, []);
    assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_profile_ensure_single"), false);
    assert.equal(f.requests.length, 0);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test("explicit project roots allow intentional classification inside a temporary worktree", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "craft-knowledge-classification-explicit-"));
  try {
    const f = fixture('{"review_decision":"supported"}', "candidate", String(claim.scope), provider,
      join(temporaryRoot, ".craft_data", "knowledge", "md", "claim.md"));
    const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport, project_root: temporaryRoot });
    assert.equal(result.processed, 1);
    assert.equal(result.skipped_temporary_count, 0);
    assert.equal((result.outcomes as JsonObject[])[0]?.status, "reviewed");
    assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_profile_ensure_single"), true);
    assert.equal(f.requests.length, 1);
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test("background classification still processes persistent project roots", async () => {
  const projectRoot = "/workspace/craft-persistent-project";
  const f = fixture(undefined, "reviewed", String(claim.scope), provider,
    join(projectRoot, ".craft_data", "knowledge", "md", "claim.md"));
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport });
  assert.equal(result.processed, 1);
  assert.equal(result.skipped_temporary_count, 0);
  assert.equal((result.outcomes as JsonObject[])[0]?.status, "classified");
});

test("worker ignores incomplete or unrelated project Knowledge content paths when deriving a root", async () => {
  const invalidReferences: unknown[] = [undefined, null, [], {}, { path: 7 }, { path: "   " },
    { path: "relative/.craft_data/knowledge/md/claim.md" }, { path: "/outside/claim.md" },
    { path: "/.craft_data/knowledge/md/claim.md" },
    { path: join(dataRoot(), "knowledge", "md", "legacy-project-claim.md") }];
  for (const contentRef of invalidReferences) {
    const f = fixture();
    const projectClaim = { ...claim, ...(contentRef === undefined ? {} : { content_ref: contentRef }) } as JsonObject;
    let taxonomyCalls = 0;
    const client: KnowledgeClassificationClient = { async call(name, args) {
      if (name === "craft_knowledge_claim_list") return { claims: [projectClaim] };
      if (name === "craft_knowledge_scenario_list") { taxonomyCalls += 1; assert.equal(args?.project_root, undefined); }
      return f.client.call(name, args);
    } };
    const result = await runKnowledgeScenarioClassificationOnce({ client, providers: [provider], transport: f.transport });
    const hasReference = contentRef !== undefined && contentRef !== null;
    assert.equal((result.outcomes as JsonObject[])[0]?.status, hasReference ? "skipped" : "classified");
    if (hasReference) assert.equal((result.outcomes as JsonObject[])[0]?.reason, "project_root_unavailable");
    assert.equal(taxonomyCalls, hasReference ? 0 : 1);
    assert.equal(f.calls.find(call => call.name === "craft_knowledge_scenario_list")?.args.project_root, undefined);
  }
});

test("classification keeps a ready ticket retryable when the shared Host-call budget is exhausted", async () => {
  const f = fixture();
  let modelCalls = 0;
  const transport: ModelTransport = { acquireCall: () => false, async complete() {
    modelCalls += 1;
    return { text: "{}", model: "test-model", usage: null };
  } };
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport });
  assert.deepEqual(result.outcomes, [{ claim_id: "claim-1", ticket_id: "ticket-1", status: "skipped", reason: "model_call_budget_exhausted" }]);
  assert.equal(modelCalls, 0);
  assert.equal(f.calls.some(call => call.name === "craft_knowledge_claim_save" || call.name === "craft_evaluation_model_ticket_complete"), false);
});

test("classification routes global Claims through the isolated global Knowledge taxonomy", async () => {
  const f = fixture(undefined, "reviewed", "global");
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
  assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_ticket_complete"), true);
  assert.equal(f.calls.some(call => call.name === "craft_trace_append" && call.args.event_kind === "classification.unclassified"), true);
  assert.deepEqual(f.calls.filter(call => call.name === "craft_trace_finalize").map(call => call.args.status), ["completed"]);
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
  assert.equal(malformed.calls.some(call => call.name === "craft_trace_append" && call.args.event_kind === "classification.failed"), true);
  assert.deepEqual(malformed.calls.filter(call => call.name === "craft_trace_finalize").map(call => call.args.status), ["failed"]);
  await assert.rejects(runKnowledgeScenarioClassificationOnce({ client: f.client, max_claims: 51 }), /between 1 and 50/u);
  await assert.rejects(runKnowledgeScenarioClassificationOnce({ client: { async call() { return { claims: null }; } } }), /must be an array/u);
});

test("model invocation failures are traced by class without persisting provider errors", async () => {
  const f = fixture();
  const transport: ModelTransport = { async complete() { throw new Error("private provider response body"); } };
  const result = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport });
  assert.equal((result.outcomes as JsonObject[])[0]?.failure_stage, "model_request");
  const failure = f.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.failed");
  assert.equal((failure?.args.data as JsonObject).failure_kind, "Error");
  assert.equal(JSON.stringify(failure).includes("private provider response body"), false);
  assert.deepEqual(f.calls.filter(call => call.name === "craft_trace_finalize").map(call => call.args.status), ["failed"]);

  const unsafe = fixture();
  const unsafeName = new Error("private");
  unsafeName.name = "private/path";
  const unsafeTransport: ModelTransport = { async complete() { throw unsafeName; } };
  const unsafeResult = await runKnowledgeScenarioClassificationOnce({ client: unsafe.client, providers: [provider], transport: unsafeTransport });
  const unsafeFailure = unsafe.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.failed");
  assert.equal((unsafeFailure?.args.data as JsonObject).failure_kind, "ClassificationError");
  assert.equal((unsafeResult.outcomes as JsonObject[])[0]?.failure_kind, "ClassificationError", "unsafe error names are sanitized in diagnostics");

  const nonError = fixture();
  const nonErrorTransport: ModelTransport = { async complete() { throw "private string failure"; } };
  const nonErrorResult = await runKnowledgeScenarioClassificationOnce({ client: nonError.client, providers: [provider], transport: nonErrorTransport });
  const nonErrorFailure = nonError.calls.find(call => call.name === "craft_trace_append" && call.args.event_kind === "model.failed");
  assert.equal((nonErrorFailure?.args.data as JsonObject).failure_kind, "ClassificationError");
  assert.equal((nonErrorResult.outcomes as JsonObject[])[0]?.failure_kind, "ClassificationError");
});

test("classification does not invoke the model when canonical Trace creation fails", async () => {
  const f = fixture();
  let modelCalls = 0;
  const transport: ModelTransport = { async complete() { modelCalls += 1; return { text: "{}", model: "test-model", usage: null }; } };
  const client: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_trace_start") throw new TypeError("trace storage unavailable");
    return f.client.call(name, args);
  } };
  const result = await runKnowledgeScenarioClassificationOnce({ client, providers: [provider], transport });
  assert.equal(modelCalls, 0);
  assert.equal((result.outcomes as JsonObject[])[0]?.failure_kind, "TypeError");
  assert.equal(f.calls.some(call => call.name === "craft_knowledge_claim_save"), false);
});

test("oversized packets are closed without model calls and pre-ticket failures are isolated", async () => {
  const f = fixture();
  const largeClient: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_semantic_review_packet") return { status: "ready", packet: { claim: { id: claim.id, version: claim.version,
      content_digest: claim.content_digest, content: "x".repeat(13_000) }, evidence_fragments: [{ evidence_id: "evidence-1",
      content_digest: "sha256:evidence-1", content: claimContent }] } };
    return f.client.call(name, args);
  } };
  const large = await runKnowledgeScenarioClassificationOnce({ client: largeClient, providers: [provider], transport: f.transport });
  assert.equal((large.outcomes as JsonObject[])[0]?.status, "skipped");
  assert.equal(f.calls.some(call => call.name === "craft_evaluation_model_ticket_issue"), false);
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
  assert.equal((nonError.outcomes as JsonObject[])[0]?.failure_kind, "ClassificationError");
  const nonErrorTaxonomy: KnowledgeClassificationClient = { async call(name, args) {
    if (name === "craft_knowledge_scenario_list") throw "private taxonomy detail";
    return base.client.call(name, args);
  } };
  const failedBeforeTicket = await runKnowledgeScenarioClassificationOnce({ client: nonErrorTaxonomy, providers: [provider], transport: base.transport });
  assert.equal((failedBeforeTicket.outcomes as JsonObject[])[0]?.failure_kind, "ClassificationError");
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


function queueFixture(count: number, blocked = 0) {
  const f = fixture();
  const call = f.client.call.bind(f.client);
  const ids = Array.from({ length: count }, (_, index) => `claim-${String(index + 1).padStart(2, "0")}`);
  f.client.call = async (name, args = {}) => {
    if (name === "craft_knowledge_claim_list") return { claims: ids.map(id => ({ ...claim, id })) };
    if (name === "craft_knowledge_semantic_review_packet" && ids.indexOf(String(args.claim_id)) < blocked) return { status: "unavailable" };
    const result = await call(name, args);
    if (name === "craft_knowledge_semantic_review_packet") {
      const packet = result.packet as JsonObject;
      return { ...result, packet: { ...packet, claim: { ...packet.claim as JsonObject, id: args.claim_id } } };
    }
    if (name === "craft_evaluation_model_ticket_issue") return { ticket: { id: `ticket-${args.knowledge_claim_id}`, status: "ready_for_adapter" } };
    return result;
  };
  return { ...f, ids };
}

test("classification advances beyond a full batch of unavailable Claims after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-classification-fairness-"));
  try {
    const stateFile = join(root, "knowledge", "classification.json"), f = queueFixture(9, 8);
    const first = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport, state_file: stateFile });
    assert.equal(first.processed, 8);
    assert.equal(f.requests.length, 0);
    const second = await runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], transport: f.transport, state_file: stateFile });
    assert.equal((second.outcomes as JsonObject[])[0]?.claim_id, f.ids[8]);
    assert.equal((second.outcomes as JsonObject[])[0]?.status, "classified");
    assert.equal(f.requests.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("classification leaves the first budget-blocked Claim next in the persisted queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-classification-budget-"));
  try {
    const f = queueFixture(3), stateFile = join(root, "classification.json");
    const run = () => {
      let used = false;
      return runKnowledgeScenarioClassificationOnce({ client: f.client, providers: [provider], state_file: stateFile,
        transport: { acquireCall: () => { if (used) return false; used = true; return true; }, complete: f.transport.complete.bind(f.transport) } });
    };
    const first = await run();
    assert.equal((first.outcomes as JsonObject[])[1]?.reason, "model_call_budget_exhausted");
    const second = await run();
    assert.equal((second.outcomes as JsonObject[])[0]?.claim_id, f.ids[1]);
    assert.equal(f.requests.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
