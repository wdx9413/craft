import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths, projectStorageDirectory } from "../core/infrastructure/paths.ts";
import { MarkdownContentStore } from "../common/craft-common-store-local/src/content-store.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-knowledge-partition-"));
  const project = join(root, "project"); mkdirSync(project);
  const paths = craftPaths(join(root, "global")); const store = await new CraftStore(paths).open();
  store.create("scope_alias", "project", { scope: { kind: "project", id: "demo" }, alias_kind: "path", alias: project, status: "active" });
  return { root, project, paths, store };
}
function cleanup(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); rmSync(f.root, { recursive: true, force: true }); }
function sharedPayloads(store: CraftStore, kinds: string[]) {
  return store.database.prepare("SELECT payload_json FROM records WHERE kind IN (SELECT value FROM json_each(?))").all(JSON.stringify(kinds)).map(row => String(row.payload_json));
}

test("Knowledge candidates, task evidence and evaluations stay in their project capability database", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_source", "source", { scope: { kind: "project", id: "demo" }, status: "active", title: "private source title" });
    f.store.create("knowledge_claim", "claim", { scope: "project:demo", source_id: "source", content: "private claim text", status: "candidate" });
    f.store.create("knowledge_evaluation_case", "case", { scope: "project:demo", query: "private task query", expected_claim_ids: ["claim"] });
    f.store.create("knowledge_evaluation_run", "run", { case_ids: ["case"], results: [{ output: "private evaluation result" }] });
    f.store.create("evidence", "fragment-evidence", { source_type: "knowledge_fragment", source_id: "source", claim: "private task evidence" });
    const kinds = ["knowledge_source", "knowledge_claim", "knowledge_evaluation_case", "knowledge_evaluation_run", "evidence"];
    for (const kind of kinds) assert.equal(sharedPayloads(f.store, [kind]).some(row => row.includes("private ")), false, kind);
    assert.equal(existsSync(join(projectStorageDirectory(f.paths, f.project), "knowledge", "knowledge.db")), true);
    assert.equal(f.store.get("knowledge_claim", "claim").content, "private claim text");
    assert.equal(f.store.get("knowledge_evaluation_case", "case").query, "private task query");
    assert.equal(f.store.get("evidence", "fragment-evidence").claim, "private task evidence");
    assert.equal(f.store.listScoped("knowledge_claim", [{ kind: "project", id: "other" }], 10).length, 0);
    const reopened = await new CraftStore(f.paths).open();
    try { assert.deepEqual(reopened.get("knowledge_evaluation_run", "run").results, [{ output: "private evaluation result" }]); }
    finally { reopened.close(); }
  } finally { cleanup(f); }
});

test("Knowledge storage reconciliation facade validates and forwards bounded paging", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const preview = service.knowledgeStorageReconcile({ max_records: 1, dry_run: true });
    assert.equal(preview.dry_run, true);
    assert.equal(Number(preview.examined), 0);
    assert.throws(() => service.knowledgeStorageReconcile({ dry_run: "yes" as never }), /dry_run must be boolean/u);
    assert.throws(() => service.knowledgeStorageReconcile({ max_records: 501 }), /max_records/u);
    assert.throws(() => service.knowledgeStorageReconcile({ cursor: "!" }), /cursor is invalid/u);
  } finally { cleanup(f); }
});

test("Knowledge bulk writes use partition routing and roll back unpublished partition rows", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_source", "source", { scope: "global", title: "private source" });
    f.store.createBatch([{ kind: "knowledge_claim", id: "one", payload: { scope: "global", source_id: "source", content: "private first" } }]);
    f.store.saveBatch([{ kind: "knowledge_claim", id: "one", payload: { scope: "global", source_id: "source", content: "private second" } }]);
    assert.equal(sharedPayloads(f.store, ["knowledge_claim"]).some(row => row.includes("private ")), false);
    assert.equal(f.store.get("knowledge_claim", "one").version, 2);
    assert.throws(() => f.store.createBatch([
      { kind: "knowledge_claim", id: "rollback", payload: { scope: "global", source_id: "source", content: "private rollback" } },
      { kind: "knowledge_claim", id: "one", payload: { scope: "global", content: "duplicate" } },
    ]), /already exists/u);
    assert.equal(f.store.find("knowledge_claim", "rollback"), null);
    const partition = new DatabaseSync(f.paths.knowledgeDatabaseFile, { readOnly: true });
    try { assert.equal(Number(partition.prepare("SELECT COUNT(*) count FROM records WHERE kind='knowledge_claim' AND id='rollback'").get()!.count), 0); }
    finally { partition.close(); }
  } finally { cleanup(f); }
});

