import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { persistCodebaseEvaluation, persistCodebaseEvaluationInput } from "../scripts/eval/codebase-evaluation-store.ts";
import { craftPaths, ensureProjectStorageDirectory, projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";

function fixturePaths(root: string) {
  const paths = craftPaths(join(root, "data"));
  mkdirSync(paths.root);
  return paths;
}

test("evaluation reports persist as immutable JSON in the project's Codebase data", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-evaluation-store-"));
  try {
    const paths = fixturePaths(root);
    const first = persistCodebaseEvaluation(root, { evaluation_pass: true, cases: 4 }, paths);
    const second = persistCodebaseEvaluation(root, { evaluation_pass: false, cases: 5 }, paths);
    assert.equal(first.startsWith(join(projectStorageDirectory(paths, root), "codebase", "evaluations")), true);
    assert.equal(lstatSync(join(root, ".craft_data"), { throwIfNoEntry: false }), undefined);
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
    const paths = fixturePaths(root);
    const external = join(root, "external");
    mkdirSync(external);
    symlinkSync(external, join(paths.root, "projects"));
    assert.throws(() => persistCodebaseEvaluation(root, {}, paths), /regular directories/);
    unlinkSync(join(paths.root, "projects"));

    const fileRoot = join(root, "file-root");
    mkdirSync(fileRoot);
    writeFileSync(join(ensureProjectStorageDirectory(paths, fileRoot), "codebase"), "not a directory");
    assert.throws(() => persistCodebaseEvaluation(fileRoot, {}, paths), /unsafe directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("evaluation inputs persist by digest and repeated writes verify identical immutable content", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-evaluation-input-store-"));
  const suite = "{\"cases\":[{\"query\":\"alpha\"}]}";
  try {
    const paths = fixturePaths(root);
    const first = persistCodebaseEvaluationInput(root, "evaluation_suites", suite, paths);
    const again = persistCodebaseEvaluationInput(root, "evaluation_suites", suite, paths);
    assert.deepEqual(again, first);
    assert.equal(first.path, join(projectStorageDirectory(paths, root), "codebase", "evaluation_suites", `${first.sha256}.json`));
    assert.equal(readFileSync(first.path, "utf8"), suite);
    if (process.platform !== "win32") assert.equal(lstatSync(first.path).mode & 0o777, 0o600);
    const config = persistCodebaseEvaluationInput(root, "evaluation_configs", Buffer.from("{\"schema_version\":1}"), paths);
    assert.equal(readFileSync(config.path, "utf8"), "{\"schema_version\":1}");
    writeFileSync(first.path, "changed");
    assert.throws(() => persistCodebaseEvaluationInput(root, "evaluation_suites", suite, paths), /content changed/);
    assert.throws(() => persistCodebaseEvaluationInput(root, "invalid" as never, suite, paths), /Unsupported/);
    assert.throws(() => persistCodebaseEvaluationInput(root, "evaluation_suites", suite, paths, () => {
      throw Object.assign(new Error("injected write failure"), { code: "EIO" });
    }), /injected write failure/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("evaluation inputs reject non-file and symlinked digest paths", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-evaluation-input-boundary-"));
  try {
    const paths = fixturePaths(root);
    const content = "suite";
    const suitePath = persistCodebaseEvaluationInput(root, "evaluation_suites", content, paths).path;
    rmSync(suitePath);
    mkdirSync(suitePath);
    assert.throws(() => persistCodebaseEvaluationInput(root, "evaluation_suites", content, paths), /unsafe file/);
    rmSync(suitePath, { recursive: true });
    if (process.platform !== "win32") {
      const external = join(root, "external"); writeFileSync(external, content);
      symlinkSync(external, suitePath);
      assert.throws(() => persistCodebaseEvaluationInput(root, "evaluation_suites", content, paths), /unsafe file/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
