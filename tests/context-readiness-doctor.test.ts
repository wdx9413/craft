import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contextReadinessDoctor } from "../core/context-readiness-doctor.ts";
import { buildCapabilityIterationPlan } from "../core/capability-iteration-plan.ts";
import { capabilityIterationGaps } from "../core/capability-iteration-gaps.ts";
import { contextUsageStatusline } from "../core/context-usage-statusline.ts";
import { codebaseLspReadiness, lspCommandIsAbsolute } from "../core/codebase-lsp-readiness.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CRAFT_RELEASE_VERSION } from "../core/version.ts";
import { discoverContextTools } from "../core/mcp/context-tools.ts";
import { McpServer } from "../core/mcp.ts";
import { TOOLS } from "../core/mcp/tool-catalog.ts";
import { projectIdentityFromRoot } from "../core/scope-identity.ts";
import { PROVIDER_CATALOG } from "../core/model-gateway.ts";
import { procedureTaskEffectFixture } from "./helpers/procedure-task-effect-fixture.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-context-readiness-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store };
}

async function dispose(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

test("Readiness Doctor reports bounded state without claiming execution", async () => {
  const f = await fixture();
  try {
    new CraftService(f.store).activationProofDoctor({});
    f.store.create("context_feedback", "feedback", { outcome: "unrated", token_measurement: { injected_tokens: 42 } });
    await mkdir(f.store.paths.knowledgeDir, { recursive: true });
    await writeFile(join(f.store.paths.knowledgeDir, "learning-worker-state.json"), JSON.stringify({ schema: "worker", updated_at: "2026-11-11T00:00:00.000Z" }));
    const result = contextReadinessDoctor(f.store, { project_root: f.root, surface: "component-context-agent" });
    assert.equal(result.release, CRAFT_RELEASE_VERSION);
    assert.equal(result.surface, "component-context-agent");
    assert.equal(result.config_is_not_execution_proof, true);
    assert.equal(result.execution_context, false);
    assert.ok((result.activation as JsonObject).components);
    assert.match(String(result.data_space_id), /^sha256:/u);
    assert.equal(((result.learning_state as JsonObject).knowledge as JsonObject).status, "observed");
    assert.equal((result.context as JsonObject).feedback, 1);
    assert.equal((result.context as JsonObject).latest_injected_tokens, 42);
    assert.ok(Array.isArray((result.context as JsonObject).correction_states));
    assert.equal((result.activation as JsonObject).release, CRAFT_RELEASE_VERSION);
  } finally { await dispose(f); }
});

test("Readiness Doctor covers migration, malformed state, unknown statuses and empty measurements", async () => {
  const f = await fixture();
  try {
    const projectRoot = join(f.root, "project");
    await mkdir(projectRoot, { recursive: true });
    f.store.create("project_identity", "project:demo", { canonical_scope: { kind: "project", id: "project:demo" } });
    f.store.create("scope_alias", "migration-alias", { alias: projectRoot, scope: { kind: "project", id: "project:demo" } });
    f.store.create("project_registry_migration", "migration", { project_root: projectRoot, state: "applied",
      legacy_scope_id: "project:legacy", data_migrated: false });
    f.store.create("context_correction_task", "known-correction", { status: "pending_review" });
    f.store.create("context_correction_task", "unknown-correction", { feedback_id: "sparse" });
    f.store.create("context_correction_task", "another-unknown-correction", { feedback_id: "sparse" });
    f.store.create("context_feedback", "empty-measurement", { outcome: "unrated" });
    await mkdir(f.store.paths.knowledgeDir, { recursive: true });
    await writeFile(join(f.store.paths.knowledgeDir, "learning-stage-cursor.json"), JSON.stringify({ updated_at: "2026-11-11T00:00:00.000Z" }));
    await writeFile(join(f.store.paths.knowledgeDir, "learning-worker-state.json"), JSON.stringify({ schema: 42, updated_at: 7 }));
    await writeFile(join(f.store.paths.knowledgeDir, "session-adjudication-cursor.json"), "[");
    await writeFile(join(f.store.paths.knowledgeDir, "classification-attempts.json"), JSON.stringify([]));
    const result = contextReadinessDoctor(f.store, { project_root: projectRoot, session_id: "session", surface: "component-context-agent" });
    assert.equal((result.identity as JsonObject).status, "registry_record_observed");
    assert.equal((result.migration as JsonObject).state, "applied");
    assert.equal(((result.learning_state as JsonObject).knowledge as JsonObject).schema, null);
    assert.equal(((result.learning_state as JsonObject).knowledge as JsonObject).updated_at, null);
    assert.equal(((result.learning_state as JsonObject).stage_cursor as JsonObject).schema, null);
    assert.equal(((result.learning_state as JsonObject).session_adjudication as JsonObject).status, "unavailable");
    assert.equal(((result.learning_state as JsonObject).classification_attempts as JsonObject).status, "unavailable");
    const corrections = (result.context as JsonObject).corrections as JsonObject;
    assert.equal(corrections.pending_review, 1);
    assert.equal(corrections.unknown, 2);
    assert.equal(((result.context as JsonObject).feedback_outcomes as JsonObject).unrated, 1);
    assert.equal((result.context as JsonObject).latest_injected_tokens, null);
  } finally { await dispose(f); }
});

test("Context Doctor and correction status are declared in the canonical tool schema", () => {
  const doctor = TOOLS.find(tool => tool.name === "craft_context_doctor");
  const corrections = TOOLS.find(tool => tool.name === "craft_context_correction_list");
  const discover = TOOLS.find(tool => tool.name === "craft_context_tools_discover");
  assert.equal(doctor?.annotations?.readOnlyHint, true);
  const statusSchema = ((corrections?.inputSchema.properties as JsonObject).status as JsonObject);
  assert.deepEqual(statusSchema.enum,
    ["pending_review", "confirmed", "dismissed", "resolved", "decided"]);
  const limitSchema = ((discover?.inputSchema.properties as JsonObject).limit as JsonObject);
  assert.equal(limitSchema.type, "integer");
});

test("Readiness Doctor distinguishes model configuration from execution proof", async () => {
  const f = await fixture();
  const previous = process.env.CRAFT_LEARNING_MODEL_HOST;
  try {
    delete process.env.CRAFT_LEARNING_MODEL_HOST;
    const settingsFile = f.store.paths.settingsFile;
    f.store.paths.settingsFile = "";
    try { assert.deepEqual(contextReadinessDoctor(f.store).learning_model,
      { status: "blocked", reason: "no_configured_model", execution: "unverified" }); }
    finally { f.store.paths.settingsFile = settingsFile; }
    assert.deepEqual(contextReadinessDoctor(f.store).learning_model,
      { status: "blocked", reason: "no_configured_model", execution: "unverified" });
    await assert.rejects(access(f.store.paths.settingsFile), { code: "ENOENT" });
    await writeFile(f.store.paths.settingsFile, "invalid settings");
    assert.deepEqual(contextReadinessDoctor(f.store).learning_model,
      { status: "blocked", reason: "invalid_model_configuration", execution: "unverified" });
    await writeFile(f.store.paths.settingsFile, JSON.stringify({ models: [
      { id: "fixture", name: "Fixture", baseUrl: "https://example.invalid/v1", model: "fixture-model", apiKeyEnv: "CRAFT_FIXTURE_KEY" },
    ] }));
    assert.deepEqual(contextReadinessDoctor(f.store).learning_model,
      { status: "gateway_models_configured", configured_models: 1, execution: "unverified" });
    process.env.CRAFT_LEARNING_MODEL_HOST = "claude-code";
    assert.deepEqual(contextReadinessDoctor(f.store).learning_model,
      { status: "host_declared", host: "claude-code", model: "claude-sonnet-4-6", execution: "unverified" });
    process.env.CRAFT_LEARNING_MODEL_HOST = "unsupported";
    assert.deepEqual(contextReadinessDoctor(f.store).learning_model,
      { status: "blocked", reason: "unsupported_learning_model_host", execution: "unverified" });
    process.env.CRAFT_LEARNING_MODEL_HOST = "codex-cli";
    Object.defineProperty(PROVIDER_CATALOG, "find", { configurable: true, value: () => undefined });
    try { assert.deepEqual(contextReadinessDoctor(f.store).learning_model,
      { status: "host_declared", host: "codex-cli", model: null, execution: "unverified" }); }
    finally { Reflect.deleteProperty(PROVIDER_CATALOG, "find"); }
  } finally {
    if (previous === undefined) delete process.env.CRAFT_LEARNING_MODEL_HOST;
    else process.env.CRAFT_LEARNING_MODEL_HOST = previous;
    await dispose(f);
  }
});

test("Readiness Doctor reports sparse migration and oversized or unknown state without guessing", async () => {
  const f = await fixture();
  try {
    const projectRoot = join(f.root, "project");
    await mkdir(projectRoot, { recursive: true });
    f.store.create("project_registry_migration", "sparse-migration", { project_root: projectRoot });
    f.store.create("scope_alias", "alias", { alias: projectRoot, scope: { kind: "project", id: "project:demo" } });
    f.store.create("context_feedback", "missing-outcome", { token_measurement: { injected_tokens: 0 } });
    await mkdir(f.store.paths.knowledgeDir, { recursive: true });
    await writeFile(join(f.store.paths.knowledgeDir, "learning-worker-state.json"), "x".repeat(4097));
    await writeFile(join(f.store.paths.knowledgeDir, "learning-stage-cursor.json"), "null");
    const result = contextReadinessDoctor(f.store, { project_root: projectRoot });
    assert.equal((result.migration as JsonObject).state, "unknown");
    assert.equal((result.migration as JsonObject).legacy_scope_id, null);
    assert.equal((result.migration as JsonObject).data_migrated, false);
    assert.equal(((result.learning_state as JsonObject).knowledge as JsonObject).status, "unavailable");
    assert.equal(((result.learning_state as JsonObject).stage_cursor as JsonObject).status, "unavailable");
    assert.equal(((result.context as JsonObject).feedback_outcomes as JsonObject).unknown, 1);
    assert.equal((result.context as JsonObject).latest_injected_tokens, 0);
  } finally { await dispose(f); }
});

test("Readiness Doctor keeps unavailable legacy partitions local and marks status counts incomplete", async () => {
  const f = await fixture();
  try {
    const originalList = f.store.list.bind(f.store);
    f.store.list = ((kind: string, limit?: number, predicate?: (record: JsonObject) => boolean, hydrate?: boolean,
      dependencies?: { source_ids: string[]; document_ids: string[] }, scope?: string) => {
      if (kind === "knowledge_claim") throw new Error("Project Knowledge storage root is not registered");
      return originalList(kind, limit, predicate, hydrate, dependencies, scope);
    }) as typeof f.store.list;
    const result = contextReadinessDoctor(f.store);
    const knowledge = ((result.components as JsonObject).knowledge as JsonObject);
    assert.equal(knowledge.status_counts_status, "incomplete");
    assert.deepEqual(knowledge.status_counts, {});
    assert.equal(knowledge.records, 0);
    assert.equal(((result.components as JsonObject).memory as JsonObject).status_counts_status, "available");
  } finally { await dispose(f); }
});

test("Context Doctor is mounted on narrow surfaces and correction list rejects invalid status", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const server = new McpServer(service, "component-context-agent");
    assert(server.tools.some(tool => tool.name === "craft_context_doctor"));
    const doctor = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "craft_context_doctor", arguments: {} } });
    const doctorResult = doctor?.result as JsonObject | undefined;
    assert.equal(doctorResult?.isError, false);
    const doctorContent = doctorResult?.structuredContent as JsonObject | undefined;
    assert.equal(doctorContent?.config_is_not_execution_proof, true);
    const invalid = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "craft_run", arguments: { resource: "context_correction", operation: "list", args: { status: "pending" } } } });
    const invalidResult = invalid?.result as JsonObject | undefined;
    assert.equal(invalidResult?.isError, true);
    const failure = invalidResult?.structuredContent as JsonObject;
    assert.notEqual(failure.error_code, "INTERNAL_ERROR");
    assert.match(String(failure.message), /status/u);
  } finally { await dispose(f); }
});

