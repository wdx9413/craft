import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../core/mcp.ts";
import { productSurfaceOf } from "../core/interfaces/mcp/product-launch.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ComponentReadinessKernel } from "../core/component-readiness.ts";
import { CRAFT_RELEASE_VERSION } from "../core/version.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-standalone-components-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  return { root, store, service };
}

async function dispose(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

test("component diagnosis filters execution receipts by component, session and release without claiming model benefit", async () => {
  const f = await fixture();
  try {
    const kernel = new ComponentReadinessKernel(f.store);
    assert.throws(() => kernel.get({ component: null }), /component must be/);
    assert.throws(() => kernel.diagnose({ component: "knowledge" }, "memory"), /mounted component/);
    for (const observed_tool_names of [null, [false], [" "]]) assert.throws(() => kernel.diagnose({ component: "memory", observed_tool_names }), /observed_tool_names/);
    const empty = kernel.diagnose({ component: "memory" });
    assert.equal((empty.execution_proof as JsonObject).status, "not_observed");
    assert.equal((empty.observability as JsonObject).learning_worker, undefined);
    await writeFile(join(f.store.paths.runtimeDir, "learning-worker-knowledge.lock.json"), JSON.stringify({ pid: 123, owner_id: "owner", runtime_version: "0.12.1" }));
    const worker = (kernel.diagnose({ component: "knowledge" }).observability as JsonObject).learning_worker as JsonObject;
    assert.equal(worker.version_relation, "different"); assert.equal(worker.liveness, "unverified");
    assert.equal(empty.next_action, "run_one_real_host_turn_then_recheck_with_session_id");
    const routed = kernel.diagnose({ component: "experience", observed_tool_names: ["craft_run", "craft_context_tools_discover"] });
    assert.equal(routed.tool_access_mode, "syscall_discovery");
    assert.deepEqual(routed.missing_tools, []);
    assert.equal(routed.host_attachment, "surface_matches");
    const namespacedRoute = kernel.diagnose({ component: "experience", observed_tool_names: [
      "mcp__craft_context__craft_run", "mcp__craft_context__craft_context_tools_discover",
    ] });
    assert.equal(namespacedRoute.tool_access_mode, "syscall_discovery");
    assert.deepEqual(namespacedRoute.missing_tools, []);
    assert.equal(namespacedRoute.host_attachment, "surface_matches");
    const unrelatedRoute = kernel.diagnose({ component: "experience", observed_tool_names: [
      "mcp__other_server__craft_run", "mcp__other_server__craft_context_tools_discover",
    ] });
    assert.equal(unrelatedRoute.tool_access_mode, "direct");
    assert.equal(unrelatedRoute.host_attachment, "bundle_or_surface_mismatch");
    assert.equal(kernel.diagnose({ component: "memory", observed_tool_names: [] }).host_attachment, "bundle_or_surface_mismatch");
    f.store.create("activation_proof_receipt", "stale", { component: "memory", session_id: "old", plugin_release: "legacy" });
    assert.equal((kernel.diagnose({ component: "memory", session_id: "old" }).execution_proof as JsonObject).status, "stale_plugin_or_receipt");
    f.store.create("activation_proof_receipt", "other-session", { component: "memory", session_id: "other", plugin_release: CRAFT_RELEASE_VERSION, memory_written: true });
    f.store.create("activation_proof_receipt", "current-no-context", { component: "memory", session_id: "current", plugin_release: CRAFT_RELEASE_VERSION });
    let selected = kernel.diagnose({ component: "memory", session_id: " current " });
    assert.deepEqual(selected.execution_proof, { status: "executed", executions: 1, context_receipt_id: null, hook_trusted: false, mcp_reachable: false, explicit_memory_written: false });
    f.store.create("activation_proof_receipt", "current", { component: "memory", session_id: "current", plugin_release: CRAFT_RELEASE_VERSION, context_receipt_id: "context", hook_trusted: true, mcp_reachable: true, memory_written: true, body: "private-content" });
    selected = kernel.diagnose({ component: "memory", session_id: "current", observed_tool_names: [...empty.expected_tools as string[], "extra", "extra"] });
    assert.equal(selected.host_attachment, "surface_matches");
    assert.deepEqual(selected.execution_proof, { status: "executed", executions: 2, context_receipt_id: "context", hook_trusted: true, mcp_reachable: true, explicit_memory_written: true });
    assert.equal(selected.host_session_verified, false);
    assert.equal(selected.model_effect_proven, false);
    assert(!JSON.stringify(selected).includes("private-content"));
    assert.equal((kernel.diagnose({ component: "memory", session_id: " " }).execution_proof as JsonObject).executions, 3);
    for (const [id, observation_written] of [["negative", false], ["positive", true]] as const) {
      f.store.create("activation_proof_receipt", id, { component: "experience", session_id: id, plugin_release: CRAFT_RELEASE_VERSION, observation_written });
      assert.equal((kernel.diagnose({ component: "experience", session_id: id }).execution_proof as JsonObject).verified_observation_written, observation_written);
    }
    f.store.create("knowledge_claim", "same-a", { scope: "global", status: "candidate" });
    f.store.create("knowledge_claim", "same-b", { scope: "global", status: "candidate" });
    assert.equal(((kernel.diagnose({ component: "knowledge" }).counts as JsonObject).claims as JsonObject).candidate, 2);

    f.service.knowledgeMemoryInstallBuiltins();
    assert.equal(kernel.get({ component: "memory" }).state, "candidate_or_approval_required");
    f.service.memoryCaptureUserStatement({ content: "Keep project checks focused.", scope_kind: "user", scope_id: "local" });
    f.store.create("usage_ledger", "observed-usage", { operation: "memory-read" });
    const readyMemory = kernel.get({ component: "memory" });
    assert.equal(readyMemory.state, "ready");
    assert.equal(readyMemory.next_action, "resolve_only_the_current_scope_and_record_outcome_linked_usage");
    assert.equal((kernel.diagnose({ component: "memory" }).observability as JsonObject).usage_measurement, "recorded");
  } finally { await dispose(f); }
});

test("Knowledge diagnosis reads only bounded content-free learning status", async () => {
  const f = await fixture();
  try {
    await mkdir(f.store.paths.knowledgeDir, { recursive: true });
    await writeFile(join(f.store.paths.knowledgeDir, "session-evaluation-state.json"), JSON.stringify({
      schema: "craft.knowledge-session-evaluation-state.v1", legacy_unknown_outcomes: 11,
      processed_task_ids: ["private-task-id"], updated_at: "2026-10-27T14:11:27.523Z" }));
    const diagnosis = new ComponentReadinessKernel(f.store).diagnose({ component: "knowledge" });
    const observation = (diagnosis.observability as JsonObject).learning_evaluation as JsonObject;
    assert.deepEqual(observation, { status: "last_recorded", measurement_scope: "eligible_held_out_batch_only",
      legacy_unknown_outcomes: 11, updated_at: "2026-10-27T14:11:27.523Z" });
    assert.equal(JSON.stringify(observation).includes("private-task-id"), false);
  } finally { await dispose(f); }
});

test("Knowledge learning status fails closed on malformed or unsafe state", async () => {
  const f = await fixture();
  try {
    const directory = f.store.paths.knowledgeDir, path = join(directory, "session-evaluation-state.json");
    const kernel = new ComponentReadinessKernel(f.store);
    const status = () => ((kernel.diagnose({ component: "knowledge" }).observability as JsonObject).learning_evaluation as JsonObject).status;
    await mkdir(directory, { recursive: true });
    assert.equal(status(), "not_observed");
    for (const value of [null, {}, { schema: "craft.knowledge-session-evaluation-state.v1" }]) {
      await writeFile(path, JSON.stringify(value)); assert.equal(status(), "not_observed");
    }
    const base = { schema: "craft.knowledge-session-evaluation-state.v1", legacy_unknown_outcomes: 1, updated_at: "2026-10-27T14:11:27.523Z" };
    for (const value of [{ ...base, legacy_unknown_outcomes: -1 }, { ...base, legacy_unknown_outcomes: 50_001 },
      { ...base, legacy_unknown_outcomes: 1.5 }, { ...base, updated_at: null }, { ...base, updated_at: "a".repeat(65) },
      { ...base, updated_at: "not-a-date" }]) {
      await writeFile(path, JSON.stringify(value)); assert.equal(status(), "unavailable");
    }
    await writeFile(path, "{"); assert.equal(status(), "unavailable");
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1)); assert.equal(status(), "unavailable");
    await rm(path); await symlink(join(f.root, "missing"), path); assert.equal(status(), "unavailable");
    await rm(path); await mkdir(path); assert.equal(status(), "unavailable");
    await rm(path, { recursive: true }); await rm(directory, { recursive: true });
    await symlink(f.root, directory); assert.equal(status(), "unavailable");
    await rm(directory); await writeFile(directory, "not a directory"); assert.equal(status(), "unavailable");
  } finally { await dispose(f); }
});

