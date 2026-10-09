import test from "node:test";
import assert from "node:assert/strict";
import { ContextHostEvaluation } from "../core/context-host-evaluation.ts";
import { fixture } from "./helpers/procedure-invocation-fixture.ts";
import { stableDigest } from "../core/digest.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { prepareContextEvaluationRun } from "./helpers/context-host-evaluation-fixture.ts";

const contractArgs = { host: "codex", host_id: "codex-cli", discovery_mode: "full_mcp", protocol_version: "2025-11-25", tool_schema_digest: "schema", definition_ids: ["open", "discover"], initial_ids: ["open", "discover"], host_fingerprint: "host", model_fingerprint: "model" };

async function setup() {
  const f = await fixture(), module = new ContextHostEvaluation(f.store);
  const contract = module.registerHost(contractArgs);
  const identity = f.service.scopeIdentityResolveProject({ project_root: f.root }).identity as any;
  f.store.create("evidence", "context-claim-evidence", { confidence: "confirmed", source_type: "human" });
  const claim = f.service.knowledgeClaimSave({ claim_id: "claim", kind: "fact", content: "fixture context", scope: `project:${identity.canonical_scope.id}`, evidence_ids: ["context-claim-evidence"] }).claim as any;
  f.service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "fixture", reason: "verified fixture" });
  const prepared = await prepareContextEvaluationRun(f.service, f.root, "host-eval-run");
  const args: JsonObject = { ...prepared, contract_id: contract.id, task_run_id: "host-eval-run" };
  assert.equal((prepared.task_run as any).task_id, undefined);
  assert.equal((prepared.task_run as any).scope, undefined);
  assert.equal((args.available_refs as string[]).length, 1);
  return { ...f, module, args };
}

test("Host matrix distinguishes full registration and conformed deferred discovery", async () => {
  const f = await setup();
  try {
    assert.equal(f.module.registerHost({ ...contractArgs, host_id: undefined }).host_id, "codex");
    const definitions = Array.from({ length: 1038 }, (_, i) => `tool-${i}`);
    const full = f.module.registerHost({ ...contractArgs, host_fingerprint: "full-product", definition_ids: definitions, initial_ids: definitions }); assert.equal((full.definition_ids as string[]).length, 1038);
    assert.throws(() => f.module.registerHost({ ...contractArgs, definition_ids: Array.from({ length: 4097 }, (_, i) => `tool-${i}`) }));
    for (const extra of [{ host: "unknown" }, { discovery_mode: "search" }, { initial_ids: [] }, { initial_ids: ["unknown"] }, { initial_ids: ["open"] }, { initial_ids: ["open", "open"] }, { definition_ids: "bad" }, { definition_ids: Array(1001).fill("x") }, { definition_ids: [1] }]) assert.throws(() => f.module.registerHost({ ...contractArgs, ...extra }));
    assert.throws(() => f.module.registerHost({ ...contractArgs, discovery_mode: "native_deferred" }), /conformance_evidence_id/);
    f.store.create("evidence", "wrong-conformance", { confidence: "bounded", source_type: "program", metadata: {} });
    assert.throws(() => f.module.registerHost({ ...contractArgs, discovery_mode: "native_deferred", conformance_evidence_id: "wrong-conformance" }), /conformance/);
    for (const [id, overrides] of [["source", { source_type: "human" }], ["mode", { metadata: { discovery_mode: "other" } }], ["host", { metadata: { discovery_mode: "native_deferred", host_fingerprint: "different" } }], ["schema", { metadata: { discovery_mode: "native_deferred", host_fingerprint: "host", tool_schema_digest: "wrong" } }]] as const) {
      f.store.create("evidence", id, { source_type: "program", confidence: "confirmed", metadata: {}, ...overrides });
      assert.throws(() => f.module.registerHost({ ...contractArgs, discovery_mode: "native_deferred", conformance_evidence_id: id }), /conformance/);
    }
    f.store.create("evidence", "conformed", { source_type: "program", confidence: "confirmed", metadata: { discovery_mode: "native_deferred", host_fingerprint: "host", tool_schema_digest: "schema" } });
    const deferred = f.module.registerHost({ ...contractArgs, host: "claude", discovery_mode: "native_deferred", initial_ids: ["discover"], conformance_evidence_id: "conformed", hook: true, precise_tokens: true });
    assert.equal(deferred.real_session_verified, false); assert.equal(f.module.matrix().model_effect_proven, false); assert.equal((f.module.matrix().contracts as unknown[]).length, 4);
  } finally { await f.close(); }
});