test("Context tool discovery is bounded, explicit, and keeps exact syscall routes", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const discovered = service.contextToolsDiscover({ intent: "experience", limit: 5 });
    const tools = discovered.tools as JsonObject[];
    assert.equal(discovered.limit, 5);
    assert.equal(tools.length, 5);
    assert.ok(Number(discovered.total_candidates) > tools.length);
    assert.ok(Number(discovered.omitted_count) > 0);
    assert.ok(tools.every(tool => (tool.syscall_route as JsonObject).tool === "craft_run"));
    assert.throws(() => service.contextToolsDiscover({ intent: "recall", limit: 6 }), /limit/i);
    const defaulted = discoverContextTools({ intent: "recall" });
    assert.equal(defaulted.limit, undefined);
    assert.equal((defaulted.tools as JsonObject[]).length, Number(defaulted.total_candidates));
  } finally { await dispose(f); }
});

test("MCP maps unclassified dispatch failures to stable diagnostics", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(new CraftService(f.store), "component-context-agent");
    const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "craft_run", arguments: { resource: "component_readiness", operation: "get", args: { component: "experience" } } } });
    const result = response?.result as JsonObject | undefined;
    assert.equal(result?.isError, true);
    const failure = result?.structuredContent as JsonObject;
    assert.notEqual(failure.error_code, "INTERNAL_ERROR");
    assert.match(String(failure.message), /not available/u);
  } finally { await dispose(f); }
});