test("public standalone component products expose small daily paths while advanced surfaces remain explicit", async () => {
  const f = await fixture();
  try {
    const expected: Record<string, readonly string[]> = {
      knowledge: ["craft_component_readiness_get", "craft_knowledge_source_register", "craft_evidence_record", "craft_knowledge_claim_save", "craft_knowledge_host_review", "craft_knowledge_support_record", "craft_knowledge_promotion_policy_get", "craft_knowledge_auto_review", "craft_knowledge_scenario_migration_propose", "craft_context_resolution_resolve"],
      memory: ["craft_component_readiness_get", "craft_memory_candidate_propose", "craft_memory_ledger_get", "craft_memory_ledger_list", "craft_memory_maintenance_run"],
      experience: ["craft_component_readiness_get", "craft_experience_scenario_list", "craft_experience_scenario_migration_propose", "craft_learning_cycle_finalize", "craft_experience_learning_request_get", "craft_experience_learning_evaluation_dispatch", "craft_experience_learning_evaluation_dispatch_list", "craft_experience_learning_evaluation_result", "craft_experience_observe", "craft_experience_procedure_draft", "craft_experience_procedure_submit", "craft_experience_procedure_get", "craft_procedure_get", "craft_procedure_list", "craft_procedure_gate", "craft_procedure_export_skill"],
    };
    for (const [product, required] of Object.entries(expected)) {
      const daily = new McpServer(f.service, productSurfaceOf(product));
      const names = daily.tools.map((tool) => tool.name);
      assert(names.length <= (product === "experience" ? 32 : product === "knowledge" ? 30 : 24), `${product} daily surface has ${names.length} tools: ${names.join(", ")}`);
      for (const name of required) assert(names.includes(name), `${product} daily surface must expose ${name}`);
      assert(!names.includes("craft_verified_work_loop_prepare"));
    }
    assert(new McpServer(f.service, "component-knowledge").tools.length > new McpServer(f.service, productSurfaceOf("knowledge")).tools.length);
    assert(new McpServer(f.service, "component-memory").tools.length > new McpServer(f.service, productSurfaceOf("memory")).tools.length);
    assert(new McpServer(f.service, "component-experience").tools.length > new McpServer(f.service, productSurfaceOf("experience")).tools.length);
    const dailyKnowledge = new Set(new McpServer(f.service, productSurfaceOf("knowledge")).tools.map((tool) => tool.name));
    const advancedKnowledge = new Set(new McpServer(f.service, "component-knowledge").tools.map((tool) => tool.name));
    for (const name of ["craft_knowledge_claim_review", "craft_knowledge_semantic_review_packet", "craft_knowledge_storage_reconcile",
      "craft_knowledge_evaluation_case_save", "craft_knowledge_evaluation_run"]) {
      assert(!dailyKnowledge.has(name), `${name} is an explicit advanced Knowledge operation`);
      assert(advancedKnowledge.has(name), `${name} remains on the advanced Knowledge surface`);
    }
    const dailyExperience = new McpServer(f.service, productSurfaceOf("experience")).tools.map((tool) => tool.name);
    assert(!dailyExperience.includes("craft_evaluation_model_profile_get"));
    assert(!dailyExperience.includes("craft_evaluation_model_ticket_list"));
    const experienceServer = new McpServer(f.service, productSurfaceOf("experience"));
    f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:project-a", alias_kind: "path", alias: f.root });
    assert.deepEqual(await experienceServer.handlers.craft_experience_scenario_list({ scope: "project:project-a" }), {
      scope: "project:project-a", catalog_version: 0, scenarios: [],
    });
    assert.throws(() => experienceServer.handlers.craft_experience_scenario_list({ scope: "global" }), /explicit project scope/u);
    const advancedExperience = new Set(new McpServer(f.service, "component-experience").tools.map((tool) => tool.name));
    for (const name of ["craft_evaluation_model_profile_get", "craft_evaluation_model_ticket_list", "craft_procedure_create", "craft_procedure_configuration_save", "craft_experience_graph_inspect",
      "craft_experience_graph_edit", "craft_experience_asset_restore"]) {
      assert(!dailyExperience.includes(name), `${name} belongs on the explicit advanced Experience surface`);
      assert(advancedExperience.has(name), `${name} must remain available on the advanced Experience surface`);
    }
    assert(!dailyExperience.some((name) => name.startsWith("craft_workflow_evolution_") || name.startsWith("craft_workflow_dag_")));
    assert(dailyExperience.includes("craft_experience_observe"));
    assert(dailyExperience.includes("craft_experience_procedure_draft"));
    assert(!dailyExperience.some((name) => name.includes("projection")));
  } finally { await dispose(f); }
});

