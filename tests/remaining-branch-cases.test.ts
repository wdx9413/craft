import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { ContextPlaneKernel, ReplayRunnerKernel, LocalRuntimeServiceKernel, ProjectBundleKernel, FeedbackLearningKernel, CostLedgerKernel } from "../src/v01211-runtime.ts";
import { V01226Runtime, defineAdapterManifest, importOpenApiDocument } from "../src/v01226-runtime.ts";
import { TraceKernel } from "../src/trace-kernel.ts";
import { RuntimeTruthKernel } from "../src/runtime-truth-kernel.ts";
import { ActionGatewayKernel, AcceptanceGateKernel } from "../src/v01213-runtime.ts";
import { ProjectBrainKernel } from "../src/project-brain.ts";
import { WorkSessionKernel } from "../src/work-session.ts";
import { WorkbenchExperienceKernel } from "../src/workbench-experience.ts";
import { KnowledgeMemoryRuntime } from "../src/knowledge-memory-runtime.ts";
import { MemoryGovernanceKernel } from "../src/memory-governance.ts";

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

    const compiler = new IntentCompilerKernel(f.store);
    compiler.compile({ intent_id: "changed", goal: "branch coverage", scope: "changed", metric: "branches", require_governance: true });
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
    await symlink(join(root, ".serena", "memories", "ok.md"), join(root, ".serena", "memories", "link.md"));
    assert.throws(() => kernel.discover({ project_root: root, trusted: true, discovery_id: "d2" }), /symbolic/);
    f.store.save("project_knowledge_discovery", "d", { ...(found.discovery as JsonObject), descriptors: [{ ...descriptor[0], path: "../../../escape.md" }] });
    assert.throws(() => kernel.resolve({ discovery_id: "d", memory_ids: [String(descriptor[0].memory_id)] }), /escapes/);
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
    assert.equal((runtime.modelRoute({ candidates: [{ id: "q", quality: 1, cost: 1, latency_ms: 10 }, { id: "c", quality: 2, cost: 3, latency_ms: 2 }], objective: "cost", budget: 2 }).selected as JsonObject).id, "q");
    assert.equal((runtime.modelRoute({ candidates: [{ id: "q", quality: 1, latency_ms: 10 }, { id: "l", quality: 2, latency_ms: 2 }], objective: "latency" }).selected as JsonObject).id, "l");
    assert.equal((await importOpenApiDocument(runtime, { openapi: "3.0.0", paths: { "/x": { get: { summary: "read" }, post: {} } } })).manifest !== undefined, true);
    assert.equal((await importOpenApiDocument(runtime, { paths: { "/x": { get: {} } } })).manifest !== undefined, true);
    assert.equal(runtime.deliveryGate({ artifacts: [], evidence: [], required_artifacts: ["a"] }).status, "blocked");
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
    assert.equal((web.prepare({ operation_id: "browser-default", url: "https://example.test", task_id: "t", workspace: f.root, input_digest: digest("i") }).operation as JsonObject).effect, "read_only");
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
    assert.throws(() => trace.retentionSweep({ policy_id: "missing", now: "2030-01-01T00:00:00Z" }), /Unknown/);
    f.store.create("trace_policy", "nullish", { max_days: 1, identity_digest: "sha256:x" });
    assert.equal(trace.retentionPlan({ policy_id: "nullish", max_days: 1, max_events: 1, replace: true }).idempotent, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("runtime acceptance covers pre-evaluation, duplicate slots, ties and baseline wins", async () => {
  const f = await fixture("craft-acceptance-remaining-");
  try {
    const k = new RuntimeAcceptanceKernel(f.store);
    const plan = k.plan({ plan_id: "p", case_ids: ["c1", "c2"], host_ids: ["h1", "h2"], trials_per_pair: 3, baseline_harness: "base", candidate_harness: "cand", environment_fingerprint: "e", budget_fingerprint: "b", observer_kind: "o" }).plan as JsonObject;
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
    assert.equal(supply.attest({ attestation_id: "att", publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "a", subject_digest: subject, signature }).idempotent, true);
    assert.throws(() => supply.attest({ attestation_id: "att", publisher_id: publisher.id, subject_kind: "capability_asset", subject_id: "a", subject_digest: digest("other"), signature }), /SHA-256|idempotency|verify/);
    assert.equal(supply.revoke({ attestation_id: String((att.attestation as JsonObject).id), reason: "r" }).idempotent, false);
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
    const compact = k.compact({ session_id: "s", messages: [{ role: "user", content: "ok" }] }); assert.equal((compact.compaction as JsonObject).session_id, "s");
    assert.equal(k.workNote({ note_id: "n", goal: "goal" }).idempotent, false); assert.equal(k.workNote({ note_id: "n", goal: "goal" }).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("OS security defaults and receipt replay are covered", async () => {
  const f = await fixture("craft-os-remaining-");
  try {
    const { OsSecurityKernel } = await import("../src/os-security.ts");
    const os = new OsSecurityKernel(f.store);
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
    const prepared = sessions.prepare({ project_id: "p", task_id: "t", session_id: "s", knowledge_refs: [{ id: "k" }], capability_refs: [{ id: "c", version: 1, digest: "sha256:c" }], workflow_refs: [{ id: "w", digest: "sha256:w" }] });
    assert.equal((prepared.session as JsonObject).status, "prepared");
    assert.equal(sessions.refresh({ session_id: "s" }).ready, true);
    f.store.save("project_brain", String((brain.open({ project_id: "p" }).brain as JsonObject).id), { ...(brain.open({ project_id: "p" }).brain as JsonObject), status: "active" });
    assert.equal((sessions.get({ session_id: "s" }).context as JsonObject).read_only, true);
    void goal;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("memory governance covers conflict resolution, expiry and consolidation idempotency", async () => {
  const f = await fixture("craft-memory-remaining-");
  try {
    f.store.create("knowledge_source", "source", { status: "active" }); f.store.create("evidence", "ev", { confidence: "confirmed" });
    const memory = new MemoryGovernanceKernel(f.store, new KnowledgeMemoryRuntime(f.store));
    const base = { source_id: "source", kind: "episodic", scope_kind: "task", scope_id: "t", topic: "topic", evidence_ids: ["ev"] };
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
    void first;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("service compatibility paths cover explicit studio nodes, claim evidence defaults and model normalization", async () => {
  const f = await fixture("craft-service-remaining-");
  try {
    const { CraftService } = await import("../src/service.ts");
    const service = new CraftService(f.store);
    service.studioWorkflowSave({ workflow_id: "nodes", name: "Nodes", nodes: [{ id: "n", type: "action", side_effect: "read_only", depends_on: [] }] });
    f.store.create("knowledge_claim", "claim", { status: "candidate", evidence_ids: "bad" });
    assert.throws(() => service.knowledgeConflictResolve({ claim_id: "claim", decision: "reviewed", reviewer: "r", reason: "r" }), /Evidence/);
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
    gateway.prepare({ action_id: "unsupported", task_id: "t", workspace: f.root, operation: "shell", input_digest: digest("s") });
    await assert.rejects(() => gateway.execute({ action_id: "unsupported", relative_path: "x" }), /platform adapter/);
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
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
