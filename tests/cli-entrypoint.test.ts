import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("CLI executes through a linked installation directory instead of silently exiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craft-cli-entry-"));
  try {
    const linked = join(directory, "installed");
    await symlink(resolve(import.meta.dirname, ".."), linked, process.platform === "win32" ? "junction" : "dir");
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(linked, "core", "cli.ts"), "--help"], { timeout: 15_000 });
    assert.match(stdout, /Usage:/u);
    assert.doesNotMatch(stderr, /craft: /u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
