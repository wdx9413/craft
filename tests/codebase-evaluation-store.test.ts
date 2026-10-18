import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { persistCodebaseEvaluation } from "../scripts/eval/codebase-evaluation-store.ts";

test("evaluation reports persist as immutable JSON in the project's Codebase data", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-evaluation-store-"));
  try {
    const first = persistCodebaseEvaluation(root, { evaluation_pass: true, cases: 4 });
    const second = persistCodebaseEvaluation(root, { evaluation_pass: false, cases: 5 });
    assert.equal(first.startsWith(join(root, ".craft_data", "codebase", "evaluations")), true);
    assert.deepEqual(JSON.parse(readFileSync(first, "utf8")), { evaluation_pass: true, cases: 4 });
    assert.deepEqual(JSON.parse(readFileSync(second, "utf8")), { evaluation_pass: false, cases: 5 });
    assert.notEqual(first, second);
    assert.equal(lstatSync(first).isFile(), true);
    if (process.platform !== "win32") assert.equal(lstatSync(first).mode & 0o777, 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("evaluation reports reject symlinked and non-directory Craft data paths", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-evaluation-store-boundary-"));
  try {
    const external = join(root, "external");
    mkdirSync(external);
    symlinkSync(external, join(root, ".craft_data"));
    assert.throws(() => persistCodebaseEvaluation(root, {}), /unsafe directory/);

    const fileRoot = join(root, "file-root");
    mkdirSync(fileRoot);
    writeFileSync(join(fileRoot, ".craft_data"), "not a directory");
    assert.throws(() => persistCodebaseEvaluation(fileRoot, {}), /unsafe directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
