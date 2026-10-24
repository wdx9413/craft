import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { ProjectAnalysisCache } from "../capability/craft-codebase/project-analysis-cache.ts";
import { craftPaths, ensureProjectStorageDirectory, projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";

test("project analysis caches are workspace-bound, atomic, digest-checked and removable", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-analysis-cache-"));
  try {
    const project = join(root, "project");
    mkdirSync(project); mkdirSync(join(root, "data"));
    const paths = craftPaths(join(root, "data"));
    const fileRoot = join(root, "not-a-directory");
    writeFileSync(fileRoot, "file");
    assert.throws(() => new ProjectAnalysisCache(fileRoot, "workspace-file", paths), /root must be a directory/u);
    const cache = new ProjectAnalysisCache(project, "workspace-1", paths);
    new ProjectAnalysisCache(project, "workspace-1", paths);
    assert.equal(cache.directory.startsWith(join(projectStorageDirectory(paths, project), "codebase")), true);
    assert.equal(cache.directory.startsWith(join(project, ".craft_data")), false);
    const kind = "codebase_semantic_file_analysis", id = "codebase_semantic_file_0123456789abcdef01234567";
    assert.equal(cache.find(kind, id), null);
    const first = cache.save(kind, id, { workspace_id: "workspace-1", path: "src/a.ts", unit_digest: "unit-1", nodes: [] });
    assert.equal(first.version, 1);
    assert.equal(cache.find(kind, id)?.unit_digest, "unit-1");
    assert.equal(cache.save(kind, id, { workspace_id: "workspace-1", path: "src/a.ts", unit_digest: "unit-1", nodes: [] }).version, 1,
      "concurrent duplicate analysis must reuse an identical cache record");
    const updated = cache.save(kind, id, { workspace_id: "workspace-1", path: "src/a.ts", unit_digest: "unit-2", nodes: [] });
    assert.equal(updated.version, 2);
    assert.deepEqual(cache.list(kind, 1).map(record => record.id), [id]);
    assert.throws(() => cache.list(kind, 0), /between 1 and 10000/u);
    assert.throws(() => cache.list(kind, 10_001), /between 1 and 10000/u);
    cache.save(kind, "codebase_semantic_file_1123456789abcdef01234567", { workspace_id: "workspace-1", path: "src/b.ts" });
    assert.throws(() => cache.list(kind, 1), /exceeds requested limit/u);
    cache.save("codebase_file_analysis", "codebase_file_4123456789abcdef01234567", { path: "src/c.ts" });
    writeFileSync(join(cache.directory, "unrelated.tmp"), "ignored");
    writeFileSync(join(cache.directory, `${kind}--ignored.tmp`), "ignored");
    assert.equal(cache.list(kind, 10).length, 2);
    assert.throws(() => cache.save(kind, id, { workspace_id: "other-workspace" }), /workspace mismatch/u);
    assert.throws(() => cache.find("unsupported", id), /Unsupported/u);
    assert.throws(() => cache.list("unsupported", 10), /Unsupported/u);
    assert.throws(() => cache.save("unsupported", id, {}), /Unsupported/u);
    assert.throws(() => cache.remove("unsupported", id), /Unsupported/u);
    assert.throws(() => cache.find(kind, "../escape"), /Invalid/u);
    assert.throws(() => cache.save(kind, "../escape", {}), /Invalid/u);
    assert.throws(() => cache.remove(kind, "../escape"), /Invalid/u);
    assert.equal(cache.remove(kind, id), true);
    assert.equal(cache.remove(kind, id), false);
    assert.throws(() => new ProjectAnalysisCache(project, "bad workspace", paths), /Invalid Codebase workspace/u);

    const corruptId = "codebase_semantic_file_2123456789abcdef01234567";
    const corruptPath = join(cache.directory, `${kind}--${corruptId}.json`);
    const saved = cache.save(kind, corruptId, { path: "src/c.ts" });
    const raw = JSON.parse(readFileSync(corruptPath, "utf8")) as JsonObject;
    for (const invalid of [
      { ...raw, format: "other" }, { ...raw, kind: "codebase_python_file_analysis" }, { ...raw, workspace_id: "other" },
      { ...raw, id: "other" }, { ...raw, version: 1.5 }, { ...raw, version: 0 }, { ...raw, payload: null },
      { ...raw, payload: [] }, { ...raw, payload: "invalid" }, { ...raw, payload_digest: "sha256:wrong" },
    ]) {
      writeFileSync(corruptPath, JSON.stringify(invalid));
      assert.equal(cache.find(kind, corruptId), null, "corrupt derived caches must be recomputed from the pinned source snapshot");
    }
    const recovered = cache.save(kind, corruptId, { path: "src/c.ts", unit_digest: "recovered", nodes: [] });
    assert.equal(recovered.version, 1);
    assert.equal(cache.find(kind, corruptId)?.unit_digest, "recovered");
    assert.equal(saved.id, corruptId);

    const invalidJsonId = "codebase_semantic_file_3123456789abcdef01234567";
    const invalidJsonPath = join(cache.directory, `${kind}--${invalidJsonId}.json`);
    for (const value of ["{", "null", "[]", "1"]) {
      writeFileSync(invalidJsonPath, value);
      assert.equal(cache.find(kind, invalidJsonId), null);
    }
    assert.equal(cache.list(kind, 10).some(record => record.id === invalidJsonId), false, "invalid cache files must not enter analyzer reuse");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project analysis cache refuses linked roots and cache records", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-analysis-cache-links-"));
  try {
    const linkedRoot = join(root, "linked-root"), realRoot = join(root, "real-root");
    mkdirSync(realRoot); mkdirSync(join(root, "data"));
    const paths = craftPaths(join(root, "data"));
    symlinkSync(realRoot, linkedRoot);
    assert.equal(new ProjectAnalysisCache(linkedRoot, "workspace-1", paths).directory,
      new ProjectAnalysisCache(realRoot, "workspace-1", paths).directory);

    const cache = new ProjectAnalysisCache(realRoot, "workspace-2", paths);
    const kind = "codebase_file_analysis", id = "codebase_file_0123456789abcdef01234567";
    const outside = join(root, "outside.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, join(cache.directory, `${kind}--${id}.json`));
    assert.throws(() => cache.find(kind, id), /record is unsafe/u);
    assert.throws(() => cache.remove(kind, id), /record is unsafe/u);
    rmSync(join(cache.directory, `${kind}--${id}.json`));
    mkdirSync(join(cache.directory, `${kind}--${id}.json`));
    assert.throws(() => cache.find(kind, id), /record is unsafe/u);

    const outsideDirectory = join(root, "outside-directory");
    mkdirSync(outsideDirectory);
    const linkedDataRoot = join(root, "linked-data-root");
    mkdirSync(linkedDataRoot);
    symlinkSync(outsideDirectory, join(linkedDataRoot, "projects"));
    assert.throws(() => new ProjectAnalysisCache(realRoot, "workspace-3", craftPaths(linkedDataRoot)), /regular directories/u);

    const linkedWorkspaceRoot = join(root, "linked-workspace-root");
    mkdirSync(linkedWorkspaceRoot);
    const indexes = join(ensureProjectStorageDirectory(paths, linkedWorkspaceRoot), "codebase", "indexes");
    mkdirSync(indexes, { recursive: true });
    symlinkSync(outsideDirectory, join(indexes, "workspace-4"));
    assert.throws(() => new ProjectAnalysisCache(linkedWorkspaceRoot, "workspace-4", paths), /cache path is unsafe/u);

    const linkedCacheRoot = join(root, "linked-cache-root");
    mkdirSync(linkedCacheRoot);
    const workspaceRoot = join(ensureProjectStorageDirectory(paths, linkedCacheRoot), "codebase", "indexes", "workspace-5");
    mkdirSync(workspaceRoot, { recursive: true });
    symlinkSync(outsideDirectory, join(workspaceRoot, "analysis_cache"));
    assert.throws(() => new ProjectAnalysisCache(linkedCacheRoot, "workspace-5", paths), /cache path is unsafe/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("parallel processes can publish the same cold analysis cache without a shared writer lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-analysis-cache-race-"));
  try {
    const project = join(root, "project"), data = join(root, "data");
    mkdirSync(project); mkdirSync(data);
    const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../capability/craft-codebase/project-analysis-cache.ts")).href;
    const pathsUrl = pathToFileURL(resolve(import.meta.dirname, "../common/craft-common-store-local/src/paths.ts")).href;
    const script = `import { ProjectAnalysisCache } from ${JSON.stringify(moduleUrl)}; import { craftPaths } from ${JSON.stringify(pathsUrl)}; new ProjectAnalysisCache(process.argv[1], "workspace-race", craftPaths(process.argv[2])).save("codebase_file_analysis", "codebase_file_0123456789abcdef01234567", { path: "src/race.ts", source_digest: "same", nodes: [] });`;
    const run = () => new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, project, data], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", rejectRun);
      child.once("exit", code => code === 0 ? resolveRun() : rejectRun(new Error(`cache publisher exited ${String(code)}: ${stderr}`)));
    });
    await Promise.all([run(), run()]);
    const cache = new ProjectAnalysisCache(project, "workspace-race", craftPaths(data));
    const record = cache.find("codebase_file_analysis", "codebase_file_0123456789abcdef01234567");
    assert.equal(record?.source_digest, "same");
    assert.deepEqual(record?.nodes, []);
    assert.equal(record?.version, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
