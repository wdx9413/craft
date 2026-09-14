import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvaluationModelProfileKernel } from "../src/evaluation-model-profile.ts";
import { McpServer, surfaceToolNames } from "../src/mcp.ts";
import { PROVIDER_CATALOG } from "../src/model-gateway.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v01224-")); const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store); const evidence = service.evidenceRecord({ evidence_id: "confirmed", source_type: "program", confidence: "confirmed", claim: "sanitized outcome observed" });
  return { root, store, service, evidence };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
function observation(service: CraftService, id: string, sourceId: string, outcome: string = "passed") {
  return service.workflowEvolutionObserve({ observation_id: id, scenario_key: "support-refund", source_kind: "external_execution", source_id: sourceId, source_digest: `sha256:${sourceId}`, outcome, evidence_ids: ["confirmed"], sanitized: true, content_stored: false }).observation as JsonObject;
}

test("v0.12.24 reserves a secret-free model profile and fails closed until explicit enablement and credentials", async () => {
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

test("v0.12.24 evolves only independent sanitized evidence into a new draft Workflow and never publishes it", async () => {
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
    assert.throws(() => f.service.workflowEvolutionProposalSubmit({ request_id: request.id, workflow_id: "again", name: "Again", description: "again", inputs: [], steps: [{ type: "assertion" }] }), /no longer awaiting/);
    assert.equal((f.service.workflowEvolutionProposalGet({ proposal_id: "draft", request_id: request.id }).request as JsonObject).id, request.id);
    assert.equal((f.service.workflowEvolutionObservations({}).observations as JsonObject[]).length, 3);
  } finally { await close(f); }
});

test("v0.12.24 exposes a bounded Workflow Evolution plugin surface and keeps it separate from discovery and work execution", async () => {
  const f = await fixture();
  try {
    const surface = "component-workflow-evolution"; const names = surfaceToolNames(surface);
    assert(names.includes("craft_workflow_evolution_observe")); assert(names.includes("craft_evaluation_model_profile_save"));
    assert(!names.includes("craft_capability_search")); assert(!names.includes("craft_verified_work_loop_prepare"));
    const server = new McpServer(f.service, surface);
    const response = await server.handle({ id: "observe", method: "tools/call", params: { name: "craft_workflow_evolution_observe", arguments: { observation_id: "mcp", scenario_key: "mcp", source_kind: "external", source_id: "one", source_digest: "sha256:one", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true } } });
    assert.equal((response?.result as JsonObject).isError, false);
    const blocked = await server.handle({ id: "blocked", method: "tools/call", params: { name: "craft_capability_search", arguments: { query: "x" } } });
    assert.equal((blocked?.error as JsonObject).code, -32602);
  } finally { await close(f); }
});

test("v0.12.24 routes every reserved model and Workflow-evolution operation through the component MCP surface", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(f.service, "component-workflow-evolution");
    const profile = (await server.handlers.craft_evaluation_model_profile_save({ profile_id: "mcp-profile", provider: "qwen", model: "qwen-plus", purposes: ["workflow_evolution"] })).profile as JsonObject;
    assert.equal(((await server.handlers.craft_evaluation_model_profile_get({ profile_id: profile.id })).profile as JsonObject).id, profile.id);
    assert.equal(((await server.handlers.craft_evaluation_model_profile_list({ limit: 1 })).profiles as JsonObject[]).length, 1);
    const first = (await server.handlers.craft_workflow_evolution_observe({ observation_id: "mcp-first", scenario_key: "mcp-flow", source_kind: "customer_execution", source_id: "one", source_digest: "sha256:one", outcome: "passed", evidence_ids: ["confirmed"], sanitized: true })).observation as JsonObject;
    const second = (await server.handlers.craft_workflow_evolution_observe({ observation_id: "mcp-second", scenario_key: "mcp-flow", source_kind: "customer_execution", source_id: "two", source_digest: "sha256:two", outcome: "failed", evidence_ids: ["confirmed"], sanitized: true })).observation as JsonObject;
    assert.equal(((await server.handlers.craft_workflow_evolution_observations({ scenario_key: "mcp-flow" })).observations as JsonObject[]).length, 2);
    const request = (await server.handlers.craft_workflow_evolution_propose({ request_id: "mcp-request", scenario_key: "mcp-flow", observation_ids: [first.id, second.id], hypothesis: "preserve the observed verification sequence", design_axes: ["orchestration"], output_contract_ref: "contract:mcp-workflow" })).request as JsonObject;
    const ticket = (await server.handlers.craft_evaluation_model_ticket_issue({ ticket_id: "mcp-ticket", profile_id: profile.id, purpose: "workflow_evolution", workflow_evolution_request_id: request.id, input_ref: "external:batch", output_contract_ref: "contract:mcp-workflow" })).ticket as JsonObject;
    const submitted = await server.handlers.craft_workflow_evolution_proposal_submit({ proposal_id: "mcp-proposal", request_id: request.id, model_ticket_id: ticket.id, workflow_id: "mcp-draft", name: "MCP draft", description: "A bounded draft from sanitized evidence.", inputs: [], steps: [{ type: "assertion" }] });
    assert.equal(((submitted.workflow as JsonObject).lifecycle), "draft");
    assert.equal(((await server.handlers.craft_workflow_evolution_proposal_get({ proposal_id: "mcp-proposal", request_id: request.id })).proposal as JsonObject).id, "mcp-proposal");
  } finally { await close(f); }
});

test("v0.12.24 rejects malformed evolution inputs and keeps generated drafts, ticket checks, and request identity deterministic", async () => {
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
