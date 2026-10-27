import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { WorkflowDagKernel } from "../core/workflow-dag.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-workflow-dag-coverage-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, kernel: new WorkflowDagKernel(store) };
}

const nodes = () => [{ id: "a", type: "action" }, { id: "b", type: "action" }];

test("Workflow DAG validates each edge contract and bounded feedback cycle", async () => {
  const f = await fixture();
  try {
    const valid = f.kernel.validate({ nodes: [{ id: "parallel", type: "parallel", join_policy: "quorum" }, { id: "b", type: "action" }], edges: [
      { from: "parallel", to: "b", kind: "condition", predicate_ref: "predicate" },
      { from: "parallel", to: "b", kind: "compensation", compensation_ref: "undo" },
      { from: "b", to: "parallel", kind: "retry", max_attempts: 1, on_exhausted: "handoff" },
      { from: "b", to: "parallel", kind: "human_resume", approval_ref: "approval" },
    ] });
    assert.equal((valid.nodes as JsonObject[])[0]!.join_policy, "quorum");
    assert.equal((valid.edges as JsonObject[]).length, 4);
    assert.equal(((f.kernel.validate({ nodes: [{ id: "default-parallel", type: "parallel" }] }).nodes as JsonObject[])[0]!).join_policy, "all");
    assert.throws(() => f.kernel.validate({ nodes: [{ id: "p", type: "parallel", join_policy: "bad" }] }), /join_policy/u);
    assert.throws(() => f.kernel.validate({ nodes: [{ id: "bad-effect", type: "action", side_effect: "network" }] }), /unsupported side_effect/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: {} }), /edges must be an array/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: [null] }), /edges\[0\] must be an object/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: [{ id: "x", from: "a", to: "b", kind: "success" }, { id: "x", from: "a", to: "b", kind: "success" }] }), /duplicate edge/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: [{ from: "a", to: "missing", kind: "success" }] }), /unknown node/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: [{ from: "a", to: "b", kind: "bad" }] }), /unsupported kind/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: [{ from: "a", to: "b", kind: "condition" }] }), /predicate_ref/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: [{ from: "a", to: "b", kind: "retry", max_attempts: 0 }] }), /max_attempts/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: [{ from: "a", to: "b", kind: "retry", max_attempts: 1, on_exhausted: "bad" }] }), /on_exhausted/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: [{ from: "a", to: "b", kind: "compensation" }] }), /compensation_ref/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: [{ from: "a", to: "b", kind: "human_resume" }] }), /approval_ref/u);
    assert.throws(() => f.kernel.validate({ nodes: nodes(), edges: [{ from: "a", to: "b", kind: "success" }, { from: "b", to: "a", kind: "failure" }] }), /unbounded cycle/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Workflow DAG retains lifecycle, version and checkpoint alternatives", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.kernel.save({ workflow_id: "bad-lifecycle", name: "Bad", lifecycle: "unknown", nodes: nodes() }), /lifecycle/u);
    assert.throws(() => f.kernel.save({ workflow_id: "bad-derived", name: "Bad", derived_from: [], nodes: nodes() }), /derived_from/u);
    const saved = f.kernel.save({ workflow_id: "wf", name: "Workflow", description: "", derived_from: { procedure: "p" }, nodes: nodes() }).workflow as JsonObject;
    assert.equal((f.kernel.get({ workflow_id: saved.id, version: saved.version }).workflow as JsonObject).id, saved.id);
    assert.equal((f.kernel.get({ workflow_id: saved.id }).workflow as JsonObject).id, saved.id);
    const checkpoint = f.kernel.checkpoint({ workflow_id: saved.id, run_id: "run" }).checkpoint as JsonObject;
    assert.equal(checkpoint.resume_action, "resume");
    assert.equal(f.kernel.resume({ checkpoint_id: checkpoint.id, state_digest: "sha256:different" }).status, "needs_replan");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Workflow DAG verification and routing stay bound to the exact held-out candidate evaluation", async () => {
  const f = await fixture();
  try {
    const saved = f.kernel.save({ workflow_id: "wf-evaluated", name: "Workflow", nodes: nodes() }).workflow as JsonObject;
    const candidate = f.kernel.transition({ workflow_id: saved.id, target: "candidate", reason: "freeze candidate" }).workflow as JsonObject;
    const badRuns = [
      { id: "bad-verdict", verdict: "failed", split: "held_out", subject_type: "workflow_dag", subject_id: candidate.id, subject_version: candidate.version },
      { id: "bad-split", verdict: "passed", split: "development", subject_type: "workflow_dag", subject_id: candidate.id, subject_version: candidate.version },
      { id: "bad-type", verdict: "passed", split: "held_out", subject_type: "workflow", subject_id: candidate.id, subject_version: candidate.version },
      { id: "bad-subject", verdict: "passed", split: "held_out", subject_type: "workflow_dag", subject_id: "other", subject_version: candidate.version },
      { id: "bad-version", verdict: "passed", split: "held_out", subject_type: "workflow_dag", subject_id: candidate.id, subject_version: Number(candidate.version) + 1 },
    ];
    for (const run of badRuns) {
      f.store.create("evaluation_run", run.id, run);
      assert.throws(() => f.kernel.transition({ workflow_id: candidate.id, target: "verified", reason: "verify", evaluation_run_id: run.id }), /exact Workflow DAG candidate version/u);
    }
    const evaluation = f.store.create("evaluation_run", "exact-held-out", { verdict: "passed", split: "held_out",
      subject_type: "workflow_dag", subject_id: candidate.id, subject_version: candidate.version });
    const verified = f.kernel.transition({ workflow_id: candidate.id, target: "verified", reason: "verified", evaluation_run_id: evaluation.id }).workflow as JsonObject;
    assert.equal(verified.evaluated_candidate_version, candidate.version);
    assert.equal(verified.evaluation_run_version, evaluation.version);

    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...evaluationPayload } = evaluation;
    f.store.save("evaluation_run", String(evaluation.id), { ...evaluationPayload, verdict: "failed" });
    f.kernel.transition({ workflow_id: candidate.id, target: "canary", reason: "canary" });
    assert.throws(() => f.kernel.transition({ workflow_id: candidate.id, target: "routable", reason: "route",
      evaluation_run_id: "different-run", canary_receipt: "canary" }), /bound to its verified candidate/u);
    const routable = f.kernel.transition({ workflow_id: candidate.id, target: "routable", reason: "route",
      canary_receipt: "canary" }).workflow as JsonObject;
    assert.equal(routable.evaluation_run_id, evaluation.id);
    assert.equal(routable.evaluation_run_version, evaluation.version);

    const altered = f.kernel.save({ workflow_id: "wf-altered-binding", name: "Altered", nodes: nodes() }).workflow as JsonObject;
    const alteredCandidate = f.kernel.transition({ workflow_id: altered.id, target: "candidate", reason: "freeze" }).workflow as JsonObject;
    const alteredEvaluation = f.store.create("evaluation_run", "altered-held-out", { verdict: "passed", split: "held_out",
      subject_type: "workflow_dag", subject_id: alteredCandidate.id, subject_version: alteredCandidate.version });
    f.kernel.transition({ workflow_id: altered.id, target: "verified", reason: "verified", evaluation_run_id: alteredEvaluation.id });
    f.kernel.transition({ workflow_id: altered.id, target: "canary", reason: "canary" });
    const canaryWorkflow = f.store.get("workflow_dag", String(altered.id));
    const { id: _workflowId, version: _workflowVersion, created_at: _workflowCreated, updated_at: _workflowUpdated, ...canaryPayload } = canaryWorkflow;
    f.store.save("workflow_dag", String(altered.id), { ...canaryPayload,
      evaluated_candidate_version: Number(alteredCandidate.version) + 1 });
    assert.throws(() => f.kernel.transition({ workflow_id: altered.id, target: "routable", reason: "bad binding",
      canary_receipt: "canary" }), /original passed held-out evaluation/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
