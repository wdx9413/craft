import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("project partitions fail closed when one real root is bound to different project scopes", async () => {
  const f = await fixture();
  try {
    const link = join(f.root, "project-link"); symlinkSync(f.project, link);
    f.store.create("scope_alias", "same-scope", { scope: { kind: "project", id: "project:demo" }, alias_kind: "path", alias: link, status: "active" });
    f.store.create("scope_alias", "inactive-other", { scope: { kind: "project", id: "other" }, alias_kind: "path", alias: f.project, status: "inactive" });
    f.store.create("scope_alias", "bad-digest", { scope: { kind: "project", id: "other" }, alias_kind: "path", alias: f.project, alias_digest: "invalid", status: "active" });
    f.store.create("scope_alias", "missing-other", { scope: { kind: "project", id: "ghost" }, alias_kind: "path", alias: join(f.root, "missing"), status: "active" });
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('scope_alias','malformed',1,'{','now','now')").run();
    f.store.create("knowledge_claim", "before-conflict", { scope: "project:demo", status: "candidate" });
    f.store.create("scope_alias", "other-scope", { scope: { kind: "project", id: "other" }, alias_kind: "path", alias: link, status: "active" });
    assert.throws(() => f.store.create("knowledge_claim", "cross-scope", { scope: "project:demo", status: "candidate" }), /PROJECT_SCOPE_CONFLICT/u);
    assert.throws(() => f.store.create("knowledge_claim", "cross-scope-other", { scope: "project:other", status: "candidate" }), /PROJECT_SCOPE_CONFLICT/u);
  } finally { cleanup(f); }
});

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
    assert.equal(service.knowledgeStorageReconcile({ max_records: 1, dry_run: true, summary_only: true }).summary_only, true);
    assert.throws(() => service.knowledgeStorageReconcile({ dry_run: "yes" as never }), /dry_run must be boolean/u);
    assert.throws(() => service.knowledgeStorageReconcile({ summary_only: "yes" as never }), /summary_only must be boolean/u);
    assert.throws(() => f.store.reconcileKnowledgeStorage({ summary_only: "yes" as never }), /summary_only must be boolean/u);
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

test("Knowledge refuses to infer global storage when neither the record nor its parents declare a scope", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.store.create("knowledge_claim", "unscoped", { content: "must not become global" }), /Knowledge storage scope is unavailable/u);
    assert.throws(() => f.store.create("knowledge_claim", "null-scope", { scope: null, content: "must not become global" }), /Knowledge storage scope is unavailable/u);
    assert.throws(() => new CraftService(f.store).knowledgeClaimSave({ kind: "fact", content: "must declare scope", evidence_ids: [] }), /scope/u);
    f.store.create("knowledge_claim", "scoped-claim", { scope: "project:demo", content: "scoped parent" });
    const now = new Date().toISOString();
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("knowledge_source", "unscoped-parent", 1, JSON.stringify({ title: "legacy parent without a scope" }), now, now);
    assert.throws(() => f.store.create("knowledge_document", "unscoped-child", { source_id: "unscoped-parent", path: "document" }),
      /Knowledge storage scope is unavailable/u);

    f.store.create("knowledge_evaluation_case", "global-case", { scope: "global", query: "global query" });
    f.store.create("knowledge_evaluation_run", "global-run", { case_ids: ["global-case"], results: [] });
    const globalRun = JSON.parse(String(f.store.database.prepare("SELECT payload_json FROM records WHERE kind='knowledge_evaluation_run' AND id='global-run'").get()!.payload_json));
    assert.deepEqual(globalRun._knowledge_partition.scope, { kind: "global", id: "global" });
    f.store.create("knowledge_source", "global-source", { scope: "global", title: "global source" });
    f.store.create("knowledge_source", "user-source", { scope: "user:principal", title: "user source" });
    f.store.create("knowledge_claim", "global-child", { scope: "global", source_id: "global-source", content: "global child" });
    f.store.create("knowledge_claim", "project-from-global", { scope: "project:demo", source_id: "global-source", content: "project child" });
    assert.throws(() => f.store.create("knowledge_relation", "explicit-global-over-project", {
      scope: "global", claim_ids: ["scoped-claim"],
    }), /different storage scopes/u);
    f.store.create("knowledge_relation", "explicit-project-match", { scope: "project:demo", claim_ids: ["scoped-claim"] });
    f.store.create("knowledge_relation", "project-child-from-global", { scope: "project:demo", claim_ids: ["global-child"] });
    assert.throws(() => f.store.create("knowledge_relation", "mixed-neutral-scopes", {
      source: { kind: "knowledge_source", id: "global-source" }, target: { kind: "knowledge_source", id: "user-source" },
    }), /different storage scopes/u);
    assert.throws(() => f.store.create("knowledge_relation", "mixed-project-user-scopes", {
      from_claim_id: "scoped-claim", source: { kind: "knowledge_source", id: "user-source" },
    }), /different storage scopes/u);
    const ownedEvidence = f.store.create("evidence", "owned-evidence", {
      source_type: "knowledge_fragment", metadata: { capability_owner: "knowledge", scope: "project:demo" }, claim: "scoped evidence",
    });
    f.store.create("knowledge_relation", "evidence-scope", {
      candidate_claim_refs: [{ id: "scoped-claim" }], evidence_ids: [ownedEvidence.id], evidence_id: ownedEvidence.id,
    });
    const evidenceHeader = JSON.parse(String(f.store.database.prepare("SELECT payload_json FROM records WHERE kind='knowledge_relation' AND id='evidence-scope'").get()!.payload_json));
    assert.deepEqual(evidenceHeader._knowledge_partition.scope, { kind: "project", id: "demo" });
  } finally { cleanup(f); }
});

