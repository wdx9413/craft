import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

test("canonical reconciliation rejects malformed persisted practices and unclassified source observations", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-canonical-reject-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const scope = { kind: "project", id: "project:test" };
  try {
    const service = new CraftService(store);
    service.scopeAliasBind({ scope_kind: "project", scope_id: scope.id, alias_kind: "path", alias: root });
    const practice = { schema: "craft.program-memory-practice.v1", scenario_key: "scene", scenario_definition: {}, statement: "canonical", task_goal: "goal", domain: "general", steps: ["step"], preconditions: [], inputs: [], outputs: ["artifact"], acceptance: ["exists"] };
    const variants = [null, {}, ...Object.keys(practice).map(key => ({ ...practice, [key]: null })), { ...practice, steps: [] }, { ...practice, outputs: [] }, { ...practice, acceptance: [] }, { ...practice, steps: [""] }, { ...practice, inputs: Array(33).fill("x") }, { ...practice, domain: "unsupported" }, { ...practice, statement: "x".repeat(321) }];
    for (const [index, value] of variants.entries()) store.create("evaluation_contract", `malformed-${index}`, { effect: "program_memory_design", scope, budget: { program_memory_practice: value } });
    const candidate = service.evolutionProgramMemoryCapture({ scope, statement: "Unclassified task practice", domain: "general" });
    store.save("program_memory_candidate", String(candidate.id), { ...candidate, evidence_ids: [17, "missing", "no-signature", "wrong-project", "unknown-scene"] });
    const empty = service.evolutionProgramMemoryCapture({ scope, statement: "Practice with no observations", domain: "general" });
    store.save("program_memory_candidate", String(empty.id), { ...empty, evidence_ids: null });
    store.create("workflow_evolution_observation", "no-signature", {});
    store.create("workflow_evolution_observation", "wrong-project", { scenario_signature: { schema: "craft.scenario-signature.v1", scenario_key: "scene", project: { id: "project:other" } } });
    store.create("workflow_evolution_observation", "unknown-scene", { scenario_key: "hashed", scenario_signature: { schema: "craft.scenario-signature.v1", scenario_key: "missing-scene", project: { id: scope.id } } });
    const result = service.evolutionProgramMemoryReconcile({ scope });
    assert.equal(result.processed, 0);
    assert.equal((result.outcomes as { reason: string }[]).filter(item => item.reason === "waiting_scenario_classification").length, 3);
    const original = service.experienceScenarioList;
    service.experienceScenarioList = () => { throw new Error("SceneUnavailable"); };
    assert.equal(service.evolutionProgramMemoryReconcile({ scope }).reason, "waiting_scenario_classification");
    service.experienceScenarioList = original;
    Object.defineProperty(service, "capabilityOwned", { value: true });
    assert.equal(service.evolutionProgramMemoryReconcile({ scope }).reason, "semantic_binding_owner_unavailable");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
