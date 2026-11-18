import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A capability kernel duplicated into the core defeats the package split: the
 * core copy keeps building while the package evolves, exactly like
 * `craft-notes-location` and `memory-consolidation` did. This guard fails when a core
 * file imports a capability implementation by relative path again.
 */
test("the core imports capability kernels by package name, never by sibling path", () => {
  const offenders: string[] = [];
  for (const file of ["core/application/service-foundation.ts", "core/application/craft-service.ts",
    "core/context-notes.ts", "core/eval/self-evolution-regression.ts"]) {
    const source = readFileSync(join(root, file), "utf8");
    if (/from "\.\.?\/(memory-consolidation|craft-notes-location)\.ts"/u.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
