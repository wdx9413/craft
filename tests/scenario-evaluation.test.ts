import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateReadOnlyEvaluationSteps, validateScenarioEvaluation, AUTOMATIC_SIGNOFF_POLICY } from "../capability/craft-experience/scenario-evaluation.ts";
import { projectIdentityFromRoot } from "../core/scope-identity.ts";
import { CraftService } from "../core/service.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../core/digest.ts";
import { ExperienceLearningEvaluation } from "../capability/craft-experience/learning-evaluation.ts";

function set(cases: JsonObject[], independent = false): JsonObject {
  return { case_set_ref: stableDigest(cases), cases, ...(independent ? { independent_of_training: true } : {}) };
}
function evaluation(): JsonObject {
  const shadow = [{ case_id: "shadow", project_root: "/tmp/project", inputs: { case_path: "sentinel.txt" } }];
  const heldOut = [{ case_id: "held-out", project_root: "/tmp/project", inputs: { case_path: "held-out-sentinel.txt" } }];
  const canary = [{ case_id: "canary", project_root: "/tmp/project", inputs: { case_path: "sentinel.txt" } }];
  return { schema: "craft.experience-evaluation.v1", signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY,
    stages: { shadow: set(shadow), held_out: set(heldOut, true), canary: set(canary) } };
}

test("scenario evaluation contracts pin exact cases and require a distinct held-out set plus automatic Signoff policy", () => {
  const valid = validateScenarioEvaluation(evaluation());
  assert.equal(valid.schema, "craft.experience-evaluation.v1");
  assert.equal(valid.stages.held_out.independent_of_training, true);
  for (const value of [null, [], "bad"]) assert.throws(() => validateScenarioEvaluation(value), /evaluation must be an object/u);
  assert.throws(() => validateScenarioEvaluation({ ...evaluation(), schema: "other" }), /schema is unsupported/u);
  assert.throws(() => validateScenarioEvaluation({ ...evaluation(), signoff_policy_ref: "reviewer:someone" }), /signoff_policy_ref is unsupported/u);
  assert.throws(() => validateScenarioEvaluation({ ...evaluation(), stages: null }), /stages must be an object/u);
  const stages = evaluation().stages as JsonObject;
  assert.doesNotThrow(() => validateScenarioEvaluation({ ...evaluation(), stages: { ...stages,
    shadow: set([{ case_id: "numeric", project_root: "/tmp/project", inputs: { enabled: true, count: 2 } }]) } }));
  const defaultInputs = [{ case_id: "defaults", project_root: "/tmp/project", inputs: {} }];
  assert.doesNotThrow(() => validateScenarioEvaluation({ ...evaluation(), stages: { ...stages,
    shadow: { cases: [{ case_id: "defaults", project_root: "/tmp/project" }], case_set_ref: stableDigest(defaultInputs) } } }));
  assert.throws(() => validateScenarioEvaluation({ ...evaluation(), stages: { ...stages, shadow: { cases: [] } } }), /between 1 and 32/u);
  assert.throws(() => validateScenarioEvaluation({ ...evaluation(), stages: { ...stages, held_out: set([{ case_id: "h", project_root: "/tmp/project", inputs: {} }]) } }), /independent_of_training/u);
  const same = set([{ case_id: "shadow", project_root: "/tmp/project", inputs: {} }]);
  assert.throws(() => validateScenarioEvaluation({ ...evaluation(), stages: { shadow: same, held_out: { ...same, independent_of_training: true }, canary: set([{ case_id: "c", project_root: "/tmp/project", inputs: {} }]) } }), /independent case set/u);
  const wrongPin = evaluation(); (wrongPin.stages as JsonObject).shadow = { ...(wrongPin.stages as JsonObject).shadow as JsonObject, case_set_ref: "sha256:wrong" };
  assert.throws(() => validateScenarioEvaluation(wrongPin), /pin the exact case set/u);
  const duplicate = [{ case_id: "same", project_root: "/tmp/project", inputs: {} }, { case_id: "same", project_root: "/tmp/project", inputs: {} }];
  const invalidInputs = set([{ case_id: "x", project_root: "/tmp/project", inputs: { "bad-name": "x" } }]);
  const secretInputs = set([{ case_id: "x", project_root: "/tmp/project", inputs: { key: "api_key=abcdefghijk" } }]);
  const longInput = set([{ case_id: "x", project_root: "/tmp/project", inputs: { value: "x".repeat(501) } }]);
  const manyInputs = set([{ case_id: "x", project_root: "/tmp/project", inputs: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`v${index}`, index])) }]);
  const repeated = evaluation(); (repeated.stages as JsonObject).canary = set(duplicate);
  for (const bad of [invalidInputs, secretInputs, longInput, manyInputs, set(duplicate)]) {
    const badCatalog = evaluation(); (badCatalog.stages as JsonObject).canary = bad;
    assert.throws(() => validateScenarioEvaluation(badCatalog));
  }
});

