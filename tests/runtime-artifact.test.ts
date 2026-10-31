import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { prepareRuntimeArtifact } from "../scripts/release/runtime-artifact.ts";

test("built public runtime declarations type-check without skipping dependency declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-public-types-"));
  try {
    await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
      "--strict", "--noEmit", "--module", "NodeNext", "--target", "ES2024", "--skipLibCheck", "false",
      fileURLToPath(new URL("../dist/core/runtime-api.d.ts", import.meta.url)),
    ], { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-artifact-"));
  const manifest: Record<string, unknown> = { files: ["dist/core"] };
  const artifact = { npm_files: ["dist/core"], runtime_copies: [{ source: "input", target: "dist/core/entry.js" }] };
  await writeFile(join(root, "input"), "compiled-runtime");
  await mkdir(join(root, "dist/runtime/app"), { recursive: true });
  await writeFile(join(root, "dist/runtime/app", "previous"), "preserve-until-preflight");
  async function configure() {
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    await writeFile(join(root, "runtime-artifacts.json"), JSON.stringify(artifact));
  }
  async function dependency(path: string, version: string, dependencies?: Record<string, string>) {
    const folder = join(root, "node_modules", path);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "package.json"), JSON.stringify({ version, dependencies }));
  }
  await configure();
  return { root, manifest, artifact, configure, dependency, close: () => rm(root, { recursive: true, force: true }) };
}

test("staged runtime binary is writable for repeated desktop resource copies", { skip: process.platform === "win32" }, async () => {
  const f = await fixture(); const binary = join(f.root, "runtime-node");
  try {
    await writeFile(binary, "runtime"); await chmod(binary, 0o555);
    const result = await prepareRuntimeArtifact(f.root, binary);
    assert.equal((await stat(binary)).mode & 0o777, 0o555);
    assert.equal((await stat(join(result, "runtime-node"))).mode & 0o777, 0o755);
    await prepareRuntimeArtifact(f.root, binary);
    assert.equal(await readFile(join(result, "runtime-node"), "utf8"), "runtime");
  } finally { await f.close(); }
});

test("runtime artifact consumes npm graph and copies actual dependency bytes with repeat/cycle deduplication", async () => {
  const f = await fixture();
  try {
    f.manifest.dependencies = { alpha: "1", beta: "1", "@local/scoped": "1" };
    await f.dependency("alpha", "1", { beta: "1" });
    await f.dependency("beta", "1", { alpha: "1" });
    await f.dependency("@local/scoped", "1");
    await f.configure();
    const result = await prepareRuntimeArtifact(f.root);
    assert.equal(await readFile(join(result, "dist/core/entry.js"), "utf8"), "compiled-runtime");
    assert.equal(JSON.parse(await readFile(join(result, "node_modules/beta/package.json"), "utf8")).version, "1");
    await assert.rejects(readFile(join(result, "previous")), /ENOENT/);
  } finally { await f.close(); }
});

test("runtime artifact resolves packages that do not export package.json", async () => {
  const f = await fixture();
  try {
    f.manifest.dependencies = { locked: "1" };
    const folder = join(f.root, "node_modules", "locked");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: "locked", version: "1", exports: { ".": "./index.js" } }));
    await writeFile(join(folder, "index.js"), "export default 1;");
    await f.configure();
    const result = await prepareRuntimeArtifact(f.root);
    assert.equal(await readFile(join(result, "node_modules/locked/index.js"), "utf8"), "export default 1;");
  } finally { await f.close(); }
});

test("an external consumer owns staging without copying presentation into the runtime", async () => {
  const f = await fixture();
  const consumer = await mkdtemp(join(tmpdir(), "craft-presentation-"));
  try {
    const output = await prepareRuntimeArtifact(f.root, process.execPath, consumer);
    assert.equal(output, join(realpathSync(consumer), "dist/runtime/app"));
    assert.equal(await readFile(join(output, "dist/core/entry.js"), "utf8"), "compiled-runtime");
    assert.equal(await readFile(join(f.root, "dist/runtime/app/previous"), "utf8"), "preserve-until-preflight");
    await rm(join(consumer, "dist"), { recursive: true });
    await symlink(join(f.root, "dist"), join(consumer, "dist"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(prepareRuntimeArtifact(f.root, process.execPath, consumer), /symlink escapes/);
    assert.equal(await readFile(join(f.root, "dist/runtime/app/previous"), "utf8"), "preserve-until-preflight");
  } finally { await f.close(); await rm(consumer, { recursive: true, force: true }); }
});

test("package resolution handles nested entrypoints and rejects invalid exports or unowned entrypoints", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "craft-unowned-entry-"));
  try {
    f.manifest.dependencies = { nested: "1" };
    const folder = join(f.root, "node_modules/nested");
    await mkdir(join(folder, "dist/nested"), { recursive: true });
    await writeFile(join(folder, "dist/nested/index.js"), "export default 1");
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: "nested", version: "1", exports: { ".": "./dist/nested/index.js" } }));
    await f.configure();
    await prepareRuntimeArtifact(f.root);
    f.manifest.dependencies = { invalid: "1" }; await f.configure();
    const invalid = join(f.root, "node_modules/invalid"); await mkdir(invalid);
    await writeFile(join(invalid, "package.json"), JSON.stringify({ name: "invalid", exports: { "./package.json": "../outside.json" } }));
    await assert.rejects(prepareRuntimeArtifact(f.root), /Invalid.*target|ERR_INVALID_PACKAGE_TARGET/);
    await writeFile(join(outside, "index.js"), "export default 1");
    f.manifest.dependencies = { escaped: "1" }; await f.configure();
    const escaped = join(f.root, "node_modules/escaped"); await mkdir(escaped);
    await symlink(join(outside, "index.js"), join(escaped, "escaped.js"));
    await writeFile(join(escaped, "package.json"), JSON.stringify({ name: "escaped", exports: { ".": "./escaped.js" } }));
    await assert.rejects(prepareRuntimeArtifact(f.root), /ENOENT|identity conflict/);
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

