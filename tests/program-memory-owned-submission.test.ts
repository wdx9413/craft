import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectIdentityFromRoot } from "../core/scope-identity.ts";
import { openOwnedLearningClients } from "../deploy/experience-learning/owned-client.ts";
import { projectExperienceDirectory } from "../core/project-experience-directory.ts";
import { AUTOMATIC_SIGNOFF_POLICY } from "@craft/capability-experience/scenario-evaluation";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";
import { stableDigest } from "../core/digest.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { runProgramMemorySubmissionOnce } from "../deploy/experience-learning/worker.ts";

test("Context submits through independent Experience and Eval owners without copying their authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-program-owned-"));
  const env = { ...process.env, CRAFT_DATA_DIR: join(root, "data"), CRAFT_CONTINUOUS_LEARNING: "0" };
  const project = join(root, "project"); mkdirSync(project);
  const scope = projectIdentityFromRoot(project).canonical_scope as { kind: string; id: string };
  const owners = [];
  try {
    for (const name of ["memory", "runtime", "experience", "eval"]) { const runtime = await openCapabilityService(name, env); runtime.close(); }
    const context = await openCapabilityService("context", env); owners.push(context);
    const experience = context.service.ownerServices.get("experience")!;
    const evaluation = context.service.ownerServices.get("eval")!;
    assert.ok(experience); assert.ok(evaluation);
    for (const service of [context.service, experience, evaluation]) service.store.create("scope_alias", "test-alias", {
      status: "active", alias_kind: "path", alias: project, alias_digest: stableDigest(project), scope });
    const design = evaluation.evaluationContractDefine({ contract_id: "design", capability_id: "inspect", capability_version: 1,
      input_contract: "input", output_contract: "output", scope, effect: "program_memory_design", budget: {
        task_effect_design: { candidate_family: "experience_procedure" },
        program_memory_workflow: { steps: [{ id: "observe", type: "assertion", evaluator: "file_exists", path: ".", expected: true }] },
      } }).contract as JsonObject;
    const ids = ["one", "two"].map(id => {
      const evidence = experience.evidenceRecord({ source_type: "host_completion_signal", confidence: "bounded", claim: "Observed fixture verification",
        metadata: { provenance: "host_completion_signal", project_scope_id: scope.id, verification_outcome: "passed",
          source_session_id: `session-${id}`, task_id: id, content_stored: false } });
      const observation = experience.workflowEvolutionObserve({ sanitized: true, content_stored: false, outcome: "passed", source_kind: "host:codex",
        source_id: id, source_session_id: `session-${id}`, source_digest: id, scope: scope.id, scenario_key: "inspect", scenario_signature: { project: { id: scope.id }, scenario_key: "inspect" }, evidence_ids: [evidence.id] }).observation as JsonObject;
      context.store.create("program_memory_verified_observation", String(observation.id), { scope, evidence_id: evidence.id,
        source_digest: id, source_session_id: `session-${id}`, task_id: id });
      return observation.id;
    });
    const captured = context.service.evolutionProgramMemoryCapture({ statement: "Inspect project state", scenario_key: "inspect", scope,
      evaluation_contract_id: design.id, evidence_ids: ids });
    assert.equal(captured.independent_evidence_count, 2);
    const submitted = context.service.evolutionProgramMemorySubmit({ id: captured.id, scope });
    assert.equal(submitted.status, "submitted");
    assert.equal(context.service.evolutionProgramMemorySubmit({ id: captured.id, scope }).procedure_id, submitted.procedure_id);
    assert.equal(context.store.list("workflow_evolution_observation", 10).length, 0);
    assert.equal(context.store.find("experience_procedure", String(submitted.procedure_id)), null);
    assert.ok(experience.store.find("experience_procedure", String(submitted.procedure_id)));
    assert.equal(experience.store.find("program_memory_candidate", String(captured.id)), null);
    assert.equal(context.store.find("evaluation_contract", String(design.id)), null);
    const directory = projectExperienceDirectory(experience.store, scope.id, project, true);
    const cases = (label: string) => [{ case_id: label, project_root: project, inputs: {} }];
    const shadowCases = cases("shadow"), heldCases = cases("held"), canaryCases = cases("canary");
    writeFileSync(join(directory, "experience-scenarios.json"), JSON.stringify({ schema: "craft.experience-scenario-catalog.v1", scenarios: [{
      scenario_key: "inspect", evaluation: { schema: "craft.experience-evaluation.v1", signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY,
        stages: { shadow: { cases: shadowCases, case_set_ref: stableDigest(shadowCases) },
          held_out: { cases: heldCases, case_set_ref: stableDigest(heldCases), independent_of_training: true, training_set_digest: stableDigest(shadowCases) },
          canary: { cases: canaryCases, case_set_ref: stableDigest(canaryCases) } } } }] }));
    context.close(); owners.length = 0;
    const result = await runProgramMemorySubmissionOnce({ async call() { throw new Error("MCP bypass forbidden"); } }, {
      ...env, CRAFT_CONTINUOUS_LEARNING: "1", CRAFT_LEARNING_PROJECT_SCOPES: JSON.stringify([scope]),
    });
    assert.equal(result.processed, 1);
    assert.equal((result.outcomes as JsonObject[])[0]!.status, "submitted");
    const hidden = await openOwnedLearningClients(env);
    try {
      assert.equal((await hidden.experience.call("craft_experience_learning_evaluation_dispatch_list")).count, 0);
      const dispatchId = (result.outcomes as JsonObject[])[0]!.dispatch_id;
      await assert.rejects(hidden.experience.call("craft_experience_learning_evaluation_run", { dispatch_id: dispatchId }), /ScopeForbidden/);
      await assert.rejects(hidden.knowledge.call("craft_knowledge_search", {}), /OwnerUnavailable/);
      await assert.rejects(hidden.context.call("craft_missing", {}), /ToolUnavailable|ToolRejected/);
      await assert.rejects(hidden.context.call("craft_component_readiness_get", {}), /ToolUnavailable|ToolRejected/);
      const ready = await hidden.context.call("craft_evaluation_contract_get", { contract_id: design.id });
      assert.ok(ready);
      await assert.rejects(hidden.context.call("craft_trace_get", { trace_id: "missing" }), /ToolRejected|ToolUnavailable/);
    }
    finally { hidden.close(); }
    await assert.rejects(openOwnedLearningClients({ ...env, CRAFT_LEARNING_PROJECT_SCOPES: '[{"kind":"global","id":"all"}]' }), /ConfigurationError/);
    const clients = await openOwnedLearningClients({ ...env, CRAFT_LEARNING_PROJECT_SCOPES: JSON.stringify([scope]) });
    try {
      const queue = await clients.experience.call("craft_experience_learning_evaluation_dispatch_list");
      assert.equal(queue.count, 1);
      const dispatch = (queue.dispatches as JsonObject[])[0]!;
      const shadow = await clients.experience.call("craft_experience_learning_evaluation_run", { dispatch_id: dispatch.id });
      assert.equal((shadow.dispatch as JsonObject).status, "passed", JSON.stringify(shadow));
      assert.equal((shadow.next_dispatch as JsonObject).stage, "held_out");
      await assert.rejects(clients.experience.call("craft_experience_learning_evaluation_result", { dispatch_id: (shadow.next_dispatch as JsonObject).id }), /trusted paired/);
      await assert.rejects(clients.experience.call("craft_experience_learning_evaluation_run", { dispatch_id: "missing" }), /ToolRejected|ToolUnavailable/);
      await assert.rejects(clients.context.call("craft_evolution_program_memory_submit", { id: captured.id }), /ToolRejected|ToolUnavailable/);
      await clients.context.call("craft_evolution_program_memory_submission_due", { scope });
    } finally { clients.close(); }
    const worker = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url)), "--once"], {
      env: { ...env, CRAFT_CONTINUOUS_LEARNING: "1", CRAFT_LEARNING_COMPONENTS: "experience", CRAFT_LEARNING_MODEL_HOST: "claude-code", CRAFT_LEARNING_PROJECT_SCOPES: JSON.stringify([scope]) },
      encoding: "utf8", timeout: 20_000,
    });
    assert.equal(worker.status, 0, worker.stderr + worker.stdout);
    assert.ok(JSON.parse(worker.stdout.trim()).evaluation);
    assert.equal(existsSync(join(env.CRAFT_DATA_DIR, "craft.db")) && lstatSync(join(env.CRAFT_DATA_DIR, "craft.db")).isFile(), false);
  } finally { for (const owner of owners) owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("standalone Experience owned worker runs without creating Context or a shared store", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-worker-alone-"));
  const env = { ...process.env, CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "0", CRAFT_LEARNING_COMPONENTS: "experience", CRAFT_LEARNING_MODEL_HOST: "" };
  try {
    const owner = await openCapabilityService("experience", env); owner.close();
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../deploy/experience-learning/worker.ts", import.meta.url)), "--once"], { env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(existsSync(join(root, "context", "publication.db")), false);
    assert.equal((JSON.parse(result.stdout.trim()).program_memory_submission as JsonObject).reason, "continuous_learning_disabled");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