test("Knowledge derives artifact custody from parents while template configuration stays global", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_source", "source", { scope: "project:demo", status: "active" });
    f.store.create("knowledge_document", "doc", { source_id: "source", path: "private document path" });
    f.store.create("knowledge_claim", "claim", { scope: "project:demo", source_id: "source", content: "private claim" });
    f.store.create("knowledge_host_review", "review", { claim_id: "claim", source_id: "source", reason: "private review reason" });
    f.store.create("evidence", "review-evidence", { source_type: "host_model_review", claim: "private review evidence",
      metadata: { review_id: "knowledge_host_review_test", source_id: "source" } });
    for (const kind of ["knowledge_document", "knowledge_host_review", "evidence"]) {
      assert.equal(sharedPayloads(f.store, [kind]).some(row => row.includes("private ")), false);
    }
    assert.throws(() => f.store.create("knowledge_host_review", "unbound", { claim_id: "missing", reason: "must not default global" }), /parent is unavailable/u);
    f.store.create("knowledge_source", "builtin.serena-project-knowledge", { kind: "serena", locator: ".serena/memories", scope: { kind: "project", id: "selected-project" } });
    assert.throws(() => f.store.create("knowledge_document", "unbound-template-data", { source_id: "builtin.serena-project-knowledge", path: "actual data" }), /Project Knowledge storage root is not registered/u);
    f.store.create("knowledge_claim", "legacy", { scope: "legacy:shared:shared", content: "private legacy candidate", status: "candidate" });
    assert.equal(f.store.get("knowledge_claim", "legacy").scope, "legacy:shared:shared");
    assert.equal(f.store.listScoped("knowledge_claim", [{ kind: "global", id: "global" }], 10).length, 0);
  } finally { cleanup(f); }
});

test("Knowledge migration is bounded, repeatable and leaves unavailable projects explicit", async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    for (const [id, scope] of [["known", "project:demo"], ["unknown", "project:missing"]]) {
      f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('knowledge_claim',?,1,?,?,?)")
        .run(id, JSON.stringify({ scope, content: `private legacy ${id}`, status: "candidate" }), now, now);
    }
    const preview = f.store.reconcileKnowledgeStorage({ max_records: 1, dry_run: true });
    assert.equal(preview.migratable, 1); assert.equal(preview.migrated, 0); assert.equal(preview.has_more, true);
    assert.equal(sharedPayloads(f.store, ["knowledge_claim"]).some(row => row.includes("private legacy known")), true);
    const moved = f.store.reconcileKnowledgeStorage({ max_records: 1 });
    assert.equal(moved.migrated, 1); assert.equal(moved.has_more, true);
    assert.equal(f.store.get("knowledge_claim", "known").content, "private legacy known");
    const remaining = f.store.reconcileKnowledgeStorage({ cursor: String(moved.next_cursor), max_records: 1 });
    assert.equal(remaining.migrated, 0); assert.equal((remaining.blocked as JsonObject[])[0]?.reason, "storage_scope_unavailable");
    const repeated = f.store.reconcileKnowledgeStorage();
    assert.equal(repeated.migrated, 0); assert.equal((repeated.blocked as JsonObject[]).length, 1);
    const backupDir = join(projectStorageDirectory(f.paths, f.project), "knowledge", "backups");
    assert.equal(existsSync(backupDir), true);
    for (const max_records of [0, -1, 501, 1.5]) assert.throws(() => f.store.reconcileKnowledgeStorage({ max_records }), /max_records/u);
    for (const cursor of ["!", "e30", Buffer.from('[1,2,3]').toString("base64url")]) assert.throws(() => f.store.reconcileKnowledgeStorage({ cursor }), /cursor is invalid/u);
  } finally { cleanup(f); }
});