function taskRecord(taskId: string, sessionId: string, outcome = "passed"): JsonObject {
  return { task_id: taskId, session_id: sessionId, task_goal: `goal:${taskId}`, changed_paths: ["src/example.ts"],
    verification_outcome: outcome, injected_refs: ["knowledge:claim@example@1"], used_refs: ["knowledge:claim@example@1"],
    user_corrections: [], turn_outcome: outcome === "passed" ? "passed" : "failed" };
}

test("Capability iteration plan is dry-run, threshold-gated and never writes live assets", async () => {
  const f = await fixture();
  try {
    for (const status of ["candidate", "stale", "reviewed", "archived"]) f.store.create("knowledge_claim", status, { scope: "global", status });
    const before = f.store.count("knowledge_claim") + f.store.count("memory_ledger") + f.store.count("experience_observation");
    const empty = buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo" });
    assert.deepEqual((empty.readiness as JsonObject).knowledge_claim_statuses, { candidate: 1, stale: 1, reviewed: 1, other: 1 });
    assert.equal(empty.generated_without_writes, true);
    assert.equal(empty.automatic_apply_allowed, false);
    assert.equal((empty.learning_record as JsonObject).outcome, "inconclusive");
    assert.equal((empty.learning_record as JsonObject).model_effect_proven, false);
    assert.equal((empty.migration as JsonObject).apply_allowed, false);
    assert.equal((empty.capability_activation as JsonObject).authorization_granted, false);
    assert.equal((empty.governed_quality as JsonObject).automatic_publication, false);
    const records = Array.from({ length: 2 }, (_, index) => ({ ...taskRecord(`task:${index}`, index === 0 ? "session:A" : "session:B"),
      injected_refs: ["knowledge:claim@example@1", ...(index === 0 ? ["knowledge:unused@example@1"] : [])] }));
    const qualified = buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo",
      input: { project_scope_id: "project:demo", records, asset_ids: ["asset:a", "asset:b", "asset:c", "asset:d", "asset:e", "asset:f"],
        allowed_effects: ["read_only"], case_ids: ["case:a", "case:b", "case:c"], environment_digest: "sha256:" + "a".repeat(64),
        budget_digest: "sha256:" + "b".repeat(64), grader_version: "grader:1", subject_version: 2 } });
    assert.equal((qualified.learning_record as JsonObject).outcome, "project_candidate_ready_for_paired_assessment");
    assert.equal((qualified.learning_record as JsonObject).business_eligible, false);
    assert.equal((qualified.learning_record as JsonObject).routeable, false);
    assert.equal((qualified.learning_record as JsonObject).model_effect_proven, false);
    assert.equal((qualified.learning_record as JsonObject).asset_usage_observations, 2);
    assert.equal((qualified.learning_record as JsonObject).matched_task_pairs, 0);
    assert.equal((qualified.capability_activation as JsonObject).omitted_count, 1);
    assert.equal((qualified.governed_quality as JsonObject).status, "screening_plan_ready");
    assert.equal((qualified.governed_quality as JsonObject).screening_minimum_pairs, 3);
    assert.equal((qualified.governed_quality as JsonObject).effect_decision_minimum_pairs, 5);
    assert.equal((qualified.governed_quality as JsonObject).equal_budget, true);
    const after = f.store.count("knowledge_claim") + f.store.count("memory_ledger") + f.store.count("experience_observation");
    assert.equal(after, before);
  } finally { await dispose(f); }
});

