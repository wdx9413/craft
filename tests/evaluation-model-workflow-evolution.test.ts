import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvaluationModelProfileKernel } from "../capability/craft-experience/evaluation-model-profile.ts";
import { validateGraphControl } from "../capability/craft-experience/procedure-graph.ts";
import { McpServer, surfaceToolNames } from "../core/mcp.ts";
import { PROVIDER_CATALOG } from "../core/model-gateway.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-evaluation-model-workflow-evolution-")); const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store); const evidence = service.evidenceRecord({ evidence_id: "confirmed", source_type: "program", confidence: "confirmed", claim: "sanitized outcome observed" });
  return { root, store, service, evidence };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
function observation(service: CraftService, id: string, sourceId: string, outcome: string = "passed") {
  return service.workflowEvolutionObserve({ observation_id: id, scenario_key: "support-refund", source_kind: "external_execution", source_id: sourceId, source_digest: `sha256:${sourceId}`, outcome, evidence_ids: ["confirmed"], sanitized: true, content_stored: false }).observation as JsonObject;
}

test("graph proposal retries compare validated control instead of silently changing it", async () => {
  const f = await fixture();
  try {
    const nodes = [
      { id: "start", type: "action", side_effect: "read_only", requires: [], provides: ["result"], acceptance_ref: "acceptance:start" },
      { id: "exit", type: "action", side_effect: "read_only", requires: ["result"], provides: [], acceptance_ref: "acceptance:exit" },
    ];
    const edges = [{ id: "edge", from: "start", to: "exit", kind: "success", max_traversals: 1 }];
    const control = { scenario_id: "scenario", title: "Scenario", entries: [{ id: "entry", node_id: "start", required_inputs: [], preconditions: [] }],
      exits: [{ id: "done", node_id: "exit", required_outputs: ["result"], acceptance_ref: "acceptance:exit" }],
      subscenarios: [{ id: "sub", title: "Sub", entry_id: "entry", exit_id: "done", allowed_nodes: ["start", "exit"], allowed_edges: ["edge"], allowed_effects: ["read_only"], max_transitions: 2, max_visits: 2 }] };
    f.store.create("workflow_evolution_request", "graph-retry", { lifecycle: "awaiting_model", procedure_kind: "graph", scenario_key: "scenario" });
    f.store.create("workflow_evolution_proposal", "graph-prior", { request_id: "graph-retry", graph: { graph_control: validateGraphControl(control, nodes, edges) } });
    const retry = { request_id: "graph-retry", proposal_id: "graph-prior", graph_control: control, nodes, edges };
    assert.equal(f.service.workflowEvolution.submit(retry).idempotent, true);
    assert.throws(() => f.service.workflowEvolution.submit({ ...retry, graph_control: { ...control, title: "Changed" } }), /Graph proposal idempotency conflict/);
    assert.throws(() => f.service.workflowEvolution.submit({ request_id: "graph-retry", proposal_id: "graph-prior" }), /Graph proposal idempotency conflict/);
    f.store.create("workflow_evolution_proposal", "graph-missing-control", { request_id: "graph-retry", graph: {} });
    assert.throws(() => f.service.workflowEvolution.submit({ ...retry, proposal_id: "graph-missing-control" }), /Graph proposal idempotency conflict/);
    f.store.create("workflow_evolution_request", "graph-new", { lifecycle: "awaiting_model", procedure_kind: "graph", scenario_key: "scenario" });
    const newProposal = f.service.workflowEvolution.submit({ request_id: "graph-new", proposal_id: "graph-new-proposal", workflow_id: "graph", name: "Graph", description: "Graph", inputs: [], nodes, edges, graph_control: control }).proposal as JsonObject;
    assert.equal(((newProposal.graph as JsonObject).graph_control as JsonObject).scenario_id, "scenario");
  } finally { await close(f); }
});

