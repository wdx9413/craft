import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { configuredClaudeExecutable, findClaudeExecutable } from "../core/interfaces/claude-executable.ts";

test("Claude executable discovery prefers a real binary over a shell shim", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-claude-path-")); const shim = join(root, "shim"), native = join(root, "native");
  mkdirSync(shim); mkdirSync(native);
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  const shell = join(shim, name), binary = join(native, name);
  writeFileSync(shell, "#!/bin/sh\n"); writeFileSync(binary, "binary"); chmodSync(shell, 0o755); chmodSync(binary, 0o755);
  const settings = join(root, "settings.json");
  try {
    assert.equal(findClaudeExecutable([shim, native].join(delimiter), process.platform, settings), binary);
    assert.equal(findClaudeExecutable(shim, process.platform, settings), shell);
    assert.throws(() => findClaudeExecutable(join(root, "missing"), process.platform, settings), /not found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude discovery ignores empty, relative and directory entries and can locate an exe filename", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-claude-entry-"));
  const settings = join(root, "settings.json");
  try {
    mkdirSync(join(root, "claude"));
    assert.throws(() => findClaudeExecutable(["", "relative-bin", root].join(delimiter), "darwin", settings), /not found/);
    const binary = join(root, "claude.exe");
    writeFileSync(binary, "MZ"); chmodSync(binary, 0o755);
    assert.equal(findClaudeExecutable(root, "win32", settings), binary);
    const shim = join(root, "claude.cmd");
    writeFileSync(shim, "@echo off\r\n"); chmodSync(shim, 0o755);
    rmSync(binary);
    // npm installs only the .cmd shim, so discovery must accept it.
    assert.equal(findClaudeExecutable(root, "win32", settings), shim);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude discovery prefers an explicit settings path and rejects an unusable path", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-claude-config-"));
  const settings = join(root, "settings.json"), binary = join(root, process.platform === "win32" ? "claude.exe" : "claude");
  writeFileSync(binary, "binary"); chmodSync(binary, 0o755);
  writeFileSync(settings, JSON.stringify({ workbench: { claudeExecutable: binary } }));
  try {
    assert.equal(configuredClaudeExecutable(settings), binary);
    assert.equal(findClaudeExecutable(join(root, "missing"), process.platform, settings), binary);
    writeFileSync(settings, JSON.stringify({ workbench: { claudeExecutable: join(root, "missing.exe") } }));
    assert.throws(() => findClaudeExecutable(join(root, "missing"), process.platform, settings), /not usable/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Restore an environment variable to exactly the state the test found it in. */
function withEnvironment(name: string, value: string | undefined, run: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { run(); }
  finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
}

test("an explicit Claude environment path beats settings and PATH discovery", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-claude-env-")));
  const codexStyle = join(root, "elsewhere", "claude.exe"), settings = join(root, "settings.json");
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  writeFileSync(codexStyle, "MZ", { mode: 0o755 });
  writeFileSync(settings, JSON.stringify({ workbench: { claudeExecutable: join(root, "from-settings.exe") } }));
  try {
    withEnvironment("CRAFT_CLAUDE_EXECUTABLE", codexStyle, () => {
      assert.equal(configuredClaudeExecutable(settings), codexStyle);
      // The environment path wins, so the settings file is never consulted.
      assert.equal(findClaudeExecutable("", "win32", settings), codexStyle);
    });
    // A relative override is a configuration error, not something to guess about.
    withEnvironment("CRAFT_CLAUDE_EXECUTABLE", "claude.exe", () => {
      assert.throws(() => configuredClaudeExecutable(settings), /must be an absolute path/u);
    });
    // An absolute override that is not runnable must not be handed to a spawn.
    withEnvironment("CRAFT_CLAUDE_EXECUTABLE", join(root, "missing.exe"), () => {
      assert.throws(() => findClaudeExecutable("", "win32", settings), /not usable/u);
    });
    // Whitespace-only is treated as absent, so PATH discovery still runs.
    withEnvironment("CRAFT_CLAUDE_EXECUTABLE", "   ", () => {
      assert.equal(configuredClaudeExecutable(settings), join(root, "from-settings.exe"));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