test("Capability iteration plan rejects invalid, ambiguous and unsafe records", async () => {
  const f = await fixture();
  try {
    assert.equal(buildCapabilityIterationPlan(f.store, { records: [] }).project_scope_id, "global");
    assert.throws(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", records: [null] }), /records\[0\]/u);
    assert.throws(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", records: Array.from({ length: 101 }, () => taskRecord("t", "s")) }), /records/u);
    assert.throws(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", records: [{ ...taskRecord("t", "s"), changed_paths: "invalid" }] }), /changed_paths/u);
    assert.throws(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", records: [{ ...taskRecord("t", "s"), changed_paths: [42] }] }), /changed_paths\[0\]/u);
    assert.throws(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", records: [{ ...taskRecord("t", "s"), task_id: "" }] }), /task_id/u);
    assert.doesNotThrow(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", records: [{ ...taskRecord("t", "s"), verification_digest: null }] }));
    assert.throws(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", records: [{ ...taskRecord("t", "s"), verification_outcome: "maybe" }] }), /verification_outcome/u);
    assert.throws(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", records: [{ ...taskRecord("t", "s"), verification_digest: "digest" }] }), /sha256/u);
    assert.throws(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", subject_version: 0 }), /subject_version/u);
    assert.throws(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", asset_ids: Array.from({ length: 101 }, () => "asset") }), /asset_ids/u);
    assert.throws(() => buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", allowed_effects: [42] }), /allowed_effects\[0\]/u);
    const projectRoot = join(f.root, "project");
    await mkdir(projectRoot, { recursive: true });
    f.store.create("project_registry_migration", "observed", { project_root: projectRoot, state: "applied" });
    f.store.create("scope_alias", "observed-alias", { alias: projectRoot, scope: { kind: "project", id: "project:demo" } });
    const withMigration = buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", project_root: projectRoot });
    assert.equal((withMigration.migration as JsonObject).status, "registry_plan_observed");
    const missingRecord = taskRecord("missing", "session:A");
    delete missingRecord.turn_outcome;
    const withDefaultOutcome = buildCapabilityIterationPlan(f.store, { project_scope_id: "project:demo", records: [missingRecord] });
    assert.equal(((withDefaultOutcome.learning_record as JsonObject).feedback_outcomes as JsonObject).unverified, 1);
    const nested = buildCapabilityIterationPlan(f.store, { project_scope_id: "outer", input: { project_scope_id: "inner",
      records: [taskRecord("t", "s", "failed")] } });
    assert.equal(nested.project_scope_id, "inner");
    assert.equal((nested.learning_record as JsonObject).outcome, "inconclusive");
    assert.equal((nested.task_ledger as JsonObject).records_supplied, 1);
  } finally { await dispose(f); }
});

test("Gap audit classifies remaining work and says no new context member is missing", async () => {
  const f = await fixture();
  try {
    const gaps = capabilityIterationGaps(f.store, { project_scope_id: "project:demo", surface: "component-context-agent" });
    assert.equal(gaps.status, "partial");
    assert.equal(gaps.generated_without_writes, true);
    assert.equal(gaps.automatic_apply_allowed, false);
    assert.equal(((gaps.control_plane as JsonObject).missing_subcapabilities as unknown[]).length, 0);
    assert.match(String(gaps.capability_boundary), /No fifth Context member/u);
    const ids = (gaps.gaps as JsonObject[]).map(item => String(item.id));
    for (const id of ["diagnostic_errors", "readiness_doctor", "context_usage", "controlled_task_effect", "hook_execution_proof"]) assert.ok(ids.includes(id));
    assert.equal((gaps.gaps as JsonObject[]).find(item => item.id === "business_data_migration"), undefined);
    const recurring = capabilityIterationGaps(f.store, { project_scope_id: "project:demo", records: [taskRecord("a", "session:A"), taskRecord("b", "session:B")] });
    const recurringGaps = recurring.gaps as JsonObject[];
    assert.equal(recurringGaps.some(item => item.id === "project_asset_recurrence"), false);
    assert.equal(recurringGaps.some(item => item.id === "controlled_task_effect"), true,
      "verified use recurrence must not clear the independent effect-evidence gap");
    const projectRoot = join(f.root, "project");
    await mkdir(projectRoot, { recursive: true });
    const scope = projectIdentityFromRoot(projectRoot).canonical_scope as JsonObject;
    f.store.create("project_registry_migration", "observed", { project_root: projectIdentityFromRoot(projectRoot).local_path_alias, state: "applied" });
    f.store.create("context_emission", "emission", { status: "shown", scope });
    f.store.create("context_feedback", "feedback", { outcome: "helpful", scope, token_measurement: { injected_tokens: 10 } });
    const withMigration = capabilityIterationGaps(f.store, { project_scope_id: scope.id, project_root: projectRoot });
    assert.ok((withMigration.gaps as JsonObject[]).some(item => item.id === "business_data_migration"));
    assert.ok(!(withMigration.gaps as JsonObject[]).some(item => item.id === "context_usage"));
  } finally { await dispose(f); }
});

function gapById(result: JsonObject, id: string): JsonObject | undefined {
  return (result.gaps as JsonObject[]).find(item => item.id === id);
}

async function callGapTool(service: CraftService, args: JsonObject): Promise<JsonObject> {
  const server = new McpServer(service, "component-context-agent");
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "craft_capability_iteration_gaps", arguments: args } });
  const result = response?.result as JsonObject;
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent as JsonObject;
}

test("Gap audit uses canonical workspace scope and excludes other projects' usage", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "workspace");
    await mkdir(root);
    const identity = projectIdentityFromRoot(root);
    const scope = identity.canonical_scope as JsonObject;
    f.store.create("project_identity", String(scope.id), identity);
    f.store.create("context_emission", "other-emission", { scope: { kind: "project", id: "project:other" } });
    f.store.create("context_feedback", "other-feedback", { scope: { kind: "project", id: "project:other" } });
    const global = capabilityIterationGaps(f.store);
    assert.equal(global.project_scope_id, "global");
    assert.equal(gapById(global, "context_usage"), undefined);
    const rootOnly = capabilityIterationGaps(f.store, { project_root: root });
    assert.equal(rootOnly.project_scope_id, scope.id);
    assert.equal(gapById(rootOnly, "project_identity_migration"), undefined);
    assert.equal(gapById(rootOnly, "context_usage")?.status, "evidence_pending");
    assert.deepEqual(capabilityIterationGaps(f.store, { project_root: root, project_scope_id: scope.id }), rootOnly);
    assert.equal(f.store.count("project_registry_migration"), 0);
    assert.equal(f.store.count("scope_alias"), 0);
    assert.equal(f.store.count("project_identity"), 1);
    assert.ok(!JSON.stringify(rootOnly).includes(root));
  } finally { await dispose(f); }
});

test("Gap audit fails closed before querying on conflicting or unresolved project roots", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "workspace");
    await mkdir(root);
    const read = () => { assert.fail("A rejected identity must stop before querying diagnostics"); };
    f.store.list = read;
    f.store.count = read;
    assert.equal(capabilityIterationGaps(f.store, { project_root: root, project_scope_id: "project:other" }).status, "identity_conflict");
    const unresolved = capabilityIterationGaps(f.store, { project_root: join(root, "missing") });
    assert.equal(unresolved.status, "identity_unresolved");
    assert.equal(unresolved.project_scope_id, null);
  } finally { await dispose(f); }
});

test("Gap audit reports required migration, ambiguity and unavailable identity owners", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "workspace");
    await mkdir(root);
    const scope = projectIdentityFromRoot(root).canonical_scope as JsonObject;
    f.store.create("scope_alias", "legacy-alias", { status: "active", alias_kind: "path", alias: root,
      scope: { kind: "project", id: "project:legacy" } });
    const args = { project_root: root, project_scope_id: scope.id };
    const legacy = capabilityIterationGaps(f.store, args);
    assert.equal(legacy.status, "identity_unresolved");
    assert.equal(gapById(legacy, "project_identity_migration")?.status, "authorization_pending");
    f.store.create("project_identity", "project:another-legacy", { local_path_alias: root });
    const ambiguous = capabilityIterationGaps(f.store, args);
    assert.equal(ambiguous.status, "identity_unresolved");
    assert.equal(ambiguous.project_scope_id, null);
    assert.equal(gapById(ambiguous, "project_identity_migration"), undefined);
    const unavailable = { stores: new Map() };
    assert.equal(capabilityIterationGaps(f.store, args, unavailable).status, "owner_unavailable");
    const global = capabilityIterationGaps(f.store, {}, unavailable);
    for (const id of ["context_usage", "project_asset_recurrence", "controlled_task_effect", "hook_execution_proof"]) {
      assert.equal(gapById(global, id)?.status, "owner_unavailable");
    }
    f.store.readSnapshot = () => { throw new Error("Registry is inaccessible"); };
    assert.equal(capabilityIterationGaps(f.store, args).status, "owner_unavailable");
  } finally { await dispose(f); }
});

