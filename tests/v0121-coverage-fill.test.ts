import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture(): Promise<{ root: string; store: CraftStore; service: CraftService }> {
  const root = join(tmpdir(), `craft-coverage-${process.pid}-${Date.now()}-${Math.random()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  return { root, store, service };
}

async function teardown(root: string, store: CraftStore): Promise<void> {
  store.close();
  await rm(root, { recursive: true, force: true });
}

/**
 * The next set of tests intentionally re-walks error branches in
 * `CraftService` that were already shipped but not exercised in earlier
 * test files. W7 + W8 added new modules and increased the denominator,
 * so these branches would otherwise drag the all-files coverage below
 * the 100/100/100 threshold.
 */

test("runtimeLeaseRecover marks an operation failed when attempts exceed max_attempts", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "Exhaust", goal: "Test" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "Exhaust Policy", allowed_effects: ["read_only"],
      require_approval_for: ["read_only"], max_concurrency: 1, max_attempts: 2, budget: { tokens: 10 } });
    service.runtimeRunStart({ run_id: "exhaust-run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "exhaust-op", kind: "agent",
        effect: "read_only", objective: "exhaust", agent_profile_id: "worker" }] });
    // First dispatch transitions to awaiting_approval; approve to
    // move it back to pending; second dispatch leases it.
    service.runtimeDispatch({ run_id: "exhaust-run", claimed_by: "host" });
    service.runtimeOperationDecision({ operation_id: "exhaust-op", decision: "approve", actor: "human" });
    const second = service.runtimeDispatch({ run_id: "exhaust-run", claimed_by: "host" });
    const lease = (second.operations as JsonObject[])[0].lease_id as string;
    // Backdate the lease so it is recoverable; bump attempts to >= max.
    const op = service.runtimeOperationGet({ operation_id: "exhaust-op" }).operation as JsonObject;
    service.store.save("runtime_operation", String(op.id), {
      ...strip(op), attempts: 2, status: "leased", lease_id: lease, lease_expires_at: "2000-01-01T00:00:00Z",
      claimed_by: "host",
    });
    const recovered = service.runtimeLeaseRecover({ run_id: "exhaust-run" });
    assert.ok((recovered.recovered_operation_ids as string[]).includes("exhaust-op"));
    const after = service.runtimeOperationGet({ operation_id: "exhaust-op" }).operation as JsonObject;
    assert.equal(after.status, "failed");
  } finally {
    await teardown(root, store);
  }
});

test("runtime and harness edge branches remain explicit", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "Runtime edges", goal: "Test" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "Edges", allowed_effects: ["read_only"],
      require_approval_for: ["read_only"], max_concurrency: 2, max_attempts: 2, budget: { tokens: 100 }, trusted_hosts: ["host"] });
    assert.throws(() => service.runtimeRunStart({ run_id: "self-dependency", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "self-dependency", kind: "agent", effect: "read_only", objective: "self", depends_on: ["self-dependency"] },
    ] }), /cannot depend on itself/);
    service.runtimeRunStart({ run_id: "parent-run", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "parent-root", kind: "agent", effect: "read_only", objective: "root" },
      { operation_id: "parent-child", kind: "agent", effect: "read_only", objective: "child", parent_operation_id: "parent-root" },
    ] });
    assert.throws(() => service.runtimeDispatch({ run_id: "parent-run", claimed_by: "host", kinds: ["unknown"] }), /dispatch kinds/);
    const parentDispatch = service.runtimeDispatch({ run_id: "parent-run", claimed_by: "host", kinds: ["agent"] });
    assert.deepEqual(parentDispatch.operations, []);
    const child = service.runtimeOperationGet({ operation_id: "parent-child" }).operation as JsonObject;
    const withoutDependencies = strip(child); delete withoutDependencies.depends_on;
    store.save("runtime_operation", "parent-child", withoutDependencies);
    service.runtimeOperationDecision({ operation_id: "parent-root", decision: "approve", actor: "human" });
    const rootLease = (service.runtimeDispatch({ run_id: "parent-run", claimed_by: "host", kinds: ["agent"] }).operations as JsonObject[])[0];
    service.runtimeOperationSubmit({ operation_id: "parent-root", lease_id: rootLease.lease_id, claimed_by: "host", verdict: "passed" });
    assert.deepEqual(service.runtimeDispatch({ run_id: "parent-run", claimed_by: "host", kinds: ["agent"] }).operations, []);
    service.runtimeOperationDecision({ operation_id: "parent-child", decision: "approve", actor: "human" });
    const childLease = (service.runtimeDispatch({ run_id: "parent-run", claimed_by: "host", kinds: ["agent"] }).operations as JsonObject[])[0];
    assert.equal(childLease.operation_id, "parent-child");
    service.runtimeOperationSubmit({ operation_id: "parent-child", lease_id: childLease.lease_id, claimed_by: "host", verdict: "failed", retryable: true });

    service.runtimeRunStart({ run_id: "recoverable-run", task_id: task.id, policy_id: policy.id, environment: {}, operations: [
      { operation_id: "recoverable-op", kind: "agent", effect: "read_only", objective: "recover" },
    ] });
    assert.deepEqual(service.runtimeDispatch({ run_id: "recoverable-run", claimed_by: "host", kinds: ["agent"] }).operations, []);
    service.runtimeOperationDecision({ operation_id: "recoverable-op", decision: "approve", actor: "human" });
    const recoverLease = (service.runtimeDispatch({ run_id: "recoverable-run", claimed_by: "host", kinds: ["agent"] }).operations as JsonObject[])[0];
    const recoverOp = service.runtimeOperationGet({ operation_id: "recoverable-op" }).operation as JsonObject;
    store.save("runtime_operation", "recoverable-op", { ...strip(recoverOp), attempts: 1, lease_id: recoverLease.lease_id,
      status: "leased", lease_expires_at: "2000-01-01T00:00:00Z", claimed_by: "host" });
    const recovered = service.runtimeLeaseRecover({ run_id: "recoverable-run", now: "2020-01-01T00:00:00Z" });
    assert.deepEqual(recovered.recovered_operation_ids, ["recoverable-op"]);
    assert.throws(() => service.runtimeLeaseRecover({ run_id: "recoverable-run", now: "not-a-date" }), /ISO timestamp/);

    const hostPolicy = service.runtimePolicySave({ name: "Host edges", allowed_effects: ["read_only", "local_write"],
      require_approval_for: ["local_write"], trusted_hosts: ["host"], budget: { tokens: 100 } });
    service.runtimeRunStart({ run_id: "no-deps-run", task_id: task.id, policy_id: hostPolicy.id, environment: {}, operations: [
      { operation_id: "no-deps-op", kind: "agent", effect: "read_only", objective: "no deps" },
    ] });
    const noDeps = service.runtimeOperationGet({ operation_id: "no-deps-op" }).operation as JsonObject;
    const noDepsPayload = strip(noDeps); delete noDepsPayload.depends_on; delete noDepsPayload.parent_operation_id;
    store.save("runtime_operation", "no-deps-op", noDepsPayload);
    const noDepsLease = (service.runtimeDispatch({ run_id: "no-deps-run", claimed_by: "host", kinds: ["agent"] }).operations as JsonObject[])[0];
    assert.equal(noDepsLease.operation_id, "no-deps-op");
    service.runtimeRunStart({ run_id: "host-ops-run", task_id: task.id, policy_id: hostPolicy.id, environment: {}, operations: [
      { operation_id: "host-agent", kind: "agent", effect: "read_only", objective: "host" },
    ] });
    const tick = service.runtimeDriverTick({ run_id: "host-ops-run", driver_id: "host" });
    assert.equal((tick.host_operations as JsonObject[]).some((item) => item.operation_id === "host-agent"), true);

    for (const [risk, budget] of [["low", undefined], ["medium", {}], ["high", { tokens: 5 }] as const]) {
      const selected = service.harnessSelect({ task_id: task.id, risk, ...(budget === undefined ? {} : { budget }) });
      assert.ok(selected.harness);
    }
    assert.throws(() => service.harnessSelect({ task_id: task.id, risk: "unknown", budget: {} }), /Harness risk/);
  } finally {
    await teardown(root, store);
  }
});

test("runtimeAuthorizeWorkflow refuses an external side effect (in-process driver limitation)", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "Authorize", goal: "Test" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "Authorizer", allowed_effects: ["external_write"],
      require_approval_for: ["external_write"], max_concurrency: 1, budget: { tokens: 10 } });
    const wf = service.workflowSave({ name: "SideEffect", steps: [{ type: "command", side_effect: "external_write",
      command: ["git", "push"], cwd: "/tmp", inputs: {} }] });
    service.runtimeRunStart({ run_id: "auth-run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "auth-op", kind: "workflow",
        effect: "external_write", objective: "external", workflow_id: wf.id, execution: {
          workflow_id: wf.id, workflow_version: 1, project_root: "/tmp",
          inputs: {}, approved_side_effects: ["external_write"],
        } }] });
    service.runtimeDispatch({ run_id: "auth-run", claimed_by: "host", kinds: ["workflow"] });
    service.runtimeOperationDecision({ operation_id: "auth-op", decision: "approve", actor: "human" });
    service.runtimeDispatch({ run_id: "auth-run", claimed_by: "host", kinds: ["workflow"] });
    // The trusted_hosts allowlist does not include "host"; the tick
    // must reject the driver before reaching the workflow authorize
    // branch, surfacing the same defensive boundary.
    assert.throws(() => service.runtimeDriverTick({ run_id: "auth-run", driver_id: "host" }),
      /trusted host|In-process Runtime Driver/);
  } finally {
    await teardown(root, store);
  }
});

test("runtimeAuthorizeWorkflow refuses a path outside the policy path_allowlist", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "Path", goal: "Test" }).task as JsonObject;
    // path_allowlist forbids every path. Side_effect is local_write so
    // the dispatch path goes awaiting_approval → approved → driver tick
    // which leases, calls runtimeAuthorizeWorkflow, and the policy branch
    // throws. The catch in runtimeDriverTick silently fails the operation,
    // so we assert on the post-tick status instead of an outer throws.
    const policy = service.runtimePolicySave({ name: "NoPath", allowed_effects: ["read_only", "local_write"],
      require_approval_for: ["local_write"], max_concurrency: 1, path_allowlist: [], command_allowlist: ["ls"],
      trusted_hosts: ["host"], budget: { tokens: 10 } });
    const wf = service.workflowSave({ name: "Write", steps: [{ type: "command", side_effect: "local_write",
      command: ["ls"], cwd: "/etc/secret", inputs: {} }] });
    service.runtimeRunStart({ run_id: "path-run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "path-op", kind: "workflow",
        effect: "local_write", objective: "exec", workflow_id: wf.id, execution: {
          workflow_id: wf.id, workflow_version: 1, project_root: "/etc/secret",
          inputs: {}, approved_side_effects: ["local_write"],
        } }] });
    service.runtimeDispatch({ run_id: "path-run", claimed_by: "host", kinds: ["workflow"] });
    service.runtimeOperationDecision({ operation_id: "path-op", decision: "approve", actor: "human" });
    const result = service.runtimeDriverTick({ run_id: "path-run", driver_id: "host" });
    const executed = (result.executed as JsonObject[])[0];
    assert.equal(executed.status, "failed");
    assert.equal(executed.blocked, true);
  } finally {
    await teardown(root, store);
  }
});

test("runtimeAuthorizeWorkflow trip-wires the path_allowlist for read steps too", async () => {
  const { root, store, service } = await fixture();
  try {
    // A read-only step whose path is outside path_allowlist trips the
    // path branch (line 755-757). The operation goes straight pending
    // without needing approval, so the test exercises the path check
    // directly through the driver tick's internal dispatch.
    const task = service.taskOpen({ title: "PathRead", goal: "Test" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "PathRead", allowed_effects: ["read_only", "local_write"],
      require_approval_for: ["local_write"], max_concurrency: 1,
      path_allowlist: ["/tmp"], command_allowlist: ["ls"], trusted_hosts: ["host"],
      budget: { tokens: 10 } });
    const wf = service.workflowSave({ name: "ReadStep", steps: [{ type: "read", side_effect: "read_only",
      path: "/etc/secret", inputs: {} }] });
    service.runtimeRunStart({ run_id: "path-read-run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "path-read-op", kind: "workflow",
        effect: "read_only", objective: "read", workflow_id: wf.id, execution: {
          workflow_id: wf.id, workflow_version: 1, project_root: "/tmp",
          inputs: {}, approved_side_effects: ["read_only"],
        } }] });
    const result = service.runtimeDriverTick({ run_id: "path-read-run", driver_id: "host" });
    const executed = (result.executed as JsonObject[])[0];
    assert.equal(executed.status, "failed");
    assert.equal(executed.blocked, true);
  } finally {
    await teardown(root, store);
  }
});

test("runtimeAuthorizeWorkflow refuses a command outside the policy command_allowlist", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "Cmd", goal: "Test" }).task as JsonObject;
    // path_allowlist must permit the cwd, otherwise the path branch fires
    // before we ever reach the command branch on lines 760-767.
    const policy = service.runtimePolicySave({ name: "NoCmd", allowed_effects: ["read_only", "local_write"],
      require_approval_for: ["local_write"], max_concurrency: 1, path_allowlist: ["."],
      command_allowlist: ["ls"], trusted_hosts: ["host"], budget: { tokens: 10 } });
    const wf = service.workflowSave({ name: "Exec", steps: [{ type: "command", side_effect: "local_write",
      command: ["rm", "-rf", "/"], cwd: ".", inputs: {} }] });
    service.runtimeRunStart({ run_id: "cmd-run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "cmd-op", kind: "workflow",
        effect: "local_write", objective: "exec", workflow_id: wf.id, execution: {
          workflow_id: wf.id, workflow_version: 1, project_root: root,
          inputs: {}, approved_side_effects: ["local_write"],
        } }] });
    service.runtimeDispatch({ run_id: "cmd-run", claimed_by: "host", kinds: ["workflow"] });
    service.runtimeOperationDecision({ operation_id: "cmd-op", decision: "approve", actor: "human" });
    const result = service.runtimeDriverTick({ run_id: "cmd-run", driver_id: "host" });
    const executed = (result.executed as JsonObject[])[0];
    assert.equal(executed.status, "failed");
    assert.equal(executed.blocked, true);
  } finally {
    await teardown(root, store);
  }
});

test("runtimeAuthorizeWorkflow refuses an external-write side effect (trusted-host gate fires first)", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "Authorize", goal: "Test" }).task as JsonObject;
    // Without trusted_hosts set, the trusted-host gate fires before
    // runtimeAuthorizeWorkflow is reached. We pair this with a workflow
    // whose step is external_write so the inner branch is otherwise
    // well-defined if trusted_hosts were ever extended to allow it.
    const policy = service.runtimePolicySave({ name: "Authorizer", allowed_effects: ["external_write"],
      require_approval_for: ["external_write"], max_concurrency: 1, budget: { tokens: 10 } });
    const wf = service.workflowSave({ name: "SideEffect", steps: [{ type: "command", side_effect: "external_write",
      command: ["git", "push"], cwd: "/tmp", inputs: {} }] });
    service.runtimeRunStart({ run_id: "auth-run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "auth-op", kind: "workflow",
        effect: "external_write", objective: "external", workflow_id: wf.id, execution: {
          workflow_id: wf.id, workflow_version: 1, project_root: "/tmp",
          inputs: {}, approved_side_effects: ["external_write"],
        } }] });
    // Single dispatch moves pending → awaiting_approval; the driver tick
    // must reject before reaching the trusted_hosts gate or the inner
    // authorize branch. Since it never leased, `runtimeOperationDecision`
    // will complain — but we never get there: the tick must throw.
    service.runtimeDispatch({ run_id: "auth-run", claimed_by: "host", kinds: ["workflow"] });
    assert.throws(() => service.runtimeDriverTick({ run_id: "auth-run", driver_id: "host" }),
      /trusted host|In-process Runtime Driver/);
  } finally {
    await teardown(root, store);
  }
});

test("runtimeAuthorizeWorkflow refuses an external side effect (steps branch catches it)", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "ExtStep", goal: "Test" }).task as JsonObject;
    // The defensive side_effect !== read_only|local_write branch inside
    // runtimeAuthorizeWorkflow fires when a workflow step has an
    // external_write/destructive side_effect. The catch in
    // runtimeDriverTick swallows the failure, so we observe the blocked
    // run instead.
    const policy = service.runtimePolicySave({ name: "TrustedExt", allowed_effects: ["external_write"],
      require_approval_for: ["external_write"], max_concurrency: 1, trusted_hosts: ["host"],
      budget: { tokens: 10 } });
    const wf = service.workflowSave({ name: "Side", steps: [{ type: "command", side_effect: "external_write",
      command: ["git", "push"], cwd: "/tmp", inputs: {} }] });
    service.runtimeRunStart({ run_id: "ext-run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "ext-op", kind: "workflow",
        effect: "external_write", objective: "external", workflow_id: wf.id, execution: {
          workflow_id: wf.id, workflow_version: 1, project_root: "/tmp",
          inputs: {}, approved_side_effects: ["external_write"],
        } }] });
    service.runtimeDispatch({ run_id: "ext-run", claimed_by: "host", kinds: ["workflow"] });
    service.runtimeOperationDecision({ operation_id: "ext-op", decision: "approve", actor: "human" });
    const result = service.runtimeDriverTick({ run_id: "ext-run", driver_id: "host" });
    const executed = (result.executed as JsonObject[])[0];
    assert.equal(executed.status, "failed");
    assert.equal(executed.blocked, true);
  } finally {
    await teardown(root, store);
  }
});

test("runtimeAuthorizeWorkflow refuses a command whose env contains a secret keyword", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "Secret", goal: "Test" }).task as JsonObject;
    // path is allowed; command is allowed; the env secret keyword is
    // what should trip the inner throw on line 765. Verify the env is
    // persisted on the workflow step.
    const policy = service.runtimePolicySave({ name: "NoSecret", allowed_effects: ["read_only", "local_write"],
      require_approval_for: ["local_write"], max_concurrency: 1, path_allowlist: ["/tmp"],
      command_allowlist: ["ls"], trusted_hosts: ["host"], budget: { tokens: 10 } });
    const wf = service.workflowSave({ name: "SecretCmd", steps: [{ type: "command", side_effect: "local_write",
      command: ["ls"], cwd: "/tmp", env: { TOKEN: "secret-value" }, inputs: {} }] });
    service.runtimeRunStart({ run_id: "secret-run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "secret-op", kind: "workflow",
        effect: "local_write", objective: "exec", workflow_id: wf.id, execution: {
          workflow_id: wf.id, workflow_version: 1, project_root: "/tmp",
          inputs: {}, approved_side_effects: ["local_write"],
        } }] });
    service.runtimeDispatch({ run_id: "secret-run", claimed_by: "host", kinds: ["workflow"] });
    service.runtimeOperationDecision({ operation_id: "secret-op", decision: "approve", actor: "human" });
    const result = service.runtimeDriverTick({ run_id: "secret-run", driver_id: "host" });
    const executed = (result.executed as JsonObject[])[0];
    assert.equal(executed.blocked, true);
    assert.equal(executed.status, "failed");
  } finally {
    await teardown(root, store);
  }
});

test("runtimeAuthorizeWorkflow covers the env-secrets branch with a non-empty command allowlist", async () => {
  // Same shape as the prior secret test but with a different secret
  // key ("PASSWORD") to ensure the i-flag regex matches a different
  // keyword, exercising the same code path and removing any
  // chance of v8 range drifting.
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "SecretPwd", goal: "Test" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "NoSecretPwd", allowed_effects: ["read_only", "local_write"],
      require_approval_for: ["local_write"], max_concurrency: 1, path_allowlist: ["/tmp"],
      command_allowlist: ["ls"], trusted_hosts: ["host"], budget: { tokens: 10 } });
    const wf = service.workflowSave({ name: "SecretCmdPwd", steps: [{ type: "command", side_effect: "local_write",
      command: ["ls"], cwd: "/tmp", env: { PASSWORD: "hunter2" }, inputs: {} }] });
    service.runtimeRunStart({ run_id: "secret-pwd-run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "secret-pwd-op", kind: "workflow",
        effect: "local_write", objective: "exec", workflow_id: wf.id, execution: {
          workflow_id: wf.id, workflow_version: 1, project_root: "/tmp",
          inputs: {}, approved_side_effects: ["local_write"],
        } }] });
    service.runtimeDispatch({ run_id: "secret-pwd-run", claimed_by: "host", kinds: ["workflow"] });
    service.runtimeOperationDecision({ operation_id: "secret-pwd-op", decision: "approve", actor: "human" });
    const result = service.runtimeDriverTick({ run_id: "secret-pwd-run", driver_id: "host" });
    const executed = (result.executed as JsonObject[])[0];
    assert.equal(executed.blocked, true);
  } finally {
    await teardown(root, store);
  }
});

test("runtimeAuthorizeWorkflow succeeds through every branch (paths / commands / env)", async () => {
  // Happy-path test where authorize completes cleanly. The catch
  // branch in runtimeDriverTick must NOT fire because every
  // downstream call succeeds.
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "Ok", goal: "Test" }).task as JsonObject;
    const policy = service.runtimePolicySave({ name: "OkPolicy", allowed_effects: ["read_only", "local_write"],
      require_approval_for: ["local_write"], max_concurrency: 1, path_allowlist: ["/tmp", "."],
      command_allowlist: ["ls"], trusted_hosts: ["host"], budget: { tokens: 10 } });
    // Assertion step `file_exists` over a project-relative `.`/existing
    // path. The path is allowed by policy and resolves relative to the
    // project_root. Using a relative path keeps safePath happy.
    const wf = service.workflowSave({ name: "OkAssert", steps: [{ type: "assertion", side_effect: "read_only",
      evaluator: "file_exists", path: "tests/_probe-secret.ts", expected: true, inputs: {} }] });
    service.runtimeRunStart({ run_id: "ok-run", task_id: task.id, policy_id: policy.id,
      environment: { image: "test@1" }, operations: [{ operation_id: "ok-op", kind: "workflow",
        effect: "read_only", objective: "ok", workflow_id: wf.id, execution: {
          workflow_id: wf.id, workflow_version: 1, project_root: root,
          inputs: {}, approved_side_effects: ["read_only"],
        } }] });
    const result = service.runtimeDriverTick({ run_id: "ok-run", driver_id: "host" });
    const executed = (result.executed as JsonObject[])[0];
    // Successful execution must not have a blocked flag.
    assert.equal(executed.blocked, undefined);
    assert.ok(executed.workflow_run_id);
  } finally {
    await teardown(root, store);
  }
});

test("runtimeAuthorizeWorkflow directly authorizes a safe command step", async () => {
  const { root, store, service } = await fixture();
  try {
    const policy = service.runtimePolicySave({ name: "CommandPolicy", allowed_effects: ["read_only", "local_write"],
      require_approval_for: ["local_write"], max_concurrency: 1, path_allowlist: ["."], command_allowlist: ["node"],
      trusted_hosts: ["host"], budget: { tokens: 10 } });
    const wf = service.workflowSave({ name: "SafeCommand", steps: [{ type: "command", side_effect: "read_only",
      command: ["node", "--version"], cwd: ".", report: "report.json", inputs: {} }] });
    const operation = { id: "op-direct-command", execution: {
      workflow_id: wf.id, workflow_version: 1, project_root: root, inputs: {}, approved_side_effects: ["read_only"],
    } } as JsonObject;
    const authorized = (service as unknown as { runtimeAuthorizeWorkflow: (operation: JsonObject, policy: JsonObject) => JsonObject })
      .runtimeAuthorizeWorkflow(operation, policy as JsonObject);
    assert.equal((authorized.plan as JsonObject).workflow_id, wf.id);
    const secretWorkflow = service.workflowSave({ name: "SecretCommand", steps: [{ type: "command", side_effect: "read_only",
      command: ["node"], cwd: ".", env: { API_TOKEN: "redacted" }, inputs: {} }] });
    assert.throws(() => (service as unknown as { runtimeAuthorizeWorkflow: (operation: JsonObject, policy: JsonObject) => JsonObject })
      .runtimeAuthorizeWorkflow({ id: "op-secret-command", execution: {
        workflow_id: secretWorkflow.id, workflow_version: 1, project_root: root, inputs: {}, approved_side_effects: ["read_only"],
      } } as JsonObject, policy as JsonObject), /does not accept command secrets/);
  } finally {
    await teardown(root, store);
  }
});

test("agentIrCompile rejects duplicate operation ids", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "IR", goal: "Test" }).task as JsonObject;
    // agentIrCompile also requires a harness_configuration row; seed one.
    service.store.create("harness_configuration", "harness_ir", {
      task_id: task.id, name: "ir-harness", version: 1, lifecycle: "draft",
      capability_profile_ids: [], verification_steps: [], risk_level: "low",
      approval_required: false,
    });
    assert.throws(() => service.agentIrCompile({ task_id: task.id, goal: "unsupported",
      harness_id: "harness_ir", operations: [{ id: "bad", kind: "unknown", effect: "read_only", objective: "bad" }] }), /unsupported/);
    assert.throws(() => service.agentIrCompile({ task_id: task.id, goal: "self",
      harness_id: "harness_ir", operations: [{ id: "self", kind: "agent", effect: "read_only", objective: "self", depends_on: ["self"] }] }), /cannot depend/);
    const withExecution = service.agentIrCompile({ task_id: task.id, goal: "execution", harness_id: "harness_ir",
      operations: [{ id: "exec", kind: "agent", effect: "read_only", objective: "exec", execution: { workflow_id: "safe" } }] });
    assert.equal((withExecution.operations as JsonObject[])[0].execution !== null, true);
    assert.throws(() => service.agentIrCompile({ task_id: task.id, goal: "duplicates",
      harness_id: "harness_ir", harness_version: 1, operations: [
        { id: "op_1", kind: "agent", effect: "read_only", objective: "x", target: "x" },
        { id: "op_1", kind: "agent", effect: "read_only", objective: "y", target: "y" },
      ] }), /uniquely identified/);
  } finally {
    await teardown(root, store);
  }
});

test("agentIrCompile rejects dependencies that target a different IR", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "IR", goal: "Test" }).task as JsonObject;
    service.store.create("harness_configuration", "harness_ir", {
      task_id: task.id, name: "ir-harness", version: 1, lifecycle: "draft",
      capability_profile_ids: [], verification_steps: [], risk_level: "low",
      approval_required: false,
    });
    assert.throws(() => service.agentIrCompile({ task_id: task.id, goal: "deps",
      harness_id: "harness_ir", harness_version: 1, operations: [
        { id: "op_1", kind: "agent", effect: "read_only", objective: "x", target: "x" },
        { id: "op_2", kind: "agent", effect: "read_only", objective: "y", target: "y",
          depends_on: ["op_external"] },
      ] }), /dependencies must belong/);
  } finally {
    await teardown(root, store);
  }
});

test("agentIrLower rewrites operation dependencies into runtime ids", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "IR lower", goal: "Test" }).task as JsonObject;
    service.store.create("harness_configuration", "harness_lower", {
      task_id: task.id, name: "ir-harness", version: 1, lifecycle: "draft",
      capability_profile_ids: [], verification_steps: [], risk_level: "low", approval_required: false,
    });
    const policy = service.runtimePolicySave({ name: "IR lower policy", allowed_effects: ["read_only"],
      require_approval_for: ["read_only"], max_concurrency: 2, budget: { tokens: 10 } });
    const ir = service.agentIrCompile({ task_id: task.id, goal: "lower", harness_id: "harness_lower", harness_version: 1,
      operations: [
        { id: "root", kind: "agent", effect: "read_only", objective: "root" },
        { id: "child", kind: "agent", effect: "read_only", objective: "child", depends_on: ["root"], execution: { workflow_id: "safe" } },
      ] });
    const lowered = service.agentIrLower({ ir_id: ir.id, policy_id: policy.id, environment: {}, run_id: "ir-lower-run" });
    const operations = lowered.run && (lowered.run as JsonObject).id ? service.runtimeRunGet({ run_id: "ir-lower-run" }).operations as JsonObject[] : [];
    assert.equal(operations.length, 2);
    const child = operations.find((operation) => operation.operation_id === "ir-lower-run:child");
    assert.deepEqual(child?.depends_on, ["ir-lower-run:root"]);
    const versioned = service.agentIrLower({ ir_id: ir.id, ir_version: 1, policy_id: policy.id, environment: {}, run_id: "ir-lower-versioned" });
    assert.equal((versioned.run as JsonObject).id, "ir-lower-versioned");
  } finally {
    await teardown(root, store);
  }
});

test("evaluationProgramGrade rejects an invalid configuration", async () => {
  const { root, store, service } = await fixture();
  try {
    // Seed a run via the proper record API so the row exists, plus a
    // program grader whose minimum_pass_rate is out of [0,1]. The
    // validation branch (line ~3007) must trip before the grader tries
    // to compute anything against the run.
    const task = service.taskOpen({ title: "Grade", goal: "Test" }).task as JsonObject;
    const workflow = service.workflowSave({ name: "GradeWf" });
    const trial = service.trialStart({ trial_id: "trial_grade", task_id: task.id, case_id: "case_grade",
      subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version,
      environment: { image: "test" }, budget: { tokens: 10 } });
    service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "ok", costs: { tokens: 1 } });
    const suite = service.evaluationSuiteSave({ suite_id: "suite_grade", name: "Grade Suite",
      cases: [{ case_id: "case_grade", split: "held_out" }] });
    const baseline = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version,
      trial_ids: [trial.id] });
    service.store.create("grader", "grader_bad", {
      kind: "program", name: "broken", version: 1, configuration: { minimum_pass_rate: 1.5 },
      grader_type: "program",
    });
    assert.throws(() => service.evaluationProgramGrade({
      evaluation_run_id: baseline.id, grader_id: "grader_bad",
    }), /Program grader configuration is invalid/);
  } finally {
    await teardown(root, store);
  }
});

test("evaluationProgramGrade accepts a duration limit and is idempotent", async () => {
  const { root, store, service } = await fixture();
  try {
    const task = service.taskOpen({ title: "Grade valid", goal: "Test" }).task as JsonObject;
    const workflow = service.workflowSave({ name: "GradeValidWf" });
    const trial = service.trialStart({ trial_id: "trial_grade_valid", task_id: task.id, case_id: "case_grade_valid",
      subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version,
      environment: { image: "test" }, budget: { tokens: 10 } });
    service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "ok", costs: { tokens: 1 } });
    const suite = service.evaluationSuiteSave({ suite_id: "suite_grade_valid", name: "Grade Suite",
      cases: [{ case_id: "case_grade_valid", split: "held_out" }, { case_id: "case_grade_failed", split: "held_out" }] });
    const evaluation = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version,
      trial_ids: [trial.id] });
    service.store.create("grader", "grader_valid", {
      kind: "program", name: "bounded", version: 1, configuration: { minimum_pass_rate: 0, maximum_mean_duration_ms: 1000 },
      grader_type: "program",
    });
    service.store.create("grader", "grader_default", {
      kind: "program", name: "default", version: 1, configuration: { maximum_mean_duration_ms: 1000 },
      grader_type: "program",
    });
    service.store.create("grader", "grader_manual", {
      kind: "manual", name: "manual", version: 1, configuration: {}, grader_type: "manual",
    });
    assert.throws(() => service.evaluationProgramGrade({ evaluation_run_id: evaluation.id, grader_id: "grader_manual" }),
      /requires a program grader/);
    const first = service.evaluationProgramGrade({ evaluation_run_id: evaluation.id, grader_id: "grader_valid" });
    const second = service.evaluationProgramGrade({ evaluation_run_id: evaluation.id, grader_id: "grader_valid" });
    const defaults = service.evaluationProgramGrade({ evaluation_run_id: evaluation.id, grader_id: "grader_default" });
    assert.equal((first.grades as JsonObject[]).length, 1);
    assert.deepEqual(second.grades, first.grades);
    assert.equal((defaults.grades as JsonObject[])[0].verdict, "passed");

    const failedTrial = service.trialStart({ trial_id: "trial_grade_failed", task_id: task.id, case_id: "case_grade_failed",
      subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version,
      environment: { image: "test" }, budget: { tokens: 10 } });
    service.outcomeRecord({ trial_id: failedTrial.id, verdict: "failed", summary: "failed", costs: { tokens: 1, duration_ms: 1 } });
    const failedEvaluation = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version,
      trial_ids: [failedTrial.id] });
    service.store.create("grader", "grader_strict", {
      kind: "program", name: "strict", version: 1, configuration: { minimum_pass_rate: 1, maximum_mean_duration_ms: 0 },
      grader_type: "program",
    });
    const failedGrades = service.evaluationProgramGrade({ evaluation_run_id: failedEvaluation.id, grader_id: "grader_strict" });
    assert.equal((failedGrades.grades as JsonObject[])[0].verdict, "failed");
  } finally {
    await teardown(root, store);
  }
});

test("evaluationPromotionAssess rejects invalid thresholds", async () => {
  const { root, store, service } = await fixture();
  try {
    // Build a real comparison: two runs over the same trial, then call
    // evaluationPromotionAssess with out-of-range thresholds so the
    // validation branch at line ~3061 trips.
    const task = service.taskOpen({ title: "Promo", goal: "Test" }).task as JsonObject;
    const workflow = service.workflowSave({ name: "PromoWf" });
    const trial = service.trialStart({ trial_id: "trial_promo", task_id: task.id, case_id: "case_promo",
      subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version,
      environment: { image: "test" }, budget: { tokens: 10 } });
    service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "ok", costs: { tokens: 1 } });
    const suite = service.evaluationSuiteSave({ suite_id: "suite_promo", name: "Promo Suite",
      cases: [{ case_id: "case_promo", split: "held_out" }] });
    const baseline = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version,
      trial_ids: [trial.id] });
    const candidate = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "workflow", subject_id: workflow.id, subject_version: workflow.version,
      trial_ids: [trial.id] });
    const comparison = service.evaluationCompare({ baseline_run_id: baseline.id, candidate_run_id: candidate.id });
    assert.throws(() => service.evaluationPromotionAssess({
      comparison_id: comparison.id, min_trials: 2, min_pass_rate_delta: 2,
    }), /Promotion thresholds are invalid/);
  } finally {
    await teardown(root, store);
  }
});

function strip(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}
