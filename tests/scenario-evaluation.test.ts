import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { linkDirectory } from "./symlink-support.ts";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateReadOnlyEvaluationSteps, validateScenarioEvaluation, AUTOMATIC_SIGNOFF_POLICY } from '@craft/capability-experience/scenario-evaluation';
import { projectIdentityFromRoot } from "../core/scope-identity.ts";
import { CraftService } from "../core/service.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../core/digest.ts";
import { ExperienceLearningEvaluation } from "../../craft-capability/capability/craft-experience/learning-evaluation.ts";
import { projectExperienceDirectory } from "../core/project-experience-directory.ts";

function set(cases: JsonObject[], independent = false): JsonObject {
  const caseSetRef = stableDigest(cases);
  return { case_set_ref: caseSetRef, cases,
    ...(independent ? { independent_of_training: true, training_set_digest: stableDigest({ training: caseSetRef }) } : {}) };
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
  assert.throws(() => validateScenarioEvaluation({ ...evaluation(), stages: { shadow: same,
    held_out: { ...same, independent_of_training: true, training_set_digest: stableDigest({ training: "shadow" }) },
    canary: set([{ case_id: "c", project_root: "/tmp/project", inputs: {} }]) } }), /independent case set/u);
  // Held-out independence must be backed by a training-set digest that differs from the held-out set.
  const heldCases = [{ case_id: "held-out", project_root: "/tmp/project", inputs: { case_path: "held-out-sentinel.txt" } }];
  const missingTraining = { ...evaluation(), stages: { ...stages,
    held_out: { case_set_ref: stableDigest(heldCases), cases: heldCases, independent_of_training: true } } };
  assert.throws(() => validateScenarioEvaluation(missingTraining), /training_set_digest/u);
  const sameAsTraining = { ...evaluation(), stages: { ...stages,
    held_out: { case_set_ref: stableDigest(heldCases), cases: heldCases, independent_of_training: true,
      training_set_digest: stableDigest(heldCases) } } };
  assert.throws(() => validateScenarioEvaluation(sameAsTraining), /must differ from the held-out case set/u);
  const nonShaTraining = { ...evaluation(), stages: { ...stages,
    held_out: { case_set_ref: stableDigest(heldCases), cases: heldCases, independent_of_training: true,
      training_set_digest: "not-a-digest" } } };
  assert.throws(() => validateScenarioEvaluation(nonShaTraining), /must be a sha256 digest/u);
  // A scenario declares one applicability domain; held-out cases cannot claim another.
  assert.doesNotThrow(() => validateScenarioEvaluation({ ...evaluation(), domain: "coding" }));
  assert.doesNotThrow(() => validateScenarioEvaluation({ ...evaluation(), domain: "quant" }));
  assert.throws(() => validateScenarioEvaluation({ ...evaluation(), domain: "astrology" }), /domain is unsupported/u);
  const mismatchedCase = evaluation();
  mismatchedCase.domain = "coding";
  const heldOutStage = (mismatchedCase.stages as JsonObject).held_out as JsonObject;
  const mismatchedCases = (heldOutStage.cases as JsonObject[]).map(item => ({ ...item, domain: "writing" }));
  (mismatchedCase.stages as JsonObject).held_out = { ...heldOutStage,
    case_set_ref: stableDigest(mismatchedCases), cases: mismatchedCases };
  assert.throws(() => validateScenarioEvaluation(mismatchedCase), /must match the scenario domain/u);
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
  service.scopeIdentityResolveProject({ project_root: projectRoot });
  const signature = { schema: "craft.scenario-signature.v1", project, scenario_key: "auto-build", target_class: "host_task_completion" };
  const sourceEvidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "Source observation" });
  const first = service.workflowEvolutionObserve({ scenario_key: "scenario:auto-build", scenario_signature: signature, scope: String(project.id),
    source_kind: "test", source_id: "task-1", source_digest: "source-1", outcome: "passed", evidence_ids: [sourceEvidence.id], sanitized: true }).observation as JsonObject;
  const second = service.workflowEvolutionObserve({ scenario_key: "scenario:auto-build", scenario_signature: signature, scope: String(project.id),
    source_kind: "test", source_id: "task-2", source_digest: "source-2", outcome: "passed", evidence_ids: [sourceEvidence.id], sanitized: true }).observation as JsonObject;
  const request = service.workflowEvolutionPropose({ scenario_key: "scenario:auto-build", observation_ids: [first.id, second.id], hypothesis: "Check sentinel", design_axes: ["output"], output_contract_ref: "acceptance:sentinel" }).request as JsonObject;
  store.create("evaluation_model_ticket", "ticket", { purpose: "workflow_evolution", target: { id: request.id, version: request.version } });
  const submitted = service.workflowEvolutionProposalSubmit({ request_id: request.id, model_ticket_id: "ticket", workflow_id: "auto-workflow",
    name: "Auto workflow", description: "Read-only assertion", inputs: ["project_root", "case_path"],
    steps: [{ id: "sentinel", type: "assertion", evaluator: "file_exists", path: "{{case_path}}", side_effect: "read_only" }] });
  const procedure = submitted.procedure as JsonObject;
  const cases = (caseId: string, inputs: JsonObject = {}) => [{ case_id: caseId, project_root: projectRoot, inputs }];
  const scenarioId = String(project.id).replace(/^project:/u, "");
  const scenarioDir = projectExperienceDirectory(store, String(project.id), projectRoot, true);
  const config = { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "auto-build", verification_commands: ["pnpm test"],
    evaluation: { schema: "craft.experience-evaluation.v1", signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY,
      stages: { shadow: set(cases("shadow", { case_path: "sentinel.txt" })), held_out: set(cases("held-out", { case_path: "held-out-sentinel.txt" }), true), canary: set(cases("canary", { case_path: "sentinel.txt" })) } } }] };
  await writeFile(join(scenarioDir, "experience-scenarios.json"), JSON.stringify(config));
  return { dataRoot, projectRoot, store, service, procedure, scenarioDir, close: async () => { store.close(); await Promise.all([rm(dataRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]); } };
}