test("Gap audit leaves inaccessible project usage unknown", async (context) => {
  const f = await fixture();
  try {
    const list = f.store.list.bind(f.store);
    context.mock.method(f.store, "list", (kind: string, ...args: Parameters<typeof list> extends [string, ...infer Rest] ? Rest : never) => {
      if (kind === "context_emission" && args[0] === 1) throw new Error("Scoped emissions are inaccessible");
      return list(kind, ...args);
    });
    const result = capabilityIterationGaps(f.store, { project_scope_id: "project:demo" });
    assert.equal(gapById(result, "context_usage")?.status, "owner_unavailable");
  } finally { await dispose(f); }
});

test("Gap audit reports observed runtime versions without a static plugin cache gap", async () => {
  const f = await fixture();
  try {
    await mkdir(f.store.paths.runtimeDir, { recursive: true });
    await writeFile(join(f.store.paths.runtimeDir, "learning-worker-knowledge.lock.json"),
      JSON.stringify({ pid: process.pid, owner_id: "diagnostic-fixture", runtime_version: CRAFT_RELEASE_VERSION }));
    const result = await callGapTool(new CraftService(f.store), {});
    assert.equal(gapById(result, "codex_plugin_cache"), undefined);
    const runtime = result.runtime as JsonObject;
    assert.equal(runtime.version, CRAFT_RELEASE_VERSION);
    assert.equal(runtime.source, "mcp_runtime");
    const worker = (runtime.learning_workers as JsonObject).knowledge as JsonObject;
    assert.equal(worker.owner_version, CRAFT_RELEASE_VERSION);
    assert.equal(worker.liveness, "unverified");
    assert.equal(worker.owner_pid, undefined);
  } finally { await dispose(f); }
});

