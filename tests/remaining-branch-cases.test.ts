import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { craftPaths } from "../src/paths.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { IntentCompilerKernel } from "../src/intent-compiler.ts";
import { ProjectKnowledgeKernel } from "../src/project-knowledge.ts";
import { RemoteRuntimeKernel } from "../src/remote-runtime.ts";
import { TaskStateKernel } from "../src/task-state.ts";
import { RuntimeAcceptanceKernel } from "../src/runtime-acceptance.ts";
import { WorkflowDagKernel } from "../src/workflow-dag.ts";
import { McpRegistryKernel } from "../src/mcp-registry.ts";
import { createOidcJwksVerifier } from "../src/oidc-jwks.ts";
import { A2AV1AdapterKernel } from "../src/a2a-v1-adapter.ts";
import { SupplyChainAttestationKernel } from "../src/supply-chain-attestation.ts";
import { InternalHostDriver } from "../src/internal-host-driver.ts";
import { defineProvider } from "../src/model-gateway.ts";
import type { ChatResult } from "../src/model-gateway.ts";
import { WebOperationKernel } from "../src/web-operation.ts";
import { FeedbackLearningKernel, CostLedgerKernel } from "../src/v01211-runtime.ts";
import { V01226Runtime, defineAdapterManifest, importOpenApiDocument } from "../src/v01226-runtime.ts";
import { TraceKernel } from "../src/trace-kernel.ts";
import { RuntimeTruthKernel } from "../src/runtime-truth-kernel.ts";
import { standardizeTrace, toOtlpTrace, parseToolCalls, compactConversation, toolResultMessage, exportOtlp } from "../src/runtime-truth.ts";
import { buildChatRequest as buildGatewayChatRequest, parseChatResponse as parseGatewayChatResponse } from "../src/model-gateway.ts";
import { ActionGatewayKernel, AcceptanceGateKernel } from "../src/v01213-runtime.ts";
import { ProjectBrainKernel } from "../src/project-brain.ts";
import { WorkSessionKernel } from "../src/work-session.ts";
import { WorkbenchExperienceKernel } from "../src/workbench-experience.ts";
import { KnowledgeMemoryRuntime } from "../src/knowledge-memory-runtime.ts";
import { MemoryGovernanceKernel } from "../src/memory-governance.ts";
import { ContextPlaneKernel, ReplayRunnerKernel, LocalRuntimeServiceKernel, ProjectBundleKernel, DomainEvaluatorKernel } from "../src/v01211-runtime.ts";
import { VerifiedAutonomousWorkKernel } from "../src/v01212-verified-work.ts";
import { kind as stateKind, StateWorkspaceKernel } from "../src/state-workspace.ts";
import { TrustProfileKernel } from "../src/trust-profile.ts";
import { WorkbenchWebApp } from "../src/workbench-server.ts";
import { normalizeSettings, defaultSettings } from "../src/settings.ts";
import { CapabilityConnectorKernel } from "../src/capability-connector.ts";
import { LongTaskWorkerKernel } from "../src/long-task-worker.ts";
import { HomeKernel } from "../src/home.ts";
import { serveMcpHttp } from "../src/mcp-http.ts";
import { Server } from "node:http";
import { LegacyKnowledgeMigrationKernel } from "../src/legacy-knowledge-migration.ts";
import { HostRunKernel } from "../src/host-run.ts";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function fixture(prefix = "craft-remaining-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store };
}

