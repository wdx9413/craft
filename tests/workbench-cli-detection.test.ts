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

test("a real probe reports an execution error instead of inventing a version", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-detect-broken-"));
  const broken = join(root, process.platform === "win32" ? "broken.exe" : "broken-cli");
  writeFileSync(broken, "not an executable", { mode: 0o644 });
  const saved = { codex: process.env.CRAFT_CODEX_EXECUTABLE, claude: process.env.CRAFT_CLAUDE_EXECUTABLE };
  try {
    process.env.CRAFT_CODEX_EXECUTABLE = broken;
    process.env.CRAFT_CLAUDE_EXECUTABLE = broken;
    const result = await detectWorkbenchClis();
    assert.deepEqual(result.providers.map(item => item.id), ["codex", "claude"]);
    for (const item of result.providers) {
      assert.equal(item.version, null);
      assert.ok(["not_found", "error"].includes(item.status));
    }
  } finally {
    for (const [name, value] of [["CRAFT_CODEX_EXECUTABLE", saved.codex], ["CRAFT_CLAUDE_EXECUTABLE", saved.claude]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real probe's process failure reaches the error callback", async () => {
  const saved = {
    codex: process.env.CRAFT_CODEX_EXECUTABLE,
    claude: process.env.CRAFT_CLAUDE_EXECUTABLE,
    nodeOptions: process.env.NODE_OPTIONS,
  };
  try {
    // A usable executable plus an invalid child option makes execFile itself fail,
    // exercising the real probe's error callback without an injected run function.
    process.env.CRAFT_CODEX_EXECUTABLE = process.execPath;
    process.env.CRAFT_CLAUDE_EXECUTABLE = process.execPath;
    process.env.NODE_OPTIONS = "--craft-eval-invalid-node-option";
    const result = await detectWorkbenchClis();
    assert.deepEqual(result.providers.map(item => [item.id, item.status, item.version]),
      [["codex", "error", null], ["claude", "error", null]]);
  } finally {
    for (const [name, value] of [
      ["CRAFT_CODEX_EXECUTABLE", saved.codex],
      ["CRAFT_CLAUDE_EXECUTABLE", saved.claude],
      ["NODE_OPTIONS", saved.nodeOptions],
    ] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
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
