import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import "./contracts.test.ts";
import "./capability-canary.test.ts";
import "./federation.test.ts";
import "./hub-sync.test.ts";
import "./materialization.test.ts";
import "./certification.test.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
async function fixture(name: string) {
  const root = join(tmpdir(), `craft-autonomy-${name}-${process.pid}-${Date.now()}`); await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  const task = service.taskOpen({ title: name, goal: "Act safely" }).task as JsonObject;
  return { root, store, service, task };
}

test("autonomy policies authorize, notify, approve, multi-sign, and consume exact requests once", async () => {
  const f = await fixture("lifecycle"); const mcp = new McpServer(f.service, "full");
  try {
    const saved = await mcp.handlers.craft_autonomy_policy_save({ policy_id: "policy", task_id: f.task.id, name: "Default",
      rules: { read: { level: "automatic" }, draft: { level: "notify_only" }, external_write: { level: "human_approval" },
        destructive: { level: "multi_sig", quorum: 2 } }, default_ttl_seconds: 600 });
    const policy = saved.policy as JsonObject;
    const automatic = (await mcp.handlers.craft_autonomy_request({ request_id: "read", policy_id: policy.id, policy_version: policy.version,
      task_id: f.task.id, action: "read", target: "report", request_digest: DIGEST, requested_by: "agent", now: "2030-01-01T00:00:00Z" })).request as JsonObject;
    assert.equal(automatic.status, "authorized");
    const consumed = await mcp.handlers.craft_autonomy_consume({ request_id: automatic.id, task_id: f.task.id, action: "read",
      target: "report", request_digest: DIGEST, idempotency_key: "use-read", now: "2030-01-01T00:00:01Z" });
    assert.equal((consumed.request as JsonObject).status, "consumed");
    assert.equal((await mcp.handlers.craft_autonomy_consume({ request_id: automatic.id, task_id: f.task.id, action: "read",
      target: "report", request_digest: DIGEST, idempotency_key: "use-read" })).idempotent, true);
    const generated = f.service.autonomyRequest({ policy_id: policy.id, policy_version: policy.version, task_id: f.task.id,
      action: "read", target: "generated", request_digest: DIGEST, requested_by: "agent" }).request as JsonObject;
    assert.match(String(generated.id), /^authorization_[a-f0-9]{32}$/u);

    const notify = f.service.autonomyRequest({ request_id: "notify", policy_id: policy.id, policy_version: policy.version,
      task_id: f.task.id, action: "draft", target: "proposal", request_digest: DIGEST, requested_by: "agent" }).request as JsonObject;
    assert.throws(() => f.service.autonomyConsume({ request_id: notify.id, task_id: f.task.id, action: "draft", target: "proposal",
      request_digest: DIGEST, idempotency_key: "n" }), /notification_ref/);
    assert.equal((f.service.autonomyConsume({ request_id: notify.id, task_id: f.task.id, action: "draft", target: "proposal",
      request_digest: DIGEST, idempotency_key: "n", notification_ref: "notice:1" }).consumption as JsonObject).notification_ref, "notice:1");

    const human = f.service.autonomyRequest({ request_id: "human", policy_id: policy.id, policy_version: policy.version,
      task_id: f.task.id, action: "external_write", target: "crm:42", request_digest: DIGEST, requested_by: "agent",
      now: "2030-01-01T00:00:00Z" }).request as JsonObject;
    assert.equal(human.status, "pending_approval");
    assert.equal(((await mcp.handlers.craft_autonomy_decide({ request_id: human.id, actor: "owner", decision: "approve",
      approval_ref: "approval:1", now: "2030-01-01T00:00:02Z" })).request as JsonObject).status, "authorized");
    assert.throws(() => f.service.autonomyDecide({ request_id: human.id, actor: "other", decision: "approve", approval_ref: "late" }), /not awaiting approval/);

    const multi = f.service.autonomyRequest({ request_id: "multi", policy_id: policy.id, policy_version: policy.version,
      task_id: f.task.id, action: "destructive", target: "record:42", request_digest: DIGEST, requested_by: "agent",
      now: "2030-01-01T00:00:00Z" }).request as JsonObject;
    assert.equal((f.service.autonomyDecide({ request_id: multi.id, actor: "a", decision: "approve", approval_ref: "a" }).request as JsonObject).status, "pending_approval");
    assert.throws(() => f.service.autonomyDecide({ request_id: multi.id, actor: "a", decision: "approve", approval_ref: "again" }), /already decided/);
    assert.equal((f.service.autonomyDecide({ request_id: multi.id, actor: "b", decision: "approve", approval_ref: "b" }).request as JsonObject).status, "authorized");
    const denied = f.service.autonomyRequest({ request_id: "deny", policy_id: policy.id, policy_version: policy.version,
      task_id: f.task.id, action: "external_write", target: "email", request_digest: DIGEST, requested_by: "agent",
      now: "2030-01-01T00:00:00Z" }).request as JsonObject;
    assert.equal((f.service.autonomyDecide({ request_id: denied.id, actor: "owner", decision: "deny", approval_ref: "no" }).request as JsonObject).status, "denied");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("autonomy fails closed on malformed policy, stale identity, expiry, and replay conflicts", async () => {
  const f = await fixture("errors");
  try {
    const base = { policy_id: "bad", task_id: f.task.id, name: "Bad" };
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: [] }), /rules must be an object/);
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: {} }), /at least one rule/);
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: { unknown: { level: "automatic" } } }), /Unsupported autonomy action/);
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: { read: [] } }), /rules.read must be an object/);
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: { read: { level: "magic" } } }), /Unsupported autonomy level/);
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: { financial: { level: "automatic" } } }), /cannot bypass/);
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: { destructive: { level: "notify_only" } } }), /cannot bypass/);
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: { destructive: { level: "multi_sig", quorum: 1 } } }), /integer between/);
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: { destructive: { level: "multi_sig", quorum: 21 } } }), /integer between/);
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: { read: { level: "automatic" } }, status: "gone" }), /status is unsupported/);
    assert.throws(() => f.service.autonomyPolicySave({ ...base, rules: { read: { level: "automatic" } }, default_ttl_seconds: 2 }), /integer between/);
    const policy = (f.service.autonomyPolicySave({ policy_id: "policy", task_id: f.task.id, name: "P",
      rules: { read: { level: "automatic" }, external_write: { level: "human_approval" } } }).policy as JsonObject);
    assert.throws(() => f.service.autonomyPolicySave({ policy_id: "policy", task_id: f.task.id, name: "P2",
      rules: { read: { level: "automatic" } }, expected_version: 9 }), /version conflict/);
    const paused = f.service.autonomyPolicySave({ policy_id: "policy", task_id: f.task.id, name: "P2",
      rules: { read: { level: "automatic" } }, status: "paused", expected_version: policy.version }).policy as JsonObject;
    const requestBase = { policy_id: paused.id, policy_version: paused.version, task_id: f.task.id, action: "read", target: "x",
      request_digest: DIGEST, requested_by: "agent" };
    assert.throws(() => f.service.autonomyRequest(requestBase), /not active/);
    const active = f.service.autonomyPolicySave({ policy_id: "policy", task_id: f.task.id, name: "P3",
      rules: { read: { level: "automatic" }, external_write: { level: "human_approval" } }, expected_version: paused.version }).policy as JsonObject;
    const current = { ...requestBase, policy_version: active.version };
    assert.throws(() => f.service.autonomyRequest({ ...current, task_id: "other" }), /another task/);
    assert.throws(() => f.service.autonomyRequest({ ...current, action: "draft" }), /not declared/);
    assert.throws(() => f.service.autonomyRequest({ ...current, request_digest: "bad" }), /sha256 hex/);
    assert.throws(() => f.service.autonomyRequest({ ...current, now: "bad" }), /ISO timestamp/);
    assert.throws(() => f.service.autonomyRequest({ ...current, ttl_seconds: 1 }), /integer between/);
    const request = f.service.autonomyRequest({ ...current, request_id: "same", now: "2030-01-01T00:00:00Z", ttl_seconds: 60 }).request as JsonObject;
    assert.equal(f.service.autonomyRequest({ ...current, request_id: "same" }).idempotent, true);
    assert.throws(() => f.service.autonomyRequest({ ...current, request_id: "same", target: "other" }), /idempotency conflict/);
    assert.throws(() => f.service.autonomyConsume({ request_id: request.id, task_id: "other", action: "read", target: "x",
      request_digest: DIGEST, idempotency_key: "k", now: "2030-01-01T00:00:01Z" }), /task_id mismatch/);
    assert.throws(() => f.service.autonomyConsume({ request_id: request.id, task_id: f.task.id, action: "draft", target: "x",
      request_digest: DIGEST, idempotency_key: "k", now: "2030-01-01T00:00:01Z" }), /action mismatch/);
    assert.throws(() => f.service.autonomyConsume({ request_id: request.id, task_id: f.task.id, action: "read", target: "other",
      request_digest: DIGEST, idempotency_key: "k", now: "2030-01-01T00:00:01Z" }), /target mismatch/);
    assert.throws(() => f.service.autonomyConsume({ request_id: request.id, task_id: f.task.id, action: "read", target: "x",
      request_digest: `sha256:${"b".repeat(64)}`, idempotency_key: "k", now: "2030-01-01T00:00:01Z" }), /request_digest mismatch/);
    f.service.autonomyConsume({ request_id: request.id, task_id: f.task.id, action: "read", target: "x", request_digest: DIGEST,
      idempotency_key: "k", now: "2030-01-01T00:00:01Z" });
    assert.throws(() => f.service.autonomyConsume({ request_id: request.id, task_id: f.task.id, action: "read", target: "x",
      request_digest: DIGEST, idempotency_key: "different" }), /idempotency conflict/);

    const pending = f.service.autonomyRequest({ ...current, request_id: "pending", action: "external_write", now: "2030-01-01T00:00:00Z",
      ttl_seconds: 60 }).request as JsonObject;
    assert.throws(() => f.service.autonomyConsume({ request_id: pending.id, task_id: f.task.id, action: "external_write", target: "x",
      request_digest: DIGEST, idempotency_key: "p" }), /not authorized/);
    assert.throws(() => f.service.autonomyDecide({ request_id: pending.id, actor: "a", decision: "maybe", approval_ref: "r" }), /decision is unsupported/);
    assert.throws(() => f.service.autonomyDecide({ request_id: pending.id, actor: "a", decision: "approve", approval_ref: "r",
      now: "2030-01-01T00:01:01Z" }), /expired/);
    const expired = f.service.autonomyRequest({ ...current, request_id: "expired", now: "2030-01-01T00:00:00Z", ttl_seconds: 60 }).request as JsonObject;
    assert.throws(() => f.service.autonomyConsume({ request_id: expired.id, task_id: f.task.id, action: "read", target: "x",
      request_digest: DIGEST, idempotency_key: "e", now: "2030-01-01T00:01:01Z" }), /expired/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("active autonomy policies are an atomic mandatory gate for external effects", async () => {
  const f = await fixture("effect-gate");
  try {
    const policy = f.service.autonomyPolicySave({ policy_id: "gate", task_id: f.task.id, name: "Gate",
      rules: { external_write: { level: "human_approval" } } }).policy as JsonObject;
    const prepare = (id: string, target = "customer") => f.service.externalEffectPrepare({ effect_id: id, task_id: f.task.id,
      provider: "crm", action: "update", target, effect: "external_write", request_digest: DIGEST,
      idempotency_key: `effect:${id}`, approval_ref: "legacy-approval" }).effect as JsonObject;
    const effect = prepare("guarded");
    assert.throws(() => f.service.externalEffectStart({ effect_id: effect.id, approval_ref: "legacy-approval" }), /request_id/);
    const request = f.service.autonomyRequest({ request_id: "effect-auth", policy_id: policy.id, policy_version: policy.version,
      task_id: f.task.id, action: "external_write", target: "customer", request_digest: DIGEST, requested_by: "agent" }).request as JsonObject;
    f.service.autonomyDecide({ request_id: request.id, actor: "owner", decision: "approve", approval_ref: "human" });
    const started = f.service.externalEffectStart({ effect_id: effect.id, approval_ref: "legacy-approval",
      authorization_request_id: request.id });
    assert.equal((started.effect as JsonObject).status, "executing"); assert.equal((started.authorization as JsonObject).status, "consumed");
    assert.equal((started.consumption as JsonObject).idempotency_key, "effect:guarded");
    assert.equal(f.service.externalEffectStart({ effect_id: effect.id, approval_ref: "legacy-approval" }).idempotent, true);
    assert.equal(f.service.effects.start({ effect_id: effect.id, approval_ref: "legacy-approval" }).idempotent, true);

    const staleEffect = prepare("stale");
    const stale = f.service.autonomyRequest({ request_id: "stale-auth", policy_id: policy.id, policy_version: policy.version,
      task_id: f.task.id, action: "external_write", target: "customer", request_digest: DIGEST, requested_by: "agent" }).request as JsonObject;
    f.service.autonomyDecide({ request_id: stale.id, actor: "owner", decision: "approve", approval_ref: "human" });
    f.service.autonomyPolicySave({ policy_id: "gate", task_id: f.task.id, name: "Gate v2",
      rules: { external_write: { level: "human_approval" } }, expected_version: policy.version });
    assert.throws(() => f.service.externalEffectStart({ effect_id: staleEffect.id, approval_ref: "legacy-approval",
      authorization_request_id: stale.id }), /does not match the active policy/);

    const latest = f.store.get("autonomy_policy", "gate");
    const duplicate = f.service.autonomyRequest({ request_id: "duplicate-auth", policy_id: latest.id, policy_version: latest.version,
      task_id: f.task.id, action: "external_write", target: "customer", request_digest: DIGEST, requested_by: "agent" }).request as JsonObject;
    f.service.autonomyDecide({ request_id: duplicate.id, actor: "owner", decision: "approve", approval_ref: "human" });
    f.service.autonomyConsume({ request_id: duplicate.id, task_id: f.task.id, action: "external_write", target: "customer",
      request_digest: DIGEST, idempotency_key: "effect:duplicate" });
    const duplicateEffect = prepare("duplicate");
    assert.throws(() => f.service.externalEffectStart({ effect_id: duplicateEffect.id, approval_ref: "legacy-approval",
      authorization_request_id: duplicate.id }), /already consumed/);

    f.service.autonomyPolicySave({ policy_id: "second", task_id: f.task.id, name: "Second",
      rules: { external_write: { level: "human_approval" } } });
    assert.throws(() => f.service.externalEffectStart({ effect_id: prepare("ambiguous").id, approval_ref: "legacy-approval",
      authorization_request_id: "missing" }), /unambiguous active/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
