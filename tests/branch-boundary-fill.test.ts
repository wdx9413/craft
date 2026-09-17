import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { IntentCompilerKernel } from "../src/intent-compiler.ts";
import { OsSecurityKernel } from "../src/os-security.ts";
import { TrustProfileKernel } from "../src/trust-profile.ts";
import { OrgSyncKernel } from "../src/org-sync.ts";
import { McpRegistryKernel } from "../src/mcp-registry.ts";
import { RuntimeAcceptanceKernel } from "../src/runtime-acceptance.ts";
import { LongTaskWorkerKernel } from "../src/long-task-worker.ts";
import { MemoryGovernanceKernel } from "../src/memory-governance.ts";
import { ProjectBrainKernel } from "../src/project-brain.ts";
import { WorkSessionKernel } from "../src/work-session.ts";
import { WorkflowDagKernel } from "../src/workflow-dag.ts";
import { RuntimeTruthKernel } from "../src/runtime-truth-kernel.ts";
import { VerifiedAutonomousWorkKernel } from "../src/v01212-verified-work.ts";
import { WebOperationKernel } from "../src/web-operation.ts";
import { RemoteRuntimeKernel } from "../src/remote-runtime.ts";
import { TaskStateKernel } from "../src/task-state.ts";
import { ProjectKnowledgeKernel } from "../src/project-knowledge.ts";
import { SupplyChainAttestationKernel } from "../src/supply-chain-attestation.ts";
import { ActionGatewayKernel, AcceptanceGateKernel, ProviderRouterKernel } from "../src/v01213-runtime.ts";
import { RuntimeAssuranceKernel } from "../src/runtime-assurance.ts";
import { PlatformExecutionKernel } from "../src/platform-execution.ts";
import { CampaignRunnerKernel } from "../src/campaign-runner.ts";
import { TraceKernel } from "../src/trace-kernel.ts";
import { V01226Runtime } from "../src/v01226-runtime.ts";
import { CraftService } from "../src/service.ts";
import { standardizeTrace, traceCorrelation, toOtlpTrace, compactConversation, parseToolCalls } from "../src/runtime-truth.ts";

async function fixture(prefix = "craft-branch-fill-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store };
}

test("pure runtime truth branches are behaviorally covered", () => {
  assert.throws(() => standardizeTrace(null as unknown as JsonObject), /trace_id|object/);
  assert.throws(() => standardizeTrace({ trace_id: "t", data: [] as unknown as JsonObject }), /object/);
  assert.equal(traceCorrelation({ trace_id: "t", span_id: "s", baggage: null }).trace_id, "t");
  assert.equal(((toOtlpTrace({ trace_id: "t", spans: [] }) as JsonObject).resourceSpans as unknown[]).length, 1);
  assert.deepEqual(parseToolCalls({ choices: [{ message: { tool_calls: [{ id: "x", type: "function", function: { name: "n", arguments: "{}" } }] } }] }), [{ id: "x", name: "n", arguments: {} }]);
  assert.throws(() => parseToolCalls({ choices: [{ message: { tool_calls: [{ id: "x", type: "function", function: { name: "n", arguments: "bad" } }] } }] }), /valid JSON/);
  const short = compactConversation([{ role: "system", content: "sys" }, { role: "user", content: "x".repeat(300) }, { role: "assistant", content: "two" }], 256);
  assert.equal(short.compacted, true);
  assert.equal(compactConversation([{ role: "user", content: "ok" }], 256).compacted, false);
});

