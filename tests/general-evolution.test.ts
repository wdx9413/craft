import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SelfEvolutionKernel } from "@craft/capability-context";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { stableDigest } from "../core/digest.ts";
import { projectExperienceDirectory } from "../core/project-experience-directory.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-general-evolution-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, kernel: new SelfEvolutionKernel(store) };
}

test("domain adapters register deterministically and candidate adapters stay candidates", async () => {
  const f = await fixture();
  try {
    f.kernel.ensureAdapters();
    const first = f.kernel.ensureAdapters();
    assert.equal((first.items as unknown[]).length, 5);
    const candidate = f.kernel.registerAdapter({ name: "coding", version: "v2", extraction_patterns: ["repo"], value_threshold: 3 }) as Record<string, unknown>;
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.value_threshold, 3);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("program memory cannot qualify from repeated capture of an unverified evidence reference", async () => {
  const f = await fixture();
  try {
    f.kernel.ensureAdapters();
    const scope = { kind: "project", id: "project:demo" };
    const first = f.kernel.captureProgramMemory({ statement: "先打开页面再点击登录", domain: "office", scope }) as Record<string, unknown>;
    assert.equal(first.status, "diagnostic");
    f.store.create("evidence", "obs1", { source_type: "test", claim: "observed login flow", confidence: "bounded" });
    f.kernel.captureProgramMemory({ statement: "先打开页面再点击登录", domain: "office", scope, evidence_ids: ["obs1"] });
    assert.throws(() => f.kernel.submitProgramMemory(String(first.id), scope), /contract|independent/i);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("program memory submits an exact Experience candidate and blocks substitute evaluation and post-revocation gates", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const scope = { kind: "project", id: "project:demo" };
    for (const id of [scope.id, "project:foreign"]) {
      const projectRoot = join(f.root, id.slice("project:".length));
      await mkdir(projectRoot);
      f.store.create("scope_alias", `alias-${id}`, { status: "active", alias_kind: "path", alias: projectRoot,
        alias_digest: stableDigest(projectRoot), scope: { ...scope, id } });
      projectExperienceDirectory(f.store, id, projectRoot, true);
    }
    const design = service.evaluationContractDefine({ contract_id: "memory-design", capability_id: "verify-project-operating-procedure",
      capability_version: 1, input_contract: "project-scoped observation", output_contract: "accepted procedure",
      scope, effect: "program_memory_design", budget: { program_memory_workflow: { steps: [{ id: "observe", type: "assertion", evaluator: "file_exists", path: "package.json", expected: true, side_effect: "read_only" }] }, task_effect_design: { candidate_family: "experience_procedure" } } }).contract as JsonObject;
    const observation = (sourceId: string, sessionId: string, project: string) => {
      const evidence = service.evidenceRecord({ source_type: "host_completion_signal", confidence: "bounded", claim: "Verified task",
        metadata: { provenance: "host_completion_signal", project_scope_id: project, verification_outcome: "passed",
          source_session_id: sessionId, task_id: sourceId, content_stored: false } });
      const result = service.workflowEvolutionObserve({ sanitized: true, content_stored: false, outcome: "passed",
        source_kind: "host:codex", source_id: sourceId, source_session_id: sessionId, source_digest: sourceId,
        scope: project, scenario_key: "verified-release", scenario_signature: { scenario_key: "verified-release", project: { id: project } }, evidence_ids: [evidence.id] }).observation as JsonObject;
      f.store.create("program_memory_verified_observation", String(result.id), { scope: { ...scope, id: project }, evidence_id: evidence.id,
        source_digest: sourceId, source_session_id: sessionId, task_id: sourceId });
      return result;
    };
    const a = observation("task-a", "session-a", scope.id);
    const duplicate = observation("task-a2", "session-a", scope.id);
    const foreign = observation("task-foreign", "session-foreign", "project:foreign");
    const b = observation("task-b", "session-b", scope.id);
    const input = { statement: "Verify the release checklist", scenario_key: "verified-release", domain: "coding",
      scope, evaluation_contract_id: design.id };
    const diagnostic = service.evolutionProgramMemoryCapture({ ...input, evaluation_contract_id: undefined, evidence_ids: [a.id] });
    const candidate = service.evolutionProgramMemoryCapture({ ...input, evidence_ids: [a.id, duplicate.id, foreign.id] });
    assert.notEqual(candidate.id, diagnostic.id);
    assert.equal((candidate.source_refs as JsonObject[]).some(ref => ref.id === diagnostic.id), true);
    assert.equal(service.evolutionProgramMemoryGet({ id: diagnostic.id, scope }).candidate !== undefined, true);
    assert.equal(candidate.independent_evidence_count, 1);
    const waiting = service.evolutionProgramMemorySubmissionDue({ scope }).items as JsonObject[];
    assert.equal(waiting.find(item => item.id === diagnostic.id)?.reason, "waiting_evaluation_design");
    assert.equal(waiting.find(item => item.id === candidate.id)?.reason, "waiting_independent_observations");
    assert.equal(service.evolutionProgramMemoryCapture({ ...input, evidence_ids: [a.id] }).version, candidate.version);
    const request = { id: candidate.id, scope };
    assert.throws(() => service.evolutionProgramMemorySubmit(request), /independent/);
    assert.equal(service.evolutionProgramMemoryCapture({ ...input, evidence_ids: [b.id] }).independent_evidence_count, 2);
    const frozenSubmissionPlan = service.evolutionProgramMemoryPrepareSubmission(request);
    const submitted = service.evolutionProgramMemorySubmit(request);
    assert.equal(submitted.status, "submitted");
    const ownerReceipt = { request_id: submitted.request_id, procedure_id: submitted.procedure_id, procedure_candidate_version: submitted.procedure_candidate_version };
    assert.throws(() => service.evolutionProgramMemoryCommitSubmission(frozenSubmissionPlan, { ...ownerReceipt, procedure_candidate_version: 999 }), /receipt conflict/);
    assert.throws(() => service.evolutionProgramMemoryCommitSubmission(frozenSubmissionPlan, { ...ownerReceipt, procedure_id: "foreign" }), /identity mismatch/);
    assert.throws(() => service.evolutionProgramMemoryCommitSubmission({ ...frozenSubmissionPlan, candidate: { ...(frozenSubmissionPlan.candidate as JsonObject), digest: "changed" } }, ownerReceipt), /changed/);

    const proposal = f.store.list("workflow_evolution_proposal", 100).find(item => item.request_id === submitted.request_id)!;
    assert.equal((proposal.steps as JsonObject[])[0]!.type, "assertion");
    assert.equal(service.evolutionProgramMemorySubmit(request).procedure_id, submitted.procedure_id);
    assert.throws(() => service.evolutionProgramMemoryPromote({ ...request, evaluation_ref: "unverified" }), /qualified/);

    const evaluation = service.evaluationContractDefine({ contract_id: "unrelated", capability_id: "unrelated",
      capability_version: 1, input_contract: "unrelated", output_contract: "unrelated", scope }).contract as JsonObject;
    const procedure = service.experienceProcedureGet({ procedure_id: submitted.procedure_id }).procedure as JsonObject;
    const stageProof = service.evidenceRecord({ source_type: "program", claim: "Verified procedure entry and exit", confidence: "confirmed",
      metadata: { procedure_definition_digest: procedure.definition_digest, entry_id: "inspect", exit_id: "verified", stage: "shadow", status: "passed" } });
    const gate = { procedure_id: submitted.procedure_id, passed: true, evidence_ids: [stageProof.id] };
    service.experienceProcedureGate({ ...gate, stage: "shadow" });
    assert.throws(() => service.experienceProcedureGate({ ...gate, stage: "held_out", evaluation_contract_id: evaluation.id,
      evaluation_id: "unverified" }), /frozen Program Memory design/);
    assert.equal(service.evolutionProgramMemoryFeedback({ ...request, outcome: "revoked" }).status, "revoked");
    assert.throws(() => service.experienceProcedureGate({ ...gate, stage: "shadow" }), /no longer authorizes/);
    assert.throws(() => service.evolutionProgramMemoryCommitSubmission(frozenSubmissionPlan, ownerReceipt), /changed/);
    assert.equal((service.evolutionProgramMemoryGet(request).candidate as JsonObject).status, "revoked", "a delayed submission commit must not resurrect a revoked candidate");

  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("artifact lineage stores metadata and recalls by artifact type with reliability floor", async () => {
  const f = await fixture();
  try {
    const scope = { kind: "project", id: "project:office" };
    f.kernel.recordArtifactLineage({ artifact_type: "slides", source_refs: ["doc1"], prompt: "make a deck", parameters: { theme: "dark" }, tool: "slides", reliability: 0.9, user_choice: "accepted", scope });
    f.kernel.recordArtifactLineage({ artifact_type: "slides", source_refs: ["doc2"], reliability: 0.2, scope });
    const recalled = f.kernel.recallArtifactLineage({ artifact_type: "slides", scope }) as { items: unknown[] };
    assert.equal(recalled.items.length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("prospective intention records trigger outcomes and research links are typed", async () => {
  const f = await fixture();
  try {
    const scope = { kind: "project", id: "project:office" };
    const other = { kind: "project", id: "project:other" };
    const intention = f.kernel.createProspectiveIntention({ intention: "提醒我提交报告", trigger: { state: "report-ready" },
      scope, expires_at: "2099-01-01T00:00:00.000Z" });
    assert.throws(() => f.kernel.fireProspectiveIntention({ id: intention.id, trigger: { state: "report-ready" }, scope: other }), /not in scope/u);
    const miss = f.kernel.fireProspectiveIntention({ id: intention.id, trigger: { state: "draft" }, scope });
    assert.equal(miss.status, "pending");
    const hit = f.kernel.fireProspectiveIntention({ id: intention.id, trigger: { state: "report-ready" }, scope });
    assert.equal(hit.status, "awaiting_host");
    assert.deepEqual(hit.receipt, { matched: true, at: (hit.receipt as Record<string, unknown>).at, action_authorized: false });
    const link = f.kernel.linkResearch({ source_id: "paper1", target_id: "exp1", relation: "derives_from", layer: "interpretation" }) as Record<string, unknown>;
    assert.equal(link.relation, "derives_from");
    assert.equal(link.layer, "interpretation");
    assert.throws(() => f.kernel.linkResearch({ source_id: "a", target_id: "b", relation: "likes" }), /unsupported/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("general fallback captures long-tail work without any matching adapter", async () => {
  const f = await fixture();
  try {
    // Long-tail work with no named-adapter signal must still be captured.
    const prd = f.kernel.captureDomainStatement({ statement: "上线前必须完成灰度评审并记录结论", scope: { kind: "project", id: "project:x" } }) as Record<string, unknown>;
    assert.equal(prd.status, "candidate");
    assert.equal(prd.adapter_match, false, "no adapter matched, yet the statement is still captured");
    assert.equal(prd.domain, "general");

    const consoleOp = f.kernel.captureDomainStatement({ statement: "先选部门，再提交表单", scope: { kind: "project", id: "project:x" } }) as Record<string, unknown>;
    assert.equal(consoleOp.status, "candidate");
    assert.equal(consoleOp.domain, "general");

    const items = (f.kernel.listProgramMemory({ scope: { kind: "project", id: "project:x" } }) as { items: Record<string, unknown>[] }).items;
    assert.ok(items.some((item) => item.domain === "general"), "general candidates are persisted");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an unknown or mismatched adapter hint degrades to general instead of dropping", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.kernel.captureDomainStatement({ domain: "legal", statement: "x" }), /unsupported domain adapter/u);
    const mismatched = f.kernel.captureDomainStatement({ domain: "travel", statement: "产品需求文档约定：上线前必须评审",
      scope: { kind: "project", id: "project:x" } }) as Record<string, unknown>;
    assert.equal(mismatched.status, "candidate");
    assert.equal(mismatched.domain, "general");
    assert.equal(mismatched.adapter_match, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