test("read-only evaluator validates assertion paths, values, thresholds, and supported step types", () => {
  const valid = validateReadOnlyEvaluationSteps([
    { id: "exists", type: "assertion", evaluator: "file_exists", path: "result.txt", expected: true, side_effect: "read_only" },
    { id: "json", type: "assertion", evaluator: "json_value", path: "result.json", field: "status", expected: "ready", side_effect: "read_only" },
    { id: "coverage", type: "coverage_gate", report: "coverage/summary.json", branch_threshold: 75, side_effect: "read_only" },
  ]);
  assert.equal(valid.length, 3);
  for (const value of [null, {}, []]) assert.throws(() => validateReadOnlyEvaluationSteps(value), /between 1 and 32/u);
  const invalid: Array<[unknown, RegExp]> = [
    [[{ id: "x", type: "assertion", evaluator: "file_exists", path: "ok", side_effect: "read_only" }, { id: "x", type: "assertion", evaluator: "file_exists", path: "ok", side_effect: "read_only" }], /unique/u],
    [[{ id: "x", type: "assertion", evaluator: "shell", path: "ok", side_effect: "read_only" }], /evaluator is unsupported/u],
    [[{ id: "x", type: "assertion", evaluator: "file_exists", path: "../outside", side_effect: "read_only" }], /stay inside/u],
    [[{ id: "x", type: "assertion", evaluator: "file_exists", path: "ok", expected: "yes", side_effect: "read_only" }], /expected must be a boolean/u],
    [[{ id: "x", type: "assertion", evaluator: "json_value", path: "ok", side_effect: "read_only" }], /expected is required/u],
    [[{ id: "x", type: "command", command: ["echo"], side_effect: "read_only" }], /type is unsupported/u],
    [[{ id: "x", type: "coverage_gate", report: "../coverage.json", side_effect: "read_only" }], /stay inside/u],
    [[{ id: "x", type: "coverage_gate", branch_threshold: 101, side_effect: "read_only" }], /between 0 and 100/u],
    [[{ id: "x", type: "assertion", evaluator: "file_exists", path: "ok", side_effect: "local_write" }], /must be read_only/u],
    [[{ type: "assertion", evaluator: "file_exists", path: "ok", side_effect: "read_only" }], /id must be non-empty/u],
  ];
  for (const [value, error] of invalid) assert.throws(() => validateReadOnlyEvaluationSteps(value), error);
});

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "craft-auto-experience-data-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "craft-auto-experience-project-"));
  const store = await new CraftStore(craftPaths(dataRoot)).open(), service = new CraftService(store);
  await writeFile(join(projectRoot, "sentinel.txt"), "do not persist this file body");
  await writeFile(join(projectRoot, "held-out-sentinel.txt"), "independent held-out fixture");
  const project = projectIdentityFromRoot(projectRoot).canonical_scope as JsonObject;
  const signature = { schema: "craft.scenario-signature.v1", project, scenario_key: "auto-build", target_class: "host_task_completion" };
  const sourceEvidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "Source observation" });
  const first = service.workflowEvolutionObserve({ scenario_key: "scenario:auto-build", scenario_signature: signature, scope: `project:${project.id}`,
    source_kind: "test", source_id: "task-1", source_digest: "source-1", outcome: "passed", evidence_ids: [sourceEvidence.id], sanitized: true }).observation as JsonObject;
  const second = service.workflowEvolutionObserve({ scenario_key: "scenario:auto-build", scenario_signature: signature, scope: `project:${project.id}`,
    source_kind: "test", source_id: "task-2", source_digest: "source-2", outcome: "passed", evidence_ids: [sourceEvidence.id], sanitized: true }).observation as JsonObject;
  const request = service.workflowEvolutionPropose({ scenario_key: "scenario:auto-build", observation_ids: [first.id, second.id], hypothesis: "Check sentinel", design_axes: ["output"], output_contract_ref: "acceptance:sentinel" }).request as JsonObject;
  store.create("evaluation_model_ticket", "ticket", { purpose: "workflow_evolution", target: { id: request.id, version: request.version } });
  const submitted = service.workflowEvolutionProposalSubmit({ request_id: request.id, model_ticket_id: "ticket", workflow_id: "auto-workflow",
    name: "Auto workflow", description: "Read-only assertion", inputs: ["project_root", "case_path"],
    steps: [{ id: "sentinel", type: "assertion", evaluator: "file_exists", path: "{{case_path}}", side_effect: "read_only" }] });
  const procedure = submitted.procedure as JsonObject;
  const cases = (caseId: string, inputs: JsonObject = {}) => [{ case_id: caseId, project_root: projectRoot, inputs }];
  const scenarioId = String(project.id).replace(/^project:/u, "");
  const scenarioDir = join(store.paths.experienceDir, "projects", scenarioId);
  await mkdir(scenarioDir, { recursive: true });
  const config = { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "auto-build", verification_commands: ["pnpm test"],
    evaluation: { schema: "craft.experience-evaluation.v1", signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY,
      stages: { shadow: set(cases("shadow", { case_path: "sentinel.txt" })), held_out: set(cases("held-out", { case_path: "held-out-sentinel.txt" }), true), canary: set(cases("canary", { case_path: "sentinel.txt" })) } } }] };
  await writeFile(join(scenarioDir, "experience-scenarios.json"), JSON.stringify(config));
  return { dataRoot, projectRoot, store, service, procedure, scenarioDir, close: async () => { store.close(); await Promise.all([rm(dataRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]); } };
}