test("Gap audit clears task effect only for an eligible signed report from the Eval owner", async (context) => {
  const f = await fixture();
  const evalFixture = await fixture();
  try {
    const evalOwner = new CraftService(evalFixture.store);
    const identity = evalOwner.scopeIdentityResolveProject({ project_root: evalFixture.root }).identity as JsonObject;
    const scope = identity.canonical_scope as JsonObject;
    const candidate = evalFixture.store.create("experience_procedure", "candidate", { scope, content_digest: "sha256:" + "a".repeat(64) });
    const report = procedureTaskEffectFixture(evalOwner, candidate);
    const otherReport = procedureTaskEffectFixture(evalOwner, candidate);
    assert.notEqual(otherReport.evaluation_contract_id, report.evaluation_contract_id);
    const candidateRef = evalOwner.evaluationContracts.artifactRef("experience_procedure", String(candidate.id), Number(candidate.version));
    const ref = { contract_id: report.evaluation_contract_id, evaluation_id: report.evaluation_id, candidate_ref: candidateRef };
    const service = await CraftService.open(f.store, undefined, { owner: "context", stores: new Map([["eval", evalFixture.store]]),
      services: new Map([["eval", evalOwner]]), contributors: [] });
    const args = { project_scope_id: scope.id, effect_evaluation_ref: ref };
    const result = await callGapTool(service, args);
    assert.equal(gapById(result, "controlled_task_effect"), undefined);
    assert.ok(!JSON.stringify(result).includes(String(report.evaluation_id)));
    const otherPair = { ...ref, contract_id: otherReport.evaluation_contract_id, evaluation_id: otherReport.evaluation_id };
    assert.equal(gapById(await callGapTool(service, { ...args, effect_evaluation_ref: otherPair }), "controlled_task_effect"), undefined);
    for (const patched of [
      { ...args, effect_evaluation_ref: { ...ref, candidate_ref: { ...candidateRef, version: candidateRef.version + 1 } } },
      { ...args, effect_evaluation_ref: { ...ref, contract_id: "missing-contract" } },
      { ...args, effect_evaluation_ref: { ...ref, contract_id: otherPair.contract_id } },
      { ...args, effect_evaluation_ref: { ...ref, evaluation_id: "missing-report" } },
      { ...args, project_scope_id: "project:other" },
    ]) assert.equal(gapById(await callGapTool(service, patched), "controlled_task_effect")?.status, "evidence_pending");
    const absent = await CraftService.open(f.store, undefined, { owner: "context", stores: new Map(), contributors: [] });
    const unmounted = gapById(await callGapTool(absent, args), "controlled_task_effect");
    assert.equal(unmounted?.status, "owner_unavailable");
    assert.equal(unmounted?.next_action, "mount_eval_owner");

    const find = evalFixture.store.find.bind(evalFixture.store);
    for (const failedKind of ["evaluation_contract", "task_effect_evaluation"]) {
      const failingRead = context.mock.method(evalFixture.store, "find", (...parameters: Parameters<typeof find>) => {
        if (parameters[0] === failedKind) throw new Error("Private storage details");
        return find(...parameters);
      });
      try {
        const unavailable = await callGapTool(service, args);
        const effect = gapById(unavailable, "controlled_task_effect");
        assert.equal(effect?.status, "owner_unavailable");
        assert.equal(effect?.next_action, "restore_eval_owner_access");
        assert.ok(!JSON.stringify(unavailable).includes("Private storage details"));
      } finally { failingRead.mock.restore(); }
    }

    const corruptReport = context.mock.method(evalFixture.store, "find", (...parameters: Parameters<typeof find>) => {
      const record = find(...parameters);
      return parameters[0] === "task_effect_evaluation" && record ? { ...record, evaluator_signature: "bad-signature" } : record;
    });
    try {
      assert.equal(gapById(await callGapTool(service, args), "controlled_task_effect")?.status, "evidence_pending");
    } finally { corruptReport.mock.restore(); }
    const malformed = service.contextCapabilityIterationGaps({ ...args, effect_evaluation_ref: { contract_id: ref.contract_id } });
    assert.equal(gapById(malformed, "controlled_task_effect")?.status, "evidence_pending");
    const defaultOwner = await CraftService.open(f.store, undefined, { stores: new Map(), contributors: [] });
    assert.equal(gapById(defaultOwner.contextCapabilityIterationGaps(args), "context_usage")?.status, "evidence_pending");

    f.store.create("context_emission", "project-emission", { scope });
    f.store.create("context_feedback", "project-feedback", { scope });
    for (const component of ["knowledge", "memory", "experience"]) {
      f.store.create("activation_proof_receipt", component, { component, session_id: "verified-hook",
        plugin_release: CRAFT_RELEASE_VERSION, hook_trust_status: "trusted", mcp_reachable: true });
    }
    const resolved = service.contextCapabilityIterationGaps({ ...args, session_id: "verified-hook",
      records: [taskRecord("first", "session:first"), taskRecord("second", "session:second")] });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.unresolved_count, 0);
  } finally {
    await dispose(evalFixture);
    await dispose(f);
  }
});

