import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { egressRequestDigest, TrustedEgressBroker } from "../src/egress.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture(name: string) {
  const root = join(tmpdir(), `craft-effects-${name}-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store); const task = service.taskOpen({ title: name, goal: "External work" }).task as JsonObject;
  const evidence = service.evidenceRecord({ evidence_id: `${name}-evidence`, source_type: "program", claim: "observed", confidence: "confirmed" });
  return { root, store, service, task, evidence };
}

test("external effects form an evidence-backed forward and compensation Saga", async () => {
  const f = await fixture("saga"); const server = new McpServer(f.service, "full");
  const call = async (name: string, args: JsonObject) => server.handlers[name](args);
  try {
    const first = await call("craft_external_effect_prepare", { effect_id: "reserve", task_id: f.task.id, provider: "billing", action: "reserve", target: "account", effect: "external_write", request_digest: "sha256:reserve", idempotency_key: "task:reserve:1", approval_ref: "approval", compensation: { action: "release", request_digest: "sha256:release" } });
    const second = await call("craft_external_effect_prepare", { effect_id: "notify", task_id: f.task.id, provider: "mail", action: "send", target: "customer", effect: "external_write", request_digest: "sha256:send", idempotency_key: "task:notify:1", approval_ref: "approval" });
    const saga = await call("craft_effect_saga_create", { saga_id: "checkout", task_id: f.task.id, effect_ids: ["reserve", "notify"] });
    assert.deepEqual(saga.next_action, { kind: "execute", effect_id: "reserve" });
    const started = await call("craft_external_effect_start", { effect_id: "reserve", approval_ref: "approval" });
    assert.equal((started.dispatch as JsonObject).idempotency_key, "task:reserve:1");
    assert.equal((await call("craft_external_effect_start", { effect_id: "reserve", approval_ref: "approval" })).idempotent, true);
    const success = await call("craft_external_effect_report", { effect_id: "reserve", receipt_id: "reserve-receipt", status: "succeeded", remote_operation_id: "remote-1", response_digest: "sha256:ok", evidence_ids: [f.evidence.id] });
    assert.equal((success.effect as JsonObject).status, "succeeded");
    assert.equal((await call("craft_external_effect_report", { effect_id: "reserve", receipt_id: "reserve-receipt", status: "succeeded", remote_operation_id: "remote-1", response_digest: "sha256:ok", evidence_ids: [f.evidence.id] })).idempotent, true);
    await call("craft_external_effect_start", { effect_id: "notify", approval_ref: "approval" });
    await call("craft_external_effect_report", { effect_id: "notify", receipt_id: "notify-receipt", status: "failed", evidence_ids: [f.evidence.id] });
    assert.deepEqual((await call("craft_effect_saga_get", { saga_id: "checkout" })).next_action, { kind: "compensate", effect_id: "reserve" });
    const compensation = await call("craft_effect_compensation_issue", { effect_id: "reserve", compensation_id: "release", approval_ref: "human" });
    assert.equal((compensation.dispatch as JsonObject).remote_operation_id, "remote-1");
    const compensated = await call("craft_effect_compensation_report", { compensation_id: "release", status: "succeeded", evidence_ids: [f.evidence.id] });
    assert.equal((compensated.effect as JsonObject).status, "compensated");
    assert.equal(((await call("craft_effect_saga_get", { saga_id: "checkout" })).next_action as JsonObject).kind, "resolve_or_stop");
    assert.equal((first.effect as JsonObject).task_id, (second.effect as JsonObject).task_id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("indeterminate effects require evidence-backed resolution and compensation outcomes stay distinct", async () => {
  const f = await fixture("resolve"); const server = new McpServer(f.service, "full");
  const prepare = (id: string, compensation = true) => f.service.externalEffectPrepare({ effect_id: id, task_id: f.task.id, provider: "api", action: "write", target: "record", effect: "destructive", request_digest: `digest:${id}`, idempotency_key: `effect:${id}:01`, approval_ref: "approve", compensation: compensation ? { action: "undo", request_digest: `undo:${id}` } : undefined });
  try {
    prepare("unknown", false); f.service.externalEffectStart({ effect_id: "unknown", approval_ref: "approve" });
    f.service.externalEffectReport({ effect_id: "unknown", receipt_id: "unknown-r", status: "indeterminate", evidence_ids: [f.evidence.id] });
    assert.throws(() => f.service.externalEffectResolve({ effect_id: "unknown", resolution: "succeeded", resolver_type: "agent", approval_ref: "human", evidence_ids: [f.evidence.id] }), /human resolver/);
    assert.throws(() => f.service.externalEffectResolve({ effect_id: "unknown", resolution: "succeeded", resolver_type: "human", approval_ref: "human", evidence_ids: [f.evidence.id] }), /remote_operation_id/);
    assert.equal(((await server.handlers.craft_external_effect_resolve({ effect_id: "unknown", resolution: "failed", resolver_type: "human", approval_ref: "human", evidence_ids: [f.evidence.id] })).effect as JsonObject).status, "failed");
    for (const [id, result, expected] of [["undo-fail", "failed", "compensation_failed"], ["undo-unknown", "indeterminate", "compensation_indeterminate"]]) {
      prepare(id); f.service.externalEffectStart({ effect_id: id, approval_ref: "approve" });
      f.service.externalEffectReport({ effect_id: id, receipt_id: `${id}-r`, status: "succeeded", remote_operation_id: `remote-${id}`, evidence_ids: [f.evidence.id] });
      const issued = f.service.effectCompensationIssue({ effect_id: id, approval_ref: "human" }).compensation as JsonObject;
      assert.equal((f.service.effectCompensationReport({ compensation_id: issued.id, status: result, response_digest: `response:${id}`, evidence_ids: [f.evidence.id] }).effect as JsonObject).status, expected);
    }
    prepare("resolved-success", false); f.service.externalEffectStart({ effect_id: "resolved-success", approval_ref: "approve" });
    f.service.externalEffectReport({ effect_id: "resolved-success", receipt_id: "resolved-r", status: "indeterminate", remote_operation_id: "known", evidence_ids: [f.evidence.id] });
    assert.equal((f.service.externalEffectResolve({ effect_id: "resolved-success", resolution: "succeeded", resolver_type: "human", approval_ref: "human", evidence_ids: [f.evidence.id] }).effect as JsonObject).remote_operation_id, "known");
    const complete = f.service.effectSagaCreate({ saga_id: "complete", task_id: f.task.id, effect_ids: ["resolved-success"] });
    assert.equal((complete.next_action as JsonObject).kind, "complete"); assert.equal(complete.derived_status, "completed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("external effect state machines reject unsafe transitions and cross-task Sagas", async () => {
  const f = await fixture("errors");
  const base = { task_id: f.task.id, provider: "api", action: "write", target: "record", effect: "external_write", request_digest: "digest", idempotency_key: "effect:safe:1", approval_ref: "approve" };
  try {
    assert.throws(() => f.service.externalEffectPrepare({ ...base, provider: " " }), /provider/);
    assert.throws(() => f.service.externalEffectPrepare({ ...base, compensation: [] }), /object/);
    assert.throws(() => f.service.externalEffectPrepare({ ...base, effect: "read_only" }), /external_write/);
    assert.throws(() => f.service.externalEffectPrepare({ ...base, idempotency_key: "short" }), /8-200/);
    assert.throws(() => f.service.externalEffectPrepare({ ...base, compensation: {} }), /compensation/);
    f.service.externalEffectPrepare({ ...base, effect_id: "effect" });
    assert.throws(() => f.service.externalEffectStart({ effect_id: "effect", approval_ref: "wrong" }), /approval/);
    assert.throws(() => f.service.externalEffectReport({ effect_id: "effect", receipt_id: "r", status: "maybe", evidence_ids: [f.evidence.id] }), /unsupported/);
    assert.throws(() => f.service.externalEffectReport({ effect_id: "effect", receipt_id: "r", status: "failed", evidence_ids: [] }), /non-empty/);
    assert.throws(() => f.service.externalEffectReport({ effect_id: "effect", receipt_id: "r", status: "failed", evidence_ids: [f.evidence.id] }), /not executing/);
    f.service.externalEffectStart({ effect_id: "effect", approval_ref: "approve" });
    assert.throws(() => f.service.externalEffectReport({ effect_id: "effect", receipt_id: "r", status: "succeeded", evidence_ids: [f.evidence.id] }), /remote_operation_id/);
    f.service.externalEffectReport({ effect_id: "effect", receipt_id: "r", status: "failed", evidence_ids: [f.evidence.id] });
    assert.throws(() => f.service.externalEffectReport({ effect_id: "effect", receipt_id: "r", status: "failed", response_digest: "changed", evidence_ids: [f.evidence.id] }), /idempotency/);
    assert.throws(() => f.service.externalEffectStart({ effect_id: "effect", approval_ref: "approve" }), /prepared/);
    assert.throws(() => f.service.externalEffectResolve({ effect_id: "effect", resolution: "failed", resolver_type: "human", approval_ref: "human", evidence_ids: [f.evidence.id] }), /indeterminate/);
    assert.throws(() => f.service.effectCompensationIssue({ effect_id: "effect", approval_ref: "human" }), /compensatable/);
    f.service.externalEffectPrepare({ ...base, effect_id: "unknown" }); f.service.externalEffectStart({ effect_id: "unknown", approval_ref: "approve" });
    f.service.externalEffectReport({ effect_id: "unknown", receipt_id: "unknown-r", status: "indeterminate", evidence_ids: [f.evidence.id] });
    assert.throws(() => f.service.externalEffectResolve({ effect_id: "unknown", resolution: "maybe", resolver_type: "human", approval_ref: "human", evidence_ids: [f.evidence.id] }), /resolution/);
    const other = f.service.taskOpen({ title: "Other", goal: "Other" }).task as JsonObject;
    f.service.externalEffectPrepare({ ...base, effect_id: "other", task_id: other.id });
    assert.throws(() => f.service.effectSagaCreate({ task_id: f.task.id, effect_ids: ["effect", "other"] }), /same task/);
    assert.throws(() => f.service.effectSagaCreate({ task_id: f.task.id, effect_ids: [] }), /non-empty/);
    assert.throws(() => f.service.effectSagaCreate({ task_id: f.task.id, effect_ids: ["effect", "effect"] }), /unique/);
    f.service.externalEffectPrepare({ ...base, effect_id: "waiting" }); f.service.externalEffectStart({ effect_id: "waiting", approval_ref: "approve" });
    assert.equal((f.service.effectSagaCreate({ task_id: f.task.id, effect_ids: ["waiting"] }).next_action as JsonObject).kind, "wait");
    f.store.create("effect_compensation", "not-running", { effect_id: "effect", status: "succeeded" });
    assert.throws(() => f.service.effectCompensationReport({ compensation_id: "not-running", status: "failed", evidence_ids: [f.evidence.id] }), /not executing/);
    f.store.create("effect_compensation", "running", { effect_id: "effect", status: "executing" });
    assert.throws(() => f.service.effectCompensationReport({ compensation_id: "running", status: "maybe", evidence_ids: [f.evidence.id] }), /unsupported/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("external effects generate identifiers and append Trial evidence traces", async () => {
  const f = await fixture("generated");
  try {
    const subject = f.store.create("workflow", "effect-workflow", { name: "Effect workflow" });
    const trial = f.service.trialStart({ trial_id: "effect-trial", task_id: f.task.id,
      subject_type: "workflow", subject_id: subject.id, subject_version: subject.version });
    const prepared = f.service.externalEffectPrepare({ task_id: f.task.id, trial_id: trial.id,
      provider: "api", action: "create", target: "record", effect: "external_write",
      request_digest: "digest:generated", idempotency_key: "generated:effect:1", approval_ref: "approve",
      compensation: { action: "delete", request_digest: "digest:delete" } }).effect as JsonObject;
    assert.match(String(prepared.id), /^effect_/);
    f.service.externalEffectStart({ effect_id: prepared.id, approval_ref: "approve" });
    f.service.externalEffectReport({ effect_id: prepared.id, receipt_id: "generated-receipt", status: "succeeded",
      remote_operation_id: "remote-generated", evidence_ids: [f.evidence.id] });
    const compensation = f.service.effectCompensationIssue({ effect_id: prepared.id, approval_ref: "approve" }).compensation as JsonObject;
    assert.match(String(compensation.id), /^compensation_/);
    f.service.effectCompensationReport({ compensation_id: compensation.id, status: "succeeded", evidence_ids: [f.evidence.id] });
    const saga = f.service.effectSagaCreate({ task_id: f.task.id, trial_id: trial.id, effect_ids: [prepared.id] }).saga as JsonObject;
    assert.match(String(saga.id), /^saga_/);
    assert.equal(f.store.events(`trial:${trial.id}`).length, 5);

    const unknown = f.service.externalEffectPrepare({ effect_id: "resolved-with-remote", task_id: f.task.id,
      provider: "api", action: "create", target: "record", effect: "external_write", request_digest: "digest:resolve",
      idempotency_key: "generated:resolve:1", approval_ref: "approve" }).effect as JsonObject;
    f.service.externalEffectStart({ effect_id: unknown.id, approval_ref: "approve" });
    f.service.externalEffectReport({ effect_id: unknown.id, receipt_id: "resolve-receipt", status: "indeterminate",
      evidence_ids: [f.evidence.id] });
    const resolved = f.service.externalEffectResolve({ effect_id: unknown.id, resolution: "succeeded", resolver_type: "human",
      approval_ref: "human-review", remote_operation_id: "remote-reconciled", evidence_ids: [f.evidence.id] }).effect as JsonObject;
    assert.equal(resolved.remote_operation_id, "remote-reconciled");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("reconciler safely resolves ambiguous effects through authorized read-only status contracts", async () => {
  const f = await fixture("reconcile-http");
  const broker = new TrustedEgressBroker({ STATUS_KEY: "hidden" }, async () => [{ address: "1.1.1.1", family: 4 }],
    async ({ url }) => ({ status: url.pathname.includes("failed") ? 404 : url.pathname.includes("unknown") ? 202 : 200,
      headers: {}, body: "status", output_limited: false }));
  const service = new CraftService(f.store, undefined, undefined, undefined, broker); const server = new McpServer(service, "full");
  try {
    service.credentialHandleRegister({ handle_id: "status-key", provider: "api", secret_ref: "env:STATUS_KEY" });
    const lease = service.credentialLeaseIssue({ lease_id: "status-lease", task_id: f.task.id, handle_id: "status-key",
      allowed_hosts: ["api.example.com"], allowed_actions: ["read-status"], ttl_seconds: 3600 }).lease as JsonObject;
    const prepare = (id: string) => {
      service.externalEffectPrepare({ effect_id: id, task_id: f.task.id, provider: "api", action: "write", target: id,
        effect: "external_write", request_digest: `write:${id}`, idempotency_key: `reconcile:${id}:1`, approval_ref: "approve" });
      service.externalEffectStart({ effect_id: id, approval_ref: "approve" });
      service.externalEffectReport({ effect_id: id, receipt_id: `${id}-receipt`, status: "indeterminate", evidence_ids: [f.evidence.id] });
      const url = `https://api.example.com/${id}`; const requestDigest = egressRequestDigest("GET", url, {}, "");
      return service.egressAuthorize({ lease_id: lease.id, receipt_id: `${id}-auth`, url, action: "read-status", request_digest: requestDigest }).authorization as JsonObject;
    };
    const successAuth = prepare("success");
    const success = await server.handlers.craft_effect_reconciliation_execute({ reconciliation_id: "success-check",
      effect_id: "success", authorization_id: successAuth.id, succeeded_http_statuses: [200], failed_http_statuses: [404] });
    assert.equal((success.effect as JsonObject).status, "succeeded");
    assert.equal((await service.effectReconciliationExecute({ reconciliation_id: "success-check", effect_id: "success",
      authorization_id: successAuth.id, succeeded_http_statuses: [200], failed_http_statuses: [404] })).idempotent, true);
    const failedAuth = prepare("failed");
    assert.equal(((await service.effectReconciliationExecute({ effect_id: "failed", authorization_id: failedAuth.id,
      succeeded_http_statuses: [200], failed_http_statuses: [404] })).effect as JsonObject).status, "failed");
    const unknownAuth = prepare("unknown");
    const unknown = await service.effectReconciliationExecute({ effect_id: "unknown", authorization_id: unknownAuth.id,
      succeeded_http_statuses: [200], failed_http_statuses: [404] });
    assert.equal((unknown.effect as JsonObject).status, "indeterminate");
    assert.equal((unknown.reconciliation as JsonObject).status, "indeterminate");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("reconciler rejects unsafe mappings, cross-task authorization, invalid receipts, and ambiguous transport", async () => {
  const f = await fixture("reconcile-errors");
  const service = new CraftService(f.store, undefined, undefined, undefined,
    new TrustedEgressBroker({ STATUS_KEY: "hidden" }, async () => [{ address: "1.1.1.1", family: 4 }], async () => { throw "network unknown"; }));
  const base = { effect_id: "unknown", task_id: f.task.id, provider: "api", action: "write", target: "record",
    effect: "external_write", request_digest: "write:unknown", idempotency_key: "reconcile:error:1", approval_ref: "approve" };
  try {
    service.externalEffectPrepare(base); service.externalEffectStart({ effect_id: "unknown", approval_ref: "approve" });
    service.externalEffectReport({ effect_id: "unknown", receipt_id: "unknown-receipt", status: "indeterminate", evidence_ids: [f.evidence.id] });
    service.credentialHandleRegister({ handle_id: "status-key", provider: "api", secret_ref: "env:STATUS_KEY" });
    const lease = service.credentialLeaseIssue({ lease_id: "status-lease", task_id: f.task.id, handle_id: "status-key",
      allowed_hosts: ["api.example.com"], allowed_actions: ["read"], ttl_seconds: 3600 }).lease as JsonObject;
    const digest = egressRequestDigest("GET", "https://api.example.com/status", {}, "");
    const auth = service.egressAuthorize({ lease_id: lease.id, receipt_id: "status-auth", url: "https://api.example.com/status",
      action: "read", request_digest: digest }).authorization as JsonObject;
    assert.throws(() => service.effects.reconcileIssue({ effect_id: "unknown", authorization_id: auth.id,
      succeeded_http_statuses: [], failed_http_statuses: [404] }), /non-empty/);
    assert.throws(() => service.effects.reconcileIssue({ effect_id: "unknown", authorization_id: auth.id,
      succeeded_http_statuses: [99], failed_http_statuses: [404] }), /HTTP status/);
    assert.throws(() => service.effects.reconcileIssue({ effect_id: "unknown", authorization_id: auth.id,
      succeeded_http_statuses: [200, 200], failed_http_statuses: [404] }), /unique/);
    assert.throws(() => service.effects.reconcileIssue({ effect_id: "unknown", authorization_id: auth.id,
      succeeded_http_statuses: [200], failed_http_statuses: [200] }), /overlap/);
    service.effects.reconcileIssue({ reconciliation_id: "conflict", effect_id: "unknown", authorization_id: auth.id,
      succeeded_http_statuses: [200], failed_http_statuses: [404] });
    assert.throws(() => service.effects.reconcileIssue({ reconciliation_id: "conflict", effect_id: "unknown", authorization_id: auth.id,
      succeeded_http_statuses: [201], failed_http_statuses: [404] }), /idempotency/);
    f.store.create("effect_reconciliation", "closed", { effect_id: "unknown", status: "failed" });
    assert.throws(() => service.effects.reconcileReport({ reconciliation_id: "closed", execution_id: "missing" }), /not executing/);
    f.store.create("effect_reconciliation", "invalid-execution", { effect_id: "unknown", authorization_id: auth.id,
      succeeded_http_statuses: [200], failed_http_statuses: [404], status: "executing" });
    f.store.create("egress_execution", "wrong-execution", { authorization_id: "wrong", status: "completed", evidence_id: f.evidence.id, http_status: 200 });
    assert.throws(() => service.effects.reconcileReport({ reconciliation_id: "invalid-execution", execution_id: "wrong-execution" }), /completed authorized/);
    service.effects.reconcileIssue({ reconciliation_id: "transport-failure", effect_id: "unknown", authorization_id: auth.id,
      succeeded_http_statuses: [200], failed_http_statuses: [404] });
    await assert.rejects(service.effectReconciliationExecute({ reconciliation_id: "transport-failure", effect_id: "unknown",
      authorization_id: auth.id, succeeded_http_statuses: [200], failed_http_statuses: [404] }), (error) => error === "network unknown");
    assert.equal(f.store.get("effect_reconciliation", "transport-failure").status, "indeterminate");
    assert.equal((service.effects.reconcileFail({ reconciliation_id: "transport-failure", error_class: "again" }).reconciliation as JsonObject).status, "indeterminate");
    service.externalEffectPrepare({ ...base, effect_id: "error-object", idempotency_key: "reconcile:error:2" });
    service.externalEffectStart({ effect_id: "error-object", approval_ref: "approve" });
    service.externalEffectReport({ effect_id: "error-object", receipt_id: "error-object-receipt", status: "indeterminate", evidence_ids: [f.evidence.id] });
    const objectUrl = "https://api.example.com/error-object";
    const objectAuth = service.egressAuthorize({ lease_id: lease.id, receipt_id: "error-object-auth", url: objectUrl,
      action: "read", request_digest: egressRequestDigest("GET", objectUrl, {}, "") }).authorization as JsonObject;
    const errorService = new CraftService(f.store, undefined, undefined, undefined,
      new TrustedEgressBroker({ STATUS_KEY: "hidden" }, async () => [{ address: "1.1.1.1", family: 4 }], async () => { throw new Error("network error"); }));
    await assert.rejects(errorService.effectReconciliationExecute({ reconciliation_id: "object-failure", effect_id: "error-object",
      authorization_id: objectAuth.id, succeeded_http_statuses: [200], failed_http_statuses: [404] }), /network error/);
    assert.equal(f.store.get("effect_reconciliation", "object-failure").error_class, "Error");
    const other = service.taskOpen({ title: "Other", goal: "Other" }).task as JsonObject;
    f.store.create("egress_authorization", "other-auth", { task_id: other.id, status: "authorized" });
    assert.throws(() => service.effects.reconcileIssue({ effect_id: "unknown", authorization_id: "other-auth",
      succeeded_http_statuses: [200], failed_http_statuses: [404] }), /same-task/);
    service.externalEffectPrepare({ ...base, effect_id: "done", idempotency_key: "reconcile:done:1" });
    service.externalEffectStart({ effect_id: "done", approval_ref: "approve" });
    service.externalEffectReport({ effect_id: "done", receipt_id: "done-receipt", status: "succeeded",
      remote_operation_id: "remote-done", evidence_ids: [f.evidence.id] });
    assert.throws(() => service.effects.reconcileIssue({ effect_id: "done", authorization_id: auth.id,
      succeeded_http_statuses: [200], failed_http_statuses: [404] }), /indeterminate/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("compensation adapter executes exact authorized requests and preserves every remote outcome", async () => {
  const f = await fixture("compensation-http");
  const broker = new TrustedEgressBroker({ COMP_KEY: "hidden" }, async () => [{ address: "1.1.1.1", family: 4 }],
    async ({ url }) => {
      if (url.pathname.includes("transport-string")) throw "transport string";
      if (url.pathname.includes("transport")) throw new Error("transport uncertain");
      return { status: url.pathname.includes("failed") ? 409 : url.pathname.includes("unknown") ? 202 : 204,
        headers: {}, body: "", output_limited: false };
    });
  const service = new CraftService(f.store, undefined, undefined, undefined, broker); const server = new McpServer(service, "full");
  try {
    service.credentialHandleRegister({ handle_id: "comp-key", provider: "api", secret_ref: "env:COMP_KEY" });
    const lease = service.credentialLeaseIssue({ lease_id: "comp-lease", task_id: f.task.id, handle_id: "comp-key",
      allowed_hosts: ["api.example.com"], allowed_actions: ["undo"], approval_required_actions: ["undo"], ttl_seconds: 3600 }).lease as JsonObject;
    const prepare = (id: string) => {
      const url = `https://api.example.com/${id}`; const requestDigest = egressRequestDigest("POST", url, {}, "{}");
      service.externalEffectPrepare({ effect_id: id, task_id: f.task.id, provider: "api", action: "create", target: id,
        effect: "external_write", request_digest: `create:${id}`, idempotency_key: `compensate:${id}:1`, approval_ref: "approve",
        compensation: { action: "undo", request_digest: requestDigest } });
      service.externalEffectStart({ effect_id: id, approval_ref: "approve" });
      service.externalEffectReport({ effect_id: id, receipt_id: `${id}-receipt`, status: "succeeded",
        remote_operation_id: `remote-${id}`, evidence_ids: [f.evidence.id] });
      return service.egressAuthorize({ lease_id: lease.id, receipt_id: `${id}-auth`, url, action: "undo",
        request_digest: requestDigest, approval_ref: "human" }).authorization as JsonObject;
    };
    const successAuth = prepare("success");
    const success = await server.handlers.craft_effect_compensation_execute({ effect_id: "success", compensation_id: "success-comp",
      authorization_id: successAuth.id, approval_ref: "human", method: "POST", body: "{}",
      succeeded_http_statuses: [204], failed_http_statuses: [409] });
    assert.equal((success.effect as JsonObject).status, "compensated");
    assert.equal((await service.effectCompensationExecute({ effect_id: "success", compensation_id: "success-comp",
      authorization_id: successAuth.id, approval_ref: "human", method: "POST", body: "{}",
      succeeded_http_statuses: [204], failed_http_statuses: [409] })).idempotent, true);
    for (const [id, expected] of [["failed", "compensation_failed"], ["unknown", "compensation_indeterminate"]]) {
      const authorization = prepare(id);
      const result = await service.effectCompensationExecute({ effect_id: id, compensation_id: `${id}-comp`,
        authorization_id: authorization.id, approval_ref: "human", method: "POST", body: "{}",
        succeeded_http_statuses: [204], failed_http_statuses: [409] });
      assert.equal((result.effect as JsonObject).status, expected);
    }
    const transportAuth = prepare("transport");
    const transport = await service.effectCompensationExecute({ effect_id: "transport", compensation_id: "transport-comp",
      authorization_id: transportAuth.id, approval_ref: "human", method: "POST", body: "{}",
      succeeded_http_statuses: [204], failed_http_statuses: [409] });
    assert.equal((transport.effect as JsonObject).status, "compensation_indeterminate");
    assert.equal((transport.evidence as JsonObject).confidence, "bounded");
    const stringAuth = prepare("transport-string");
    const stringResult = await service.effectCompensationExecute({ effect_id: "transport-string", compensation_id: "transport-string-comp",
      authorization_id: stringAuth.id, approval_ref: "human", method: "POST", body: "{}",
      succeeded_http_statuses: [204], failed_http_statuses: [409] });
    assert.equal(((stringResult.evidence as JsonObject).locator as JsonObject).error_class, "UnknownError");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("compensation adapter rejects mismatched contracts and cancels only before dispatch", async () => {
  const f = await fixture("compensation-errors"); const service = f.service;
  const url = "https://api.example.com/undo"; const requestDigest = egressRequestDigest("POST", url, {}, "{}");
  try {
    service.externalEffectPrepare({ effect_id: "effect", task_id: f.task.id, provider: "api", action: "create", target: "record",
      effect: "external_write", request_digest: "create", idempotency_key: "compensation:error:1", approval_ref: "approve",
      compensation: { action: "undo", request_digest: requestDigest } });
    service.externalEffectStart({ effect_id: "effect", approval_ref: "approve" });
    service.externalEffectReport({ effect_id: "effect", receipt_id: "effect-receipt", status: "succeeded",
      remote_operation_id: "remote", evidence_ids: [f.evidence.id] });
    f.store.create("egress_authorization", "wrong", { task_id: f.task.id, status: "authorized", action: "other", request_digest: requestDigest });
    assert.throws(() => service.effectCompensationIssue({ effect_id: "effect", compensation_id: "wrong-comp",
      authorization_id: "wrong", approval_ref: "human", succeeded_http_statuses: [200], failed_http_statuses: [400] }), /exact executable/);
    service.credentialHandleRegister({ handle_id: "comp-key", provider: "api", secret_ref: "env:MISSING_COMP_KEY" });
    const lease = service.credentialLeaseIssue({ lease_id: "comp-lease", task_id: f.task.id, handle_id: "comp-key",
      allowed_hosts: ["api.example.com"], allowed_actions: ["undo"], ttl_seconds: 3600 }).lease as JsonObject;
    service.egressAuthorize({ lease_id: lease.id, receipt_id: "auth", url, action: "undo", request_digest: requestDigest });
    assert.throws(() => service.effectCompensationIssue({ effect_id: "effect", compensation_id: "overlap-comp",
      authorization_id: "auth", approval_ref: "human", succeeded_http_statuses: [200], failed_http_statuses: [200] }), /overlap/);
    service.effectCompensationIssue({ effect_id: "effect", compensation_id: "conflict-comp", authorization_id: "auth", approval_ref: "human",
      succeeded_http_statuses: [200], failed_http_statuses: [400] });
    assert.throws(() => service.effectCompensationIssue({ effect_id: "effect", compensation_id: "conflict-comp",
      authorization_id: "auth", approval_ref: "different", succeeded_http_statuses: [200], failed_http_statuses: [400] }), /idempotency/);
    f.store.create("effect_compensation", "invalid-execution-comp", { effect_id: "effect", authorization_id: "auth", status: "executing" });
    f.store.create("egress_execution", "invalid-comp-execution", { authorization_id: "wrong", status: "completed", evidence_id: f.evidence.id });
    assert.throws(() => service.effects.compensateFromExecution({ compensation_id: "invalid-execution-comp",
      execution_id: "invalid-comp-execution", succeeded_http_statuses: [200], failed_http_statuses: [400] }), /completed authorized/);
    const cancelEffect = service.externalEffectPrepare({ effect_id: "cancel-effect", task_id: f.task.id, provider: "api", action: "create",
      target: "record", effect: "external_write", request_digest: "create", idempotency_key: "compensation:cancel:1",
      approval_ref: "approve", compensation: { action: "undo", request_digest: requestDigest } }).effect as JsonObject;
    service.externalEffectStart({ effect_id: cancelEffect.id, approval_ref: "approve" });
    service.externalEffectReport({ effect_id: cancelEffect.id, receipt_id: "cancel-receipt", status: "succeeded",
      remote_operation_id: "remote-cancel", evidence_ids: [f.evidence.id] });
    await assert.rejects(service.effectCompensationExecute({ effect_id: cancelEffect.id, compensation_id: "cancel-comp",
      authorization_id: "auth", approval_ref: "human", method: "POST", body: "changed",
      succeeded_http_statuses: [200], failed_http_statuses: [400] }), /digest/);
    assert.equal(f.store.get("effect_compensation", "cancel-comp").status, "cancelled");
    assert.equal(f.store.get("external_effect", String(cancelEffect.id)).status, "succeeded");
    assert.equal((service.effects.compensateCancel({ compensation_id: "cancel-comp", error_class: "again" }).compensation as JsonObject).status, "cancelled");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
