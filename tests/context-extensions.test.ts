import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextExtensionsKernel, computeCommand, computeEnv } from "../core/context-extensions.ts";
import { MemoryFileStore } from "../capability/craft-memory/memory-files.ts";
import { contextStoragePreflight, ContextStoragePreflightReader } from "../core/context-storage-preflight.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { sessionStorageScopeId } from "../common/craft-common-store-local/src/paths.ts";
import { CraftService } from "../core/service.ts";
import { TOOLS } from "../core/mcp/tool-catalog.ts";
import { CONTEXT_ROUTED_TOOL_NAMES } from "../core/mcp/context-tools.ts";

async function openStore(): Promise<{ store: CraftStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "craft-context-ext-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, root };
}

test("routing render names the compute/capture/search tools", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const byDefault = kernel.renderRouting({});
    assert.equal(byDefault.client, "codex");
    assert.match(String(byDefault.content), /craft_context_compute/u);
    assert.match(String(byDefault.content), /not a security sandbox/u);
    const explicit = kernel.renderRouting({ client: "claude" });
    assert.equal(explicit.client, "claude");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("computeCommand selects a runner for every language/platform pair", () => {
  assert.equal(computeCommand("javascript", "linux", "/w", "/node").command, "/node");
  assert.equal(computeCommand("python", "win32", "/w", "/node").command, "python");
  assert.equal(computeCommand("python", "linux", "/w", "/node").command, "python3");
  assert.equal(computeCommand("shell", "win32", "/w", "/node").command, "powershell");
  assert.equal(computeCommand("shell", "linux", "/w", "/node").command, "/bin/sh");
  assert.equal(computeCommand("javascript", "linux", "/w", "/node").file, join("/w", "main.mjs"));
});

test("computeEnv keeps only the allowlisted environment keys", () => {
  const bare = computeEnv("/tmp/work", {});
  assert.equal(bare.PATH, undefined);
  assert.equal(bare.SystemRoot, undefined);
  const full = computeEnv("/tmp/work", { PATH: "p", SystemRoot: "s", PATHEXT: "e" });
  assert.equal(full.PATH, "p");
  assert.equal(full.SystemRoot, "s");
  assert.equal(full.PATHEXT, "e");
  assert.equal(full.HOME, "/tmp/work");
});

test("ephemeral index records, deduplicates, updates and bounds input", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const first = kernel.recordEphemeral({ session_host: "codex", session_id: "s1", source: "logs",
      items: [{ id: "a", text: "alpha beta", title: "A" }, { id: "a", text: "alpha beta updated" }] });
    assert.equal(first.item_count, 1);
    const second = kernel.recordEphemeral({ session_host: "codex", session_id: "s1", source: "logs", items: [{ id: "b", text: "gamma" }] });
    assert.equal(second.item_count, 1);
    const contentOnly = kernel.recordEphemeral({ session_host: "codex", session_id: "s1", source: "logs", items: [{ content: "delta", source: "inline" }] });
    assert.equal(contentOnly.item_count, 1);
    assert.throws(() => kernel.recordEphemeral({ session_host: "codex", session_id: "s1", items: [] }), /non-empty array/u);
    assert.throws(() => kernel.recordEphemeral({ session_host: "codex", session_id: "s1", items: Array.from({ length: 501 }, (_, index) => ({ id: String(index), text: "x" })) }), /item limit/u);
    assert.throws(() => kernel.recordEphemeral({ session_host: "codex", session_id: "s1", items: [1] }), /object/u);
    assert.throws(() => kernel.recordEphemeral({ session_host: "codex", session_id: "s1", items: [{ id: "a", text: " " }] }), /items\.text/u);
    assert.throws(() => kernel.recordEphemeral({ session_host: "codex", session_id: "s1", items: [{ id: "a", text: "x".repeat(400_001) }] }), /character limit/u);
    assert.throws(() => kernel.recordEphemeral({ session_host: "codex", session_id: "s1", items: [{ id: "a", text: "x" }], ttl_seconds: 0 }), /ttl_seconds/u);
    assert.throws(() => kernel.recordEphemeral({ session_host: "codex", session_id: "s1", items: [{ id: "a", text: "x" }], now: "nope" }), /ISO timestamp/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("ephemeral search reports missing, expired, matched and unmatched indexes", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    assert.equal(kernel.searchEphemeral({ session_host: "codex", session_id: "none", query: "alpha" }).reason, "index_missing");
    kernel.recordEphemeral({ session_host: "codex", session_id: "s2", source: "docs", ttl_seconds: 1, now: "2020-01-01T00:00:00.000Z",
      items: [{ id: "a", text: "alpha beta" }] });
    assert.equal(kernel.searchEphemeral({ session_host: "codex", session_id: "s2", source: "docs", query: "alpha", now: "2020-01-02T00:00:00.000Z" }).reason, "index_expired");
    kernel.recordEphemeral({ session_host: "codex", session_id: "s3", source: "docs", items: [{ id: "a", text: "alpha beta" }, { id: "b", text: "gamma" }] });
    const matched = kernel.searchEphemeral({ session_host: "codex", session_id: "s3", source: "docs", query: "alpha" });
    assert.equal(matched.reason, "matched");
    assert.equal((matched.hits as unknown[]).length, 1);
    assert.equal(kernel.searchEphemeral({ session_host: "codex", session_id: "s3", source: "docs", query: "zzz" }).reason, "no_match");
    assert.equal(kernel.searchEphemeral({ session_host: "codex", session_id: "s4", query: "alpha" }).reason, "index_missing");
    assert.throws(() => kernel.searchEphemeral({ session_host: "codex", session_id: "s3", query: "alpha", limit: 0 }), /limit/u);
    assert.throws(() => kernel.searchEphemeral({ session_host: "codex", session_id: "s3", query: "" }), /query/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("ephemeral search requires expansion rather than cutting an oversized constraint", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const sentence = `不要执行危险操作${"并检查条件".repeat(100)}除非获得明确授权。`;
    kernel.recordEphemeral({ session_host: "codex", session_id: "s", source: "docs", items: [{ id: "rule", text: sentence }] });
    const search = kernel.searchEphemeral({ session_host: "codex", session_id: "s", source: "docs", query: "危险操作" });
    const hit = (search.hits as Array<Record<string, unknown>>)[0]!;
    assert.equal(hit.preview, "");
    assert.equal(hit.excerpt_reason, "requires_expansion");
    assert.equal(hit.source_start, 0);
    assert.equal(hit.source_end, sentence.length);
    const read = { session_host: "codex", session_id: "s", source: "docs", query: "危险操作", read_item_id: "rule", read_start: hit.source_start, read_end: hit.source_end, identity_digest: search.identity_digest };
    assert.equal(kernel.searchEphemeral(read).content, sentence);
    assert.equal(kernel.searchEphemeral({ ...read, max_chars: 8_000 }).content, sentence);
    assert.throws(() => kernel.searchEphemeral({ ...read, max_chars: 100 }), /exceeds max_chars/u);
    assert.throws(() => kernel.searchEphemeral({ ...read, read_start: 1 }), /must match/u);
    assert.throws(() => kernel.searchEphemeral({ ...read, read_item_id: "missing" }), /not found/u);
    assert.throws(() => kernel.searchEphemeral({ ...read, identity_digest: "old" }), /changed/u);
    assert.throws(() => kernel.searchEphemeral({ ...read, identity_digest: undefined }), /identity_digest/u);
    assert.throws(() => kernel.searchEphemeral({ ...read, session_id: "other", index_id: search.index_id }), /scope mismatch/u);
    assert.throws(() => kernel.searchEphemeral({ ...read, read_end: sentence.length + 1 }), /read_end/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("ephemeral purge removes one source or a whole session", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    kernel.recordEphemeral({ session_host: "codex", session_id: "s", source: "one", items: [{ id: "a", text: "alpha" }] });
    kernel.recordEphemeral({ session_host: "codex", session_id: "s", source: "two", items: [{ id: "b", text: "beta" }] });
    assert.equal(kernel.purgeEphemeral({ session_host: "codex", session_id: "s", source: "one" }).removed, 1);
    assert.equal(kernel.purgeEphemeral({ session_host: "codex", session_id: "s" }).removed, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("explicit ephemeral index IDs cannot cross session or source boundaries", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    kernel.recordEphemeral({ session_host: "codex", session_id: "owner", source: "docs", index_id: "shared-id", items: [{ text: "private evidence" }] });
    for (const scope of [{ session_id: "other", source: "docs" }, { session_id: "owner", source: "other" }]) {
      assert.throws(() => kernel.searchEphemeral({ session_host: "codex", ...scope, index_id: "shared-id", query: "private" }), /scope mismatch/u);
      assert.throws(() => kernel.recordEphemeral({ session_host: "codex", ...scope, index_id: "shared-id", items: [{ text: "replacement" }] }), /scope mismatch/u);
      assert.throws(() => kernel.purgeEphemeral({ session_host: "codex", ...scope, index_id: "shared-id" }), /scope mismatch/u);
    }
    assert.equal(kernel.searchEphemeral({ session_host: "codex", session_id: "owner", source: "docs", index_id: "shared-id", query: "private" }).reason, "matched");
    assert.equal(kernel.purgeEphemeral({ session_host: "codex", session_id: "owner", source: "docs", index_id: "shared-id" }).removed, 1);
    assert.equal(kernel.purgeEphemeral({ session_host: "codex", session_id: "owner", source: "docs", index_id: "shared-id" }).removed, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("ephemeral indexes isolate equal session IDs across Hosts", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const first = kernel.recordEphemeral({ session_id: "same", session_host: "codex", source: "docs", items: [{ text: "alpha codex" }] });
    const second = kernel.recordEphemeral({ session_id: "same", session_host: "claude", source: "docs", items: [{ text: "alpha claude" }] });
    assert.notEqual(first.index_id, second.index_id);
    assert.throws(() => kernel.searchEphemeral({ session_id: "same", session_host: "claude", source: "docs", index_id: first.index_id, query: "alpha" }), /scope mismatch/u);
    assert.throws(() => kernel.recordEphemeral({ session_id: "same", session_host: "claude", source: "docs", index_id: first.index_id, items: [{ text: "overwrite" }] }), /scope mismatch/u);
    assert.throws(() => kernel.purgeEphemeral({ session_id: "same", session_host: "claude", source: "docs", index_id: first.index_id }), /scope mismatch/u);
    assert.equal(kernel.purgeEphemeral({ session_id: "same", session_host: "codex" }).removed, 1);
    assert.equal(kernel.searchEphemeral({ session_id: "same", session_host: "claude", source: "docs", query: "alpha" }).reason, "matched");
    assert.throws(() => kernel.recordEphemeral({ session_id: "same", items: [{ text: "missing host" }] }), /session_host/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("new Context session bodies are partitioned under their Host session directory", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const session = { session_id: "partitioned", session_host: "codex" };
    const index = kernel.recordEphemeral({ ...session, source: "docs", items: [{ text: "private context body" }] });
    const snapshot = kernel.checkpointResume({ ...session, tasks: ["private resume body"] });
    const path = join(root, "sessions", sessionStorageScopeId("codex", "partitioned"), "context", "context.db");
    assert.equal(existsSync(path), true);
    const central = store.database.prepare("SELECT payload_json FROM records WHERE id IN (?,?)").all(String(index.index_id), String(snapshot.resume_id));
    assert.equal(central.length, 2);
    assert.doesNotMatch(JSON.stringify(central), /private (?:context|resume) body/u);
    const partition = new DatabaseSync(path, { readOnly: true });
    try { assert.match(JSON.stringify(partition.prepare("SELECT payload_json FROM records").all()), /private context body/u); }
    finally { partition.close(); }
    assert.equal(new MemoryFileStore(store).archiveSession("partitioned", "codex").status, "archived");
    assert.equal(existsSync(path), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context reads reject partition content changed after publication", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "digest-check");
    const kernel = new ContextExtensionsKernel(store);
    const record = kernel.recordEphemeral({ session_id: "digest-check", session_host: "codex", source: "docs", items: [{ text: "original" }] });
    const file = join(root, "sessions", scope, "context", "context.db");
    const partition = new DatabaseSync(file);
    try {
      const row = partition.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=1").get("context_ephemeral_index", String(record.index_id)) as { payload_json: string };
      partition.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=1").run(row.payload_json.replace("original", "tampered"), "context_ephemeral_index", String(record.index_id));
    } finally { partition.close(); }
    assert.throws(() => kernel.searchEphemeral({ session_id: "digest-check", session_host: "codex", source: "docs", query: "tampered" }), /digest mismatch/u);
    assert.throws(() => store.list("context_ephemeral_index", 100, undefined, false), /digest mismatch/u);
    assert.equal(contextStoragePreflight(craftPaths(root)).records[0]?.status, "partition_digest_mismatch");
    const files = new MemoryFileStore(store);
    const queued = files.queueSessionArchive("digest-check", "codex");
    let outcome: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i++) {
      outcome = (files.runQueuedArchiveSteps().outcomes as Array<Record<string, unknown>>)[0];
      if (outcome?.status === "failed") break;
    }
    assert.equal(outcome?.needs_reconciliation, true);
    assert.equal(store.find("memory_session_archive", String(queued.id))?.retry_state, "requires_reconciliation");
    assert.equal(store.find("memory_session_archive", String(queued.id))?.last_error_code, "context_digest_mismatch");
    assert.equal(files.runQueuedArchiveSteps().attempted, 0);
    assert.equal(existsSync(file), true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("session archive stops for reconciliation when a Context partition record is missing", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "missing-context");
    const record = new ContextExtensionsKernel(store).checkpointResume({ session_id: "missing-context", session_host: "codex", tasks: ["task"] });
    const file = join(root, "sessions", scope, "context", "context.db");
    const partition = new DatabaseSync(file);
    try { partition.prepare("DELETE FROM records WHERE kind=? AND id=? AND version=1").run("context_resume_snapshot", String(record.resume_id)); }
    finally { partition.close(); }
    const files = new MemoryFileStore(store), queued = files.queueSessionArchive("missing-context", "codex");
    let outcome: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i++) {
      outcome = (files.runQueuedArchiveSteps().outcomes as Array<Record<string, unknown>>)[0];
      if (outcome?.status === "failed") break;
    }
    assert.equal(outcome?.needs_reconciliation, true);
    assert.equal(store.find("memory_session_archive", String(queued.id))?.retry_state, "requires_reconciliation");
    assert.equal(store.find("memory_session_archive", String(queued.id))?.last_error_code, "context_record_missing");
    assert.equal(files.runQueuedArchiveSteps().attempted, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("session archive reports a missing Context database without retrying", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "missing-db");
    new ContextExtensionsKernel(store).checkpointResume({ session_id: "missing-db", session_host: "codex", tasks: ["task"] });
    store.closeContextScope({ kind: "session", id: scope });
    await rm(join(root, "sessions", scope, "context", "context.db"));
    const files = new MemoryFileStore(store), queued = files.queueSessionArchive("missing-db", "codex");
    let outcome: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i++) {
      outcome = (files.runQueuedArchiveSteps().outcomes as Array<Record<string, unknown>>)[0];
      if (outcome?.status === "failed") break;
    }
    assert.equal(outcome?.needs_reconciliation, true);
    const state = store.find("memory_session_archive", String(queued.id));
    assert.equal(state?.retry_state, "requires_reconciliation");
    assert.equal(state?.last_error_code, "context_database_missing");
    assert.equal(files.runQueuedArchiveSteps().attempted, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context storage preflight pages exact versions and classifies without exposing bodies", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "inventory");
    const insert = store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)");
    const put = (id: string, payload: unknown) => insert.run("context_ephemeral_index", id, 1, JSON.stringify(payload), "2020-01-01", "2020-01-01");
    put("a", { session_id: "inventory", session_host: "codex", session_scope_id: scope, text: "private body" });
    put("b", { session_id: "inventory", text: "private body" });
    put("c", { session_id: "inventory", session_host: "codex", session_scope_id: "wrong" });
    put("d", { session_id: "inventory", session_host: "codex", session_scope_id: scope, _context_partition: { file: "/outside", scope: { kind: "session", id: scope } } });
    put("e", { session_id: "inventory", session_host: "codex", session_scope_id: scope, _context_partition: { file: join(root, "sessions", scope, "context", "context.db"), scope: { kind: "session", id: "wrong" } } });
    put("f", { session_id: "inventory", session_host: "BAD HOST", session_scope_id: scope });
    put("g", { session_id: "inventory", session_host: "codex", session_scope_id: scope, _context_partition: { file: join(root, "sessions", scope, "context", "context.db"), scope: { kind: "session", id: scope } } });
    const missingScope = sessionStorageScopeId("codex", "missing");
    put("h", { session_id: "missing", session_host: "codex", session_scope_id: missingScope, _context_partition: { file: join(root, "sessions", missingScope, "context", "context.db"), scope: { kind: "session", id: missingScope } } });
    const saved = new ContextExtensionsKernel(store).checkpointResume({ session_id: "inventory", session_host: "codex", tasks: ["private resume"] });
    const pages = []; let cursor: [string, string, number] | null = ["", "", 0];
    while (cursor) { const page = contextStoragePreflight(craftPaths(root), cursor, 2); pages.push(...page.records); cursor = page.next_cursor; }
    assert.deepEqual(pages.map(item => item.status), ["central_ready", "unbound", "identity_mismatch", "pointer_mismatch", "pointer_mismatch", "invalid", "partition_row_missing", "partition_missing", "partition_digest_verified"]);
    assert.equal(pages.at(-1)?.id, saved.resume_id);
    assert.doesNotMatch(JSON.stringify(pages), /private/u);
    const raw = store.database.prepare("SELECT payload_json FROM records WHERE kind='context_resume_snapshot' AND id=?").get(String(saved.resume_id)) as { payload_json: string };
    const header = JSON.parse(raw.payload_json) as Record<string, unknown>;
    const update = store.database.prepare("UPDATE records SET payload_json=? WHERE kind='context_resume_snapshot' AND id=?");
    update.run(JSON.stringify({ ...header, context_payload_digest: "sha256:wrong" }), String(saved.resume_id));
    assert.equal(contextStoragePreflight(craftPaths(root), ["context_resume_snapshot", "", 0]).records[0]?.status, "partition_digest_mismatch");
    delete header.context_payload_digest;
    update.run(JSON.stringify(header), String(saved.resume_id));
    assert.equal(contextStoragePreflight(craftPaths(root), ["context_resume_snapshot", "", 0]).records[0]?.status, "partition_digest_missing");
    update.run(raw.payload_json, String(saved.resume_id));
    assert.throws(() => contextStoragePreflight(craftPaths(root), ["", "", -1]), /cursor/u);
    assert.throws(() => contextStoragePreflight(craftPaths(root), ["", "", 0], 501), /limit/u);
    const reader = new ContextStoragePreflightReader(craftPaths(root));
    assert.equal(reader.readPage(["", "", 0], 2).records.length, 2);
    put("z", { session_id: "inventory" });
    assert.throws(() => reader.readPage(), /database changed/u);
    reader.close();
    assert.throws(() => reader.readPage(), /reader is closed/u);
    const during = new ContextStoragePreflightReader(craftPaths(root));
    const injected = during as unknown as { currentDataVersion: () => number };
    const version = injected.currentDataVersion.bind(during); let calls = 0;
    injected.currentDataVersion = () => { if (++calls === 2) put("zz-during-page", { session_id: "inventory" }); return version(); };
    try { assert.throws(() => during.readPage(), /database changed/u); } finally { during.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context storage preflight fails closed on changed partition identity and unsafe files", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "audit-partition");
    const record = new ContextExtensionsKernel(store).checkpointResume({ session_id: "audit-partition", session_host: "codex", tasks: ["test"] });
    const file = join(root, "sessions", scope, "context", "context.db");
    const partition = new DatabaseSync(file);
    try {
      const query = partition.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?");
      const update = partition.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?");
      const current = query.get("context_resume_snapshot", String(record.resume_id), 1) as { payload_json: string };
      update.run(JSON.stringify({ ...JSON.parse(current.payload_json), session_host: "claude" }), "context_resume_snapshot", String(record.resume_id), 1);
      assert.equal(contextStoragePreflight(craftPaths(root)).records[0]?.status, "partition_identity_mismatch");
      update.run(Buffer.from("not-text"), "context_resume_snapshot", String(record.resume_id), 1);
      assert.equal(contextStoragePreflight(craftPaths(root)).records[0]?.status, "partition_row_missing");
      update.run("{", "context_resume_snapshot", String(record.resume_id), 1);
      assert.equal(contextStoragePreflight(craftPaths(root)).records[0]?.status, "partition_unreadable");
    } finally { partition.close(); }
    store.closeContextScope({ kind: "session", id: scope });
    await rm(file);
    await symlink(join(root, "db", "craft.db"), file);
    assert.equal(contextStoragePreflight(craftPaths(root)).records[0]?.status, "partition_unsafe");
    await rm(join(root, "sessions", scope, "context"), { recursive: true });
    await symlink(root, join(root, "sessions", scope, "context"));
    assert.equal(contextStoragePreflight(craftPaths(root)).records[0]?.status, "partition_unsafe");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context migration backs up and moves verified versions idempotently", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "migration");
    const payload = { session_id: "migration", session_host: "codex", session_scope_id: scope, source: "docs", items: [{ id: "a", text: "old body" }] };
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("context_ephemeral_index", "legacy", 1, JSON.stringify(payload), "2020-01-01", "2020-01-01");
    const entry = { kind: "context_ephemeral_index", id: "legacy", version: 1 };
    assert.throws(() => store.migrateLegacyContextVersions([{ ...entry, source_digest: "sha256:stale" }]), /preflight source changed/u);
    assert.deepEqual(store.migrateLegacyContextVersions([entry]), { migrated: 1, already_current: 0 });
    assert.equal(contextStoragePreflight(craftPaths(root)).records[0]?.status, "partition_digest_verified");
    assert.equal((store.find(entry.kind, entry.id, 1, false)?.items as Array<Record<string, unknown>>)[0]?.text, "old body");
    assert.deepEqual(store.migrateLegacyContextVersions([entry]), { migrated: 0, already_current: 1 });
    const backupDir = join(root, "backups", "context-migration", "backups");
    const backup = (await readdir(backupDir)).find(name => name.endsWith(".json"))!;
    assert.match(await readFile(join(backupDir, backup), "utf8"), /old body/u);
    assert.throws(() => store.migrateLegacyContextVersions([entry, entry]), /repeats/u);
    assert.throws(() => store.migrateLegacyContextVersions([{ ...entry, id: "missing" }]), /source is missing/u);
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(entry.kind, "unbound", 1, JSON.stringify({ session_id: "migration" }), "2020-01-01", "2020-01-01");
    assert.throws(() => store.migrateLegacyContextVersions([{ ...entry, id: "unbound" }]), /identity is unavailable/u);
    assert.equal((store.find(entry.kind, "unbound", 1, false) as Record<string, unknown>).session_id, "migration");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context migration command preflights, applies, and reports unbound rows", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "command");
    const insert = store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)");
    insert.run("context_ephemeral_index", "ready", 1, JSON.stringify({ session_id: "command", session_host: "codex", session_scope_id: scope, source: "docs", items: [{ text: "body" }] }), "2020-01-01", "2020-01-01");
    insert.run("context_ephemeral_index", "unbound", 1, JSON.stringify({ session_id: "command" }), "2020-01-01", "2020-01-01");
    const script = join(process.cwd(), "scripts/context-storage-migration.ts");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", script, `--data-root=${root}`, ...args], { encoding: "utf8" });
    assert.notEqual(run("--bad").status, 0);
    assert.notEqual(run("--apply", "--apply").status, 0);
    assert.notEqual(run("--cursor=!").status, 0);
    assert.notEqual(run("--cursor=bnVsbA").status, 0);
    assert.notEqual(run("--cursor=eA").status, 0);
    assert.notEqual(run("--limit=0").status, 0);
    assert.notEqual(spawnSync(process.execPath, ["--experimental-strip-types", script, "--data-root= "], { encoding: "utf8" }).status, 0);
    const dry = run(); assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(JSON.parse(dry.stdout).status_counts, { central_ready: 1, unbound: 1 });
    assert.equal(JSON.parse(dry.stdout).migrated, 0);
    const applied = run("--apply"); assert.equal(applied.status, 2, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).migrated, 1);
    assert.equal(JSON.parse(applied.stdout).verified, 1);
    assert.equal(JSON.parse(applied.stdout).blocked, 1);
    const after = run(); assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(JSON.parse(after.stdout).status_counts, { partition_digest_verified: 1, unbound: 1 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context migration final rescan detects records inserted before its cursor", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "cursor");
    const insert = store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)");
    const put = (id: string) => insert.run("context_ephemeral_index", id, 1, JSON.stringify({ session_id: "cursor", session_host: "codex", session_scope_id: scope, source: id, items: [{ text: id }] }), "2020-01-01", "2020-01-01");
    put("a"); put("z");
    const script = join(process.cwd(), "scripts/context-storage-migration.ts");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", script, `--data-root=${root}`, "--limit=1", "--apply", ...args], { encoding: "utf8" });
    const first = run(); assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).completion_verified, false);
    const cursor = JSON.parse(first.stdout).next_cursor as string;
    put("0-before-cursor");
    const last = run(`--cursor=${cursor}`); assert.equal(last.status, 2, last.stderr);
    assert.equal(JSON.parse(last.stdout).completion_verified, false);
    assert.equal(JSON.parse(last.stdout).remaining_status_counts.central_ready, 1);
    const retry = run(); assert.equal(retry.status, 0, retry.stderr);
    assert.equal(JSON.parse(retry.stdout).migrated, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context migration command fails when its readback changes after publication", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "readback-fault");
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("context_ephemeral_index", "fault", 1, JSON.stringify({ session_id: "readback-fault", session_host: "codex", session_scope_id: scope, source: "docs", items: [{ text: "test" }] }), "2020-01-01", "2020-01-01");
    const preload = join(root, "migration-fault.mjs");
    const storeUrl = pathToFileURL(join(process.cwd(), "common/craft-common-store-local/src/store.ts")).href;
    await writeFile(preload, `import { CraftStore } from ${JSON.stringify(storeUrl)};
      const original = CraftStore.prototype.migrateLegacyContextVersions;
      CraftStore.prototype.migrateLegacyContextVersions = function(entries) { const result = original.call(this, entries); this.database.prepare('DELETE FROM records WHERE kind=? AND id=? AND version=?').run('context_ephemeral_index', 'fault', 1); return result; };`);
    const script = join(process.cwd(), "scripts/context-storage-migration.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", preload, script, `--data-root=${root}`, "--apply"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /readback incomplete/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context migration preserves central data when a staged version conflicts", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "conflict");
    new ContextExtensionsKernel(store).checkpointResume({ session_id: "conflict", session_host: "codex" });
    const body = { session_id: "conflict", session_host: "codex", session_scope_id: scope, source: "docs", items: [{ text: "original" }] };
    const entry = { kind: "context_ephemeral_index", id: "staged", version: 1 };
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(entry.kind, entry.id, entry.version, JSON.stringify(body), "2020-01-01", "2020-01-01");
    const path = join(root, "sessions", scope, "context", "context.db");
    const staged = new DatabaseSync(path);
    try { staged.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(entry.kind, entry.id, entry.version, JSON.stringify({ ...body, source: "different" }), "2020-01-01", "2020-01-01"); }
    finally { staged.close(); }
    assert.throws(() => store.migrateLegacyContextVersions([entry]), /target conflicts/u);
    assert.equal((store.find(entry.kind, entry.id, 1, false)?.items as Array<Record<string, unknown>>)[0]?.text, "original");
    const cleanup = new DatabaseSync(path);
    try { cleanup.prepare("DELETE FROM records WHERE kind=? AND id=? AND version=?").run(entry.kind, entry.id, entry.version); }
    finally { cleanup.close(); }
    assert.equal(store.migrateLegacyContextVersions([entry]).migrated, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context migration backup restores missing versions without overwriting changed data", async () => {
  const { store, root } = await openStore();
  try {
    const scope = sessionStorageScopeId("codex", "restore");
    const body = { session_id: "restore", session_host: "codex", session_scope_id: scope, source: "docs", items: [{ text: "original" }] };
    const entry = { kind: "context_ephemeral_index", id: "restore-item", version: 1 };
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(entry.kind, entry.id, entry.version, JSON.stringify(body), "2020-01-01", "2020-01-01");
    store.migrateLegacyContextVersions([entry]);
    const directory = join(root, "backups", "context-migration", "backups");
    const name = (await readdir(directory)).find(item => item.endsWith(".json"))!;
    const path = join(root, "sessions", scope, "context", "context.db");
    const partition = new DatabaseSync(path);
    try { partition.prepare("DELETE FROM records WHERE kind=? AND id=? AND version=?").run(entry.kind, entry.id, entry.version); }
    finally { partition.close(); }
    const script = join(process.cwd(), "scripts/context-storage-restore.ts");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", script, `--data-root=${root}`, `--backup=${name}`, ...args], { encoding: "utf8" });
    const dry = run(); assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).backup_digest_verified, true);
    assert.equal(JSON.parse(dry.stdout).target_checked, true);
    assert.equal(JSON.parse(dry.stdout).status_counts.restore_ready, 1);
    assert.equal(contextStoragePreflight(craftPaths(root)).records[0]?.status, "partition_row_missing");
    const restored = run("--apply"); assert.equal(restored.status, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).restored, 1);
    assert.equal(JSON.parse(restored.stdout).verified, 1);
    assert.deepEqual(store.restoreContextMigrationBackup(name), { restored: 0, already_present: 1 });
    const existing = run(); assert.equal(JSON.parse(existing.stdout).status_counts.already_present, 1);
    assert.notEqual(run("--bad").status, 0);
    const preload = join(root, "restore-fault.mjs");
    const storeUrl = pathToFileURL(join(process.cwd(), "common/craft-common-store-local/src/store.ts")).href;
    await writeFile(preload, `import { CraftStore } from ${JSON.stringify(storeUrl)}; import { DatabaseSync } from 'node:sqlite';
      const original = CraftStore.prototype.restoreContextMigrationBackup;
      CraftStore.prototype.restoreContextMigrationBackup = function(name) { const result = original.call(this, name); const db = new DatabaseSync(${JSON.stringify(path)}); db.prepare('UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?').run('{}', ${JSON.stringify(entry.kind)}, ${JSON.stringify(entry.id)}, 1); db.close(); return result; };`);
    const fault = spawnSync(process.execPath, ["--experimental-strip-types", "--import", preload, script, `--data-root=${root}`, `--backup=${name}`, "--apply"], { encoding: "utf8" });
    assert.notEqual(fault.status, 0);
    assert.match(fault.stderr, /restore readback mismatch/u);
    const changed = new DatabaseSync(path);
    try { changed.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?").run(JSON.stringify({ ...body, source: "changed" }), entry.kind, entry.id, entry.version); }
    finally { changed.close(); }
    assert.throws(() => store.restoreContextMigrationBackup(name), /target conflicts/u);
    const blocked = run("--apply"); assert.equal(blocked.status, 2, blocked.stderr);
    assert.equal(JSON.parse(blocked.stdout).status_counts.target_conflict, 1);
    const central = store.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(entry.kind, entry.id, entry.version) as { payload_json: string };
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?").run(JSON.stringify({ ...JSON.parse(central.payload_json), context_payload_digest: "sha256:changed" }), entry.kind, entry.id, entry.version);
    assert.throws(() => store.restoreContextMigrationBackup(name), /published pointer changed/u);
    assert.equal(JSON.parse(run().stdout).status_counts.pointer_changed, 1);
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=? AND version=?").run(central.payload_json, entry.kind, entry.id, entry.version);
    new MemoryFileStore(store).queueSessionArchive("restore", "codex");
    const archived = run("--apply"); assert.equal(archived.status, 2);
    assert.equal(JSON.parse(archived.stdout).status_counts.session_archived, 1);
    const before = await readFile(join(directory, name), "utf8");
    await writeFile(join(directory, name), `${before} `);
    assert.throws(() => store.restoreContextMigrationBackup(name), /backup digest mismatch/u);
    assert.notEqual(run().status, 0);
    assert.throws(() => store.restoreContextMigrationBackup("../bad"), /backup name/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context restore preflight rejects invalid inputs and unsafe paths", async () => {
  const { store, root } = await openStore();
  try {
    const directory = join(root, "backups", "context-migration", "backups");
    await mkdir(directory, { recursive: true });
    const script = join(process.cwd(), "scripts/context-storage-restore.ts");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", script, `--data-root=${root}`, ...args], { encoding: "utf8" });
    const save = async (value: unknown) => {
      const content = JSON.stringify(value);
      const name = `legacy-partition-${createHash("sha256").update(content).digest("hex")}.json`;
      await writeFile(join(directory, name), content);
      return name;
    };
    assert.notEqual(run().status, 0);
    assert.notEqual(run("--backup=bad").status, 0);
    assert.notEqual(run("--apply", "--apply").status, 0);
    const invalid = await save({ schema: "wrong" });
    assert.notEqual(run(`--backup=${invalid}`).status, 0);
    const scope = sessionStorageScopeId("codex", "preflight-invalid");
    const empty = await save({ schema: "craft.capability-partition-migration-backup.v1", domain: "context", scope: { kind: "session", id: scope }, records: [] });
    assert.notEqual(run(`--backup=${empty}`, "--apply").status, 0);
    const backup = { schema: "craft.capability-partition-migration-backup.v1", domain: "context", scope: { kind: "session", id: scope }, records: [null] };
    const name = await save(backup);
    const blocked = run(`--backup=${name}`, "--apply"); assert.equal(blocked.status, 2);
    assert.equal(JSON.parse(blocked.stdout).status_counts.invalid_backup_record, 1);
    const base = { kind: "context_ephemeral_index", id: "x", version: 1, created_at: "x", updated_at: "x" };
    const varied = await save({ ...backup, records: [
      { ...base, payload_json: "{" },
      { ...base, updated_at: 1, payload_json: "{}" },
      { ...base, payload_json: JSON.stringify({ session_id: "preflight-invalid", session_host: "codex", session_scope_id: "wrong" }) },
      { ...base, payload_json: JSON.stringify({ session_id: "preflight-invalid", session_host: "codex", session_scope_id: scope }) },
    ] });
    const result = run(`--backup=${varied}`); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).status_counts, { invalid_backup_record: 3, pointer_changed: 1 });
    const targetDir = join(root, "sessions", scope);
    await mkdir(targetDir, { recursive: true });
    await symlink(root, join(targetDir, "context"));
    assert.notEqual(run(`--backup=${name}`).status, 0);
    await rm(join(targetDir, "context"));
    await mkdir(join(targetDir, "context"));
    await symlink(join(directory, name), join(targetDir, "context", "context.db"));
    assert.notEqual(run(`--backup=${name}`).status, 0);
    await rm(join(directory, name));
    await symlink(join(directory, varied), join(directory, name));
    assert.notEqual(run(`--backup=${name}`).status, 0);
    await rm(directory, { recursive: true });
    await symlink(root, directory);
    assert.notEqual(run(`--backup=${name}`).status, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context migration recovers after the process dies between copy and pointer switch", { timeout: 15_000 }, async () => {
  const fixture = await openStore();
  let store = fixture.store;
  const scope = sessionStorageScopeId("codex", "crash");
  const entry = { kind: "context_ephemeral_index", id: "crash-record", version: 1 };
  const body = { session_id: "crash", session_host: "codex", session_scope_id: scope, source: "docs", items: [{ text: "recoverable" }] };
  store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run(entry.kind, entry.id, entry.version, JSON.stringify(body), "2020-01-01", "2020-01-01");
  store.close();
  const moduleUrl = pathToFileURL(join(process.cwd(), "common/craft-common-store-local/src/store.ts")).href;
  const pathsUrl = pathToFileURL(join(process.cwd(), "common/craft-common-store-local/src/paths.ts")).href;
  const script = `const { writeSync } = await import('node:fs'); const { CraftStore } = await import(process.argv[1]); const { craftPaths } = await import(process.argv[2]);
    const store = await new CraftStore(craftPaths(process.argv[3])).open({ skipLegacyPartitionMigration: true });
    const original = store.memoryHeader.bind(store);
    store.memoryHeader = (...args) => { const header = original(...args); writeSync(1, 'ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); return header; };
    store.migrateLegacyContextVersions([{ kind: 'context_ephemeral_index', id: 'crash-record', version: 1 }]);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, moduleUrl, pathsUrl, fixture.root], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const [ready] = await once(child.stdout!, "data");
    assert.match(String(ready), /ready/u);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    store = await new CraftStore(craftPaths(fixture.root)).open({ skipLegacyPartitionMigration: true });
    const central = store.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(entry.kind, entry.id, entry.version) as { payload_json: string };
    assert.equal(central.payload_json, JSON.stringify(body));
    const file = join(fixture.root, "sessions", scope, "context", "context.db");
    const partition = new DatabaseSync(file, { readOnly: true });
    try { assert.equal((partition.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? AND version=?").get(entry.kind, entry.id, entry.version) as { payload_json: string }).payload_json, central.payload_json); }
    finally { partition.close(); }
    assert.equal(store.migrateLegacyContextVersions([entry]).migrated, 1);
    assert.equal(contextStoragePreflight(craftPaths(fixture.root)).records[0]?.status, "partition_digest_verified");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    store.close(); await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Context migration resumes a batch after a committed version and process death", { timeout: 15_000 }, async () => {
  const fixture = await openStore();
  let store = fixture.store;
  const scope = sessionStorageScopeId("codex", "batch-crash");
  new ContextExtensionsKernel(store).checkpointResume({ session_id: "batch-crash", session_host: "codex" });
  const entries = ["first", "second"].map(id => ({ kind: "context_ephemeral_index", id, version: 1 }));
  const insert = store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)");
  for (const entry of entries) insert.run(entry.kind, entry.id, entry.version, JSON.stringify({ session_id: "batch-crash", session_host: "codex", session_scope_id: scope, source: entry.id, items: [{ text: entry.id }] }), "2020-01-01", "2020-01-01");
  store.close();
  const moduleUrl = pathToFileURL(join(process.cwd(), "common/craft-common-store-local/src/store.ts")).href;
  const pathsUrl = pathToFileURL(join(process.cwd(), "common/craft-common-store-local/src/paths.ts")).href;
  const script = `const { writeSync } = await import('node:fs'); const { CraftStore } = await import(process.argv[1]); const { craftPaths } = await import(process.argv[2]);
    const store = await new CraftStore(craftPaths(process.argv[3])).open({ skipLegacyPartitionMigration: true });
    const original = store.transaction.bind(store);
    store.transaction = (...args) => { const result = original(...args); writeSync(1, 'ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); return result; };
    store.migrateLegacyContextVersions([{ kind: 'context_ephemeral_index', id: 'first', version: 1 }, { kind: 'context_ephemeral_index', id: 'second', version: 1 }]);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, moduleUrl, pathsUrl, fixture.root], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const [ready] = await once(child.stdout!, "data"); assert.match(String(ready), /ready/u);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    store = await new CraftStore(craftPaths(fixture.root)).open({ skipLegacyPartitionMigration: true });
    const before = contextStoragePreflight(craftPaths(fixture.root)).records.filter(item => item.kind === "context_ephemeral_index");
    assert.deepEqual(before.map(item => item.status), ["partition_digest_verified", "central_ready"]);
    assert.deepEqual(store.migrateLegacyContextVersions(entries), { migrated: 1, already_current: 1 });
    const after = contextStoragePreflight(craftPaths(fixture.root)).records.filter(item => item.kind === "context_ephemeral_index");
    assert.deepEqual(after.map(item => item.status), ["partition_digest_verified", "partition_digest_verified"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    store.close(); await rm(fixture.root, { recursive: true, force: true });
  }
});

test("expired ephemeral reads recheck removal and renewal inside the write transaction", async () => {
  const { store, root } = await openStore();
  const originalFind = store.find.bind(store);
  try {
    const kernel = new ContextExtensionsKernel(store);
    const created = kernel.recordEphemeral({ session_host: "codex", session_id: "s", source: "docs", now: "2020-01-01T00:00:00.000Z", ttl_seconds: 1, items: [{ text: "alpha" }] });
    const id = String(created.index_id);
    const original = originalFind("context_ephemeral_index", id, undefined, false)!;
    for (const replacement of [null, { ...original, expires_at: "2099-01-01T00:00:00.000Z" }]) {
      let calls = 0;
      store.find = ((...args: Parameters<typeof store.find>) => {
        if (args[0] === "context_ephemeral_index" && args[1] === id && ++calls === 2) return replacement;
        return originalFind(...args);
      }) as typeof store.find;
      const result = kernel.searchEphemeral({ session_host: "codex", session_id: "s", source: "docs", query: "alpha", now: "2021-01-01T00:00:00.000Z" });
      assert.equal(result.reason, replacement ? "matched" : "index_expired");
      store.find = originalFind;
    }
    assert.ok(originalFind("context_ephemeral_index", id, undefined, false));
  } finally { store.find = originalFind; store.close(); await rm(root, { recursive: true, force: true }); }
});

test("output capture passes small results and indexes large ones", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    assert.equal(kernel.captureOutput({ session_host: "codex", tool_name: "Read", content: "small" }).action, "pass");
    assert.throws(() => kernel.captureOutput({ session_host: "codex", tool_name: "Read", content: "x".repeat(9_000) }), /session_id/u);
    const indexed = kernel.captureOutput({ session_host: "codex", tool_name: "Read", content: "x".repeat(9_000), session_id: "s" });
    assert.equal(indexed.action, "indexed");
    assert.equal(indexed.preview, "");
    const withTtl = kernel.captureOutput({ session_host: "codex", tool_name: "Read", content: "x".repeat(9_000), session_id: "s", ttl_seconds: 60 });
    assert.equal(withTtl.action, "indexed");
    assert.equal(kernel.captureOutput({ session_host: "codex", session_id: "s", content: "x".repeat(9_000) }).action, "indexed");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("compute refuses without consent and bounds its inputs", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    assert.throws(() => kernel.compute({ language: "javascript", code: "1" }), /allow_execution/u);
    assert.throws(() => kernel.compute({ language: "ruby", code: "1", allow_execution: true }), /language/u);
    assert.throws(() => kernel.compute({ language: "javascript", code: "x".repeat(200_001), allow_execution: true }), /source limit/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("compute returns bounded stdout, truncates floods and reports timeouts", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const ok = kernel.compute({ language: "javascript", code: "console.log('hello')", allow_execution: true });
    assert.equal(ok.exit_code, 0);
    assert.equal(String(ok.stdout).trim(), "hello");
    assert.equal(ok.not_a_security_sandbox, true);
    const flood = kernel.compute({ language: "javascript", code: "console.log('x'.repeat(20000))", allow_execution: true, output_limit: 100 });
    assert.equal(flood.stdout_truncated, true);
    const slow = kernel.compute({ language: "javascript", code: "while(true){}", allow_execution: true, timeout_ms: 50 });
    assert.equal(slow.timed_out, true);
    const python = kernel.compute({ language: "python", code: "print(1)", allow_execution: true });
    assert.equal(typeof python.exit_code === "number" || python.exit_code === null, true);
    const shell = kernel.compute({ language: "shell", code: "Write-Output ok", allow_execution: true, timeout_ms: 10_000 });
    assert.equal(typeof shell.exit_code === "number" || shell.exit_code === null, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("resume snapshot checkpoints, reads and projects bounded content", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    assert.equal(kernel.getResume({ session_host: "codex", session_id: "r" }).resume_available, false);
    assert.equal(kernel.resolveResume({ session_host: "codex", session_id: "r" }).resume_available, false);
    const created = kernel.checkpointResume({ session_host: "codex", session_id: "r", scope: "project:p", files_touched: ["a.ts"], tasks: ["finish"], errors: ["boom"], decisions: ["use X"], open_questions: ["next?"] });
    assert.equal(created.content_free, false);
    assert.equal((created.snapshot as Record<string, unknown>).content_free, false);
    const updated = kernel.checkpointResume({ session_host: "codex", session_id: "r", tasks: ["again"] });
    assert.equal(updated.snapshot !== null, true);
    const projected = kernel.resolveResume({ session_host: "codex", session_id: "r", max_chars: 5 });
    assert.equal(projected.truncated, true);
    assert.equal(projected.content, "");
    assert.equal(projected.reason, "requires_expansion");
    const complete = kernel.resolveResume({ session_host: "codex", session_id: "r", max_chars: 8_000 });
    assert.equal(complete.truncated, false);
    assert.equal(complete.content_free, false);
    assert.equal(kernel.getResume({ session_host: "codex", session_id: "r" }).resume_available, true);
    assert.throws(() => kernel.checkpointResume({ session_host: "codex", session_id: "r", now: "nope" }), /ISO timestamp/u);
    assert.throws(() => kernel.checkpointResume({ session_host: "codex", session_id: "r", tasks: "nope" }), /tasks/u);
    assert.throws(() => kernel.checkpointResume({ session_host: "codex", session_id: "r", tasks: Array(101).fill("task") }), /item limit/u);
    assert.throws(() => kernel.checkpointResume({ session_host: "codex", session_id: "r", tasks: ["x".repeat(2001)] }), /character limit/u);
    assert.throws(() => kernel.checkpointResume({ session_host: "codex", session_id: "r", tasks: Array(5).fill("x".repeat(2000)) }), /character limit/u);
    assert.equal(kernel.checkpointResume({ session_host: "codex", session_id: "r", tasks: [] }).content_free, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("sparse raw records fall back without fabricating content", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const future = new Date(Date.now() + 60_000).toISOString();
    store.create("context_ephemeral_index", "raw-items", { session_id: "s", session_host: "codex", session_scope_id: sessionStorageScopeId("codex", "s"), source: "raw", expires_at: future,
      items: [{ id: "x", title: "alpha" }, { id: "y", text: "alpha" }] });
    const sparse = kernel.searchEphemeral({ session_host: "codex", session_id: "s", source: "raw", index_id: "raw-items", query: "alpha" });
    assert.equal(sparse.reason, "matched");
    assert.equal((sparse.hits as unknown[]).length, 2);
    store.create("context_ephemeral_index", "raw-no-items", { session_id: "s", session_host: "codex", session_scope_id: sessionStorageScopeId("codex", "s"), source: "none", expires_at: future, items: "not-an-array" });
    assert.equal(kernel.searchEphemeral({ session_host: "codex", session_id: "s", source: "none", index_id: "raw-no-items", query: "alpha" }).reason, "no_match");
    const createdResume = kernel.checkpointResume({ session_host: "codex", session_id: "sparse" });
    store.save("context_resume_snapshot", String(createdResume.resume_id), { ...(createdResume.snapshot as Record<string, unknown>), files_touched: "not-an-array" });
    const projected = kernel.resolveResume({ session_host: "codex", session_id: "sparse" });
    assert.equal(projected.content, "");
    store.create("context_resolution_receipt", "empty-receipt", {});
    assert.equal(kernel.stats({}).estimated_tokens, 0);
    store.create("retrieval_adapter", "eligible-adapter", { status: "eligible" });
    store.create("retrieval_adapter", "configured-adapter", { status: "configured" });
    assert.equal(kernel.health({}).ok, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("resume snapshots isolate equal session IDs between Hosts and reject mismatched records", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const codex = kernel.checkpointResume({ session_id: "same", session_host: "codex", tasks: ["codex task"] });
    const claude = kernel.checkpointResume({ session_id: "same", session_host: "claude", tasks: ["claude task"] });
    assert.notEqual(codex.resume_id, claude.resume_id);
    assert.match(String(kernel.resolveResume({ session_id: "same", session_host: "codex" }).content), /codex task/u);
    assert.match(String(kernel.resolveResume({ session_id: "same", session_host: "claude" }).content), /claude task/u);
    assert.throws(() => kernel.getResume({ session_id: "same" }), /session_host/u);
    assert.throws(() => store.save("context_resume_snapshot", String(codex.resume_id), { ...(codex.snapshot as Record<string, unknown>), session_host: "claude" }), /identity is invalid/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("resume rejects mismatched identity and tolerates missing captured time", async () => {
  const { store, root } = await openStore();
  const original = store.find.bind(store);
  try {
    const kernel = new ContextExtensionsKernel(store), args = { session_id: "read-guard", session_host: "codex" };
    const created = kernel.checkpointResume({ ...args, tasks: ["task"] });
    const record = created.snapshot as JsonObject;
    store.find = ((...params: Parameters<typeof store.find>) => params[0] === "context_resume_snapshot"
      ? { ...record, session_host: "claude" } : original(...params)) as typeof store.find;
    assert.throws(() => kernel.checkpointResume(args), /scope mismatch/u);
    assert.throws(() => kernel.getResume(args), /scope mismatch/u);
    assert.throws(() => kernel.resolveResume(args), /scope mismatch/u);
    store.find = ((...params: Parameters<typeof store.find>) => params[0] === "context_resume_snapshot"
      ? { ...record, captured_at: undefined } : original(...params)) as typeof store.find;
    assert.equal(kernel.resolveResume(args).captured_at, null);
  } finally { store.find = original; store.close(); await rm(root, { recursive: true, force: true }); }
});

test("ephemeral expansion handles a sparse item without inventing a body", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store), args = { session_id: "sparse-expand", session_host: "codex", source: "docs" };
    const saved = kernel.recordEphemeral({ ...args, items: [{ id: "item", text: "body" }] });
    const record = store.find("context_ephemeral_index", String(saved.index_id), undefined, false)!;
    store.save("context_ephemeral_index", String(saved.index_id), { ...record, items: [{ id: "item" }] });
    const result = kernel.searchEphemeral({ ...args, query: "body", read_item_id: "item", read_start: 0, read_end: 0, identity_digest: saved.identity_digest });
    assert.equal(result.content, "");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("compute handles a failed spawn with absent output streams", async () => {
  const { store, root } = await openStore(); store.close();
  try {
    const script = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
      cp.spawnSync = () => ({ status: null, signal: null, stdout: null, stderr: null, error: { code: 'ENOENT' } }); syncBuiltinESMExports();
      const { CraftStore } = await import(process.argv[1]); const { craftPaths } = await import(process.argv[2]); const { ContextExtensionsKernel } = await import(process.argv[3]);
      const store = await new CraftStore(craftPaths(process.argv[4])).open({ skipLegacyPartitionMigration: true });
      const result = new ContextExtensionsKernel(store).compute({ language: 'javascript', code: '1', allow_execution: true });
      if (result.stdout !== '' || result.stderr !== '') process.exitCode = 2; store.close();`;
    const urls = ["common/craft-common-store-local/src/store.ts", "common/craft-common-store-local/src/paths.ts", "core/context-extensions.ts"].map(path => pathToFileURL(join(process.cwd(), path)).href);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, ...urls, root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("queued session archive fences and removes only its Host Context records", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store), files = new MemoryFileStore(store);
    const codex = { session_id: "same", session_host: "codex" }, claude = { session_id: "same", session_host: "claude" };
    const one = kernel.recordEphemeral({ ...codex, source: "docs", items: [{ text: "alpha" }] });
    const two = kernel.recordEphemeral({ ...claude, source: "docs", items: [{ text: "alpha" }] });
    const resume = kernel.checkpointResume({ ...codex, tasks: ["task"] });
    const otherResume = kernel.checkpointResume({ ...claude, tasks: ["other task"] });
    store.create("context_ephemeral_index", "legacy-without-host", { session_id: "same", source: "docs" });
    files.queueSessionArchive("same", "codex");
    assert.throws(() => kernel.recordEphemeral({ ...codex, items: [{ text: "late" }] }), /SESSION_ARCHIVED/u);
    assert.throws(() => kernel.checkpointResume({ ...codex, tasks: ["late"] }), /SESSION_ARCHIVED/u);
    assert.throws(() => kernel.searchEphemeral({ ...codex, source: "docs", query: "alpha" }), /SESSION_ARCHIVED/u);
    assert.throws(() => kernel.getResume(codex), /SESSION_ARCHIVED/u);
    assert.throws(() => kernel.resolveResume(codex), /SESSION_ARCHIVED/u);
    let result: JsonObject = {};
    for (let i = 0; i < 20 && result.status !== "archived"; i++) result = files.archiveSessionStep("same", "codex", 1);
    assert.equal(result.status, "archived");
    assert.equal(store.find("context_ephemeral_index", String(one.index_id), undefined, false), null);
    assert.equal(store.find("context_resume_snapshot", String(resume.resume_id), undefined, false), null);
    assert.ok(store.find("context_ephemeral_index", String(two.index_id), undefined, false));
    assert.ok(store.find("context_resume_snapshot", String(otherResume.resume_id), undefined, false));
    assert.ok(store.find("context_ephemeral_index", "legacy-without-host", undefined, false));
    assert.equal(kernel.searchEphemeral({ ...claude, source: "docs", query: "alpha" }).reason, "matched");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("invalid Context archive checkpoint stops for reconciliation", async () => {
  const { store, root } = await openStore();
  try {
    const files = new MemoryFileStore(store);
    const queued = files.queueSessionArchive("bad-checkpoint", "codex");
    store.save("memory_session_archive", String(queued.id), { ...queued, inventory_complete: true, observations_complete: true, context_cleanup_index: 2 });
    const result = files.runQueuedArchiveSteps();
    const outcome = (result.outcomes as Array<Record<string, unknown>>)[0]!;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.needs_reconciliation, true);
    assert.equal(store.find("memory_session_archive", String(queued.id))?.retry_state, "requires_reconciliation");
    const badCursor = files.queueSessionArchive("bad-cursor", "codex");
    store.save("memory_session_archive", String(badCursor.id), { ...badCursor, inventory_complete: true, observations_complete: true, context_cleanup_cursor: 42 });
    const cursorResult = files.runQueuedArchiveSteps();
    assert.equal((cursorResult.outcomes as Array<Record<string, unknown>>)[0]?.needs_reconciliation, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context archive resumes a paginated cleanup after reopening its store", async () => {
  const fixture = await openStore();
  let store = fixture.store;
  try {
    const kernel = new ContextExtensionsKernel(store);
    for (let i = 0; i < 215; i++) kernel.recordEphemeral({ session_id: "page", session_host: "codex", source: `source-${i}`, items: [{ text: "alpha" }] });
    const other = kernel.recordEphemeral({ session_id: "page", session_host: "claude", source: "other", items: [{ text: "alpha" }] });
    let files = new MemoryFileStore(store);
    files.queueSessionArchive("page", "codex");
    let result: JsonObject = {};
    for (let i = 0; i < 20; i++) {
      result = files.archiveSessionStep("page", "codex", 1);
      if (result.context_cleanup_index === 0 && typeof result.context_cleanup_cursor === "string" && result.context_cleanup_cursor) break;
    }
    assert.equal(result.status, "archiving");
    assert.ok(result.context_cleanup_cursor);
    store.close();
    store = await new CraftStore(craftPaths(fixture.root)).open();
    files = new MemoryFileStore(store);
    for (let i = 0; i < 20 && result.status !== "archived"; i++) result = files.archiveSessionStep("page", "codex", 1);
    assert.equal(result.status, "archived");
    assert.equal(store.list("context_ephemeral_index", 1000, row => row.session_host === "codex", false).length, 0);
    assert.ok(store.find("context_ephemeral_index", String(other.index_id), undefined, false));
  } finally { store.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test("Context archive pages only the exact Host session", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    for (const source of ["a", "b", "c"]) kernel.recordEphemeral({ session_id: "s", session_host: "codex", source, items: [{ text: "x" }] });
    kernel.recordEphemeral({ session_id: "s", session_host: "claude", source: "a", items: [{ text: "x" }] });
    const first = store.listSessionContextPage("context_ephemeral_index", "s", "codex", "", 2);
    assert.equal(first.records.length, 2);
    assert.equal(first.has_more, true);
    const last = store.listSessionContextPage("context_ephemeral_index", "s", "codex", first.next_cursor!, 2);
    assert.equal(last.records.length, 1);
    assert.equal(last.has_more, false);
    assert.equal(store.listSessionContextPage("context_resume_snapshot", "s", "codex", "", 2).records.length, 0);
    assert.throws(() => store.listSessionContextPage("other", "s", "codex", "", 1), /Unsupported/u);
    assert.throws(() => store.listSessionContextPage("context_ephemeral_index", "s", "codex", null as unknown as string, 1), /after_id/u);
    assert.throws(() => store.listSessionContextPage("context_ephemeral_index", "s", "codex", "", 1001), /page limit/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("stats and health summarize existing receipts without reading bodies", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const empty = kernel.stats({});
    assert.equal(empty.receipts, 0);
    assert.equal((empty.feedback_outcomes as Record<string, number>).helpful, undefined);
    store.create("context_resolution_receipt", "r1", { total_used_chars: 300, omitted_count: 2, deduplicated_count: 1, total_items: 4 });
    store.create("context_working_set_receipt", "w1", {});
    store.create("context_emission", "e1", {});
    store.create("context_feedback", "f1", { outcome: "helpful" });
    store.create("context_feedback", "f2", { outcome: "helpful" });
    store.create("context_feedback", "f3", {});
    const populated = kernel.stats({});
    assert.equal(populated.receipts, 1);
    assert.equal(populated.feedback, 3);
    assert.equal((populated.feedback_outcomes as Record<string, number>).helpful, 2);
    assert.equal(populated.estimated_tokens, 100);
    const health = kernel.health({});
    assert.equal(health.ok, true);
    assert.equal((health.checks as unknown[]).length, 5);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("health fails closed when the store is unavailable", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    store.close();
    const health = kernel.health({});
    assert.equal(health.ok, false);
    assert.equal((health.checks as unknown[]).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("new context tools are registered and mounted on the context product", () => {
  const names = new Set(TOOLS.map((tool) => tool.name));
  for (const name of ["craft_context_routing_render", "craft_context_ephemeral_record", "craft_context_ephemeral_search",
    "craft_context_ephemeral_purge", "craft_context_output_capture", "craft_context_compute", "craft_context_resume_checkpoint",
    "craft_context_resume_get", "craft_context_resume_resolve", "craft_context_stats", "craft_context_health",
    "craft_context_correction_list", "craft_context_correction_decide",
    "craft_codebase_symbol_usage_record", "craft_codebase_symbol_usage_get"]) {
    assert.equal(names.has(name), true, `${name} must be registered`);
    assert.equal(CONTEXT_ROUTED_TOOL_NAMES.has(name), true, `${name} must be on the context product`);
  }
  const search = TOOLS.find(tool => tool.name === "craft_context_ephemeral_search")!;
  const properties = search.inputSchema.properties as Record<string, { type: string }>;
  for (const name of ["read_start", "read_end", "max_chars"]) assert.equal(properties[name]?.type, "integer");
  for (const name of ["read_item_id", "identity_digest"]) assert.equal(properties[name]?.type, "string");
});

test("service delegates the context extension tools", async () => {
  const { store, root } = await openStore();
  try {
    const service = new CraftService(store);
    assert.equal(service.contextExtensionsStats({}).receipts, 0);
    assert.equal(service.contextExtensionsHealth({}).ok, true);
    assert.equal(service.contextExtensionsRenderRouting({}).client, "codex");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("correction tasks can be listed and resolved without changing source status", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    store.create("context_correction_task", "t1", { status: "pending_review", outcome: "incorrect",
      asset_ref: { member: "knowledge", id: "k1", version: 1 } });
    store.create("context_correction_task", "t2", { status: "pending_review", outcome: "stale",
      asset_ref: { member: "memory", id: "m1", version: 1 } });
    assert.equal(kernel.listCorrections({}).count, 2);
    assert.equal(kernel.listCorrections({ member: "memory" }).count, 1);
    assert.throws(() => kernel.listCorrections({ status: "nope" }), /status/u);
    const confirmed = kernel.decideCorrection({ task_id: "t1", decision: "confirmed", reason: "verified" });
    assert.equal(confirmed.changes_source_status, false);
    assert.equal((confirmed.correction as JsonObject).status, "confirmed");
    assert.equal(kernel.decideCorrection({ task_id: "t1", decision: "confirmed" }).idempotent, true);
    assert.throws(() => kernel.decideCorrection({ task_id: "t1", decision: "dismissed" }), /already resolved/u);
    assert.equal(kernel.decideCorrection({ task_id: "t2", decision: "dismissed" }).idempotent, false);
    assert.throws(() => kernel.decideCorrection({ task_id: "t2", decision: "other" }), /decision/u);
    assert.equal(kernel.listCorrections({ status: "confirmed" }).count, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("codebase symbol usage records and reads net per-symbol weights", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s1", outcome: "passed" });
    kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s1", outcome: "passed" });
    kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s2", outcome: "failed" });
    kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s3", outcome: "read" });
    kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s4" });
    store.create("codebase_symbol_usage", "raw-usage", { index_id: "i1", symbol_id: "s5", outcome: "passed" });
    store.create("codebase_symbol_usage", "raw-no-symbol", { index_id: "i1", outcome: "passed" });
    store.create("codebase_symbol_usage", "raw-unknown", { index_id: "i1", symbol_id: "s6", outcome: "other" });
    const legacyId = `codebase_symbol_usage_${stableDigest({ index_id: "i1", symbol_id: "s7", outcome: "read", day: "2026-01-01" }).slice(-24)}`;
    store.create("codebase_symbol_usage", legacyId, { index_id: "i1", symbol_id: "s7", outcome: "read", day: "2026-01-01" });
    assert.equal((kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s7", outcome: "read", now: "2026-01-01T00:00:00.000Z" }).usage as JsonObject).count, 2);
    kernel.recordCodebaseUsage({ index_id: "i2", symbol_id: "s1", outcome: "passed" });
    assert.deepEqual(kernel.getCodebaseUsage({ index_id: "i1" }).weights as Array<[string, number]>,
      [["s1", 2], ["s2", -1], ["s3", 0.5], ["s4", 0.5], ["s5", 1], ["s7", 1]]);
    assert.throws(() => kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s1", outcome: "nope" }), /outcome/u);
    assert.throws(() => kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s1", now: "nope" }), /timestamp/u);
    assert.throws(() => kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: " " }), /symbol_id/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