test("reserves a secret-free model profile and fails closed until explicit enablement and credentials", async () => {
  const f = await fixture();
  try {
    const kernel = new EvaluationModelProfileKernel(f.store, PROVIDER_CATALOG, {});
    const saved = kernel.save({ profile_id: "qwen-eval", provider: "qwen", tier: "frontier", purposes: ["workflow_evolution"] });
    const profile = saved.profile as JsonObject;
    assert.equal(profile.model, "qwen-max"); assert.equal(profile.api_key_env, "DASHSCOPE_API_KEY"); assert.equal(profile.secret_stored, false);
    assert.equal((saved.readiness as JsonObject).status, "needs_enablement");
    assert.equal(kernel.save({ profile_id: "qwen-eval", provider: "qwen", tier: "frontier", purposes: ["workflow_evolution"] }).idempotent, true);
    assert.throws(() => kernel.save({ profile_id: "qwen-eval", provider: "qwen", model: "other" }), /idempotency/);
    assert.throws(() => kernel.save({ provider: "unknown", model: "x" }), /Unknown model provider/);
    assert.throws(() => kernel.save({ provider: " ", model: "x" }), /provider/);
    assert.throws(() => kernel.save({ provider: "qwen", model: "api_key=abcdefgh" }), /credentials/);
    assert.throws(() => kernel.save({ provider: "qwen" }), /model or tier/);
    assert.equal((kernel.save({ provider: "qwen", model: "qwen-custom", purposes: ["evaluation", "workflow_evolution"], max_output_tokens: 8, max_attempts: 2, temperature: 0.2, network_execution_enabled: false }).profile as JsonObject).model, "qwen-custom");
    assert.throws(() => kernel.save({ provider: "qwen", model: "x", temperature: 3 }), /temperature/);
    assert.throws(() => kernel.save({ provider: "qwen", model: "x", network_execution_enabled: "yes" }), /boolean/);
    assert.throws(() => kernel.save({ provider: "qwen", model: "x", purposes: ["other"] }), /unsupported purpose/);
    assert.equal((kernel.list({ limit: 1 }).profiles as JsonObject[]).length, 1);
    assert.throws(() => kernel.list({ limit: 0 }), /limit/);
    assert.equal((kernel.get({ profile_id: profile.id, version: profile.version }).profile as JsonObject).id, profile.id);
    assert.equal((kernel.get({ profile_id: profile.id }).profile as JsonObject).id, profile.id);
    const qwenProvider = PROVIDER_CATALOG.find(item => item.provider === "qwen")!;
    const cachedKernel = new EvaluationModelProfileKernel(f.store, [{ ...qwenProvider,
      context_cache: { mode: "automatic_prefix", requires_exact_prefix: true, usage_fields: "none" } }], {});
    const cachedProfile = cachedKernel.save({ profile_id: "cached-provider", provider: "qwen", model: "qwen-plus" }).profile as JsonObject;
    assert.equal((cachedKernel.get({ profile_id: cachedProfile.id }).provider as JsonObject).context_cache instanceof Object, true);
    const legacyKernel = new EvaluationModelProfileKernel(f.store, [{ ...qwenProvider, context_cache: undefined }], {});
    const legacyProfile = legacyKernel.save({ profile_id: "legacy-provider", provider: "qwen", model: "qwen-plus" }).profile as JsonObject;
    assert.deepEqual((legacyKernel.get({ profile_id: legacyProfile.id }).provider as JsonObject).context_cache,
      { mode: "none", requires_exact_prefix: false, usage_fields: "none" });
    assert.equal((kernel.ticketList().tickets as JsonObject[]).length >= 0, true);
    assert.throws(() => kernel.get({ profile_id: profile.id, version: 0 }), /version/);

    observation(f.service, "one", "record-one"); observation(f.service, "two", "record-two", "failed");
    const request = f.service.workflowEvolutionPropose({ request_id: "proposal-request", scenario_key: "support-refund", hypothesis: "group the verified checks", design_axes: ["orchestration"], output_contract_ref: "contract:workflow-v1" }).request as JsonObject;
    const ticket = kernel.issue({ ticket_id: "ticket", profile_id: profile.id, purpose: "workflow_evolution", workflow_evolution_request_id: request.id, input_ref: "external:batch-1", output_contract_ref: "contract:workflow-v1" });
    assert.equal((ticket.ticket as JsonObject).status, "needs_enablement"); assert.equal(ticket.idempotent, false);
    assert.equal(kernel.issue({ ticket_id: "ticket", profile_id: profile.id, purpose: "workflow_evolution", workflow_evolution_request_id: request.id, input_ref: "external:batch-1", output_contract_ref: "contract:workflow-v1" }).idempotent, true);
    assert.throws(() => kernel.issue({ ticket_id: "ticket", profile_id: profile.id, purpose: "workflow_evolution", workflow_evolution_request_id: request.id, input_ref: "changed", output_contract_ref: "contract:workflow-v1" }), /idempotency/);
    assert.throws(() => kernel.save({ provider: "qwen", model: "x", purposes: [] }), /non-empty/);
    assert.throws(() => kernel.save({ provider: "qwen", model: "x", purposes: "evaluation" }), /array/);
    assert.throws(() => kernel.issue({ profile_id: profile.id, purpose: "evaluation", input_ref: "x", output_contract_ref: "y" }), /does not allow this purpose/);
    f.store.save("workflow_evolution_request", String(request.id), { ...request, lifecycle: "draft_submitted" });
    assert.throws(() => kernel.issue({ profile_id: profile.id, purpose: "workflow_evolution", workflow_evolution_request_id: request.id, input_ref: "x", output_contract_ref: "y" }), /not awaiting a model proposal/);

    const enabledWithoutCredential = new EvaluationModelProfileKernel(f.store, PROVIDER_CATALOG, {}).save({ profile_id: "enabled", provider: "qwen", model: "qwen-plus", network_execution_enabled: true });
    assert.equal((enabledWithoutCredential.readiness as JsonObject).status, "needs_credential");
    const ready = new EvaluationModelProfileKernel(f.store, PROVIDER_CATALOG, { DASHSCOPE_API_KEY: "not-stored" }).save({ profile_id: "ready", provider: "qwen", model: "qwen-plus", network_execution_enabled: true });
    assert.equal((ready.readiness as JsonObject).status, "ready_for_adapter");
    const evalProfile = kernel.save({ profile_id: "eval", provider: "qwen", model: "qwen-plus", purposes: ["evaluation"] }).profile as JsonObject;
    f.store.create("campaign_runner_dispatch", "issued-dispatch", { status: "issued", runner_id: "runner", slot_id: "slot" });
    assert.equal(((kernel.issue({ profile_id: evalProfile.id, purpose: "evaluation", campaign_dispatch_id: "issued-dispatch", input_ref: "case:one", output_contract_ref: "contract:out" }).ticket as JsonObject).target as JsonObject).kind, "campaign_runner_dispatch");
    assert.match(String((kernel.issue({ profile_id: evalProfile.id, purpose: "evaluation", campaign_dispatch_id: "issued-dispatch", input_ref: "case:generated", output_contract_ref: "contract:out" }).ticket as JsonObject).id), /^evaluation_model_ticket_/);
    f.store.create("campaign_runner_dispatch", "closed-dispatch", { status: "bound", runner_id: "runner", slot_id: "slot" });
    assert.throws(() => kernel.issue({ profile_id: evalProfile.id, purpose: "evaluation", campaign_dispatch_id: "closed-dispatch", input_ref: "case:two", output_contract_ref: "contract:out" }), /not issuable/);
    f.store.create("evaluation_model_profile", "inactive", { provider: "qwen", lifecycle: "disabled", purposes: ["evaluation"] });
    assert.throws(() => kernel.issue({ profile_id: "inactive", purpose: "evaluation", campaign_dispatch_id: "issued-dispatch", input_ref: "case", output_contract_ref: "contract" }), /not active/);
    assert.throws(() => kernel.issue({ profile_id: evalProfile.id, purpose: "evaluation", campaign_dispatch_id: "missing", input_ref: "case", output_contract_ref: "contract" }), /Unknown/);
  } finally { await close(f); }
});