test("runtime artifact resolves seven declared workspace packages without node_modules links", async () => {
  const f = await fixture();
  const names = ["craft-common-store-local", "craft-common-base", "craft-common-log", "@craft/capability-knowledge", "@craft/capability-memory", "@craft/capability-experience", "@craft/capability-codebase"];
  try {
    f.manifest.dependencies = Object.fromEntries(names.map(name => [name, "0.12.42"]));
    for (const name of names) {
      const folder = name.startsWith("@craft/") ? join(f.root, "capability", `craft-${name.slice("@craft/capability-".length)}`) : join(f.root, "common", name);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "package.json"), JSON.stringify({ name, version: "0.12.42" }));
    }
    await f.configure();
    const result = await prepareRuntimeArtifact(f.root);
    for (const name of names) assert.equal(JSON.parse(await readFile(join(result, "node_modules", name, "package.json"), "utf8")).name, name);
    await writeFile(join(f.root, "common", "craft-common-base", "package.json"), JSON.stringify({ name: "wrong", version: "0.12.42" }));
    await assert.rejects(prepareRuntimeArtifact(f.root), /identity conflict/);
    await rm(join(f.root, "common", "craft-common-base", "package.json"));
    await assert.rejects(prepareRuntimeArtifact(f.root), /MODULE_NOT_FOUND|Cannot find module/);
    f.manifest.dependencies = { "unavailable-package": "1" }; await f.configure();
    await assert.rejects(prepareRuntimeArtifact(f.root), /MODULE_NOT_FOUND|Cannot find module/);
    f.manifest.dependencies = { "hidden-package": "1" }; await f.dependency("hidden-package", "1");
    await writeFile(join(f.root, "node_modules", "hidden-package", "package.json"), JSON.stringify({ name: "hidden-package", version: "1", exports: {} }));
    await f.configure();
    await assert.rejects(prepareRuntimeArtifact(f.root), /ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/);
  } finally { await f.close(); }
});

test("preflight rejects contract/path/target/dependency drift without deleting existing staging", async () => {
  const f = await fixture();
  const preserved = async () => assert.equal(await readFile(join(f.root, "dist/runtime/app/previous"), "utf8"), "preserve-until-preflight");
  try {
    f.manifest.files = [];
    await f.configure();
    await assert.rejects(prepareRuntimeArtifact(f.root), /contract drift/); await preserved();
    f.manifest.files = ["dist/core"];
    for (const path of [".", "../escape"]) {
      f.artifact.runtime_copies[0].target = path; await f.configure();
      await assert.rejects(prepareRuntimeArtifact(f.root), /inside its product/); await preserved();
    }
    f.artifact.runtime_copies[0].target = "dist/core/entry.js";
    f.artifact.runtime_copies.push({ ...f.artifact.runtime_copies[0] }); await f.configure();
    await assert.rejects(prepareRuntimeArtifact(f.root), /Duplicate/); await preserved();
    f.artifact.runtime_copies.pop(); f.artifact.runtime_copies[0].source = "../escape"; await f.configure();
    await assert.rejects(prepareRuntimeArtifact(f.root), /inside its product/); await preserved();
    f.artifact.runtime_copies[0].source = "missing"; await f.configure();
    await assert.rejects(prepareRuntimeArtifact(f.root), /ENOENT/); await preserved();
    f.artifact.runtime_copies[0].source = "input";
    f.manifest.dependencies = { "../escape": "1" }; await f.configure();
    await assert.rejects(prepareRuntimeArtifact(f.root), /package name/); await preserved();
    f.manifest.dependencies = { alpha: "1", beta: "1" };
    await f.dependency("alpha", "1", { beta: "2" });
    await f.dependency("beta", "1");
    await f.dependency("alpha/node_modules/beta", "2"); await f.configure();
    await assert.rejects(prepareRuntimeArtifact(f.root), /collision/); await preserved();
    await f.dependency("alpha/node_modules/beta", "1");
    await assert.rejects(prepareRuntimeArtifact(f.root), /collision/); await preserved();
    delete f.manifest.dependencies; await f.configure();
    await assert.rejects(prepareRuntimeArtifact(f.root, join(f.root, "missing-binary")), /ENOENT/); await preserved();
    await prepareRuntimeArtifact(f.root, process.execPath);
  } finally { await f.close(); }
});

test("artifact source and generated output cannot escape through filesystem symlinks", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "craft-artifact-outside-"));
  try {
    await writeFile(join(outside, "input"), "outside");
    await symlink(join(outside, "input"), join(f.root, "linked-input"));
    f.artifact.runtime_copies[0].source = "linked-input";
    await f.configure();
    await assert.rejects(prepareRuntimeArtifact(f.root), /symlink escapes/);
    f.artifact.runtime_copies[0].source = "input";
    await f.configure();
    await rm(join(f.root, "dist/runtime/app"), { recursive: true });
    await symlink(outside, join(f.root, "dist/runtime/app"), "junction");
    await assert.rejects(prepareRuntimeArtifact(f.root), /symlink escapes/);
    assert.equal(await readFile(join(outside, "input"), "utf8"), "outside");
    await rm(join(f.root, "dist/runtime/app"));
    await rm(join(f.root, "dist/runtime"), { recursive: true });
    assert.ok(await prepareRuntimeArtifact(f.root));
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});