test("the local evaluator records Shadow and waits for the trusted paired Held-out report", async () => {
  const f = await fixture();
  try {
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const shadow = f.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id });
    assert.equal((shadow.dispatch as JsonObject).status, "passed");
    const heldOutDispatch = shadow.next_dispatch as JsonObject;
    assert.equal(heldOutDispatch.stage, "held_out");
    const heldOut = f.service.experienceLearningEvaluationRun({ dispatch_id: heldOutDispatch.id });
    assert.equal(heldOut.status, "awaiting_adapter");
    assert.equal(heldOut.reason, "trusted_task_effect_evaluation_required");
    assert.equal((heldOut.dispatch as JsonObject).status, "awaiting_adapter");
    assert.equal(f.store.find("experience_release", String(f.procedure.id)), null);
    const evidence = f.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.experience_evaluation_dispatch_id !== undefined);
    assert.equal(evidence.length, 1);
    assert.equal((evidence[0]!.metadata as JsonObject).stage, "shadow");
    const run = f.store.list("workflow_run", 10, item => item.evaluator_dispatch_id !== undefined)[0]!;
    assert.equal(JSON.stringify(run).includes("do not persist this file body"), false);
    assert.equal(JSON.stringify(run).includes(f.projectRoot), false);
    assert.match(String(run.environment_digest), /^sha256:/u);
    assert.equal(run.environment_stable, true);
    assert.equal(JSON.stringify(run.results).includes("actual"), false);
  } finally { await f.close(); }
});

test("evaluation dispatch listing, idempotency, and evidence binding reject malformed replay", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.service.experienceLearningEvaluationList({}).count, 0);
    assert.throws(() => f.service.experienceLearningEvaluationList({ limit: 0 }), /between 1 and 1000/u);
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id, dispatch_id: "stable-dispatch" }).dispatch as JsonObject;
    assert.equal(f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id, dispatch_id: "stable-dispatch" }).idempotent, true);
    assert.equal((f.service.experienceLearningEvaluationList({ limit: 10 }).dispatches as JsonObject[]).length, 1);
    const unbound = f.service.evidenceRecord({ source_type: "fact", confidence: "confirmed", claim: "unbound evidence",
      metadata: { experience_evaluation_dispatch_id: dispatch.id } });
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: dispatch.id, evidence_ids: [String(unbound.id)] }), /not confirmed and bound/u);
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

test("automatic evaluation rejects a formerly valid project scene when its root is unregistered", async () => {
  const f = await fixture();
  try {
    const scope = String(f.procedure.scope);
    for (const alias of f.store.list("scope_alias", 100, item => (item.scope as JsonObject | undefined)?.id === scope)) {
      f.store.remove("scope_alias", String(alias.id));
    }
    for (const identity of f.store.list("project_identity", 100, item => (item.canonical_scope as JsonObject | undefined)?.id === scope)) {
      f.store.remove("project_identity", String(identity.id));
    }
    assert.throws(() => f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }), /root is not registered/u);
  } finally { await f.close(); }
});