test("Knowledge classification tickets track the live candidate and keep result records content free", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_source", "source-1", { status: "active", trust: "verified" });
    f.store.create("knowledge_claim", "claim-1", { status: "candidate", scope: "project:demo", version: 1,
      content_digest: "sha256:claim", source_id: "source-1" });
    f.store.create("knowledge_claim", "reviewed-claim", { status: "reviewed", scope: "project:demo", version: 1,
      content_digest: "sha256:reviewed", source_id: "source-1" });
    const kernel = new EvaluationModelProfileKernel(f.store, PROVIDER_CATALOG, { DASHSCOPE_API_KEY: "configured-for-test" });
    const saved = kernel.save({ profile_id: "knowledge-classifier", provider: "qwen", model: "qwen-plus",
      purposes: ["knowledge_scenario_classification"], network_execution_enabled: true });
    const profile = saved.profile as JsonObject;
    const issued = kernel.issue({ profile_id: profile.id, purpose: "knowledge_scenario_classification", knowledge_claim_id: "claim-1",
      input_ref: "craft-knowledge://claim/claim-1/v1/catalog/0", output_contract_ref: "craft-knowledge-scenario-classification-v1" });
    const ticket = issued.ticket as JsonObject;
    assert.equal(ticket.status, "ready_for_adapter");
    const reviewedTicket = kernel.issue({ profile_id: profile.id, purpose: "knowledge_scenario_classification", knowledge_claim_id: "reviewed-claim",
      input_ref: "craft-knowledge://claim/reviewed-claim/v1/catalog/0", output_contract_ref: "craft-knowledge-scenario-classification-v1" }).ticket as JsonObject;
    assert.equal(reviewedTicket.status, "ready_for_adapter");
    const target = ticket.target as JsonObject;
    const staleTargets: Array<[string, JsonObject | undefined]> = [
      ["missing", { ...target, id: "missing-claim" }],
      ["rejected", { ...target, id: "rejected-claim", version: 1, content_digest: "sha256:rejected" }],
      ["classified", { ...target, id: "classified-claim", version: 1, content_digest: "sha256:classified" }],
      ["version", { ...target, version: 3 }],
      ["digest", { ...target, content_digest: "sha256:changed" }],
      ["scope", { ...target, id: "global-claim", version: 1, content_digest: "sha256:global" }],
      ["missing-scope", { ...target, id: "issue-missing-scope", version: 1, content_digest: "sha256:no-scope" }],
      ["missing-target", undefined],
    ];
    f.store.create("knowledge_claim", "rejected-claim", { status: "rejected", scope: "project:demo", version: 1, content_digest: "sha256:rejected" });
    f.store.create("knowledge_claim", "classified-claim", { status: "candidate", scenario_key: "existing", scope: "project:demo", version: 1, content_digest: "sha256:classified" });
    f.store.create("knowledge_claim", "global-claim", { status: "candidate", scope: "global", version: 1, content_digest: "sha256:global" });
    f.store.create("knowledge_claim", "issue-missing-scope", { status: "candidate", version: 1, content_digest: "sha256:no-scope" });
    for (const [suffix, staleTarget] of staleTargets) f.store.create("evaluation_model_ticket", `stale-${suffix}`, {
      profile_id: profile.id, profile_version: profile.version, purpose: "knowledge_scenario_classification", status: "ready_for_adapter", target: staleTarget,
    });
    assert.equal((kernel.ticketList({ purpose: "knowledge_scenario_classification" }).tickets as JsonObject[]).length, 2);
    assert.throws(() => kernel.ticketComplete({ ticket_id: ticket.id, result_digest: "bad" }), /SHA-256/u);
    const resultDigest = `sha256:${"a".repeat(64)}`;
    const completed = kernel.ticketComplete({ ticket_id: ticket.id, result_digest: resultDigest });
    assert.equal((completed.ticket as JsonObject).status, "completed");
    assert.equal((completed.ticket as JsonObject).result_digest, resultDigest);
    assert.equal((kernel.ticketList({ purpose: "knowledge_scenario_classification" }).tickets as JsonObject[]).length, 1);
    const reviewedTicketId = String(reviewedTicket.id);
    assert.equal(((kernel.ticketComplete({ ticket_id: reviewedTicketId, result_digest: resultDigest }).ticket as JsonObject).status), "completed");
    assert.throws(() => kernel.ticketComplete({ ticket_id: ticket.id, result_digest: resultDigest }), /Only a ready Knowledge/u);
    f.store.create("evaluation_model_ticket", "foreign-ticket", { purpose: "workflow_evolution", status: "ready_for_adapter" });
    assert.throws(() => kernel.ticketComplete({ ticket_id: "foreign-ticket", result_digest: resultDigest }), /Only a ready Knowledge/u);
    f.store.save("knowledge_claim", "claim-1", { status: "reviewed", scope: "project:demo", content_digest: "sha256:claim" });
    assert.deepEqual((kernel.ticketList({ purpose: "knowledge_scenario_classification" }).tickets as JsonObject[]).map(item => item.id), []);
    assert.throws(() => kernel.issue({ profile_id: profile.id, purpose: "knowledge_scenario_classification", knowledge_claim_id: "missing",
      input_ref: "input", output_contract_ref: "contract" }));
    for (const [claimId, claimValue] of [
      ["issue-rejected", { status: "rejected", scope: "project:demo", version: 1, content_digest: "sha256:rejected", source_id: "source-1" }],
      ["issue-classified", { status: "candidate", scenario_key: "known", scope: "project:demo", version: 1, content_digest: "sha256:classified", source_id: "source-1" }],
      ["issue-global", { status: "candidate", scope: "global", version: 1, content_digest: "sha256:global", source_id: "source-1" }],
      ["untrusted-claim", { status: "candidate", scope: "project:demo", version: 1, content_digest: "sha256:untrusted", source_id: "untrusted-source" }],
      ["missing-source-ref", { status: "candidate", scope: "project:demo", version: 1, content_digest: "sha256:no-source" }],
      ["missing-scope", { status: "candidate", version: 1, content_digest: "sha256:no-scope", source_id: "source-1" }],
    ] as const) f.store.create("knowledge_claim", claimId, claimValue);
    f.store.create("knowledge_source", "untrusted-source", { status: "active", trust: "untrusted" });
    for (const claimId of ["issue-rejected", "issue-classified", "issue-global", "untrusted-claim", "missing-source-ref", "missing-scope"]) {
      assert.throws(() => kernel.issue({ profile_id: profile.id, purpose: "knowledge_scenario_classification", knowledge_claim_id: claimId,
        input_ref: "input", output_contract_ref: "contract" }), /unclassified project Claim from an active trusted Source/u);
    }
    f.store.create("evaluation_model_ticket", "wrong-classification-purpose", { profile_id: profile.id, profile_version: profile.version,
      purpose: "workflow_evolution", status: "ready_for_adapter", target: { kind: "knowledge_scenario_classification", id: "claim-1" } });
    f.store.create("evaluation_model_ticket", "wrong-workflow-target", { profile_id: profile.id, profile_version: profile.version,
      purpose: "workflow_evolution", status: "ready_for_adapter", target: { kind: "unknown" } });
    f.store.create("evaluation_model_ticket", "evaluation-ticket", { profile_id: profile.id, profile_version: profile.version,
      purpose: "evaluation", status: "ready_for_adapter", target: { kind: "unknown" } });
    assert.equal((kernel.ticketList().tickets as JsonObject[]).some(item => item.id === "evaluation-ticket"), true);
  } finally { await close(f); }
});