test("Context usage status line prefers host measurement and exposes omissions", async () => {
  const f = await fixture();
  try {
    const empty = contextUsageStatusline(f.store);
    assert.equal((empty.tokens as JsonObject).provenance, "estimated");
    assert.equal((empty.tokens as JsonObject).total, 0);
    assert.equal((empty.feedback as JsonObject).unrated_ratio, 0);
    assert.equal(empty.content_free, true);
    f.store.create("context_resolution_receipt", "receipt", { total_items: 3, total_used_chars: 30, omitted_count: 2, session_id: "s", session_host: "codex" });
    f.store.create("context_feedback", "measured", { outcome: "helpful", usage_stage: "used", turn_outcome: "passed", session_id: "s", receipt_id: "receipt",
      token_measurement: { injected_tokens: 100, schema_tokens: 20, history_tokens: 30 }, asset_refs: [{ member: "knowledge", id: "k" }] });
    f.store.create("context_feedback", "unrated", { outcome: "unrated", session_id: "s", receipt_id: "receipt" });
    const measured = contextUsageStatusline(f.store, { session_id: "s", session_host: "codex" });
    assert.equal((measured.tokens as JsonObject).provenance, "host_reported");
    assert.equal((measured.tokens as JsonObject).total, 150);
    assert.equal((measured.tokens as JsonObject).measured_feedback, 1);
    assert.equal((measured.selected as JsonObject).items, 3);
    assert.equal((measured.selected as JsonObject).omitted, 2);
    assert.equal((measured.feedback as JsonObject).unrated_ratio, 0.5);
    assert.match(String(measured.line), /measured context 150 tok/u);
    assert.deepEqual((measured.recent as JsonObject[]).map(item => item.outcome).sort(), ["helpful", "unrated"]);
    const estimated = contextUsageStatusline(f.store, { session_id: "other" });
    assert.equal((estimated.tokens as JsonObject).estimated, 0);
    f.store.create("context_resolution_receipt", "other-host", { total_items: 1, total_used_chars: 9, omitted_count: 0, session_id: "s", session_host: "claude" });
    f.store.create("context_feedback", "partial-measurement", { outcome: "irrelevant", receipt_id: "other-host", session_id: "s",
      token_measurement: { schema_tokens: 5 } });
    f.store.create("context_feedback", "bad-measurement", { outcome: "stale", receipt_id: "other-host", session_id: "s",
      token_measurement: { injected_tokens: -1, history_tokens: "x" } });
    f.store.create("context_feedback", "no-outcome", { receipt_id: "other-host", session_id: "s" });
    f.store.create("context_resolution_receipt", "sparse-receipt", { session_id: "s", session_host: "claude" });
    const partial = contextUsageStatusline(f.store, { session_id: "s", session_host: "claude" });
    assert.equal((partial.tokens as JsonObject).provenance, "estimated");
    assert.equal((partial.feedback as JsonObject).records, 3);
    assert.equal((partial.selected as JsonObject).items, 1);
    assert.equal(((partial.feedback as JsonObject).outcomes as JsonObject).unknown, 1);
    unratedFromClaude(partial);
  } finally { await dispose(f); }
});

