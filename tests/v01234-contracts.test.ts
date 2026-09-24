import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { EvaluationContractKernel } from "../core/evaluation-contract.ts";
import { digestContract, normalizeTaskSemantics, validateHarness } from "../core/runtime-contracts.ts";

test("v0.12.34 normalizes task semantics and keeps turn mode lightweight", () => {
  assert.deepEqual(normalizeTaskSemantics({ goal: "chat", mode: "turn", target: { subject: "ignored" } }), { goal: "chat", mode: "turn" });
  const semantics = normalizeTaskSemantics({ goal: "ship", mode: "execute", target: { subject: "change", scope: "repo", desired_state: "tests pass" }, plan: { strategy: "safe", steps: [{ id: "edit", description: "edit files", action: "patch", preconditions: ["clean"], failure_action: "replan" }] }, acceptance: { criteria: [{ id: "tests" }], observer: "pytest", artifact_refs: ["artifact:report"] } });
  assert.equal(semantics.plan?.steps[0]?.failure_action, "replan");
  assert.deepEqual(semantics.accept?.criteria, ["tests"]);
  assert.deepEqual(semantics.accept?.artifact_refs, ["artifact:report"]);
  assert.equal(digestContract(semantics), digestContract(semantics));
  assert.throws(() => normalizeTaskSemantics({ goal: "run", mode: "execute" }), /requires accept criteria/);
  assert.throws(() => normalizeTaskSemantics({ goal: "run", mode: "execute", acceptance: { criteria: [42] } }), /string or criterion object/);
  assert.deepEqual(normalizeTaskSemantics({ goal: "default mode" }).mode, "goal");
  assert.throws(() => normalizeTaskSemantics({ goal: "bad", mode: "unknown" }), /Unsupported interaction mode/);
  const sparse = normalizeTaskSemantics({
    goal: "sparse",
    mode: "plan",
    target: { subject: "thing" },
    plan: { steps: [{ description: "inspect", failure_action: "not-supported" }], strategy: "minimal" },
    accept: { criteria: [
      "string criterion",
      { name: "named criterion" },
      { description: "described criterion" },
    ] },
  });
  assert.equal(sparse.plan?.steps[0]?.id, "step_1");
  assert.deepEqual(sparse.accept?.criteria, ["string criterion", "named criterion", "described criterion"]);
  assert.throws(() => normalizeTaskSemantics({ goal: "bad target", target: { subject: "" } }), /target.subject/);
  assert.throws(() => normalizeTaskSemantics({ goal: "bad accept", accept: { criteria: [{ nope: true }] } }), /accept.criteria/);
  assert.throws(() => normalizeTaskSemantics({ goal: "bad accept", accept: { criteria: [null] } }), /string or criterion object/);
  assert.throws(() => normalizeTaskSemantics({ goal: "bad plan", plan: { steps: [{ description: "x", action: "" }] } }), /plan.steps\[0\].action/);
  assert.throws(() => normalizeTaskSemantics({ goal: "bad target", target: { subject: "x", scope: "" } }), /target.scope/);
  assert.throws(() => normalizeTaskSemantics({ goal: "bad target", target: { subject: "x", desired_state: "" } }), /target.desired_state/);
  assert.throws(() => normalizeTaskSemantics({ goal: "bad accept", accept: { criteria: ["x"], observer: "" } }), /accept.observer/);
  assert.throws(() => normalizeTaskSemantics({ goal: "bad accept", accept: { criteria: ["x"], artifact_refs: [""] } }), /accept.artifact_ref/);
  assert.deepEqual(normalizeTaskSemantics({ goal: "empty plan", plan: { steps: [] } }).plan?.steps, []);
  assert.throws(() => normalizeTaskSemantics({ goal: "missing accept", mode: "verify" }), /requires accept criteria/);
});

test("v0.12.34 validates the four Harness faces and Environment composition", () => {
  const harness = validateHarness({ context: ["history", "knowledge", "state"], tools: ["craft_knowledge_search"], permission: { effect: "read_only" }, environment: { sandbox: "none", runtime: "host" } });
  assert.equal(harness.environment.runtime, "host");
  assert.deepEqual(validateHarness({ environment: { sandbox: "none", runtime: "host", network: "deny" } }).tools, []);
  assert.deepEqual(validateHarness({ context: [], tools: [], environment: { sandbox: "none", runtime: "host", network: "restricted" } }).environment.network, "restricted");
  assert.throws(() => validateHarness({ environment: { sandbox: "", runtime: "host" } }), /environment.sandbox/);
  assert.throws(() => validateHarness({ environment: { sandbox: "none", runtime: "host" }, tools: [""] }), /harness.tools/);
  assert.deepEqual(validateHarness({ environment: { sandbox: "none", runtime: "host" }, context: "history" as never }).context, []);
  assert.throws(() => validateHarness({ context: ["unknown"], environment: { sandbox: "none", runtime: "host" } }), /unsupported member/);
  assert.throws(() => validateHarness({}), /harness.environment/);
  assert.throws(() => validateHarness({ context: [], environment: { sandbox: "none" } }), /environment.runtime/);
});

test("v0.12.34 Evaluation Contract advances monotonically to routeable", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-v01234-contract-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const kernel = new EvaluationContractKernel(store);
    const created = kernel.define({ capability_id: "memory", capability_version: 1, input_contract: "query", output_contract: "bounded-items" });
    const id = String((created.contract as Record<string, unknown>).id);
    assert.equal(kernel.define({ contract_id: id, capability_id: "memory", capability_version: 1, input_contract: "query", output_contract: "bounded-items" }).idempotent, true);
    assert.throws(() => kernel.record({ contract_id: id, stage: "integration_passed" }), /one gate/);
    for (const stage of ["fixture_passed", "conformance_passed", "integration_passed", "host_verified", "business_eligible", "routeable"] as const) kernel.record({ contract_id: id, stage, evidence: [`eval:${stage}`] });
    assert.equal((kernel.get(id).contract as Record<string, unknown>).status, "routeable");
    assert.throws(() => kernel.record({ contract_id: id, stage: "mechanism_passed" }), /cannot move backwards/);
    assert.throws(() => kernel.define({ capability_id: "", capability_version: 1, input_contract: "q", output_contract: "r" }), /requires capability/);
    assert.throws(() => kernel.define({ capability_id: "memory", capability_version: 0, input_contract: "q", output_contract: "r" }), /requires capability/);
    assert.throws(() => kernel.define({ capability_id: "memory", capability_version: 1, input_contract: "", output_contract: "r" }), /requires capability/);
    assert.throws(() => kernel.define({ capability_id: "memory", capability_version: 1, input_contract: "q", output_contract: "" }), /requires capability/);
    assert.throws(() => kernel.define({ capability_id: "memory", capability_version: 1, input_contract: "q", output_contract: "r", contract_id: id }), /idempotency conflict/);
    assert.throws(() => kernel.record({ contract_id: id, stage: "not-a-stage" as never }), /Unsupported evaluation stage/);
    assert.throws(() => kernel.record({ contract_id: id, stage: "fixture_passed", metrics: { score: 1 } }), /cannot move backwards/);
    const second = kernel.define({ capability_id: "knowledge", capability_version: 1, input_contract: "q", output_contract: "r" });
    const secondId = String((second.contract as Record<string, unknown>).id);
    await Promise.resolve();
    store.save("evaluation_contract", secondId, { ...(store.get("evaluation_contract", secondId)), stage_history: undefined });
    kernel.record({ contract_id: secondId, stage: "fixture_passed", metrics: { score: 1 } });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