function legacyBody(f: Awaited<ReturnType<typeof fixture>>, id = "legacy-body", scope = "project:demo") {
  return new MarkdownContentStore(f.paths).writeSync({ kind: "knowledge", record_id: id, version: 1,
    scope, status: "candidate", sensitivity: "internal", source_id: "source", body: "项目专属的可验证知识。", title: id });
}
function legacyClaim(f: Awaited<ReturnType<typeof fixture>>, ref: ReturnType<typeof legacyBody>) {
  const now = new Date().toISOString();
  f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('knowledge_claim',?,1,?,?,?)")
    .run(ref.record_id, JSON.stringify({ scope: ref.scope, content_ref: ref, status: "candidate" }), now, now);
}

test("Knowledge migration backs up original Markdown in the project before retiring shared copies", async () => {
  const f = await fixture();
  try {
    const ref = legacyBody(f); legacyClaim(f, ref);
    const raw = readFileSync(ref.path, "utf8");
    const moved = f.store.reconcileKnowledgeStorage();
    assert.equal(moved.phase, "records"); assert.equal(moved.migrated, 1);
    assert.equal(existsSync(ref.path), true);
    const nextRef = f.store.get("knowledge_claim", ref.record_id).content_ref as typeof ref;
    assert.equal(nextRef.path.startsWith(join(projectStorageDirectory(f.paths, f.project), "knowledge", "md") + "/"), true);
    assert.equal(readFileSync(nextRef.path, "utf8"), raw);
    const preview = f.store.reconcileKnowledgeStorage({ cursor: String(moved.next_cursor), dry_run: true });
    assert.equal(preview.phase, "content"); assert.equal(preview.migratable, 1); assert.equal(preview.retired_content, 0);
    assert.equal(existsSync(ref.path), true);
    const finished = f.store.reconcileKnowledgeStorage({ cursor: String(moved.next_cursor) });
    assert.equal(finished.retired_content, 1); assert.equal(finished.has_more, false);
    assert.equal(existsSync(ref.path), false); assert.equal(readFileSync(nextRef.path, "utf8"), raw);
    const backups = join(projectStorageDirectory(f.paths, f.project), "knowledge", "backups");
    const snapshots = readdirSync(backups).flatMap(name => JSON.parse(readFileSync(join(backups, name), "utf8")).content_snapshots ?? []);
    assert.equal(snapshots.some(item => item.path === ref.path && item.markdown === raw && /^sha256:/u.test(item.digest)), true);
    assert.equal(f.store.reconcileKnowledgeStorage().retired_content, 0);
  } finally { cleanup(f); }
});

test("Knowledge migration isolates one invalid content path without blocking a valid claim in the same project", async () => {
  const f = await fixture();
  try {
    const valid = legacyBody(f, "valid-claim"), invalid = legacyBody(f, "invalid-claim");
    const foreign = join(f.project, "foreign.md");
    writeFileSync(foreign, readFileSync(invalid.path));
    legacyClaim(f, valid);
    legacyClaim(f, { ...invalid, path: foreign });
    const result = f.store.reconcileKnowledgeStorage({ max_records: 10 });
    assert.equal(result.migrated, 1);
    assert.deepEqual((result.blocked as JsonObject[]).map(item => item.failure_kind), ["content_path_out_of_scope"]);
    assert.equal(String((f.store.get("knowledge_claim", valid.record_id).content_ref as JsonObject).path).startsWith(f.paths.root), true);
    const blockedRow = f.store.database.prepare("SELECT payload_json FROM records WHERE kind='knowledge_claim' AND id=?")
      .get(invalid.record_id) as { payload_json: string };
    assert.equal(JSON.parse(blockedRow.payload_json).content_ref.path, foreign);
  } finally { cleanup(f); }
});

