import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CraftStore } from "../src/store.ts";
import { craftPaths } from "../src/paths.ts";
import { MarkdownContentStore } from "../src/content-store.ts";
import { CraftService } from "../src/application/craft-service.ts";
import { ContentMigrationKernel } from "../src/content-migration.ts";
import { MemoryConsolidationKernel } from "../src/memory-consolidation.ts";
import { McpServer } from "../src/mcp.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-content-store-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  return { root, paths, store, service: new CraftService(store) };
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`; }

test("MarkdownContentStore writes self-describing content and verifies its digest", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const ref = await content.write({ kind: "knowledge", record_id: "claim-1", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "Hello knowledge" });
  assert.match(ref.path, /knowledge\/md\/claim-1\.v1\.md$/);
  assert.equal((await content.read(ref)).body, "Hello knowledge");
  assert.equal((await content.verify(ref)).status, "verified");
  assert.equal(content.verifySync(ref).status, "verified");
  assert.equal(content.verifySync({ ...ref, path: join(f.root, "missing.md") }).status, "drifted");
  const missing = await content.write({ kind: "knowledge", record_id: "missing", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "to remove" });
  await unlink(missing.path);
  assert.equal((await content.verify(missing)).status, "missing");
  assert.equal(content.verifySync(missing).status, "missing");
  const raw = await readFile(ref.path, "utf8");
  assert.match(raw, /^---\nschema_version: "craft\.content\.v1"/m);
  assert.match(raw, /record_version: 1/);
  assert.equal((await stat(ref.path)).mode & 0o777, 0o600);
  const legacyPath = content.legacyPathFor("knowledge", "claim-1", 1);
  await mkdir(dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, raw, "utf8");
  assert.equal(content.readCompatSync({ ...ref, path: legacyPath }).body, "Hello knowledge");
  assert.throws(() => content.readCompatSync({ ...ref, path: join(f.root, "outside.md") }), /outside/);
  await f.store.close();
});

test("content drift and unsafe identifiers fail closed", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const ref = await content.write({ kind: "memory", record_id: "memory-1", version: 1, scope: "user:local", status: "active", sensitivity: "restricted", source_id: "source-1", body: "Private memory" });
  await assert.rejects(content.read({ ...ref, record_id: "other" }), /outside|metadata/);
  await writeFile(ref.path, (await readFile(ref.path, "utf8")).replace("Private memory", "Changed memory"), "utf8");
  await assert.rejects(content.read(ref), /digest/);
  assert.equal((await content.verify(ref)).status, "drifted");
  assert.equal(content.verifySync(ref).status, "drifted");
  await content.writeSync({ kind: "memory", record_id: "memory-2", version: 1, scope: "user:local", status: "active", sensitivity: "restricted", source_id: "source-1", body: "Private memory" });
  await writeFile(ref.path, "tampered", "utf8");
  await assert.rejects(content.read(ref), /frontmatter|digest/);
  await assert.rejects(content.write({ kind: "memory", record_id: "../escape", version: 1, scope: "user:local", status: "active", sensitivity: "restricted", source_id: "source-1", body: "x" }), /identifier/);
  await f.store.close();
});

test("content store rejects malformed documents and conflicting versions", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const ref = await content.write({ kind: "knowledge", record_id: "friendly id", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "body" });
  assert.equal((await content.write({ kind: "knowledge", record_id: "friendly id", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "body" })).digest, ref.digest);
  await assert.rejects(content.write({ kind: "knowledge", record_id: "friendly id", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "other" }), /different body/);
  assert.throws(() => content.writeSync({ kind: "knowledge", record_id: "friendly id", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "other" }), /different body/);
  await writeFile(ref.path, "---\nschema_version: \"wrong\"\n---\nbody", "utf8");
  await assert.rejects(content.read(ref), /incomplete/);
  await writeFile(join(f.root, "unclosed.md"), "---\nschema_version: \"craft.content.v1\"", "utf8");
  assert.throws(() => content.readUncheckedSync(join(f.root, "unclosed.md")), /not closed/);
  await writeFile(join(f.root, "invalid-line.md"), "---\nnot-a-field\n---\nbody", "utf8");
  assert.throws(() => content.readUncheckedSync(join(f.root, "invalid-line.md")), /frontmatter is invalid/);
  const conflict = await content.write({ kind: "knowledge", record_id: "identity", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "identity" });
  await writeFile(conflict.path, (await readFile(conflict.path, "utf8")).replace('record_id: "identity"', 'record_id: "other"'), "utf8");
  await assert.rejects(content.write({ kind: "knowledge", record_id: "identity", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "identity" }), /identity conflict/);
  const syncConflict = content.writeSync({ kind: "knowledge", record_id: "sync-identity", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "sync" });
  writeFileSync(syncConflict.path, readFileSync(syncConflict.path, "utf8").replace('record_id: "sync-identity"', 'record_id: "other"'), "utf8");
  assert.throws(() => content.writeSync({ kind: "knowledge", record_id: "sync-identity", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "sync" }), /identity conflict/);
  assert.throws(() => content.writeSync({ kind: "knowledge", record_id: "bad-sync-version", version: 0, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "x" }), /positive integer/);
  assert.match(content.pathFor("knowledge", "no-version"), /no-version\.md$/);
  assert.match(content.legacyPathFor("memory", "no-version"), /no-version\.md$/);
  await assert.rejects(content.write({ kind: "knowledge", record_id: "bad-version", version: 0, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "x" }), /positive integer/);
  await assert.rejects(content.write({ kind: "knowledge", record_id: "empty", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: " " }), /empty/);
  await assert.rejects(content.write({ kind: "knowledge", record_id: "secret", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "password: 12345678" }), /credentials/);
  await f.store.close();
});

test("content verification reports primitive adapter failures without assuming Error objects", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const ref = await content.write({ kind: "knowledge", record_id: "primitive", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body" });
  const asyncRead = content.read.bind(content);
  const syncRead = content.readSync.bind(content);
  content.read = (async () => { throw "primitive"; }) as typeof content.read;
  content.readSync = (() => { throw "primitive"; }) as typeof content.readSync;
  assert.equal((await content.verify(ref)).status, "drifted");
  assert.equal(content.verifySync(ref).status, "drifted");
  content.read = asyncRead;
  content.readSync = syncRead;
  await f.store.close();
});

test("content frontmatter validates every required field and accepts plain scalars", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const fields: Record<string, string> = {
    schema_version: "craft.content.v1", record_kind: "knowledge", record_id: "plain", record_version: "1",
    scope: "global", status: "active", sensitivity: "internal", source_id: "source", body_digest: "sha256:x", updated_at: "now",
  };
  const valid = join(f.root, "plain.md");
  await writeFile(valid, `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\nbody`, "utf8");
  assert.equal(content.readUncheckedSync(valid).manifest.record_id, "plain");
  for (const key of Object.keys(fields)) {
    const altered = { ...fields }; delete altered[key];
    const path = join(f.root, `missing-${key}.md`);
    await writeFile(path, `---\n${Object.entries(altered).map(([name, value]) => `${name}: ${value}`).join("\n")}\n---\nbody`, "utf8");
    assert.throws(() => content.readUncheckedSync(path), /incomplete/);
  }
  const invalidKind = { ...fields, record_kind: "other" };
  await writeFile(join(f.root, "invalid-kind.md"), `---\n${Object.entries(invalidKind).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\nbody`, "utf8");
  assert.throws(() => content.readUncheckedSync(join(f.root, "invalid-kind.md")), /incomplete/);
  await f.store.close();
});

test("knowledge and memory writes persist body in Markdown and only a reference in SQLite", async () => {
  const f = await fixture();
  const evidence = f.store.create("evidence", "evidence-1", { source_type: "test", confidence: "confirmed", claim: "fixture" });
  const claim = f.service.knowledgeClaimSave({ kind: "fact", content: "A durable fact", evidence_ids: [evidence.id] }).claim as Record<string, unknown>;
  assert.equal("content" in claim, false);
  assert.equal((claim.content_ref as Record<string, unknown>).format, "markdown");
  const claimPath = String((claim.content_ref as Record<string, unknown>).path);
  assert.equal((await readFile(claimPath, "utf8")).includes("A durable fact"), true);
  const source = f.service.knowledgeSourceRegister({ source_id: "source-1", kind: "custom", label: "test", scope_kind: "user", scope_id: "local", locator: "test://source", content_digest: "source:v1" }).source as Record<string, unknown>;
  const memory = f.service.memoryLedgerRemember({ source_id: source.id, kind: "episodic", scope_kind: "user", scope_id: "local", content: "A durable memory" }).memory as Record<string, unknown>;
  assert.equal("content" in memory, false);
  assert.equal((memory.content_ref as Record<string, unknown>).format, "markdown");
  const memoryPath = String((memory.content_ref as Record<string, unknown>).path);
  assert.equal((await readFile(memoryPath, "utf8")).includes("A durable memory"), true);
  await f.store.close();
  const reopened = await new CraftStore(f.paths).open();
  const knowledgeIndex = new DatabaseSync(f.paths.knowledgeDatabaseFile);
  const memoryIndex = new DatabaseSync(f.paths.memoryDatabaseFile);
  assert.equal(Number((knowledgeIndex.prepare("SELECT COUNT(*) count FROM content_index WHERE id=?").get(String(claim.id)) as { count: number }).count), 1);
  assert.equal(Number((memoryIndex.prepare("SELECT COUNT(*) count FROM content_index WHERE id=?").get(String(memory.id)) as { count: number }).count), 1);
  knowledgeIndex.close(); memoryIndex.close(); reopened.close();
});

test("layout exposes flat content directories without forcing records on installation", async () => {
  const f = await fixture();
  assert.deepEqual(await readdir(f.paths.knowledgeContentDir), []);
  assert.deepEqual(await readdir(f.paths.memoryContentDir), []);
  assert.equal(existsSync(f.paths.knowledgeDatabaseFile), true);
  assert.equal(existsSync(f.paths.memoryDatabaseFile), true);
  await f.store.close();
});

test("content migration moves legacy inline bodies to Markdown idempotently", async () => {
  const f = await fixture();
  f.store.create("evidence", "unmanaged", { claim: "not content" });
  const legacy = f.store.create("memory_ledger", "legacy-memory", {
    scope_kind: "user", scope_id: "local", kind: "episodic", content: "legacy body", source_id: "legacy",
  });
  const migration = new ContentMigrationKernel(f.store);
  assert.deepEqual(migration.status(), { scanned: 1, inline: 1, referenced: 0, pending: 1 });
  assert.equal((migration.verify() as { failed: number }).failed, 1);
  assert.equal((migration.verify({ kind: "memory_ledger" }) as { failed: number }).failed, 1);
  const dry = migration.migrate({ dry_run: true });
  assert.equal(dry.migrated, 1);
  assert.equal((f.store.rawRecords("memory_ledger")[0]!.payload).content, "legacy body");
  const result = migration.migrate();
  assert.equal(result.migrated, 1);
  assert.equal(result.skipped, 0);
  const raw = f.store.rawRecords("memory_ledger")[0]!;
  assert.equal("content" in raw.payload, false);
  assert.equal((raw.payload.content_ref as Record<string, unknown>).format, "markdown");
  assert.equal(f.store.get("memory_ledger", String(legacy.id)).content, "legacy body");
  assert.deepEqual(migration.status(), { scanned: 1, inline: 0, referenced: 1, pending: 0 });
  assert.equal((migration.verify() as { verified: number }).verified, 1);
  assert.equal(migration.migrate().migrated, 0);
  assert.equal(migration.migrate().skipped, 1);
  await f.store.close();
});

test("content migration relocates old content references into the domain directory", async () => {
  const f = await fixture();
  const content = f.store.contentStore;
  const current = content.writeSync({ kind: "memory", record_id: "old-ref", version: 1, scope: "task", status: "active", sensitivity: "internal", source_id: "legacy", body: "old reference" });
  const oldPath = content.legacyPathFor("memory", "old-ref", 1);
  await mkdir(dirname(oldPath), { recursive: true });
  await writeFile(oldPath, await readFile(current.path, "utf8"), "utf8");
  f.store.create("memory_ledger", "old-ref", { scope: "task", content_ref: { ...current, path: oldPath } });
  const result = new ContentMigrationKernel(f.store).migrate();
  assert.equal(result.migrated, 1);
  assert.match(String((f.store.rawRecords("memory_ledger")[0]!.payload.content_ref as Record<string, unknown>).path), /memory\/md\/old-ref\.v1\.md$/);
  await f.store.close();
});

test("content migration preserves old wiki files and fails closed on secrets", async () => {
  const f = await fixture();
  const oldPath = join(f.root, "legacy-page.md");
  await writeFile(oldPath, "legacy wiki", "utf8");
  f.store.create("wiki_page", "legacy-page", { title: "Legacy", scope: "global", file_path: oldPath, body_digest: "sha256:old" });
  const migration = new ContentMigrationKernel(f.store);
  assert.equal(migration.migrate().migrated, 1);
  const page = f.store.get("wiki_page", "legacy-page");
  assert.match(String(page.file_path), /knowledge\/md\/legacy-page\.v1\.md$/);
  assert.equal(f.store.contentStore.readSync(page.content_ref as never).body, "legacy wiki");

  f.store.create("knowledge_claim", "secret-claim", { kind: "fact", content: "api_key: abcdefgh", evidence_ids: [] });
  assert.throws(() => migration.migrate(), /credentials|secrets/);
  assert.equal(f.store.rawRecords("knowledge_claim").find((item) => item.id === "secret-claim")!.payload.content, "api_key: abcdefgh");
  await f.store.close();
});

test("content migration resolves wiki defaults, legacy source fields, and primitive rollback errors", async () => {
  const f = await fixture();
  const migration = new ContentMigrationKernel(f.store);
  f.store.create("wiki_page", "wiki-default", { title: "Wiki", file_path: join(f.root, "wiki-default.md") });
  await writeFile(join(f.root, "wiki-default.md"), "wiki body", "utf8");
  f.store.create("memory_ledger", "source-only", { content: "memory body", source: "legacy-source", status: "active" });
  f.store.create("memory_ledger", "fallback-source", { content: "fallback body" });
  assert.equal(migration.migrate({ dry_run: true }).migrated, 3);
  const original = f.store.replacePayloadBatch.bind(f.store);
  f.store.replacePayloadBatch = (() => { throw "primitive failure"; }) as typeof f.store.replacePayloadBatch;
  assert.throws(() => migration.migrate(), /rolled back; database backup: .*; primitive failure/);
  f.store.replacePayloadBatch = original;
  await f.store.close();
});

test("content references reject metadata drift in canonical and legacy files", async () => {
  const f = await fixture();
  const content = f.store.contentStore;
  const canonical = await content.write({ kind: "knowledge", record_id: "metadata", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body" });
  const canonicalRaw = await readFile(canonical.path, "utf8");
  await writeFile(canonical.path, canonicalRaw.replace("record_version: 1", "record_version: 2"), "utf8");
  await assert.rejects(content.read(canonical), /metadata drifted/);
  assert.throws(() => content.readSync(canonical), /metadata drifted/);

  const legacy = content.legacyPathFor("memory", "legacy-metadata", 1);
  await mkdir(dirname(legacy), { recursive: true });
  const legacyRef = content.writeSync({ kind: "memory", record_id: "legacy-metadata", version: 1, scope: "task", status: "active", sensitivity: "internal", source_id: "source", body: "legacy" });
  const legacyRaw = readFileSync(legacyRef.path, "utf8");
  await writeFile(legacy, legacyRaw.replace('record_id: "legacy-metadata"', 'record_id: "wrong"'), "utf8");
  assert.throws(() => content.readCompatSync({ ...legacyRef, path: legacy }), /metadata drifted/);
  await writeFile(legacy, legacyRaw.replace('body_digest: "sha256:', 'body_digest: "sha256:wrong'), "utf8");
  assert.throws(() => content.readCompatSync({ ...legacyRef, path: legacy }), /digest drifted/);
  await f.store.close();
});

test("content migration rejects missing legacy bodies and reports database rollback", async () => {
  const f = await fixture();
  f.store.create("wiki_page", "missing-page", { title: "Missing", file_path: join(f.root, "does-not-exist.md") });
  assert.throws(() => new ContentMigrationKernel(f.store).migrate(), /ENOENT|no such file/);
  f.store.remove("wiki_page", "missing-page");
  f.store.create("memory_ledger", "rollback-memory", { content: "will not be attached" });
  const migration = new ContentMigrationKernel(f.store);
  const original = f.store.replacePayloadBatch.bind(f.store);
  f.store.replacePayloadBatch = (() => { throw new Error("simulated database failure"); }) as typeof f.store.replacePayloadBatch;
  assert.throws(() => migration.migrate(), /rolled back; database backup/);
  f.store.replacePayloadBatch = original;
  f.store.create("memory_ledger", "empty-memory", { scope: "task" });
  assert.throws(() => migration.migrate(), /no readable content body/);
  await f.store.close();
});

test("legacy consolidation memories also use Markdown references", async () => {
  const f = await fixture();
  const consolidation = new MemoryConsolidationKernel(f.store);
  const remembered = consolidation.remember({ memory_id: "episodic-1", scope: "task", content: "Observed a stable workflow", source: "test" });
  assert.equal(f.store.get("episodic_memory", "episodic-1").content, "Observed a stable workflow");
  const raw = f.store.rawRecords("episodic_memory")[0]!;
  assert.equal("content" in raw.payload, false);
  const consolidated = consolidation.consolidate({ memory_ids: ["episodic-1"], content: "Stable workflow summary" });
  assert.equal(f.store.get("semantic_memory", String((consolidated.memory as Record<string, unknown>).id)).content, "Stable workflow summary");
  assert.equal("content" in f.store.rawRecords("semantic_memory")[0]!.payload, false);
  await f.store.close();
});

test("knowledge memory runtime fails closed when a referenced body disappears", async () => {
  const f = await fixture();
  const source = f.service.knowledgeSourceRegister({ source_id: "source-runtime", kind: "custom", label: "runtime", scope_kind: "user", scope_id: "local", locator: "test://runtime", content_digest: "v1" }).source as Record<string, unknown>;
  const memory = f.service.memoryLedgerRemember({ memory_id: "runtime-memory", source_id: source.id, kind: "episodic", scope_kind: "user", scope_id: "local", content: "body" }).memory as Record<string, unknown>;
  await unlink(String((memory.content_ref as Record<string, unknown>).path));
  assert.throws(() => f.service.knowledgeMemory.get({ memory_id: "runtime-memory" }), /ENOENT|no such file|body/);
  f.store.create("memory_ledger", "missing-ref", { scope: "user:local", status: "active" });
  assert.throws(() => f.service.knowledgeMemory.get({ memory_id: "missing-ref" }), /reference is missing/);
  await f.store.close();
});

test("migration-only store payload replacement is transactional", async () => {
  const f = await fixture();
  f.store.create("legacy", "one", { content: "before" });
  f.store.replacePayload("legacy", "one", 1, { content: "after", version: 99 });
  assert.equal(f.store.get("legacy", "one").content, "after");
  f.store.replacePayloadBatch([]);
  assert.throws(() => f.store.replacePayload("legacy", "missing", 1, { value: true }), /Unknown record/);
  assert.throws(() => f.store.replacePayloadBatch([{ kind: "legacy", id: "one", version: 99, payload: { value: false } }]), /Unknown record/);
  assert.equal(f.store.get("legacy", "one").content, "after");
  await f.store.close();
});

test("content diagnostics are exposed through full and syscall MCP surfaces", async () => {
  const f = await fixture();
  const server = new McpServer(f.service, "full");
  const response = await server.handle({ id: 1, method: "tools/call", params: { name: "craft_content_status", arguments: {} } });
  assert.equal((response?.result as Record<string, unknown>).isError, false);
  const verify = await server.handle({ id: 3, method: "tools/call", params: { name: "craft_content_verify", arguments: {} } });
  assert.equal((verify?.result as Record<string, unknown>).isError, false);
  const migrate = await server.handle({ id: 4, method: "tools/call", params: { name: "craft_content_migrate", arguments: { dry_run: true } } });
  assert.equal((migrate?.result as Record<string, unknown>).isError, false);
  const syscall = new McpServer(f.service, "syscall");
  const listed = await syscall.handle({ id: 2, method: "tools/call", params: { name: "craft_list", arguments: { resource: "knowledge_claim" } } });
  assert.equal((listed?.result as Record<string, unknown>).isError, false);
  await f.store.close();
});

test("Wiki compatibility reads and refreshes cover canonical, legacy, and drifted files", async () => {
  const f = await fixture();
  const created = await f.service.wikiPageSave({ page_id: "wiki-compat", title: "Compat", body: "first", scope: "global" });
  const page = created.page as Record<string, unknown>;
  await f.service.wikiPageSave({ page_id: "wiki-compat", title: "Compat", body: "second", scope: "global" });
  assert.equal((f.service.wikiPageGet({ page_id: "wiki-compat" }) as Record<string, unknown>).body, "second");
  const saved = f.store.get("wiki_page", "wiki-compat");
  f.store.save("wiki_page", "wiki-compat", { ...saved, body_digest: "sha256:wrong", identity_digest: null });
  await assert.rejects(f.service.wikiPageSave({ page_id: "wiki-compat", title: "Compat", body: "third", scope: "global" }), /unrecorded changes/);

  const fallbackPath = join(f.root, "wiki-fallback.md");
  await writeFile(fallbackPath, "plain fallback", "utf8");
  f.store.save("wiki_page", "wiki-compat", { ...f.store.get("wiki_page", "wiki-compat"), file_path: fallbackPath,
    content_ref: { kind: "knowledge", record_id: "wiki-compat", version: 2, path: join(f.root, "missing-ref.md"), digest: "sha256:missing", bytes: 1, format: "markdown" }, body_digest: "sha256:plain" });
  assert.equal((f.service.wikiPageGet({ page_id: "wiki-compat" }) as Record<string, unknown>).body, "plain fallback");
  assert.equal((f.service.wikiPageRefresh({ page_id: "wiki-compat" }) as Record<string, unknown>).changed, true);

  const noFilePath = f.store.create("wiki_page", "wiki-no-file", { title: "No file", scope: "global", content_ref: { ...(page.content_ref as Record<string, unknown>), path: join(f.root, "missing-no-file.md") }, body_digest: page.body_digest });
  assert.throws(() => f.service.wikiPageRefresh({ page_id: "wiki-no-file" }), /ENOENT|no such file|frontmatter/);

  const legacyPath = join(f.root, "legacy-save.md");
  await writeFile(legacyPath, "legacy old", "utf8");
  f.store.create("wiki_page", "legacy-save", { title: "Legacy", file_path: legacyPath, body_digest: digest("legacy old"), identity_digest: null, scope: "global" });
  assert.equal((f.service.wikiPageGet({ page_id: "legacy-save" }) as Record<string, unknown>).body, "legacy old");
  await f.service.wikiPageSave({ page_id: "legacy-save", title: "Legacy", body: "legacy new", scope: "global" });
  const missingLegacy = join(f.root, "missing-legacy-save.md");
  f.store.create("wiki_page", "missing-legacy-save", { title: "Missing", file_path: missingLegacy, body_digest: digest("old"), identity_digest: null, scope: "global" });
  await assert.rejects(f.service.wikiPageSave({ page_id: "missing-legacy-save", title: "Missing", body: "new", scope: "global" }), /unrecorded changes/);
  const refreshPath = join(f.root, "refresh-legacy.md");
  await writeFile(refreshPath, "refresh body", "utf8");
  f.store.create("wiki_page", "refresh-legacy", { title: "Refresh", file_path: refreshPath, body_digest: digest("old"), identity_digest: null });
  assert.equal((f.service.wikiPageRefresh({ page_id: "refresh-legacy" }) as Record<string, unknown>).changed, true);
  await f.store.close();
});
