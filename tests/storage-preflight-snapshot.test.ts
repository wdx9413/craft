import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CodebaseStoragePreflightReader } from "../core/codebase-storage-preflight.ts";
import { withStoragePreflightSnapshot } from "../core/storage-preflight-snapshot.ts";

test("migration inventory sees one committed primary snapshot while live writes continue", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-preflight-source-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  let snapshotPath = "";
  try {
    store.create("fixture", "first", { status: "active" });
    await withStoragePreflightSnapshot(paths, async snapshotPaths => {
      snapshotPath = snapshotPaths.databaseFile;
      assert.equal(snapshotPaths.root, paths.root);
      assert.equal(snapshotPaths.knowledgeDir, paths.knowledgeDir);
      const reader = new CodebaseStoragePreflightReader(snapshotPaths);
      try {
        reader.readPage({ max_records: 1 });
        store.create("fixture", "second", { status: "active" });
        reader.readPage({ max_records: 1 });
        const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
        try {
          assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM records WHERE kind='fixture'").get()!.n, 1);
        } finally { snapshot.close(); }
      } finally { reader.close(); }
    });
    assert.equal(existsSync(dirname(snapshotPath)), false);
    assert.equal(store.count("fixture"), 2);
    await assert.rejects(withStoragePreflightSnapshot(paths, async snapshotPaths => {
      snapshotPath = snapshotPaths.databaseFile;
      throw new Error("fixture interruption");
    }), /fixture interruption/u);
    assert.equal(existsSync(dirname(snapshotPath)), false);
    await assert.rejects(withStoragePreflightSnapshot({ ...paths, databaseFile: join(root, "missing.db") }, async () => {
      assert.fail("missing sources must not reach inventory");
    }));
    assert(!existsSync(join(root, "missing.db")));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