test("Knowledge content retirement recovers after copy and backup without deleting referenced or foreign content", async t => {
  const f = await fixture();
  try {
    const ref = legacyBody(f), global = legacyBody(f, "global-body", "global");
    const interrupted = t.mock.method(f.store, "transaction", () => { throw new Error("simulated interruption before retirement"); });
    const first = f.store.reconcileKnowledgeStorage();
    assert.equal(first.retired_content, 0); assert.equal((first.blocked as JsonObject[]).length, 1);
    assert.equal(existsSync(ref.path), true);
    interrupted.mock.restore();
    const retry = f.store.reconcileKnowledgeStorage();
    assert.equal(retry.retired_content, 1); assert.equal(retry.skipped, 1);
    assert.equal(existsSync(ref.path), false); assert.equal(existsSync(global.path), true);
    const referenced = legacyBody(f, "referenced"); legacyClaim(f, referenced);
    const contentCursor = Buffer.from(JSON.stringify(["content_scan", "", 1])).toString("base64url");
    const pending = f.store.reconcileKnowledgeStorage({ cursor: contentCursor });
    assert.equal((pending.blocked as JsonObject[]).some(item => item.reason === "legacy_content_still_referenced"), true);
    assert.equal(existsSync(referenced.path), true);
  } finally { cleanup(f); }
});

test("Knowledge content cleanup is paginated and refuses symlinks, missing scopes and drifted bodies", async () => {
  const f = await fixture();
  try {
    const refs = [legacyBody(f, "alpha"), legacyBody(f, "bravo"), legacyBody(f, "missing", "project:unregistered")];
    writeFileSync(refs[1]!.path, readFileSync(refs[1]!.path, "utf8").replace("项目专属的可验证知识。", "正文已被改动。"));
    symlinkSync(refs[0]!.path, join(f.paths.knowledgeContentDir, "unsafe.md"));
    writeFileSync(join(f.paths.knowledgeContentDir, "invalid.md"), "invalid frontmatter");
    let cursor: string | undefined; let examined = 0, retired = 0, blocked = 0;
    do {
      const result = f.store.reconcileKnowledgeStorage({ max_records: 1, ...(cursor ? { cursor } : {}) });
      assert.equal(result.phase, "content"); examined += Number(result.examined); retired += Number(result.retired_content);
      blocked += (result.blocked as JsonObject[]).length;
      cursor = result.has_more ? String(result.next_cursor) : undefined;
    } while (cursor);
    assert.equal(examined, 5); assert.equal(retired, 1); assert.equal(blocked, 4);
    assert.equal(existsSync(refs[1]!.path), true); assert.equal(existsSync(refs[2]!.path), true);
    const invalid = Buffer.from(JSON.stringify(["content_scan", "", 2])).toString("base64url");
    assert.throws(() => f.store.reconcileKnowledgeStorage({ cursor: invalid }), /cursor is invalid/u);
  } finally { cleanup(f); }
});

test("Knowledge retirement refuses references and file changes introduced after backup", async t => {
  const f = await fixture();
  try {
    const ref = legacyBody(f);
    const internals = f.store as unknown as { writeLegacyPartitionBackup: (...args: unknown[]) => void };
    const original = internals.writeLegacyPartitionBackup.bind(f.store);
    const referenceRace = t.mock.method(internals, "writeLegacyPartitionBackup", (...args: unknown[]) => {
      original(...args); legacyClaim(f, ref);
    });
    const blocked = f.store.reconcileKnowledgeStorage();
    assert.equal((blocked.blocked as JsonObject[]).length, 1); assert.equal(existsSync(ref.path), true);
    referenceRace.mock.restore();
    const migrated = f.store.reconcileKnowledgeStorage();
    assert.equal(migrated.migrated, 1);
    const raw = readFileSync(ref.path, "utf8");
    const fileRace = t.mock.method(internals, "writeLegacyPartitionBackup", (...args: unknown[]) => {
      original(...args); writeFileSync(ref.path, raw.replace("项目专属的可验证知识。", "并发编辑后的内容。"));
    });
    const changed = f.store.reconcileKnowledgeStorage({ cursor: String(migrated.next_cursor) });
    assert.equal(changed.retired_content, 0); assert.equal(existsSync(ref.path), true);
    fileRace.mock.restore();
    writeFileSync(ref.path, raw);
    assert.equal(f.store.reconcileKnowledgeStorage({ cursor: String(migrated.next_cursor) }).retired_content, 1);
  } finally { cleanup(f); }
});