test("Host emissions bind real runtime identities, exact pack references and content-free measurements", async () => {
  const f = await setup();
  try {
    f.store.create("context_host_observation_pending", "host-eval-run", { status: "pending", contract_id: "wrong" });
    assert.throws(() => f.module.recordEmission(f.args), /Pending Host/);
    assert.equal(f.store.count("context_host_emission"), 0);
    f.store.save("context_host_observation_pending", "host-eval-run", { status: "pending", contract_id: f.args.contract_id });
    const emission = f.module.recordEmission(f.args);
    assert.equal((emission.metrics as any).cost_usd, null); assert.equal(emission.provenance, "host_reported"); assert.equal(emission.actual_model_use, "unknown"); assert.equal(emission.emission_content_verification, "host_reported_digest_only");
    assert.equal((f.module.recordEmission({ ...f.args, cost_usd: 0.01 }).metrics as any).cost_usd, 0.01);
    for (const extra of [{ scope: "project:other" }, { host_id: "other" }, { emitted_refs: ["other"] }, { available_refs: ["other"], available_refs_digest: stableDigest(["other"]) }, { available_refs_digest: "wrong" }, { injected_tokens: -1 }, { cost_usd: -1 }, { cost_usd: "1" }, { cost_usd: Infinity }]) assert.throws(() => f.module.recordEmission({ ...f.args, ...extra }));
    for (const [field, value] of [["task_id", "wrong"], ["model_fingerprint", "wrong"], ["capability_fingerprint", "wrong"]] as const) {
      const previous = f.store.get("host_session", "host-eval-run"); f.store.save("host_session", "host-eval-run", { ...previous, [field]: value }); assert.throws(() => f.module.recordEmission(f.args), /binding/); f.store.save("host_session", "host-eval-run", previous);
    }
    const run = f.store.get("task_run", "host-eval-run"), taskId = String((run.launch_identity as any).task_id);
    const task = f.store.get("task", taskId); f.store.save("task", taskId, { ...task, project_id: "wrong" }); assert.throws(() => f.module.recordEmission(f.args), /scope/);
    f.store.save("task", taskId, task);
    const pack = f.store.get("context_pack_receipt", String(f.args.receipt_id)); const ws = f.store.get("context_working_set_receipt", String(pack.working_set_id));
    for (const override of [{ task_id: "other-task" }, { session_id: "other-session" }]) { f.store.save("context_working_set_receipt", String(ws.id), { ...ws, ...override }); assert.throws(() => f.module.recordEmission(f.args), /task\/session/); }
    f.store.save("context_working_set_receipt", String(ws.id), ws);
    for (const override of [{ scope: { kind: "project", id: "other" } }, { asset_refs: [] }]) { f.store.save("context_working_set_receipt", String(ws.id), { ...ws, ...override }); assert.throws(() => f.module.recordEmission(f.args), /material binding/); }
    f.store.save("context_working_set_receipt", String(ws.id), ws);
    const originalRun = f.store.get("task_run", "host-eval-run"), controlId = String(originalRun.contract_id), launchId = String(originalRun.launch_id);
    const originalControl = f.store.get("task_control_contract", controlId), originalLaunch = f.store.get("work_launch", launchId);
    for (const override of [{ status: "paused" }, { launch_id: "other-launch" }, { task_id: "other-task" }, { workspace: "/other-root" }]) {
      const changed = f.store.save("task_control_contract", controlId, { ...originalControl, ...override }); f.store.save("task_run", "host-eval-run", { ...originalRun, contract_version: changed.version }); assert.throws(() => f.module.recordEmission(f.args), /binding changed/);
    }
    const restoredControl = f.store.save("task_control_contract", controlId, originalControl); f.store.save("task_run", "host-eval-run", { ...originalRun, contract_version: restoredControl.version });
    assert.throws(() => { f.store.save("task_run", "host-eval-run", { ...originalRun, contract_version: -1 }); f.module.recordEmission(f.args); }, /binding changed/);
    f.store.save("task_run", "host-eval-run", { ...originalRun, contract_version: restoredControl.version });
    for (const field of ["task_id", "host", "dispatch_id", "workspace", "prompt_digest"]) { f.store.save("task_run", "host-eval-run", { ...originalRun, contract_version: restoredControl.version, launch_identity: { ...(originalRun.launch_identity as any), [field]: "other" } }); assert.throws(() => f.module.recordEmission(f.args), /binding changed/); }
    f.store.save("task_run", "host-eval-run", { ...originalRun, contract_version: restoredControl.version });
    const session = f.store.get("host_session", "host-eval-run"); f.store.save("host_session", "host-eval-run", { ...session, host_id: "other" }); assert.throws(() => f.module.recordEmission({ ...f.args, host_id: "other" }), /Host session/); f.store.save("host_session", "host-eval-run", session);
    const otherContract = f.module.registerHost({ ...contractArgs, host_id: "different-contract-host" }); assert.throws(() => f.module.recordEmission({ ...f.args, contract_id: otherContract.id }), /Host session/);
    f.store.save("context_pack_receipt", String(pack.id), { ...pack, scope: { kind: "task", id: "other" } }); assert.throws(() => f.module.recordEmission({ ...f.args, scope: "task:other" }), /scope/);
    f.store.save("context_pack_receipt", String(pack.id), { ...pack, scope: { kind: "user", id: "other" } }); assert.throws(() => f.module.recordEmission({ ...f.args, scope: "user:other" }), /scope/);
    const taskContext = await f.service.contextWorkingSets.resolve({ query: "fixture", scope_kind: "task", scope_id: taskId, task_id: taskId, session_id: "host-eval-run", members: ["history"] });
    f.store.create("context_pack_receipt", "task-scope-pack", { working_set_id: (taskContext.working_set as any).id, scope: { kind: "task", id: taskId }, asset_refs: taskContext.asset_refs, identity_digest: "fixture-task-projection" });
    assert.equal(f.module.recordEmission({ ...f.args, receipt_id: "task-scope-pack", scope: `task:${taskId}`, available_refs: [], emitted_refs: [], available_refs_digest: stableDigest([]) }).task_id, taskId);
    f.store.save("context_pack_receipt", String(pack.id), pack);
    f.store.create("task_run", "forged-top-level", { task_id: taskId, scope: f.args.scope }); assert.throws(() => f.module.recordEmission({ ...f.args, task_run_id: "forged-top-level" }), /launch_identity/);
  } finally { await f.close(); }
});

