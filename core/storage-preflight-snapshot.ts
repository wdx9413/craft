import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { CraftPaths } from "./infrastructure/paths.ts";

/** Pin the primary inventory while retaining the original content and partition locations. */
export async function withStoragePreflightSnapshot<T>(
  paths: CraftPaths,
  inspect: (snapshotPaths: CraftPaths) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "craft-storage-preflight-"));
  try {
    const snapshot = join(directory, "snapshot.db");
    const source = new DatabaseSync(paths.databaseFile, { readOnly: true });
    try {
      source.exec("BEGIN");
      source.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      await backup(source, snapshot);
    }
    finally { source.close(); }
    return await inspect({ ...paths, databaseFile: snapshot });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
