import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("runtime driver pauses effects for approval, resumes exactly once, and aggregates child-agent resources", async () => {
  const root = join(tmpdir(), `craft-runtime-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Runtime", goal: "Run safely" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "Restricted", allowed_effects: ["read_only", "local_write"],
      require_approval_for: ["local_write"], max_concurrency: 1, budget: { tokens: 10 } });
    const started = service.runtimeRunStart({ run_id: "run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "parent", kind: "agent", effect: "local_write",
        objective: "change one file", agent_profile_id: "worker" }] });
    assert.equal((started.run as JsonObject).status, "running");
    assert.match(String((started.run as JsonObject).environment_fingerprint), /^[a-f0-9]{64}$/);

    const first = service.runtimeDispatch({ run_id: "run", claimed_by: "host" });
    assert.deepEqual(first.operations, []);
    assert.equal((service.runtimeOperationGet({ operation_id: "parent" }).operation as JsonObject).status, "awaiting_approval");
    assert.throws(() => service.runtimeOperationDecision({ operation_id: "parent", decision: "approved", actor: "human" }),
      /approval/);
    const approved = service.runtimeOperationDecision({ operation_id: "parent", decision: "approve", actor: "human" });
    assert.equal((approved.operation as JsonObject).status, "pending");

    const dispatched = service.runtimeDispatch({ run_id: "run", claimed_by: "host" });
    const parent = (dispatched.operations as JsonObject[])[0];
    assert.equal(parent.operation_id, "parent");
    const completed = service.runtimeOperationSubmit({ operation_id: "parent", lease_id: parent.lease_id, claimed_by: "host",
      verdict: "passed", costs: { tokens: 3 }, children: [{ operation_id: "child", kind: "agent", effect: "read_only",
        objective: "review", agent_profile_id: "reviewer" }] });
    assert.equal((completed.run as JsonObject).status, "running");
    const child = (service.runtimeDispatch({ run_id: "run", claimed_by: "host" }).operations as JsonObject[])[0];
    service.runtimeOperationSubmit({ operation_id: "child", lease_id: child.lease_id, claimed_by: "host",
      verdict: "passed", costs: { tokens: 2 }, idempotency_key: "child-final" });
    assert.equal(((service.runtimeOperationSubmit({ operation_id: "child", lease_id: child.lease_id, claimed_by: "host",
      verdict: "passed", idempotency_key: "child-final" }).run as JsonObject).id), "run");
    const final = service.runtimeRunGet({ run_id: "run" }).run as JsonObject;
    assert.equal(final.status, "completed");
    assert.equal((final.resource_ledger as JsonObject).tokens, 5);
    assert.deepEqual((service.runtimeDispatch({ run_id: "run", claimed_by: "host" }).operations), []);
    assert.equal((service.runtimeRunResume({ run_id: "run" }).next_action as JsonObject).kind, "completed");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("runtime policy and environment fingerprints invalidate promotion eligibility without erasing historical evidence", async () => {
  const root = join(tmpdir(), `craft-runtime-fingerprint-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Fingerprint", goal: "Compare safely" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "Policy", allowed_effects: ["read_only"] });
    assert.throws(() => service.runtimePolicySave({ name: "Bad", allowed_effects: ["network"] }), /Runtime policy effects/);
    assert.throws(() => service.runtimePolicySave({ name: "Bad approval", allowed_effects: ["read_only"],
      require_approval_for: ["local_write"] }), /Runtime policy effects/);
    const workflow = service.workflowSave({ workflow_id: "trial-workflow", name: "Trial workflow" });
    const trial = service.trialStart({ task_id: task.id, subject_type: "workflow", subject_id: workflow.id,
      subject_version: workflow.version });
    const traced = service.runtimeRunStart({ task_id: task.id, trial_id: trial.id, policy_id: policy.id,
      environment: { tags: ["one"], ready: true }, operations: [{ operation_id: "traced", kind: "agent", effect: "read_only", objective: "inspect" }] });
    assert.equal((service.trialGet({ trial_id: trial.id }).trace as JsonObject[]).some((event) => event.event_type === "runtime.started"), true);
    assert.equal((traced.operations as JsonObject[]).length, 1);
    assert.equal((service.runtimeRunResume({ run_id: (traced.run as JsonObject).id }).next_action as JsonObject).kind, "dispatch");
    assert.throws(() => service.runtimeRunStart({ task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "bad-effect", kind: "agent", effect: "external_write", objective: "bad" },
    ] }), /not allowed/);
    assert.throws(() => service.runtimeRunStart({ task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "orphan", kind: "agent", effect: "read_only", objective: "orphan", parent_operation_id: "missing" },
    ] }), /dependencies must belong/);
    assert.throws(() => service.runtimeRunStart({ task_id: task.id, policy_id: policy.id, environment: {}, operations: [] }), /must not be empty/);
    assert.throws(() => service.runtimeRunStart({ task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "duplicate", kind: "agent", effect: "read_only", objective: "one" },
      { operation_id: "duplicate", kind: "agent", effect: "read_only", objective: "two" },
    ] }), /must be unique/);
    assert.throws(() => service.runtimeRunStart({ task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "self", kind: "agent", effect: "read_only", objective: "self", parent_operation_id: "self" },
    ] }), /cannot parent itself/);
    const started = service.runtimeRunStart({ task_id: task.id, policy_id: policy.id, environment: { image: "one" },
      operations: [{ operation_id: "read", kind: "agent", effect: "read_only", objective: "inspect" }] });
    const run = started.run as JsonObject;
    assert.throws(() => service.runtimeRunStart({ task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "read", kind: "agent", effect: "read_only", objective: "existing" },
    ] }), /already exists/);
    assert.equal((service.runtimePromotionEligibility({ run_id: run.id, policy_id: policy.id,
      environment: { image: "one" } }).eligible), true);
    assert.equal((service.runtimePromotionEligibility({ run_id: run.id, policy_id: policy.id,
      environment: { image: "two" } }).eligible), false);
    const updatedPolicy = service.runtimePolicySave({ policy_id: policy.id, name: "Policy v2", allowed_effects: ["read_only"] });
    assert.equal((service.runtimePromotionEligibility({ run_id: run.id, policy_id: updatedPolicy.id,
      policy_version: updatedPolicy.version, environment: { image: "one" } }).eligible), false);

    const approval = service.runtimePolicySave({ name: "Approval", allowed_effects: ["local_write"], require_approval_for: ["local_write"] });
    service.runtimeRunStart({ run_id: "reject-run", task_id: task.id, policy_id: approval.id, environment: {}, operations: [
      { operation_id: "reject-op", kind: "agent", effect: "local_write", objective: "reject" },
    ] });
    service.runtimeDispatch({ run_id: "reject-run", claimed_by: "host" });
    assert.equal((service.runtimeOperationDecision({ operation_id: "reject-op", decision: "reject", actor: "human" }).run as JsonObject).status, "failed");
    assert.throws(() => service.runtimeOperationDecision({ operation_id: "reject-op", decision: "approve", actor: "human" }), /not awaiting/);

    service.runtimeRunStart({ run_id: "lease-run", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "lease-op", kind: "agent", effect: "read_only", objective: "lease" },
    ] });
    const lease = (service.runtimeDispatch({ run_id: "lease-run", claimed_by: "host" }).operations as JsonObject[])[0];
    assert.throws(() => service.runtimeOperationSubmit({ operation_id: "lease-op", lease_id: "wrong", claimed_by: "host", verdict: "passed" }), /lease does not match/);
    assert.throws(() => service.runtimeOperationSubmit({ operation_id: "lease-op", lease_id: lease.lease_id, claimed_by: "host", verdict: "passed",
      children: [{ operation_id: "bad-child", kind: "agent", effect: "external_write", objective: "bad" }] }), /not allowed/);
    assert.equal((service.runtimeOperationGet({ operation_id: "lease-op" }).operation as JsonObject).status, "leased");

    const defaults = service.runtimePolicySave({ name: "Defaults" });
    assert.deepEqual(defaults.allowed_effects, ["read_only"]);
    service.runtimeRunStart({ run_id: "invalid-verdict", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "invalid-op", kind: "agent", effect: "read_only", objective: "invalid" },
    ] });
    const invalidLease = (service.runtimeDispatch({ run_id: "invalid-verdict", claimed_by: "host" }).operations as JsonObject[])[0];
    assert.throws(() => service.runtimeOperationSubmit({ operation_id: "invalid-op", lease_id: invalidLease.lease_id, claimed_by: "host", verdict: "unknown" }), /Unsupported runtime/);
    service.runtimeRunStart({ run_id: "duplicate-child", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "child-parent", kind: "agent", effect: "read_only", objective: "parent" },
    ] });
    const childParent = (service.runtimeDispatch({ run_id: "duplicate-child", claimed_by: "host" }).operations as JsonObject[])[0];
    assert.throws(() => service.runtimeOperationSubmit({ operation_id: "child-parent", lease_id: childParent.lease_id, claimed_by: "host", verdict: "passed",
      children: [{ operation_id: "child-parent", kind: "agent", effect: "read_only", objective: "duplicate" }] }), /already exists/);

    const limited = service.runtimePolicySave({ name: "Limited", allowed_effects: ["read_only"], budget: { tokens: 0 } });
    service.runtimeRunStart({ run_id: "limited", task_id: task.id, policy_id: limited.id, environment: {}, operations: [
      { operation_id: "limited-op", kind: "agent", effect: "read_only", objective: "limited" },
    ] });
    const limitedLease = (service.runtimeDispatch({ run_id: "limited", claimed_by: "host" }).operations as JsonObject[])[0];
    service.runtimeOperationSubmit({ operation_id: "limited-op", lease_id: limitedLease.lease_id, claimed_by: "host", verdict: "passed", costs: { tokens: 1 } });
    assert.equal((service.runtimeDispatch({ run_id: "limited", claimed_by: "host" }).paused), "paused_budget");
    assert.equal((service.runtimeRunResume({ run_id: "limited" }).next_action as JsonObject).kind, "await_budget");

    service.runtimeRunStart({ run_id: "null-child", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "null-parent", kind: "agent", effect: "read_only", objective: "parent" },
    ] });
    const nullParent = (service.runtimeDispatch({ run_id: "null-child", claimed_by: "host" }).operations as JsonObject[])[0];
    service.runtimeOperationSubmit({ operation_id: "null-parent", lease_id: nullParent.lease_id, claimed_by: "host", verdict: "passed",
      children: [{ operation_id: "null-child-op", kind: "agent", effect: "read_only", objective: "child" }] });
    assert.equal((service.runtimeOperationGet({ operation_id: "null-child-op" }).operation as JsonObject).agent_profile_id, null);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
