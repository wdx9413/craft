import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareRuntimeArtifact } from "../scripts/release/runtime-artifact.ts";

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

test("runtime artifact resolves seven declared workspace packages without node_modules links", async () => {
  const f = await fixture();
  const names = ["craft-common-store-local", "craft-common-base", "craft-common-log", "@craft/capability-knowledge", "@craft/capability-memory", "@craft/capability-experience", "@craft/capability-codebase"];
  try {
    f.manifest.dependencies = Object.fromEntries(names.map(name => [name, "0.12.41"]));
    for (const name of names) {
      const folder = name.startsWith("@craft/") ? join(f.root, "capability", `craft-${name.slice("@craft/capability-".length)}`) : join(f.root, "common", name);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "package.json"), JSON.stringify({ name, version: "0.12.41" }));
    }
    await f.configure();
    const result = await prepareRuntimeArtifact(f.root);
    for (const name of names) assert.equal(JSON.parse(await readFile(join(result, "node_modules", name, "package.json"), "utf8")).name, name);
    await writeFile(join(f.root, "common", "craft-common-base", "package.json"), JSON.stringify({ name: "wrong", version: "0.12.41" }));
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
