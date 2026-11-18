import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftNotesRegistry } from "@craft/craft-notes";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { migrateCraftNotesLocationNotes } from "../core/craft-notes-migration.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-notes-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const notes = new CraftNotesRegistry(store);
  notes.createDevice({ id: "local", note: "测试用本地设备" });
  return { root, store, notes };
}

test("device notes are required and device notes are isolated and revocable", async () => {
  const { store, root, notes } = await fixture();
  try {
    assert.throws(() => notes.createDevice({ id: "laptop" }), /note must be a non-empty string/u);
    assert.throws(() => notes.createDevice({ id: "laptop", note: "api_key=super-secret-token" }), /credential/u);
    const device = notes.createDevice({ id: "laptop", name: "Laptop", note: "主力开发机，运行本地模型" });
    assert.equal(device.status, "confirmed");
    assert.equal(notes.resolve({ device_id: "laptop" }).items[0]?.text, "主力开发机，运行本地模型");
    assert.equal(notes.resolve({ device_id: "other" }).items.length, 0);
    const revoked = notes.revoke({ id: device.id, expected_version: device.version, revoked_by: "user", reason: "device replaced" });
    assert.equal(revoked.status, "revoked");
    assert.equal(notes.resolve({ device_id: "laptop" }).items.length, 0);
    assert.throws(() => notes.revoke({ id: "missing", expected_version: 1, revoked_by: "user", reason: "test" }), /Unknown craft_note/u);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Notes registry validates versions and limits, filters lists, and keeps disabled devices out of recall", async () => {
  const { store, root, notes } = await fixture();
  try {
    const device = notes.createDevice({ id: "laptop", note: "主力开发设备" });
    assert.throws(() => notes.createDevice({ id: "Bad ID", note: "设备" }), /device_id/u);
    assert.throws(() => notes.confirm({ id: device.id }), /expected_version/u);
    assert.throws(() => notes.confirm({ id: device.id, expected_version: device.version + 1 }), /stale Note/u);
    assert.equal(notes.list({ status: "confirmed", limit: 1 }).items.length, 1);
    assert.equal(notes.list({ status: "candidate" }).items.length, 0);
    assert.equal(notes.candidateList({ device_id: "laptop", limit: 1 }).items.length, 0);
    assert.equal(notes.resolve({ device_id: "laptop", project_id: "other", path: "/work/app" }).items.some(item => item.subject_type === "directory" || item.subject_type === "file"), false);
    assert.throws(() => notes.list({ limit: 0 }), /limit/u);
    assert.throws(() => notes.resolve({ limit: 1001 }), /limit/u);
    notes.createDevice({ id: "laptop", note: "停用设备", status: "disabled" });
    assert.equal(notes.resolve({ device_id: "laptop" }).items.length, 0);
    notes.createDevice({ id: "laptop", note: "重新启用设备", status: "active" });
    assert.equal(notes.resolve({ device_id: "laptop" }).items[0]?.text, "重新启用设备");
    const pinned = notes.observeDirectory({ path: "/work/revoked", pin: true });
    const candidate = pinned.note as { id: string; version: number };
    const revoked = notes.revoke({ id: candidate.id, expected_version: candidate.version, revoked_by: "user", reason: "obsolete" });
    assert.equal((notes.observeDirectory({ id: candidate.id, path: "/work/revoked", pin: true }).note as { status: string }).status, "revoked");
    assert.equal(revoked.status, "revoked");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("directory evidence is deduplicated by task/session, threshold only creates a candidate, pin requires confirmation", async () => {
  const { store, root, notes } = await fixture();
  try {
    assert.throws(() => notes.observeDirectory({ path: "/work/app", task_id: "t1", session_id: "s1", outcome: "failed" }), /completed/u);
    assert.throws(() => notes.observeDirectory({ path: "relative", pin: true }), /absolute/u);
    let first = notes.observeDirectory({ path: "/work/app", task_id: "t1", session_id: "s1", outcome: "completed", note: "backend root" });
    assert.equal(first.eligible, false);
    notes.observeDirectory({ path: "/work/app", task_id: "t1", session_id: "s1", outcome: "completed" });
    notes.observeDirectory({ path: "/work/app", task_id: "t2", session_id: "s1", outcome: "completed" });
    first = notes.observeDirectory({ path: "/work/app", task_id: "t3", session_id: "s2", outcome: "completed" });
    assert.equal(first.eligible, true);
    assert.equal(notes.candidateList().items.length, 1);
    assert.equal(notes.resolve({ device_id: "local", path: "/work/app" }).items.some(item => item.subject_type === "directory"), false);
    const candidate = (first.note as { id: string; version: number });
    const confirmed = notes.confirm({ id: candidate.id, expected_version: candidate.version, note: "核心后端架构" });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(notes.resolve({ device_id: "local", path: "/work/app" }).items.find(item => item.subject_type === "directory")?.text, "核心后端架构");
    const pinned = notes.observeDirectory({ path: "/work/pinned", pin: true, note: "pinned directory" });
    assert.equal(pinned.eligible, true);
    assert.equal(notes.candidateList({ limit: 1 }).items.length, 1);
    assert.throws(() => notes.confirm({ id: "missing", expected_version: 1 }), /Unknown craft_note/u);
    const revoked = notes.revoke({ id: candidate.id, expected_version: confirmed.version, revoked_by: "user", reason: "obsolete" });
    assert.equal(revoked.status, "revoked");
    assert.throws(() => notes.confirm({ id: candidate.id, expected_version: revoked.version }), /revoked/u);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("file notes only accept explicit evidence and caller metadata, then require review after metadata changes", async () => {
  const { store, root, notes } = await fixture();
  try {
    assert.throws(() => notes.observeFileReference({ path: "/work/config.toml", task_id: "t1", session_id: "s1", outcome: "completed" }), /artifact/u);
    assert.throws(() => notes.observeFileReference({ path: "/work/config.toml", pin: true, metadata: { size: -1 } }), /size/u);
    assert.throws(() => notes.observeFileReference({ path: "/work/config.toml", pin: true, metadata: { modified_at: "bad" } }), /timestamp/u);
    const result = notes.observeFileReference({ path: "/work/config.toml", pin: true, note: "production config, read only", metadata: { size: 10, modified_at: "2026-11-01T00:00:00Z" } });
    const id = (result.note as { id: string }).id;
    assert.equal((result.note as { freshness: string }).freshness, "current");
    const confirmed = notes.confirm({ id, expected_version: Number(store.find("craft_note", id)?.version) });
    assert.equal(confirmed.status, "confirmed");
    const stale = notes.observeFileReference({ path: "/work/config.toml", pin: true, metadata: { size: 11, modified_at: "2026-11-02T00:00:00Z" } });
    assert.equal((stale.note as { status: string }).status, "needs_review");
    const unknownMeta = notes.observeFileReference({ path: "/remote/config.toml", pin: true });
    assert.equal((unknownMeta.note as { freshness: string }).freshness, "path_only");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy migration preserves ids and promoted recall, and is idempotent", async () => {
  const { store, root, notes } = await fixture();
  try {
    store.save("craft_notes_location", "old-promoted", { id: "old-promoted", device_id: "local", path: "/work/old", description: "old directory", status: "promoted", use_count: 4 });
    store.save("craft_notes_location", "old-observed", { id: "old-observed", device_id: "local", path: "/work/new", description: "new directory", status: "observed", use_count: 1 });
    store.save("craft_notes_location", "old-revoked", { id: "old-revoked", device_id: "local", path: "/work/secret", description: "revoked directory", status: "revoked", use_count: 1 });
    assert.deepEqual(migrateCraftNotesLocationNotes(store), { scanned: 3, migrated: 3, skipped: 0 });
    assert.deepEqual(migrateCraftNotesLocationNotes(store), { scanned: 3, migrated: 0, skipped: 3 });
    assert.equal(notes.resolve({ device_id: "local", path: "/work/old" }).items[0]?.status, "legacy_unreviewed");
    assert.equal(notes.resolve({ device_id: "local", path: "/work/new" }).items.some(item => item.subject_type === "directory"), false);
    assert.equal(notes.resolve({ device_id: "local", path: "/work/secret" }).items.some(item => item.subject_type === "directory"), false);
    assert.equal(notes.candidateList().items.some(item => item.id === "old-promoted"), true);
    assert.equal(notes.confirm({ id: "old-promoted", expected_version: 1 }).status, "confirmed");
    store.save("craft_notes_location", "bad", { id: "bad", device_id: "local", path: "", status: "promoted" });
    assert.deepEqual(migrateCraftNotesLocationNotes(store), { scanned: 4, migrated: 0, skipped: 4 });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("only attested successful task completion contributes deduplicated usage to a review candidate", async () => {
  const { store, root } = await fixture();
  try {
    const repo = join(root, "repo"); mkdirSync(repo); execFileSync("git", ["-C", repo, "init", "-q"]);
    const service = new CraftService(store);
    const completed = async (taskId: string, sessionId: string, turnId: string, outcome: "passed" | "failed", verified: boolean) => {
      const context = await service.contextOpen({ project_root: repo, query: "record a project directory note", task_id: taskId,
        session_id: sessionId, turn_id: turnId, include_codebase: false }) as Record<string, unknown>;
      const receipt = context.receipt as { id: string };
      service.learningCycleFinalize({ host: "codex", task_id: taskId, session_id: sessionId, turn_id: turnId,
        context_receipt_id: receipt.id, verification_outcome: outcome, verification_ref: `test:${turnId}`, verified,
        observed_paths: [repo] });
    };
    await completed("task-fail", "session-1", "turn-fail", "failed", true);
    await completed("task-not-verified", "session-1", "turn-unverified", "passed", false);
    assert.equal(store.list("craft_note_usage", 20).length, 0);
    await completed("task-1", "session-1", "turn-1", "passed", true);
    await completed("task-1", "session-1", "turn-1-replay", "passed", true);
    await completed("task-2", "session-1", "turn-2", "passed", true);
    assert.equal(store.list("craft_note_usage", 20).length, 2);
    await completed("task-3", "session-2", "turn-3", "passed", true);
    assert.equal(store.list("craft_note_usage", 20).length, 3);
    const candidate = service.craftNotesCandidateList({}).items[0]!;
    assert.equal(candidate.subject_key, `local:${repo}`);
    service.craftNotesConfirm({ id: candidate.id, expected_version: candidate.version, note: "核心项目目录" });
    assert.equal(service.craftNotesResolve({ device_id: "local", project_id: candidate.project_id, path: repo }).items.length, 2);
    const injected = await service.contextOpen({ project_root: repo, query: "项目目录用途", include_codebase: false,
      task_id: "task-context", session_id: "session-3", turn_id: "turn-context" }) as Record<string, unknown>;
    const injectedScope = (injected.pack_receipt as { scope: { id: string } }).scope.id;
    assert.equal(service.craftNotesResolve({ device_id: "local", project_id: injectedScope, path: repo }).items.length, 2,
      JSON.stringify({ injectedScope, candidateProject: candidate.project_id, candidatePath: candidate.subject_key }));
    assert.equal((injected.craft_notes as Array<{ subject_type: string; text: string }>).find(item => item.subject_type === "directory")?.text, "核心项目目录");
    const otherRepo = join(root, "other"); mkdirSync(otherRepo); execFileSync("git", ["-C", otherRepo, "init", "-q"]);
    const unrelated = await service.contextOpen({ project_root: otherRepo, query: "项目目录用途", include_codebase: false,
      task_id: "task-other", session_id: "session-3", turn_id: "turn-other" }) as Record<string, unknown>;
    assert.equal((unrelated.craft_notes as Array<{ subject_type: string }>).length, 1);
    assert.equal((unrelated.craft_notes as Array<{ subject_type: string }>).every(item => item.subject_type === "device"), true);
    const filePath = join(repo, "prod.yaml");
    const fileCandidate = service.craftNotesObserveFile({ path: filePath, device_id: "local", project_id: injectedScope,
      pin: true, note: "生产只读配置" }).note as { id: string; version: number };
    service.craftNotesConfirm({ id: fileCandidate.id, expected_version: Number(store.find("craft_note", fileCandidate.id)?.version) });
    const defaultNotes = await service.contextOpen({ project_root: repo, query: "读取配置说明", include_codebase: false,
      task_id: "task-file-default", session_id: "session-3", turn_id: "turn-file-default" }) as Record<string, unknown>;
    assert.equal((defaultNotes.craft_notes as Array<{ subject_type: string }>).some(item => item.subject_type === "file"), false);
    const requestedFileNotes = await service.contextOpen({ project_root: repo, query: "读取配置说明", include_codebase: false,
      note_paths: [filePath], task_id: "task-file-requested", session_id: "session-3", turn_id: "turn-file-requested" }) as Record<string, unknown>;
    assert.equal((requestedFileNotes.craft_notes as Array<{ subject_type: string }>).some(item => item.subject_type === "file"), true);
    const originalResolve = service.contextWorkingSets.resolve.bind(service.contextWorkingSets);
    service.contextWorkingSets.resolve = async args => {
      const result = await originalResolve(args);
      const current = service.craftNotesResolve({ device_id: "local", project_id: injectedScope, path: repo }).items.find(item => item.id === candidate.id)!;
      service.craftNotesRevoke({ id: candidate.id, expected_version: current.version, revoked_by: "race-test", reason: "revoked during context read" });
      return result;
    };
    await assert.rejects(() => service.contextOpen({ project_root: repo, query: "项目目录用途", include_codebase: false,
      task_id: "task-race", session_id: "session-3", turn_id: "turn-race" }), /Craft Notes changed during Context resolution/u);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("public MCP exposes Craft Notes operations and preserves confirmed retrieval", async () => {
  const { store, root } = await fixture();
  try {
    const server = new McpServer(new CraftService(store));
    const listed = await server.handle({ jsonrpc: "2.0", id: "tools", method: "tools/list" }) as { result: { tools: Array<{ name: string }> } };
    for (const name of ["craft_notes_create_device", "craft_notes_observe_directory", "craft_notes_observe_file", "craft_notes_confirm", "craft_notes_resolve"]) {
      assert.ok(listed.result.tools.some(tool => tool.name === name), `${name} is public`);
    }
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await server.handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
      assert.notEqual(response.result.isError, true, JSON.stringify(response));
      return response.result.structuredContent!;
    };
    await call("craft_notes_create_device", { id: "mcp-laptop", note: "本地模型开发设备" });
    const address = ["test", "example.com"].join("@");
    const unsafe = await server.handle({ jsonrpc: "2.0", id: "unsafe", method: "tools/call", params: {
      name: "craft_notes_create_device", arguments: { id: "mcp-unsafe", note: `联系 ${address}` },
    } }) as { result: { isError?: boolean } };
    assert.equal(unsafe.result.isError, true);
    const result = await call("craft_notes_resolve", { device_id: "mcp-laptop" });
    assert.equal(((result.items as Array<{ text: string }>)[0] ?? {}).text, "本地模型开发设备");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
