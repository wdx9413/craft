import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";

test("storage apply reports each unresolved pointer without migrating or hiding its status", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-storage-apply-report-"));
  const dataRoot = join(root, "data"), projectRoot = join(root, "project"), legacyMemoryRoot = join(root, "legacy-memory");
  mkdirSync(projectRoot); mkdirSync(legacyMemoryRoot);
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  try {
    const alias = { kind: "project", id: "project:report-fixture" };
    store.create("scope_alias", "report-fixture-alias", { scope: alias, alias_kind: "path", alias: projectRoot,
      alias_digest: stableDigest(projectRoot), status: "active" });
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("memory_candidate", "unresolved-fixture", 1, JSON.stringify({
        _memory_partition: { file: join(projectRoot, ".craft_data", "memory", "memory.db"), scope: alias },
      }), now, now);
  } finally { store.close(); }

  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-migration-apply.ts"),
      `--data-root=${dataRoot}`, `--legacy-session-memory-root=${legacyMemoryRoot}`, "--apply"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout) as { mode: string; blocked_entries: Array<Record<string, unknown>> };
    assert.equal(report.mode, "blocked");
    assert.deepEqual(report.blocked_entries, [{ kind: "memory_candidate", id: "unresolved-fixture", version: 1, status: "missing_file" }]);
    const unchanged = await new CraftStore(craftPaths(dataRoot)).open({ skipLegacyPartitionMigration: true });
    try {
      assert.equal(unchanged.database.prepare("SELECT count(*) AS count FROM records WHERE kind='memory_candidate' AND id='unresolved-fixture'")
        .get()?.count, 1);
    } finally { unchanged.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
