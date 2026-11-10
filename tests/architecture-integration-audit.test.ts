import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("architecture integration audit checks the paths declared in the map", t => {
  const workspace = mkdtempSync(join(tmpdir(), "craft-map-audit-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const craft = join(workspace, "craft"), scripts = join(craft, "scripts/ci"), docs = join(craft, "docs/product");
  mkdirSync(scripts, { recursive: true }); mkdirSync(docs, { recursive: true });
  copyFileSync(resolve(import.meta.dirname, "../scripts/ci/audit-capability-map.ts"), join(scripts, "audit-capability-map.ts"));
  for (const name of ["craft-workbench", "craft-eval"]) { mkdirSync(join(workspace, name)); writeFileSync(join(workspace, name, "entry.ts"), ""); }
  const map = join(docs, "capability-architecture-map.zh-CN.md");
  const link = (name: string, path: string) => `[entry](https://github.com/wdx9413/${name}/blob/main/${path})`;
  const run = () => spawnSync(process.execPath, [join(scripts, "audit-capability-map.ts"), workspace], { encoding: "utf8" });
  writeFileSync(map, `${link("craft-workbench", "entry.ts")}\n${link("craft-eval", "entry.ts")}\n`);
  assert.equal(run().status, 0);
  writeFileSync(map, `${link("craft-workbench", "entry.ts")}\n${link("craft-eval", "entry.ts")}\nhttps://github.com/wdx9413/craft-workbench/blob/maim/entry.ts\n`);
  let malformed = run(); assert.equal(malformed.status, 1); assert.match(malformed.stderr, /malformed architecture link/);
  writeFileSync(map, `${link("craft-workbench", "entry.ts")}\n${link("craft-eval", "entry.ts")}\nhttps://github.com/wdx9413/craft-workbenhc/blob/main/entry.ts\n`);
  malformed = run(); assert.equal(malformed.status, 1); assert.match(malformed.stderr, /unknown declared repository/);
  writeFileSync(map, `${link("craft-workbench", "entry.ts")}\n${link("craft-eval", "entry.ts")}\n`);
  rmSync(join(workspace, "craft-eval", "entry.ts"));
  let result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /craft-eval: unavailable architecture anchor entry.ts/);
  writeFileSync(map, `${link("craft-workbench", "../outside")}\n`);
  result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /malformed architecture link/); assert.match(result.stderr, /no declared architecture anchors/);
  writeFileSync(map, `${link("craft-workbench", "entry.ts")}\n${link("craft-eval", ".")}\n`);
  result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /malformed architecture link/);
});
