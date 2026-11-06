import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coverageInventory } from "../scripts/coverage/coverage-inventory.ts";

test("coverage inventory exposes omitted production files independently of green groups", () => {
  const result = coverageInventory(["core/known.ts", "core/new.ts", "core/known.ts", "core/types.d.ts", "tests/test.ts", "core/data.json", "adapters/dist/generated.js", "adapters/node_modules/vendor.js", "workbench/page.js"], [{ name: "known", include: ["core/known.ts"] }]);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.managed, ["core/known.ts"]);
  assert.deepEqual(result.missing, ["core/new.ts"]);
  assert.equal(result.coverage_proven, false);
  assert.equal(result.native_coverage, "separate_required");
  assert.equal(coverageInventory(["core/known.ts"], [{ name: "known", include: ["core/known.ts"] }]).status, "complete");
  const shared = coverageInventory(["common/craft-common-log/src/index.ts", "common/craft-common-log/src/new.ts", "common/craft-common-log/dist/index.js"], [{ name: "log", include: ["common/craft-common-log/src/*.ts"] }]);
  assert.equal(shared.status, "complete");
  assert.deepEqual(shared.managed, ["common/craft-common-log/src/index.ts", "common/craft-common-log/src/new.ts"]);
  const debt = coverageInventory(["core/old.ts", "core/new.ts"], [], ["core/old.ts"]);
  assert.deepEqual(debt.baseline_missing, ["core/old.ts"]);
  assert.deepEqual(debt.new_missing, ["core/new.ts"]);
  assert.equal(debt.status, "incomplete");
});

test("type-only registration verifies actual compiler output and cannot hide runtime code", () => {
  const path = "core/contracts.ts";
  for (const source of ["", "// comments only", "type Value = string;", "export interface Shape { value: string }", "import type { Value } from './value.js'; export type Result = Value;", "export type { Value } from './value.js';", "declare const native: string; export type Value = typeof native;"]) {
    const result = coverageInventory([path], [], [], { [path]: source });
    assert.equal(result.status, "complete", source); assert.deepEqual(result.type_only, [path]); assert.deepEqual(result.missing, []);
    assert.equal(result.coverage_proven, false); assert.equal(result.typecheck_required, true);
  }
  for (const source of ["export const count = 1", "import './side-effect.js'", "import { Value } from './value.js'; export type Result = typeof Value", "export {} from './side-effect.js'", "export { value } from './value.js'", "console.log('export{};')", "enum Value { one }", "export type Broken = ;"]) {
    const result = coverageInventory([path], [{ name: "existing", include: [path] }], [], { [path]: source });
    assert.equal(result.status, "invalid", source); assert.deepEqual(result.invalid_type_only, [path]); assert.deepEqual(result.managed, [path]);
  }
  const unsupported = coverageInventory(["core/contracts.js"], [], [], { "core/contracts.js": "", "tests/fixture.ts": "export type Value = string" });
  assert.deepEqual(unsupported.invalid_type_only, ["core/contracts.js", "tests/fixture.ts"]);
  assert.deepEqual(unsupported.new_missing, ["core/contracts.js"]);
  const debt = coverageInventory(["core/debt.ts", path], [], ["core/debt.ts"], { [path]: "export type Value = string" });
  assert.equal(debt.status, "incomplete"); assert.deepEqual(debt.baseline_missing, ["core/debt.ts"]); assert.deepEqual(debt.new_missing, []);
});

test("inventory CLI checks actual files and rejects a type-only declaration that gains runtime code", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-coverage-inventory-")), source = resolve(import.meta.dirname, "..");
  try {
    await mkdir(join(root, "scripts/coverage"), { recursive: true }); await mkdir(join(root, "core")); await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), '{"type":"module"}'); await writeFile(join(root, ".gitignore"), "node_modules\n");
    await symlink(join(source, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    for (const name of ["coverage-inventory.ts", "check-coverage-inventory.ts"]) {
      const from = join(source, "scripts/coverage", name), to = join(root, "scripts/coverage", name); await copyFile(from, to); assert.equal(await readFile(from, "utf8"), await readFile(to, "utf8"));
    }
    execFileSync("git", ["-C", root, "init", "-q"]);
    const manifest = { groups: [] as Array<{ name: string; include: string[] }>, type_only: ["core/contracts.ts"] };
    const file = join(root, "tests/coverage-gates.json"); await writeFile(file, JSON.stringify(manifest));
    await writeFile(join(root, "tests/coverage-inventory-baseline.json"), '["core/legacy.ts"]'); await writeFile(join(root, "core/legacy.ts"), "export const legacy = 1");
    await writeFile(join(root, "core/contracts.ts"), "export type Value = string");
    const run = () => spawnSync(process.execPath, ["--experimental-strip-types", join(root, "scripts/coverage/check-coverage-inventory.ts"), "--check"], { cwd: root, encoding: "utf8" });
    const valid = run(); assert.equal(valid.status, 0, valid.stderr); const result = JSON.parse(valid.stdout);
    assert.equal(result.baseline_debt, 1); assert.deepEqual(result.type_only, ["core/contracts.ts"]); assert.deepEqual(result.new_missing, []);
    await writeFile(join(root, "core/contracts.ts"), 'export type Value = string; console.log("must not execute");');
    manifest.groups.push({ name: "registered", include: ["core/*.ts"] }); await writeFile(file, JSON.stringify(manifest));
    const invalid = run(); assert.equal(invalid.status, 1, invalid.stderr); const rejected = JSON.parse(invalid.stdout);
    assert.equal(rejected.status, "invalid"); assert.deepEqual(rejected.new_missing, []); assert.deepEqual(rejected.invalid_type_only, ["core/contracts.ts"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