test("the local evaluator runs pinned stages, writes content-free Evidence, applies automatic Signoff, and promotes after Canary", async () => {
  const f = await fixture();
  try {
    let dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      assert.equal(dispatch.stage, stage);
      const result = f.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id });
      assert.equal((result.dispatch as JsonObject).status, "passed", JSON.stringify({ result, workflow: f.store.find("workflow", "auto-workflow"), runs: f.store.list("workflow_run") }));
      if (stage === "canary") {
        assert.equal((result.current as JsonObject).id, f.procedure.id);
        assert.equal((result.current as JsonObject).lifecycle, "routeable");
      } else dispatch = result.next_dispatch as JsonObject;
    }
    const evidence = f.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.experience_evaluation_dispatch_id !== undefined);
    assert.equal(evidence.length, 4);
    const signoff = evidence.find(item => (item.metadata as JsonObject).stage === "signoff")!;
    assert.equal((signoff.metadata as JsonObject).signoff_policy_ref, AUTOMATIC_SIGNOFF_POLICY);
    assert.equal((signoff.metadata as JsonObject).signoff_ref, undefined);
    const heldOut = evidence.find(item => (item.metadata as JsonObject).stage === "held_out")!;
    assert.equal((heldOut.metadata as JsonObject).independent_of_training, true);
    assert.match(String((heldOut.metadata as JsonObject).held_out_set_ref), /^sha256:/u);
    const run = f.store.list("workflow_run", 10, item => item.evaluator_dispatch_id !== undefined)[0]!;
    assert.equal(JSON.stringify(run).includes("do not persist this file body"), false);
    assert.equal(JSON.stringify(run).includes(f.projectRoot), false);
    assert.match(String(run.environment_digest), /^sha256:/u);
    assert.equal(run.environment_stable, true);
    assert.equal(JSON.stringify(run.results).includes("actual"), false);
  } finally { await f.close(); }
});

test("missing project evaluation config leaves the dispatch awaiting an adapter without evidence", async () => {
  const f = await fixture();
  try {
    await rm(join(f.scenarioDir, "experience-scenarios.json"));
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const result = f.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id });
    assert.equal(result.status, "awaiting_adapter");
    assert.equal(result.reason, "project_scenario_evaluator_not_configured");
    assert.equal((result.dispatch as JsonObject).status, "awaiting_adapter");
    assert.equal(f.store.count("evidence"), 1);
  } finally { await f.close(); }
});