test("Knowledge relevance and citation support remain separate measured contracts", async () => {
  const f = await setup();
  try {
    const emission = f.module.recordEmission(f.args), ref = (f.args.available_refs as string[])[0]!;
    const args = { emission_id: emission.id, expected_relevant_refs: [ref], retrieved_refs: [ref], citation_judgements: [] };
    assert.equal((f.module.evaluateKnowledge(args).support as any).accuracy, null);
    assert.equal((f.module.evaluateKnowledge({ ...args, expected_relevant_refs: [], retrieved_refs: [] }).retrieval as any).recall, 1);
    assert.equal((f.module.evaluateKnowledge({ ...args, expected_relevant_refs: [], retrieved_refs: [ref] }).retrieval as any).recall, 0);
    assert.equal((f.module.evaluateKnowledge({ ...args, retrieved_refs: [] }).retrieval as any).precision, 0);
    f.store.create("evidence", "citation-proof", { confidence: "confirmed", source_type: "program", metadata: { emission_id: emission.id, claim_digest: "answer-claim", reference: ref, supported: false } });
    const judgement = { ref, claim_digest: "answer-claim", supported: false, evidence_id: "citation-proof" };
    const assessment = f.module.evaluateKnowledge({ ...args, citation_judgements: [judgement] });
    assert.equal((assessment.retrieval as any).recall, 1); assert.equal((assessment.support as any).accuracy, 0); assert.equal(assessment.changes_claim_status, false);
    f.store.create("evidence", "positive-proof", { confidence: "confirmed", source_type: "program", metadata: { emission_id: emission.id, claim_digest: "positive", reference: ref, supported: true } });
    assert.equal((f.module.evaluateKnowledge({ ...args, citation_judgements: [{ ref, claim_digest: "positive", supported: true, evidence_id: "positive-proof" }] }).support as any).accuracy, 1);
    for (const extra of [{ retrieved_refs: ["other"] }, { citation_judgements: null }, { citation_judgements: Array(1001).fill({}) }, { citation_judgements: [{ ...judgement, ref: "other" }] }, { citation_judgements: [{ ...judgement, supported: "false" }] }, { citation_judgements: [{ ...judgement, claim_digest: "wrong" }] }]) assert.throws(() => f.module.evaluateKnowledge({ ...args, ...extra }));
    f.store.create("evidence", "human-label", { confidence: "confirmed", source_type: "human", metadata: { emission_id: emission.id, claim_digest: "human", reference: ref, supported: true, reviewer: "annotator" } });
    const human = { ref, claim_digest: "human", supported: true, evidence_id: "human-label" };
    assert.equal(f.module.evaluateKnowledge({ ...args, citation_judgements: [human] }).support_truth_proven, false);
    f.store.create("evidence", "anonymous-label", { confidence: "confirmed", source_type: "human", metadata: { emission_id: emission.id, claim_digest: "human", reference: ref, supported: true } }); assert.throws(() => f.module.evaluateKnowledge({ ...args, citation_judgements: [{ ...human, evidence_id: "anonymous-label" }] }), /reviewer/);
    const original = f.store.get("evidence", "citation-proof");
    for (const override of [{ confidence: "bounded" }, { source_type: "unsupported" }, { metadata: { emission_id: "wrong" } }, { metadata: { emission_id: emission.id, claim_digest: "answer-claim", reference: "wrong" } }, { metadata: { emission_id: emission.id, claim_digest: "answer-claim", reference: ref, supported: true } }]) {
      f.store.save("evidence", "citation-proof", { ...original, ...override }); assert.throws(() => f.module.evaluateKnowledge({ ...args, citation_judgements: [judgement] }), /binding/);
    }
  } finally { await f.close(); }
});

