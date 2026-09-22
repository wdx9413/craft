import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { WorkflowDagKernel } from "../src/workflow-dag.ts";

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