test("automatic Knowledge profile selection reuses one purpose profile and fails closed on ambiguity", async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.evaluationModelProfileEnsureSingle({ purpose: "knowledge_scenario_classification" }).reason, "no_configured_model");
    f.service.modelAdd({ id: "qwen", name: "Qwen", baseUrl: "https://example.invalid/v1", model: "qwen-plus", apiKeyEnv: "DASHSCOPE_API_KEY" });
    const first = f.service.evaluationModelProfileEnsureSingle({ purpose: "knowledge_scenario_classification" });
    assert.equal(first.status, "needs_credential");
    assert.equal((first.profile as JsonObject).network_execution_enabled, true);
    assert.equal(f.service.evaluationModelProfileEnsureSingle({ purpose: "knowledge_scenario_classification" }).idempotent, true);
    f.store.save("evaluation_model_profile", String((first.profile as JsonObject).id), { ...first.profile as JsonObject, lifecycle: "revoked" });
    f.service.modelAdd({ id: "other", name: "Other", baseUrl: "https://example.invalid/v1", model: "other-model", apiKeyEnv: "OTHER_KEY" });
    assert.equal(f.service.evaluationModelProfileEnsureSingle({ purpose: "knowledge_scenario_classification" }).reason, "multiple_models_require_explicit_profile");
    f.service.evaluationModelProfileSave({ profile_id: "another-knowledge-profile", provider: "qwen", model: "qwen-plus",
      purposes: ["knowledge_scenario_classification"] });
    f.service.evaluationModelProfileSave({ profile_id: "second-knowledge-profile", provider: "qwen", model: "qwen-max",
      purposes: ["knowledge_scenario_classification"] });
    assert.equal(f.service.evaluationModelProfileEnsureSingle({ purpose: "knowledge_scenario_classification" }).reason, "multiple_active_profiles_for_purpose");
    assert.throws(() => f.service.evaluationModelProfileEnsureSingle({ purpose: "unknown" }), /purpose is unsupported/u);
  } finally { await close(f); }
});