test("existing Knowledge can be withdrawn after its source is removed", async () => {
  const f = await fixture();
  try {
    f.store.create("knowledge_source", "withdrawal-source", { scope: "project:demo", status: "active" });
    f.store.create("knowledge_claim", "withdrawal-claim", {
      scope: "project:demo", source_id: "withdrawal-source", status: "active", content: "retire after source removal",
    });
    f.store.remove("knowledge_source", "withdrawal-source");
    const withdrawn = f.store.save("knowledge_claim", "withdrawal-claim", {
      scope: "project:demo", source_id: "withdrawal-source", status: "withdrawn", content: "retire after source removal",
    });
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(f.store.get("knowledge_claim", "withdrawal-claim").version, 2);
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
    assert.equal((remaining.blocked as JsonObject[])[0]?.failure_kind, "project_root_missing");
    assert.equal((remaining.blocked as JsonObject[])[0]?.failure_phase, "scope_resolution");
    const compact = f.store.reconcileKnowledgeStorage({ max_records: 2, dry_run: true, summary_only: true });
    assert.equal(compact.blocked_count, 1); assert.deepEqual(compact.blocked, []);
    assert.deepEqual(compact.blocked_reasons, { storage_scope_unavailable: 1 });
    assert.deepEqual(compact.blocked_failure_kinds, { project_root_missing: 1 });
    assert.equal(JSON.stringify(compact).includes("private legacy unknown"), false);
    const repeated = f.store.reconcileKnowledgeStorage();
    assert.equal(repeated.migrated, 0); assert.equal((repeated.blocked as JsonObject[]).length, 1);
    const backupDir = join(projectStorageDirectory(f.paths, f.project), "knowledge", "backups");
    assert.equal(existsSync(backupDir), true);
    for (const max_records of [0, -1, 501, 1.5]) assert.throws(() => f.store.reconcileKnowledgeStorage({ max_records }), /max_records/u);
    for (const cursor of ["!", "e30", Buffer.from('[1,2,3]').toString("base64url")]) assert.throws(() => f.store.reconcileKnowledgeStorage({ cursor }), /cursor is invalid/u);
  } finally { cleanup(f); }
});

test("records-only Knowledge migration paginates without entering content retirement", async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    for (const [id, scope] of [["known", "project:demo"], ["unknown", "project:missing"]]) {
      f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('knowledge_claim',?,1,?,?,?)")
        .run(id, JSON.stringify({ scope, content: id }), now, now);
    }
    assert.throws(() => f.store.reconcileKnowledgeStorage({ records_only: "yes" as never }), /records_only must be boolean/u);
    const contentCursor = Buffer.from(JSON.stringify(["content_scan", "", 1])).toString("base64url");
    assert.throws(() => f.store.reconcileKnowledgeStorage({ records_only: true, cursor: contentCursor }), /cursor is invalid/u);
    const first = f.store.reconcileKnowledgeStorage({ records_only: true, max_records: 1 });
    assert.equal(first.migrated, 1); assert.equal(first.has_more, true);
    const second = f.store.reconcileKnowledgeStorage({ records_only: true, max_records: 1, cursor: String(first.next_cursor) });
    assert.equal(second.status, "partial"); assert.equal(second.has_more, false); assert.equal(second.next_cursor, null);
    assert.equal((second.blocked as JsonObject[]).length, 1);
    f.store.database.prepare("DELETE FROM records WHERE kind='knowledge_claim' AND id='unknown'").run();
    const empty = f.store.reconcileKnowledgeStorage({ records_only: true });
    assert.equal(empty.status, "completed"); assert.equal(empty.has_more, false);
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
    const compact = f.store.reconcileKnowledgeStorage({ cursor: contentCursor, dry_run: true, summary_only: true });
    assert.equal(compact.blocked_count, 1); assert.deepEqual(compact.blocked, []);
    assert.deepEqual(compact.blocked_reasons, { legacy_content_still_referenced: 1 });
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
    ];
    for (const [i, payload] of forms.entries()) {
      f.store.create("knowledge_relation", `relation-${i}`, payload);
      const header = JSON.parse(String(f.store.database.prepare("SELECT payload_json FROM records WHERE kind='knowledge_relation' AND id=?").get(`relation-${i}`)!.payload_json));
      assert.equal(header.scope.kind, "project");
    }
    assert.throws(() => f.store.create("knowledge_relation", "unbound-relation", { source: { kind: "unrelated", id: "ignored" }, target: [] }),
      /Knowledge storage scope is unavailable/u);
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

