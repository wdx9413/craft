import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import { listWorkbenchDirectories, listWorkbenchFiles } from "../core/interfaces/workbench-directories.ts";

test("project picker lists only visible directories and rejects invalid paths", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-folder-picker-")));
  try {
    mkdirSync(join(root, "project")); mkdirSync(join(root, ".hidden")); writeFileSync(join(root, "file"), "x");
    if (process.platform !== "win32") symlinkSync(join(root, "project"), join(root, "link"));
    const result = await listWorkbenchDirectories(root);
    assert.equal(result.path, root); assert.deepEqual(result.directories, [{ name: "project", path: join(root, "project") }]); assert.equal(result.truncated, false);
    await assert.rejects(listWorkbenchDirectories("relative"), /invalid/);
    await assert.rejects(listWorkbenchDirectories(join(root, "file")), /not a folder/);
    await assert.rejects(listWorkbenchDirectories(join(root, "missing")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project picker falls back to the home directory and reports a null parent at the filesystem root", async () => {
  const home = await listWorkbenchDirectories();
  assert.equal(home.path, realpathSync(homedir()));
  const rootDirectory = parse(process.cwd()).root;
  const rootResult = await listWorkbenchDirectories(rootDirectory);
  assert.equal(rootResult.parent, null);
});

test("composer file search is bounded, skips heavy directories and rejects invalid limits", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-file-search-")));
  try {
    const project = join(root, "project");
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(project, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(project, ".hidden"), { recursive: true });
    writeFileSync(join(project, "README.md"), "# readme");
    writeFileSync(join(project, "src", "a.ts"), "export {}");
    writeFileSync(join(project, "node_modules", "pkg", "index.js"), "x");
    writeFileSync(join(project, ".hidden", "secret.txt"), "x");
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    if (process.platform === "win32") symlinkSync(outside, join(project, "linked"), "junction");
    else symlinkSync(outside, join(project, "linked"));
    const all = await listWorkbenchFiles(project, "", 200);
    assert.deepEqual(all.files.map(item => item.path), ["README.md", "src/a.ts"]);
    assert.equal(all.truncated, false);
    assert.deepEqual((await listWorkbenchFiles(project, "a.ts")).files.map(item => item.path), ["src/a.ts"]);
    assert.deepEqual((await listWorkbenchFiles(project, "not-present")).files, []);
    const limited = await listWorkbenchFiles(project, "", 1);
    assert.equal(limited.files.length, 1);
    assert.equal(limited.truncated, true);
    await assert.rejects(listWorkbenchFiles("relative"), /invalid/);
    await assert.rejects(listWorkbenchFiles(project, "x".repeat(257)), /file query is invalid/);
    await assert.rejects(listWorkbenchFiles(project, "", 0), /between 1 and 500/);
    await assert.rejects(listWorkbenchFiles(join(project, "README.md")), /not a folder/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("composer file search skips symlink and non-file directory entries", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-file-search-entries-")));
  try {
    const entries = [
      { name: "linked", isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false },
      { name: "socket", isDirectory: () => false, isSymbolicLink: () => false, isFile: () => false },
      { name: "kept.ts", isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true },
    ] as unknown as Dirent[];
    const readEntries = (async () => entries) as unknown as Parameters<typeof listWorkbenchFiles>[3];
    const result = await listWorkbenchFiles(root, "", 200, readEntries);
    assert.deepEqual(result.files.map(item => item.path), ["kept.ts"]);
    assert.equal(result.truncated, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