test("evolves only independent sanitized evidence into a new draft Workflow and never publishes it", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.workflowEvolutionObserve({ scenario_key: "x", source_kind: "external", source_id: "one", source_digest: "d", outcome: "passed", evidence_ids: ["confirmed"], sanitized: false }), /sanitized/);
    f.store.create("evidence", "weak", { confidence: "unverified" });
    assert.throws(() => f.service.workflowEvolutionObserve({ scenario_key: "x", source_kind: "external", source_id: "one", source_digest: "d", outcome: "passed", evidence_ids: ["weak"], sanitized: true }), /confirmed or bounded/);
    assert.throws(() => f.service.workflowEvolutionObserve({ scenario_key: "x", source_kind: "external", source_id: "one", source_digest: "d", outcome: "other", evidence_ids: ["confirmed"], sanitized: true }), /outcome/);
    assert.throws(() => f.service.workflowEvolutionObserve({ scenario_key: "x", source_kind: "external", source_id: "one", source_digest: "d", outcome: "passed", evidence_ids: [], sanitized: true }), /at least 1/);
    assert.throws(() => f.service.workflowEvolutionObserve({ scenario_key: "x", source_kind: "external", source_id: "one", source_digest: "d", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true, content_stored: true }), /content-free/);
    const first = observation(f.service, "first", "source-one"); const second = observation(f.service, "second", "source-two", "failed");
    assert.equal((f.service.workflowEvolutionObserve({ observation_id: "first", scenario_key: "support-refund", source_kind: "external_execution", source_id: "source-one", source_digest: "sha256:source-one", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true }).idempotent), true);
    assert.throws(() => f.service.workflowEvolutionObserve({ observation_id: "first", scenario_key: "support-refund", source_kind: "external_execution", source_id: "source-one", source_digest: "changed", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true }), /idempotency/);
    assert.equal((f.service.workflowEvolutionObservations({ scenario_key: "support-refund" }).observations as JsonObject[]).length, 2);
    assert.throws(() => f.service.workflowEvolutionPropose({ scenario_key: "support-refund", observation_ids: [first.id, first.id], hypothesis: "h", design_axes: ["tools"], output_contract_ref: "contract" }), /unique/);
    const duplicateSource = observation(f.service, "same-source", "source-one");
    assert.throws(() => f.service.workflowEvolutionPropose({ scenario_key: "support-refund", observation_ids: [first.id, duplicateSource.id], hypothesis: "h", design_axes: ["tools"], output_contract_ref: "contract" }), /independent/);
    assert.throws(() => f.service.workflowEvolutionPropose({ scenario_key: "support-refund", hypothesis: "h", design_axes: ["tools", "context", "memory"], output_contract_ref: "contract" }), /at most two/);
    assert.throws(() => f.service.workflowEvolutionPropose({ scenario_key: "support-refund", observation_ids: [first.id, second.id], hypothesis: "h", design_axes: ["unknown"], output_contract_ref: "contract" }), /supported design axes/);
    assert.throws(() => f.service.workflowEvolutionPropose({ scenario_key: "other", observation_ids: [first.id, second.id], hypothesis: "h", design_axes: ["tools"], output_contract_ref: "contract" }), /do not match/);
    assert.throws(() => f.service.workflowEvolutionPropose({ scenario_key: "empty", hypothesis: "h", design_axes: ["tools"], output_contract_ref: "contract" }), /at least two/);
    const request = f.service.workflowEvolutionPropose({ request_id: "request", scenario_key: "support-refund", observation_ids: [first.id, second.id], hypothesis: "use a consistent check sequence", design_axes: ["tools", "orchestration"], output_contract_ref: "contract:workflow" }).request as JsonObject;
    assert.equal((f.service.workflowEvolutionPropose({ request_id: "request", scenario_key: "support-refund", observation_ids: [first.id, second.id], hypothesis: "use a consistent check sequence", design_axes: ["tools", "orchestration"], output_contract_ref: "contract:workflow" }).idempotent), true);
    const baseline = f.service.workflowSave({ workflow_id: "existing", name: "Existing", steps: [] });
    const profile = f.service.evaluationModelProfileSave({ profile_id: "evolution-model", provider: "qwen", model: "qwen-plus", purposes: ["workflow_evolution"] }).profile as JsonObject;
    const ticket = f.service.evaluationModelTicketIssue({ ticket_id: "evolution-ticket", profile_id: profile.id, purpose: "workflow_evolution", workflow_evolution_request_id: request.id, input_ref: "external:batch", output_contract_ref: "contract:workflow" }).ticket as JsonObject;
    assert.equal(ticket.purpose, "workflow_evolution"); assert.equal((ticket.target as JsonObject).id, request.id); assert.equal((ticket.target as JsonObject).version, request.version);
    const submitted = f.service.workflowEvolutionProposalSubmit({ proposal_id: "draft", request_id: request.id, model_ticket_id: ticket.id, workflow_id: "support-refund-v2", name: "Support refund verification", description: "A generic evidence-backed draft.", inputs: ["case_ref"], steps: [{ id: "verify", type: "assertion", evaluator: "file_exists", path: "receipt.txt" }], replaces_workflow_id: baseline.id });
    const workflow = submitted.workflow as JsonObject;
    assert.equal(workflow.lifecycle, "draft"); assert.equal((workflow.derived_from as JsonObject).workflow_evolution_proposal_id, "draft"); assert.equal((submitted.proposal as JsonObject).publication_allowed, false);
    assert.equal((f.service.workflowEvolutionProposalGet({ proposal_id: "draft" }).proposal as JsonObject).id, "draft");
    assert.equal(f.service.workflowEvolutionProposalSubmit({ proposal_id: "draft", request_id: request.id, model_ticket_id: ticket.id, workflow_id: "support-refund-v2", name: "Support refund verification", description: "A generic evidence-backed draft.", inputs: ["case_ref"], steps: [{ id: "verify", type: "assertion", evaluator: "file_exists", path: "receipt.txt" }], replaces_workflow_id: baseline.id }).idempotent, true);
    const nextRequest = f.service.workflowEvolutionPropose({ request_id: "request-next", scenario_key: "support-refund", observation_ids: [first.id, second.id], hypothesis: "tighten the receipt check", design_axes: ["orchestration"], output_contract_ref: "contract:workflow" }).request as JsonObject;
    const nextTicket = f.service.evaluationModelTicketIssue({ ticket_id: "ticket-next", profile_id: profile.id, purpose: "workflow_evolution", workflow_evolution_request_id: nextRequest.id, input_ref: "external:batch-next", output_contract_ref: "contract:workflow" }).ticket as JsonObject;
    const next = f.service.workflowEvolutionProposalSubmit({ proposal_id: "draft-next", request_id: nextRequest.id, model_ticket_id: nextTicket.id, workflow_id: "support-refund-v3", name: "Support refund verification v2", description: "An iterated, bounded draft.", inputs: ["case_ref"], steps: [{ id: "verify", type: "assertion", evaluator: "file_exists", path: "receipt-v2.txt" }] });
    const firstProcedure = submitted.procedure as JsonObject, nextProcedure = next.procedure as JsonObject;
    assert.equal(nextProcedure.id, firstProcedure.id);
    assert.equal(nextProcedure.version, Number(firstProcedure.version) + 1);
    assert.equal(nextProcedure.lifecycle, "candidate");
    assert.equal(((nextProcedure.definition_ref as JsonObject).procedure_version), 2);
    assert.equal((f.store.get("experience_procedure", String(firstProcedure.id), Number(firstProcedure.version)).definition_ref as JsonObject).procedure_version, 1);
    assert.throws(() => f.service.workflowEvolutionProposalSubmit({ request_id: request.id, workflow_id: "again", name: "Again", description: "again", inputs: [], steps: [{ type: "assertion" }] }), /no longer awaiting/);
    assert.equal((f.service.workflowEvolutionProposalGet({ proposal_id: "draft", request_id: request.id }).request as JsonObject).id, request.id);
    assert.equal((f.service.workflowEvolutionObservations({}).observations as JsonObject[]).length, 3);
  } finally { await close(f); }
});