test("Codebase LSP readiness reports configured, missing and unsupported languages without starting a server", async () => {
  const f = await fixture();
  try {
    const empty = codebaseLspReadiness(f.store, { files: ["src/a.ts", "main.py", "data.csv"] });
    assert.equal((empty.config as JsonObject).exists, false);
    assert.deepEqual((empty.files as JsonObject).languages, ["python", "typescript"]);
    const languages = empty.languages as JsonObject[];
    assert.equal(languages.find(item => item.language === "typescript")!.status, "server_not_configured");
    assert.equal((languages.find(item => item.language === "typescript")!.suggested_config as JsonObject).args instanceof Array, true);
    assert.equal((empty.security as JsonObject).starts_language_server, false);
    await mkdir(f.store.paths.configDir, { recursive: true });
    const executable = process.execPath;
    await writeFile(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1, adapters: [
      { language: "typescript", command: executable, args: ["--version"], analyzer_version: "tsserver-1" },
      { language: "python", command: "relative", args: [] },
    ] }));
    const configured = codebaseLspReadiness(f.store, { files: ["src/a.ts", "main.py"] });
    const items = configured.languages as JsonObject[];
    assert.equal(items.find(item => item.language === "typescript")!.status, "trusted_adapter_configured");
    assert.equal(items.find(item => item.language === "python")!.status, "server_not_configured");
    assert.equal((configured.summary as JsonObject).configured_languages, 1);
    assert.ok((configured.config_diagnostics as JsonObject[]).length > 0);
    assert.equal(configured.content_free, true);
    const noFiles = codebaseLspReadiness(f.store, { files: [42, "  ", "README.md"] });
    assert.deepEqual((noFiles.files as JsonObject).languages, []);
    assert.equal((noFiles.languages as JsonObject[]).length, 0);
    const unsupported = codebaseLspReadiness(f.store, { files: ["data.csv"], languages: ["ruby"] });
    assert.equal((unsupported.languages as JsonObject[]).length, 1);
    assert.equal(((unsupported.languages as JsonObject[])[0]!).status, "unsupported_language");
    const rust = codebaseLspReadiness(f.store, { languages: ["rust"] });
    assert.equal(((rust.languages as JsonObject[])[0]!).status, "server_not_configured");
    const elixir = codebaseLspReadiness(f.store, { languages: ["elixir"] });
    assert.equal(((elixir.languages as JsonObject[])[0]!).status, "unsupported_language");
    const keyed = codebaseLspReadiness(f.store, { languages: [42, "elixir"] });
    assert.equal((keyed.languages as JsonObject[]).length, 1);
    assert.equal(((keyed.languages as JsonObject[])[0]!).language, "elixir");
    assert.equal(((rust.languages as JsonObject[])[0]!).suggested_command, "rust-analyzer");
    assert.equal(((rust.languages as JsonObject[])[0]!).suggested_config !== null, true);
    assert.equal((((rust.languages as JsonObject[])[0]!).suggested_config as JsonObject).command_must_be_absolute, true);
    assert.equal(lspCommandIsAbsolute("rust-analyzer"), false);
    assert.equal(lspCommandIsAbsolute(process.execPath), true);
    assert.equal(lspCommandIsAbsolute(42), false);
    assert.throws(() => codebaseLspReadiness(f.store, { files: "a.ts" as unknown as string[] }), /files/u);
  } finally { await dispose(f); }
});

function unratedFromClaude(statusline: JsonObject): void {
  const outcomes = (statusline.feedback as JsonObject).outcomes as JsonObject;
  assert.equal(outcomes.irrelevant, 1);
  assert.equal(outcomes.stale, 1);
}

test("owned Doctor leaves absent or inaccessible owners unknown and accepts only objective trust", async () => {
  const f = await fixture();
  try {
    const absent = contextReadinessDoctor(f.store, { project_root: f.root }, { stores: new Map() });
    assert.equal((absent.identity as JsonObject).status, "owner_unavailable");
    assert.equal((absent.activation as JsonObject).status, "owner_unavailable");
    assert.equal((absent.iteration_plan as JsonObject).status, "owner_unavailable");
    const peerOnly = contextReadinessDoctor(f.store, {}, { stores: new Map([["memory", f.store]]) });
    assert.ok((peerOnly.activation as JsonObject).components);
    f.store.create("activation_proof_receipt", "untrusted", { component: "memory", session_id: "s", plugin_release: CRAFT_RELEASE_VERSION, hook_trust_status: "untrusted" });
    f.store.create("codex_hook_turn", "journal", { trace_id: "doctor-journal", session_id: "s", has_edit: true, signals: [] });
    const untrusted = contextReadinessDoctor(f.store, { session_id: "s" });
    assert.equal((untrusted.verification_gap as JsonObject).reason, "hook_untrusted");
    f.store.create("context_correction_task", "legacy-lifecycle", { lifecycle: "confirmed" });
    const port = contextReadinessDoctor(f.store, {}, { readiness: { authentication: "unavailable" } });
    assert.equal(((port.context as JsonObject).corrections as JsonObject).confirmed, 1);
    assert.equal((port.verification_gap as JsonObject).readiness_source, "observed_host_readiness_port");
    assert.equal((port.verification_gap as JsonObject).reason, "host_auth_unavailable");
    const originalCount = f.store.count.bind(f.store), originalList = f.store.list.bind(f.store);
    f.store.count = (kind: string) => { if (kind === "knowledge_claim") throw new Error("OwnerReadUnavailable"); return originalCount(kind); };
    f.store.list = (kind, ...args) => { if (kind === "knowledge_claim") throw new Error("OwnerReadUnavailable"); return originalList(kind, ...args); };
    const unavailable = contextReadinessDoctor(f.store);
    assert.equal(((unavailable.components as JsonObject).knowledge as JsonObject).records, null);
    assert.equal(((unavailable.components as JsonObject).knowledge as JsonObject).status_counts_status, "incomplete");
    f.store.count = originalCount; f.store.list = originalList;
  } finally { await dispose(f); }
});
