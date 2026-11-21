import { contextReadinessDoctor } from "../core/context-readiness-doctor.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";
import { CodexHookBridge } from "../core/codex-hook-bridge.ts";
import { projectIdentityFromRoot } from "../core/scope-identity.ts";
import { payload, stableDigest } from "../core/digest.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { runProgramMemorySubmissionOnce } from "../deploy/experience-learning/worker.ts";

test("different Hook tasks converge only through their classified scene and frozen canonical practice", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-canonical-practice-")), project = join(root, "project"), data = join(root, "data"); mkdirSync(project);
  const env = { ...process.env, CRAFT_DATA_DIR: data, CRAFT_CONTINUOUS_LEARNING: "0" };
  for (const owner of ["runtime", "experience", "eval", "context"]) { const runtime = await openCapabilityService(owner, env); runtime.close(); }
  const runtime = await openCapabilityService("context", env), service = runtime.service;
  try {
    const scope = projectIdentityFromRoot(project).canonical_scope as JsonObject;
    const experience = service.ownerServices.get("experience")!, evaluation = service.ownerServices.get("eval")!;
    const definition = { summary: "Verify the project root marker", applies_when: "A project change must verify its root marker", excludes: "Other outputs or external side effects" };
    const practice = { schema: "craft.program-memory-practice.v1", scenario_key: "inspect-root", scenario_definition: definition,
      domain: "coding", statement: "Check the project root marker after local changes", steps: ["Check the frozen project root acceptance marker"],
      task_goal: "Verify the project root marker after local code changes", preconditions: ["The project root is bound"],
      inputs: ["Project root"], outputs: ["Observed marker presence"], acceptance: ["The marker exists and no file is changed by verification"] };
    evaluation.evaluationContractDefine({ contract_id: "canonical-design", capability_id: "inspect-root", capability_version: 1, scope,
      input_contract: "Bound project root", output_contract: "Marker acceptance", effect: "program_memory_design", budget: {
        program_memory_practice: practice, program_memory_workflow: { steps: [{ id: "check", type: "assertion", evaluator: "file_exists", path: ".", expected: true }] },
        task_effect_design: { candidate_family: "experience_procedure" },
      } });
    const bridge = new CodexHookBridge(service, undefined, true);
    const observe = async (id: string, file: string, goal: string, scenario: string, scene: JsonObject) => {
      const input = { cwd: project, session_host: "codex", session_id: `session-${id}`, turn_id: `turn-${id}` };
      await bridge.handle("context", { ...input, hook_event_name: "UserPromptSubmit", prompt: goal });
      writeFileSync(join(project, file), "synthetic");
      await bridge.handle("context", { ...input, hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: `edit-${id}`, tool_input: { file_path: join(project, file) }, tool_response: { success: true } });
      await bridge.handle("context", { ...input, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: `verify-${id}`, tool_input: { command: "node --test fixture.test.mjs" }, tool_response: { exit_code: 0 } });
      await bridge.handle("context", { ...input, hook_event_name: "Stop" });
      const journal = bridge.journal.find(input)!;
      const observation = experience.store.list("workflow_evolution_observation", 100).find(item => (item.source as JsonObject).id === journal.id)!;
      assert.ok(observation);
      const classified = service.learningCycleFinalize({ host: "codex", session_id: input.session_id, task_id: journal.id, turn_id: input.turn_id,
        context_receipt_id: journal.context_receipt_id, verified: true, verification_outcome: "passed", verification_ref: stableDigest(journal.verification_receipts),
        project_root: project, scenario_key: scenario, scenario_definition: scene });
      assert.equal((classified.observation as JsonObject).id, observation.id);
    };
    await observe("one", "first.ts", "Fix the first code module and verify the project root", "inspect-root", definition);
    await observe("two", "second.ts", "Repair another code module while checking the root marker", "inspect-root", definition);
    const diagnostics = (service.selfEvolution.listProgramMemory({ scope }).items as JsonObject[]).filter(item => !item.evaluation_design_id);
    assert.equal(diagnostics.length, 2);
    assert.notEqual(diagnostics[0]!.id, diagnostics[1]!.id, "the source diagnostics retain different prose and observed files");
    const originalDesign = evaluation.store.get("evaluation_contract", "canonical-design");
    evaluation.evaluationContractDefine({ contract_id: "alternative-design", capability_id: "inspect-root-alternative", capability_version: 1, scope,
      input_contract: "Bound project root", output_contract: "Alternative criterion", effect: "program_memory_design", budget: originalDesign.budget });
    const ambiguous = service.evolutionProgramMemoryReconcile({ scope });
    assert.ok((ambiguous.outcomes as JsonObject[]).every(item => item.reason === "ambiguous_canonical_practice"));
    const result = await runProgramMemorySubmissionOnce({ async call() { throw new Error("backend must use its owner port"); } }, { ...env, CRAFT_CONTINUOUS_LEARNING: "1", CRAFT_PROGRAM_MEMORY_DESIGNS: JSON.stringify({ [String(scope.id)]: { "inspect-root": "canonical-design" } }) });
    assert.equal(result.processed, 1, JSON.stringify(result));
    const canonical = (service.selfEvolution.listProgramMemory({ scope }).items as JsonObject[]).filter(item => item.evaluation_design_id === "canonical-design");
    assert.equal(canonical.length, 1); assert.equal(canonical[0]!.independent_evidence_count, 2); assert.equal(canonical[0]!.status, "submitted");
    assert.equal((canonical[0]!.source_refs as JsonObject[]).length, 2);
    assert.equal(experience.store.list("experience_procedure", 100).filter(item => item.id === canonical[0]!.procedure_id).length, 1);
    await observe("other", "third.ts", "Repair unrelated output with a different acceptance contract", "other-output", { ...definition, summary: "Verify another output", applies_when: "Different goal and output", excludes: "Project root marker checks" });
    const unrelated = service.evolutionProgramMemoryReconcile({ scope, design_bindings: { "inspect-root": "canonical-design" } });
    assert.ok((unrelated.outcomes as JsonObject[]).some(item => item.reason === "waiting_canonical_practice"));
    assert.equal((service.evolutionProgramMemoryGet({ id: canonical[0]!.id, scope }).candidate as JsonObject).independent_evidence_count, 2);
    const doctor = service.contextReadinessDoctor({});
    assert.equal(((doctor.components as JsonObject).experience as JsonObject).records, 3);
    assert.equal(((doctor.learning_chain as JsonObject).contracts as JsonObject).records, 2);
    assert.equal(service.store.count("workflow_evolution_observation"), 0);
    assert.equal((doctor.verification_gap as JsonObject).host_authentication, "unknown");
    const restricted = contextReadinessDoctor(service.store, {}, { stores: new Map([["context", service.store]]) });
    assert.equal(((restricted.components as JsonObject).experience as JsonObject).records, null);
    assert.equal(((restricted.components as JsonObject).experience as JsonObject).status_counts_status, "owner_unavailable");
    const observedUnavailable = contextReadinessDoctor(service.store, {}, { stores: new Map([["context", service.store]]), readiness: { authentication: "unavailable" } });
    assert.equal((observedUnavailable.verification_gap as JsonObject).reason, "host_auth_unavailable");
    const noClient = { async call() { throw new Error("local owner authorization only"); } };
    assert.equal((await runProgramMemorySubmissionOnce(noClient, { ...env })).reason, "continuous_learning_disabled");
    const originalList = Object.getPrototypeOf(service.store).list;
    Object.getPrototypeOf(service.store).list = function(kind: string, ...args: unknown[]) {
      if (kind === "context_learning_enrollment") throw new Error("EnrollmentReadUnavailable");
      return originalList.call(this, kind, ...args);
    };
    try { await assert.rejects(runProgramMemorySubmissionOnce(noClient, { ...env, CRAFT_CONTINUOUS_LEARNING: "1" }), /EnrollmentReadUnavailable/); }
    finally { Object.getPrototypeOf(service.store).list = originalList; }
    assert.equal((await runProgramMemorySubmissionOnce(noClient, { ...env, CRAFT_LEARNING_PROJECT_SCOPES: JSON.stringify([scope]) })).reason, "continuous_learning_disabled");
    const enrollment = service.store.list("context_learning_enrollment", 1)[0]!;
    service.store.save("context_learning_enrollment", String(enrollment.id), { ...payload(enrollment), status: "disabled" });
    assert.equal((await runProgramMemorySubmissionOnce(noClient, { ...env, CRAFT_CONTINUOUS_LEARNING: "1" })).reason, "waiting_configuration");
    const explicitDisabled = await runProgramMemorySubmissionOnce(noClient, { ...env, CRAFT_CONTINUOUS_LEARNING: "1", CRAFT_LEARNING_PROJECT_SCOPES: JSON.stringify([scope]) });
    assert.equal((explicitDisabled.outcomes as JsonObject[])[0]!.reason, "learning_enrollment_disabled");
    service.store.save("context_learning_enrollment", String(enrollment.id), { ...payload(enrollment), status: "active" });
    for (const alias of service.store.list("scope_alias", 100, item => stableDigest(item.scope) === stableDigest(scope))) service.store.save("scope_alias", String(alias.id), { ...payload(alias), status: "retired" });
    assert.equal((await runProgramMemorySubmissionOnce(noClient, { ...env, CRAFT_CONTINUOUS_LEARNING: "1" })).reason, "waiting_configuration");
    const explicitRevoked = await runProgramMemorySubmissionOnce(noClient, { ...env, CRAFT_CONTINUOUS_LEARNING: "1", CRAFT_LEARNING_PROJECT_SCOPES: JSON.stringify([scope]) });
    assert.equal((explicitRevoked.outcomes as JsonObject[])[0]!.reason, "project_scope_not_registered");


  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