test("exposes a bounded Workflow Evolution plugin surface and keeps it separate from discovery and work execution", async () => {
  const f = await fixture();
  try {
    const surface = "component-experience"; const names = surfaceToolNames(surface);
    assert(names.includes("craft_experience_observe")); assert(names.includes("craft_evaluation_model_profile_save"));
    assert(!names.includes("craft_capability_search")); assert(!names.includes("craft_verified_work_loop_prepare"));
    const server = new McpServer(f.service, surface);
    const response = await server.handle({ id: "observe", method: "tools/call", params: { name: "craft_experience_observe", arguments: { observation_id: "mcp", scenario_key: "mcp", source_kind: "external", source_id: "one", source_digest: "sha256:one", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true } } });
    assert.equal((response?.result as JsonObject).isError, false);
    const blocked = await server.handle({ id: "blocked", method: "tools/call", params: { name: "craft_capability_search", arguments: { query: "x" } } });
    assert.equal((blocked?.error as JsonObject).code, -32602);
  } finally { await close(f); }
});

test("routes every reserved model and Workflow-evolution operation through the component MCP surface", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(f.service, "component-experience");
    const profile = (await server.handlers.craft_evaluation_model_profile_save({ profile_id: "mcp-profile", provider: "qwen", model: "qwen-plus", purposes: ["workflow_evolution"] })).profile as JsonObject;
    const profileDetails = await server.handlers.craft_evaluation_model_profile_get({ profile_id: profile.id });
    assert.equal((profileDetails.profile as JsonObject).id, profile.id);
    assert.equal((profileDetails.provider as JsonObject).provider, "qwen");
    assert.equal(((await server.handlers.craft_evaluation_model_profile_list({ limit: 1 })).profiles as JsonObject[]).length, 1);
    const first = (await server.handlers.craft_experience_observe({ observation_id: "mcp-first", scenario_key: "mcp-flow", source_kind: "customer_execution", source_id: "one", source_digest: "sha256:one", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true })).observation as JsonObject;
    const second = (await server.handlers.craft_experience_observe({ observation_id: "mcp-second", scenario_key: "mcp-flow", source_kind: "customer_execution", source_id: "two", source_digest: "sha256:two", outcome: "failed", evidence_ids: ["confirmed"], sanitized: true })).observation as JsonObject;
    assert.equal(((await server.handlers.craft_experience_patterns_list({ scenario_key: "mcp-flow" })).observations as JsonObject[]).length, 2);
    const request = (await server.handlers.craft_experience_procedure_draft({ request_id: "mcp-request", scenario_key: "mcp-flow", observation_ids: [first.id, second.id], hypothesis: "preserve the observed verification sequence", design_axes: ["orchestration"], output_contract_ref: "contract:mcp-workflow" })).request as JsonObject;
    const ticket = (await server.handlers.craft_evaluation_model_ticket_issue({ ticket_id: "mcp-ticket", profile_id: profile.id, purpose: "workflow_evolution", workflow_evolution_request_id: request.id, input_ref: "external:batch", output_contract_ref: "contract:mcp-workflow" })).ticket as JsonObject;
    const pendingTickets = (await server.handlers.craft_evaluation_model_ticket_list({ purpose: "workflow_evolution" })).tickets as JsonObject[];
    assert.equal(pendingTickets.length, 1);
    assert.equal((pendingTickets[0]!.readiness as JsonObject).status, "needs_enablement");
    assert.throws(() => server.handlers.craft_evaluation_model_ticket_list({ purpose: "unsupported" }), /purpose is unsupported/u);
    assert.throws(() => server.handlers.craft_evaluation_model_ticket_list({ limit: 0 }), /limit/u);
    const submitted = await server.handlers.craft_experience_procedure_submit({ proposal_id: "mcp-proposal", request_id: request.id, model_ticket_id: ticket.id, workflow_id: "mcp-draft", name: "MCP draft", description: "A bounded draft from sanitized evidence.", inputs: [], steps: [{ type: "assertion" }] });
    assert.equal(((submitted.workflow as JsonObject).lifecycle), "draft");
    assert.equal(((await server.handlers.craft_evaluation_model_ticket_list({ purpose: "workflow_evolution" })).tickets as JsonObject[]).length, 0);
    assert.equal(((await server.handlers.craft_experience_procedure_get({ proposal_id: "mcp-proposal", request_id: request.id })).proposal as JsonObject).id, "mcp-proposal");
  } finally { await close(f); }
});

