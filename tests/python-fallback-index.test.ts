import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { analyzePythonCheckpoint, resolvePythonAnalyzerPath } from "../capability/craft-codebase/python-analysis.ts";
import type { RepositoryFile } from "../capability/craft-codebase/repository-files.ts";
import { ProjectGraphStore } from "../capability/craft-codebase/project-graph-store.ts";
import { stableDigest } from "../core/digest.ts";

test("Python fallback Unicode analysis imports and an old index policy is rebuilt without changing source files", async () => {
  const runtime = process.env.CRAFT_TEST_CODEBASE_RUNTIME_ROOT;
  const RuntimeService: typeof CraftService = runtime ? (await import(pathToFileURL(join(runtime, "dist/core/runtime-api.js")).href)).CraftService : CraftService;
  const adapter: Pick<typeof import("../capability/craft-codebase/python-analysis.ts"), "analyzePythonCheckpoint" | "resolvePythonAnalyzerPath"> = runtime
    ? await import(pathToFileURL(join(runtime, "dist/capability/craft-codebase/python-analysis.js")).href) : { analyzePythonCheckpoint, resolvePythonAnalyzerPath };
  const root = await realpath(await mkdtemp(join(tmpdir(), "craft-python-fallback-index-"))), repo = join(root, "repo"); await mkdir(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(), service = new RuntimeService(store); let calls = 0;
  try {
    const moduleRoot = await realpath(runtime || resolve(import.meta.dirname, ".."));
    const analyzer = adapter.resolvePythonAnalyzerPath(root, path => path.startsWith(moduleRoot + sep) && existsSync(path));
    assert.ok(analyzer, "Python adapter must find a resource inside its own package without using sibling sources");
    assert.equal((await stat(analyzer)).isFile(), true);
    const content = '# 中文😀\ndef f():\n    return "😀"\n\ndef caller():\n    return f()\n';
    await writeFile(join(repo, "main.py"), content);
    Object.assign(service, { analyzePython: (files: readonly RepositoryFile[]) => {
      calls++; return adapter.analyzePythonCheckpoint(files, { pythonPath: join(root, "missing-python"), analyzerPath: analyzer });
    } });
    const first = service.codebaseRepositoryEnsure({ project_root: repo, index_depth: "semantic" }); assert.equal(first.status, "ready");
    const warm = service.codebaseRepositoryEnsure({ project_root: repo, index_depth: "semantic" }); assert.equal(warm.reused, true); assert.equal(calls, 1);
    const stateId = `${first.workspace_id}_semantic`, state = store.get("codebase_repository_state", stateId);
    const workspace = store.get("workspace", String(first.workspace_id)), currentIndex = store.get("codebase_index", String(first.index_id));
    // A synthetic policy-12 cache must also use its old index ID, not retain a current-policy index.
    const legacyId = `repository_index_${stableDigest({ workspaceId: first.workspace_id, depth: "semantic", checkpointId: state.checkpoint_id,
      state_revision: workspace.state_revision, policy: 12, adapter_config: state.adapter_config_digest }).slice(-24)}`;
    store.remove("codebase_index", String(first.index_id)); store.save("codebase_index", legacyId, { ...currentIndex, id: legacyId });
    store.save("codebase_repository_state", stateId, { ...state, policy_version: 12, index_id: legacyId });
    const rebuilt = service.codebaseRepositoryEnsure({ project_root: repo, index_depth: "semantic" });
    assert.equal(rebuilt.status, "ready"); assert.equal(rebuilt.reused, false); assert.equal(calls, 2);
    assert.ok(Number(store.get("codebase_repository_state", stateId).policy_version) > 12);
    const index = store.get("codebase_index", String(rebuilt.index_id)); assert.ok(Number(index.node_count) > 0);
    const graph = new ProjectGraphStore(String(workspace.root_path), String(workspace.id), store.paths);
    const edges = (index.shard_ids as string[]).flatMap(id => graph.read(id).edges as JsonObject[]);
    const call = edges.find(edge => edge.kind === "calls" && (edge.source_span as JsonObject).start_offset === content.lastIndexOf("f()"));
    assert.ok(call, "the imported fallback graph must contain the call at its actual UTF-16 position"); assert.equal(call.confidence, "partial");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
