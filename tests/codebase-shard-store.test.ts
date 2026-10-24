import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { migrateCodebaseGraphShards } from "../scripts/codebase-graph-shard-migration.ts";
import { compactCentralDb } from "../scripts/compact-central-db.ts";
import { CodebaseShardStore, type GraphRow } from "../common/craft-common-store-local/src/codebase-shards.ts";

test("legacy Codebase graph migration keeps every version and its digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-codebase-shards-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  const ids = ["codebase_shard_a", "codebase_edge_route_a"];
  let before = "";
  try {
    store.create("codebase_index_shard", ids[0]!, { nodes: [{ id: "node-a" }], edges: [] });
    store.save("codebase_index_shard", ids[0]!, { nodes: [{ id: "node-b" }], edges: [] });
    store.create("codebase_index_edge_route", ids[1]!, { locations: {} });
    before = store.latestRecordsDigest("codebase_index_shard", [ids[0]!]);
  } finally { store.close(); }
  try {
    assert.deepEqual(await migrateCodebaseGraphShards(root), { graph_records: 2, versions: 3, migrated: 0, backup: null });
    const graphCli = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/codebase-graph-shard-migration.ts", `--data-root=${root}`],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(graphCli.status, 0, graphCli.stderr);
    assert.equal(JSON.parse(graphCli.stdout).versions, 3);
    const invalidGraphCli = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/codebase-graph-shard-migration.ts"],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(invalidGraphCli.status, 0);
    assert.match(invalidGraphCli.stderr, /Usage: codebase-graph-shard-migration/u);
    const result = await migrateCodebaseGraphShards(root, true);
    assert.equal(result.migrated, 2);
    const backup = new DatabaseSync(result.backup!, { readOnly: true });
    try { assert.equal(backup.prepare("SELECT COUNT(*) n FROM records WHERE kind='codebase_index_shard'").get()?.n, 2); }
    finally { backup.close(); }
    const reopened = await new CraftStore(paths).open();
    try {
      assert.equal(reopened.latestRecordsDigest("codebase_index_shard", [ids[0]!]), before);
      assert.equal(reopened.find("codebase_index_shard", ids[0]!, 1)?.nodes instanceof Array, true);
      assert.equal(reopened.findMany("codebase_index_edge_route", [ids[1]!]).length, 1);
      assert.deepEqual(reopened.findMany("codebase_index_shard", [ids[0]!, "missing-shard"], false).map(row => row.id), [ids[0]!]);
      assert.equal(reopened.count("codebase_index_shard"), 1);
      assert.equal(reopened.list("codebase_index_shard", 10).length, 1);
      assert.deepEqual(reopened.history("codebase_index_shard", ids[0]!, 3, 10).map(item => item.version), [2, 1]);
      assert.equal(reopened.database.prepare("SELECT COUNT(*) n FROM records WHERE kind IN ('codebase_index_shard','codebase_index_edge_route')").get()?.n, 0);
      assert.equal(reopened.updateIfVersion("codebase_index_shard", ids[0]!, 2, { nodes: [{ id: "node-c" }] }).version, 3);
      assert.throws(() => reopened.updateIfVersion("codebase_index_shard", ids[0]!, 2, {}), /Concurrent update/u);
      assert.equal(reopened.save("codebase_index_shard", ids[0]!, { nodes: [{ id: "node-d" }] }).version, 4);
      assert.equal(reopened.countMany(["codebase_index_shard"]).codebase_index_shard, 1);
      assert.throws(() => reopened.create("codebase_index_shard", ids[0]!, {}), /already exists/u);
    } finally { reopened.close(); }
    assert.equal((await migrateCodebaseGraphShards(root, true)).migrated, 0);
    const compacted = compactCentralDb(root, true);
    assert.ok(compacted.backup);
    assert.ok(compacted.after_bytes! <= compacted.before_bytes);
    const afterCompact = await new CraftStore(paths).open();
    try { assert.equal(afterCompact.find("codebase_index_shard", ids[0]!)?.version, 4); }
    finally { afterCompact.close(); }
    const compactCli = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/compact-central-db.ts", `--data-root=${root}`],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(compactCli.status, 0, compactCli.stderr);
    assert.ok(JSON.parse(compactCli.stdout).before_bytes > 0);
    const invalidCompactCli = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/compact-central-db.ts"],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(invalidCompactCli.status, 0);
    assert.match(invalidCompactCli.stderr, /Usage: compact-central-db/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codebase shards validate ownership, preserve imports, filter lists and reject unsafe paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-codebase-shard-api-"));
  const shards = new CodebaseShardStore(root);
  const id = "standalone-shard";
  try {
    assert.equal(shards.raw("codebase_index_shard", id), null);
    assert.equal(shards.count("codebase_index_shard"), 0);
    assert.throws(() => shards.raw("unknown", id), /Unsupported/u);
    assert.throws(() => shards.find("unknown", id), /Unsupported/u);
    assert.throws(() => shards.history("unknown", id, 10, 10), /Unsupported/u);
    assert.throws(() => shards.save("unknown", id, {}), /Unsupported/u);
    assert.throws(() => shards.raw("codebase_index_shard", ""), /must not be empty/u);
    assert.equal(shards.find("codebase_index_shard", "absent"), null);
    assert.deepEqual(shards.history("codebase_index_shard", "absent", 5, 10), []);

    const now = "2026-01-01T00:00:00.000Z";
    const imported: GraphRow = { kind: "codebase_index_shard", id, version: 1,
      payload_json: JSON.stringify({ nodes: [{ id: "imported" }] }), created_at: now, updated_at: now };
    shards.importLegacy(id, [imported]);
    shards.importLegacy(id, [imported]);
    assert.equal(shards.raw("codebase_index_shard", id, 1)?.version, 1);
    assert.equal(shards.raw("codebase_index_shard", id, 99), null);
    assert.throws(() => shards.importLegacy("different-owner", [imported]), /different owner/u);
    assert.throws(() => shards.importLegacy(id, [{ ...imported, kind: "unknown" }]), /different owner/u);
    assert.throws(() => shards.importLegacy(id, [{ ...imported, payload_json: JSON.stringify({ nodes: [] }) }]), /conflicts with shard/u);

    shards.save("codebase_index_shard", id, { nodes: [{ id: "current" }] });
    assert.throws(() => shards.save("codebase_index_shard", id, { nodes: [{ id: "conflict" }] }, 1));
    const currentUpdatedAt = String(shards.find("codebase_index_shard", id)?.updated_at);
    const secondId = "second-shard";
    assert.equal(shards.save("codebase_index_shard", secondId, { label: "keep" }, 4).version, 4);
    const secondShard = createHash("sha256").update(secondId).digest()[0]! % 16;
    const secondDatabase = new DatabaseSync(join(shards.directory, `${secondShard.toString(16).padStart(2, "0")}.db`));
    try { secondDatabase.prepare("UPDATE records SET updated_at=? WHERE id=?").run(currentUpdatedAt, secondId); }
    finally { secondDatabase.close(); }
    assert.equal(shards.find("codebase_index_shard", id, 1)?.id, id);
    assert.deepEqual(shards.history("codebase_index_shard", id, 2, 10), [shards.find("codebase_index_shard", id, 1)]);
    assert.equal(shards.history("codebase_index_shard", id, 3, 10).length, 2);
    assert.equal(shards.list("codebase_index_shard", 10).length, 2);
    assert.equal(shards.list("codebase_index_shard", 10, row => row.label === "keep").length, 1);
    assert.equal(shards.count("codebase_index_shard"), 2);
  } finally { shards.close(); await rm(root, { recursive: true, force: true }); }

  const unsafeRoot = await mkdtemp(join(tmpdir(), "craft-codebase-shard-link-"));
  try {
    await mkdir(join(unsafeRoot, "outside"));
    await symlink(join(unsafeRoot, "outside"), join(unsafeRoot, "codebase"));
    assert.throws(() => new CodebaseShardStore(unsafeRoot).save("codebase_index_shard", id, {}), /regular directories/u);
  } finally { await rm(unsafeRoot, { recursive: true, force: true }); }

  const shardZeroId = Array.from({ length: 10_000 }, (_, index) => `shard-zero-${index}`)
    .find(value => createHash("sha256").update(value).digest()[0]! % 16 === 0)!;
  const linkedRoot = await mkdtemp(join(tmpdir(), "craft-codebase-shard-file-link-"));
  try {
    const directory = join(linkedRoot, "codebase", "legacy-graph-v1"), outside = join(linkedRoot, "outside.db");
    await mkdir(directory, { recursive: true }); await writeFile(outside, ""); await symlink(outside, join(directory, "00.db"));
    assert.throws(() => new CodebaseShardStore(linkedRoot).save("codebase_index_shard", shardZeroId, {}), /regular file/u);
  } finally { await rm(linkedRoot, { recursive: true, force: true }); }

  const corruptRoot = await mkdtemp(join(tmpdir(), "craft-codebase-shard-corrupt-"));
  try {
    const directory = join(corruptRoot, "codebase", "legacy-graph-v1");
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "00.db"), "not a SQLite database");
    assert.throws(() => new CodebaseShardStore(corruptRoot).save("codebase_index_shard", shardZeroId, {}));
  } finally { await rm(corruptRoot, { recursive: true, force: true }); }
});
