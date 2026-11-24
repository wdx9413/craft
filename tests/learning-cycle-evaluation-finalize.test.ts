import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { openMcpRuntime } from "../core/interfaces/mcp/runtime.ts";
import { CraftService } from "../core/application/craft-service.ts";
import { WorkbenchEvaluations } from "../core/workbench-evaluations.ts";
import { reconcileCodexSessionTaskEvidence, resolveCodexHostEvidenceArchive, resolveCodexHostEvidenceRecord, runCodexSessionCollectionOnce } from "../core/codex-session-archive.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

const delay = (milliseconds: number) => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

test("a controlled passing report writes task evidence; a failed report creates no successful learning record", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-learning-eval-finalize-"));
  const codexHome = await mkdtemp(join(tmpdir(), "craft-learning-eval-codex-"));
  const project = await mkdtemp(join(tmpdir(), "craft-learning-eval-project-"));
  execFileSync("git", ["init", "--quiet", project]);
  const sessions = join(codexHome, "sessions", "2026", "11"), sessionFile = join(sessions, "session.jsonl");
  await mkdir(sessions, { recursive: true });
  const hostEnv = { ...process.env, CRAFT_DATA_DIR: root, CODEX_HOME: codexHome };
  const runtime = await openMcpRuntime("component-context-agent", hostEnv);
  const service = runtime.server.service;
  const evalOwner = service.ownerServices.get("eval");
  const experienceOwner = service.ownerServices.get("experience");
  assert(evalOwner && experienceOwner, "the composed Context runtime must route Eval and Experience owners");
  const defaultRuntimeService = await CraftService.open(experienceOwner.store);
  assert.equal(defaultRuntimeService.serviceEnvironment, process.env, "direct CraftService.open uses its process environment by default");
  const evaluations = new WorkbenchEvaluations(evalOwner.store);
  const suite = join(root, "suite.json"), subject = join(root, "subject.json"), evalRuntime = join(root, "runtime.json");
  await writeFile(subject, JSON.stringify({ kind: "software", id: "learning-subject", version: "1" }));
  await writeFile(evalRuntime, JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "fixed"]))) );
  try {
    const sessionId = "learning-evaluation-session", turnId = "learning-evaluation-turn";
    const context = await service.contextOpen({ project_root: project, query: "修复模块并运行验证", include_codebase: false,
      task_id: "learning-task", session_id: sessionId, turn_id: turnId, session_host: "codex", members: ["experience"], max_tokens: 5000 });
    const packReceipt = context.pack_receipt as JsonObject;
    const receiptId = String(packReceipt.context_receipt_id);
    const receipt = service.store.find("context_resolution_receipt", receiptId)!;
    const verificationRef = "test-run:host-terminal";
    const hostCompletion = service.learningCycleFinalize({ host: "codex", task_id: String(receipt.task_id ?? "learning-task"), turn_id: turnId,
      session_id: sessionId, context_receipt_id: receiptId, verified: true, verification_outcome: "passed", verification_ref: verificationRef,
      project_root: project, scenario_key: "engineering.controlled-evaluation",
      scenario_definition: { summary: "Run a controlled task evaluation", applies_when: "A completed task has a reproducible held-out test", excludes: "Unverified or diagnostic-only work" } });
    const hostEvidence = hostCompletion.evidence as JsonObject;
    assert.equal(hostEvidence.source_type, "host_completion_signal");
    assert.equal(((hostCompletion.observation as JsonObject).scenario_signature as JsonObject).scenario_key, "engineering.controlled-evaluation");
    const line = (type: string, payload: JsonObject) => JSON.stringify({ type, payload });
    await writeFile(sessionFile, [
      line("session_meta", { session_id: sessionId, cwd: project }),
      line("event_msg", { type: "task_started", turn_id: turnId, started_at: "2026-11-24T00:00:00.000Z" }),
      line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "修复模块并运行验证" }] }),
      line("response_item", { type: "custom_tool_call", name: "terminal" }),
      line("response_item", { type: "custom_tool_call_output", output: "tests passed" }),
      line("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "已完成修复和验证" }] }),
      line("event_msg", { type: "task_complete", turn_id: turnId, completed_at: "2026-11-24T00:01:00.000Z" }),
    ].join("\n") + "\n");
    const archiveOptions = { sessions_root: join(codexHome, "sessions"), state_file: join(root, "runtime", "codex-session-collection.json") };
    await runCodexSessionCollectionOnce(archiveOptions, hostEnv);
    const metadata = hostEvidence.metadata as JsonObject;
    const archived = await reconcileCodexSessionTaskEvidence([{ evidence_id: String(hostEvidence.id), session_id: sessionId, turn_id: turnId,
      context_receipt_id: receiptId, verification_ref_digest: metadata.verification_ref_digest as string,
      terminal_identity_digest: metadata.terminal_identity_digest as string, verification_outcome: "passed", verified: true, content_stored: false }], archiveOptions, hostEnv);
    assert.equal(archived.status, "reconciled");
    const hostMatch = await resolveCodexHostEvidenceRecord(hostEvidence, archiveOptions, hostEnv);
    const rawHostMatch = await resolveCodexHostEvidenceArchive(String(hostEvidence.id), archiveOptions, hostEnv);
    assert.equal(hostMatch.status, "matched", JSON.stringify({ hostMatch, rawHostMatch, metadata, sessionId, turnId, receiptId }));
    assert.deepEqual({ session: hostMatch.session_id, turn: hostMatch.turn_id, receipt: hostMatch.context_receipt_id,
      verification_ref_digest: hostMatch.verification_ref_digest, outcome: hostMatch.verification_outcome }, {
      session: sessionId, turn: turnId, receipt: receiptId, verification_ref_digest: metadata.verification_ref_digest, outcome: "passed" });
    const binding = { host: "codex", task_id: String(receipt.task_id ?? "learning-task"), turn_id: turnId,
      context_receipt_id: receiptId, session_id: sessionId, host_evidence_id: String(hostEvidence.id), verification_ref: verificationRef, project_root: project,
      scenario_context: { task_goal: "修复模块", effect_summary: "定向验证通过", sanitized: true, content_stored: false } };

    const run = async (operationId: string, command: string) => {
      await writeFile(suite, JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: operationId, subject_kind: "software", partition: "held_out", sanitized: true, approved_by: "fixture-reviewer",
        cases: [{ id: "one", argv: [process.execPath, "-e", command], timeout_s: 15,
          checks: [{ id: "exit", kind: "exit_code", equals: 0 }] }] }));
      const record = await evaluations.submit({ suite, subject, runtime: evalRuntime, workspace: project, operation_id: operationId, learning_binding: binding });
      for (let attempt = 0; attempt < 200 && ["starting", "running", "cancelling"].includes(String(evaluations.get(String(record.id)).state)); attempt += 1) await delay(25);
      return evaluations.get(String(record.id));
    };

    const passing = await run("learning-pass", "process.exit(0)");
    assert.equal(passing.state, "completed", String(passing.error));
    const finalizedCall = await runtime.server.handle({ jsonrpc: "2.0", id: "learning-finalize-pass", method: "tools/call",
      params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: String(passing.id) } } });
    assert(finalizedCall, "MCP evaluation finalization returned no response");
    assert(finalizedCall.result, JSON.stringify(finalizedCall));
    assert.equal((finalizedCall.result as JsonObject).isError, false, JSON.stringify(finalizedCall));
    const finalized = (finalizedCall?.result as JsonObject).structuredContent as JsonObject;
    assert.equal(finalized.status, "observed", JSON.stringify(finalized));
    assert.equal(finalized.observation_created, false, "the earlier Host completion already created this Observation");
    assert.equal(typeof finalized.evaluation_report_digest, "string");
    assert.equal(typeof finalized.evaluation_evidence_id, "string");
    assert.equal(experienceOwner.store.list("workflow_evolution_observation", 10).length, 1);
    assert.equal(experienceOwner.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.provenance === "host_completion_signal").length, 1);
    const evaluationEvidence = experienceOwner.store.get("evidence", String(finalized.evaluation_evidence_id));
    assert.equal(evaluationEvidence.source_type, "program");
    assert.equal((evaluationEvidence.metadata as JsonObject).report_digest, finalized.evaluation_report_digest);
    const observation = finalized.observation as JsonObject;
    const requestId = "request-with-controlled-evaluation-evidence";
    experienceOwner.store.create("workflow_evolution_request", requestId, { observation_refs: [{ id: observation.id, version: observation.version }] });
    const requestView = experienceOwner.learningCycleRequestGet({ request_id: requestId });
    const retrievedObservation = (requestView.observations as JsonObject[])[0]!;
    assert.deepEqual(retrievedObservation.controlled_evaluations, [{ evaluation_id: passing.id, evidence_id: finalized.evaluation_evidence_id,
      report_digest: finalized.evaluation_report_digest, host_evidence_digest: finalized.host_evidence_digest, expected: 1, passed: 1 }]);
    const retryCall = await runtime.server.handle({ jsonrpc: "2.0", id: "learning-finalize-pass-retry", method: "tools/call",
      params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: String(passing.id) } } });
    const retried = (retryCall?.result as JsonObject).structuredContent as JsonObject;
    assert.equal(retried.evaluation_evidence_id, finalized.evaluation_evidence_id, JSON.stringify(retryCall));
    assert.equal(retried.observation_created, false);
    assert.equal(experienceOwner.store.get("evidence", String(finalized.evaluation_evidence_id)).version, evaluationEvidence.version,
      "idempotent retries must not rewrite evaluation Evidence");
    assert.equal(experienceOwner.store.list("experience_learning_evaluation_link", 10).length, 1);
    const validLink = experienceOwner.store.list("experience_learning_evaluation_link", 1)[0]!;
    const originalFind = experienceOwner.store.find.bind(experienceOwner.store);
    experienceOwner.store.find = ((kind: string, id: string, version?: number) => {
      const result = originalFind(kind, id, version);
      return kind === "experience_learning_evaluation_link" && id === String(validLink.id) && result
        ? { ...result, report_digest: "race-changed" } : result;
    }) as typeof experienceOwner.store.find;
    try {
      const raceCall = await runtime.server.handle({ jsonrpc: "2.0", id: "learning-finalize-link-race", method: "tools/call",
        params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: String(passing.id) } } });
      assert.equal((raceCall?.result as JsonObject).isError, true);
    } finally {
      experienceOwner.store.find = originalFind;
    }
    assert.equal(experienceOwner.store.get("evidence", String(finalized.evaluation_evidence_id)).version, evaluationEvidence.version,
      "a link race must not rewrite persisted evaluation Evidence");
    const withoutEvaluation = experienceOwner.workflowEvolutionObserve({ observation_id: "observation-without-evaluation-link",
      scenario_key: "unclassified:without-evaluation", source_kind: "host:codex", source_id: "another-task", source_session_id: "another-session",
      source_digest: "another-terminal-digest", outcome: "passed", scope: "project:example", evidence_ids: [String(hostEvidence.id)],
      sanitized: true, content_stored: false });
    experienceOwner.store.create("workflow_evolution_request", "request-without-controlled-evaluation", {
      observation_refs: [{ id: (withoutEvaluation.observation as JsonObject).id, version: (withoutEvaluation.observation as JsonObject).version }] });
    const plainRequest = experienceOwner.learningCycleRequestGet({ request_id: "request-without-controlled-evaluation" });
    assert.equal(Object.hasOwn((plainRequest.observations as JsonObject[])[0]!, "controlled_evaluations"), false);
    const observationCountBeforeRejectedRuns = experienceOwner.store.list("workflow_evolution_observation", 10).length;

    const evaluationLink = experienceOwner.store.list("experience_learning_evaluation_link", 1)[0]!;
    const evaluationEvidenceVersionBeforeConflict = experienceOwner.store.get("evidence", String(finalized.evaluation_evidence_id)).version;
    experienceOwner.store.save("experience_learning_evaluation_link", String(evaluationLink.id), { ...evaluationLink, report_digest: "changed" });
    const conflictCall = await runtime.server.handle({ jsonrpc: "2.0", id: "learning-finalize-link-conflict", method: "tools/call",
      params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: String(passing.id) } } });
    assert.equal((conflictCall?.result as JsonObject).isError, true);
    assert.equal(experienceOwner.store.get("evidence", String(finalized.evaluation_evidence_id)).version, evaluationEvidenceVersionBeforeConflict,
      "a conflicting link must not rewrite previously persisted evaluation Evidence");

    experienceOwner.store.save("experience_learning_evaluation_link", String(evaluationLink.id), validLink);
    const validEvidence = experienceOwner.store.get("evidence", String(finalized.evaluation_evidence_id));
    const malformedEvidence = experienceOwner.store.save("evidence", String(validEvidence.id), { ...validEvidence, metadata: null });
    const malformedEvidenceCall = await runtime.server.handle({ jsonrpc: "2.0", id: "learning-finalize-malformed-prior-evidence", method: "tools/call",
      params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: String(passing.id) } } });
    assert.equal((malformedEvidenceCall?.result as JsonObject).isError, true);
    assert.equal(experienceOwner.store.get("evidence", String(validEvidence.id)).version, malformedEvidence.version);
    experienceOwner.store.save("evidence", String(validEvidence.id), { ...malformedEvidence, metadata: validEvidence.metadata });

    const failed = await run("learning-fail", "process.exit(2)");
    assert.equal(failed.state, "completed", String(failed.error));
    const rejectedCall = await runtime.server.handle({ jsonrpc: "2.0", id: "learning-finalize-fail", method: "tools/call",
      params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: String(failed.id) } } });
    assert.equal((rejectedCall?.result as JsonObject).isError, false, JSON.stringify(rejectedCall));
    const rejected = (rejectedCall?.result as JsonObject).structuredContent as JsonObject;
    assert.deepEqual({ status: rejected.status, observation_created: rejected.observation_created }, { status: "rejected", observation_created: false });
    assert.equal(experienceOwner.store.list("workflow_evolution_observation", 10).length, observationCountBeforeRejectedRuns);
    assert.equal(experienceOwner.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.provenance === "host_completion_signal").length, 1);
    assert.equal(experienceOwner.store.list("experience_learning_evaluation_link", 10).length, 1);
    const evidenceConflictRun = await run("learning-evidence-conflict", "process.exit(0)");
    const conflictingEvidenceId = `evidence_workbench_${String(evidenceConflictRun.id).slice(-32)}`;
    const conflictingEvidence = experienceOwner.store.create("evidence", conflictingEvidenceId, { source_type: "program", confidence: "confirmed",
      claim: "Controlled Workbench evaluation passed 1/1 cases.", locator: `workbench-evaluation:${evidenceConflictRun.id}`, metadata: null });
    const evidenceConflictCall = await runtime.server.handle({ jsonrpc: "2.0", id: "learning-finalize-evidence-conflict", method: "tools/call",
      params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: String(evidenceConflictRun.id) } } });
    assert.equal((evidenceConflictCall?.result as JsonObject).isError, true);
    assert.equal(experienceOwner.store.get("evidence", conflictingEvidenceId).version, conflictingEvidence.version,
      "conflicting preexisting Evidence must remain unchanged");
    assert.equal(experienceOwner.store.list("experience_learning_evaluation_link", 10, item => item.evaluation_id === evidenceConflictRun.id).length, 0);

    const finalize = experienceOwner.learningCycleFinalize.bind(experienceOwner);
    const listObservations = experienceOwner.store.list.bind(experienceOwner.store);
    experienceOwner.learningCycleFinalize = () => ({ status: "ignored" });
    experienceOwner.store.list = ((kind: string, limit: number, predicate?: (item: JsonObject) => boolean) =>
      kind === "workflow_evolution_observation" ? [] : listObservations(kind, limit, predicate)) as typeof experienceOwner.store.list;
    try {
      const invalidObservationRun = await run("learning-no-observation", "process.exit(0)");
      const noObservationCall = await runtime.server.handle({ jsonrpc: "2.0", id: "learning-finalize-no-observation", method: "tools/call",
        params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: String(invalidObservationRun.id) } } });
      assert.equal((noObservationCall?.result as JsonObject).isError, true);
    } finally { experienceOwner.learningCycleFinalize = finalize; experienceOwner.store.list = listObservations; }
    const changedBindingRun = await run("learning-binding-race", "process.exit(0)");
    assert.equal(changedBindingRun.state, "completed", String(changedBindingRun.error));
    const originalReport = WorkbenchEvaluations.prototype.report;
    WorkbenchEvaluations.prototype.report = async function (id: string): Promise<JsonObject> {
      const report = await originalReport.call(this, id);
      const record = evalOwner.store.get("workbench_evaluation", id);
      evalOwner.store.save("workbench_evaluation", id, { ...record,
        learning_binding: { ...(record.learning_binding as JsonObject), task_id: "changed-after-report" } });
      return report;
    };
    try {
      const changedCall = await runtime.server.handle({ jsonrpc: "2.0", id: "learning-finalize-changed", method: "tools/call",
        params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: String(changedBindingRun.id) } } });
      assert.equal((changedCall?.result as JsonObject).isError, true);
    } finally { WorkbenchEvaluations.prototype.report = originalReport; }
    assert.equal(experienceOwner.store.list("workflow_evolution_observation", 10).length, observationCountBeforeRejectedRuns);
    assert.equal(experienceOwner.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.provenance === "host_completion_signal").length, 1);
    assert.equal(experienceOwner.store.list("experience_learning_evaluation_link", 10).length, 1);
    const ambiguousTaskId = String(binding.task_id);
    for (const suffix of ["one", "two"]) experienceOwner.store.create("workflow_evolution_observation", `ambiguous-host-observation-${suffix}`, {
      scenario_key: "engineering.ambiguous", source: { kind: "host:codex", id: ambiguousTaskId, digest: `ambiguous-${suffix}`,
        session_id: sessionId, scope: String((hostEvidence.metadata as JsonObject).project_scope_id) }, outcome: "passed",
      evidence_ids: [hostEvidence.id], sanitized: true, content_stored: false });
    const ambiguousRun = await run("learning-ambiguous-observation", "process.exit(0)");
    const ambiguousCall = await runtime.server.handle({ jsonrpc: "2.0", id: "learning-finalize-ambiguous-observation", method: "tools/call",
      params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: String(ambiguousRun.id) } } });
    assert.equal((ambiguousCall?.result as JsonObject).isError, true);
    assert.equal(experienceOwner.store.list("experience_learning_evaluation_link", 20, item => item.evaluation_id === ambiguousRun.id).length, 0);
    const scenarioTask = async (taskId: string, sessionId: string) => {
      const opened = await service.contextOpen({ project_root: project, query: "验证分类观察", include_codebase: false,
        task_id: taskId, session_id: sessionId, turn_id: `${sessionId}-turn`, session_host: "codex", members: ["experience"], max_tokens: 1000 });
      const taskReceipt = String(((opened.pack_receipt as JsonObject).context_receipt_id));
      return experienceOwner.learningCycleFinalize({ host: "codex", task_id: taskId, turn_id: `${sessionId}-turn`,
        session_id: sessionId, context_receipt_id: taskReceipt, verified: true, verification_outcome: "passed", verification_ref: `test:${taskId}`,
        project_root: project, scenario_key: "engineering.coverage", scenario_definition: { summary: "验证覆盖分支", applies_when: "Need cover learning branch paths",
          excludes: "Documentation-only tasks" }, scenario_context: { task_goal: "Implement the parser and verify all boundary and recovery cases.",
            effect_summary: "All parser boundary and recovery checks passed.", sanitized: true, content_stored: false } });
    };
    const firstScenarioTask = await scenarioTask("goal-digest-task", "goal-digest-session");
    const goalEvidence = firstScenarioTask.evidence as JsonObject;
    assert.equal(firstScenarioTask.observation_created, true);
    assert.match(String((goalEvidence.metadata as JsonObject).task_goal_digest), /^sha256:/u);
    const secondScenarioTask = await scenarioTask("goal-digest-task-two", "goal-digest-session-two");
    assert.equal(secondScenarioTask.observation_created, true);
    const secondScenarioReplay = await scenarioTask("goal-digest-task-two", "goal-digest-session-two");
    assert.equal(secondScenarioReplay.observation_created, false);
    assert.equal(secondScenarioReplay.idempotent, true);
    const noSessionScenario = experienceOwner.learningCycleFinalize({ host: "codex", task_id: "learning-task", turn_id: "no-session-scenario-turn",
      context_receipt_id: receiptId, verified: true, verification_outcome: "passed", verification_ref: "test:no-session-scenario",
      project_root: project, scenario_key: "engineering.coverage", scenario_definition: { summary: "验证覆盖分支", applies_when: "Need cover learning branch paths",
        excludes: "Documentation-only tasks" }, scenario_context: { task_goal: "Run one more focused validation.",
          effect_summary: "The no-session observation is recorded.", sanitized: true, content_stored: false } });
    assert.equal(noSessionScenario.observation_created, true);
    assert.equal(noSessionScenario.next_action, "host_session_id_required_for_independent_learning");
    const userReceiptId = "learning-evaluation-user-scope-receipt";
    service.store.create("context_resolution_receipt", userReceiptId, { scope: { kind: "user", id: "user-a" }, task_id: "user-scope-task" });
    const userScoped = experienceOwner.learningCycleFinalize({ host: "codex", task_id: "user-scope-task", turn_id: "user-scope-turn",
      context_receipt_id: userReceiptId, verified: true, verification_outcome: "passed", verification_ref: "test:user-scope" });
    const userScopedMetadata = (userScoped.evidence as JsonObject).metadata as JsonObject;
    assert.equal(Object.hasOwn(userScopedMetadata, "source_session_id"), false);
    assert.equal(Object.hasOwn(userScopedMetadata, "project_scope_id"), false);
    assert.equal(Object.hasOwn(userScopedMetadata, "task_goal_digest"), false);
    for (let index = 0; index < 16; index += 1) experienceOwner.store.create("experience_learning_evaluation_link", `pagination-link-${index}`, {
      evaluation_id: `pagination-evaluation-${index}`, observation_id: observation.id, evidence_id: `pagination-evidence-${index}`,
      report_digest: `pagination-report-${index}`, host_evidence_digest: "host-digest", expected: 1, passed: 1, status: "passed", content_stored: false });
    const truncatedRequest = experienceOwner.learningCycleRequestGet({ request_id: requestId });
    const truncatedObservation = (truncatedRequest.observations as JsonObject[])[0]!;
    assert.equal((truncatedObservation.controlled_evaluations as JsonObject[]).length, 16);
    assert.equal(truncatedObservation.controlled_evaluations_truncated, true, "bounded request output must disclose omitted evaluation links");
    const finalizeError = async (evaluationId: string, id: string) => {
      const result = await runtime.server.handle({ jsonrpc: "2.0", id, method: "tools/call",
        params: { name: "craft_learning_cycle_evaluation_finalize", arguments: { evaluation_id: evaluationId } } });
      assert.equal((result?.result as JsonObject).isError, true, JSON.stringify(result));
    };
    const oversizedPriorRun = await run("learning-too-many-links", "process.exit(0)");
    const originalList = experienceOwner.store.list.bind(experienceOwner.store);
    experienceOwner.store.list = ((kind: string, limit: number, predicate?: (item: JsonObject) => boolean) =>
      kind === "experience_learning_evaluation_link" ? Array.from({ length: 65 }, (_, index) => ({ id: `prior-${index}` }))
        : originalList(kind, limit, predicate)) as typeof experienceOwner.store.list;
    try { await finalizeError(String(oversizedPriorRun.id), "too-many-links"); }
    finally { experienceOwner.store.list = originalList; }

    const changedDuringCommitRun = await run("learning-binding-changed-during-commit", "process.exit(0)");
    const originalTransaction = experienceOwner.store.transaction.bind(experienceOwner.store);
    const originalEvaluation = evalOwner.store.get("workbench_evaluation", String(changedDuringCommitRun.id));
    experienceOwner.store.transaction = ((operation: () => unknown) => {
      experienceOwner.store.transaction = originalTransaction;
      evalOwner.store.save("workbench_evaluation", String(originalEvaluation.id), { ...originalEvaluation, learning_binding: { ...(originalEvaluation.learning_binding as JsonObject), task_id: "changed-before-commit" } });
      return originalTransaction(operation);
    }) as typeof experienceOwner.store.transaction;
    try { await finalizeError(String(changedDuringCommitRun.id), "binding-changed-during-commit"); }
    finally { experienceOwner.store.transaction = originalTransaction; evalOwner.store.save("workbench_evaluation", String(originalEvaluation.id), originalEvaluation); }

    const changedHostRun = await run("learning-host-changed-during-commit", "process.exit(0)");
    const originalHostEvidence = experienceOwner.store.get("evidence", String(hostEvidence.id));
    experienceOwner.store.transaction = ((operation: () => unknown) => {
      experienceOwner.store.transaction = originalTransaction;
      experienceOwner.store.save("evidence", String(originalHostEvidence.id), { ...originalHostEvidence, metadata: { ...(originalHostEvidence.metadata as JsonObject), changed_during_finalize: true } });
      return originalTransaction(operation);
    }) as typeof experienceOwner.store.transaction;
    try { await finalizeError(String(changedHostRun.id), "host-changed-during-commit"); }
    finally { experienceOwner.store.transaction = originalTransaction; experienceOwner.store.save("evidence", String(originalHostEvidence.id), originalHostEvidence); }

    const oversizedObservationRun = await run("learning-too-many-observations", "process.exit(0)");
    experienceOwner.store.list = ((kind: string, limit: number, predicate?: (item: JsonObject) => boolean) =>
      kind === "workflow_evolution_observation" ? Array.from({ length: 10_001 }, (_, index) => ({ id: `observation-${index}` }))
        : originalList(kind, limit, predicate)) as typeof experienceOwner.store.list;
    try { await finalizeError(String(oversizedObservationRun.id), "too-many-observations"); }
    finally { experienceOwner.store.list = originalList; }
  } finally {
    await evaluations.close();
    runtime.close();
    await rm(root, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
