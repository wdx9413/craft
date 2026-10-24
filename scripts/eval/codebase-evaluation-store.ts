import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { digestEvaluationMaterial } from "./codebase-evaluation-provenance.ts";
import { craftPaths, ensureProjectStorageDirectory, type CraftPaths } from "../../common/craft-common-store-local/src/paths.ts";

export type CodebaseEvaluationInputKind = "evaluation_suites" | "evaluation_configs";

function ensureCodebaseDirectory(repositoryRoot: string, tail: string[], paths: CraftPaths): string {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  let current = ensureProjectStorageDirectory(paths, repositoryRoot);
  for (const part of ["codebase", ...tail]) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Codebase evaluation path contains an unsafe directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return current;
}

/** Persist immutable, digest-addressed inputs so an evaluation can be replayed. */
export function persistCodebaseEvaluationInput(repositoryRoot: string, kind: CodebaseEvaluationInputKind, material: string | Uint8Array,
  paths: CraftPaths = craftPaths(join(homedir(), ".craft_data")),
  writeMaterial: (path: string, material: string | Uint8Array) => void = (path, content) => writeFileSync(path, content, { flag: "wx", mode: 0o600 })) {
  if (kind !== "evaluation_suites" && kind !== "evaluation_configs") throw new Error("Unsupported Codebase evaluation input kind");
  const sha256 = digestEvaluationMaterial(material);
  const directory = ensureCodebaseDirectory(repositoryRoot, [kind], paths);
  const path = join(directory, `${sha256}.json`);
  try { writeMaterial(path, material); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Codebase evaluation input path contains an unsafe file");
  const persisted = readFileSync(path);
  if (!persisted.equals(Buffer.from(material))) throw new Error("Codebase evaluation input content changed for its digest");
  return { path, sha256 };
}

/** Persist an immutable evaluation report inside the evaluated project's Craft data. */
export function persistCodebaseEvaluation(repositoryRoot: string, report: unknown,
  paths: CraftPaths = craftPaths(join(homedir(), ".craft_data"))): string {
  const current = ensureCodebaseDirectory(repositoryRoot, ["evaluations"], paths);
  const path = join(current, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}