test("Knowledge retirement refuses unsafe directories and oversized content", async () => {
  const f = await fixture();
  try {
    const ref = legacyBody(f); truncateSync(ref.path, 8 * 1024 * 1024 + 1);
    const result = f.store.reconcileKnowledgeStorage();
    assert.equal(result.retired_content, 0); assert.equal((result.blocked as JsonObject[]).length, 1);
    const original = f.paths.knowledgeContentDir + "-original";
    renameSync(f.paths.knowledgeContentDir, original); symlinkSync(original, f.paths.knowledgeContentDir);
    assert.throws(() => f.store.reconcileKnowledgeStorage(), /directory must be regular/u);
  } finally { cleanup(f); }
});

test("Knowledge migration leaves Core Evidence alone and accepts legacy Markdown without titles", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "core", { source_type: "tool", claim: "owned by Core" });
    const page = f.store.reconcileKnowledgeStorage();
    assert.equal(page.phase, "records"); assert.equal(page.skipped, 1); assert.equal(page.migrated, 0);
    const ref = legacyBody(f);
    writeFileSync(ref.path, readFileSync(ref.path, "utf8").replace(/^title:.*\n/mu, ""));
    assert.equal(f.store.reconcileKnowledgeStorage({ cursor: String(page.next_cursor) }).retired_content, 1);
    const emptyConfirmation = f.store.create("memory_confirmation", "missing-memory", {});
    assert.deepEqual(emptyConfirmation.scope, { kind: "global", id: "global" });
  } finally { cleanup(f); }
});

test("Knowledge scope inheritance covers catalogs, references, relations and explicit capability Evidence", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_source", "source", { scope: "project:demo" });
    f.store.create("knowledge_document", "doc", { source_id: "source" });
    f.store.create("knowledge_claim", "claim", { scope: "project:demo" });
    f.store.create("wiki_skill_candidate", "candidate", { scope: "project:demo" });
    f.store.create("evidence", "core", { metadata: "not an owner", claim: "core coordination evidence" });
    const forms = [
      { metadata: { scope: "project:demo" } }, { project_scope_id: "project:demo" }, { metadata: { project_scope_id: "project:demo" } },
      { project_id: "demo" }, { document_id: "doc" }, { claim_ids: ["claim"] }, { claim_refs: [{ claim_id: "claim" }, { id: "claim" }] },
      { source: { kind: "knowledge_source", id: "source" }, target: { kind: "evidence", id: "core" } },
      { source: { kind: "unrelated", id: "ignored" }, target: [] },
    ];
    for (const [i, payload] of forms.entries()) {
      f.store.create("knowledge_relation", `relation-${i}`, payload);
      const header = JSON.parse(String(f.store.database.prepare("SELECT payload_json FROM records WHERE kind='knowledge_relation' AND id=?").get(`relation-${i}`)!.payload_json));
      assert.equal(header.scope.kind, i === forms.length - 1 ? "global" : "project");
    }
    f.store.create("wiki_candidate_review", "review", { candidate_id: "candidate" });
    assert.deepEqual(JSON.parse(String(f.store.database.prepare("SELECT payload_json FROM records WHERE kind='wiki_candidate_review' AND id='review'").get()!.payload_json)).scope, { kind: "project", id: "demo" });
    for (const owner of ["knowledge", "memory", "experience"]) {
      f.store.create("evidence", owner, { metadata: { capability_owner: owner, scope: "project:demo" }, claim: "owned evidence" });
      assert.equal(sharedPayloads(f.store, ["evidence"]).some(raw => raw.includes('"claim":"owned evidence"')), false);
    }
    f.store.create("knowledge_claim", "other", { scope: "global" });
    f.store.create("knowledge_claim", "session", { scope: "session:independent-task" });
    assert.throws(() => f.store.create("knowledge_relation", "mixed", { claim_ids: ["claim", "session"] }), /different storage scopes/u);
    const duplicate = join(f.root, "duplicate"); mkdirSync(duplicate);
    f.store.create("scope_alias", "duplicate", { scope: { kind: "project", id: "demo" }, alias_kind: "path", alias: duplicate, status: "active" });
    assert.throws(() => f.store.create("knowledge_claim", "ambiguous", { scope: "project:demo" }), /root is ambiguous/u);
    assert.throws(() => f.store.contentStore.writeSync({ kind: "knowledge", record_id: "ambiguous", version: 1, scope: "project:demo", status: "candidate", sensitivity: "internal", source_id: "s", body: "ambiguous" }), /registered project root/u);
  } finally { cleanup(f); }
});