test("rejects malformed evolution inputs and keeps generated drafts, ticket checks, and request identity deterministic", async () => {
  const f = await fixture();
  try {
    const kernel = f.service.workflowEvolution;
    assert.throws(() => kernel.observe({ scenario_key: "", source_kind: "external", source_id: "one", source_digest: "d", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true }), /scenario_key/);
    assert.throws(() => kernel.observe({ scenario_key: "x", source_kind: "token=abcdefgh", source_id: "one", source_digest: "d", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true }), /credentials/);
    assert.throws(() => kernel.observe({ scenario_key: "x", source_kind: "external", source_id: "one", source_digest: "d", outcome: "passed", evidence_ids: "confirmed", sanitized: true }), /array/);
    assert.throws(() => kernel.observe({ scenario_key: "x", source_kind: "external", source_id: "one", source_digest: "d", outcome: "passed", evidence_ids: ["confirmed", "confirmed"], sanitized: true }), /unique/);
    const one = kernel.observe({ scenario_key: "generated", source_kind: "external", source_id: "one", source_digest: "one", outcome: "passed", failure_type: "none", evidence_ids: ["confirmed"], sanitized: true }).observation as JsonObject;
    const two = kernel.observe({ scenario_key: "generated", source_kind: "external", source_id: "two", source_digest: "two", outcome: "inconclusive", evidence_ids: ["confirmed"], sanitized: true }).observation as JsonObject;
    assert.match(String(one.id), /^workflow_evolution_observation_/);
    const request = kernel.propose({ scenario_key: "generated", hypothesis: "a bounded draft", design_axes: ["output"], output_contract_ref: "contract" }).request as JsonObject;
    assert.match(String(request.id), /^workflow_evolution_request_/);
    assert.throws(() => kernel.propose({ request_id: request.id, scenario_key: "generated", hypothesis: "changed", design_axes: ["output"], output_contract_ref: "contract" }), /idempotency/);
    f.store.save("workflow_evolution_observation", String(two.id), { ...two, lifecycle: "revoked" });
    assert.throws(() => kernel.propose({ scenario_key: "generated", observation_ids: [one.id, two.id], hypothesis: "mismatch", design_axes: ["output"], output_contract_ref: "contract" }), /do not match/);

    const freshTwo = kernel.observe({ scenario_key: "generated-two", source_kind: "external", source_id: "two", source_digest: "two", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true }).observation as JsonObject;
    const freshOne = kernel.observe({ scenario_key: "generated-two", source_kind: "external", source_id: "one", source_digest: "one", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true }).observation as JsonObject;
    const fresh = kernel.propose({ scenario_key: "generated-two", observation_ids: [freshOne.id, freshTwo.id], hypothesis: "write a generic draft", design_axes: ["output"], output_contract_ref: "contract" }).request as JsonObject;
    assert.throws(() => kernel.submit({ request_id: fresh.id, workflow_id: "bad", name: "Bad", description: "Bad", inputs: [], steps: [] }), /non-empty/);
    f.store.create("evaluation_model_ticket", "wrong-purpose", { purpose: "evaluation", target: { id: fresh.id, version: fresh.version } });
    assert.throws(() => kernel.submit({ request_id: fresh.id, model_ticket_id: "wrong-purpose", workflow_id: "bad", name: "Bad", description: "Bad", inputs: [], steps: [{ type: "assertion" }] }), /not a Workflow Evolution/);
    f.store.create("evaluation_model_ticket", "wrong-target", { purpose: "workflow_evolution", target: { id: "other", version: fresh.version } });
    assert.throws(() => kernel.submit({ request_id: fresh.id, model_ticket_id: "wrong-target", workflow_id: "bad", name: "Bad", description: "Bad", inputs: [], steps: [{ type: "assertion" }] }), /does not belong/);
    const draft = kernel.submit({ request_id: fresh.id, workflow_id: "generated-draft", name: "Generated", description: "Generated", inputs: [], steps: [{ id: "check", type: "assertion" }] });
    assert.match(String((draft.proposal as JsonObject).id), /^workflow_evolution_proposal_/);
    assert.equal(kernel.get({ proposal_id: (draft.proposal as JsonObject).id }).request, null);
    f.store.create("workflow_evolution_proposal", "wrong-prior", { request_id: "other" });
    assert.throws(() => kernel.submit({ proposal_id: "wrong-prior", request_id: fresh.id, workflow_id: "x", name: "x", description: "x", inputs: [], steps: [{ type: "assertion" }] }), /idempotency/);
    const thirdOne = kernel.observe({ scenario_key: "generated-three", source_kind: "external", source_id: "one", source_digest: "one", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true }).observation as JsonObject;
    const thirdTwo = kernel.observe({ scenario_key: "generated-three", source_kind: "external", source_id: "two", source_digest: "two", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true }).observation as JsonObject;
    const third = kernel.propose({ scenario_key: "generated-three", observation_ids: [thirdOne.id, thirdTwo.id], hypothesis: "another generic draft", design_axes: ["output"], output_contract_ref: "contract" }).request as JsonObject;
    assert.throws(() => kernel.submit({ request_id: third.id, workflow_id: "duplicate-inputs", name: "Duplicate", description: "Duplicate", inputs: ["x", "x"], steps: [{ type: "assertion" }] }), /unique values/);
    assert.match(String((kernel.submit({ request_id: third.id, workflow_id: "implicit-inputs", name: "Implicit", description: "Implicit", steps: [{ type: "assertion" }] }).proposal as JsonObject).id), /^workflow_evolution_proposal_/);
  } finally { await close(f); }
});