test("Graph improvements attribute public failures and save only a reviewed draft", async () => {
  const f = await setup();
  try {
    const configuration = { definition: { nodes: [] } };
    f.store.create("experience_procedure", "product-development", { scope: "project:fixture" });
    f.store.create("procedure_invocation_receipt", "failed-receipt", { invocation_id: "invocation", output_refs: { test: "public-output" } });
    f.store.create("procedure_invocation_outcome", "failed-outcome", { scope: "project:fixture", status: "failed", invocation_id: "invocation", receipt_id: "failed-receipt", procedure_id: "product-development", procedure_version: 1, definition_digest: "graph", call_path: "root/review", failure_stage: "review-step", evidence_ids: ["confirmed-output"] });
    const args = { outcome_id: "failed-outcome", scope: "project:fixture", configuration };
    const proposal = f.module.proposeGraphImprovement(args); assert.equal(proposal.promotion_automatic, false); assert.equal(proposal.node_path, "root/review");
    assert.equal(f.module.proposeGraphImprovement({ ...args, graph_id: "product-development" }).id, proposal.id);
    assert.throws(() => f.module.proposeGraphImprovement({ ...args, graph_id: "other" }));
    f.store.save("experience_procedure", "product-development", { scope: "project:other" }); assert.throws(() => f.module.proposeGraphImprovement(args));
    f.store.save("experience_procedure", "product-development", { scope: "project:fixture", scope_envelope: { audience: { mode: "private", principal_ids: ["owner"] } } }); assert.throws(() => f.module.proposeGraphImprovement(args));
    f.store.save("experience_procedure", "product-development", { scope: "project:fixture" });
    assert.throws(() => f.module.proposeGraphImprovement({ ...args, scope: "other" }));
    const outcome = f.store.get("procedure_invocation_outcome", "failed-outcome");
    f.store.save("procedure_invocation_outcome", "failed-outcome", { ...outcome, status: "passed" }); assert.throws(() => f.module.proposeGraphImprovement(args));
    f.store.save("procedure_invocation_outcome", "failed-outcome", { ...outcome, failure_stage: null }); assert.throws(() => f.module.proposeGraphImprovement(args));
    f.store.save("procedure_invocation_outcome", "failed-outcome", outcome);
    f.store.save("procedure_invocation_receipt", "failed-receipt", { invocation_id: "wrong" }); assert.throws(() => f.module.proposeGraphImprovement(args));
    const submit = { proposal_id: proposal.id, scope: "project:fixture", expected_proposal_digest: proposal.proposal_digest, reviewer: "human", expected_version: 1 };
    const port = { inspect() { return { draft: configuration, draft_digest: "draft" }; }, edit(input: any) { assert.equal(input.action, "save"); assert.equal(input.graph_id, "product-development"); assert.deepEqual(input.configuration, configuration); return { draft_digest: "draft" }; } };
    assert.equal(f.module.submitGraphImprovement(submit, port).status, "draft_saved");
    assert.throws(() => f.module.submitGraphImprovement({ ...submit, action: "other" }, port));
    assert.throws(() => f.module.submitGraphImprovement({ ...submit, action: "submit" }, port));
    for (const read of [{ draft: configuration, draft_digest: "other" }, { draft: { ...configuration, title: "different" }, draft_digest: "draft" }, { draft: { ...configuration, procedure_kind: "workflow", scenario_id: "different" }, draft_digest: "draft" }, { draft: {}, draft_digest: "draft" }, { draft: { ...configuration, procedure_kind: "workflow" }, draft_digest: "draft" }]) assert.throws(() => f.module.submitGraphImprovement({ ...submit, action: "submit", expected_draft_digest: "draft" }, { ...port, inspect() { return read; } }), /no longer matches/);
    assert.equal(f.module.submitGraphImprovement({ ...submit, action: "submit", expected_draft_digest: "draft" }, { inspect() { return { draft: configuration, draft_digest: "draft" }; }, edit(input) { assert.equal(input.action, "submit"); return { lifecycle: "candidate" }; } }).status, "candidate_submitted");
    for (const extra of [{ scope: "other" }, { expected_proposal_digest: "wrong" }, { reviewer: "" }]) assert.throws(() => f.module.submitGraphImprovement({ ...submit, ...extra }, port));
    f.store.save("experience_improvement_proposal", String(proposal.id), { ...proposal, status: "rejected" }); assert.throws(() => f.module.submitGraphImprovement(submit, port));
    const cases = [{ scenario_id: "review", host_fingerprint: "codex", model_fingerprint: "model", expected_applicable: true, actual_applicable: true }, { scenario_id: "billing", host_fingerprint: "claude", model_fingerprint: "other-model", expected_applicable: false, actual_applicable: true }, { scenario_id: "outside", host_fingerprint: "dsh", model_fingerprint: "model", expected_applicable: false, actual_applicable: false }];
    const assessment = f.module.evaluateApplicability({ cases }); assert.equal(assessment.false_activation_count, 1); assert.equal(assessment.task_outcome_proven, false);
    for (const value of [null, [], Array(101).fill({}), [{ ...cases[0], expected_applicable: "true" }], [{ ...cases[0], actual_applicable: "true" }]]) assert.throws(() => f.module.evaluateApplicability({ cases: value }));
  } finally { await f.close(); }
});