test("scenario catalog symbolic links fail closed under the central Experience data root", async () => {
  const f = await fixture();
  try {
    const catalog = join(f.scenarioDir, "experience-scenarios.json"), target = join(f.projectRoot, "outside-catalog.json");
    await writeFile(target, JSON.stringify({ schema: "craft.experience-scenario-catalog.v1", scenarios: [] }));
    await rm(catalog);
    await symlink(target, catalog);
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    assert.throws(() => f.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id }), /must not use symbolic links/u);
    await rm(catalog);
    await writeFile(catalog, "not-json");
    assert.throws(() => f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }), SyntaxError);
  } finally { await f.close(); }
});

test("retired scenarios stop dispatch, execution, and adapter results", async () => {
  const f = await fixture();
  try {
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const catalogPath = join(f.scenarioDir, "experience-scenarios.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as JsonObject;
    (catalog.scenarios as JsonObject[])[0]!.lifecycle = "retired";
    await writeFile(catalogPath, JSON.stringify(catalog));
    assert.throws(() => f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }), /retired; candidate cannot be evaluated/u);
    assert.throws(() => f.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id }), /retired; evaluation cannot execute/u);
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: ["missing"] }), /retired; evaluation result cannot qualify/u);
  } finally { await f.close(); }
});

test("changing the pinned scenario evaluation contract between gates stops promotion", async () => {
  const f = await fixture();
  try {
    const shadow = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const passed = f.service.experienceLearningEvaluationRun({ dispatch_id: shadow.id });
    const heldOut = passed.next_dispatch as JsonObject;
    const path = join(f.scenarioDir, "experience-scenarios.json");
    const catalog = JSON.parse(await readFile(path, "utf8")) as JsonObject;
    const scenarios = catalog.scenarios as JsonObject[];
    const scenario = scenarios[0]!;
    const evaluation = scenario.evaluation as JsonObject;
    const stages = evaluation.stages as JsonObject;
    stages.canary = set([{ case_id: "changed-canary", project_root: f.projectRoot, inputs: { case_path: "sentinel.txt" } }]);
    await writeFile(path, JSON.stringify(catalog));
    assert.throws(() => f.service.experienceLearningEvaluationRun({ dispatch_id: heldOut.id }), /contract changed after an earlier gate/u);
    assert.equal(f.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.evaluation_contract_digest !== undefined).length, 1);
    assert.equal((f.store.get("experience_evaluation_dispatch", String(heldOut.id))).status, "awaiting_adapter");
  } finally { await f.close(); }
});