test("daily Experience aliases preserve the bounded legacy evolution behavior", async () => {
  const f = await fixture();
  try {
    f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: f.root });
    const experience = new McpServer(f.service, productSurfaceOf("experience"));
    const evidence = f.store.create("evidence", "experience-alias-evidence", { confidence: "bounded" });
    const inputs = [
      { source_id: "one", source_digest: "sha256:one", outcome: "failed" },
      { source_id: "two", source_digest: "sha256:two", outcome: "passed" },
    ];
    for (const [index, input] of inputs.entries()) {
      await experience.handlers.craft_experience_observe({ observation_id: `experience-alias-${index}`, scope: "project:demo", scenario_key: "coding.retry", source_kind: "outcome", evidence_ids: [evidence.id], sanitized: true, ...input });
    }
    const patterns = await experience.handlers.craft_experience_patterns_list({ scenario_key: "coding.retry" }) as JsonObject;
    const observations = patterns.observations as JsonObject[];
    const drafted = await experience.handlers.craft_experience_procedure_draft({ request_id: "experience-alias-request", scenario_key: "coding.retry", observation_ids: observations.map((item) => item.id), hypothesis: "Bound retries.", design_axes: ["orchestration"], output_contract_ref: "acceptance:tests-pass" }) as JsonObject;
    assert.equal((drafted.request as JsonObject).procedure_kind, "workflow");
    const submitted = await experience.handlers.craft_experience_procedure_submit({ proposal_id: "experience-alias-proposal", request_id: (drafted.request as JsonObject).id, workflow_id: "experience-alias-workflow", name: "Bounded retry", description: "A linear procedure remains the default.", inputs: [], steps: [{ type: "assertion" }] }) as JsonObject;
    const proposal = submitted.proposal as JsonObject;
    assert.equal(proposal.procedure_kind, "workflow");
    assert.equal(((await experience.handlers.craft_experience_procedure_get({ proposal_id: proposal.id }) as JsonObject).proposal as JsonObject).id, proposal.id);
    assert.throws(() => experience.handlers.craft_experience_procedure_draft({ scenario_key: "coding.retry", observation_ids: observations.map((item) => item.id), hypothesis: "No evidence for a graph.", design_axes: ["orchestration"], procedure_kind: "graph", output_contract_ref: "acceptance:tests-pass" }), /Graph/);
  } finally { await dispose(f); }
});