test("automatic evaluation surfaces an invalid registered project root", async () => {
  const f = await fixture();
  const fileRoot = join(f.dataRoot, "registered-project-file");
  try {
    await writeFile(fileRoot, "not a directory");
    f.store.create("scope_alias", "invalid-project-root", { status: "active", alias_kind: "path", alias: fileRoot,
      alias_digest: stableDigest(fileRoot), scope: { kind: "project", id: "project:invalid-root" } });
    const evaluator = new ExperienceLearningEvaluation(f.store) as unknown as { readScenarioEvaluation(projectId: string, scenarioKey: string): JsonObject | null };
    assert.equal(evaluator.readScenarioEvaluation("unregistered-project", "auto-build"), null);
    assert.throws(() => evaluator.readScenarioEvaluation("invalid-root", "auto-build"), /project root must be a directory/u);
  } finally { await f.close(); }
});

test("scenario catalog symbolic links fail closed under the central Experience data root", async () => {
  const f = await fixture();
  try {
    const catalog = join(f.scenarioDir, "experience-scenarios.json"), target = join(f.projectRoot, "outside-catalog.json");
    await mkdir(target, { recursive: true });
    await rm(catalog);
    await linkDirectory(target, catalog);
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

test("local held-out evaluation does not substitute for the trusted paired report", async () => {
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
    const result = f.service.experienceLearningEvaluationRun({ dispatch_id: heldOut.id });
    assert.equal(result.status, "awaiting_adapter");
    assert.equal(result.reason, "trusted_task_effect_evaluation_required");
    assert.equal(f.store.list("evidence", 20, item => (item.metadata as JsonObject | undefined)?.evaluation_contract_digest !== undefined).length, 1);
    assert.equal((f.store.get("experience_evaluation_dispatch", String(heldOut.id))).status, "awaiting_adapter");
  } finally { await f.close(); }
});

test("a caller cannot pass a Held-out dispatch through the adapter result without contract references", async () => {
  const f = await fixture();
  try {
    const shadowDispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const shadow = f.service.experienceLearningEvaluationRun({ dispatch_id: shadowDispatch.id });
    const dispatch = shadow.next_dispatch as JsonObject;
    const procedure = f.store.get("experience_procedure", String(dispatch.procedure_id), Number(dispatch.procedure_version));
    const evidence = f.service.evidenceRecord({ evidence_id: "unqualified-held-out", source_type: "program", confidence: "confirmed",
      claim: "Untrusted local held-out claim.", metadata: { experience_evaluation_dispatch_id: dispatch.id, procedure_id: procedure.id,
        procedure_version: procedure.version, definition_digest: procedure.definition_digest, baseline_version: dispatch.baseline_version,
        stage: "held_out", status: "passed", evaluator_ref: "local-read-only-v1", environment_digest: "sha256:local",
        held_out_set_ref: "local-fixture", independent_of_training: true } });
    f.store.save("evidence", String(evidence.id), { ...evidence, record_origin: "experience_evaluator" });
    assert.throws(() => new ExperienceLearningEvaluation(f.store).result({ dispatch_id: dispatch.id, evidence_ids: [evidence.id] }, () => {
      assert.fail("the held-out gate must not run without a trusted Evaluation Contract reference");
    }), /trusted task-effect Evaluation Contract result/u);
    assert.equal(f.store.get("experience_evaluation_dispatch", String(dispatch.id)).status, "awaiting_adapter");
  } finally { await f.close(); }
});

test("automatic evaluation rejects stale records and safely skips unsupported identities or contracts", async () => {
  const runnerResult = async (mutate: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void): Promise<JsonObject> => {
    const f = await fixture();
    try {
      await mutate(f);
      const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id, dispatch_id: `dispatch-${Math.random()}` }).dispatch as JsonObject;
      return new ExperienceLearningEvaluation(f.store).run({ dispatch_id: dispatch.id }, () => ({ passed: true }), () => {},
        input => { const record = f.service.evidenceRecord(input); return f.store.save("evidence", String(record.id), { ...record, record_origin: "experience_evaluator" }); }, input => f.service.experienceProcedures.gate(input));
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
      input => { const record = alreadyResolved.service.evidenceRecord(input); return alreadyResolved.store.save("evidence", String(record.id), { ...record, record_origin: "experience_evaluator" }); }, input => alreadyResolved.service.experienceProcedures.gate(input)), /already resolved/u);
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
    const awaiting = missingPriorGate.service.experienceLearningEvaluationRun({ dispatch_id: dispatch.id });
    assert.equal(awaiting.status, "awaiting_adapter");
    assert.equal(awaiting.reason, "trusted_task_effect_evaluation_required");
  } finally { await missingPriorGate.close(); }

  const noRunReceipt = await fixture();
  try {
    const dispatch = noRunReceipt.service.experienceLearningEvaluationDispatch({ procedure_id: noRunReceipt.procedure.id }).dispatch as JsonObject;
    const result = new ExperienceLearningEvaluation(noRunReceipt.store).run({ dispatch_id: dispatch.id }, () => ({ passed: true }), () => {},
      input => { const record = noRunReceipt.service.evidenceRecord(input); return noRunReceipt.store.save("evidence", String(record.id), { ...record, record_origin: "experience_evaluator" }); }, input => noRunReceipt.service.experienceProcedures.gate(input));
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
      input => { const record = f.service.evidenceRecord(input); return f.store.save("evidence", String(record.id), { ...record, record_origin: "experience_evaluator" }); }, input => f.service.experienceProcedures.gate(input));
    assert.equal((result.dispatch as JsonObject).status, "failed");
    const evidenceId = ((result.dispatch as JsonObject).evidence_ids as string[])[0]!;
    const metadata = f.store.get("evidence", evidenceId).metadata as JsonObject;
    assert.deepEqual(metadata.baseline_workflow_run_ids, []);
    assert.deepEqual(metadata.workflow_run_ids, []);
  } finally { await f.close(); }
});