test("intent compiler covers inferred metric, defaults, scalar lists and idempotency", async () => {
  const f = await fixture("craft-intent-branches-");
  try {
    const k = new IntentCompilerKernel(f.store);
    for (const [id, goal] of [["m", "method coverage"], ["l", "line coverage"], ["b", "branch coverage"], ["n", "ordinary request"]] as const) {
      const result = k.compile({ intent_id: id, goal, materials: "doc", non_goals: "none", allowed_effects: "read_only" });
      assert.equal((result.intent as JsonObject).id, id);
    }
    const specified = k.compile({ intent_id: "specified", goal: "coverage", scope: "specified", metric: "all", acceptance: {} });
    assert.equal((specified.intent as JsonObject).route, "clarification");
    assert.throws(() => k.compile({ intent_id: "bad", goal: "x", metric: "bad" }), /unsupported/);
    assert.throws(() => k.compile({ intent_id: "bad-scope", goal: "x", scope: "bad" }), /unsupported/);
    assert.throws(() => k.compile({ intent_id: "bad-threshold", goal: "x", threshold: 101 }), /between/);
    const governed = k.compile({ intent_id: "gov", goal: "please test this request", require_governance: true, workspace: "w", baseline: "b", test_command: "t", changed_paths: ["a"], host: "h", model: "m", budget: {}, acceptance: {} });
    assert.equal((k.acceptanceCompile({ intent_id: "gov" }).acceptance as JsonObject).status, "active");
    assert.equal(k.acceptanceCompile({ intent_id: "gov" }).idempotent, true);
    assert.equal(k.acceptanceCompile({ intent_id: "gov", acceptance_id: "other-acceptance" }).idempotent, false);
    void governed;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("OS security and trust profiles cover platform, verification and lifecycle outcomes", async () => {
  const f = await fixture("craft-security-branches-");
  try {
    const os = new OsSecurityKernel(f.store);
    for (const platform of ["win32", "darwin", "linux"]) {
      const plan = os.plan({ plan_id: `p-${platform}`, platform, workspace: "/tmp", network: "allowlist", filesystem: "workspace_write", egress_allowlist: ["example.test"], secret_broker: true }).plan as JsonObject;
      assert.equal((os.verify({ plan_id: plan.id, observed: { boundary_digest: plan.boundary_digest }, evidence_ids: ["e"] }).receipt as JsonObject).compatible, true);
    }
    assert.throws(() => os.plan({ platform: "other", workspace: "/tmp" }), /Unsupported platform/);
    const noEvidence = os.plan({ plan_id: "no-evidence", platform: "linux", workspace: "/tmp" }).plan as JsonObject;
    assert.equal((os.verify({ plan_id: noEvidence.id, observed: { boundary_digest: noEvidence.boundary_digest } }).receipt as JsonObject).compatible, false);
    const trust = new TrustProfileKernel(f.store);
    assert.throws(() => trust.record({ profile_id: "empty", scope: {}, passed: 0, failed: 0, evidence_ids: ["e"] }), /scope/);
    const base = { scope: { task_class: "x", capability_revision: "c", model_ref: "m", host_ref: "h" }, passed: 1, failed: 0, evidence_ids: ["e"] };
    const profile = trust.record({ profile_id: "tp", ...base }).profile as JsonObject;
    assert.equal((trust.recommend({ profile_id: profile.id }).recommendation), "human_approval");
    f.store.save("trust_profile", String(profile.id), { ...profile, attempts: 10, passed: 10, interventions: 0 });
    assert.equal(trust.recommend({ profile_id: profile.id }).recommendation, "automatic");
    const expired = f.store.save("trust_profile", "expired", { ...profile, status: "expired", valid_until: "2000-01-01T00:00:00.000Z" });
    assert.equal(trust.recommend({ profile_id: expired.id }).recommendation, "blocked");
    assert.equal(Number(trust.list({ task_class: "x" }).count) >= 1, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("registry, organization sync and acceptance kernels cover conflicts and response forms", async () => {
  const f = await fixture("craft-registry-branches-");
  try {
    const registry = new McpRegistryKernel(f.store);
    const source = registry.sourceRegister({ source_id: "s", endpoint: "https://registry.test", trust: "official" }).source as JsonObject;
    assert.equal(registry.sourceRegister({ source_id: "s", endpoint: "https://registry.test", trust: "official" }).idempotent, true);
    assert.throws(() => registry.sourceRegister({ source_id: "s", endpoint: "https://other.test", trust: "official" }), /conflict/);
    const server = registry.serverIngest({ source_id: source.id, server_id: "srv", name: "n", version: "1", endpoint: "https://server.test", digest: "d" }).server as JsonObject;
    assert.equal((registry.health({ server_id: server.id }).health as JsonObject).status, "healthy");
    assert.equal(registry.health({ server_id: server.id }).idempotent, true);
    assert.throws(() => registry.health({ server_id: server.id, status: "bad" }), /Unsupported/);
    assert.equal(registry.revoke({ server_id: server.id, reason: "x" }).idempotent, false);
    assert.equal(registry.revoke({ server_id: server.id, reason: "x" }).idempotent, true);
    const sync = await registry.sync({ source_id: source.id }, async () => ({ status: 200, json: async () => ({ servers: [{ name: "n2", version: "1", endpoint: "https://s2.test", digest: "d2" }] }) }));
    assert.equal(sync.count, 1);
    const arraySync = await registry.sync({ source_id: source.id, list_url: "https://registry.test/list" }, async () => ({ status: 200, json: async () => [{ name: "n3", version: "1", endpoint: "https://s3.test", digest: "d3" }] }));
    assert.equal(arraySync.count, 1);
    await assert.rejects(registry.sync({ source_id: source.id }, async () => ({ status: 500, json: async () => ({}) })), /HTTP/);
    const org = new OrgSyncKernel(f.store);
    const manifest = org.prepare({ sync_id: "sync", workspace_id: "w", member_ids: ["m"], record_refs: [] }).manifest as JsonObject;
    assert.equal(org.prepare({ sync_id: "sync", workspace_id: "w", member_ids: ["m"], record_refs: [] }).idempotent, true);
    assert.throws(() => org.prepare({ sync_id: "sync", workspace_id: "other", member_ids: ["m"], record_refs: [] }), /conflict/);
    assert.equal(org.apply({ sync_id: manifest.id, base_digest: manifest.manifest_digest }).status, "applied");
    assert.equal(org.apply({ sync_id: manifest.id, base_digest: "wrong" }).status, "conflict");
    assert.equal(org.prepare({ sync_id: "defaults", workspace_id: "w" }).idempotent, false);
    const acceptance = new RuntimeAcceptanceKernel(f.store);
    const plan = acceptance.plan({ plan_id: "plan", case_ids: ["a", "b"], host_ids: ["h", "h2"], trials_per_pair: 3, baseline_harness: "base", candidate_harness: "cand", environment_fingerprint: "env", budget_fingerprint: "budget", observer_kind: "observer" }).plan as JsonObject;
    assert.throws(() => acceptance.record({ plan_id: plan.id, case_id: "a", host_id: "no", trial_index: 1, arm: "baseline", harness: "base", environment_fingerprint: "env", budget_fingerprint: "budget", host_session_id: "session", observation_id: "obs" }), /Host is not in/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("legacy kernel argument guards exercise non-string and non-object defensive paths", async () => {
  const f = await fixture("craft-guard-branches-");
  try {
    const cases: Array<() => unknown> = [
      () => new LongTaskWorkerKernel(f.store).suspend({ task_id: 7 }),
      () => new MemoryGovernanceKernel(f.store, {} as never).propose({ task_id: 7 }),
      () => new ProjectBrainKernel(f.store).open({ project_id: 7 }),
      () => new WorkSessionKernel(f.store).prepare({ task_id: 7 }),
      () => new WorkflowDagKernel(f.store).validate({ nodes: 7 }),
      () => new RuntimeTruthKernel(f.store).standardize({ trace: 7 }),
      () => new VerifiedAutonomousWorkKernel(f.store).prepare({ task_id: 7 }),
      () => new McpRegistryKernel(f.store).sourceRegister({ endpoint: 7 }),
      () => new RemoteRuntimeKernel(f.store).tenantRegister({ tenant_id: 7 }),
      () => new TaskStateKernel(f.store).transition({ task_id: 7 }),
      () => new ProjectKnowledgeKernel(f.store).discover({ trusted: true, project_root: 7 }),
      () => new SupplyChainAttestationKernel(f.store).publisherRegister({ publisher_id: 7 }),
      () => new ActionGatewayKernel(f.store).prepare({ task_id: 7 }),
      () => new AcceptanceGateKernel(f.store).prepare({ gate_id: 7 }),
      () => new ProviderRouterKernel(f.store).plan({ route_id: 7 }),
      () => new OrgSyncKernel(f.store).prepare({ workspace_id: 7 }),
      () => new OsSecurityKernel(f.store).plan({ platform: "linux", workspace: 7 }),
      () => new ProjectKnowledgeKernel(f.store).resolve({ discovery_id: 7 }),
      () => new RemoteRuntimeKernel(f.store).bind({ tenant_id: 7 }),
      () => new TaskStateKernel(f.store).get({ task_id: 7 }),
      () => new RuntimeAcceptanceKernel(f.store).plan({ case_ids: 7 }),
      () => new TraceKernel(f.store).start({ task_id: 7 }),
      () => new WebOperationKernel(f.store).get({ operation_id: 7 }),
      () => new V01226Runtime(f.store).adapterGet(7 as never),
    ];
    for (const invoke of cases) assert.throws(invoke, /must not be empty|must be an object|Unknown|task_id|nodes must|non-empty array/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workflow DAG and web operations cover branches, defaults and terminal variants", async () => {
  const f = await fixture("craft-workflow-web-branches-");
  try {
    const workflow = new WorkflowDagKernel(f.store);
    assert.throws(() => workflow.validate({ nodes: [{ id: "a", type: "action", depends_on: ["missing"] }] }), /unknown dependency/);
    assert.throws(() => workflow.validate({ nodes: [{ id: "a", type: "retry" }] }), /max_attempts/);
    assert.throws(() => workflow.validate({ nodes: [{ id: "a", type: "subworkflow" }] }), /workflow_id/);
    assert.throws(() => workflow.validate({ nodes: [{ id: "a", type: "action", side_effect: "bad" }] }), /side_effect/);
    const saved = workflow.save({ workflow_id: "wf", name: "WF", nodes: [{ id: "a", type: "action" }, { id: "b", type: "retry", depends_on: ["a"], max_attempts: 2 }], inputs: [], outputs: [] }).workflow as JsonObject;
    assert.equal(workflow.save({ workflow_id: "wf", name: "WF", nodes: [{ id: "a", type: "action" }, { id: "b", type: "retry", depends_on: ["a"], max_attempts: 2 }], inputs: [], outputs: [] }).idempotent, true);
    workflow.transition({ workflow_id: saved.id, target: "candidate", reason: "review" });
    assert.throws(() => workflow.transition({ workflow_id: saved.id, target: "verified", reason: "x", evaluation_run_id: "missing" }), /evaluation_run/);
    const cp = workflow.checkpoint({ checkpoint_id: "cp", run_id: "r", workflow_id: saved.id }).checkpoint as JsonObject;
    assert.equal(workflow.resume({ checkpoint_id: cp.id }).status, "ready");
    assert.equal(workflow.resume({ checkpoint_id: cp.id, graph_digest: "drift" }).status, "needs_replan");
    assert.throws(() => workflow.import({ document: [] }), /object/);
    const web = new WebOperationKernel(f.store);
    assert.throws(() => web.prepare({ url: "ftp://example.test", task_id: "t", workspace: "/tmp", input_digest: "d" }), /http or https/);
    await assert.rejects(web.fetch({ url: "https://example.test", method: "POST" }, async () => new Response("x")), /GET or HEAD/);
    const head = await web.fetch({ operation_id: "head", url: "https://example.test", method: "HEAD", max_bytes: 1 }, async () => new Response(null, { status: 200 }));
    assert.equal((head.observation as JsonObject).body, "");
    const prepared = web.prepare({ operation_id: "browser", url: "https://example.test", task_id: "t", workspace: "/tmp", input_digest: "d" });
    assert.equal((web.complete({ operation_id: "browser", verdict: "blocked", adapter_id: "a", result_digest: "r" }).operation as JsonObject).status, "blocked");
    web.prepare({ operation_id: "browser2", url: "https://example.test", task_id: "t", workspace: "/tmp", input_digest: "d" });
    assert.equal((web.complete({ operation_id: "browser2", verdict: "passed", adapter_id: "a", result_digest: "r" }).operation as JsonObject).status, "completed");
    assert.equal(web.complete({ operation_id: "browser2", verdict: "failed", adapter_id: "a", result_digest: "r" }).idempotent, true);
    void prepared;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("runtime acceptance records every outcome branch and evaluates incomplete, rejected and inconclusive runs", async () => {
  const f = await fixture("craft-acceptance-branches-");
  try {
    const k = new RuntimeAcceptanceKernel(f.store);
    const plan = k.plan({ plan_id: "accept-plan", case_ids: ["case-a", "case-b"], host_ids: ["host-a", "host-b"], trials_per_pair: 3, baseline_harness: "base", candidate_harness: "candidate", environment_fingerprint: "env", budget_fingerprint: "budget", observer_kind: "observer" }).plan as JsonObject;
    const make = (host: string, caseId: string, trial: number, arm: "baseline" | "candidate", verdict: string) => {
      const sessionId = `session-${host}-${caseId}-${trial}-${arm}`; const traceId = `trace-${sessionId}`; const observationId = `obs-${sessionId}`;
      f.store.create("host_session", sessionId, { host_id: host, trace_id: traceId, environment_fingerprint: "env" });
      f.store.create("outcome_observation", observationId, { trace_id: traceId, host_id: host, observer_kind: "observer", observer_id: "independent", verdict });
      return k.record({ plan_id: plan.id, host_id: host, case_id: caseId, arm, harness: arm === "baseline" ? "base" : "candidate", trial_index: trial, environment_fingerprint: "env", budget_fingerprint: "budget", host_session_id: sessionId, observation_id: observationId });
    };
    make("host-a", "case-a", 1, "baseline", "failed"); make("host-a", "case-a", 1, "candidate", "passed");
    make("host-a", "case-a", 2, "baseline", "passed"); make("host-a", "case-a", 2, "candidate", "failed");
    make("host-a", "case-a", 3, "baseline", "passed"); make("host-a", "case-a", 3, "candidate", "passed");
    const incomplete = k.evaluate({ plan_id: plan.id, evaluation_id: "eval-incomplete" });
    assert.equal((incomplete.evaluation as JsonObject).status, "inconclusive");
    f.store.save("runtime_acceptance_plan", String(plan.id), { ...f.store.get("runtime_acceptance_plan", String(plan.id)), status: "collecting" });
    for (const host of ["host-a", "host-b"]) for (const caseId of ["case-a", "case-b"]) for (const trial of [1, 2, 3]) {
      for (const arm of ["baseline", "candidate"] as const) {
        if (host === "host-a" && caseId === "case-a" && trial <= 3) continue;
        make(host, caseId, trial, arm, arm === "candidate" ? "failed" : "passed");
      }
    }
    const evaluated = k.evaluate({ plan_id: plan.id, evaluation_id: "eval-complete" });
    assert.equal((evaluated.evaluation as JsonObject).status, "rejected");
    f.store.save("runtime_acceptance_evaluation", "eval-complete", { ...f.store.get("runtime_acceptance_evaluation", "eval-complete"), evaluation_digest: "sha256:drift" });
    assert.throws(() => k.evaluate({ plan_id: plan.id, evaluation_id: "eval-complete" }), /idempotency/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.13 action, gate and provider compatibility paths are exercised", async () => {
  const f = await fixture("craft-v013-branches-");
  try {
    const action = new ActionGatewayKernel(f.store, f.root);
    f.store.create("task", "task", { title: "task" });
    const read = action.prepare({ action_id: "read", task_id: "task", workspace: f.root, operation: "workspace_read", input_digest: "d" });
    await (await import("node:fs/promises")).writeFile(join(f.root, "a.txt"), "ok");
    assert.equal((await action.execute({ action_id: "read", relative_path: "a.txt" })).idempotent, false);
    assert.equal((await action.execute({ action_id: "read", relative_path: "a.txt" })).idempotent, true);
    assert.throws(() => action.prepare({ action_id: "write", task_id: "task", workspace: f.root, operation: "workspace_write", effect: "local_write", input_digest: "d", approval_ref: null as never }), /approval_ref|must not be empty/);
    const gate = new AcceptanceGateKernel(f.store);
    const pending = gate.prepare({ gate_id: "gate", task_id: "task", work_id: "work", acceptance_ref: "ref" }).gate as JsonObject;
    assert.throws(() => gate.assess({ gate_id: pending.id, verdict: "passed", artifact_ids: [], evidence_ids: [] }), /requires artifacts/);
    assert.equal((gate.assess({ gate_id: pending.id, verdict: "failed", artifact_ids: [], evidence_ids: [] }).gate as JsonObject).status, "failed");
    const provider = new ProviderRouterKernel(f.store);
    const route = provider.plan({ route_id: "route", providers: ["p", "q"] }).route as JsonObject;
    assert.equal((provider.record({ route_id: route.id, provider: "p" }).route as JsonObject).status, "used");
    assert.throws(() => provider.record({ route_id: route.id, provider: "q", usage: [] }), /object/);
    void read;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("service compatibility facades cover default, review and rollback branches", async () => {
  const f = await fixture("craft-service-branches-");
  try {
    const service = new CraftService(f.store);
    service.studioWorkflowSave({ workflow_id: "studio-wf", name: "Studio", steps: [{ type: "action" }] });
    service.studioWorkflowSave({ workflow_id: "studio-placeholder", name: "Placeholder", steps: [] });
    assert.throws(() => service.knowledgeExpirySweep({ now: "bad" }), /ISO/);
    assert.equal((service.knowledgeExpirySweep({}).expired as JsonObject[]).length, 0);
    f.store.create("knowledge_claim", "claim", { status: "candidate", evidence_ids: [] });
    assert.throws(() => service.knowledgeConflictResolve({ claim_id: "claim", decision: "reviewed", reviewer: "r", reason: "r" }), /Evidence/);
    f.store.create("evidence", "evidence-service", { confidence: "bounded", claim: "fact" });
    const page = await service.wikiPageSave({ title: "Page", body: "Body" });
    assert.equal((page.page as JsonObject).scope, "global");
    assert.throws(() => service.modelAdd({ id: "" }), /id/);
    const task = service.taskOpen({ title: "T", goal: "G" }).task as JsonObject;
    const claim = service.knowledgeClaimSave({ claim_id: "service-claim", kind: "fact", content: "fact", scope: "global", evidence_ids: ["evidence-service"] }).claim as JsonObject;
    assert.throws(() => service.knowledgeConflictResolve({ claim_id: claim.id, decision: "bad", reviewer: "r", reason: "r" }), /unsupported/);
    void task;
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("project knowledge read-only bridge covers empty roots and bounded resolution", async () => {
  const f = await fixture("craft-project-knowledge-branches-");
  try {
    const project = await mkdtemp(join(f.root, "project-"));
    await mkdir(join(project, ".serena", "memories"), { recursive: true });
    await writeFile(join(project, ".serena", "memories", "note.md"), "safe memory");
    const kernel = new ProjectKnowledgeKernel(f.store);
    const discovery = kernel.discover({ discovery_id: "d", trusted: true, project_root: project }).discovery as JsonObject;
    assert.throws(() => kernel.resolve({ discovery_id: discovery.id }), /one to three/);
    const resolved = kernel.resolve({ discovery_id: discovery.id, memory_ids: ["serena:note"] });
    assert.equal((resolved.memories as JsonObject[])[0]?.content, "safe memory");
    assert.equal(kernel.discover({ discovery_id: "d", trusted: true, project_root: project }).idempotent, true);
    assert.throws(() => kernel.resolve({ discovery_id: discovery.id, memory_ids: ["serena:note"], max_chars: 1 }), /max_chars/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