test("automatic evaluation rejects stale records and safely skips unsupported identities or contracts", async () => {
  const runnerResult = async (mutate: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void): Promise<JsonObject> => {
    const f = await fixture();
    try {
      await mutate(f);
      const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id, dispatch_id: `dispatch-${Math.random()}` }).dispatch as JsonObject;
      return new ExperienceLearningEvaluation(f.store).run({ dispatch_id: dispatch.id }, () => ({ passed: true }), () => {},
        input => f.service.evidenceRecord(input), input => f.service.experienceProcedureGate(input));
    } finally { await f.close(); }
  };
  const unsupported = await runnerResult(f => {
    f.store.save("experience_procedure", String(f.procedure.id), { ...f.procedure, procedure_kind: "graph" });
  });
  assert.equal(unsupported.reason, "automatic_evaluator_supports_read_only_workflows_only");

  const noScenarioKey = await runnerResult(f => {
    f.store.save("experience_procedure", String(f.procedure.id), { ...f.procedure, scenario_signature: {} });
  });
  assert.equal(noScenarioKey.reason, "scenario_identity_is_not_evaluable");

  const invalidProject = await runnerResult(f => {
    f.store.save("experience_procedure", String(f.procedure.id), { ...f.procedure, scenario_signature: { scenario_key: "auto-build", project: { id: "project:bad/id" } } });
  });
  assert.equal(invalidProject.reason, "scenario_identity_is_not_evaluable");

  const noScenario = await runnerResult(async f => {
    await writeFile(join(f.scenarioDir, "experience-scenarios.json"), JSON.stringify({ schema: "craft.experience-scenario-catalog.v1", scenarios: [] }));
  });
  assert.equal(noScenario.reason, "project_scenario_evaluator_not_configured");

  const noEvaluation = await runnerResult(async f => {
    await writeFile(join(f.scenarioDir, "experience-scenarios.json"), JSON.stringify({ schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "auto-build" }] }));
  });
  assert.equal(noEvaluation.reason, "project_scenario_evaluator_not_configured");

  const malformedCatalog = await fixture();
  try {
    await writeFile(join(malformedCatalog.scenarioDir, "experience-scenarios.json"), "[]");
    const dispatch = malformedCatalog.service.experienceLearningEvaluationDispatch({ procedure_id: malformedCatalog.procedure.id }).dispatch as JsonObject;
    assert.throws(() => malformedCatalog.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id }), /catalog is invalid/u);
    await writeFile(join(malformedCatalog.scenarioDir, "experience-scenarios.json"), JSON.stringify({ schema: "other", scenarios: [] }));
    const fresh = malformedCatalog.service.experienceLearningEvaluationDispatch({ procedure_id: malformedCatalog.procedure.id, dispatch_id: "bad-schema" }).dispatch as JsonObject;
    assert.throws(() => malformedCatalog.service.experienceLearningEvaluationRun({ dispatch_id: fresh.id }), /catalog is invalid/u);
  } finally { await malformedCatalog.close(); }

  const ambiguousCatalog = await fixture();
  try {
    const valid = JSON.parse(await readFile(join(ambiguousCatalog.scenarioDir, "experience-scenarios.json"), "utf8")) as JsonObject;
    const scenarios = valid.scenarios as JsonObject[];
    valid.scenarios = [scenarios[0]!, { ...scenarios[0]! }];
    await writeFile(join(ambiguousCatalog.scenarioDir, "experience-scenarios.json"), JSON.stringify(valid));
    const dispatch = ambiguousCatalog.service.experienceLearningEvaluationDispatch({ procedure_id: ambiguousCatalog.procedure.id }).dispatch as JsonObject;
    assert.throws(() => ambiguousCatalog.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id }), /ambiguous/u);
  } finally { await ambiguousCatalog.close(); }

  const f = await fixture();
  try {
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    f.store.save("experience_evaluation_dispatch", String(dispatch.id), { ...dispatch, definition_digest: "sha256:drift" });
    assert.throws(() => f.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id }), /definition drifted/u);
    await writeFile(join(f.scenarioDir, "experience-scenarios.json"), "x".repeat(16_385));
    const fresh = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id, dispatch_id: "oversize-catalog" }).dispatch as JsonObject;
    assert.throws(() => f.service.experienceLearningEvaluationRun({ dispatch_id: fresh.id }), /exceeds 16384/u);
  } finally { await f.close(); }
});

test("automatic evaluator guard branches preserve dispatches and require a complete Signoff history", async () => {
  const alreadyResolved = await fixture();
  try {
    const dispatch = alreadyResolved.service.experienceLearningEvaluationDispatch({ procedure_id: alreadyResolved.procedure.id }).dispatch as JsonObject;
    alreadyResolved.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id });
    assert.throws(() => new ExperienceLearningEvaluation(alreadyResolved.store).run({ dispatch_id: dispatch.id }, () => ({}), () => {},
      input => alreadyResolved.service.evidenceRecord(input), input => alreadyResolved.service.experienceProcedureGate(input)), /already resolved/u);
  } finally { await alreadyResolved.close(); }

  const definitionDrift = await fixture();
  try {
    definitionDrift.store.save("experience_procedure", String(definitionDrift.procedure.id), { ...definitionDrift.procedure, definition_digest: "sha256:wrong-definition" });
    const dispatch = definitionDrift.service.experienceLearningEvaluationDispatch({ procedure_id: definitionDrift.procedure.id }).dispatch as JsonObject;
    assert.throws(() => definitionDrift.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id }), /definition digest does not match/u);
  } finally { await definitionDrift.close(); }

  const unqualified = await fixture();
  try {
    const procedure = unqualified.store.save("experience_procedure", String(unqualified.procedure.id), { ...unqualified.procedure, completed_gates: null });
    const dispatch = unqualified.service.experienceLearningEvaluationDispatch({ procedure_id: procedure.id }).dispatch as JsonObject;
    unqualified.store.save("experience_evaluation_dispatch", String(dispatch.id), { ...dispatch, stage: "signoff" });
    assert.throws(() => unqualified.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id }), /requires passed Shadow and Held-out gates/u);
  } finally { await unqualified.close(); }

  const missingPriorGate = await fixture();
  try {
    const procedure = missingPriorGate.store.save("experience_procedure", String(missingPriorGate.procedure.id), { ...missingPriorGate.procedure, completed_gates: ["shadow"] });
    const dispatch = missingPriorGate.service.experienceLearningEvaluationDispatch({ procedure_id: procedure.id }).dispatch as JsonObject;
    assert.equal(dispatch.stage, "held_out");
    assert.throws(() => missingPriorGate.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id }), /contract changed after an earlier gate/u);
  } finally { await missingPriorGate.close(); }

  const noRunReceipt = await fixture();
  try {
    const dispatch = noRunReceipt.service.experienceLearningEvaluationDispatch({ procedure_id: noRunReceipt.procedure.id }).dispatch as JsonObject;
    const result = new ExperienceLearningEvaluation(noRunReceipt.store).run({ dispatch_id: dispatch.id }, () => ({ passed: true }), () => {},
      input => noRunReceipt.service.evidenceRecord(input), input => noRunReceipt.service.experienceProcedureGate(input));
    assert.equal((result.dispatch as JsonObject).status, "passed");
    const evidenceId = ((result.dispatch as JsonObject).evidence_ids as string[])[0]!;
    assert.deepEqual((noRunReceipt.store.get("evidence", evidenceId).metadata as JsonObject).workflow_run_ids, []);
  } finally { await noRunReceipt.close(); }
});

