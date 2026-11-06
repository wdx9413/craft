import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ScopeIdentityKernel } from "../core/scope-identity.ts";
import { projectDataInventory } from "../core/project-data-inventory.ts";
import { stableDigest } from "../core/digest.ts";
import { TOOLS } from "../core/mcp/tool-catalog.ts";

async function fixture(legacy = "legacy") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "craft-data-inventory-")));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const kernel = new ScopeIdentityKernel(store);
  kernel.bindAlias({ scope_kind: "project", scope_id: legacy, alias_kind: "path", alias: root });
  store.create("project_identity", legacy, { canonical_scope: { kind: "project", id: legacy }, local_path_alias: root });
  const plan = kernel.resolveProject({ project_root: root, action: "plan_registry_migration" });
  const result = kernel.resolveProject({ project_root: root, action: "apply_registry_migration", expected_digest: plan.plan_digest, legacy_scope_id: legacy });
  const identity = result.identity as JsonObject;
  const args = { project_root: root, action: "inventory_project_data", migration_id: (result.migration as JsonObject).id };
  // Old on-disk projections must be inspected without hydrating their bodies.
  function header(kind: string, id: string, payload: JsonObject, version = 1) {
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(kind, id, version, JSON.stringify({ ...payload, id, version }), now, now);
  }
  return { root, store, kernel, identity, args, header,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("inventory pages published old-scope pointers without reading bodies, taking a writer or changing data", async () => {
  const f = await fixture();
  const peer = new DatabaseSync(f.store.paths.databaseFile);
  try {
    const note = f.store.create("legacy_project_note", "note", { scope: "project:legacy", content: "private central content" });
    const memory = f.store.create("memory_ledger", "memory", { scope: { kind: "project", id: "legacy" }, status: "active", content: "private partition content" });
    f.header("codebase_index", "old-index", { project_id: "legacy", secret: "private codebase body" });
    f.header("legacy_project_note", "updated", { scope: "project:legacy", secret: "obsolete" });
    f.header("legacy_project_note", "updated", { scope: "project:legacy", secret: "private latest body" }, 2);
    const before = f.store.database.prepare("SELECT * FROM records ORDER BY kind,id,version").all();
    const changes = f.store.database.prepare("SELECT total_changes() count").get();
    peer.exec("BEGIN IMMEDIATE");
    const all: JsonObject[] = [];
    let cursor: unknown;
    do {
      const page = f.kernel.resolveProject({ ...f.args, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      assert.equal(page.data_migrated, false); assert.equal(page.automatic_apply_allowed, false);
      assert.equal(page.raw_content_stored, false); assert.equal(page.snapshot_scope, "page_only");
      assert.equal(page.partition_content_verified, false); assert.equal(page.coverage, "published_central_records_only");
      assert.equal(page.page_digest, stableDigest({ binding: page.migration_digest, records: page.records }));
      assert.doesNotMatch(JSON.stringify(page), /private (central|partition|latest|codebase)|obsolete|content_ref|\.db/);
      all.push(...page.records as JsonObject[]);
      cursor = page.next_cursor;
      assert.equal(page.has_more, cursor !== null);
    } while (cursor !== null);
    assert.deepEqual(all.map(row => [row.kind, row.id, row.version]), [
      ["codebase_index", "old-index", 1], ["legacy_project_note", "note", 1], ["legacy_project_note", "updated", 2], ["memory_ledger", "memory", 1],
    ]);
    assert.deepEqual(all.map(row => row.disposition), ["reindex_required", "requires_typed_recipe", "requires_typed_recipe", "requires_business_provenance_review"]);
    assert.equal(all.at(-1)!.binding, "published_partition_pointer");
    const pointer = f.store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_ledger' AND id='memory'").get()!.payload_json;
    assert.equal(all.at(-1)!.pointer_digest, stableDigest(JSON.parse(String(pointer))));
    assert.deepEqual(f.store.database.prepare("SELECT total_changes() count").get(), changes);
    assert.deepEqual(f.store.database.prepare("SELECT * FROM records ORDER BY kind,id,version").all(), before);
    peer.exec("ROLLBACK");
    assert.deepEqual(f.store.get("legacy_project_note", "note"), note);
    assert.deepEqual(f.store.get("memory_ledger", "memory"), memory);
  } finally { if (peer.isTransaction) peer.exec("ROLLBACK"); peer.close(); await f.close(); }
});

test("inventory respects explicit scope ownership, legacy aliases and latest revisions", async () => {
  const f = await fixture("project:legacy");
  try {
    const included = [
      { scope: { kind: "project", id: "project:legacy" } },
      { scope: "project:legacy" }, { scope_kind: "project", scope_id: "legacy" },
      { project_scope_id: "project:legacy" }, { project_id: "legacy" },
    ];
    const excluded = [
      { scope: { kind: "global", id: "global" }, project_id: "legacy" },
      { scope: "session:legacy", project_id: "legacy" },
      { scope: "global", project_id: "legacy" },
      { scope_kind: "user", scope_id: "legacy", project_id: "legacy" },
      { scope: { kind: "project", id: "another" }, project_id: "legacy" },
      { scope: { kind: "project" }, project_id: "legacy" },
      { scope: { id: "legacy" }, project_id: "legacy" },
      { scope: [], project_id: "legacy" }, { scope: 1, project_id: "legacy" },
      { scope: "project", project_id: "legacy" },
      { scope_kind: "project", project_id: "legacy" },
      { scope: "project:another" }, {},
    ];
    included.forEach((payload, i) => f.header("old_record", `included-${i}`, payload));
    excluded.forEach((payload, i) => f.header("old_record", `excluded-${i}`, payload));
    f.header("old_record", "moved", { scope: "project:legacy" });
    f.header("old_record", "moved", { scope: "project:another" }, 2);
    const page = f.kernel.resolveProject(f.args);
    assert.deepEqual(page.legacy_scope_ids, ["project:legacy", "legacy"]);
    assert.deepEqual((page.records as JsonObject[]).map(row => row.id), included.map((_, i) => `included-${i}`));
    assert.equal(page.next_cursor, null);
    assert.deepEqual(f.kernel.resolveProject({ ...f.args, cursor: Buffer.from(JSON.stringify({ binding: page.migration_digest, after: ["zzzz", ""] })).toString("base64url") }).records, []);
  } finally { await f.close(); }
});

test("inventory marks oversized or ambiguous projections for review and never hydrates missing partitions", async () => {
  const f = await fixture();
  try {
    for (const domain of ["memory", "knowledge", "experience", "evolution", "context"]) {
      f.header("old_record", domain, { scope: "project:legacy", [`_${domain}_partition`]: { file: "/does/not/exist.db", scope: { kind: "project", id: "legacy" } } });
    }
    f.header("old_record", "ambiguous", { scope: "project:legacy", _memory_partition: {}, _knowledge_partition: {} });
    f.header("old_record", "huge", { scope: "project:legacy", body: "密".repeat(400_000), _memory_partition: {} });
    const page = f.kernel.resolveProject(f.args);
    const rows = page.records as JsonObject[];
    for (const domain of ["memory", "knowledge", "experience", "evolution", "context"]) assert.equal(rows.find(row => row.id === domain)!.domain, domain);
    assert.equal(rows.find(row => row.id === "ambiguous")!.disposition, "requires_typed_recipe");
    assert.equal(rows.find(row => row.id === "ambiguous")!.binding, "ambiguous_partition_pointer");
    const huge = rows.find(row => row.id === "huge")!;
    assert.ok(Number(huge.metadata_bytes) > 1048576); assert.equal(huge.pointer_digest, null);
    assert.equal(huge.disposition, "metadata_exceeds_inventory_budget");
    assert.ok(JSON.stringify(page).length < 6000);
  } finally { await f.close(); }
});

test("inventory rejects invalid bounds, changed migration bindings and cross-project cursors", async () => {
  const f = await fixture(), other = await fixture();
  try {
    assert.throws(() => projectDataInventory(f.store, f.identity, {}), /migration_id/);
    assert.throws(() => projectDataInventory(f.store, f.identity, { migration_id: "" }), /migration_id/);
    for (const limit of [0, 101, 1.5, "1", null, Infinity]) {
      assert.throws(() => f.kernel.resolveProject({ ...f.args, limit }), /limit/);
    }
    f.header("old_record", "a", { scope: "project:legacy" }); f.header("old_record", "b", { scope: "project:legacy" });
    const first = f.kernel.resolveProject({ ...f.args, limit: 1 });
    for (const cursor of [null, 1, "x".repeat(4097), "%%%", Buffer.from("null").toString("base64url"),
      ...[{ binding: first.migration_digest, after: "a" }, { binding: first.migration_digest, after: [] },
        { binding: first.migration_digest, after: [1, ""] }, { binding: first.migration_digest, after: ["a".repeat(1025), ""] }]
        .map(value => Buffer.from(JSON.stringify(value)).toString("base64url"))]) {
      assert.throws(() => f.kernel.resolveProject({ ...f.args, cursor }), /cursor/);
    }
    assert.throws(() => other.kernel.resolveProject({ ...other.args, cursor: first.next_cursor }), /cursor/);
    for (const identity of [{ ...f.identity, local_path_alias: other.root }, { ...f.identity, canonical_scope: { kind: "project", id: "other" } }]) {
      assert.throws(() => projectDataInventory(f.store, identity, f.args), /exact project/);
    }
    const migration = f.store.get("project_registry_migration", String(f.args.migration_id));
    f.store.save("project_registry_migration", String(migration.id), { ...migration, note: "changed" });
    assert.throws(() => f.kernel.resolveProject({ ...f.args, cursor: first.next_cursor }), /changed migration/);
    f.store.save("project_registry_migration", String(migration.id), { ...f.store.get("project_registry_migration", String(migration.id)), state: "restored" });
    assert.throws(() => f.kernel.resolveProject(f.args), /applied registry/);
  } finally { await f.close(); await other.close(); }
});

test("the existing identity tool advertises bounded inventory arguments", () => {
  const tool = TOOLS.find(item => item.name === "craft_scope_identity_resolve_project")!;
  const properties = tool.inputSchema.properties as JsonObject;
  for (const key of ["migration_id", "limit", "cursor"]) assert.ok(key in properties);
  assert.match(tool.description, /inventory_project_data/);
});
