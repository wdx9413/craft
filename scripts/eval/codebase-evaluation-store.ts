import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** Persist an immutable evaluation report inside the evaluated project's Craft data. */
export function persistCodebaseEvaluation(repositoryRoot: string, report: unknown): string {
  const root = resolve(repositoryRoot);
  let current = root;
  for (const part of [".craft_data", "codebase", "evaluations"]) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Codebase evaluation path contains an unsafe directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  const path = join(current, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}