test("Knowledge migration dry-run validates project bodies and reports concise failure classes", async () => {
  const f = await fixture();
  try {
    const ref = legacyBody(f, "missing-content-claim"); legacyClaim(f, ref); rmSync(ref.path);
    const preview = f.store.reconcileKnowledgeStorage({ max_records: 10, dry_run: true, summary_only: true });
    assert.equal(preview.migratable, 0);
    assert.equal(preview.blocked_count, 1);
    assert.deepEqual(preview.blocked_reasons, { partition_migration_failed: 1 });
    assert.deepEqual(preview.blocked_failure_kinds, { source_missing: 1 });
    assert.deepEqual(preview.blocked, []);
    assert.equal(f.store.find("knowledge_claim", ref.record_id)?.content_ref &&
      (f.store.find("knowledge_claim", ref.record_id)!.content_ref as JsonObject).path, ref.path);
    assert.equal(existsSync(join(projectStorageDirectory(f.paths, f.project), "knowledge", "knowledge.db")), false);
  } finally { cleanup(f); }
});

test("Knowledge migration dry-run leaves non-project records on the scoped database path", async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('knowledge_claim',?,1,?,?,?)")
      .run("global-without-body", JSON.stringify({ scope: "global", status: "candidate" }), now, now);
    const preview = f.store.reconcileKnowledgeStorage({ max_records: 10, dry_run: true });
    assert.equal(preview.migratable, 1);
    assert.equal(preview.blocked_count, 0);
    assert.equal(preview.migrated, 0);
  } finally { cleanup(f); }
});

test("Knowledge migration creates a regular capability path before writing a legacy-scope backup", async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('knowledge_claim',?,1,?,?,?)")
      .run("legacy-scope-claim", JSON.stringify({ scope: { kind: "legacy", id: "shared" }, status: "candidate" }), now, now);
    const preview = f.store.reconcileKnowledgeStorage({ max_records: 10, dry_run: true });
    assert.equal(preview.migratable, 1);
    assert.equal(preview.blocked_count, 0);
    const migrated = f.store.reconcileKnowledgeStorage({ max_records: 10 });
    assert.equal(migrated.migrated, 1);
    const record = f.store.get("knowledge_claim", "legacy-scope-claim");
    assert.deepEqual(record.scope, { kind: "legacy", id: "shared" });
    const partitionRoot = join(f.paths.knowledgeDir, "scopes", `legacy-${createHash("sha256").update("legacy:shared").digest("hex").slice(0, 24)}`);
    assert.equal(existsSync(join(partitionRoot, "knowledge.db")), true);
    assert.equal(readdirSync(join(partitionRoot, "backups")).some(name => name.startsWith("legacy-partition-")), true);
  } finally { cleanup(f); }
});

test("Knowledge migration publishes all staged scopes in one central transaction", async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    for (const id of ["shared-a", "shared-b"]) f.store.database.prepare(
      "INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('knowledge_claim',?,1,?,?,?)")
      .run(`batched-${id}`, JSON.stringify({ scope: { kind: "legacy", id }, status: "candidate" }), now, now);
    const internals = f.store as unknown as { transaction: (operation: (database: DatabaseSync) => unknown) => unknown };
    const transaction = internals.transaction.bind(f.store);
    let transactionCalls = 0;
    internals.transaction = operation => { transactionCalls++; return transaction(operation); };
    try {
      const result = f.store.reconcileKnowledgeStorage({ max_records: 10 });
      assert.equal(result.migrated, 2);
      assert.equal(transactionCalls, 1);
      assert.equal(f.store.get("knowledge_claim", "batched-shared-a").status, "candidate");
      assert.equal(f.store.get("knowledge_claim", "batched-shared-b").status, "candidate");
    } finally { internals.transaction = transaction; }
  } finally { cleanup(f); }
});

