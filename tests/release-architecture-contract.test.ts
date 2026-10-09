import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("npm publication actually includes the offline OCR models and compiled graph", async () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // dry-run examines the real npm file selection without executing prepack,
  // creating a tarball, installing dependencies, or contacting the registry.
  const cache = await mkdtemp(join(tmpdir(), "craft-pack-cache-"));
  try {
    const { stdout } = await promisify(execFile)(npm, ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", cache], { cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, shell: process.platform === "win32" });
    const [result] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const files = new Set(result.files.map((file) => file.path));
    for (const file of ["assets/ocr/eng.traineddata", "assets/ocr/chi_sim.traineddata", "dist/core/cli.js", "dist/bin/craft-mcp.js", "dist/capability/craft-memory/capability.js", "dist/adapters/deepseek-harness/package.json", "dist/adapters/deepseek-harness/dist/index.js", "runtime-artifacts.json"]) assert.ok(files.has(file), `npm package is missing ${file}`);
    assert.ok(![...files].some((file) => file.includes("node_modules/") || file.includes("src-tauri/target/") || file.startsWith(".serena/") || file.startsWith("workbench/") || file.startsWith("desktop/") || file.startsWith("dist/workbench/")));
  } finally { await rm(cache, { recursive: true, force: true }); }
});

test("core no longer has an automatic desktop release workflow", async () => {
  await assert.rejects(access(resolve(root, ".github/workflows/desktop-release.yml")), /ENOENT/);
});
