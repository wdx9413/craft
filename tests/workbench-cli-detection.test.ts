import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { detectWorkbenchClis } from "../core/interfaces/workbench-cli-detection.ts";

test("CLI detection distinguishes missing, invalid and usable executables", async () => {
  const usable = await detectWorkbenchClis(async command => command === "codex" ? "codex 1.2.3\n" : Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })));
  assert.deepEqual(usable.providers.map(item => [item.id, item.status, item.version]), [["codex", "available", "codex 1.2.3"], ["claude", "not_found", null]]);
  const failed = await detectWorkbenchClis(async command => command === "codex" ? " " : Promise.reject(new Error("failed")));
  assert.deepEqual(failed.providers.map(item => item.status), ["error", "error"]);
  const long = await detectWorkbenchClis(async () => "x".repeat(300));
  assert.equal(long.providers[0].version?.length, 256);
});

test("real CLI probes complete without exposing environment contents", async () => {
  const result = await detectWorkbenchClis();
  assert.deepEqual(result.providers.map(item => item.id), ["codex", "claude"]);
  for (const item of result.providers) assert.ok(["available", "not_found", "error"].includes(item.status));
});

test("Claude detection uses the executable selected by the session runtime", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-detect-"));
  const shim = join(root, "shim"), native = join(root, "native");
  mkdirSync(shim); mkdirSync(native);
  writeFileSync(join(shim, "claude"), "#!/bin/sh\nexit 1\n"); chmodSync(join(shim, "claude"), 0o755);
  symlinkSync(process.execPath, join(native, "claude"));
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = [shim, native].join(delimiter);
    const result = await detectWorkbenchClis();
    assert.equal(result.providers[1].status, "available");
    assert.match(result.providers[1].version!, /^v\d/);
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); }
});
