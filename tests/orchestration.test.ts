import assert from "node:assert/strict";
import test from "node:test";
import { dispatchNodes, normalizeNodes, planStatus, submitNode } from "../src/orchestration.ts";

const base = () => normalizeNodes([
  { id: "research", role: "researcher", objective: "find", profile_ids: ["astra", "luna"] },
  { id: "review", role: "reviewer", objective: "check", profile_ids: ["sol"], depends_on: ["research"] },
]);

test("orchestration validates DAGs, profiles, and side effects", () => {
  assert.equal(base().length, 2);
  assert.throws(() => normalizeNodes([]), /At least one/);
  assert.throws(() => normalizeNodes([null]), /must be an object/);
  assert.throws(() => normalizeNodes([{}]), /requires id/);
  assert.throws(() => normalizeNodes([{ id: "x", role: "r", objective: "o", profile_ids: ["a"] },
    { id: "x", role: "r", objective: "o", profile_ids: ["b"] }]), /Duplicate/);
  assert.throws(() => normalizeNodes([{ id: "x", role: "r", objective: "o", profile_ids: ["a"], depends_on: "x" }]), /depends_on/);
  assert.throws(() => normalizeNodes([{ id: "x", role: "r", objective: "o", profile_ids: [] }]), /profile_ids/);
  assert.throws(() => normalizeNodes([{ id: "x", role: "r", objective: "o" }]), /profile_ids/);
  assert.throws(() => normalizeNodes([{ id: "x", role: "r", objective: "o", profile_ids: [""] }]), /profile_ids/);
  assert.throws(() => normalizeNodes([{ id: "x", role: "r", objective: "o", profile_ids: ["a", "a"] }]), /unique/);
  assert.throws(() => normalizeNodes([{ id: "x", role: "r", objective: "o", profile_ids: ["a"], side_effect: "bad" }]), /side effect/);
  assert.throws(() => normalizeNodes([{ id: "x", role: "r", objective: "o", profile_ids: ["a"], depends_on: ["x"] }]), /itself/);
  assert.throws(() => normalizeNodes([{ id: "x", role: "r", objective: "o", profile_ids: ["a"], depends_on: ["missing"] }]), /unknown dependency/);
  assert.throws(() => normalizeNodes([
    { id: "x", role: "r", objective: "o", profile_ids: ["a"], depends_on: ["y"] },
    { id: "y", role: "r", objective: "o", profile_ids: ["a"], depends_on: ["x"] },
  ]), /cycle/);
});

test("orchestration leases ready work, routes failures, and blocks descendants", () => {
  const initial = base();
  assert.equal(planStatus(initial), "running");
  assert.equal(dispatchNodes(initial, 0, "host").leases.length, 0);
  assert.throws(() => dispatchNodes(initial, Number.NaN, "host"), /capacity/);
  assert.throws(() => dispatchNodes([{ ...initial[0], route_index: 99 }], 1, "host"), /route_index/);
  const first = dispatchNodes(initial, 1, "host");
  assert.equal(first.leases.length, 1);
  assert.equal(dispatchNodes(first.nodes, 1, "host").leases.length, 0);
  assert.throws(() => submitNode(first.nodes, "missing", "passed", "agent_reported"), /Unknown lease/);
  assert.throws(() => submitNode(first.nodes, String(first.leases[0].lease_id), "bad", "agent_reported"), /verdict/);
  assert.throws(() => submitNode(first.nodes, String(first.leases[0].lease_id), "passed", "bad"), /provenance/);
  const rerouted = submitNode(first.nodes, String(first.leases[0].lease_id), "failed", "model_judged");
  assert.equal(rerouted[0].status, "pending");
  assert.equal(dispatchNodes(rerouted, 2, "host").leases[0].profile_id, "luna");
  const retried = dispatchNodes(rerouted, 1, "host");
  const failed = submitNode(retried.nodes, String(retried.leases[0].lease_id), "failed", "program_verified");
  assert.equal(failed[1].status, "blocked");
  const chain = normalizeNodes([
    { id: "a", role: "r", objective: "a", profile_ids: ["p"] },
    { id: "b", role: "r", objective: "b", profile_ids: ["p"], depends_on: ["a"] },
    { id: "c", role: "r", objective: "c", profile_ids: ["p"], depends_on: ["b"] },
  ]);
  const leasedChain = dispatchNodes(chain, 1, "host");
  const blockedChain = submitNode(leasedChain.nodes, String(leasedChain.leases[0].lease_id), "failed", "program_verified");
  assert.deepEqual(blockedChain.map((node) => node.status), ["failed", "blocked", "blocked"]);
  assert.equal(planStatus(failed), "failed");
  const passedResearch = submitNode(first.nodes, String(first.leases[0].lease_id), "passed", "human_approved");
  const review = dispatchNodes(passedResearch, 2, "host");
  const completed = submitNode(review.nodes, String(review.leases[0].lease_id), "passed", "agent_reported");
  assert.equal(planStatus(completed), "completed");
  const stale = completed.map((node, index) => index ? node : { ...node, lease_id: "old" });
  assert.throws(() => submitNode(stale, "old", "passed", "agent_reported"), /not active/);
});
