import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { WorkbenchAgentSessionLinks } from "../core/application/use-cases/workbench-agent-session-links.ts";
import { WorkbenchMessageQueue } from "../core/interfaces/workbench-message-queue.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-native-links-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "one", { title: "One" });
  store.create("task", "two", { title: "Two" });
  return { root, store, links: new WorkbenchAgentSessionLinks(store) };
}

test("configuration changes only while idle and without pending messages", async () => {
  const f = await fixture();
  try {
    const link = f.links.bind({ task_id: "one", provider: "codex", native_session_id: "thread-config", workspace: f.root, permission: "ask", model: "a" }).link as Record<string, unknown>, id = String(link.id);
    assert.throws(() => f.links.configure("two", id, "b", "full"), /does not belong/);
    assert.throws(() => f.links.configure("one", id, "", "full"), /model/);
    assert.throws(() => f.links.configure("one", id, "b", "invalid"), /permission/);
    const queue = new WorkbenchMessageQueue(f.store), queued = queue.enqueue("one", id, "hello");
    assert.throws(() => f.links.configure("one", id, "b", "full"), /排队/);
    queue.cancel("one", id, String(queued.id));
    assert.equal(f.links.configure("one", id, "b", "full").permission, "full");
    f.links.reserveTurn("one", id, "op"); assert.throws(() => f.links.configure("one", id, "a", "ask"), /运行中/);
    f.store.close(); const reopened = await new CraftStore(craftPaths(f.root)).open();
    try { assert.equal(new WorkbenchAgentSessionLinks(reopened).get("one", id).model, "b"); } finally { reopened.close(); }
  } finally { try { f.store.close(); } catch {} rmSync(f.root, { recursive: true, force: true }); }
});

test("native sessions remain separate, persist across reopening, and unlink leaves native data untouched", async () => {
  const f = await fixture();
  try {
    const nativeHistory = join(f.root, "native-history.jsonl");
    writeFileSync(nativeHistory, "native session history\n");
    const args = { task_id: "one", provider: "codex", native_session_id: "thread-a", workspace: f.root, permission: "ask", model: "model-a", prompt: "must not persist" };
    const a = f.links.bind(args).link as Record<string, unknown>;
    const b = f.links.bind({ ...args, provider: "claude", native_session_id: "session-b", model: null }).link as Record<string, unknown>;
    assert.notEqual(a.id, b.id);
    assert.equal(f.links.bind(args).idempotent, true);
    assert.throws(() => f.links.bind({ ...args, task_id: "two" }), /already linked/);
    assert.throws(() => f.links.get("two", a.id), /does not belong/);
    assert.equal((f.links.list("one").links as unknown[]).length, 2);
    assert.deepEqual(f.links.list("two"), { links: [], truncated: false });
    assert.equal("prompt" in a, false);
    assert.equal(f.store.list("task_message", 100).length, 0);
    f.store.close();
    const reopened = await new CraftStore(craftPaths(f.root)).open();
    try {
      const links = new WorkbenchAgentSessionLinks(reopened);
      assert.equal(links.get("one", a.id).native_session_id, "thread-a");
      links.unlink("one", a.id);
      assert.equal(readFileSync(nativeHistory, "utf8"), "native session history\n");
      assert.equal((links.list("one").links as unknown[]).length, 1);
      assert.throws(() => links.get("one", a.id), /Unknown/);
      assert.equal(links.get("one", b.id).native_session_id, "session-b");
    } finally { reopened.close(); }
  } finally { try { f.store.close(); } catch {} rmSync(f.root, { recursive: true, force: true }); }
});

