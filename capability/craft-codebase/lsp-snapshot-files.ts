import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RepositoryContextFile } from "./repository-files.ts";

export type LspSnapshotSourceFile = { readonly path: string; readonly content: string };

function snapshotPath(root: string, path: string): string {
  const target = resolve(root, path);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) throw new Error("invalid_snapshot_path");
  return target;
}

function writeSnapshotFile(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { flag: "wx" });
}

/** Materialize only digest-pinned checkpoint content under the private LSP root. */
export function stageLspSnapshotFiles(root: string, files: readonly LspSnapshotSourceFile[], contextFiles: readonly RepositoryContextFile[] = []): void {
  for (const file of files) writeSnapshotFile(snapshotPath(root, file.path), file.content);
  for (const file of contextFiles) {
    const target = snapshotPath(root, file.path);
    if (createHash("sha256").update(file.content).digest("hex") !== file.digest) throw new Error("LSP workspace context digest mismatch");
    writeSnapshotFile(target, file.content);
  }
}