test("existing Knowledge and Graph MCP tools expose evaluations without expanding tool count", async () => {
  const { McpServer } = await import("../core/mcp.ts");
  const f = await setup();
  try {
    const mcp = new McpServer(f.service, "full");
    const emission = f.module.recordEmission(f.args);
    const assessment = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_knowledge_evaluation_run", arguments: { mode: "citation_support", emission_id: emission.id, expected_relevant_refs: [], retrieved_refs: [], citation_judgements: [] } } });
    assert.equal((assessment!.result as any).isError, false);
    const draft = f.service.experienceGraphEdit({ action: "save", graph_id: "product-development", scope: "project:fixture", template_id: "internet-product-engineering" });
    f.service.experienceGraphEdit({ action: "submit", graph_id: "product-development", scope: "project:fixture", expected_draft_digest: draft.draft_digest });
    const cases = [{ query: "zznomatchzz", scenario_id: "outside", host_fingerprint: "codex", model_fingerprint: "model", expected_applicable: false, input_keys: [] }];
    const match = await mcp.handle({ id: 2, method: "tools/call", params: { name: "craft_experience_graph_inspect", arguments: { action: "evaluate_applicability", graph_id: "product-development", scope: "project:fixture", release_channel: "test", cases } } });
    assert.equal((match!.result as any).isError, false);
    assert.equal(f.service.experienceGraphInspect({ action: "evaluate_applicability", graph_id: "product-development", scope: "project:fixture", release_channel: "test", cases }).provenance, "runtime_graph_match");
    for (const cases of [null, [], Array(101).fill({})]) assert.throws(() => f.module.evaluateGraphApplicability({ cases }, () => ({})));
    const direct = f.module.evaluateGraphApplicability({ cases: [{ ...cases[0], expected_applicable: true }] }, () => ({ routes: [{ subscenario_id: "different", ready_to_plan: true }, { subscenario_id: "outside", ready_to_plan: false }, { subscenario_id: "outside", ready_to_plan: true }], procedure_version: 1, definition_digest: "graph" }));
    assert.equal(direct.applicability_accuracy, 1);
    const config = (f.service.experienceGraphInspect({ action: "template" }).configuration as any);
    f.store.create("procedure_invocation_receipt", "integration-receipt", { invocation_id: "integration", output_refs: {} });
    f.store.create("procedure_invocation_outcome", "integration-outcome", { invocation_id: "integration", receipt_id: "integration-receipt", scope: "project:fixture", status: "failed", failure_stage: "root/review", call_path: "root/review", procedure_id: "product-development", procedure_version: 1, definition_digest: "fixture", evidence_ids: [] });
    const proposalArgs = { action: "improvement_propose", graph_id: "product-development", scope: "project:fixture", outcome_id: "integration-outcome", configuration: { ...config, title: "Reviewed improvement" } };
    assert.equal(((await mcp.handle({ id: 3, method: "tools/call", params: { name: "craft_experience_graph_edit", arguments: proposalArgs } }))!.result as any).isError, false);
    const proposal = f.service.experienceGraphEdit(proposalArgs);
    const current = f.store.get("experience_procedure", "product-development");
    const saved = f.service.experienceGraphEdit({ action: "improvement_save", graph_id: current.id, scope: "project:fixture", proposal_id: proposal.id, expected_proposal_digest: proposal.proposal_digest, reviewer: "fixture-reviewer", expected_version: current.version, expected_draft_digest: draft.draft_digest });
    assert.equal(saved.status, "draft_saved");
    const submitted = f.service.experienceGraphEdit({ action: "improvement_submit", graph_id: current.id, scope: "project:fixture", proposal_id: proposal.id, expected_proposal_digest: proposal.proposal_digest, reviewer: "fixture-reviewer", expected_draft_digest: (saved.draft as any).draft_digest });
    assert.equal(submitted.status, "candidate_submitted");
  } finally { await f.close(); }
});