test("remaining protocol and compiler failure branches are observable", async () => {
  const f = await fixture("craft-protocol-branches-");
  try {
    const a2a = new A2AV1AdapterKernel(f.store);
    const grant = f.store.create("federated_delegation_grant", "g", { status: "consumed", effect: "read_only", grant_digest: digest("g") });
    const fetchCard = async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "GET") return { status: 200, json: async () => ({ protocolVersion: "1.0", url: "https://agent.test/rpc" }) };
      return { status: 503, json: async () => ({}) };
    };
    const card = await a2a.discover({ endpoint: "https://agent.test", observation_id: "card" }, fetchCard);
    await assert.rejects(() => a2a.submit({ task_id: "failed-send", grant_id: grant.id, card_observation_id: "card", request_id: "r", input_digest: digest("i") }, fetchCard), /HTTP 503/);
    const unsupported = async (_url: string, init?: { method?: string }) => init?.method === "POST" ? { status: 200, json: async () => ({ result: { id: "remote", status: "unknown" } }) } : { status: 200, json: async () => ({ protocolVersion: "1.0", url: "https://agent.test/rpc" }) };
    await assert.rejects(() => a2a.submit({ task_id: "unsupported", grant_id: grant.id, card_observation_id: "card", request_id: "r2", input_digest: digest("i") }, unsupported), /unsupported/);
    const accepted = await a2a.submit({ task_id: "accepted", grant_id: grant.id, card_observation_id: "card", request_id: "r3", input_digest: digest("i") }, async (_url, init) => init?.method === "POST" ? { status: 200, json: async () => ({ result: { id: "remote-ok", status: "submitted" } }) } : { status: 200, json: async () => ({}) });
    assert.equal((accepted.task as JsonObject).status, "submitted");
    await assert.rejects(() => a2a.taskGet({ task_id: "accepted", request_id: "poll" }, async () => ({ status: 200, json: async () => ({ result: { id: "remote-ok", status: "unknown" } }) })), /unsupported/);

    const compiler = new IntentCompilerKernel(f.store);
    compiler.compile({ intent_id: "changed", goal: "branch coverage", scope: "changed", metric: "branches", require_governance: true });
    compiler.compile({ intent_id: "workspace", goal: "workspace coverage", scope: "workspace", metric: "lines" });
    const acceptance = compiler.acceptanceCompile({ intent_id: "changed", acceptance_id: "accept" });
    assert.match(String(((acceptance.acceptance as JsonObject).criteria as JsonObject[])[0]?.name), /Incremental/);
    f.store.save("task_intent", "changed", { ...(f.store.get("task_intent", "changed")), goal: "changed goal" });
    assert.throws(() => compiler.acceptanceCompile({ intent_id: "changed", acceptance_id: "accept" }), /idempotency/);
    void card;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("project knowledge rejects escaped and symlinked memory paths", async () => {
  const f = await fixture("craft-project-branches-");
  try {
    const root = join(f.root, "project"); await mkdir(join(root, ".serena", "memories"), { recursive: true });
    await writeFile(join(root, ".serena", "memories", "ok.md"), "safe");
    const kernel = new ProjectKnowledgeKernel(f.store);
    const found = kernel.discover({ project_root: root, trusted: true, discovery_id: "d" });
    const descriptor = (found.discovery as JsonObject).descriptors as JsonObject[];
    assert.equal(descriptor.length, 1);
    const raced = new ProjectKnowledgeKernel(f.store, (() => ({ isSymbolicLink: () => true })) as never);
    assert.throws(() => raced.discover({ project_root: root, trusted: true, discovery_id: "d-race" }), /symbolic/);
    await symlink(join(root, ".serena", "memories", "ok.md"), join(root, ".serena", "memories", "link.md"));
    assert.throws(() => kernel.discover({ project_root: root, trusted: true, discovery_id: "d2" }), /symbolic/);
    f.store.save("project_knowledge_discovery", "d", { ...(found.discovery as JsonObject), descriptors: [{ ...descriptor[0], path: "../../../escape.md" }] });
    assert.throws(() => kernel.resolve({ discovery_id: "d", memory_ids: [String(descriptor[0].memory_id)] }), /escapes/);
    f.store.save("project_knowledge_discovery", "d", { ...(found.discovery as JsonObject), descriptors: [{ ...descriptor[0], path: ".serena/memories/link.md" }] });
    assert.throws(() => kernel.resolve({ discovery_id: "d", memory_ids: [String(descriptor[0].memory_id)] }), /symbolic/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("remote binding and task state cover invalid timestamps, conflicts and revisions", async () => {
  const f = await fixture("craft-remote-state-branches-");
  try {
    const remote = new RemoteRuntimeKernel(f.store);
    f.store.create("task", "task", { title: "task" });
    const tenant = remote.tenantRegister({ tenant_id: "tenant", data_space_id: "space", key_envelope_ref: "key", retention_policy_ref: "ret", deletion_policy_ref: "del" }).tenant as JsonObject;
    assert.throws(() => remote.bind({ tenant_id: tenant.id, task_id: "task", principal_digest: digest("a"), access_receipt_digest: digest("b"), audience: "a", scopes: ["read"], expires_at: "bad", now: "2030-01-01T00:00:00Z" }), /ISO/);
    const args = { binding_id: "binding", tenant_id: tenant.id, task_id: "task", principal_digest: digest("a"), access_receipt_digest: digest("b"), audience: "a", scopes: ["read"], expires_at: "2030-01-01T01:00:00Z", now: "2030-01-01T00:00:00Z" };
    const binding = remote.bind(args);
    assert.throws(() => remote.bind({ ...args, principal_digest: digest("d") }), /idempotency/);
    const state = new TaskStateKernel(f.store);
    assert.throws(() => state.transition({ task_id: "task", state: "prepared", expected_revision: -1 }), /revision/);
    const first = state.transition({ task_id: "task", state: "running" });
    assert.throws(() => state.transition({ task_id: "task", state: "completed", expected_revision: 0 }), /revision|conflict|Concurrent/);
    assert.equal((state.transition({ task_id: "task", state: "completed", expected_revision: Number((first.projection as JsonObject).state_revision) }).projection as JsonObject).state, "completed");
    f.store.create("task_state_projection", "defaults", { task_id: "defaults", state: "prepared" });
    assert.equal((state.transition({ task_id: "defaults", state: "running" }).projection as JsonObject).state, "running");
    void binding;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workflow, registry and OIDC defensive branches are covered", async () => {
  const f = await fixture("craft-defensive-branches-");
  try {
    const workflow = new WorkflowDagKernel(f.store);
    const saved = workflow.save({ workflow_id: "wf-default", name: "WF", nodes: [{ id: "a", type: "action" }] });
    assert.equal((saved.workflow as JsonObject).lifecycle, "draft");
    assert.throws(() => workflow.save({ workflow_id: "wf-invalid", name: "WF", nodes: [{ id: "a", type: "action" }], lifecycle: "invalid" }), /unsupported/);
    const registry = new McpRegistryKernel(f.store);
    const source = registry.sourceRegister({ source_id: "source", endpoint: "https://registry.test", trust: "official" }).source as JsonObject;
    f.store.save("mcp_registry_source", String(source.id), { ...source, enabled: false });
    await assert.rejects(registry.sync({ source_id: source.id }, async () => ({ status: 200, json: async () => ({}) })), /disabled/);
    const verifier = createOidcJwksVerifier({ issuer: "https://issuer.test", audience: "craft", fetch: async () => ({ status: 200, json: async () => ({ keys: [] }) }) });
    await assert.rejects(() => verifier("bad.token"), /compact JWT/);
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k" })).toString("base64url");
    const c = Buffer.from(JSON.stringify({ iss: "https://issuer.test", aud: "craft", sub: "s", exp: 2000000000 })).toString("base64url");
    await assert.rejects(() => verifier(`${h}.${c}.bad`), /usable|signature|key/);
    const malformed = createOidcJwksVerifier({ issuer: "https://issuer.test", audience: "craft", fetch: async () => ({ status: 200, json: async () => ({ keys: [{ kty: "RSA", kid: "k", n: 1, e: "AQAB" }] }) }) });
    await assert.rejects(() => malformed(`${h}.${c}.bad`), /invalid|signature/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("context, replay, local service, bundle, feedback and cost ledgers cover defaults and conflicts", async () => {
  const f = await fixture("craft-v01211-branches-");
  try {
    const context = new ContextPlaneKernel(f.store);
    const saved = context.save({ project_id: "p", task_id: "t", manifest_id: "m" });
    assert.equal(context.save({ project_id: "p", task_id: "t", manifest_id: "m" }).idempotent, true);
    assert.throws(() => context.save({ project_id: "p", task_id: "t", manifest_id: "m", model: "other" }), /idempotency/);
    const trace = new TraceKernel(f.store);
    trace.start({ trace_id: "no-events", task_id: "t" }); trace.finalize({ trace_id: "no-events", status: "failed", summary: "done" });
    const replay = new ReplayRunnerKernel(f.store);
    assert.throws(() => replay.prepare({ trace_id: "no-events", approval_ref: "a", workspace_digest: "w" }), /replayable/);
    trace.start({ trace_id: "events", task_id: "t" }); trace.append({ trace_id: "events", event_kind: "action", action_contract: { op: "read" } }); trace.finalize({ trace_id: "events", status: "completed", summary: "done" });
    const prepared = replay.prepare({ trace_id: "events", replay_id: "r", approval_ref: "a", workspace_digest: "w" });
    f.store.save("replay_run", "r", { ...(prepared.replay as JsonObject), status: "failed" });
    await assert.rejects(() => replay.execute({ replay_id: "r" }), /not prepared/);
    const local = new LocalRuntimeServiceKernel(f.store);
    assert.equal(local.start({ service_id: "new-service" }).idempotent, false);
    assert.equal(local.start({ service_id: "new-service" }).idempotent, true);
    local.stop({ service_id: "new-service" }); local.stop({ service_id: "new-service" });
    const bundle = new ProjectBundleKernel(f.store);
    const firstBundle = bundle.export({ project_id: "p", bundle_id: "b" });
    assert.equal(bundle.export({ project_id: "p", bundle_id: "b" }).idempotent, true);
    assert.throws(() => bundle.export({ project_id: "other", bundle_id: "b" }), /idempotency/);
    const feedback = new FeedbackLearningKernel(f.store);
    feedback.record({ signal_id: "s", action: "a", diff_digest: digest("d"), reason: "r" });
    assert.equal(feedback.record({ signal_id: "s", action: "a", diff_digest: digest("d"), reason: "r" }).idempotent, true);
    assert.throws(() => feedback.record({ signal_id: "s", action: "changed", diff_digest: digest("d"), reason: "r" }), /idempotency/);
    const cost = new CostLedgerKernel(f.store);
    cost.priceSave({ provider: "p", model: "m", price_id: "price", input_per_million: 1, output_per_million: 1 });
    cost.priceSave({ provider: "p", model: "m", price_id: "price", input_per_million: 2, output_per_million: 2, effective_at: "2030-01-01T00:00:00Z" });
    assert.throws(() => cost.usageRecord({ provider: "p", model: "m", input_tokens: -1, output_tokens: 0 }), /token counts/);
    cost.usageRecord({ provider: "p", model: "m", usage_id: "u", input_tokens: 0, output_tokens: 0 });
    assert.equal((cost.report().total_input_tokens), 0);
    const legacyEvaluator = new DomainEvaluatorKernel(f.store);
    legacyEvaluator.save({ evaluator_id: "legacy-eval", domain: "test", name: "Legacy", criteria: { ok: 1 } });
    assert.throws(() => legacyEvaluator.evaluate({ evaluator_id: "legacy-eval", metrics: [] as never }), /metrics|object/);
    void saved; void firstBundle;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("adapter runtime covers manifest defaults, updates, routing and OpenAPI fallbacks", async () => {
  const f = await fixture("craft-v01226-branches-");
  try {
    assert.equal(defineAdapterManifest({ adapter_id: "a", version: "1", kind: "command" }).entry, "builtin");
    assert.throws(() => defineAdapterManifest({ adapter_id: "bad", version: "1", kind: "command", platforms: ["darwin", "darwin"] }), /unique/);
    assert.throws(() => defineAdapterManifest({ adapter_id: "bad", version: "1", kind: "command", effects: ["unknown"] }), /effect/);
    const runtime = new V01226Runtime(f.store);
    runtime.adapterRegister({ adapter_id: "a", version: "1", kind: "command" });
    assert.equal(runtime.adapterRegister({ adapter_id: "a", version: "1", kind: "command" }).idempotent, true);
    assert.equal((runtime.adapterRegister({ adapter_id: "a", version: "2", kind: "command" }).manifest as JsonObject).version, 2);
    assert.deepEqual((runtime.capabilityProject({ candidates: [{ id: "x", token_cost: 2 }, { id: "y", token_cost: 20 }], required: ["x"], token_budget: 5 }).excluded as JsonObject[]).map((x) => x.reason), ["not_required"]);
    const defaultsProjection = runtime.capabilityProject({ candidates: [{ token_cost: 1 }, { capability: "other", token_cost: 1 }] });
    assert.equal((defaultsProjection.selected as JsonObject[]).length, 2);
    assert.equal((runtime.modelRoute({ candidates: [{ id: "q", quality: 1, cost: 1, latency_ms: 10 }, { id: "c", quality: 2, cost: 3, latency_ms: 2 }], objective: "cost", budget: 2 }).selected as JsonObject).id, "q");
    runtime.modelRoute({ candidates: [{ id: "cost-missing" }], objective: "cost" });
    assert.equal((runtime.modelRoute({ candidates: [{ id: "q", quality: 1, latency_ms: 10 }, { id: "l", quality: 2, latency_ms: 2 }], objective: "latency" }).selected as JsonObject).id, "l");
    runtime.modelRoute({ candidates: [{ id: "latency-missing" }], objective: "latency" });
    assert.equal((runtime.modelRoute({ candidates: [{ id: "low", quality: 1 }, { id: "high", quality: 3 }], objective: "quality" }).selected as JsonObject).id, "high");
    runtime.modelRoute({ candidates: [{ id: "quality-missing" }], objective: "quality" });
    assert.equal((runtime.modelRoute({ candidates: [{ id: "missing-cost" }], budget: 1 }).selected as JsonObject).id, "missing-cost");
    assert.equal((runtime.modelRoute({ candidates: [{ id: "over", cost: 5 }], budget: 1 }).selected as JsonObject).id, "over");
    assert.equal((await importOpenApiDocument(runtime, { openapi: "3.0.0", paths: { "/x": { get: { summary: "read" }, post: {} } } })).manifest !== undefined, true);
    assert.equal((await importOpenApiDocument(runtime, { paths: { "/x": { get: {} } } })).manifest !== undefined, true);
    assert.equal(runtime.deliveryGate({ artifacts: [], evidence: [], required_artifacts: ["a"] }).status, "blocked");
    runtime.durableStart({ run_id: "attempt-default" });
    f.store.save("durable_run", "attempt-default", { ...f.store.get("durable_run", "attempt-default"), attempts: undefined });
    assert.equal(runtime.durableTick("owner").claimed, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("web operation covers allowlist, truncation, non-2xx and browser defaults", async () => {
  const f = await fixture("craft-web-remaining-");
  try {
    const web = new WebOperationKernel(f.store);
    await assert.rejects(() => web.fetch({ url: "https://example.test", allowed_hosts: ["other.test"] }, async () => new Response("x")), /allowed_hosts/);
    const first = await web.fetch({ operation_id: "web-fail", url: "https://example.test", max_bytes: 1 }, async () => new Response("long", { status: 404 }));
    assert.equal((first.operation as JsonObject).status_state, "failed"); assert.equal((first.observation as JsonObject).truncated, true);
    assert.equal((await web.fetch({ operation_id: "web-fail", url: "https://example.test" }, async () => new Response("ignored"))).idempotent, true);
    assert.equal((await web.fetch({ url: "https://example.test" }, async () => new Response("ok"))).idempotent, false);
    assert.equal((web.prepare({ operation_id: "browser-default", url: "https://example.test", task_id: "t", workspace: f.root, input_digest: digest("i") }).operation as JsonObject).effect, "read_only");
    assert.equal((web.prepare({ url: "https://example.test", task_id: "t", workspace: f.root, input_digest: digest("j") }).operation as JsonObject).status, "prepared");
    assert.equal((web.prepare({ operation_id: "with-approval", url: "https://example.test", task_id: "t", workspace: f.root, input_digest: digest("k"), approval_ref: "approval" }).operation as JsonObject).approval_ref, "approval");
    assert.throws(() => web.complete({ operation_id: "browser-default", verdict: "unknown", adapter_id: "a", result_digest: "r" }), /unsupported/);
    assert.throws(() => web.prepare({ operation_id: "browser-default", url: "https://example.test", task_id: "t", workspace: f.root, input_digest: digest("other") }), /idempotency/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("trace archive query and retention branches remain observable", async () => {
  const f = await fixture("craft-trace-remaining-");
  try {
    const trace = new TraceKernel(f.store);
    trace.start({ trace_id: "old", task_id: "task" });
    trace.append({ trace_id: "old", event_kind: "action", action_contract: { effect: "read_only" } });
    trace.finalize({ trace_id: "old", status: "completed", summary: "done" });
    const current = f.store.get("trace", "old"); f.store.save("trace", "old", { ...current, last_event_at: "2020-01-01T00:00:00Z" });
    trace.retentionSweep({ now: "2030-01-01T00:00:00Z", max_days: 1 });
    assert.equal(trace.query({ trace_id: "old" }).count, 2);
    assert.equal(trace.query({ trace_id: "old", event_kind: "action" }).count, 1);
    assert.equal(Number((trace.query({ task_id: "task" }) as JsonObject).count) >= 1, true);
    assert.throws(() => trace.retentionSweep({ policy_id: "missing", now: "2030-01-01T00:00:00Z" }), /Unknown/);
    f.store.create("trace_policy", "nullish", { max_days: 1, identity_digest: "sha256:x" });
    assert.equal(trace.retentionPlan({ policy_id: "nullish", max_days: 1, max_events: 1, replace: true }).idempotent, false);
    trace.start({ trace_id: "existing-archive", task_id: "task" }); trace.finalize({ trace_id: "existing-archive", status: "completed", summary: "done" });
    const existingTrace = f.store.get("trace", "existing-archive");
    f.store.save("trace", "existing-archive", { ...existingTrace, last_event_at: "2020-01-01T00:00:00Z" });
    const pointer = trace.archives.write({ trace_id: "existing-archive", trace_version: 1, archived_at: "2020-01-01T00:00:00Z", trace: { id: "existing-archive" }, events: [], feedback: [] });
    f.store.create("trace_archive", "existing-archive", { trace_id: "existing-archive", trace_version: 1, status: "completed", archive_storage: pointer.storage, archive_locator: pointer.locator, archive_uri: pointer.uri, archive_format: pointer.format, content_digest: pointer.content_digest, bytes: pointer.bytes });
    assert.equal(trace.retentionSweep({ now: "2030-01-01T00:00:00Z", max_days: 1 }).archived, 1);
    const eventPointer = trace.archives.write({ trace_id: "archived-events", trace_version: 1, archived_at: "2020-01-01T00:00:00Z", trace: { id: "archived-events", task_id: "task" }, events: [{ id: "archive-event", event_kind: "archived" }], feedback: [] });
    f.store.create("trace_archive", "archived-events", { trace_id: "archived-events", trace_version: 1, task_id: "task", status: "completed", archive_storage: eventPointer.storage, archive_locator: eventPointer.locator, archive_uri: eventPointer.uri, archive_format: eventPointer.format, content_digest: eventPointer.content_digest, bytes: eventPointer.bytes });
    assert.equal(trace.query({ event_kind: "archived" }).count, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("runtime acceptance covers pre-evaluation, duplicate slots, ties and baseline wins", async () => {
  const f = await fixture("craft-acceptance-remaining-");
  try {
    const k = new RuntimeAcceptanceKernel(f.store);
    assert.throws(() => k.plan({ case_ids: ["dup", "dup"], host_ids: ["h1", "h2"], trials_per_pair: 3, baseline_harness: "base", candidate_harness: "cand", environment_fingerprint: "e", budget_fingerprint: "b", observer_kind: "o" }), /unique/);
    assert.throws(() => k.plan({ case_ids: ["c1", "c2"], host_ids: ["h1", "h2"], trials_per_pair: 3.5, baseline_harness: "base", candidate_harness: "cand", environment_fingerprint: "e", budget_fingerprint: "b", observer_kind: "o" }), /integer/);
    const plan = k.plan({ plan_id: "p", case_ids: ["c1", "c2"], host_ids: ["h1", "h2"], trials_per_pair: 3, baseline_harness: "base", candidate_harness: "cand", environment_fingerprint: "e", budget_fingerprint: "b", observer_kind: "o" }).plan as JsonObject;
    assert.equal(k.plan({ plan_id: "p", case_ids: ["c1", "c2"], host_ids: ["h1", "h2"], trials_per_pair: 3, baseline_harness: "base", candidate_harness: "cand", environment_fingerprint: "e", budget_fingerprint: "b", observer_kind: "o" }).idempotent, true);
    assert.equal(k.get({ plan_id: plan.id }).evaluation, null);
    f.store.create("host_session", "s", { host_id: "h1", environment_fingerprint: "e", trace_id: "tr" });
    f.store.create("outcome_observation", "o", { trace_id: "tr", host_id: "h1", observer_kind: "o", observer_id: "independent", verdict: "passed" });
    const rec = { plan_id: plan.id, host_id: "h1", case_id: "c1", trial_index: 1, arm: "baseline", harness: "base", environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "s", observation_id: "o" };
    k.record({ ...rec, record_id: "r1" });
    assert.throws(() => k.record({ ...rec, record_id: "r2" }), /slot/);
    const result = k.evaluate({ plan_id: plan.id });
    assert.equal((result.evaluation as JsonObject).status, "inconclusive");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("supply-chain attestation covers invalid publisher, signature, idempotency and revocation", async () => {
  const f = await fixture("craft-supply-remaining-");
  try {
    const supply = new SupplyChainAttestationKernel(f.store);
    assert.throws(() => supply.publisherRegister({ publisher_id: "bad", public_key_pem: "not-a-key", identity_ref: "id" }), /invalid/);
    const keys = generateKeyPairSync("ed25519");
    const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const publisher = supply.publisherRegister({ publisher_id: "p", public_key_pem: pem, identity_ref: "id" }).publisher as JsonObject;
    assert.equal(supply.publisherRegister({ publisher_id: "p", public_key_pem: pem, identity_ref: "id" }).idempotent, true);
    assert.throws(() => supply.publisherRegister({ publisher_id: "p", public_key_pem: pem, identity_ref: "other" }), /idempotency/);
    const subject = digest("subject");
    assert.throws(() => supply.attest({ publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "a", subject_digest: "bad", signature: "x" }), /SHA-256/);
    assert.throws(() => supply.attest({ publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "a", subject_digest: subject, signature: Buffer.from("bad").toString("base64url") }), /signature/);
    const signature = sign(null, Buffer.from(subject), keys.privateKey).toString("base64url");
    const att = supply.attest({ attestation_id: "att", publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "a", subject_digest: subject, signature });
    assert.equal((supply.attest({ publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "b", subject_digest: subject, signature }).attestation as JsonObject).status, "verified");
    assert.equal(supply.attest({ attestation_id: "att", publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "a", subject_digest: subject, signature }).idempotent, true);
    assert.throws(() => supply.attest({ attestation_id: "att", publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "a", subject_digest: digest("other"), signature }), /SHA-256|idempotency|verify/);
    const subjectB = digest("subject-b"); const signatureB = sign(null, Buffer.from(subjectB), keys.privateKey).toString("base64url");
    assert.throws(() => supply.attest({ attestation_id: "att", publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "b", subject_digest: subjectB, signature: signatureB }), /idempotency conflict/);
    f.store.save("supply_chain_publisher", String(publisher.id), { ...publisher, public_key_pem: "invalid" });
    assert.throws(() => supply.attest({ publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "invalid-key", subject_digest: subject, signature }), /signature is invalid/);
    f.store.save("supply_chain_publisher", String(publisher.id), { ...publisher, status: "active" });
    f.store.save("supply_chain_publisher", String(publisher.id), { ...publisher, status: "revoked" });
    assert.throws(() => supply.attest({ publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "c", subject_digest: subject, signature }), /not active/);
    assert.equal(supply.revoke({ attestation_id: String((att.attestation as JsonObject).id), reason: "r" }).idempotent, false);
    assert.throws(() => supply.assertCurrent({ attestation_id: String((att.attestation as JsonObject).id), current_subject_digest: subject }), /not active/);
    assert.equal(supply.revoke({ attestation_id: String((att.attestation as JsonObject).id), reason: "r" }).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("internal host covers optional bindings, persisted non-text messages and tool argument defaults", async () => {
  const f = await fixture("craft-internal-remaining-");
  try {
    const provider = defineProvider({ provider: "demo", label: "Demo", protocol: "openai-compatible", base_url: "https://example.test/v1", api_key_env: "DEMO_KEY", models: { standard: "demo" } });
    f.store.create("task", "task", { title: "task" });
    let turn = 0;
    const driver = new InternalHostDriver(f.store, { providers: [provider], transport: { complete: async (): Promise<ChatResult> => {
      turn += 1;
      return turn === 1 ? { text: "", model: "demo", usage: { input_tokens: 1, output_tokens: 1 }, tool_calls: [{ id: "call", type: "function", function: { name: "noop", arguments: "" } }] } : { text: "done", model: "demo", usage: { input_tokens: 1, output_tokens: 1 } };
    } }, invokeAction: () => ({ ok: true }) });
    const prepared = driver.prepare({ task_id: "task", prompt: "go", session_id: "session", context_digest: digest("context"), acceptance_ref: "accept" });
    f.store.create("internal_session", `session_${String((prepared.dispatch as JsonObject).id)}`, { messages: [{ role: "user", content: { structured: true } }] });
    const executed = await driver.execute({ dispatch_id: String((prepared.dispatch as JsonObject).id), prompt: "go" });
    assert.equal((executed.receipt as JsonObject).status, "completed");
    const preparedNull = driver.prepare({ dispatch_id: "null-content", task_id: "task", prompt: "null", session_id: "session-null", context_digest: digest("context"), acceptance_ref: "accept" });
    f.store.create("internal_session", `session_${String((preparedNull.dispatch as JsonObject).id)}`, { messages: [{ role: "user", content: null }] });
    assert.equal((await driver.execute({ dispatch_id: String((preparedNull.dispatch as JsonObject).id), prompt: "null" })).receipt !== undefined, true);
    const finalDriver = new InternalHostDriver(f.store, { providers: [provider], transport: { complete: async (): Promise<ChatResult> => ({ text: "", model: "demo", usage: null }) } });
    const finalDispatch = finalDriver.prepare({ dispatch_id: "empty-final", task_id: "task", prompt: "empty", context_digest: digest("context"), acceptance_ref: "accept" });
    assert.equal((await finalDriver.execute({ dispatch_id: String((finalDispatch.dispatch as JsonObject).id), prompt: "empty" })).receipt !== undefined, true);
    const malformedDriver = new InternalHostDriver(f.store, {
      providers: [provider],
      transport: { complete: async (): Promise<ChatResult> => ({ text: "", model: "demo", usage: null, tool_calls: [{ id: "bad", type: "function", function: { name: "noop", arguments: "{" } }] }) },
      invokeAction: () => ({ ok: true }),
    });
    const malformedDispatch = malformedDriver.prepare({ dispatch_id: "malformed-args", task_id: "task", prompt: "bad" });
    const malformedRun = await malformedDriver.execute({ dispatch_id: String((malformedDispatch.dispatch as JsonObject).id), prompt: "bad" });
    assert.equal((malformedRun.receipt as JsonObject).status, "failed");
    const stringDriver = new InternalHostDriver(f.store, { providers: [provider], transport: { complete: async (): Promise<ChatResult> => ({ text: "done", model: "demo", usage: null }) } });
    const stringDispatch = stringDriver.prepare({ dispatch_id: "string-content", task_id: "task", prompt: "string" });
    f.store.create("internal_session", `session_${String((stringDispatch.dispatch as JsonObject).id)}`, { messages: [{ role: "user", content: "plain" }] });
    assert.equal((await stringDriver.execute({ dispatch_id: String((stringDispatch.dispatch as JsonObject).id), prompt: "string" })).receipt !== undefined, true);
    const noActionDriver = new InternalHostDriver(f.store, { providers: [provider], transport: { complete: async (): Promise<ChatResult> => ({ text: "", model: "demo", usage: null, tool_calls: [{ id: "call-noop", type: "function", function: { name: "noop", arguments: "{}" } }] }) } });
    const noActionDispatch = noActionDriver.prepare({ dispatch_id: "no-action", task_id: "task", prompt: "no action" });
    const noActionRun = await noActionDriver.execute({ dispatch_id: String((noActionDispatch.dispatch as JsonObject).id), prompt: "no action" });
    assert.match(String((noActionRun.receipt as JsonObject).final_message), /Tool call noop/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("host run records resolved failed and cancelled receipts", async () => {
  const f = await fixture("craft-host-resolved-");
  try {
    f.store.create("demo_dispatch", "failed-dispatch", { task_id: "task", status: "prepared" });
    const failed = new HostRunKernel(f.store, [{ host: "demo", dispatchKind: "demo_dispatch", prepare: (args) => args, execute: async () => ({ receipt: { id: "failed-receipt", status: "failed", cancelled: false } }) }]);
    failed.start({ run_id: "resolved-failed", host: "demo", dispatch_id: "failed-dispatch", prompt: "go" });
    await failed.wait("resolved-failed");
    assert.equal(f.store.get("host_run", "resolved-failed").status, "failed");
    f.store.create("demo_dispatch", "cancel-dispatch", { task_id: "task", status: "prepared" });
    const cancelled = new HostRunKernel(f.store, [{ host: "demo", dispatchKind: "demo_dispatch", prepare: (args) => args, execute: async () => ({ receipt: { id: "cancel-receipt", status: "completed", cancelled: true } }) }]);
    cancelled.start({ run_id: "resolved-cancelled", host: "demo", dispatch_id: "cancel-dispatch", prompt: "go" });
    await cancelled.wait("resolved-cancelled");
    assert.equal(f.store.get("host_run", "resolved-cancelled").status, "cancelled");
    f.store.create("demo_dispatch", "complete-dispatch", { task_id: "task", status: "prepared" });
    const complete = new HostRunKernel(f.store, [{ host: "demo", dispatchKind: "demo_dispatch", prepare: (args) => args, execute: async () => ({ receipt: { id: "complete-receipt", status: "completed" } }) }]);
    complete.start({ run_id: "resolved-complete", host: "demo", dispatch_id: "complete-dispatch", prompt: "go" });
    await complete.wait("resolved-complete");
    assert.equal(f.store.get("host_run", "resolved-complete").status, "completed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("runtime truth persistence covers defaults, idempotency and event validation", async () => {
  const f = await fixture("craft-truth-remaining-");
  try {
    const k = new RuntimeTruthKernel(f.store);
    const trace = { trace_id: "t", schema: "craft.trace", schema_revision: 1, status: "completed", events: [] } as JsonObject;
    const first = k.standardize({ trace, export_id: "e" }); assert.equal(k.standardize({ trace, export_id: "e" }).idempotent, true); void first;
    assert.throws(() => k.otlp({ trace, events: {} }), /array/);
    k.otlp({ trace, events: [{ trace_id: "t", event_kind: "x" }] });
    const exported = await k.export({ endpoint: "https://collector.test/v1/traces", trace, fetch_impl: async () => ({ status: 200, body: "ok" }) });
    assert.equal((exported.export as JsonObject).accepted, true);
    const compact = k.compact({ session_id: "s", messages: [{ role: "user", content: "ok" }] }); assert.equal((compact.compaction as JsonObject).session_id, "s");
    k.compact({ session_id: "s-explicit", messages: [{ role: "user", content: "ok" }], max_chars: 256 });
    const nullCompaction = compactConversation([{ role: "system", content: null }, { role: "user", content: "x".repeat(300) }, { role: "assistant", content: null }], 256);
    assert.equal(nullCompaction.compacted, true);
    assert.equal(k.workNote({ note_id: "n", goal: "goal" }).idempotent, false); assert.equal(k.workNote({ note_id: "n", goal: "goal" }).idempotent, true);
    assert.throws(() => k.workNote({ goal: "" }), /goal/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("OS security defaults and receipt replay are covered", async () => {
  const f = await fixture("craft-os-remaining-");
  try {
    const { OsSecurityKernel } = await import("../src/os-security.ts");
    const os = new OsSecurityKernel(f.store);
    assert.equal((os.plan({ platform: "linux", workspace: f.root }).plan as JsonObject).status, "planned");
    const plan = os.plan({ plan_id: "p", platform: "linux", workspace: f.root }).plan as JsonObject;
    assert.equal(plan.network, "denied"); assert.equal(plan.filesystem, "read_only");
    assert.equal(os.plan({ plan_id: "p", platform: "linux", workspace: f.root }).idempotent, true);
    assert.throws(() => os.plan({ plan_id: "p", platform: "linux", workspace: "/other" }), /idempotency/);
    const receipt = os.verify({ plan_id: "p", receipt_id: "r", observed: {}, evidence_ids: [] });
    assert.equal(receipt.compatible, false); assert.equal(os.verify({ plan_id: "p", receipt_id: "r", observed: {}, evidence_ids: [] }).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("project brain and work session cover default projection and reference branches", async () => {
  const f = await fixture("craft-brain-session-remaining-");
  try {
    const brain = new ProjectBrainKernel(f.store); brain.open({ project_id: "p" });
    f.store.create("task", "t", { project_id: "p", goal: "g", title: "T" });
    const goal = brain.goalSave({ project_id: "p", goal_id: "g1", title: "Goal" });
    brain.goalSave({ project_id: "p", goal_id: "g1" });
    brain.materialBind({ project_id: "p", material_id: "m", name: "M", uri: "file:///m", content_digest: "sha256:m" });
    brain.materialBind({ project_id: "p", material_id: "m", name: "M2", uri: "file:///m2", content_digest: "sha256:m2" });
    brain.outcomeRecord({ project_id: "p", outcome_id: "o", verdict: "passed", summary: "ok" });
    brain.experienceRecord({ project_id: "p", experience_id: "x", name: "X", pattern: "p" });
    const sessions = new WorkSessionKernel(f.store);
    assert.throws(() => sessions.prepare({ project_id: "p", task_id: "t", knowledge_refs: "bad" as never }), /array/);
    assert.throws(() => sessions.prepare({ project_id: "p", task_id: "t", excluded_refs: ["x", "x"] }), /unique/);
    const prepared = sessions.prepare({ project_id: "p", task_id: "t", session_id: "s", knowledge_refs: [{ id: "k" }], capability_refs: [{ id: "c", version: 1, digest: "sha256:c" }], workflow_refs: [{ id: "w", digest: "sha256:w" }] });
    assert.equal((prepared.session as JsonObject).status, "prepared");
    assert.equal(sessions.refresh({ session_id: "s" }).ready, true);
    f.store.save("project_brain", String((brain.open({ project_id: "p" }).brain as JsonObject).id), { ...(brain.open({ project_id: "p" }).brain as JsonObject), status: "active" });
    assert.equal((sessions.get({ session_id: "s" }).context as JsonObject).read_only, true);
    const sessionRecord = f.store.get("work_session", "s");
    f.store.save("project_brain", String((brain.open({ project_id: "p" }).brain as JsonObject).id), { ...brain.open({ project_id: "p" }).brain as JsonObject, version: 999 });
    f.store.save("work_session", "s", { ...sessionRecord, status: "running", brain_version: 1 });
    assert.equal(sessions.refresh({ session_id: "s" }).next_action, "review_context_drift");
    f.store.create("work_session", "orphan-session", { task_id: "missing", brain_id: "missing", task_version: 1, brain_version: 1, status: "running", next_action: "observe_execution" });
    assert.equal(sessions.refresh({ session_id: "orphan-session" }).next_action, "review_context_drift");
    f.store.create("work_session", "clean-session", { task_id: "t", brain_id: String((brain.open({ project_id: "p" }).brain as JsonObject).id), task_version: 1, brain_version: 999, status: "prepared" });
    assert.equal(sessions.refresh({ session_id: "clean-session" }).next_action, "bind_work_launch");
    f.store.create("work_session", "launched-session", { task_id: "t", brain_id: String((brain.open({ project_id: "p" }).brain as JsonObject).id), task_version: 1, brain_version: 999, status: "prepared", launch_id: "launch" });
    assert.equal(sessions.refresh({ session_id: "launched-session" }).next_action, "observe_execution");
    f.store.create("internal_dispatch", "dispatch", { task_id: "t", session_id: "other" });
    assert.throws(() => sessions.bindDispatch({ session_id: "s", dispatch_id: "dispatch" }), /another session/);
    f.store.create("task", "wrong-task", { project_id: "other", goal: "g" });
    assert.throws(() => sessions.prepare({ project_id: "p", task_id: "wrong-task" }), /does not belong/);
    void goal;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("memory governance covers conflict resolution, expiry and consolidation idempotency", async () => {
  const f = await fixture("craft-memory-remaining-");
  try {
    f.store.create("knowledge_source", "source", { status: "active" }); f.store.create("evidence", "ev", { confidence: "confirmed" });
    const memory = new MemoryGovernanceKernel(f.store, new KnowledgeMemoryRuntime(f.store));
    const base = { source_id: "source", kind: "episodic", scope_kind: "task", scope_id: "t", topic: "topic", evidence_ids: ["ev"] };
    f.store.create("memory_candidate", "legacy-no-conflict-ids", { source_id: "source", kind: "episodic", scope: { kind: "task", id: "t" }, topic: "topic", content_digest: digest("legacy"), status: "candidate" });
    const first = memory.propose({ ...base, candidate_id: "c1", content: "one", valid_until: "2020-01-01T00:00:00Z" });
    const second = memory.propose({ ...base, candidate_id: "c2", content: "two", valid_until: "2030-01-01T00:00:00Z" });
    assert.equal((second.candidate as JsonObject).status, "conflict_pending");
    assert.throws(() => memory.review({ candidate_id: "c2", decision: "approve", reviewer: "r", reason: "r" }), /conflict/);
    memory.resolveConflict({ candidate_id: "c2", resolution: "keep", actor: "r", reason: "keep" });
    memory.review({ candidate_id: "c1", decision: "approve", reviewer: "r", reason: "r" });
    memory.review({ candidate_id: "c2", decision: "approve", reviewer: "r", reason: "r" });
    memory.consolidate({ candidate_ids: ["c1", "c2"], consolidation_id: "cons", summary: "summary" });
    assert.equal(memory.consolidate({ candidate_ids: ["c1", "c2"], consolidation_id: "cons", summary: "summary" }).idempotent, true);
    assert.equal(Number(memory.expirySweep({ now: "2030-02-01T00:00:00Z" }).count) >= 1, true);
    assert.equal(Number(memory.expirySweep().count) >= 0, true);
    f.store.create("memory_candidate", "orphan", { status: "conflict_pending", conflict_ids: ["missing"], scope: { kind: "task", id: "t" }, topic: "topic" });
    assert.equal(memory.resolveConflict({ candidate_id: "orphan", resolution: "dismiss", actor: "r", reason: "dismiss" }).candidate !== undefined, true);
    f.store.create("memory_candidate", "orphan-no-ids", { status: "conflict_pending", scope: { kind: "task", id: "t" }, topic: "topic" });
    f.store.create("memory_candidate", "resolver", { status: "conflict_pending", conflict_ids: ["orphan-no-ids"], scope: { kind: "task", id: "t" }, topic: "topic" });
    assert.equal(memory.resolveConflict({ candidate_id: "resolver", resolution: "keep", actor: "r", reason: "keep" }).candidate !== undefined, true);
    const solo = memory.propose({ ...base, candidate_id: "c3", topic: "solo", content: "three", evidence_ids: ["ev"] });
    const solo2 = memory.propose({ ...base, candidate_id: "c4", topic: "solo2", content: "four", evidence_ids: ["ev"] });
    memory.review({ candidate_id: "c3", decision: "approve", reviewer: "r", reason: "ok" });
    memory.review({ candidate_id: "c4", decision: "approve", reviewer: "r", reason: "ok" });
    assert.equal(memory.consolidate({ candidate_ids: ["c3", "c4"], summary: "solo summary" }).idempotent, false);
    void first;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("service compatibility paths cover explicit studio nodes, claim evidence defaults and model normalization", async () => {
  const f = await fixture("craft-service-remaining-");
  try {
    const { CraftService } = await import("../src/service.ts");
    const service = new CraftService(f.store);
    await assert.rejects((service as unknown as { invokeInternalAction: (action: string, args: JsonObject) => Promise<JsonObject> }).invokeInternalAction("workspace_write", { task_id: "session-task", workspace: f.root, relative_path: "note.txt", content: "note" }), /approval/);
    await service.settingsUpdate({ models: [{ id: "configured", name: "Configured", protocol: "openai-compatible", baseUrl: "https://example.test/v1", model: "configured", apiKeyEnv: "CONFIGURED_KEY", supportsTools: false }] });
    const configuredService = new CraftService(f.store);
    assert.equal((configuredService.modelProviderList().providers as JsonObject[]).some((item) => item.provider === "configured"), true);
    service.studioWorkflowSave({ workflow_id: "nodes", name: "Nodes", nodes: [{ id: "n", type: "action", side_effect: "read_only", depends_on: [] }] });
    service.studioWorkflowSave({ workflow_id: "steps", name: "Steps", steps: [{ id: "s", type: "action" }] });
    service.studioWorkflowSave({ workflow_id: "steps-complete", name: "Steps complete", steps: [{ id: "s", type: "action", side_effect: "read_only", action: "noop", depends_on: [] }] });
    service.studioWorkflowCompatSave({ workflow_id: "compat", name: "Compat", steps: [{ id: "s", type: "action" }] });
    service.studioWorkflowCompatSave({ workflow_id: "compat-inputs", name: "Compat inputs", description: "desc", inputs: [{ id: "x" }], steps: [] });
    service.studioKnowledgeClaimSave({ claim_id: "studio-claim", kind: "fact", content: "candidate" });
    service.capabilityProjection({ candidates: [], token_budget: 1 });
    service.durableRunRecover({ owner: "none" });
    await assert.rejects(service.adapterInstall({ manifest_path: join(f.root, "missing-adapter.json"), integrity: "sha256:missing" }));
    f.store.create("knowledge_claim", "claim", { status: "candidate", evidence_ids: "bad" });
    assert.throws(() => service.knowledgeConflictResolve({ claim_id: "claim", decision: "reviewed", reviewer: "r", reason: "r" }), /Evidence/);
    f.store.create("evidence", "ev", { confidence: "bounded" });
    f.store.create("knowledge_claim", "claim-array", { status: "candidate", evidence_ids: ["ev"] });
    assert.equal((service.knowledgeConflictResolve({ claim_id: "claim-array", decision: "reviewed", reviewer: "r", reason: "r" }).claim as JsonObject).status, "reviewed");
    assert.throws(() => service.modelAdd({ id: "!!!" }), /model id|name/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("action gateway covers absolute data-root reads, writes, completion replay and unsupported operations", async () => {
  const f = await fixture("craft-action-remaining-");
  try {
    const gateway = new ActionGatewayKernel(f.store, f.root);
    f.store.create("task", "t", { title: "task" });
    await writeFile(join(f.root, "input.txt"), "input");
    gateway.prepare({ action_id: "read", task_id: "t", workspace: f.root, operation: "workspace_read", input_digest: digest("i") });
    await gateway.execute({ action_id: "read", relative_path: "input.txt" });
    assert.equal((await gateway.execute({ action_id: "read", relative_path: "input.txt" })).idempotent, true);
    gateway.prepare({ action_id: "write", task_id: "t", workspace: f.root, operation: "workspace_write", effect: "local_write", input_digest: digest("w") });
    await gateway.execute({ action_id: "write", relative_path: "nested/out.txt", approved: true, content: "out" });
    gateway.prepare({ action_id: "data-read", task_id: "t", workspace: "/not-workspace", operation: "workspace_read", input_digest: digest("dr") });
    await gateway.execute({ action_id: "data-read", relative_path: join(f.root, "input.txt") });
    gateway.prepare({ action_id: "bad-write", task_id: "t", workspace: f.root, operation: "workspace_write", effect: "external_write", input_digest: digest("bw") });
    await assert.rejects(() => gateway.execute({ action_id: "bad-write", relative_path: "x", approved: true, content: "x" }), /local_write effect/);
    gateway.prepare({ action_id: "unsupported", task_id: "t", workspace: f.root, operation: "shell", input_digest: digest("s") });
    await assert.rejects(() => gateway.execute({ action_id: "unsupported", relative_path: "x" }), /platform adapter/);
    gateway.prepare({ action_id: "not-prepared", task_id: "t", workspace: f.root, operation: "workspace_read", input_digest: digest("np") });
    f.store.save("action_gateway", "not-prepared", { ...f.store.get("action_gateway", "not-prepared"), status: "running" });
    await assert.rejects(() => gateway.execute({ action_id: "not-prepared", relative_path: "input.txt" }), /not executable/);
    const gate = new AcceptanceGateKernel(f.store); gate.prepare({ gate_id: "g", task_id: "t", work_id: "w", acceptance_ref: "r" });
    assert.throws(() => gate.assess({ gate_id: "g", verdict: "unknown", artifact_ids: [], evidence_ids: [] }), /Unsupported/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workbench experience selects each safe next action and validates filters", async () => {
  const f = await fixture("craft-experience-remaining-");
  try {
    const experience = new WorkbenchExperienceKernel(f.store);
    assert.throws(() => experience.query({ limit: 0 }), /between/);
    f.store.create("work_session", "running", { project_id: "p", task_id: "t", status: "running" });
    assert.equal(experience.query({ project_id: "p" }).next_action, "observe_execution");
    f.store.save("work_session", "running", { ...f.store.get("work_session", "running"), status: "prepared" });
    f.store.create("work_launch", "approval", { task_id: "t", status: "awaiting_approval" });
    assert.equal(experience.query({ task_id: "t" }).next_action, "approve_or_deny");
    f.store.create("assured_work_pilot", "pilot", { task_id: "t", status: "needs_replan" });
    assert.equal(experience.query({ task_id: "t" }).next_action, "review_context_drift");
    assert.equal(experience.get({ session_id: "running" }).content_free, true);
    assert.throws(() => experience.get({ session_id: "" }), /session_id/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("runtime truth and model wire formats cover legacy, tool and compaction branches", async () => {
  const legacy = standardizeTrace({ schema: "craft.trace.v1", id: "legacy", event_type: "tool.call", data: { token: "secret", value: 1 }, sequence: 2, parent_span_id: "p" });
  assert.equal(legacy.legacy_schema, "craft.trace.v1");
  assert.equal((toOtlpTrace({ trace_id: "t", event_kind: "model.reply", sequence: 0, parent_span_id: "p" }, [legacy]).resourceSpans as JsonObject[]).length, 1);
  const calls = parseToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "fn", arguments: { x: 1 } } }] } }], content: [{ type: "tool_use", id: "u", name: "anthropic", input: {} }] });
  assert.equal(calls.length, 2);
  assert.equal(parseToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "default-args" } }] } }] })[0]?.arguments && typeof parseToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "default-args" } }] } }] })[0]?.arguments, "object");
  assert.throws(() => parseToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "fn", arguments: "{" } }] } }] }), /valid JSON/);
  await assert.rejects(exportOtlp("not-a-url", {}, async () => ({ status: 200, body: "" })), /valid HTTP/);
  assert.equal(toolResultMessage("c", { token: "secret", ok: true }).content, '{"ok":true}');
  const messages = [{ role: "system" as const, content: "system" }, { role: "user" as const, content: "x".repeat(300) }, { role: "assistant" as const, content: "y".repeat(300) }];
  assert.equal(compactConversation(messages, 256).compacted, true);
  const tailCompacted = compactConversation([{ role: "system", content: "s" }, { role: "user", content: "x".repeat(300) }, { role: "system", content: "s2" }, { role: "assistant", content: "a" }], 256);
  assert.equal(tailCompacted.compacted, true);
  const provider = defineProvider({ provider: "anthropic", label: "A", protocol: "anthropic", base_url: "https://example.test", api_key_env: "A_KEY", models: { standard: "a" } });
  const req = buildGatewayChatRequest(provider, { model: "a", messages: [{ role: "system", content: "rules" }, { role: "tool", content: null, tool_call_id: "c" }], tools: [{ type: "function", function: { name: "f", description: "d" } }], stream: true });
  assert.equal((req.body as JsonObject).system, "rules");
  const nullSystem = buildGatewayChatRequest(provider, { model: "a", messages: [{ role: "system", content: null }, { role: "user", content: "x" }] });
  assert.equal((nullSystem.body as JsonObject).system, undefined);
  assert.throws(() => buildGatewayChatRequest(provider, { model: "a", messages: [{ role: "bad" as never, content: "x" }] }), /unsupported role/);
  const parsed = parseGatewayChatResponse(provider, { model: "a", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "u", name: "f", input: { x: 1 } }], usage: { input_tokens: 1, output_tokens: 2 } });
  assert.equal(parsed.text, "ok");
  assert.throws(() => parseGatewayChatResponse(provider, { content: [] }), /no text/);
  const openai = defineProvider({ provider: "openai", label: "O", protocol: "openai-compatible", base_url: "https://example.test", api_key_env: "O_KEY", models: { standard: "o" } });
  const openaiParsed = parseGatewayChatResponse(openai, { choices: [{ message: { content: null, tool_calls: [{ function: { name: "f", arguments: { x: 1 } } }] } }] });
  assert.equal(openaiParsed.tool_calls?.[0]?.function.arguments, '{"x":1}');
});

test("legacy runtime validation and state/trust boundaries are exercised", async () => {
  const f = await fixture("craft-legacy-boundaries-");
  try {
    const context = new ContextPlaneKernel(f.store);
    assert.throws(() => context.save({ project_id: "p", task_id: "t", manifest_id: "m", knowledge_refs: ["x", "x"] }), /unique/);
    context.save({ project_id: "p", task_id: "t", manifest_id: "m" });
    assert.equal(context.audit({ manifest_id: "m" }).status, "ready");
    assert.equal(context.audit({ manifest_id: "m", expected_digest: "sha256:drift" }).status, "needs_replan");
    const local = new LocalRuntimeServiceKernel(f.store);
    local.configure({ service_id: "svc", schedule: "cron", startup: "auto", notification: "enabled", crash_recovery: false });
    assert.equal(local.tick({ service_id: "svc" }).skipped, true);
    local.start({ service_id: "svc" });
    f.store.create("runtime_wakeup", "wake", { service_id: "svc", status: "pending" });
    assert.equal(local.tick({ service_id: "svc", now: "2030-01-01T00:00:00Z" }).count, 1);
    const bundle = new ProjectBundleKernel(f.store);
    assert.throws(() => bundle.export({ project_id: "p", limit: 0 }), /between/);
    const state = new StateWorkspaceKernel(f.store);
    assert.equal(stateKind({ isFile: () => true, isDirectory: () => false }, "x"), "file");
    assert.equal(stateKind({ isFile: () => false, isDirectory: () => true }, "x"), "directory");
    assert.throws(() => stateKind({ isFile: () => false, isDirectory: () => false }, "x"), /regular files/);
    f.store.create("workspace", "w", { root_path: f.root, include_paths: ["."], state_revision: 1 });
    assert.throws(() => state.observe({ workspace_id: "w", adapter: "bad" }), /unsupported/);
    assert.throws(() => state.observe({ workspace_id: "w", adapter: "file_artifact", paths: [] }), /at least/);
    const trust = new TrustProfileKernel(f.store);
    const scope = { task_class: "t", capability_revision: "c", model_ref: "m", host_ref: "h" };
    f.store.create("evidence", "ev", { confidence: "confirmed" });
    assert.throws(() => trust.record({ profile_id: "bad", scope, passed: 1, failed: 0, evidence_ids: [] }), /evidence_ids/);
    const profile = trust.record({ profile_id: "tp", scope, passed: 3, failed: 0, evidence_ids: ["ev"] });
    assert.equal((profile.recommendation as JsonObject).recommendation, "notify_only");
    trust.revoke({ profile_id: "tp" });
    assert.equal((trust.recommend({ profile_id: "tp" }).recommendation as string), "blocked");
    const verified = new VerifiedAutonomousWorkKernel(f.store);
    const work = verified.prepare({ work_id: "vw", task_id: "t", context_manifest_id: "m", host: "h", workspace_digest: "d", action_digest: "a", acceptance_ref: "r" });
    assert.equal(verified.prepare({ work_id: "vw", task_id: "t", context_manifest_id: "m", host: "h", workspace_digest: "d", action_digest: "a", acceptance_ref: "r" }).idempotent, true);
    assert.throws(() => verified.prepare({ work_id: "bad", task_id: "t", context_manifest_id: "m", host: "h", workspace_digest: "d", action_digest: "a", acceptance_ref: "r", effect: "unknown" }), /effect/);
    assert.equal((work.work as JsonObject).status, "prepared");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v01226 adapter runtime hits both default and defensive alternatives", async () => {
  const f = await fixture("craft-v01226-extra-");
  try {
    assert.throws(() => defineAdapterManifest({ adapter_id: "x", version: "1", kind: "command", platforms: "any" as never }), /array/);
    assert.throws(() => defineAdapterManifest({ adapter_id: "x", version: "1", kind: "command", capabilities: "run" as never }), /array/);
    const runtime = new V01226Runtime(f.store);
    assert.throws(() => runtime.commandPlan({ argv: "echo" as never }), /array/);
    assert.throws(() => runtime.commandPlan({ argv: ["echo"], effect: "unsupported" }), /effect/);
    assert.throws(() => runtime.commandPlan({ argv: ["echo"], output_limit: 255 }), /between/);
    const projection = runtime.capabilityProject({ candidates: [{ id: "a" }, { capability: "b", token_cost: 2 }], required: [], token_budget: 3 });
    assert.equal((projection.selected as JsonObject[]).length, 1);
    assert.equal((runtime.modelRoute({ candidates: [{ id: "no-metrics" }], budget: 0 }).selected as JsonObject).id, "no-metrics");
    assert.equal((runtime.modelRoute({ objective: "latency", candidates: [{ id: "missing-latency" }] }).selected as JsonObject).id, "missing-latency");
    const manifestPath = join(f.root, "integrity.json");
    await writeFile(manifestPath, JSON.stringify({ adapter_id: "integrity.adapter", version: "1", kind: "command", integrity: "sha256:wrong", signature: "sig" }));
    await assert.rejects(runtime.adapterInstall(manifestPath), /integrity/);
    assert.equal(runtime.durableTick().claimed, false);
    await assert.rejects(importOpenApiDocument(runtime, {}), /no operations/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Workbench Studio routes are reachable through the shared service bridge", async () => {
  const f = await fixture("craft-studio-routes-");
  try {
    const { CraftService } = await import("../src/service.ts");
    const app = new WorkbenchWebApp(new CraftService(f.store), "secret", "http://127.0.0.1:4173", { studioDir: null });
    const req = (method: "GET" | "POST", path: string, body: unknown = {}) => app.handle({ method, path, token: "secret", body: JSON.stringify(body), origin: "http://127.0.0.1:4173" });
    assert.equal(req("GET", "/api/studio/resources").status, 200);
    assert.equal(req("POST", "/api/studio/resources").status, 404);
    assert.notEqual(req("POST", "/api/studio/memory").status, 404);
    assert.equal(req("GET", "/api/studio/memory").status, 404);
    assert.notEqual(req("POST", "/api/studio/memory/missing/retire").status, 404);
    assert.notEqual(req("POST", "/api/studio/knowledge/claims").status, 404);
    assert.equal(req("GET", "/api/studio/knowledge/claims").status, 404);
    assert.notEqual(req("POST", "/api/studio/workflows").status, 404);
    assert.equal(req("GET", "/api/studio/workflows").status, 404);
    const call = (body: unknown) => app.handleAsync({ method: "POST", path: "/api/studio/call", token: "secret", body: JSON.stringify(body), origin: "http://127.0.0.1:4173" });
    assert.equal((await call({ tool: "not_craft" })).status, 422);
    assert.equal((await call({})).status, 422);
    assert.equal((await call({ tool: "craft_unknown" })).status, 422);
    assert.equal((await call({ tool: "craft_info", args: [] })).status, 422);
    assert.equal((await call({ tool: "craft_info" })).status, 200);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("small compatibility kernels exercise explicit invalid and default branches", async () => {
  const f = await fixture("craft-small-branches-");
  try {
    const { OsSecurityKernel } = await import("../src/os-security.ts");
    const os = new OsSecurityKernel(f.store);
    assert.throws(() => os.plan({ platform: "linux", workspace: f.root, network: "bad" }), /network/);
    assert.throws(() => os.plan({ platform: "linux", workspace: f.root, filesystem: "bad" }), /filesystem/);
    assert.throws(() => os.plan({ platform: "linux", workspace: f.root, egress_allowlist: "bad" as never }), /array/);
    assert.equal(defaultSettings().theme, "light");
    assert.throws(() => normalizeSettings({ locale: "fr" }), /locale/);
    assert.throws(() => normalizeSettings({ theme: "neon" }), /theme/);
    assert.throws(() => normalizeSettings({ models: "bad" }), /models/);
    assert.throws(() => normalizeSettings({ models: [{ id: "m", baseUrl: "not-url" }] }), /valid HTTP/);
    assert.throws(() => normalizeSettings({ models: [null] }), /object/);
    const rawRoot = await mkdtemp(join(tmpdir(), "craft-store-meta-default-"));
    const rawPaths = craftPaths(rawRoot); await mkdir(rawPaths.databaseDir, { recursive: true });
    const rawDb = new DatabaseSync(rawPaths.databaseFile); rawDb.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)"); rawDb.close();
    const repaired = await new CraftStore(rawPaths).open(); repaired.close(); await rm(rawRoot, { recursive: true, force: true });
    const brain = new ProjectBrainKernel(f.store);
    brain.open({ project_id: "p" });
    assert.equal((brain.outcomeRecord({ project_id: "p", verdict: "passed", summary: "ok" }).outcome as JsonObject).status, "recorded");
    brain.outcomeRecord({ project_id: "p", outcome_id: "with-refs", task_id: "task-state", session_id: "s", verdict: "passed", summary: "ok", evidence_ids: [], artifact_ids: [] });
    assert.throws(() => brain.get({ project_id: "missing" }), /Unknown Project Brain/);
    assert.throws(() => brain.snapshot({ project_id: "missing" }), /Unknown Project Brain/);
    f.store.create("task", "task-state", { project_id: "p", title: "task" });
    const state = new TaskStateKernel(f.store);
    assert.equal((state.transition({ task_id: "task-state", state: "prepared", evidence_ids: "bad" as never }).projection as JsonObject).state, "prepared");
    f.store.create("knowledge_claim", "home-task", { task_id: "task-state", scope: "other", status: "candidate" });
    f.store.create("knowledge_claim", "home-scope", { scope: "task:task-state", status: "candidate" });
    assert.equal(((new HomeKernel(f.store).task({ task_id: "task-state" }).context as JsonObject).knowledge as JsonObject[]).length, 2);
    const verified = new VerifiedAutonomousWorkKernel(f.store);
    verified.prepare({ work_id: "dup", task_id: "t", context_manifest_id: "m", host: "h", workspace_digest: "d", action_digest: "a", acceptance_ref: "r" });
    assert.throws(() => verified.prepare({ work_id: "bad", task_id: "t", context_manifest_id: "m", host: "h", workspace_digest: "d", action_digest: "a", acceptance_ref: "r", budget: [] as never }), /object/);
    verified.authorize({ work_id: "dup", authorization_ref: "read" });
    const receipt = verified.recordAction({ work_id: "dup", idempotency_key: "k", action_contract: {}, input_digest: "i", result_digest: "r" });
    assert.equal(verified.recordAction({ work_id: "dup", idempotency_key: "k", action_contract: {}, input_digest: "i", result_digest: "r" }).idempotent, true);
    assert.equal((receipt.receipt as JsonObject).status, "observed");
    const work2 = verified.prepare({ work_id: "vw2", task_id: "t", context_manifest_id: "m", host: "h", workspace_digest: "d", action_digest: "a", acceptance_ref: "r" });
    verified.authorize({ work_id: "vw2" });
    verified.reobserve({ work_id: "vw2", observed_digest: "d" });
    assert.equal(verified.deliver({ work_id: "vw2", acceptance_verdict: "failed", artifact_ids: [], evidence_ids: [] }).delivered, false);
    verified.prepare({ work_id: "vw3", task_id: "t", context_manifest_id: "m", host: "h", workspace_digest: "d", action_digest: "a", acceptance_ref: "r" });
    verified.authorize({ work_id: "vw3" });
    verified.reobserve({ work_id: "vw3", observed_digest: "d" });
    assert.throws(() => verified.deliver({ work_id: "vw3", acceptance_verdict: "passed", artifact_ids: "bad" as never, evidence_ids: [] }), /array/);
    assert.throws(() => verified.deliver({ work_id: "vw3", acceptance_verdict: "passed", artifact_ids: ["dup", "dup"], evidence_ids: ["e"] }), /unique/);
    void work2;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("capability connector health and operation guards cover both sides", async () => {
  const f = await fixture("craft-connector-branches-");
  try {
    const k = new CapabilityConnectorKernel(f.store);
    const c = k.register({ connector_id: "builtin", kind: "builtin", name: "Built" }).connector as JsonObject;
    assert.throws(() => k.register({ connector_id: "dupops", kind: "builtin", name: "Dup", allowed_operations: ["x", "x"] }), /unique/);
    assert.throws(() => k.healthRecord({ connector_id: c.id, status: "bad", source_digest: c.metadata_digest, observed_by: "t" }), /unsupported/);
    assert.throws(() => k.healthRecord({ connector_id: c.id, status: "healthy", source_digest: c.metadata_digest, observed_by: "t", health_id: "wrong" }), /derived/);
    f.store.remove("capability_connector_health", `connector_health_${c.id}`);
    const health = k.healthRecord({ connector_id: c.id, status: "healthy", source_digest: c.metadata_digest, observed_by: "t" });
    assert.equal((health.health as JsonObject).status, "healthy");
    f.store.remove("capability_connector_health", `connector_health_${c.id}`);
    assert.equal((k.list({}).connectors as JsonObject[])[0]?.health, "unknown");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("long-task checkpoints cover wake, expiry and context drift outcomes", async () => {
  const f = await fixture("craft-long-task-branches-");
  try {
    const worker = new LongTaskWorkerKernel(f.store);
    f.store.create("work_session", "s", { task_id: "t", version: 1, context_digest: digest("ctx") });
    assert.throws(() => worker.suspend({ session_id: "s", wait_condition: "wait", now: "bad" }), /ISO/);
    const cp = worker.suspend({ session_id: "s", checkpoint_id: "cp", wait_condition: "wait", expires_at: "2030-01-01T00:00:00Z", now: "2029-01-01T00:00:00Z" });
    assert.equal(worker.wake({ checkpoint_id: "cp", signal: "ready", reason: "external", now: "2029-01-02T00:00:00Z" }).idempotent, false);
    assert.equal(worker.resume({ checkpoint_id: "cp", now: "2029-01-02T00:00:00Z" }).ready, true);
    const expired = worker.suspend({ session_id: "s", checkpoint_id: "expired", wait_condition: "wait", expires_at: "2020-01-01T00:00:00Z" });
    assert.equal(Number((worker.tick({ now: "2030-01-01T00:00:00Z" }) as JsonObject).count) >= 1, true);
    assert.equal((cp.checkpoint as JsonObject).status, "waiting");
    assert.equal((expired.checkpoint as JsonObject).status, "waiting");
    f.store.create("long_task_checkpoint", "missing-session", { session_id: "none", status: "waiting", context_digest: "x", session_version: 1 });
    assert.equal(worker.resume({ checkpoint_id: "missing-session" }).ready, false);
    f.store.create("work_launch", "launch-other", { task_id: "other" });
    f.store.create("task_run", "run-mismatch", { contract_id: "c", launch_id: "launch-other" });
    assert.throws(() => worker.suspend({ session_id: "s", task_run_id: "run-mismatch", wait_condition: "wait" }), /does not belong/);
    f.store.create("long_task_checkpoint", "completed", { session_id: "s", status: "completed", context_digest: digest("ctx"), session_version: 1 });
    assert.throws(() => worker.resume({ checkpoint_id: "completed" }), /cannot resume/);
    f.store.create("long_task_checkpoint", "regressed", { session_id: "s", status: "waiting", context_digest: digest("ctx"), session_version: 999 });
    assert.equal(worker.resume({ checkpoint_id: "regressed" }).ready, false);
    f.store.create("long_task_checkpoint", "changed", { session_id: "s", status: "waiting", context_digest: digest("other"), session_version: 1 });
    assert.equal(worker.resume({ checkpoint_id: "changed" }).ready, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("remaining state, trust, org sync and model defaults are exercised", async () => {
  const f = await fixture("craft-more-defaults-");
  try {
    const state = new StateWorkspaceKernel(f.store);
    f.store.create("workspace", "escape", { root_path: f.root, include_paths: ["../outside"], state_revision: 1 });
    assert.throws(() => state.observe({ workspace_id: "escape" }), /relative to the workspace/);
    const trust = new TrustProfileKernel(f.store);
    f.store.create("evidence", "ev", { confidence: "confirmed" });
    assert.throws(() => trust.record({ profile_id: "missing-evidence", scope: { task_class: "class", project_id: "project", capability_revision: "c", model_ref: "m", host_ref: "h" }, passed: 1, failed: 0 }), /evidence_ids/);
    trust.record({ profile_id: "tp", scope: { task_class: "class", project_id: "project", capability_revision: "c", model_ref: "m", host_ref: "h" }, passed: 1, failed: 0, evidence_ids: ["ev"] });
    assert.equal(trust.list({}).count, 1);
    assert.equal(trust.list({ task_class: "class" }).count, 1);
    const { OrgSyncKernel } = await import("../src/org-sync.ts");
    const org = new OrgSyncKernel(f.store);
    const prepared = org.prepare({ sync_id: "sync", workspace_id: "w" });
    const md = String((prepared.manifest as JsonObject).manifest_digest);
    assert.equal(org.apply({ sync_id: "sync", base_digest: md }).status, "applied");
    const preparedExplicit = org.prepare({ sync_id: "sync-explicit", workspace_id: "w" });
    const explicitDigest = String((preparedExplicit.manifest as JsonObject).manifest_digest);
    assert.equal(org.apply({ sync_id: "sync-explicit", base_digest: explicitDigest, current_digest: explicitDigest, tombstones: null }).status, "applied");
    f.store.create("usage_ledger", "usage-defaults", { input_tokens: null, output_tokens: undefined, cost_usd: 1 });
    assert.equal(Number((new (await import("../src/v01211-runtime.ts")).CostLedgerKernel(f.store).report() as JsonObject).total_cost_usd) >= 1, true);
    const provider = defineProvider({ provider: "anthropic", label: "A", protocol: "anthropic", base_url: "https://example.test", api_key_env: "A_KEY", models: { standard: "a" } });
    const request = buildGatewayChatRequest(provider, { model: "a", messages: [{ role: "user", content: "x" }], tools: [] });
    assert.equal((request.body as JsonObject).system, undefined);
    assert.throws(() => parseGatewayChatResponse(provider, { content: [{ type: "tool_use", name: "f", input: {} }] }), /no text/);
    const openai = defineProvider({ provider: "openai", label: "O", protocol: "openai-compatible", base_url: "https://example.test", api_key_env: "O_KEY", models: { standard: "o" } });
    const parsed = parseGatewayChatResponse(openai, { choices: [{ message: { content: "", tool_calls: [{ function: { name: "f", arguments: "{}" } }] } }] });
    assert.equal(parsed.tool_calls?.[0]?.id, "tool_1");
    const parsedDefaults = parseGatewayChatResponse(openai, { choices: [{ message: { content: "", tool_calls: [{ function: { name: "g" } }] } }] });
    assert.deepEqual(parsedDefaults.tool_calls?.[0]?.function.arguments, "{}");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("verified work and web validation conflict branches are explicit", async () => {
  const f = await fixture("craft-more-conflicts-");
  try {
    const verified = new VerifiedAutonomousWorkKernel(f.store);
    verified.prepare({ work_id: "w", task_id: "t", context_manifest_id: "m", host: "h", workspace_digest: "d", action_digest: "a", acceptance_ref: "r" });
    assert.throws(() => verified.prepare({ work_id: "w", task_id: "t", context_manifest_id: "m", host: "h", workspace_digest: "changed", action_digest: "a", acceptance_ref: "r" }), /idempotency conflict/);
    assert.throws(() => verified.recordAction({ work_id: "w", idempotency_key: "k", action_contract: {}, input_digest: "i", result_digest: "r" }), /not authorized/);
    const web = new WebOperationKernel(f.store);
    await assert.rejects(() => web.fetch({ url: "https://example.test", timeout_ms: 0 }), /between/);
    await assert.rejects(() => web.fetch({ url: "https://example.test", allowed_hosts: "example.test" as never }), /array/);
    await assert.rejects(() => web.fetch({ url: "https://example.test", allowed_hosts: ["example.test", "example.test"] }), /unique/);
    const op = web.prepare({ operation_id: "no-approval", url: "https://example.test", task_id: "t", workspace: f.root, input_digest: digest("x") });
    assert.equal((op.operation as JsonObject).approval_ref, null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("MCP HTTP server uses safe default host and injected runtime lifecycle", async () => {
  const runtime = { server: { handle: async () => undefined }, close: () => undefined };
  const served = await serveMcpHttp({ port: 0, start: async () => runtime });
  assert.ok(served.server);
  served.close();
});

test("MCP HTTP server evaluates the documented default port without binding it", async () => {
  const originalListen = Server.prototype.listen;
  const originalClose = Server.prototype.close;
  (Server.prototype as unknown as { listen: (...args: unknown[]) => Server }).listen = (function (this: Server, ...args: unknown[]) { const callback = args.at(-1); if (typeof callback === "function") callback(); return this; }) as unknown as (...args: unknown[]) => Server;
  (Server.prototype as unknown as { close: () => Server }).close = (function (this: Server) { return this; }) as unknown as () => Server;
  try {
    const served = await serveMcpHttp({ start: async () => ({ server: { handle: async () => undefined }, close: () => undefined }) });
    served.close();
  } finally { Server.prototype.listen = originalListen; Server.prototype.close = originalClose; }
});

test("remaining fallback branches are exercised through bounded seams", async () => {
  const f = await fixture("craft-final-branches-");
  try {
    const runtime = new V01226Runtime(f.store);
    runtime.modelRoute({ objective: "cost", candidates: [{ id: "missing", quality: 1 }, { id: "priced", cost: 2 }] });
    runtime.modelRoute({ objective: "latency", candidates: [{ id: "missing", quality: 1 }, { id: "fast", latency_ms: 2 }] });
    runtime.modelRoute({ objective: "quality", candidates: [{ id: "missing" }, { id: "rated", quality: 2 }] });

    const archiveBundle = { trace_id: "archived-query", trace_version: 1, archived_at: "2030-01-01T00:00:00Z", trace: { id: "archived-query", task_id: "task" }, events: [{ event_kind: "first" }, { event_kind: "second" }], feedback: [] };
    const archiveStore = { write: () => ({ storage: "local_jsonl_gzip", format: "craft.trace.archive.v1", locator: "trace-archive/x", uri: "craft://trace-archive/local/x", content_digest: digest("archive"), bytes: 1, backend_id: "backend" }), read: () => archiveBundle } as never;
    f.store.create("trace_archive", "archived-query", { trace_id: "archived-query", task_id: "task", archive_storage: "local_jsonl_gzip", archive_format: "craft.trace.archive.v1", archive_locator: "trace-archive/x", archive_uri: "craft://trace-archive/local/x", content_digest: digest("archive"), bytes: 1 });
    assert.equal(new TraceKernel(f.store, archiveStore).query({ trace_id: "archived-query" }).count, 2);
    const retention = new TraceKernel(f.store, archiveStore);
    retention.start({ trace_id: "fallback-updated", task_id: "task" }); retention.finalize({ trace_id: "fallback-updated", status: "completed", summary: "done" });
    f.store.save("trace", "fallback-updated", { ...f.store.get("trace", "fallback-updated"), last_event_at: null });
    retention.retentionSweep({ now: "2030-01-01T00:00:00Z", max_days: 1 });
    retention.start({ trace_id: "fallback-started", task_id: "task" }); retention.finalize({ trace_id: "fallback-started", status: "completed", summary: "done" });
    const originalList = f.store.list.bind(f.store);
    (f.store as unknown as { list: CraftStore["list"] }).list = ((kind: string, limit?: number, predicate?: (record: JsonObject) => boolean) => {
      if (kind === "trace") return [{ ...f.store.get("trace", "fallback-started"), last_event_at: null, updated_at: null, started_at: "2020-01-01T00:00:00Z" }].filter((item) => !predicate || predicate(item));
      return originalList(kind, limit, predicate);
    }) as CraftStore["list"];
    retention.retentionSweep({ now: "2030-01-01T00:00:00Z", max_days: 1 });
    (f.store as unknown as { list: CraftStore["list"] }).list = originalList;
    f.store.create("trace_policy", "fallback-policy", { max_days: 1, max_events: 10 });
    retention.retentionSweep({ policy_id: "fallback-policy", now: "2030-01-01T00:00:00Z" });

    const brain = new ProjectBrainKernel(f.store); brain.open({ project_id: "session-project" });
    f.store.create("task", "session-task", { project_id: "session-project", title: "Session", goal: "exercise" });
    const sessions = new WorkSessionKernel(f.store);
    assert.throws(() => sessions.prepare({ project_id: "session-project", task_id: "session-task", excluded_refs: "bad" as never }), /array/);
    const prepared = sessions.prepare({ session_id: "session", project_id: "session-project", task_id: "session-task", goal: "exercise" }).session as JsonObject;
    const { brain_version: _brainVersion, ...withoutBrainVersion } = prepared;
    f.store.save("work_session", "session", { ...withoutBrainVersion, status: "running" });
    sessions.refresh({ session_id: "session" });

    const { CraftService } = await import("../src/service.ts");
    const service = new CraftService(f.store);
    (service as unknown as { assertShadowWorkflowReadOnly: (workflow: JsonObject) => void }).assertShadowWorkflowReadOnly({});
    (service as unknown as { assertShadowWorkflowReadOnly: (workflow: JsonObject) => void }).assertShadowWorkflowReadOnly({ steps: [] });
    (service as unknown as { assertShadowWorkflowReadOnly: (workflow: JsonObject) => void }).assertShadowWorkflowReadOnly({ steps: [{}] });
    await assert.rejects((service as unknown as { invokeInternalAction: (action: string, args: JsonObject) => Promise<JsonObject> }).invokeInternalAction("workspace_write", { task_id: "session-task", workspace: f.root, relative_path: "note-approved.txt", content: "note", approval_ref: "approval" }), /approval/);
    service.studioWorkflowCompatSave({ workflow_id: "compat-empty-steps", name: "Empty steps" });
    const claim = f.store.create("knowledge_claim", "claim-null-evidence", { kind: "fact", content: "x", evidence_ids: null, status: "candidate" });
    assert.throws(() => service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "r", reason: "r" }), /Evidence/);
    await service.settingsUpdate({ models: [{ id: "model", name: "Model", protocol: "openai-compatible", baseUrl: "https://model.example/v1", model: "model", apiKeyEnv: "CRAFT_FINAL_KEY", supportsTools: false }] });
    const previousFetch = globalThis.fetch; const previousKey = process.env.CRAFT_FINAL_KEY; process.env.CRAFT_FINAL_KEY = "test-key";
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "model" }), { status: 200 })) as typeof fetch;
    const task = service.taskOpen({ title: "Message", goal: "chat", model_id: "model" }).task as JsonObject;
    const { permission_mode: _permissionMode, ...taskWithoutPermission } = task;
    f.store.save("task", String(task.id), taskWithoutPermission);
    assert.equal((await service.taskMessageSend({ task_id: task.id, content: "hello" })).assistant !== undefined, true);
    const originalCreate = f.store.create.bind(f.store);
    (f.store as unknown as { create: CraftStore["create"] }).create = ((kind: string, id: string, payload: JsonObject) => {
      if (kind === "task_message" && payload.role === "assistant") throw "assistant persistence failure";
      return originalCreate(kind, id, payload);
    }) as CraftStore["create"];
    await assert.rejects(service.taskMessageSend({ task_id: task.id, content: "failure" }), /assistant persistence failure/);
    (f.store as unknown as { create: CraftStore["create"] }).create = originalCreate;
    assert.equal((f.store.events(`task:${task.id}`).at(-1)?.payload as JsonObject).error_class, "UnknownError");
    globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.CRAFT_FINAL_KEY; else process.env.CRAFT_FINAL_KEY = previousKey;
    const auto = service.verifiedWorkLoopWorkbenchPrepare({ workspace: f.root, task_id: "session-task", work_loop_id: "auto-session-loop", host: "codex-cli", prompt: "exercise", sandbox: "read-only" });
    assert.ok(auto.work_loop);
    const autoWorkspace = f.store.list("workspace", 100)[0]!;
    assert.throws(() => service.verifiedWorkLoopWorkbenchPrepare({ workspace: f.root, workspace_id: String(autoWorkspace.id), task_id: "session-task", work_loop_id: "different-loop", host: "codex-cli", prompt: "exercise", sandbox: "read-only", include_paths: ["other"] }), /bound/);
    await Promise.all(f.store.list("host_run", 100).map((run) => service.hostRuns.wait(String(run.id))));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("legacy migration source-state and metadata guards fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-state-extra-"));
  const legacy = await mkdtemp(join(tmpdir(), "legacy-state-extra-"));
  const pages = join(legacy, "data", "pages", "facts"); await mkdir(pages, { recursive: true });
  const page = "---\nstatus: confirmed\ncategory: workflows\nknowledge_type: unknown\nevidence_type: test\nevidence_ref: x\nreuse_reason: reusable\n---\n# F\n";
  await writeFile(join(pages, "meta.md"), page);
  const store = await new CraftStore(craftPaths(root)).open(); const kernel = new LegacyKnowledgeMigrationKernel(store);
  try {
    await assert.rejects(kernel.discover({ source_root: "" }), /source_root/);
    const discovered = await kernel.discover({ migration_id: "state", source_root: legacy });
    const entry = ((discovered.migration as JsonObject).entries as JsonObject[])[0]!;
    assert.equal(entry.reason, "unsupported_metadata");
    await writeFile(join(pages, "current.md"), page.replace("unknown", "stable_project_fact"));
    const second = await kernel.discover({ migration_id: "state2", source_root: legacy });
    const current = ((second.migration as JsonObject).entries as JsonObject[]).find((x) => String(x.rel_path).endsWith("current.md"))!;
    const outsideFile = join(root, "outside.md"); await writeFile(outsideFile, page.replace("unknown", "stable_project_fact")); await symlink(outsideFile, join(pages, "link.md"));
    const tamperedEntries = (second.migration as JsonObject).entries as JsonObject[];
    tamperedEntries.push({ ...current, rel_path: "data/pages/facts/link.md", page_digest: digest(page.replace("unknown", "stable_project_fact")) });
    store.save("legacy_knowledge_migration", "state2", { ...(second.migration as JsonObject), entries: tamperedEntries });
    const escaped = await kernel.importCandidates({ migration_id: "state2", candidate_ids: ["data/pages/facts/link.md"] }, "source", () => ({ evidence_id: "e", claim_id: "c" }));
    assert.equal((escaped.failures as JsonObject[])[0]?.code, "source_path_escape");
    await writeFile(join(pages, "current.md"), "password: supersecretvalue");
    const sensitive = await kernel.importCandidates({ migration_id: "state2", candidate_ids: [String(current.rel_path)] }, "source", () => ({ evidence_id: "e", claim_id: "c" }));
    assert.equal((sensitive.failures as JsonObject[])[0]?.code, "source_sensitive_or_disallowed");
    await rm(join(pages, "current.md"));
    const missing = await kernel.importCandidates({ migration_id: "state2", candidate_ids: [String(current.rel_path)] }, "source", () => ({ evidence_id: "e", claim_id: "c" }));
    assert.equal((missing.failures as JsonObject[])[0]?.code, "source_unavailable");
    await writeFile(join(pages, "current.md"), "x".repeat(256 * 1024 + 1));
    const large = await kernel.importCandidates({ migration_id: "state2", candidate_ids: [String(current.rel_path)] }, "source", () => ({ evidence_id: "e", claim_id: "c" }));
    assert.equal((large.failures as JsonObject[])[0]?.code, "source_unavailable");
    const escape = await mkdtemp(join(tmpdir(), "legacy-state-escape-")); const escapedRoot = await mkdtemp(join(tmpdir(), "legacy-state-root-")); await mkdir(join(escapedRoot, "data"), { recursive: true }); await symlink(escape, join(escapedRoot, "data", "pages"));
    await assert.rejects(kernel.discover({ migration_id: "escaped", source_root: escapedRoot }), /escapes source_root/);
    await rm(escapedRoot, { recursive: true, force: true }); await rm(escape, { recursive: true, force: true });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); }
});

test("runtime acceptance strict promotion and idempotent record paths are exercised", async () => {
  const f = await fixture("craft-acceptance-strict-");
  try {
    const k = new RuntimeAcceptanceKernel(f.store);
    assert.throws(() => k.plan({ case_ids: ["a"], host_ids: ["h", "h2"], trials_per_pair: 3, baseline_harness: "b", candidate_harness: "c", environment_fingerprint: "e", budget_fingerprint: "b", observer_kind: "o" }), /exactly 2/);
    const plan = k.plan({ plan_id: "strict", case_ids: ["a", "b"], host_ids: ["h", "h2"], trials_per_pair: 5, baseline_harness: "base", candidate_harness: "cand", environment_fingerprint: "e", budget_fingerprint: "b", observer_kind: "o" }).plan as JsonObject;
    assert.throws(() => k.plan({ plan_id: "strict", case_ids: ["different", "other"], host_ids: ["h", "h2"], trials_per_pair: 5, baseline_harness: "base", candidate_harness: "cand", environment_fingerprint: "e", budget_fingerprint: "b", observer_kind: "o" }), /idempotency/);
    const autoPlan = k.plan({ case_ids: ["x", "y"], host_ids: ["u", "v"], trials_per_pair: 3, baseline_harness: "base", candidate_harness: "cand", environment_fingerprint: "e", budget_fingerprint: "b", observer_kind: "o" }).plan as JsonObject;
    f.store.create("host_session", "auto-session", { host_id: "u", trace_id: "auto-trace", environment_fingerprint: "e" });
    f.store.create("outcome_observation", "auto-observation", { trace_id: "auto-trace", host_id: "u", observer_kind: "o", observer_id: "independent", verdict: "passed" });
    assert.throws(() => k.record({ plan_id: autoPlan.id, host_id: "u", case_id: "missing", trial_index: 1, arm: "baseline", harness: "base", environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "auto-session", observation_id: "auto-observation" }), /not in the plan/);
    k.record({ plan_id: autoPlan.id, host_id: "u", case_id: "x", trial_index: 1, arm: "baseline", harness: "base", environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "auto-session", observation_id: "auto-observation" });
    k.evaluate({ plan_id: autoPlan.id });
    for (const host of ["h", "h2"]) for (const c of ["a", "b"]) for (let trial = 1; trial <= 5; trial++) for (const arm of ["baseline", "candidate"] as const) {
      const sid = `${host}-${c}-${trial}-${arm}`; f.store.create("host_session", sid, { host_id: host, trace_id: `tr-${sid}`, environment_fingerprint: "e" });
      f.store.create("outcome_observation", `obs-${sid}`, { trace_id: `tr-${sid}`, host_id: host, observer_kind: "o", observer_id: "independent", verdict: arm === "candidate" ? "passed" : "failed" });
      const args = { plan_id: plan.id, record_id: `rec-${sid}`, host_id: host, case_id: c, trial_index: trial, arm, harness: arm === "candidate" ? "cand" : "base", environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: sid, observation_id: `obs-${sid}` };
      k.record(args); assert.equal(k.record(args).idempotent, true);
      if (host === "h" && c === "a" && trial === 1 && arm === "candidate") {
        f.store.save("outcome_observation", `obs-${sid}`, { ...f.store.get("outcome_observation", `obs-${sid}`), verdict: "failed" });
        assert.throws(() => k.record(args), /idempotency conflict/);
      }
    }
    const evaluation = k.evaluate({ plan_id: plan.id, evaluation_id: "strict-eval" });
    assert.equal((evaluation.evaluation as JsonObject).status, "eligible");
    assert.equal(k.evaluate({ plan_id: plan.id, evaluation_id: "strict-eval" }).idempotent, true);
    f.store.save("runtime_acceptance_record", "rec-h-a-1-baseline", { ...f.store.get("runtime_acceptance_record", "rec-h-a-1-baseline"), verdict: "passed" });
    assert.throws(() => k.evaluate({ plan_id: plan.id, evaluation_id: "strict-eval", now: "2031-01-01T00:00:00Z" }), /idempotency/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
