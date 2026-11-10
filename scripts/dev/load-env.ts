/**
 * Load local model credentials without adding a dependency.
 *
 * Credentials never live in the source tree (see `.gitignore` and the secret
 * detectors in `src/federation.ts` / `src/materialization.ts`). `.env.example`
 * documents the variable names; `.env.local` holds the real values and is
 * ignored by git. Node's built-in `process.loadEnvFile` reads the file, and the
 * loader only fills variables that are not already set, so an explicit
 * environment always wins over the file.
 *
 * Usage:
 *   node --import ./scripts/dev/load-env.ts --experimental-strip-types capability/craft-eval/suite.ts
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const candidates = [".env.local", ".env"].map((name) => join(root, name));

export function loadLocalEnv(candidatePaths: string[] = candidates): string[] {
  const loaded: string[] = [];
  for (const file of candidatePaths) {
    if (!existsSync(file)) continue;
    const before = new Map(Object.entries(process.env));
    process.loadEnvFile(file);
    // Restore anything the file tried to override that was already set.
    for (const [key, value] of before) {
      if (value !== undefined) process.env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}

loadLocalEnv();