test("candidate exceptions without a current baseline are recorded as failed without baseline receipts", async () => {
  const f = await fixture();
  try {
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const result = new ExperienceLearningEvaluation(f.store).run({ dispatch_id: dispatch.id }, () => { throw new Error("candidate unavailable"); }, () => {},
      input => f.service.evidenceRecord(input), input => f.service.experienceProcedureGate(input));
    assert.equal((result.dispatch as JsonObject).status, "failed");
    const evidenceId = ((result.dispatch as JsonObject).evidence_ids as string[])[0]!;
    const metadata = f.store.get("evidence", evidenceId).metadata as JsonObject;
    assert.deepEqual(metadata.baseline_workflow_run_ids, []);
    assert.deepEqual(metadata.workflow_run_ids, []);
  } finally { await f.close(); }
});

test("held-out failure stops automatic evolution before Signoff and preserves current", async () => {
  const f = await fixture();
  try {
    const old = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const passed = f.service.experienceLearningEvaluationRun({ dispatch_id: old.id });
    const held = passed.next_dispatch as JsonObject;
    await rm(join(f.projectRoot, "held-out-sentinel.txt"));
    const failed = f.service.experienceLearningEvaluationRun({ dispatch_id: held.id });
    assert.equal((failed.dispatch as JsonObject).status, "failed");
    assert.equal(failed.next_dispatch, null);
    assert.equal((failed.procedure as JsonObject).lifecycle, "rejected");
    assert.equal(f.store.find("experience_release", String(f.procedure.id)), null);
  } finally { await f.close(); }
});

