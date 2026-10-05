import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "yaml";

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
    assert.ok(![...files].some((file) => file.includes("node_modules/") || file.includes("src-tauri/target/") || file.startsWith(".serena/")));
  } finally { await rm(cache, { recursive: true, force: true }); }
});

test("manual desktop packaging stays artifact-only and Release upload has scoped credentials", async () => {
  const workflow = parse(await readFile(resolve(root, ".github/workflows/desktop-release.yml"), "utf8"));
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.attach.if, "github.event_name == 'release'");
  assert.equal(workflow.jobs.attach.permissions.contents, "write");
  const packageStep = workflow.jobs.package.steps.find((step: { name?: string }) => step.name === "Package desktop bundle");
  assert.ok(packageStep.run.includes("exec tauri build --bundles"));
  const upload = workflow.jobs.attach.steps.find((step: { name?: string }) => step.name === "Upload release assets");
  assert.equal(upload.env.RELEASE_TAG, "${{ github.event.release.tag_name }}");
  assert.ok(upload.run.includes('gh release upload "$RELEASE_TAG"'));
  assert.ok(!upload.run.includes("${{"));
});