test("standalone readiness reflects automatic memory commitment and the coding experience threshold without reading bodies", async () => {
  const f = await fixture();
  try {
    const codingRoot = join(f.root, "coding"); await mkdir(codingRoot);
    f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:coding", alias_kind: "path", alias: codingRoot });
    const knowledge = new McpServer(f.service, productSurfaceOf("knowledge"));
    const memory = new McpServer(f.service, productSurfaceOf("memory"));
    const experience = new McpServer(f.service, productSurfaceOf("experience"));
    assert.equal((await knowledge.handlers.craft_component_readiness_get({ component: "knowledge" })).state, "bootstrap_required");
    assert.equal((await memory.handlers.craft_component_readiness_get({ component: "memory" })).state, "bootstrap_required");
    assert.equal((await experience.handlers.craft_component_readiness_get({ component: "experience" })).state, "independent_observations_required");
    assert.deepEqual((await knowledge.handlers.craft_component_readiness_get({ component: "knowledge" })).usage, {
      kind: "readiness_only",
      component_used: false,
      context_resolved: false,
    });
    assert.throws(() => f.service.componentReadinessGet({ component: "all" }), /component must be knowledge/u);
    await knowledge.handlers.craft_knowledge_bootstrap_install({});
    f.store.create("knowledge_claim", "statusless", { scope: "global" });
    assert.equal((await knowledge.handlers.craft_component_readiness_get({ component: "knowledge" })).state, "evidence_review_pending");
    const evidence = f.store.create("evidence", "coding-evidence", { confidence: "bounded", source: "fixture", summary: "observed test result" });
    await memory.handlers.craft_memory_candidate_propose({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "coding", content: "Run focused tests before a full suite.", evidence_ids: [evidence.id] });
    const memoryReady = await memory.handlers.craft_component_readiness_get({ component: "memory" }) as JsonObject;
    assert.equal(memoryReady.state, "ready");
    assert.equal(((memoryReady.counts as JsonObject).ledger as JsonObject).active, 1);
    assert.equal((memoryReady.counts as JsonObject).memory_feedback_records, 0);
    f.store.create("context_feedback", "memory-feedback-without-refs", { outcome: "helpful", evidence_verified: true });
    f.store.create("context_feedback", "memory-feedback-empty-refs", { memory_refs: [], outcome: "helpful", evidence_verified: true });
    f.store.create("context_feedback", "memory-feedback-unverified", { memory_refs: [{ memory_id: "memory-under-test", memory_version: 1,
      content_digest: "sha256:memory" }], outcome: "helpful", evidence_verified: false });
    f.store.create("context_feedback", "memory-feedback-verified", { memory_refs: [{ memory_id: "memory-under-test", memory_version: 1,
      content_digest: "sha256:memory" }], outcome: "helpful", evidence_verified: true });
    f.store.create("context_feedback", "memory-feedback-irrelevant", { memory_refs: [{ memory_id: "memory-under-test", memory_version: 1,
      content_digest: "sha256:memory" }], outcome: "irrelevant", evidence_verified: true });
    const feedbackReady = await memory.handlers.craft_component_readiness_get({ component: "memory" }) as JsonObject;
    assert.equal((feedbackReady.counts as JsonObject).memory_feedback_records, 3);
    assert.equal((feedbackReady.counts as JsonObject).verified_helpful_memory_feedback_records, 1);
    const originalList = f.store.list.bind(f.store);
    f.store.list = ((kind: string, limit = 20, predicate?: (record: JsonObject) => boolean, hydrate = true,
      dependencies?: { source_ids: string[]; document_ids: string[] }) => kind === "context_feedback"
      ? Array.from({ length: 10_001 }, (_, index) => ({ id: `feedback-${index}`, memory_refs: [{ memory_id: "m" }], outcome: "helpful", evidence_verified: true }))
      : originalList(kind, limit, predicate, hydrate, dependencies)) as typeof f.store.list;
    try {
      const cappedFeedback = await memory.handlers.craft_component_readiness_get({ component: "memory" }) as JsonObject;
      assert.equal((cappedFeedback.counts as JsonObject).memory_feedback_records, 10_000);
      assert.equal((cappedFeedback.counts as JsonObject).verified_helpful_memory_feedback_records, 10_000);
      assert.equal((cappedFeedback.counts as JsonObject).memory_feedback_records_truncated, true);
    } finally { f.store.list = originalList; }

    const first = f.store.create("outcome", "coding-outcome-a", { status: "passed" });
    const second = f.store.create("outcome", "coding-outcome-b", { status: "passed" });
    const observe = experience.handlers.craft_experience_observe;
    await observe({ scenario_key: "coding:test-failure-recovery", source_kind: "outcome", source_id: first.id, source_digest: "sha256:a", outcome: "passed", evidence_ids: [evidence.id], sanitized: true });
    await observe({ scenario_key: "coding:test-failure-recovery", source_kind: "outcome", source_id: second.id, source_digest: "sha256:b", outcome: "passed", evidence_ids: [evidence.id], sanitized: true });
    const experienceReady = await experience.handlers.craft_component_readiness_get({ component: "experience" }) as JsonObject;
    assert.equal(experienceReady.state, "draft_proposal_available");
    assert.equal(experienceReady.model_effect_proven, false);
    f.store.create("knowledge_claim", "reviewed", { scope: "global", status: "reviewed" });
    f.store.create("memory_ledger", "active", { status: "active" });
    f.store.create("workflow_evolution_request", "readiness-draft-request", { scope: { kind: "project", id: "coding" }, scenario_key: "readiness", lifecycle: "awaiting_model" });
    f.store.create("workflow_evolution_proposal", "draft", { request_id: "readiness-draft-request", status: "draft" });
    assert.equal((await knowledge.handlers.craft_component_readiness_get({ component: "knowledge" })).state, "ready");
    assert.equal((await memory.handlers.craft_component_readiness_get({ component: "memory" })).state, "ready");
    assert.equal((await experience.handlers.craft_component_readiness_get({ component: "experience" })).state, "evaluation_required");
  } finally { await dispose(f); }
});

