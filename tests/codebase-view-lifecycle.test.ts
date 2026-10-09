import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { repositoryFiles } from "../capability/craft-codebase/repository-files.ts";
import { codeContextCandidates } from "../capability/craft-codebase/context-search.ts";

test("changing query in a bounded large repository changes views without checkpoint churn", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-view-")), repo = join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  for (let n = 0; n < 505; n++) writeFileSync(join(repo, `${String(n).padStart(4, "0")}.ts`), `export const item${n} = ${n};`);
  writeFileSync(join(repo, "zz-login.ts"), "export function loginUser() {}\n");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(), service = new CraftService(store);
  try {
    assert.deepEqual(repositoryFiles(repo, "login").files.map(file => file.path), repositoryFiles(repo, "item").files.map(file => file.path));
    const first = service.codebaseRepositoryEnsure({ project_root: repo, query: "login" });
    const checkpointCount = store.count("workspace_checkpoint"), indexCount = store.count("codebase_index");
    const again = service.codebaseRepositoryEnsure({ project_root: repo, query: "item" });
    assert.equal(again.checkpoint_id, first.checkpoint_id); assert.equal(again.index_id, first.index_id); assert.equal(again.reused, true);
    assert.equal(store.count("workspace_checkpoint"), checkpointCount); assert.equal(store.count("codebase_index"), indexCount);
    assert.equal(first.omitted_files, 6);
    const workspace = store.get("workspace", String(first.workspace_id));
    assert.equal((workspace.include_paths as string[]).length, 500);
    const snapshot = store.get("workspace_checkpoint", String(first.checkpoint_id));
    assert.equal((snapshot.entries as unknown[]).length, 500);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("repo map is a bounded deterministic projection of analyzed dependency edges", () => {
  const node = (id: string, name = id, path = `${id}.ts`) => ({ id, name, path });
  const edge = (from: string, to: string) => ({ id: `${from}:${to}`, kind: "calls", from_node_id: from, to_node_id: to });
  const index = { nodes: [node("a", "login"), node("b", "loginSecond"), node("c", "c", "shared.ts"), node("d", "d", "shared.ts"), node("e")], edges: [edge("a", "c"), edge("b", "c"), edge("b", "d"), edge("c", "e"), edge("missing", "a")] };
  const found = codeContextCandidates(index, "login", 3);
  assert.deepEqual((found.symbols as JsonObject[]).map(item => item.id), ["a", "b", "c"]);
  assert.equal((found.symbols as JsonObject[])[2]!.selection_reason, "dependency_neighbour");
  assert.equal(found.omitted_count, 1);
  assert.deepEqual((found.repo_map as JsonObject).node_ids, ["a", "b", "c"]);
  assert.equal(((found.repo_map as JsonObject).edges as unknown[]).length, 2);
  assert.equal((found.repo_map as JsonObject).relations_analyzed, true);
  assert.deepEqual(codeContextCandidates(index, "login", 3), found);
  assert.equal((codeContextCandidates(index, "unmatched").symbols as unknown[]).length, 0);
  assert.equal((codeContextCandidates({ nodes: index.nodes }, "login").repo_map as JsonObject).relations_analyzed, false);
  for (const limit of [0, -1, 1.5, 1001, NaN]) assert.throws(() => codeContextCandidates(index, "login", limit), /limit/);
  const manyEdges = Array.from({ length: 20 }, (_, n) => ({ ...edge("a", "b"), id: String(n) }));
  assert.equal((codeContextCandidates({ ...index, edges: manyEdges }, "login", 2).repo_map as JsonObject).omitted_edges, 16);
  const stronger = { nodes: [node("a", "loginSecond"), node("b", "login", "login.ts"), node("c")], edges: [edge("a", "c"), edge("b", "c"), edge("a", "b")] };
  assert.equal(((codeContextCandidates(stronger, "login", 3).symbols as JsonObject[]).find(item => item.id === "c")!).score, 1);
});

test("analysis precedes repository publication and changing discovered source cannot publish a mismatched index", async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-publication-")), repo = join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]); writeFileSync(join(repo, "login.ts"), "export function login() {}\n");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(), service = new CraftService(store);
  try {
    const original = service.workspaceOpen.bind(service);
    t.mock.method(service, "workspaceOpen", (args: JsonObject) => {
      assert.equal(store.count("codebase_file_analysis"), 1);
      const result = original(args);
      writeFileSync(join(repo, "login.ts"), "export function changed() {}\n");
      return result;
    });
    assert.throws(() => service.codebaseRepositoryEnsure({ project_root: repo }), /digest mismatch/);
    assert.equal(store.count("codebase_index"), 0); assert.equal(store.count("workspace_checkpoint"), 0);
    assert.equal(store.count("workspace"), 0);
    t.mock.restoreAll();
    assert.equal(service.codebaseRepositoryEnsure({ project_root: repo }).status, "ready");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test("repository discovery does not hide Git ignore failures", t => {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-ignore-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  const original = childProcess.execFileSync;
  try {
    t.mock.method(childProcess, "execFileSync", (...args: Parameters<typeof execFileSync>) => {
      if (Array.isArray(args[1]) && args[1].includes("check-ignore")) throw Object.assign(new Error("ignore unavailable"), { status: 2 });
      return original(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => repositoryFiles(root), /ignore unavailable/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test("semantic analysis is prepared outside publication and source digests remain mandatory", async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-semantic-")), repo = join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  writeFileSync(join(repo, "login.tsx"), "export function login() { return 1; }\n");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(), service = new CraftService(store);
  try {
    const original = service.codebaseAnalysisImport.bind(service);
    let imported = false;
    t.mock.method(service, "codebaseAnalysisImport", (args: JsonObject) => {
      imported = true;
      const analysis = args.analysis as JsonObject;
      assert.equal(analysis.analyzer, "typescript-checker");
      assert.equal(((analysis.nodes as JsonObject[])[0]!).language, "jsx");
      return original(args);
    });
    const built = service.codebaseRepositoryEnsure({ project_root: repo, index_depth: "semantic" });
    assert.equal(imported, true); assert.equal(built.status, "ready");
    assert.equal((built.summary as JsonObject).analyzer, "typescript-checker");
    assert.equal(service.codebaseRepositoryEnsure({ project_root: repo, index_depth: "semantic", query: "other" }).index_id, built.index_id);
    t.mock.restoreAll();
    const checkpoint = service.workspaceCheckpoint.bind(service);
    t.mock.method(service, "workspaceCheckpoint", (args: JsonObject) => {
      writeFileSync(join(repo, "login.tsx"), "export function concurrent() {}\n");
      return checkpoint(args);
    });
    writeFileSync(join(repo, "login.tsx"), "export function edit() {}\n");
    assert.throws(() => service.codebaseRepositoryEnsure({ project_root: repo, index_depth: "semantic" }), /digest mismatch/);
    assert.equal(store.count("codebase_index"), 1);
    assert.equal(store.get("workspace", String(built.workspace_id)).latest_checkpoint_id, built.checkpoint_id);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("semantic repositories without supported sources report partial coverage without compiler work", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-unsupported-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  writeFileSync(join(root, "main.py"), "def run(): pass\n");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(), service = new CraftService(store);
  try {
    const built = service.codebaseRepositoryEnsure({ project_root: root, index_depth: "semantic" });
    assert.equal((built.summary as JsonObject).certainty, "partial");
    assert.equal((built.summary as JsonObject).unsupported_file_count, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
