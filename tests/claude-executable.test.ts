import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { findClaudeExecutable } from "../core/interfaces/claude-executable.ts";

test("Claude executable discovery prefers a real binary over a shell shim", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-claude-path-")); const shim = join(root, "shim"), native = join(root, "native");
  mkdirSync(shim); mkdirSync(native);
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  const shell = join(shim, name), binary = join(native, name);
  writeFileSync(shell, "#!/bin/sh\n"); writeFileSync(binary, "binary"); chmodSync(shell, 0o755); chmodSync(binary, 0o755);
  try {
    assert.equal(findClaudeExecutable([shim, native].join(delimiter)), binary);
    assert.equal(findClaudeExecutable(shim), shell);
    assert.throws(() => findClaudeExecutable(join(root, "missing")), /not found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude discovery ignores empty, relative and directory entries and can locate an exe filename", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-claude-entry-"));
  try {
    mkdirSync(join(root, "claude"));
    assert.throws(() => findClaudeExecutable(["", "relative-bin", root].join(delimiter), "darwin"), /not found/);
    const binary = join(root, "claude.exe");
    writeFileSync(binary, "MZ"); chmodSync(binary, 0o755);
    assert.equal(findClaudeExecutable(root, "win32"), binary);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
