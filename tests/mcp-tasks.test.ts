import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore } from "../src/infrastructure/store.ts";
import { McpTaskKernel } from "../src/mcp-tasks.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "craft-mcp-task-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, tasks: new McpTaskKernel(store), service: new CraftService(store) };
}

test("MCP Tasks persist before return, are idempotent, owner scoped and terminal", async () => {
  const { tasks, service } = await setup();
  const first = tasks.create({ request_id: "r1", operation: "demo", input: { secret: "not stored" }, owner: "alice", ttl_seconds: 60 });
  assert.equal(first.idempotent, false);
  const same = tasks.create({ request_id: "r1", operation: "demo", input: { secret: "not stored" }, owner: "alice" });
  assert.equal(same.idempotent, true);
  assert.throws(() => tasks.get({ task_id: String((first.task as any).id), owner: "bob" }), /not visible/);
  const waiting = tasks.update({ task_id: String((first.task as any).id), owner: "alice", status: "input_required" });
  assert.equal((waiting.task as any).status, "input_required");
  const done = tasks.update({ task_id: String((first.task as any).id), owner: "alice", status: "completed", result_digest: "sha256:result" });
  assert.equal((done.task as any).status, "completed");
  assert.equal((tasks.update({ task_id: String((first.task as any).id), owner: "alice", status: "failed" }) as any).idempotent, true);
  assert.equal((tasks.get({ task_id: String((first.task as any).id), owner: "alice" }).task as any).input, undefined);
  const facade = service.mcpTaskCreate({ request_id: "facade", operation: "demo", owner: "alice" });
  assert.equal((service.mcpTaskGet({ task_id: String((facade.task as any).id), owner: "alice" }).task as any).status, "working");
  assert.equal((service.mcpTaskUpdate({ task_id: String((facade.task as any).id), owner: "alice", status: "completed" }).task as any).status, "completed");
  assert.equal((service.mcpTaskCancel({ task_id: String((facade.task as any).id), owner: "alice" }) as any).idempotent, true);
  assert.equal(service.mcpTaskExpire({}).count, 0);
});

test("MCP Tasks expire by bounded TTL and cancellation is idempotent", async () => {
  const { tasks } = await setup();
  const created = tasks.create({ request_id: "r2", operation: "demo", owner: null, ttl_seconds: 1, poll_interval_ms: 100 });
  const id = String((created.task as any).id);
  const expired = tasks.expire({ now: new Date(Date.now() + 2_000).toISOString() });
  assert.equal(expired.count, 1);
  assert.equal((tasks.get({ task_id: id }).task as any).status, "expired");
  const next = tasks.create({ request_id: "r3", operation: "demo", owner: null, ttl_seconds: 60 });
  const nextId = String((next.task as any).id);
  assert.equal((tasks.cancel({ task_id: nextId, reason: "stop" }).task as any).status, "cancelled");
  assert.equal((tasks.cancel({ task_id: nextId }).idempotent), true);
  const auto = tasks.create({ request_id: "r5", operation: "demo", ttl_seconds: 60 });
  assert.equal(tasks.expire().count, 0);
  assert.equal((tasks.get({ task_id: String((auto.task as any).id) }).task as any).status, "working");
});

test("MCP Task get expires an overdue task on read", async () => {
  const { tasks } = await setup();
  const created = tasks.create({ request_id: "r6", operation: "demo", ttl_seconds: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal((tasks.get({ task_id: String((created.task as any).id) }).task as any).status, "expired");
});

test("MCP Task validation and explicit identifiers fail closed", async () => {
  const { tasks } = await setup();
  assert.throws(() => tasks.create({ request_id: "bad", operation: "x", ttl_seconds: 0 }), /ttl_seconds/);
  assert.throws(() => tasks.create({ request_id: "bad-poll", operation: "x", poll_interval_ms: 99 }), /poll_interval_ms/);
  assert.throws(() => tasks.create({ request_id: "bad-poll-high", operation: "x", poll_interval_ms: 86_400_001 }), /poll_interval_ms/);
  const created = tasks.create({ task_id: "explicit", request_id: "r4", operation: "x", input_digest: "sha256:i", owner: "a" });
  assert.throws(() => tasks.create({ task_id: "explicit", request_id: "different", operation: "x", input_digest: "sha256:i", owner: "a" }), /idempotency conflict/);
  assert.throws(() => tasks.update({ task_id: "explicit", owner: "a", status: "unknown" }), /Unsupported/);
  assert.equal((tasks.update({ task_id: "explicit", owner: "a" }).task as any).status, "working");
  assert.equal((tasks.update({ task_id: "explicit", owner: "a", input_digest: "sha256:new", result_digest: "sha256:result", error_code: "none", status: "working" }).task as any).status, "working");
  assert.throws(() => tasks.expire({ now: "not-a-date" }), /ISO timestamp/);
  assert.throws(() => tasks.get({ task_id: "explicit", owner: "" }), /owner must not be empty/);
  assert.equal((created.task as any).id, "explicit");
});