test("invalid identities, paths, models and permissions fail before a link is written", async () => {
  const f = await fixture();
  try {
    const args = { task_id: "one", provider: "codex", native_session_id: "native", workspace: f.root, permission: "read_only" };
    writeFileSync(join(f.root, "file"), "file");
    for (const patch of [
      { task_id: "missing" }, { task_id: "" }, { task_id: null }, { provider: "other" },
      { native_session_id: "\n" }, { native_session_id: "x".repeat(513) },
      { workspace: "relative" }, { workspace: join(f.root, "file") }, { workspace: join(f.root, "missing") },
      { model: " " }, { permission: "bypass" },
    ]) assert.throws(() => f.links.bind({ ...args, ...patch }));
    assert.deepEqual(f.links.list("one"), { links: [], truncated: false });
    assert.throws(() => f.links.get("", "id"), /task_id/);
    assert.throws(() => f.links.get("one", ""), /link_id/);
  } finally { f.store.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("concurrent duplicate binding reconciles only matching metadata and propagates storage failure", async () => {
  const f = await fixture();
  try {
    const args = { task_id: "one", provider: "codex", native_session_id: "raced", workspace: f.root, permission: "ask" };
    const create = f.store.create.bind(f.store);
    f.store.create = ((kind, id, payload) => { create(kind, id, payload); throw new Error("race"); }) as typeof f.store.create;
    assert.equal(f.links.bind(args).idempotent, true);
    f.store.create = (() => { throw new Error("storage failed"); }) as typeof f.store.create;
    assert.throws(() => f.links.bind({ ...args, native_session_id: "other" }), /storage failed/);
  } finally { f.store.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("session listing signals when the task has more than the display limit", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 101; i++) f.links.bind({ task_id: "one", provider: "codex", native_session_id: `thread-${i}`, workspace: f.root, permission: "read_only" });
    const result = f.links.list("one");
    assert.equal((result.links as unknown[]).length, 100);
    assert.equal(result.truncated, true);
  } finally { f.store.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("turn reservation survives restart and requires matching terminal evidence before another send", async () => {
  const f = await fixture();
  const link = f.links.bind({ task_id: "one", provider: "codex", native_session_id: "thread", workspace: f.root, permission: "ask" }).link as Record<string, unknown>;
  try {
    assert.equal(f.links.reserveTurn("one", link.id, "op").turn_state, "starting");
    assert.throws(() => f.links.identifyUnknownTurn("one", link.id, "op", "turn"), /reservation/);
    assert.throws(() => f.links.reserveTurn("one", link.id, "other"), /unsettled/);
    assert.throws(() => f.links.unlink("one", link.id), /unsettled/);
    assert.throws(() => f.links.acknowledgeTurn("one", link.id, "other", "turn"), /reservation/);
    assert.equal(f.links.acknowledgeTurn("one", link.id, "op", "turn").turn_state, "running");
    assert.throws(() => f.links.markTurnUnknown("one", link.id, "other"), /reservation/);
    assert.equal(f.links.markTurnUnknown("one", link.id, "op").turn_state, "unknown");
    f.store.close();
    const reopened = await new CraftStore(craftPaths(f.root)).open();
    try {
      const links = new WorkbenchAgentSessionLinks(reopened);
      assert.equal(links.get("one", link.id).turn_state, "unknown");
      assert.throws(() => links.reserveTurn("one", link.id, "retry"), /unsettled/);
      assert.throws(() => links.completeTurn("one", link.id, "op", "turn", "running"), /invalid/);
      assert.throws(() => links.completeTurn("one", link.id, "op", "wrong", "completed"), /identity/);
      assert.throws(() => links.completeTurn("one", link.id, "other", "turn", "completed"), /identity/);
      const finished = links.completeTurn("one", link.id, "op", "turn", "interrupted");
      assert.equal(finished.turn_state, "idle"); assert.equal(finished.last_turn_status, "interrupted");
      assert.equal(links.reserveTurn("one", link.id, "next").turn_state, "starting");
      assert.equal(links.markTurnUnknown("one", link.id, "next").turn_state, "unknown");
      assert.throws(() => links.identifyUnknownTurn("one", link.id, "other", "turn"), /reservation/);
      assert.equal(links.identifyUnknownTurn("one", link.id, "next", "turn-2").turn_id, "turn-2");
      assert.throws(() => links.identifyUnknownTurn("one", link.id, "next", "turn-2"), /reservation/);
    } finally { reopened.close(); }
  } finally { try { f.store.close(); } catch {} rmSync(f.root, { recursive: true, force: true }); }
});

test("a competing update prevents a stale turn reservation", async () => {
  const f = await fixture();
  try {
    const link = f.links.bind({ task_id: "one", provider: "claude", native_session_id: "session", workspace: f.root, permission: "ask" }).link as Record<string, unknown>;
    const original = f.store.updateIfVersion.bind(f.store);
    f.store.updateIfVersion = ((kind, id, version, payload) => {
      original(kind, id, version, { ...payload, operation_id: "competitor" });
      return original(kind, id, version, payload);
    }) as typeof f.store.updateIfVersion;
    assert.throws(() => f.links.reserveTurn("one", link.id, "mine"), /Concurrent update/);
    assert.equal(f.links.get("one", link.id).operation_id, "competitor");
  } finally { f.store.close(); rmSync(f.root, { recursive: true, force: true }); }
});
