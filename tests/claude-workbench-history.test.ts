import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { WorkbenchAgentSessionLinks } from "../core/application/use-cases/workbench-agent-session-links.ts";
import { ClaudeWorkbenchHistory } from "../core/interfaces/claude-workbench-history.ts";

test("Claude history checks session ownership and returns bounded native messages without saving them", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-history-"))); const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "one", {}); store.create("task", "other", {});
  const links = new WorkbenchAgentSessionLinks(store), id = "12345678-1234-1234-1234-123456789012";
  const link = links.bind({ task_id: "one", provider: "claude", native_session_id: id, workspace: root, permission: "ask" }).link as Record<string, unknown>;
  let info: SDKSessionInfo | undefined = { sessionId: id, cwd: root, summary: "private summary", lastModified: 1 };
  let messages: SessionMessage[] = [{ type: "assistant", uuid: "u", session_id: id, message: { content: "private-answer-marker" }, parent_tool_use_id: null, parent_agent_id: null }];
  let reads = 0;
  const history = new ClaudeWorkbenchHistory(links, async (_id, opts) => { assert.equal(opts?.dir, root); return info; }, async (_id, opts) => { reads++; assert.equal(opts?.limit, 101); return messages.slice(opts?.offset ?? 0, (opts?.offset ?? 0) + 101); });
  try {
    const result = await history.read("one", String(link.id)); assert.equal(result.messages.length, 1); assert.equal(result.truncated, false);
    assert.equal(store.list("task_message", 100).length, 0); assert.equal(JSON.stringify(links.list("one")).includes("private-answer-marker"), false);
    await assert.rejects(history.read("other", String(link.id)), /does not belong/);
    const codex = links.bind({ task_id: "one", provider: "codex", native_session_id: "codex-id", workspace: root, permission: "ask" }).link as Record<string, unknown>;
    await assert.rejects(history.read("one", String(codex.id)), /not Claude/);
    info = undefined; await assert.rejects(history.read("one", String(link.id)), /could not be verified/); assert.equal(reads, 1);
    info = { sessionId: id, cwd: root, summary: "", lastModified: 1, fileSize: 2 * 1024 * 1024 + 1 };
    assert.equal((await history.read("one", String(link.id))).messages.length, 1);
    await assert.rejects(history.read("one", String(link.id), -1), /offset is invalid/);
    info.fileSize = 0; messages = [{ ...messages[0], session_id: "other" }]; await assert.rejects(history.read("one", String(link.id)), /different session/);
    messages = [{ ...messages[0], session_id: id, message: "x".repeat(2 * 1024 * 1024) }];
    await assert.rejects(history.read("one", String(link.id)), /exceeds display limit/);
    messages = Array.from({ length: 101 }, () => ({ type: "user", uuid: "u", session_id: id, message: "hello", parent_tool_use_id: null, parent_agent_id: null }));
    const truncated = await history.read("one", String(link.id)); assert.equal(truncated.truncated, true); assert.equal(truncated.messages.length, 100); assert.equal(truncated.next_offset, 100);
    const last = await history.read("one", String(link.id), truncated.next_offset!); assert.equal(last.messages.length, 1); assert.equal(last.next_offset, null);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
