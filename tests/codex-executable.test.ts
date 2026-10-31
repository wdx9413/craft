import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { configuredCodexExecutable, findCodexExecutable, resolveCodexExecutable } from "../core/interfaces/codex-executable.ts";

test("Windows Codex discovery uses a direct binary or the official npm package binary", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-codex-win-")));
  const directDir = join(root, "direct"), npmDir = join(root, "npm");
  const vendorDir = join(npmDir, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
  const bundledDir = join(npmDir, "node_modules", "@openai", "codex", "vendor", "aarch64-pc-windows-msvc", "bin");
  mkdirSync(directDir, { recursive: true }); mkdirSync(vendorDir, { recursive: true }); mkdirSync(bundledDir, { recursive: true });
  const direct = join(directDir, "codex.exe"), vendor = join(vendorDir, "codex.exe"), bundled = join(bundledDir, "codex.exe");
  writeFileSync(direct, "binary", { mode: 0o755 }); writeFileSync(vendor, "binary", { mode: 0o755 }); writeFileSync(bundled, "binary", { mode: 0o755 });
  writeFileSync(join(npmDir, "node_modules", "@openai", "codex-win32-x64", "package.json"), '{"name":"@openai/codex-win32-x64"}');
  try {
    assert.equal(findCodexExecutable([directDir, npmDir].join(delimiter), "win32", "x64"), direct);
    assert.equal(findCodexExecutable(npmDir, "win32", "x64"), vendor);
    assert.equal(findCodexExecutable(npmDir, "win32", "arm64"), bundled);
    assert.throws(() => findCodexExecutable(npmDir, "win32", "ia32"), /not found/);
    assert.throws(() => findCodexExecutable("relative", "win32", "x64"), /not found/);
    const directoryOnly = join(root, "directory-only"); mkdirSync(join(directoryOnly, "codex.exe"), { recursive: true });
    assert.throws(() => findCodexExecutable([directoryOnly, ""].join(delimiter), "win32", "x64"), /not found/);
    assert.equal(findCodexExecutable("", "linux", "x64"), "codex");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("configured Codex executable wins over PATH and fails loudly when unusable", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "craft-codex-config-")));
  const codex = join(root, "codex.exe"), settings = join(root, "settings.json");
  writeFileSync(codex, "binary", { mode: 0o755 });
  try {
    writeFileSync(settings, JSON.stringify({ workbench: { codexExecutable: codex } }));
    assert.equal(configuredCodexExecutable(settings), codex);
    writeFileSync(settings, "\uFEFF" + JSON.stringify({ workbench: { codexExecutable: codex } }));
    assert.equal(configuredCodexExecutable(settings), codex);
    assert.equal(resolveCodexExecutable("", "win32", "x64", settings), codex);
    writeFileSync(settings, JSON.stringify({ workbench: { codexExecutable: join(root, "missing.exe") } }));
    assert.throws(() => resolveCodexExecutable("", "win32", "x64", settings), /not usable/u);
    const previous = process.env.CRAFT_CODEX_EXECUTABLE;
    process.env.CRAFT_CODEX_EXECUTABLE = codex;
    try { assert.equal(configuredCodexExecutable(settings), codex); }
    finally { if (previous === undefined) delete process.env.CRAFT_CODEX_EXECUTABLE; else process.env.CRAFT_CODEX_EXECUTABLE = previous; }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