test("Knowledge migration backup paths cannot escape the Craft data root", async () => {
  const f = await fixture();
  try {
    const internals = f.store as unknown as { writeLegacyPartitionBackup: (...args: unknown[]) => void };
    const backup = (directory: string) => internals.writeLegacyPartitionBackup("knowledge", { kind: "global", id: "global" }, directory,
      [], { write: writeFileSync, rename: renameSync, unlink: (path: string) => rmSync(path) });
    assert.throws(() => backup(f.paths.root), /within the Craft data root/u);
    assert.throws(() => backup(join(f.paths.root, "..")), /within the Craft data root/u);
    assert.throws(() => backup(f.root), /within the Craft data root/u);
  } finally { cleanup(f); }
});

test("Knowledge migration distinguishes an ambiguous project root from a missing one", async () => {
  const f = await fixture();
  try {
    const roots = [join(f.root, "ambiguous-a"), join(f.root, "ambiguous-b")];
    roots.forEach(root => mkdirSync(root));
    roots.forEach((alias, index) => f.store.create("scope_alias", `ambiguous-${index}`, {
      scope: { kind: "project", id: "ambiguous-project" }, alias_kind: "path", alias, status: "active",
    }));
    const now = new Date().toISOString();
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('knowledge_claim',?,1,?,?,?)")
      .run("ambiguous-project-claim", JSON.stringify({ scope: "project:ambiguous-project", status: "candidate" }), now, now);
    const preview = f.store.reconcileKnowledgeStorage({ max_records: 10, dry_run: true, summary_only: true });
    assert.equal(preview.migratable, 0);
    assert.equal(preview.blocked_count, 1);
    assert.deepEqual(preview.blocked_failure_kinds, { project_root_ambiguous: 1 });
    assert.deepEqual(preview.blocked_failure_phases, { scope_resolution: 1 });
  } finally { cleanup(f); }
});

test("Knowledge migration refuses a linked Craft data root before creating backups", async () => {
  const f = await fixture();
  const moved = `${f.paths.root}.real`;
  try {
    f.store.close();
    renameSync(f.paths.root, moved);
    symlinkSync(f.project, f.paths.root);
    const internals = f.store as unknown as { writeLegacyPartitionBackup: (...args: unknown[]) => void };
    assert.throws(() => internals.writeLegacyPartitionBackup("knowledge", { kind: "global", id: "global" }, join(f.paths.root, "knowledge"),
      [], { write: writeFileSync, rename: renameSync, unlink: (path: string) => rmSync(path) }), /Craft data root must be a regular directory/u);
  } finally {
    rmSync(f.paths.root, { recursive: true, force: true });
    if (existsSync(moved)) renameSync(moved, f.paths.root);
    cleanup(f);
  }
});

test("Knowledge migration preflights and relocates content from the exact legacy project tree", async () => {
  const f = await fixture();
  try {
    const shared = legacyBody(f, "legacy-project-content");
    const legacyDirectory = join(f.project, ".craft_data", "knowledge", "md");
    const legacyPath = join(legacyDirectory, "legacy-project-content.v1.md");
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(legacyPath, readFileSync(shared.path));
    legacyClaim(f, { ...shared, path: legacyPath });

    const preview = f.store.reconcileKnowledgeStorage({ max_records: 10, dry_run: true });
    assert.equal(preview.migratable, 1);
    assert.equal(preview.blocked_count, 0);
    const result = f.store.reconcileKnowledgeStorage({ max_records: 10 });
    assert.equal(result.migrated, 1);
    const migrated = f.store.get("knowledge_claim", shared.record_id).content_ref as JsonObject;
    assert.equal(String(migrated.path).startsWith(join(projectStorageDirectory(f.paths, f.project), "knowledge", "md") + "/"), true);
    assert.equal(f.store.contentStore.readSync(migrated as never).body, "项目专属的可验证知识。");
  } finally { cleanup(f); }
});

test("Knowledge migration classifies recoverable and unexpected backup failures", async t => {
  const cases: Array<{ error: unknown; failureKind: string }> = [
    { error: new Error("database is locked"), failureKind: "write_lock" },
    { error: new Error("Content reference path is outside the canonical directory"), failureKind: "content_path_out_of_scope" },
    { error: new Error("version collision"), failureKind: "version_collision" },
    { error: new Error("scope validation failed"), failureKind: "scope_validation" },
    { error: new Error("content manifest digest is invalid"), failureKind: "content_validation" },
    { error: new Error("Project Knowledge storage root is not registered"), failureKind: "project_root_missing" },
    { error: new Error("Project Knowledge storage root is ambiguous"), failureKind: "project_root_ambiguous" },
    { error: new Error("ENOENT: no such file, lstat '/tmp/knowledge/scopes/legacy'"), failureKind: "source_missing" },
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