test("Workflow Evolution covers graph evidence, signature drift, and prompt-only draft fallbacks", async () => {
  const f = await fixture();
  try {
    const kernel = f.service.workflowEvolution;
    assert.throws(() => kernel.observe({ scenario_key: "bad-shape", source_kind: "external", source_id: "one", source_digest: "one", outcome: "passed", evidence_ids: ["confirmed"], execution_shape: ["unsupported"], sanitized: true }), /execution_shape/u);
    assert.throws(() => kernel.observe({ scenario_key: "bad-signature", source_kind: "external", source_id: "one", source_digest: "one", outcome: "passed", evidence_ids: ["confirmed"], scenario_signature: [] as never, sanitized: true }), /Signature/u);
    const first = kernel.observe({ observation_id: "signature-one", scenario_key: "signature", source_kind: "external", source_id: "one", source_digest: "one", outcome: "passed", evidence_ids: ["confirmed"], scenario_signature: { digest: "one" }, sanitized: true }).observation as JsonObject;
    const second = kernel.observe({ observation_id: "signature-two", scenario_key: "signature", source_kind: "external", source_id: "two", source_digest: "two", outcome: "passed", evidence_ids: ["confirmed"], scenario_signature: { digest: "two" }, sanitized: true }).observation as JsonObject;
    assert.throws(() => kernel.propose({ scenario_key: "signature", observation_ids: [first.id, second.id], hypothesis: "h", design_axes: ["tools"], output_contract_ref: "contract" }), /share a Scenario Signature/u);
    const graphOne = kernel.observe({ observation_id: "graph-one", scenario_key: "graph", source_kind: "external", source_id: "graph-one", source_digest: "one", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true }).observation as JsonObject;
    const graphTwo = kernel.observe({ observation_id: "graph-two", scenario_key: "graph", source_kind: "external", source_id: "graph-two", source_digest: "two", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true }).observation as JsonObject;
    assert.throws(() => kernel.propose({ scenario_key: "graph", observation_ids: [graphOne.id, graphTwo.id], hypothesis: "h", design_axes: ["tools"], procedure_kind: "graph", output_contract_ref: "contract" }), /Graph Procedure/u);
    const promptOne = kernel.observe({ observation_id: "prompt-one", scenario_key: "prompt", source_kind: "external", source_id: "prompt-one", source_digest: "one", outcome: "passed", evidence_ids: ["confirmed"], execution_shape: ["branch"], sanitized: true }).observation as JsonObject;
    const promptTwo = kernel.observe({ observation_id: "prompt-two", scenario_key: "prompt", source_kind: "external", source_id: "prompt-two", source_digest: "two", outcome: "passed", evidence_ids: ["confirmed"], execution_shape: ["branch"], sanitized: true }).observation as JsonObject;
    const promptRequest = kernel.propose({ request_id: "prompt-request", scenario_key: "prompt", observation_ids: [promptOne.id, promptTwo.id], hypothesis: "h", design_axes: ["output"], procedure_kind: "prompt", output_contract_ref: "contract" });
    assert.equal(promptRequest.next_action, "issue_a_model_ticket_or_submit_a_host_distilled_prompt_procedure");
    const proposal = kernel.submit({ request_id: "prompt-request", name: "Prompt", description: "Prompt fallback", inputs: [] }).proposal as JsonObject;
    assert.match(String(proposal.workflow_id), /^prompt_/u);
    assert.equal(proposal.prompt, "Prompt fallback");
    f.store.create("workflow_evolution_observation", "legacy-signature-one", { scenario_key: "legacy-signature", source: { kind: "external", id: "legacy-one", digest: "one" }, outcome: "passed", evidence_ids: ["confirmed"], lifecycle: "accepted" });
    f.store.create("workflow_evolution_observation", "legacy-signature-two", { scenario_key: "legacy-signature", source: { kind: "external", id: "legacy-two", digest: "two" }, outcome: "passed", evidence_ids: ["confirmed"], execution_shape: [], lifecycle: "accepted" });
    assert.equal(((kernel.propose({ scenario_key: "legacy-signature", hypothesis: "legacy", design_axes: ["tools"], output_contract_ref: "contract" }).request as JsonObject).scenario_signature as JsonObject).source, "legacy_scenario_key");
    assert.equal(((kernel.propose({ scenario_key: "legacy-signature", hypothesis: "legacy with explicit input", design_axes: ["tools"], output_contract_ref: "contract", scenario_signature: { digest: "explicit" } }).request as JsonObject).scenario_signature as JsonObject).digest, "explicit");
  } finally { await close(f); }
});