test("standalone readiness is scoped to the mounted component and cannot substitute for retrieval", async () => {
  const f = await fixture();
  try {
    const memory = new McpServer(f.service, productSurfaceOf("memory"));
    const experience = new McpServer(f.service, productSurfaceOf("experience"));
    assert.throws(
      () => memory.handlers.craft_component_readiness_get({ component: "knowledge" }),
      /mounted component is memory/u,
    );
    const response = await experience.handle({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "craft_component_readiness_get", arguments: { component: "knowledge" } },
    }) as JsonObject;
    const result = response.result as JsonObject;
    assert.equal(result.isError, true);
    assert.match(String((result.content as JsonObject[])[0]?.text), /mounted component is experience/u);
  } finally { await dispose(f); }
});

test("standalone Knowledge exposes Host-managed review without a separate model provider", async () => {
  const f = await fixture();
  try {
    f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: f.root });
    const knowledge = new McpServer(f.service, productSurfaceOf("knowledge"));
    await knowledge.handlers.craft_knowledge_source_register({ source_id: "host-source", kind: "project_note", label: "Host source", trust: "verified", scope_kind: "project", scope_id: "demo", locator: "README.md", content_digest: `sha256:${"a".repeat(64)}` });
    const evidence = await knowledge.handlers.craft_evidence_record({ evidence_id: "host-evidence", source_type: "observation", confidence: "bounded", claim: "fixture" }) as JsonObject;
    const saved = await knowledge.handlers.craft_knowledge_claim_save({ claim_id: "host-claim", kind: "fact", scope: "project:demo", content: "Run the focused test.", source_id: "host-source", evidence_ids: [evidence.id] }) as JsonObject;
    const reviewed = await knowledge.handlers.craft_knowledge_host_review({ claim_id: (saved.claim as JsonObject).id, host_run_key: "codex:fixture:turn", source_digest: `sha256:${"a".repeat(64)}`, decision: "supported" }) as JsonObject;
    assert.equal(reviewed.promoted, false);
    assert.equal((reviewed.claim as JsonObject).status, "candidate");
    assert.equal((reviewed.review as JsonObject).validation_status, "revalidation_required");
  } finally { await dispose(f); }
});

