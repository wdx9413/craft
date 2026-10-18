import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { ProjectAnalysisCache } from "../capability/craft-codebase/project-analysis-cache.ts";

test("project analysis caches are workspace-bound, atomic, digest-checked and removable", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-analysis-cache-"));
  try {
    const fileRoot = join(root, "not-a-directory");
    writeFileSync(fileRoot, "file");
    assert.throws(() => new ProjectAnalysisCache(fileRoot, "workspace-file"), /root is unsafe/u);
    const cache = new ProjectAnalysisCache(root, "workspace-1");
    new ProjectAnalysisCache(root, "workspace-1");
    const kind = "codebase_semantic_file_analysis", id = "codebase_semantic_file_0123456789abcdef01234567";
    assert.equal(cache.find(kind, id), null);
    const first = cache.save(kind, id, { workspace_id: "workspace-1", path: "src/a.ts", unit_digest: "unit-1", nodes: [] });
    assert.equal(first.version, 1);
    assert.equal(cache.find(kind, id)?.unit_digest, "unit-1");
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
    assert.throws(() => new ProjectAnalysisCache(root, "bad workspace"), /Invalid Codebase workspace/u);

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
      assert.throws(() => cache.find(kind, corruptId), /integrity failure/u);
    }
    assert.equal(saved.id, corruptId);

    const invalidJsonId = "codebase_semantic_file_3123456789abcdef01234567";
    const invalidJsonPath = join(cache.directory, `${kind}--${invalidJsonId}.json`);
    for (const value of ["{", "null", "[]", "1"]) {
      writeFileSync(invalidJsonPath, value);
      if (value === "{") assert.throws(() => cache.find(kind, invalidJsonId), SyntaxError);
      else assert.throws(() => cache.find(kind, invalidJsonId), /record is invalid/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project analysis cache refuses linked roots and cache records", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-analysis-cache-links-"));
  try {
    const linkedRoot = join(root, "linked-root"), realRoot = join(root, "real-root");
    mkdirSync(realRoot);
    symlinkSync(realRoot, linkedRoot);
    assert.throws(() => new ProjectAnalysisCache(linkedRoot, "workspace-1"), /root is unsafe/u);

    const cache = new ProjectAnalysisCache(root, "workspace-2");
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
    mkdirSync(join(linkedDataRoot, ".craft_data"), { recursive: true });
    symlinkSync(outsideDirectory, join(linkedDataRoot, ".craft_data", "codebase"));
    assert.throws(() => new ProjectAnalysisCache(linkedDataRoot, "workspace-3"), /cache path is unsafe/u);

    const linkedWorkspaceRoot = join(root, "linked-workspace-root");
    const indexes = join(linkedWorkspaceRoot, ".craft_data", "codebase", "indexes");
    mkdirSync(indexes, { recursive: true });
    symlinkSync(outsideDirectory, join(indexes, "workspace-4"));
    assert.throws(() => new ProjectAnalysisCache(linkedWorkspaceRoot, "workspace-4"), /cache path is unsafe/u);

    const linkedCacheRoot = join(root, "linked-cache-root");
    const workspaceRoot = join(linkedCacheRoot, ".craft_data", "codebase", "indexes", "workspace-5");
    mkdirSync(workspaceRoot, { recursive: true });
    symlinkSync(outsideDirectory, join(workspaceRoot, "analysis_cache"));
    assert.throws(() => new ProjectAnalysisCache(linkedCacheRoot, "workspace-5"), /cache path is unsafe/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