test("Canary runs the pinned current Procedure and binds both run receipts", async () => {
  const f = await fixture();
  try {
    let dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    let current: JsonObject | null = null;
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      const result = f.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id });
      if (stage === "canary") current = result.current as JsonObject;
      else dispatch = result.next_dispatch as JsonObject;
    }
    assert.equal(current?.id, f.procedure.id);
    await writeFile(join(f.projectRoot, "sentinel-v2.txt"), "candidate");
    const signature = f.procedure.scenario_signature as JsonObject;
    const sourceEvidenceId = String((f.procedure.evidence_ids as string[])[0]);
    const first = f.service.workflowEvolutionObserve({ scenario_key: "scenario:auto-build", scenario_signature: signature, scope: String(f.procedure.scope),
      source_kind: "test", source_id: "task-3", source_digest: "source-3", outcome: "passed", evidence_ids: [sourceEvidenceId], sanitized: true }).observation as JsonObject;
    const second = f.service.workflowEvolutionObserve({ scenario_key: "scenario:auto-build", scenario_signature: signature, scope: String(f.procedure.scope),
      source_kind: "test", source_id: "task-4", source_digest: "source-4", outcome: "passed", evidence_ids: [sourceEvidenceId], sanitized: true }).observation as JsonObject;
    const request = f.service.workflowEvolutionPropose({ scenario_key: "scenario:auto-build", observation_ids: [first.id, second.id],
      hypothesis: "Check both established markers", design_axes: ["output"], output_contract_ref: "acceptance:both" }).request as JsonObject;
    f.store.create("evaluation_model_ticket", "ticket-next", { purpose: "workflow_evolution", target: { id: request.id, version: request.version } });
    await writeFile(join(f.projectRoot, "held-out-sentinel-v2.txt"), "independent candidate fixture");
    const next = f.service.workflowEvolutionProposalSubmit({ request_id: request.id, model_ticket_id: "ticket-next", workflow_id: "auto-workflow-v2",
      name: "Auto workflow v2", description: "Two read-only assertions", inputs: ["project_root", "case_path"], steps: [
        { id: "sentinel", type: "assertion", evaluator: "file_exists", path: "{{case_path}}", side_effect: "read_only" },
        { id: "sentinel-v2", type: "assertion", evaluator: "file_exists", path: "sentinel-v2.txt", side_effect: "read_only" },
      ] });
    const candidate = next.procedure as JsonObject;
    assert.equal(candidate.id, f.procedure.id);
    const shadowCases = [{ case_id: "shadow-v2", project_root: f.projectRoot, inputs: { case_path: "sentinel.txt" } }];
    const heldOutCases = [{ case_id: "held-out-v2", project_root: f.projectRoot, inputs: { case_path: "held-out-sentinel-v2.txt" } }];
    const canaryCases = [
      { case_id: "baseline-error", project_root: f.projectRoot, inputs: { case_path: "sentinel.txt" } },
      { case_id: "candidate-string-error", project_root: f.projectRoot, inputs: { case_path: "sentinel.txt" } },
      { case_id: "candidate-error", project_root: f.projectRoot, inputs: { case_path: "sentinel.txt" } },
    ];
    await writeFile(join(f.scenarioDir, "experience-scenarios.json"), JSON.stringify({ schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "auto-build", verification_commands: ["pnpm test"], evaluation: {
      schema: "craft.experience-evaluation.v1", signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY,
      stages: { shadow: set(shadowCases), held_out: set(heldOutCases, true), canary: set(canaryCases) },
    } }] }));
    dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: candidate.id }).dispatch as JsonObject;
    assert.equal(dispatch.baseline_version, current!.version);
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      const result = f.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id });
      if (stage === "canary") {
        assert.equal(Number((result.current as JsonObject).version), Number(candidate.version) + 4);
        const metadata = f.store.get("evidence", String((result.dispatch as JsonObject).evidence_ids && ((result.dispatch as JsonObject).evidence_ids as string[])[0])).metadata as JsonObject;
        assert.equal((metadata.baseline_workflow_run_ids as string[]).length, 3);
        assert.equal((metadata.workflow_run_ids as string[]).length, 3);
        assert.notEqual((metadata.baseline_workflow_run_ids as string[])[0], (metadata.workflow_run_ids as string[])[0]);
      } else dispatch = result.next_dispatch as JsonObject;
    }

    const observe = (sourceId: string) => f.service.workflowEvolutionObserve({ scenario_key: "scenario:auto-build", scenario_signature: signature,
      scope: String(f.procedure.scope), source_kind: "test", source_id: sourceId, source_digest: sourceId,
      outcome: "passed", evidence_ids: [sourceEvidenceId], sanitized: true }).observation as JsonObject;
    const third = observe("task-5"), fourth = observe("task-6");
    const nextRequest = f.service.workflowEvolutionPropose({ scenario_key: "scenario:auto-build", observation_ids: [third.id, fourth.id],
      hypothesis: "Check both established markers again", design_axes: ["output"], output_contract_ref: "acceptance:both-v3" }).request as JsonObject;
    f.store.create("evaluation_model_ticket", "ticket-v3", { purpose: "workflow_evolution", target: { id: nextRequest.id, version: nextRequest.version } });
    const thirdCandidate = f.service.workflowEvolutionProposalSubmit({ request_id: nextRequest.id, model_ticket_id: "ticket-v3", workflow_id: "auto-workflow-v3",
      name: "Auto workflow v3", description: "Two read-only assertions", inputs: ["project_root", "case_path"], steps: [
        { id: "sentinel", type: "assertion", evaluator: "file_exists", path: "{{case_path}}", side_effect: "read_only" },
        { id: "sentinel-v2", type: "assertion", evaluator: "file_exists", path: "sentinel-v2.txt", side_effect: "read_only" },
      ] }).procedure as JsonObject;
    let thirdDispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: thirdCandidate.id }).dispatch as JsonObject;
    for (const stage of ["shadow", "held_out", "signoff"]) {
      const result = f.service.experienceLearningEvaluationRun({ dispatch_id: thirdDispatch.id });
      thirdDispatch = result.next_dispatch as JsonObject;
    }
    assert.notEqual(thirdDispatch.baseline_version, null);
    const scenarioCatalogPath = join(f.scenarioDir, "experience-scenarios.json");
    const scenarioCatalogBytes = await readFile(scenarioCatalogPath, "utf8");
    await writeFile(scenarioCatalogPath, "[]");
    assert.throws(() => f.service.experienceLearningEvaluationRun({ dispatch_id: thirdDispatch.id }), /Canary baseline changed/u);
    await writeFile(scenarioCatalogPath, "not-json");
    assert.throws(() => f.service.experienceLearningEvaluationRun({ dispatch_id: thirdDispatch.id }), SyntaxError);
    await writeFile(scenarioCatalogPath, scenarioCatalogBytes);
    const originalLstat = fs.lstatSync;
    let catalogReads = 0;
    fs.lstatSync = ((...call: Parameters<typeof fs.lstatSync>) => {
      if (String(call[0]) === scenarioCatalogPath && ++catalogReads === 2) throw new Error("scenario catalog read failed");
      return originalLstat(...call);
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => f.service.experienceLearningEvaluationRun({ dispatch_id: thirdDispatch.id }), /scenario catalog read failed/u);
    } finally { fs.lstatSync = originalLstat; syncBuiltinESMExports(); }
    const proxyStore = new Proxy(f.store, { get(target, property, receiver) {
      if (property === "get") return (kind: string, id: string, version?: number) => {
        const record = target.get(kind, id, version);
        return kind === "experience_procedure" && id === thirdCandidate.id && version === Number(thirdDispatch.baseline_version)
          ? { ...record, definition_ref: null } : record;
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const unsupportedBaseline = new ExperienceLearningEvaluation(proxyStore).run({ dispatch_id: thirdDispatch.id }, () => ({ passed: true }), () => {},
      input => f.service.evidenceRecord(input), input => f.service.experienceProcedureGate(input));
    assert.equal(unsupportedBaseline.reason, "canary_baseline_requires_external_adapter");
    const release = f.store.find("experience_release", String(thirdCandidate.id))!;
    const revoked = f.store.save("experience_release", String(release.id), { ...release, status: "revoked" });
    const staleEvidence = f.service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "Stale Canary proof", metadata: {
      experience_evaluation_dispatch_id: thirdDispatch.id, procedure_id: thirdDispatch.procedure_id, procedure_version: thirdDispatch.procedure_version,
      definition_digest: thirdDispatch.definition_digest, baseline_version: thirdDispatch.baseline_version, stage: "canary", status: "passed",
      evaluator_ref: "test-evaluator", environment_digest: "sha256:test",
    } });
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: thirdDispatch.id, evidence_ids: [staleEvidence.id] }), /baseline changed/u);
    assert.throws(() => f.service.experienceLearningEvaluationRun({ dispatch_id: thirdDispatch.id }), /baseline changed/u);
    f.store.save("experience_release", String(release.id), { ...revoked, status: "active" });
    const runner = new ExperienceLearningEvaluation(f.store);
    const rejected = runner.run({ dispatch_id: thirdDispatch.id }, input => {
      if (input.case_id === "baseline-error:current") throw new Error("baseline execution failed");
      if (input.case_id === "baseline-error") return { passed: true, workflow_run_id: "candidate-run" };
      if (input.case_id === "candidate-string-error:current") throw "baseline execution failed";
      if (input.case_id === "candidate-error:current") return { passed: true, workflow_run_id: "baseline-instance", inputs_digest: "shared", environment_digest: "sha256:baseline" };
      if (input.case_id === "candidate-string-error") throw "candidate execution failed";
      throw new Error("candidate execution failed");
    }, () => {}, input => f.service.evidenceRecord(input), input => f.service.experienceProcedureGate(input));
    assert.equal((rejected.dispatch as JsonObject).status, "failed");
    const failedEvidenceId = ((rejected.dispatch as JsonObject).evidence_ids as string[])[0]!;
    const failedMetadata = f.store.get("evidence", failedEvidenceId).metadata as JsonObject;
    assert.deepEqual(failedMetadata.baseline_workflow_run_ids, ["baseline-instance"]);
    assert.deepEqual(failedMetadata.workflow_run_ids, ["candidate-run"]);
  } finally { await f.close(); }
});
