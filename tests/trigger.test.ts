import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TrustedEgressBroker } from "../src/egress.ts";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

const SECRET = "webhook-test-secret";
function signature(timestamp: string, body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}
async function fixture(name: string) {
  const root = join(tmpdir(), `craft-trigger-${name}-${process.pid}-${Date.now()}`);
  const store = await new CraftStore(craftPaths(root)).open();
  const broker = new TrustedEgressBroker({ HOOK_SECRET: SECRET });
  const service = new CraftService(store, undefined, undefined, undefined, broker);
  const task = service.taskOpen({ title: name, goal: "Receive signed events" }).task as JsonObject;
  service.credentialHandleRegister({ handle_id: "hook", provider: "webhook", secret_ref: "env:HOOK_SECRET" });
  return { root, store, service, task };
}

test("signed webhook subscriptions filter, throttle, budget, project, deduplicate, and wake exact waits", async () => {
  const f = await fixture("lifecycle"); const server = new McpServer(f.service, "full");
  const now = "2029-01-01T00:00:00.000Z";
  try {
    f.service.budgetOpen({ budget_id: "trigger-budget", owner_type: "task", owner_id: f.task.id, limits: { events: 3 } });
    f.service.durableWaitCreate({ wait_id: "hook-wait", task_id: f.task.id, condition: "event", event_key: "monitor.alert" });
    const saved = await server.handlers.craft_trigger_subscription_save({ subscription_id: "alerts", task_id: f.task.id,
      name: "Alerts", event_key: "monitor.alert", handle_id: "hook", filters: { kind: "alert" },
      allowed_fields: ["kind", "title"], max_age_seconds: 300, throttle_seconds: 60,
      budget_id: "trigger-budget", per_event_resources: { events: 1 } });
    assert.equal((saved.subscription as JsonObject).version, 1);
    const body = JSON.stringify({ kind: "alert", title: "Database slow", ignored: "raw detail" });
    const delivered = await server.handlers.craft_webhook_trigger_ingest({ subscription_id: "alerts", event_id: "evt1",
      timestamp: now, now, signature: signature(now, body), raw_body: body });
    assert.equal((delivered.trigger_event as JsonObject).status, "delivered");
    assert.deepEqual((delivered.dispatch as JsonObject).payload, { kind: "alert", title: "Database slow" });
    assert.equal((delivered.dispatch as JsonObject).execution_authority, false);
    assert.equal(f.store.get("durable_wait", "hook-wait").status, "resumed");
    assert.equal(Object.hasOwn(delivered.trigger_event as JsonObject, "raw_body"), false);
    const repeated = f.service.webhookTriggerIngest({ subscription_id: "alerts", event_id: "evt1",
      timestamp: now, now, signature: signature(now, body), raw_body: body });
    assert.equal(repeated.idempotent, true); assert.equal((repeated.trigger_event as JsonObject).status, "delivered");

    const secondBody = JSON.stringify({ kind: "alert", title: "Second" });
    const throttled = f.service.webhookTriggerIngest({ subscription_id: "alerts", event_id: "evt2",
      timestamp: now, now, signature: signature(now, secondBody), raw_body: secondBody });
    assert.equal((throttled.trigger_event as JsonObject).status, "throttled"); assert.equal(throttled.dispatch, null);
    const ignoredBody = JSON.stringify({ kind: "notice", title: "Ignored" });
    const ignored = f.service.webhookTriggerIngest({ subscription_id: "alerts", event_id: "evt3",
      timestamp: now, now, signature: signature(now, ignoredBody), raw_body: ignoredBody });
    assert.equal((ignored.trigger_event as JsonObject).status, "ignored");

    const updated = f.service.triggerSubscriptionSave({ subscription_id: "alerts", expected_version: 1, task_id: f.task.id,
      name: "Alerts paused", event_key: "monitor.alert", handle_id: "hook", filters: {}, allowed_fields: [], status: "paused" });
    assert.equal((updated.subscription as JsonObject).version, 2);
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "alerts", event_id: "evt4",
      timestamp: now, now, signature: signature(now, "{}"), raw_body: "{}" }), /not active/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("webhook ingress fails closed for replay, signatures, raw data, schema, secret, version, and budget errors", async () => {
  const f = await fixture("errors"); const now = "2029-01-01T00:00:00.000Z";
  const base = { subscription_id: "hook-sub", task_id: f.task.id, name: "Hook", event_key: "hook.event", handle_id: "hook" };
  try {
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, subscription_id: "bad id" }), /invalid/);
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, name: " " }), /name/);
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, filters: [] }), /object/);
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, filters: { secret: "x" } }), /sensitive/);
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, filters: { nested: {} } }), /bounded scalar/);
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, allowed_fields: new Array(33).fill("x") }), /at most 32/);
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, allowed_fields: ["token"] }), /sensitive/);
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, max_age_seconds: 1 }), /between/);
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, throttle_seconds: 4000 }), /between/);
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, per_event_resources: { events: -1 } }), /non-negative/);
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, status: "deleted" }), /unsupported/);
    f.service.budgetOpen({ budget_id: "closed-budget", owner_type: "task", owner_id: f.task.id, limits: {} });
    f.service.budgetClose({ budget_id: "closed-budget" });
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, subscription_id: "closed-budget-sub",
      budget_id: "closed-budget" }), /must be active/);
    f.service.triggerSubscriptionSave({ ...base, subscription_id: "scalar-filter", filters: { count: 1, enabled: true, empty: null } });
    f.service.triggerSubscriptionSave({ ...base, filters: {}, allowed_fields: ["kind"] });
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, expected_version: 2 }), /version conflict/);

    const body = JSON.stringify({ kind: "event" });
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "hook-sub", event_id: "old",
      timestamp: "2028-01-01T00:00:00.000Z", now, signature: signature("2028-01-01T00:00:00.000Z", body), raw_body: body }), /replay/);
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "hook-sub", event_id: "bad-signature",
      timestamp: now, now, signature: "sha256=bad", raw_body: body }), /signature/);
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "hook-sub", event_id: "bad-now",
      timestamp: now, now: "invalid", signature: signature(now, body), raw_body: body }), /ISO/);
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "hook-sub", event_id: "bad-json",
      timestamp: now, now, signature: signature(now, "not-json"), raw_body: "not-json" }), /JSON object/);
    const arrayBody = "[]";
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "hook-sub", event_id: "array",
      timestamp: now, now, signature: signature(now, arrayBody), raw_body: arrayBody }), /JSON object/);
    const nestedBody = JSON.stringify({ kind: {} });
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "hook-sub", event_id: "nested",
      timestamp: now, now, signature: signature(now, nestedBody), raw_body: nestedBody }), /bounded scalar/);
    const accepted = f.service.webhookTriggerIngest({ subscription_id: "hook-sub", event_id: "same",
      timestamp: now, now, signature: signature(now, body), raw_body: body });
    assert.equal((accepted.trigger_event as JsonObject).status, "delivered");
    const changed = JSON.stringify({ kind: "changed" });
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "hook-sub", event_id: "same",
      timestamp: now, now, signature: signature(now, changed), raw_body: changed }), /idempotency/);
    const later = "2029-01-01T00:00:01.000Z";
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "hook-sub", event_id: "same",
      timestamp: later, now: later, signature: signature(later, body), raw_body: body }), /idempotency/);

    f.service.triggerSubscriptionSave({ ...base, subscription_id: "sorting", throttle_seconds: 0 });
    for (const [eventId, timestamp] of [["sort1", now], ["sort2", later], ["sort3", "2029-01-01T00:00:02.000Z"]]) {
      const rawSignature = signature(timestamp, body).slice("sha256=".length);
      f.service.webhookTriggerIngest({ subscription_id: "sorting", event_id: eventId, timestamp,
        now: timestamp, signature: rawSignature, raw_body: body });
    }

    const current = new Date().toISOString(); const currentBody = JSON.stringify({ kind: "current" });
    f.service.webhookTriggerIngest({ subscription_id: "sorting", event_id: "default-clock", timestamp: current,
      signature: signature(current, currentBody), raw_body: currentBody });

    f.service.credentialHandleRegister({ handle_id: "missing-hook", provider: "webhook", secret_ref: "env:MISSING_HOOK_SECRET" });
    f.service.triggerSubscriptionSave({ ...base, subscription_id: "missing-secret", handle_id: "missing-hook" });
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "missing-secret", event_id: "missing",
      timestamp: now, now, signature: signature(now, body), raw_body: body }), /unavailable/);
    f.store.create("credential_handle", "malformed-hook", { provider: "webhook", status: "active", secret_ref: "literal" });
    f.service.triggerSubscriptionSave({ ...base, subscription_id: "malformed-secret", handle_id: "malformed-hook" });
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "malformed-secret", event_id: "malformed",
      timestamp: now, now, signature: signature(now, body), raw_body: body }), /unavailable/);
    f.store.create("credential_handle", "empty-hook", { provider: "webhook", status: "active" });
    f.service.triggerSubscriptionSave({ ...base, subscription_id: "empty-secret", handle_id: "empty-hook" });
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "empty-secret", event_id: "empty",
      timestamp: now, now, signature: signature(now, body), raw_body: body }), /unavailable/);
    f.store.save("credential_handle", "hook", { ...f.store.get("credential_handle", "hook"), status: "revoked" });
    assert.throws(() => f.service.triggerSubscriptionSave({ ...base, subscription_id: "revoked" }), /not active/);

    f.store.save("credential_handle", "hook", { ...f.store.get("credential_handle", "hook"), status: "active" });
    f.service.budgetOpen({ budget_id: "empty", owner_type: "task", owner_id: f.task.id, limits: { events: 0 } });
    f.service.triggerSubscriptionSave({ ...base, subscription_id: "budgeted", budget_id: "empty", per_event_resources: { events: 1 } });
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "budgeted", event_id: "budget-event",
      timestamp: now, now, signature: signature(now, body), raw_body: body }), /exceeds/);
    assert.equal(f.store.get("trigger_event", "budgeted_budget-event").status, "awaiting_budget");
    assert.throws(() => f.service.webhookTriggerIngest({ subscription_id: "hook-sub", event_id: "huge",
      timestamp: now, now, signature: "sha256=" + "a".repeat(64), raw_body: "x".repeat(1024 * 1024 + 1) }), /1 MiB/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
