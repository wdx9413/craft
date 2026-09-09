import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import "./codex-driver.test.ts";
import "./claude-driver.test.ts";
import "./host-run.test.ts";
import "./supervisor.test.ts";
import "./work-launch.test.ts";
import "./acceptance.test.ts";
import "./acceptance-runner.test.ts";
import "./acceptance-worker.test.ts";
import "./domain-kit.test.ts";
import { AttentionKernel } from "../src/attention.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftStore } from "../src/store.ts";
import { CraftService } from "../src/service.ts";
import { McpServer } from "../src/mcp.ts";

async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "craft-attention-")); const store = await new CraftStore(craftPaths(root)).open(); return { store, kernel: new AttentionKernel(store) }; }

test("attention inbox projects cross-kernel work by audience and priority without owning source state", async () => {
  const f = await fixture();
  f.store.create("recovery_item", "recover", { status: "open", task_id: "task", action: "resume_due_wait", priority: 90, subject_kind: "durable_wait", subject_id: "wait" });
  f.store.create("autonomy_request", "approval", { status: "pending_approval", task_id: "task", action: "external_write", target: "crm" });
  f.store.create("maintenance_component", "worker", { status: "open", next_retry_at: "2030-01-01T00:01:00Z", last_failure_fingerprint: "sha256:x" });
  f.store.create("maintenance_component", "worker2", { status: "degraded", next_retry_at: "2030-01-01T00:01:00Z" });
  f.store.create("speculative_candidate", "draft", { status: "ready", task_id: "task", expires_at: "2030-01-02T00:00:00Z" });
  f.store.create("work_launch", "launch", { status: "awaiting_approval", task_id: "task", host: "codex-cli", workspace: "C:/work", sandbox: "workspace-write" });
  const refreshed = f.kernel.refresh({ now: "2030-01-01T00:00:00Z" }); assert.equal(refreshed.count, 6); assert.equal(refreshed.open_count, 6);
  assert.equal((f.kernel.list({ now: "2030-01-01T00:00:00Z" }).items as object[]).length, 6);
  const humans = f.kernel.list({ audience: "human", now: "2030-01-01T00:00:00Z" }).items as Record<string, unknown>[];
  assert.deepEqual(humans.map((item) => item.action), ["review_authorization", "review_work_launch", "review_speculative_candidate"]);
  assert.equal((f.kernel.list({ audience: "operator", limit: 1 }).items as object[]).length, 1); f.store.close();
});

test("acknowledge and defer are stable until source changes or disappears", async () => {
  const f = await fixture(); f.store.create("recovery_item", "recover", { status: "open", action: "retry", priority: 10, subject_kind: "x", subject_id: "y" });
  const card = (f.kernel.refresh({ now: "2030-01-01T00:00:00Z" }).cards as Record<string, unknown>[])[0];
  const deferred = f.kernel.decide({ item_id: card.id, decision: "defer", decided_by: "user", reason: "later", now: "2030-01-01T00:00:00Z", deferred_until: "2030-01-01T01:00:00Z" }).item as Record<string, unknown>;
  assert.equal((f.kernel.list({ now: "2030-01-01T00:30:00Z" }).items as object[]).length, 0);
  assert.equal((f.kernel.list({ now: "2030-01-01T01:00:00Z" }).items as object[]).length, 1);
  assert.equal((f.kernel.refresh({ now: "2030-01-01T00:30:00Z" }).cards as Record<string, unknown>[])[0].version, deferred.version);
  f.store.save("recovery_item", "recover", { status: "open", action: "retry", priority: 10, subject_kind: "x", subject_id: "y" });
  const reopened = (f.kernel.refresh({ now: "2030-01-01T00:30:00Z" }).cards as Record<string, unknown>[])[0]; assert.equal(reopened.status, "open");
  const acknowledged = f.kernel.decide({ item_id: reopened.id, decision: "acknowledge", decided_by: "user" }).item as Record<string, unknown>; assert.equal(acknowledged.status, "acknowledged");
  assert.equal((f.kernel.refresh().cards as Record<string, unknown>[])[0].status, "acknowledged");
  f.store.save("recovery_item", "recover", { status: "completed", action: "retry", priority: 10, subject_kind: "x", subject_id: "y" }); f.kernel.refresh({ now: "2030-01-02T00:00:00Z" });
  assert.equal(f.store.get("attention_item", String(card.id)).status, "resolved"); f.store.close();
});