test("Knowledge migration rejects partition collisions and lost compare-and-swap without removing legacy content", async t => {
  const f = await fixture();
  try {
    const ref = legacyBody(f); legacyClaim(f, ref);
    const transaction = f.store.transaction.bind(f.store);
    const raced = t.mock.method(f.store, "transaction", (operation: Parameters<CraftStore["transaction"]>[0]) => {
      f.store.database.prepare("UPDATE records SET payload_json=json_set(payload_json,'$.concurrent',true) WHERE kind='knowledge_claim' AND id=?").run(ref.record_id);
      return transaction(operation);
    });
    const first = f.store.reconcileKnowledgeStorage();
    assert.equal(first.migrated, 0); assert.equal((first.blocked as JsonObject[])[0]?.reason, "partition_migration_failed");
    assert.equal(existsSync(ref.path), true); raced.mock.restore();
    const second = f.store.reconcileKnowledgeStorage();
    assert.equal(second.migrated, 0, "a different unpublished partition payload must not be overwritten");
    const current = JSON.parse(String(f.store.database.prepare("SELECT payload_json FROM records WHERE id=?").get(ref.record_id)!.payload_json));
    delete current.concurrent;
    f.store.database.prepare("UPDATE records SET payload_json=? WHERE kind='knowledge_claim' AND id=?").run(JSON.stringify(current), ref.record_id);
    const third = f.store.reconcileKnowledgeStorage(); assert.equal(third.migrated, 1);
    const file = join(projectStorageDirectory(f.paths, f.project), "knowledge", "knowledge.db");
    const partition = new DatabaseSync(file);
    try { partition.prepare("DELETE FROM records WHERE kind='knowledge_claim' AND id=?").run(ref.record_id); }
    finally { partition.close(); }
    assert.throws(() => f.store.get("knowledge_claim", ref.record_id), /Knowledge partition record is missing/u);
    assert.throws(() => f.store.findMany("knowledge_claim", [ref.record_id]), /Knowledge partition record is missing/u);
    assert.throws(() => f.store.reconcileKnowledgeStorage({ dry_run: "yes" as never }), /dry_run must be boolean/u);
  } finally { cleanup(f); }
});

test("Knowledge migration classifies recoverable and unexpected backup failures", async t => {
  const cases: Array<{ error: unknown; failureKind: string }> = [
    { error: new Error("database is locked"), failureKind: "write_lock" },
    { error: new Error("Content reference path is outside the canonical directory"), failureKind: "content_path_out_of_scope" },
    { error: new Error("version collision"), failureKind: "version_collision" },
    { error: new Error("scope validation failed"), failureKind: "scope_validation" },
    { error: new Error("content manifest digest is invalid"), failureKind: "content_validation" },
    { error: new Error("ENOENT: no such file"), failureKind: "source_missing" },
    { error: new Error("unexpected filesystem failure"), failureKind: "other" },
    { error: "non-Error failure", failureKind: "other" },
  ];
  for (const [index, { error, failureKind }] of cases.entries()) {
    const f = await fixture();
    try {
      const ref = legacyBody(f, `failed-backup-${index}`);
      legacyClaim(f, ref);
      const internals = f.store as unknown as { writeLegacyPartitionBackup: (...args: unknown[]) => void };
      const failure = t.mock.method(internals, "writeLegacyPartitionBackup", () => { throw error; });
      const result = f.store.reconcileKnowledgeStorage();
      assert.equal(result.migrated, 0);
      assert.deepEqual((result.blocked as JsonObject[]).map(item => item.failure_kind), [failureKind]);
      assert.equal(existsSync(ref.path), true, "a failed backup must leave the source body intact");
      failure.mock.restore();
    } finally { cleanup(f); }
  }
});