test("memory maintenance evaluates the governed ledger first and keeps expiry as a review finding", async () => {
  const f = await fixture();
  try {
    const codingRoot = join(f.root, "coding"); await mkdir(codingRoot);
    f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:coding", alias_kind: "path", alias: codingRoot });
    f.service.knowledgeMemoryInstallBuiltins();
    const first = f.service.memoryLedgerRemember({ memory_id: "active-expired", source_id: "builtin.evidence-wiki", kind: "working", scope_kind: "project", scope_id: "coding", content: "Temporary setup", valid_until: "2020-01-01T00:00:00.000Z" }).memory as JsonObject;
    f.store.create("memory_ledger", "incomplete-ledger", { status: "active" });
    f.store.create("episodic_memory", "legacy-should-not-drive", { content_digest: "legacy", content_ref: { kind: "memory" } });
    const result = f.service.memoryMaintenanceRun({ maintenance_id: "ledger-maintenance", stage: "deep", now: "2026-09-20T00:00:00.000Z" });
    const findings = result.findings as JsonObject[];
    assert(findings.some((finding) => finding.kind === "expired_active" && finding.memory_id === first.id));
    assert.equal((result.candidate as JsonObject).source_kind, "memory_ledger");
    assert.equal((result.run as JsonObject).memory_kind, "memory_ledger");
    const signal = f.service.memoryMaintenanceSignal({ memory_id: first.id, signal_id: "ledger-signal" });
    assert.equal((signal.signal as JsonObject).memory_kind, "memory_ledger");
    assert.equal(f.service.memoryMaintenanceSignal({ memory_id: first.id, signal_id: "ledger-signal" }).idempotent, true);
    assert.throws(() => f.service.memoryMaintenanceSignal({ memory_id: "missing" }), /Unknown Memory/u);
  } finally { await dispose(f); }
});