test("attention input and lifecycle guards reject ambiguous operations", async () => {
  const f = await fixture();
  assert.throws(() => f.kernel.refresh({ now: "never" }), /ISO/); assert.throws(() => f.kernel.refresh({ now: " " }), /not be empty/); assert.throws(() => f.kernel.refresh({ limit: 0 }), /between/); assert.throws(() => f.kernel.refresh({ limit: 1.5 }), /between/);
  assert.throws(() => f.kernel.list({ audience: "nobody" }), /unsupported/); assert.throws(() => f.kernel.list({ limit: 1001 }), /between/);
  f.store.create("attention_item", "card", { status: "open" });
  assert.throws(() => f.kernel.decide({ item_id: "card", decision: "skip", decided_by: "u" }), /unsupported/);
  assert.throws(() => f.kernel.decide({ item_id: "card", decision: "defer", decided_by: "u", now: "2030-01-01T00:00:00Z" }), /deferred_until/);
  assert.throws(() => f.kernel.decide({ item_id: "card", decision: "defer", decided_by: "u", now: "2030-01-01T00:00:00Z", deferred_until: "2029-01-01T00:00:00Z" }), /later/);
  f.kernel.decide({ item_id: "card", decision: "acknowledge", decided_by: "u" });
  assert.throws(() => f.kernel.decide({ item_id: "card", decision: "acknowledge", decided_by: "u" }), /not actionable/); f.store.close();
});

test("expired deferrals reopen and unrelated cards do not appear in filtered views", async () => {
  const f = await fixture(); f.store.create("recovery_item", "b", { status: "open", action: "same", priority: 1, subject_kind: "x", subject_id: "b" });
  f.store.create("recovery_item", "a", { status: "open", action: "same", priority: 1, subject_kind: "x", subject_id: "a" });
  const cards = f.kernel.refresh({ now: "2030-01-01T00:00:00Z" }).cards as Record<string, unknown>[];
  f.kernel.decide({ item_id: cards[0].id, decision: "defer", decided_by: "u", now: "2030-01-01T00:00:00Z", deferred_until: "2030-01-01T00:01:00Z" });
  assert.equal((f.kernel.refresh({ now: "2030-01-01T00:01:00Z" }).cards as Record<string, unknown>[])[0].status, "open");
  assert.equal((f.kernel.list({ audience: "agent" }).items as object[]).length, 2);
  assert.equal((f.kernel.list({ audience: "human" }).items as object[]).length, 0); f.store.close();
});

test("service and MCP expose the attention projection without granting source actions", async () => {
  const f = await fixture(); const service = new CraftService(f.store); const server = new McpServer(service);
  assert.equal(service.attentionRefresh({ now: "2030-01-01T00:00:00Z" }).count, 0);
  assert.equal(service.attentionList({}).count, 0);
  f.store.create("attention_item", "manual", { status: "open" });
  assert.equal((service.attentionDecide({ item_id: "manual", decision: "acknowledge", decided_by: "user" }).item as Record<string, unknown>).status, "acknowledged");
  for (const [name, args] of [["craft_attention_refresh", {}], ["craft_attention_list", {}], ["craft_attention_decide", {}]] as const) {
    const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: args } });
    assert.equal((response?.result as Record<string, unknown>).isError, name === "craft_attention_decide");
  }
  f.store.close();
});
