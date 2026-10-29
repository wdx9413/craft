import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listWorkbenchDirectories } from "../core/interfaces/workbench-directories.ts";

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