test("local evaluator cannot mark Held-out passed or rejected without a trusted report", async () => {
  const f = await fixture();
  try {
    const old = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    const passed = f.service.experienceLearningEvaluationRun({ dispatch_id: old.id });
    const held = passed.next_dispatch as JsonObject;
    await rm(join(f.projectRoot, "held-out-sentinel.txt"));
    const heldOut = f.service.experienceLearningEvaluationRun({ dispatch_id: held.id });
    assert.equal(heldOut.status, "awaiting_adapter");
    assert.equal((heldOut.dispatch as JsonObject).status, "awaiting_adapter");
    assert.equal((heldOut.procedure as JsonObject | undefined)?.lifecycle, undefined);
    assert.equal(f.store.find("experience_release", String(f.procedure.id)), null);
  } finally { await f.close(); }
});

test("Canary regression runs only after trusted Held-out qualification and binds its run receipts", async () => {
  const f = await fixture();
  try {
    const catalog = JSON.parse(await readFile(join(f.scenarioDir, "experience-scenarios.json"), "utf8")) as JsonObject;
    const scenario = (catalog.scenarios as JsonObject[])[0]!;
    const evaluationContractDigest = stableDigest(scenario.evaluation);
    const existing = f.store.get("experience_procedure", String(f.procedure.id));
    f.store.save("experience_procedure", String(existing.id), { ...existing,
      completed_gates: ["shadow", "held_out", "signoff"], evaluation_contract_id: "trusted-contract", evaluation_id: "trusted-report" });
    for (const stage of ["shadow", "held_out", "signoff"]) {
      const id = `prior-${stage}-evidence`;
      f.store.create("evidence", id, { source_type: "program", confidence: "confirmed", record_origin: "experience_evaluator",
        metadata: { evaluation_contract_digest: evaluationContractDigest } });
      f.store.create("experience_procedure_gate", `prior-${stage}-gate`, { procedure_id: f.procedure.id, stage,
        procedure_version: existing.version, evidence_ids: [id] });
    }
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: f.procedure.id }).dispatch as JsonObject;
    assert.equal(dispatch.stage, "canary");
    const evaluated = new ExperienceLearningEvaluation(f.store).run({ dispatch_id: dispatch.id }, input => ({ passed: true,
      workflow_run_id: `run-${String(input.case_id)}`, environment_digest: "sha256:canary", inputs_digest: "sha256:inputs" }), () => {},
      input => { const evidence = f.service.evidenceRecord(input); return f.store.save("evidence", String(evidence.id), { ...evidence, record_origin: "experience_evaluator" }); },
      gateArgs => ({ gate: { id: gateArgs.gate_id }, procedure: { ...f.procedure, routeable: true, lifecycle: "routeable" } }));
    assert.equal((evaluated.dispatch as JsonObject).status, "passed");
    const evidenceId = String(((evaluated.dispatch as JsonObject).evidence_ids as string[])[0]);
    const evidence = f.store.get("evidence", evidenceId);
    assert.equal((evidence.metadata as JsonObject).stage, "canary");
    assert.deepEqual((evidence.metadata as JsonObject).workflow_run_ids, ["run-canary"]);
    assert.equal((evaluated.dispatch as JsonObject).status, "passed");
  } finally { await f.close(); }
});
