import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { rootDesignDocuments } from "../scripts/ci/root-design-documents.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "craft-root-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "DESIGN.md"), "# Design\n");
  writeFileSync(join(root, "UX-CONTRACT.md"), "# UX\n");
  return root;
}

test("root design contracts are mandatory regular files in a fixed order", (t) => {
  const root = fixture(t);
  assert.deepEqual(rootDesignDocuments(root), [join(root, "DESIGN.md"), join(root, "UX-CONTRACT.md")]);
  for (const name of ["DESIGN.md", "UX-CONTRACT.md"]) {
    const file = join(root, name);
    rmSync(file);
    assert.throws(() => rootDesignDocuments(root), /ENOENT/);
    mkdirSync(file);
    assert.throws(() => rootDesignDocuments(root), /must be a regular file/);
    rmSync(file, { recursive: true });
    writeFileSync(file, "# Restored\n");
  }
});

test("a root contract link cannot redirect the gate to another directory", (t) => {
  const root = fixture(t);
  const target = join(root, "other");
  mkdirSync(target);
  rmSync(join(root, "DESIGN.md"));
  // Junctions do not require Windows Developer Mode; other OSes use a symlink.
  symlinkSync(target, join(root, "DESIGN.md"), "junction");
  assert.throws(() => rootDesignDocuments(root), /must be a regular file: DESIGN.md/);
});

test("the real audit CLI checks root links and retains docs and ADR failures", (t) => {
  const root = fixture(t);
  const scripts = join(root, "scripts", "ci");
  mkdirSync(scripts, { recursive: true });
  const source = resolve(import.meta.dirname, "..", "scripts", "ci");
  for (const name of ["check-doc-links.ts", "root-design-documents.ts"]) copyFileSync(join(source, name), join(scripts, name));
  const adr = join(root, "docs", "adr");
  mkdirSync(adr, { recursive: true });
  writeFileSync(join(root, "docs", "README.md"), "[ADR](adr/README.md)\n");
  writeFileSync(join(adr, "README.md"), "[Decision](0001-test.md)\n");
  writeFileSync(join(adr, "0001-test.md"), "# Decision\n");
  writeFileSync(join(root, "DESIGN.md"), "[Contract](UX-CONTRACT.md)\n");
  const run = () => spawnSync(process.execPath, [join(scripts, "check-doc-links.ts")], { cwd: root, encoding: "utf8", timeout: 10_000 });
  let result = run(); assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 internal link\(s\) across 5 document\(s\)/);
  writeFileSync(join(root, "UX-CONTRACT.md"), "[Retired](studio/missing.ts)\n");
  result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /UX-CONTRACT.md.*studio\/missing.ts/);
  writeFileSync(join(root, "UX-CONTRACT.md"), "[Directory](docs)\n");
  result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /resolves to a directory/);
  writeFileSync(join(root, "UX-CONTRACT.md"), "# UX\n");
  writeFileSync(join(root, "docs", "README.md"), "[Broken](missing.md)\n");
  result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /docs\/README.md.*missing.md/);
  writeFileSync(join(root, "docs", "README.md"), "# Docs\n");
  writeFileSync(join(adr, "README.md"), "[Missing](0002-gone.md)\n");
  result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /missing from the index/); assert.match(result.stderr, /no record behind/);
  writeFileSync(join(adr, "README.md"), "[Decision](0001-test.md)\n");
  rmSync(join(root, "DESIGN.md"));
  result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /ENOENT/);
});
