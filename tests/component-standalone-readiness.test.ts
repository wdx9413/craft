import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../core/mcp.ts";
import { productSurfaceOf } from "../core/interfaces/mcp/product-launch.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

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

test("public standalone component products expose small daily paths while advanced surfaces remain explicit", async () => {
  const f = await fixture();
  try {
    const expected: Record<string, readonly string[]> = {
      knowledge: ["craft_component_readiness_get", "craft_knowledge_source_register", "craft_evidence_record", "craft_knowledge_claim_save", "craft_knowledge_host_review", "craft_knowledge_support_record", "craft_knowledge_promotion_policy_get", "craft_knowledge_auto_review", "craft_context_resolution_resolve"],
      memory: ["craft_component_readiness_get", "craft_memory_candidate_propose", "craft_memory_ledger_get", "craft_memory_ledger_list", "craft_memory_maintenance_run"],
      experience: ["craft_component_readiness_get", "craft_experience_observe", "craft_experience_procedure_draft", "craft_experience_procedure_submit", "craft_experience_procedure_get", "craft_procedure_create", "craft_procedure_get", "craft_procedure_list", "craft_procedure_gate", "craft_procedure_export_skill"],
    };
    for (const [product, required] of Object.entries(expected)) {
      const daily = new McpServer(f.service, productSurfaceOf(product));
      const names = daily.tools.map((tool) => tool.name);
      assert(names.length <= 16, `${product} daily surface must stay within the tool budget`);
      for (const name of required) assert(names.includes(name), `${product} daily surface must expose ${name}`);
      assert(!names.includes("craft_verified_work_loop_prepare"));
    }
    assert(new McpServer(f.service, "component-knowledge").tools.length > new McpServer(f.service, productSurfaceOf("knowledge")).tools.length);
    assert(new McpServer(f.service, "component-memory").tools.length > new McpServer(f.service, productSurfaceOf("memory")).tools.length);
    assert(new McpServer(f.service, "component-experience").tools.length > new McpServer(f.service, productSurfaceOf("experience")).tools.length);
    const dailyExperience = new McpServer(f.service, productSurfaceOf("experience")).tools.map((tool) => tool.name);
    assert(!dailyExperience.some((name) => name.startsWith("craft_workflow_evolution_") || name.startsWith("craft_workflow_dag_")));
    assert(dailyExperience.includes("craft_experience_observe"));
    assert(dailyExperience.includes("craft_experience_procedure_draft"));
    assert(!dailyExperience.some((name) => name.includes("projection")));
  } finally { await dispose(f); }
});

test("daily Experience aliases preserve the bounded legacy evolution behavior", async () => {
  const f = await fixture();
  try {
    const experience = new McpServer(f.service, productSurfaceOf("experience"));
    const evidence = f.store.create("evidence", "experience-alias-evidence", { confidence: "bounded" });
    const inputs = [
      { source_id: "one", source_digest: "sha256:one", outcome: "failed" },
      { source_id: "two", source_digest: "sha256:two", outcome: "passed" },
    ];
    for (const [index, input] of inputs.entries()) {
      await experience.handlers.craft_experience_observe({ observation_id: `experience-alias-${index}`, scenario_key: "coding.retry", source_kind: "outcome", evidence_ids: [evidence.id], sanitized: true, ...input });
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

test("standalone readiness makes empty ledgers and the coding experience threshold visible without reading bodies", async () => {
  const f = await fixture();
  try {
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
    f.store.create("knowledge_claim", "statusless", {});
    assert.equal((await knowledge.handlers.craft_component_readiness_get({ component: "knowledge" })).state, "evidence_review_pending");
    const evidence = f.store.create("evidence", "coding-evidence", { confidence: "bounded", source: "fixture", summary: "observed test result" });
    await memory.handlers.craft_memory_candidate_propose({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "coding", content: "Run focused tests before a full suite.", evidence_ids: [evidence.id] });
    const memoryReady = await memory.handlers.craft_component_readiness_get({ component: "memory" }) as JsonObject;
    assert.equal(memoryReady.state, "candidate_or_approval_required");

    const first = f.store.create("outcome", "coding-outcome-a", { status: "passed" });
    const second = f.store.create("outcome", "coding-outcome-b", { status: "passed" });
    const observe = experience.handlers.craft_experience_observe;
    await observe({ scenario_key: "coding:test-failure-recovery", source_kind: "outcome", source_id: first.id, source_digest: "sha256:a", outcome: "passed", evidence_ids: [evidence.id], sanitized: true });
    await observe({ scenario_key: "coding:test-failure-recovery", source_kind: "outcome", source_id: second.id, source_digest: "sha256:b", outcome: "passed", evidence_ids: [evidence.id], sanitized: true });
    const experienceReady = await experience.handlers.craft_component_readiness_get({ component: "experience" }) as JsonObject;
    assert.equal(experienceReady.state, "draft_proposal_available");
    assert.equal(experienceReady.model_effect_proven, false);
    f.store.create("knowledge_claim", "reviewed", { status: "reviewed" });
    f.store.create("memory_ledger", "active", { status: "active" });
    f.store.create("workflow_evolution_proposal", "draft", { status: "draft" });
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
    const knowledge = new McpServer(f.service, productSurfaceOf("knowledge"));
    await knowledge.handlers.craft_knowledge_source_register({ source_id: "host-source", kind: "project_note", label: "Host source", trust: "verified", scope_kind: "project", scope_id: "demo", locator: "README.md", content_digest: `sha256:${"a".repeat(64)}` });
    const evidence = await knowledge.handlers.craft_evidence_record({ evidence_id: "host-evidence", source_type: "observation", confidence: "bounded", claim: "fixture" }) as JsonObject;
    const saved = await knowledge.handlers.craft_knowledge_claim_save({ claim_id: "host-claim", kind: "fact", scope: "project:demo", content: "Run the focused test.", source_id: "host-source", evidence_ids: [evidence.id] }) as JsonObject;
    const reviewed = await knowledge.handlers.craft_knowledge_host_review({ claim_id: (saved.claim as JsonObject).id, host_run_key: "codex:fixture:turn", source_digest: `sha256:${"a".repeat(64)}`, decision: "supported" }) as JsonObject;
    assert.equal(reviewed.promoted, true);
    assert.equal((reviewed.claim as JsonObject).status, "reviewed");
  } finally { await dispose(f); }
});

test("memory maintenance evaluates the governed ledger first and keeps expiry as a review finding", async () => {
  const f = await fixture();
  try {
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
