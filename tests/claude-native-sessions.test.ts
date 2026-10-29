import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { WorkbenchAgentSessionLinks } from "../core/application/use-cases/workbench-agent-session-links.ts";
import { ClaudeNativeSessions } from "../core/interfaces/claude-native-sessions.ts";

test("Claude native discovery paginates and import verifies identity before linking", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-native-")));
  const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "one", {}); store.create("task", "other", {});
  const id = "12345678-1234-1234-1234-123456789012";
  const info = { sessionId: id, cwd: root, summary: "a session", lastModified: 1 };
  let mismatch = false;
  const native = new ClaudeNativeSessions(new WorkbenchAgentSessionLinks(store), async options => options?.offset ? [info] : Array.from({ length: 51 }, () => info), async () => mismatch ? { ...info, sessionId: "another" } : info);
  try {
    assert.equal((await native.list(0)).next_cursor, "50"); assert.equal((await native.list(50)).next_cursor, null);
    await assert.rejects(native.list(-1), /offset/);
    await assert.rejects(native.list(Number.MAX_SAFE_INTEGER + 1), /offset/);
    await assert.rejects(native.import("one", "../bad", null, "ask"), /session id/);
    await assert.rejects(native.import("one", id, null, "invalid"), /permission/);
    await assert.rejects(native.import("one", id, "\n", "ask"), /model/);
    await assert.rejects(native.import("one", id, 123, "ask"), /model/);
    mismatch = true; await assert.rejects(native.import("one", id, null, "ask"), /verified/); mismatch = false;
    const link = (await native.import("one", id, "sonnet", "ask")).link as Record<string, unknown>;
    assert.equal(link.native_session_id, id); assert.equal(link.model, "sonnet");
    assert.equal(((await native.list(50)).threads as any[])[0].linked_id, link.id);
    await assert.rejects(native.import("other", id, "sonnet", "ask"), /already linked/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Claude discovery rejects malformed pages and filters sessions without usable identity", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-native-")));
  const store = await new CraftStore(craftPaths(root)).open(); store.create("task", "one", {});
  const links = new WorkbenchAgentSessionLinks(store), id = "12345678-1234-1234-1234-123456789012";
  try {
    const bad = new ClaudeNativeSessions(links, async () => Array.from({ length: 52 }, () => ({ sessionId: id, summary: "", lastModified: 0 })));
    await assert.rejects(bad.list(0), /Invalid/);
    const native = new ClaudeNativeSessions(links, async () => [{ sessionId: "bad", cwd: root, summary: "", lastModified: 0 }, { sessionId: id, summary: "", lastModified: 0 }, { sessionId: id, cwd: root, summary: "", firstPrompt: "prompt", lastModified: 0 }, { sessionId: id, cwd: root, summary: "summary", customTitle: "title", lastModified: 0 }], async () => undefined);
    const result = await native.list(0); assert.deepEqual((result.threads as any[]).map(row => row.title), ["prompt", "title"]);
    await assert.rejects(native.import("one", id, null, "ask"), /verified/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
