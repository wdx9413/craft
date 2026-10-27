import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths, projectStorageDirectory } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { repositoryRoot, repositoryFiles, repositoryPolicyDigest, repositoryPolicySnapshot, repositoryPolicySnapshotCurrent } from "../capability/craft-codebase/repository-files.ts";
import { basicAnalysis } from "../capability/craft-codebase/basic-analysis.ts";
import { CodebaseIndexKernel } from "../capability/craft-codebase/codebase-index.ts";
import { ensureRepository } from "../capability/craft-codebase/repository-onboarding.ts";
import { payload, stableDigest } from "../common/craft-common-base/src/digest.ts";
import { analyzeTypeScript } from "../capability/craft-codebase/typescript-analysis.ts";
import { analyzePythonCheckpoint } from "../capability/craft-codebase/python-analysis.ts";
import { pythonFileUnitDigest } from "../capability/craft-codebase/python-incremental.ts";
import { analyzeJavaCheckpoint } from "../capability/craft-codebase/java-analysis.ts";
import { cacheLspDocumentSymbols, lspDocumentSymbolsDigest } from "../capability/craft-codebase/lsp-adapter.ts";
import { ProjectGraphStore } from "../capability/craft-codebase/project-graph-store.ts";
import { ProjectAnalysisCache } from "../capability/craft-codebase/project-analysis-cache.ts";
import { estimateTokens } from "../core/token-budget.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-repository-context-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  const paths = craftPaths(join(root, "data")); const store = await new CraftStore(paths).open();
  const service = new CraftService(store);
  const write = (path: string, content: string) => writeFileSync(join(repo, path), content);
  return { root, repo, store, service, write, git, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function projectGraph(f: Awaited<ReturnType<typeof fixture>>, workspaceId: string): ProjectGraphStore {
  const workspace = f.store.get("workspace", workspaceId);
  return new ProjectGraphStore(String(workspace.root_path), workspaceId, f.store.paths);
}
function projectAnalysis(f: Awaited<ReturnType<typeof fixture>>, workspaceId: string, kind: string, limit = 100): JsonObject[] {
  return new ProjectAnalysisCache(f.repo, workspaceId, f.store.paths).list(kind, limit);
}
const result = async (server: McpServer, name: string, args: JsonObject) => {
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any;
  assert(!response.error, JSON.stringify(response)); assert(!response.result.isError, JSON.stringify(response));
  return response.result.structuredContent as JsonObject;
};

test("repository auto onboarding reuses across clients, incrementally parses, deletes, opts out and isolates worktrees", async () => {
  const f = await fixture();
  try {
    f.write("a.ts", "export function alpha() { return 1; }"); f.write("b.py", "def beta():\n    return 2\n");
    mkdirSync(join(f.repo, "src"));
    const first = f.service.codebaseRepositoryEnsure({ project_root: join(f.repo, "src") });
    assert.equal(first.status, "ready"); assert.equal(first.reused, false);
    assert.equal(projectAnalysis(f, String(first.workspace_id), "codebase_file_analysis").length, 2);
    assert.equal(f.store.list("codebase_file_analysis", 10, item => item.workspace_id === first.workspace_id).length, 0);
    const stateId = `${String(first.workspace_id)}_basic`, state = f.store.get("codebase_repository_state", stateId);
    const summary = { ...(state.summary as JsonObject) }; delete summary.omitted_files; delete summary.omitted_by_language;
    f.store.save("codebase_repository_state", stateId, { ...payload(state), summary });
    const again = f.service.codebaseRepositoryEnsure({ project_root: f.repo }); assert.equal(again.index_id, first.index_id); assert.equal(again.reused, true);
    assert.equal(again.omitted_files, 0); assert.deepEqual(again.omitted_by_language, {});
    const anotherHost = new CraftService(f.store);
    assert.equal(anotherHost.codebaseRepositoryEnsure({ project_root: f.repo }).index_id, first.index_id);
    f.write("a.ts", "export function gamma() { return 3; }");
    const changed = f.service.codebaseRepositoryEnsure({ project_root: f.repo }); assert.notEqual(changed.index_id, first.index_id);
    assert.equal(((changed.summary as JsonObject).diagnostics as JsonObject[])[0]!.reused_files, 1); assert.equal(((changed.summary as JsonObject).diagnostics as JsonObject[])[0]!.analyzed_files, 1);
    const matches = f.service.codebaseSymbolFind({ workspace_id: changed.workspace_id, index_id: changed.index_id, query: "gamma" }); assert.equal((matches.symbols as unknown[]).length, 1);
    assert.throws(() => f.service.codebaseSymbolFind({ workspace_id: first.workspace_id, index_id: first.index_id, query: "alpha" }), /stale/);
    const semantic = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }); assert.equal(semantic.status, "ready");
    assert.equal(projectAnalysis(f, String(semantic.workspace_id), "codebase_semantic_file_analysis").length, 1);
    assert.equal(projectAnalysis(f, String(semantic.workspace_id), "codebase_python_file_analysis").length, 1);
    assert.equal(f.store.list("codebase_semantic_file_analysis", 10, item => item.workspace_id === semantic.workspace_id).length, 0);
    assert.equal(f.store.list("codebase_python_file_analysis", 10, item => item.workspace_id === semantic.workspace_id).length, 0);
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }).reused, true);
    f.git("add", "."); f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
    const worktree = join(f.root, "worktree"); f.git("worktree", "add", "--detach", worktree);
    assert.notEqual(f.service.codebaseRepositoryEnsure({ project_root: worktree }).workspace_id, first.workspace_id);
    f.service.codebaseDeactivate({ workspace_id: first.workspace_id }); assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo }).status, "disabled");
    f.service.codebaseActivate({ workspace_id: first.workspace_id, actor: "repository-auto" });
    rmSync(join(f.repo, "a.ts")); rmSync(join(f.repo, "b.py"));
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo }).status, "empty");
    assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "wrong" }), /index_depth/);
  } finally { f.close(); }
});

test("repository indexing retries once when policy changes during analysis then fails closed on a second change", async () => {
  const f = await fixture();
  try {
    f.write("a.ts", "export function alpha() { return 1; }\n");
    let analyses = 0;
    const port = Object.create(f.service) as CraftService & { analyzeTypeScript: typeof analyzeTypeScript };
    port.analyzeTypeScript = (files, options) => {
      analyses += 1;
      f.write(".gitignore", `policy-change-${analyses}\n`);
      return analyzeTypeScript(files, options);
    };
    assert.throws(() => ensureRepository(port, { project_root: f.repo, index_depth: "semantic" }), /policy changed during index analysis/u);
    assert(analyses >= 2, "a changed policy gets one retry before rejection");
  } finally { f.close(); }
});

test("repository indexing uses the legacy checkpoint API when repository-file snapshots are unavailable", async () => {
  const f = await fixture();
  try {
    f.write("a.ts", "export function alpha() { return 1; }\n");
    const legacyPort = new Proxy(f.service, {
      get(target, property, receiver) {
        if (property === "workspaceCheckpointFromRepositoryFiles") return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    const result = ensureRepository(legacyPort, { project_root: f.repo, index_depth: "basic" });
    assert.equal(result.status, "ready");
    assert.equal(typeof result.checkpoint_id, "string");
  } finally { f.close(); }
});

test("repository freshness binds checkpoints to Git branch and commit even when source bytes are unchanged", async () => {
  const f = await fixture();
  try {
    f.write("source.ts", "export const stable = 1;\n");
    f.git("add", "source.ts");
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base");
    const initial = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(initial.status, "ready");
    const workspaceId = String(initial.workspace_id);
    const freshness = f.service.workspace as unknown as { freshness(args: JsonObject): JsonObject };
    assert.equal(freshness.freshness({ workspace_id: workspaceId }).status, "current");
    f.git("checkout", "-b", "same-tree");
    const branchChanged = freshness.freshness({ workspace_id: workspaceId });
    assert.equal(branchChanged.status, "changed");
    assert.deepEqual(branchChanged.changed_paths, []);
    assert.equal(branchChanged.repository_state_changed, true);
    const branchIndex = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(branchIndex.status, "ready");
    assert.notEqual(branchIndex.checkpoint_id, initial.checkpoint_id);
    assert.notEqual(branchIndex.index_id, initial.index_id);
    assert.equal(freshness.freshness({ workspace_id: workspaceId }).status, "current");
    f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "same tree new revision");
    const revisionChanged = freshness.freshness({ workspace_id: workspaceId });
    assert.equal(revisionChanged.status, "changed");
    assert.deepEqual(revisionChanged.changed_paths, []);
    assert.equal(revisionChanged.repository_state_changed, true);
    const revisionIndex = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(revisionIndex.status, "ready");
    assert.notEqual(revisionIndex.checkpoint_id, branchIndex.checkpoint_id);
    assert.notEqual(revisionIndex.index_id, branchIndex.index_id);
    f.write("source.ts", "export const stable = 2;\n");
    const sourceChanged = freshness.freshness({ workspace_id: workspaceId });
    assert.equal(sourceChanged.status, "changed");
    assert.deepEqual(sourceChanged.changed_paths, ["source.ts"]);
    const sourceIndex = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(sourceIndex.status, "ready");
    assert.notEqual(sourceIndex.index_id, revisionIndex.index_id);
  } finally { f.close(); }
});

test("repository ensure reuses an index published while another ensure was analyzing", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function stable() {}\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const workspace = f.service.workspace as unknown as { freshness(args: JsonObject): JsonObject };
    const originalFreshness = workspace.freshness.bind(workspace);
    let calls = 0;
    workspace.freshness = args => ++calls === 1 ? { status: "stale" } : originalFreshness(args);
    try {
      const second = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      assert.equal(second.status, "ready");
      assert.equal(second.reused, true);
      assert.equal(second.index_id, first.index_id);
      assert.equal(calls, 2);
    } finally { workspace.freshness = originalFreshness; }
  } finally { f.close(); }
});

test("repository ensure migrates legacy global checkpoints into the project Codebase data root", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function legacySnapshot() { return true; }\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const workspaceId = String(first.workspace_id);
    const workspace = f.store.get("workspace", workspaceId);
    const checkpointId = String(workspace.latest_checkpoint_id);
    const checkpoint = f.store.get("workspace_checkpoint", checkpointId);
    f.store.save("workspace", workspaceId, { ...payload(workspace), snapshot_storage: "global" });
    f.store.save("workspace_checkpoint", checkpointId, { ...payload(checkpoint), snapshot_root: join(f.store.paths.runtimeDir, "workspaces", workspaceId, "snapshots", checkpointId) });

    const migrated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const migratedCheckpoint = f.store.get("workspace_checkpoint", String(migrated.checkpoint_id));

    assert.equal(migrated.status, "ready");
    assert.notEqual(migrated.checkpoint_id, checkpointId);
    assert.equal(migratedCheckpoint.snapshot_root, join(projectStorageDirectory(f.store.paths, f.repo), "codebase", "snapshots", workspaceId, String(migrated.checkpoint_id)));
    assert.equal(f.store.get("workspace", workspaceId).snapshot_storage, "project_codebase");
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }).reused, true);
  } finally { f.close(); }
});

test("semantic onboarding scans empty TypeScript and Python cache collections without crossing workspace boundaries", async () => {
  const f = await fixture();
  try {
    f.write("main.cpp", "int main() { return 0; }\n");
    f.store.save("codebase_semantic_file_analysis", "other-workspace-ts", {
      workspace_id: "other-workspace", path: "other.ts", nodes: [], edges: [], unit_digest: "other-ts",
    });
    f.store.save("codebase_python_file_analysis", "other-workspace-python", {
      workspace_id: "other-workspace", path: "other.py", nodes: [], edges: [], unit_digest: "other-python",
    });

    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });

    assert.equal(result.status, "ready");
    assert.equal(f.store.find("codebase_semantic_file_analysis", "other-workspace-ts")?.workspace_id, "other-workspace");
    assert.equal(f.store.find("codebase_python_file_analysis", "other-workspace-python")?.workspace_id, "other-workspace");
  } finally { f.close(); }
});

test("repository analysis migrates validated legacy file caches into project Codebase storage", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function legacyCache() { return 1; }\n");
    const workspaceId = `repository_${stableDigest(realpathSync(f.repo)).slice(-24)}`;
    const files = repositoryFiles(f.repo).files.filter(file => /^(?:tsx?|mts|cts|jsx?|mjs|cjs)$/u.test(file.language))
      .map(file => ({ ...file, language: file.language === "tsx" ? "jsx" : file.language }));
    const analyzed = analyzeTypeScript(files, { include_file_units: true });
    const units = analyzed.file_units as JsonObject[];
    assert.equal(units.length, 1);
    const unit = units[0]!;
    const cacheId = `codebase_semantic_file_${stableDigest({ workspaceId, path: unit.path }).slice(-24)}`;
    f.store.save("codebase_semantic_file_analysis", cacheId, { workspace_id: workspaceId, ...unit });

    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });

    assert.equal(result.status, "ready");
    assert.equal(f.store.find("codebase_semantic_file_analysis", cacheId), null);
    const projectUnits = projectAnalysis(f, workspaceId, "codebase_semantic_file_analysis");
    assert.equal(projectUnits.length, 1);
    assert.equal(projectUnits[0]!.unit_digest, unit.unit_digest);
    const diagnostics = ((result.summary as JsonObject).diagnostics as JsonObject[])[0]!;
    const typescript = (diagnostics.languages as JsonObject[]).find(component => component.analyzer === "typescript-checker")!;
    assert.equal((typescript.diagnostics as JsonObject).incremental_mode, "reuse");
  } finally { f.close(); }
});

test("semantic repository onboarding uses only explicitly trusted LSP adapters and reindexes when they change", async () => {
  const f = await fixture();
  try {
    const source = "int target() { return 1; }\n";
    mkdirSync(join(f.repo, "src"));
    f.write("src/main.cpp", source);
    f.write("src/second.cpp", "int second() { return 2; }\n");
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1, adapters: [{ language: "cpp", command: process.execPath, max_documents: 1, request_timeout_ms: 4_567 }] }));
    const calls: JsonObject[] = [];
    const timeouts: number[] = [];
    (f.service as unknown as { analyzeLsp: (request: JsonObject, timeoutMs: number) => JsonObject }).analyzeLsp = (request, timeoutMs) => {
      calls.push(request);
      timeouts.push(timeoutMs);
      const document = (request.documents as JsonObject[])[0]!;
      return { format: "craft-static-analysis-v1", analyzer: "test-cpp", analyzer_version: "1", edges: [],
        nodes: [{ id: "lsp_target", kind: "symbol", path: "src/main.cpp", language: "cpp", name: "target", source_digest: document.source_digest, span: { start_offset: 4, end_offset: 10 } }],
        diagnostics: { relations: "analyzed" } };
    };
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(first.status, "ready"); assert.equal(calls.length, 1);
    assert.deepEqual(timeouts, [4_567]); assert.equal(calls[0]!.request_timeout_ms, 4_567);
    assert.equal(calls[0]!.command, process.execPath);
    assert.equal((calls[0]!.documents as JsonObject[])[0]!.language, "cpp");
    assert.equal((calls[0]!.documents as JsonObject[]).length, 1);
    assert(JSON.stringify(first.summary).includes("document_limit"));
    const symbol = f.service.codebaseSymbolFind({ workspace_id: first.workspace_id, index_id: first.index_id, query: "target" });
    assert((symbol.symbols as JsonObject[]).some(item => item.name === "target"));
    assert.equal(f.store.get("codebase_repository_state", `${String(first.workspace_id)}_semantic`).adapter_config_digest !== undefined, true);
    delete (f.service as unknown as { analyzeLsp?: unknown }).analyzeLsp;
    const example = "class Example {};\n"; f.write("src/main.cpp", example);
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "cpp", command: process.execPath, args: [resolve("tests/fixtures/lsp-stdio-fixture.cjs"), "ok"], max_documents: 1 }] }));
    const previousEntry = process.argv[1]; process.argv[1] = resolve("bin/craft-mcp.ts");
    try {
      const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      assert.equal(updated.reused, false); assert.notEqual(updated.index_id, first.index_id);
      const exampleSymbol = f.service.codebaseSymbolFind({ workspace_id: updated.workspace_id, index_id: updated.index_id, query: "Example" });
      assert((exampleSymbol.symbols as JsonObject[]).some(item => item.name === "Example"));
    } finally { process.argv[1] = previousEntry!; }
  } finally { f.close(); }
});

test("semantic repository onboarding rebuilds adapter relations when only the trusted LSP config changes", async () => {
  const f = await fixture();
  try {
    f.write("main.cpp", "int stable() { return 1; }\n");
    const configPath = join(f.store.paths.configDir, "codebase-lsp.json");
    const writeConfig = (relationSymbolLimit: number) => writeFileSync(configPath, JSON.stringify({ schema_version: 1,
      adapters: [{ language: "cpp", command: process.execPath, relation_symbol_limit: relationSymbolLimit }] }));
    writeConfig(300);
    const calls: JsonObject[] = [];
    Object.assign(f.service, { analyzeLsp: (request: JsonObject) => {
      calls.push(request);
      const document = (request.documents as JsonObject[])[0]!;
      return { format: "craft-static-analysis-v1", analyzer: "lsp-cpp", analyzer_version: "1", edges: [],
        nodes: [{ id: "stable", kind: "symbol", path: "main.cpp", language: "cpp", name: "stable", source_digest: document.source_digest,
          span: { start_offset: 4, end_offset: 10 } }], diagnostics: { relations: "analyzed" } };
    } });

    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const unchanged = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });

    assert.equal(first.status, "ready");
    assert.equal(first.reused, false);
    assert.equal(unchanged.reused, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.relation_symbol_limit, 300);

    writeConfig(301);
    const reconfigured = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });

    assert.equal(reconfigured.status, "ready");
    assert.equal(reconfigured.reused, false);
    assert.notEqual(reconfigured.index_id, first.index_id);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.relation_symbol_limit, 301);
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }).reused, true);
    assert.equal(calls.length, 2);
  } finally { f.close(); }
});

test("semantic repository onboarding retries failed adapters after cooldown and clears retry state on recovery", async () => {
  const f = await fixture();
  try {
    const content = "package main\nfunc stable() {}\n";
    f.write("main.go", content);
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "go", command: process.execPath }] }));
    let fail = true;
    const calls: JsonObject[] = [];
    Object.assign(f.service, { analyzeLsp: (request: JsonObject) => {
      calls.push(request);
      if (fail) throw new Error("Unable to start configured language server");
      const document = (request.documents as JsonObject[])[0]!;
      const start = content.indexOf("stable");
      return { format: "craft-static-analysis-v1", analyzer: "lsp-go", analyzer_version: "1", edges: [],
        nodes: [{ id: "stable", kind: "symbol", path: "main.go", language: "go", name: "stable", source_digest: document.source_digest,
          span: { start_offset: start, end_offset: start + 6 } }], diagnostics: { relations: "analyzed" } };
    } });

    const failed = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const stateId = `${String(failed.workspace_id)}_semantic`;
    const stateAfterFailure = f.store.get("codebase_repository_state", stateId)!;
    assert.equal(failed.status, "ready");
    assert.equal(JSON.stringify(failed.summary).includes("server_unavailable"), true);
    assert.equal(typeof stateAfterFailure.semantic_retry_after, "string");
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }).reused, true);
    assert.equal(calls.length, 1);

    fail = false;
    const legacyFailure = { ...stateAfterFailure };
    delete legacyFailure.semantic_retry_after;
    f.store.save("codebase_repository_state", stateId, legacyFailure);
    const recovered = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(recovered.reused, false);
    assert.notEqual(recovered.index_id, failed.index_id);
    assert.equal((recovered.summary as JsonObject).analyzer, "lsp-go");
    assert.equal(f.store.get("codebase_repository_state", stateId)!.semantic_retry_after, undefined);
    assert.equal(calls.length, 2);

    const recoveredState = f.store.get("codebase_repository_state", stateId)!;
    f.store.save("codebase_repository_state", stateId, { ...recoveredState, semantic_retry_after: "2000-01-01T00:00:00.000Z" });
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }).reused, false);
    assert.equal(calls.length, 3);

    const retriedState = f.store.get("codebase_repository_state", stateId)!;
    f.store.save("codebase_repository_state", stateId, { ...retriedState, semantic_retry_after: "invalid-timestamp" });
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }).reused, false);
    assert.equal(calls.length, 4);
  } finally { f.close(); }
});

test("LSP onboarding degrades without a worker entry and supports packaged JavaScript worker entries", async () => {
  const unavailable = await fixture();
  const previousEntry = process.argv[1];
  try {
    unavailable.write("main.cpp", "int workerSymbol() { return 1; }\n");
    unavailable.write("main.ts", "export function fallbackSymbol() {}\n");
    writeFileSync(join(unavailable.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "cpp", command: process.execPath }] }));
    process.argv[1] = "";
    const result = unavailable.service.codebaseRepositoryEnsure({ project_root: unavailable.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    assert(JSON.stringify(result.summary).includes("worker_unavailable"));
  } finally {
    process.argv[1] = previousEntry!;
    unavailable.close();
  }

  const packaged = await fixture();
  try {
    const content = "int workerSymbol() { return 1; }\n";
    packaged.write("main.cpp", content);
    packaged.write("main.ts", "export function fallbackSymbol() {}\n");
    writeFileSync(join(packaged.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "cpp", command: process.execPath }] }));
    const workerPath = join(packaged.root, "fake-worker.cjs");
    writeFileSync(workerPath, [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(input);",
      "  const document = request.documents[0];",
      "  const start = document.content.indexOf('workerSymbol');",
      "  process.stdout.write(JSON.stringify({ format: 'craft-static-analysis-v1', analyzer: request.analyzer, analyzer_version: request.analyzer_version, nodes: [{ id: 'worker_symbol', kind: 'symbol', path: document.path, language: document.language, name: 'workerSymbol', source_digest: document.source_digest, span: { start_offset: start, end_offset: start + 12 } }], edges: [] }));",
      "});",
    ].join("\n"));
    process.argv[1] = workerPath;
    const result = packaged.service.codebaseRepositoryEnsure({ project_root: packaged.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    const symbols = packaged.service.codebaseSymbolFind({ workspace_id: String(result.workspace_id), index_id: String(result.index_id), query: "workerSymbol" }).symbols as JsonObject[];
    assert(symbols.some(symbol => symbol.name === "workerSymbol" && symbol.path === "main.cpp"));
  } finally {
    process.argv[1] = previousEntry!;
    packaged.close();
  }
});

test("Go LSP worker receives persistent cache directories under the project Codebase data root", async () => {
  const f = await fixture();
  const previousEntry = process.argv[1];
  try {
    const content = "package main\n\nfunc cacheEntry() int { return 1 }\n";
    f.write("go.mod", "module example.test/go-cache\n\ngo 1.22\n");
    f.write("main.go", content);
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "go", command: process.execPath, analyzer_version: "test-go-cache-1" }] }));
    const workerPath = join(f.root, "go-cache-worker.cjs");
    writeFileSync(workerPath, [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(input);",
      "  const requestCwd = require('node:fs').realpathSync(request.cwd);",
      "  const document = request.documents[0];",
      "  const start = document.content.indexOf('cacheEntry');",
      "  process.stdout.write(JSON.stringify({ format: 'craft-static-analysis-v1', analyzer: request.analyzer, analyzer_version: request.analyzer_version, nodes: [{ id: 'cache_entry', kind: 'symbol', path: document.path, language: document.language, name: 'cacheEntry', source_digest: document.source_digest, span: { start_offset: start, end_offset: start + 10 } }], edges: [], diagnostics: { gopls_cache: process.env.GOPLSCACHE, go_build_cache: process.env.GOCACHE, request_cwd: requestCwd, worker_cwd: process.cwd() } }));",
      "});",
    ].join("\n"));
    delete (f.service as unknown as { analyzeLsp?: unknown }).analyzeLsp;
    process.argv[1] = workerPath;
    const indexed = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(indexed.status, "ready");
    const combined = ((indexed.summary as JsonObject).diagnostics as JsonObject[])[0]!;
    const go = (combined.languages as JsonObject[]).find(item => item.analyzer === "lsp-go") as JsonObject;
    assert(go, JSON.stringify(indexed.summary));
    const projectCodebaseRoot = join(projectStorageDirectory(f.store.paths, f.repo), "codebase");
    assert.equal((go.diagnostics as JsonObject).gopls_cache, join(projectCodebaseRoot, "gopls-cache"));
    assert.equal((go.diagnostics as JsonObject).go_build_cache, join(projectCodebaseRoot, "go-build-cache"));
    assert.equal((go.diagnostics as JsonObject).worker_cwd, (go.diagnostics as JsonObject).request_cwd);
  } finally {
    process.argv[1] = previousEntry!;
    f.close();
  }
});

test("LSP worker failures retain safe request stage and protocol code in repository diagnostics", async () => {
  const f = await fixture();
  const previousEntry = process.argv[1];
  try {
    f.write("main.cpp", "int workerSymbol() { return 1; }\n");
    f.write("main.ts", "export function fallbackSymbol() {}\n");
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "cpp", command: process.execPath, args: [resolve("tests/fixtures/lsp-stdio-fixture.cjs"), "request-error"] }] }));
    delete (f.service as unknown as { analyzeLsp?: unknown }).analyzeLsp;
    process.argv[1] = resolve("bin/craft-mcp.ts");
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    const summaryDiagnostics = (result.summary as JsonObject).diagnostics as JsonObject[];
    const diagnostic = summaryDiagnostics.find(item => item.language === "cpp")
      ?? summaryDiagnostics.flatMap(item => [
        ...(Array.isArray(item.degraded_languages) ? item.degraded_languages as JsonObject[] : []),
        ...(Array.isArray((item.diagnostics as JsonObject | undefined)?.degraded_languages) ? (item.diagnostics as JsonObject).degraded_languages as JsonObject[] : []),
      ]).find(item => item.language === "cpp");
    assert(diagnostic, JSON.stringify(result.summary));
    assert.equal(diagnostic.reason, "server_request_failed");
    assert.equal(diagnostic.failure_stage, "textDocument/documentSymbol");
    assert.equal(diagnostic.protocol_error_code, -32603);
    assert.equal(JSON.stringify(diagnostic).includes("fixture failure"), false);

    f.write("main.cpp", "int changedWorkerSymbol() { return 2; }\n");
    const workerPath = join(f.root, "safe-failure-worker.cjs");
    writeFileSync(workerPath, "process.stdout.write(JSON.stringify({format:'craft-lsp-worker-failure-v1'}));\n");
    process.argv[1] = workerPath;
    const degraded = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const degradedDiagnostics = (degraded.summary as JsonObject).diagnostics as JsonObject[];
    const degradedDiagnostic = degradedDiagnostics.flatMap(item => Array.isArray(item.degraded_languages) ? item.degraded_languages as JsonObject[] : [])
      .find(item => item.language === "cpp");
    assert.equal(degradedDiagnostic?.reason, "analysis_failed");
    assert.equal(degradedDiagnostic?.failure_stage, undefined);
    assert.equal(degradedDiagnostic?.protocol_error_code, undefined);
  } finally {
    process.argv[1] = previousEntry!;
    f.close();
  }
});

test("Go LSP receives module context from the checkpoint and invalidates cached symbols when it changes", async () => {
  const f = await fixture();
  try {
    const source = "package authchecker\n\nfunc NewDelegateAuthChecker() {}\n";
    f.write("go.mod", "module example.test/is-manager\n\ngo 1.21\n");
    mkdirSync(join(f.repo, "middleware", "authchecker"), { recursive: true });
    f.write("middleware/authchecker/delegate_auth_checker.go", source);
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "go", command: process.execPath, analyzer_version: "test-go-1" }] }));
    const requests: JsonObject[] = [];
    (f.service as unknown as { analyzeLsp: (request: JsonObject) => JsonObject }).analyzeLsp = request => {
      requests.push(request);
      const moduleFile = readFileSync(join(String(request.cwd), "go.mod"), "utf8");
      assert.match(moduleFile, /module example\.test\/is-manager/u);
      const document = (request.documents as JsonObject[])[0]!;
      const symbols = cacheLspDocumentSymbols([{ name: "NewDelegateAuthChecker", kind: 12,
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 35 } },
        selectionRange: { start: { line: 2, character: 5 }, end: { line: 2, character: 27 } } }]);
      const cacheDigest = lspDocumentSymbolsDigest({ analyzer: "lsp-go", analyzer_version: "test-go-1", path: String(document.path),
        language: "go", source_digest: String(document.source_digest), symbols });
      return { format: "craft-static-analysis-v1", analyzer: "lsp-go", analyzer_version: "test-go-1", edges: [],
        nodes: [{ id: "go_constructor", kind: "symbol", path: String(document.path), language: "go", name: "NewDelegateAuthChecker",
          source_digest: String(document.source_digest), span: { start_offset: 28, end_offset: 50 } }],
        document_symbol_cache: [{ path: document.path, language: "go", source_digest: document.source_digest, symbols, cached_symbols_digest: cacheDigest }],
        diagnostics: { relations: "analyzed" } };
    };
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(first.status, "ready");
    const checkpoint = f.store.get("workspace_checkpoint", String(first.checkpoint_id));
    assert((checkpoint.entries as JsonObject[]).some(entry => entry.path === "go.mod"));
    assert.match(readFileSync(join(String(checkpoint.snapshot_root), "go.mod"), "utf8"), /module example\.test\/is-manager/u);
    assert.equal(f.store.get("codebase_index", String(first.index_id)).checkpoint_id, first.checkpoint_id);
    assert.equal((requests[0]!.documents as JsonObject[])[0]!.cached_symbols, undefined);

    f.write("go.mod", "module example.test/is-manager\n\ngo 1.22\n");
    const second = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(second.status, "ready");
    assert.notEqual(second.index_id, first.index_id);
    assert.equal(requests.length, 2);
    assert.equal((requests[1]!.documents as JsonObject[])[0]!.cached_symbols, undefined);
  } finally { f.close(); }
});

test("Go without a trusted adapter stays searchable with explicit partial relation coverage", async () => {
  const f = await fixture();
  try {
    f.write("go.mod", "module example.test/go-fallback\n\ngo 1.22\n");
    f.write("main.go", "package main\n\nfunc main() { NewService().Run() }\ntype Service struct{}\nfunc (s *Service) Run() {}\nfunc NewService() *Service { return &Service{} }\n");

    const indexed = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(indexed.status, "ready");
    const found = f.service.codebaseSymbolFind({ workspace_id: indexed.workspace_id, index_id: indexed.index_id, query: "Run" });
    const symbols = found.symbols as JsonObject[];
    assert(symbols.some(symbol => symbol.name === "Run" && symbol.language === "go" && symbol.path === "main.go"));
    const constructor = f.service.codebaseSymbolFind({ workspace_id: indexed.workspace_id, index_id: indexed.index_id, query: "NewService" }).symbols as JsonObject[];
    assert(constructor.some(symbol => symbol.name === "NewService" && symbol.language === "go"));
    const index = f.store.get("codebase_index", String(indexed.index_id));
    assert.deepEqual((index.analysis as JsonObject).relation_analysis, { status: "not_analyzed", analyzer: "craft-basic-symbols", edge_count: 0,
      relation_kinds: [], reported_statuses: ["not_analyzed"], partial_reasons: ["degraded_languages"], next_action: "build_semantic_index" });
    const diagnostics = (indexed.summary as JsonObject).diagnostics as JsonObject[];
    assert(diagnostics.some(item => Array.isArray(item.degraded_languages)
      && (item.degraded_languages as JsonObject[]).some(language => language.language === "go" && language.status === "partial"
        && language.fallback_analyzer === "craft-basic-symbols" && language.relations === "not_analyzed")));
    assert.equal(index.edge_count, 0);
  } finally { f.close(); }
});

test("Go LSP failure falls back to searchable basic symbols and preserves the relation gap", async () => {
  const f = await fixture();
  try {
    f.write("go.mod", "module example.test/go-lsp-fallback\n\ngo 1.22\n");
    f.write("main.go", "package main\n\nfunc RunQueuedTask() {}\ntype TaskManager struct{}\n");
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "go", command: process.execPath, analyzer_version: "test-go-failure" }] }));
    (f.service as unknown as { analyzeLsp: () => never }).analyzeLsp = () => {
      throw new Error("Language server request failed during textDocument/documentSymbol (0)");
    };
    const indexed = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(indexed.status, "ready");
    const found = f.service.codebaseSymbolFind({ workspace_id: indexed.workspace_id, index_id: indexed.index_id, query: "RunQueuedTask" });
    assert((found.symbols as JsonObject[]).some(symbol => symbol.name === "RunQueuedTask" && symbol.language === "go"));
    const diagnostics = (indexed.summary as JsonObject).diagnostics as JsonObject[];
    const degraded = diagnostics.flatMap(item => Array.isArray(item.degraded_languages) ? item.degraded_languages as JsonObject[] : [])
      .find(item => item.language === "go");
    assert.equal(degraded?.semantic_adapter_status, "unavailable");
    assert.equal(degraded?.failure_stage, "textDocument/documentSymbol");
    assert.equal(degraded?.protocol_error_code, 0);
    assert.equal(degraded?.fallback_analyzer, "craft-basic-symbols");
    assert.equal(degraded?.relations, "not_analyzed");
    const index = f.store.get("codebase_index", String(indexed.index_id));
    assert.equal((index.analysis as JsonObject).relation_analysis && ((index.analysis as JsonObject).relation_analysis as JsonObject).status, "not_analyzed");
  } finally { f.close(); }
});

test("Go workspace context omissions are explicit in the semantic index receipt", async () => {
  const f = await fixture();
  try {
    f.write("go.mod", "module example.test/context-budget\n\ngo 1.22\n");
    f.write("go.sum", "x".repeat(512 * 1024 + 1));
    f.write("main.go", "package main\nfunc main() {}\n");
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "go", command: process.execPath, analyzer_version: "test-go-1" }] }));
    (f.service as unknown as { analyzeLsp: (request: JsonObject) => JsonObject }).analyzeLsp = request => {
      assert.equal((request.documents as JsonObject[]).length, 1);
      assert.equal(readFileSync(join(String(request.cwd), "go.mod"), "utf8"), "module example.test/context-budget\n\ngo 1.22\n");
      assert.equal(existsSync(join(String(request.cwd), "go.sum")), false);
      const document = (request.documents as JsonObject[])[0]!;
      return { format: "craft-static-analysis-v1", analyzer: "lsp-go", analyzer_version: "test-go-1",
        nodes: [{ id: "go_main", kind: "symbol", path: "main.go", language: "go", name: "main", source_digest: document.source_digest,
          span: { start_offset: 17, end_offset: 21 } }], edges: [] };
    };
    const indexed = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(indexed.status, "ready");
    const diagnostics = (indexed.summary as JsonObject).diagnostics as JsonObject[];
    const degraded = diagnostics.flatMap(item => Array.isArray(item.degraded_languages) ? item.degraded_languages as JsonObject[] : []);
    assert(degraded.some(item => item.language === "go" && item.reason === "workspace_context_file_omitted" && item.omitted_files === 1));
  } finally { f.close(); }
});

test("Go workspace changes during LSP analysis trigger one snapshot-bound retry", async () => {
  const f = await fixture();
  try {
    f.write("go.mod", "module example.test/context-race\n\ngo 1.22\n");
    f.write("main.go", "package main\nfunc main() {}\n");
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "go", command: process.execPath, analyzer_version: "test-go-1" }] }));
    let analyzerCalls = 0;
    (f.service as unknown as { analyzeLsp: (request: JsonObject) => JsonObject }).analyzeLsp = request => {
      analyzerCalls++;
      const module = readFileSync(join(String(request.cwd), "go.mod"), "utf8");
      if (analyzerCalls === 1) {
        assert.equal(module, "module example.test/context-race\n\ngo 1.22\n");
        f.write("go.mod", "module example.test/context-race\n\ngo 1.23\n");
      } else assert.equal(module, "module example.test/context-race\n\ngo 1.23\n");
      const document = (request.documents as JsonObject[])[0]!;
      return { format: "craft-static-analysis-v1", analyzer: "lsp-go", analyzer_version: "test-go-1",
        nodes: [{ id: "go_main", kind: "symbol", path: "main.go", language: "go", name: "main", source_digest: document.source_digest,
          span: { start_offset: 17, end_offset: 21 } }], edges: [] };
    };
    const ensured = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(ensured.status, "ready");
    assert.equal(analyzerCalls, 2);
    assert.equal(f.store.count("codebase_index"), 1);
    const checkpoint = f.store.get("workspace_checkpoint", String(ensured.checkpoint_id));
    assert.equal(readFileSync(join(String(checkpoint.snapshot_root), "go.mod"), "utf8"), "module example.test/context-race\n\ngo 1.23\n");
  } finally { f.close(); }
});

test("configured LSP reuses valid symbols, rejects corrupted caches and rebuilds cross-file relations", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "src"));
    const callerSource = "int caller() { return target(); }\n", targetSource = "int target() { return 1; }\nint alternate() { return 2; }\n";
    f.write("src/main.cpp", callerSource); f.write("src/target.cpp", targetSource);
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "cpp", command: process.execPath, relations: ["calls"] }] }));
    const requests: JsonObject[][] = [];
    (f.service as unknown as { analyzeLsp: (request: JsonObject) => JsonObject }).analyzeLsp = request => {
      const documents = request.documents as JsonObject[];
      requests.push(documents);
      const nodes: JsonObject[] = [], document_symbol_cache: JsonObject[] = [];
      for (const document of documents) {
        const path = String(document.path), language = String(document.language), content = String(document.content), source_digest = String(document.source_digest);
        const rawSymbols = Array.isArray(document.cached_symbols) ? document.cached_symbols as JsonObject[]
          : [...content.matchAll(/int\s+([a-zA-Z_]\w*)\s*\(/gu)].map(match => {
            const name = match[1]!, start = match.index + match[0].lastIndexOf(name), end = start + name.length;
            return { name, kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: content.length - 1 } },
              selectionRange: { start: { line: 0, character: start }, end: { line: 0, character: end } } };
          });
        for (const symbol of rawSymbols) {
          const selection = symbol.selectionRange as JsonObject, start = Number((selection.start as JsonObject).character), end = Number((selection.end as JsonObject).character);
          nodes.push({ id: `lsp_${stableDigest([path, symbol.name, start, end]).slice(-20)}`, kind: "symbol", path, language,
            name: symbol.name, source_digest, span: { start_offset: start, end_offset: end } });
        }
        const symbols = cacheLspDocumentSymbols(rawSymbols);
        document_symbol_cache.push({ path, language, source_digest, symbols,
          cached_symbols_digest: lspDocumentSymbolsDigest({ analyzer: "lsp-cpp", analyzer_version: "1", path, language, source_digest, symbols }) });
      }
      const caller = nodes.find(node => node.name === "caller");
      const callerContent = String(documents.find(document => document.path === "src/main.cpp")?.content ?? "");
      const calledName = callerContent.match(/return\s+([a-zA-Z_]\w*)\s*\(/u)?.[1];
      const target = nodes.find(node => node.name === calledName);
      const targetOffset = calledName ? callerContent.indexOf(calledName) : -1;
      return { format: "craft-static-analysis-v1", analyzer: "lsp-cpp", analyzer_version: "1", nodes,
        edges: caller && target ? [{ kind: "calls", from_node_id: caller.id, to_node_id: target.id, source_span: { start_offset: targetOffset, end_offset: targetOffset + 6 } }] : [],
        diagnostics: { relations: "analyzed" }, document_symbol_cache };
    };

    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(first.status, "ready");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.every(document => document.cached_symbols === undefined), true);
    const firstUnits = projectAnalysis(f, String(first.workspace_id), "codebase_lsp_file_analysis", 10);
    assert.equal(firstUnits.length, 2);
    assert.equal(JSON.stringify(firstUnits).includes(callerSource), false);

    const changedCaller = "int caller() { return target() + 2; }\n";
    f.write("src/main.cpp", changedCaller);
    const second = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(second.status, "ready"); assert.notEqual(second.index_id, first.index_id);
    assert.equal(requests.length, 2);
    const secondDocuments = requests[1]!;
    assert.equal(secondDocuments.length, 2);
    assert.equal(secondDocuments.find(document => document.path === "src/main.cpp")!.cached_symbols, undefined);
    const cachedTarget = secondDocuments.find(document => document.path === "src/target.cpp")!;
    assert.equal(Array.isArray(cachedTarget.cached_symbols), true);
    const caller = (f.service.codebaseSymbolFind({ workspace_id: second.workspace_id, index_id: second.index_id, query: "caller" }).symbols as JsonObject[])[0]!;
    const relation = f.service.codebaseRelationsFind({ workspace_id: second.workspace_id, index_id: second.index_id, node_id: caller.id,
      relation_kind: "calls", direction: "outgoing" });
    assert.equal((((relation.relations as JsonObject[])[0]?.to as JsonObject)?.name), "target");

    // Relation queries must be rebuilt against current source even when an unchanged
    // target file reuses its document-symbol cache.
    f.write("src/main.cpp", "int caller() { return alternate(); }\n");
    const changedTarget = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(changedTarget.status, "ready");
    assert.notEqual(changedTarget.index_id, second.index_id);
    const thirdDocuments = requests[2]!;
    assert.equal(thirdDocuments.find(document => document.path === "src/main.cpp")!.cached_symbols, undefined);
    assert.equal(Array.isArray(thirdDocuments.find(document => document.path === "src/target.cpp")!.cached_symbols), true);
    const changedCallerNode = (f.service.codebaseSymbolFind({ workspace_id: changedTarget.workspace_id, index_id: changedTarget.index_id,
      query: "caller" }).symbols as JsonObject[])[0]!;
    const changedRelation = f.service.codebaseRelationsFind({ workspace_id: changedTarget.workspace_id, index_id: changedTarget.index_id,
      node_id: changedCallerNode.id, relation_kind: "calls", direction: "outgoing" });
    assert.equal((((changedRelation.relations as JsonObject[])[0]?.to as JsonObject)?.name), "alternate");

    const targetCache = projectAnalysis(f, String(second.workspace_id), "codebase_lsp_file_analysis", 10)
      .find(item => item.path === "src/target.cpp")!;
    new ProjectAnalysisCache(f.repo, String(second.workspace_id), f.store.paths).save("codebase_lsp_file_analysis", String(targetCache.id),
      { ...payload(targetCache), cached_symbols_digest: "tampered" });
    f.write("src/main.cpp", "int caller() { return target() + 3; }\n");
    const third = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(third.status, "ready");
    assert.notEqual(third.index_id, second.index_id);
    const fourthDocuments = requests[3]!;
    assert.equal(fourthDocuments.find(document => document.path === "src/target.cpp")!.cached_symbols, undefined);
    const refreshedTarget = projectAnalysis(f, String(third.workspace_id), "codebase_lsp_file_analysis", 10)
      .find(item => item.path === "src/target.cpp")!;
    assert.equal(refreshedTarget.cached_symbols_digest, lspDocumentSymbolsDigest({ analyzer: "lsp-cpp", analyzer_version: "1",
      path: "src/target.cpp", language: "cpp", source_digest: String(refreshedTarget.source_digest), symbols: refreshedTarget.symbols }));

    rmSync(join(f.repo, "src/target.cpp"));
    const fifth = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(fifth.status, "ready");
    assert.deepEqual(projectAnalysis(f, String(fifth.workspace_id), "codebase_lsp_file_analysis", 10).map(item => item.path), ["src/main.cpp"]);
  } finally { f.close(); }
});

test("LSP adapter failures retain safe category and protocol stage in repository diagnostics", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "src"));
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "cpp", command: process.execPath }] }));
    const cases: Array<{ error: unknown; reason: string; stage?: string; signal?: string; exit_code?: number; protocol_error_code?: number }> = [
      { error: new Error("Language server exited before completion during textDocument/documentSymbol (code null, signal SIGTRAP)"),
        reason: "server_crash", stage: "textDocument/documentSymbol", signal: "SIGTRAP" },
      { error: new Error("Language server request timed out during textDocument/documentSymbol"),
        reason: "request_timeout", stage: "textDocument/documentSymbol" },
      { error: new Error("Unable to start configured language server"), reason: "server_unavailable" },
      { error: new Error("Language server request failed (-32000)"), reason: "server_request_failed", protocol_error_code: -32000 },
      { error: new Error("Language server request failed during initialize (protocol code 999999999999999999999999)"),
        reason: "server_request_failed", stage: "initialize" },
      { error: new Error("Language server exited before completion during initialize (code 4, signal none)"),
        reason: "analysis_failed", stage: "initialize", exit_code: 4 },
      { error: new Error("Language server exited before completion during initialize (code 999999999999999999999, signal none)"),
        reason: "analysis_failed", stage: "initialize" },
      { error: "private adapter failure", reason: "analysis_failed" },
    ];
    const adapter = f.service as unknown as { analyzeLsp: () => never };
    for (const [index, item] of cases.entries()) {
      f.write("src/main.cpp", `int target${index}() { return ${index}; }\n`);
      adapter.analyzeLsp = () => { throw item.error; };
      const indexed = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      const diagnostic = ((indexed.summary as JsonObject).diagnostics as JsonObject[]).find(value => value.language === "cpp")!;
      assert.equal(diagnostic.reason, item.reason);
      assert.equal(diagnostic.failure_stage, item.stage);
      assert.equal(diagnostic.signal, item.signal);
      assert.equal(diagnostic.exit_code, item.exit_code);
      assert.equal(diagnostic.protocol_error_code, item.protocol_error_code);
      assert.equal(JSON.stringify(diagnostic).includes("private adapter failure"), false);
    }
  } finally { f.close(); }
});

test("an explicitly trusted TypeScript LSP can provide hierarchy relations instead of the built-in analyzer", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "src"));
    f.write("src/hierarchy.ts", "class Contract {}\nclass Concrete extends Contract {}\n");
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1, adapters: [{ language: "typescript",
      command: process.execPath, args: [resolve("tests/fixtures/lsp-stdio-fixture.cjs"), "relations-hierarchy"], relations: ["type_hierarchy"] }] }));
    const previousEntry = process.argv[1]; process.argv[1] = resolve("bin/craft-mcp.ts");
    try {
      const indexed = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      assert.equal(indexed.status, "ready");
      const example = (f.service.codebaseSymbolFind({ workspace_id: indexed.workspace_id, index_id: indexed.index_id, query: "Concrete" }).symbols as JsonObject[])
        .find(item => item.name === "Concrete");
      const relations = f.service.codebaseRelationsFind({ workspace_id: indexed.workspace_id, index_id: indexed.index_id,
        node_id: example!.id, relation_kind: "extends", direction: "outgoing" });
      const base = (relations.relations as JsonObject[])[0]?.to as JsonObject;
      assert.equal(base?.name, "Contract", JSON.stringify({ summary: indexed.summary, relations }));
      assert.equal(((indexed.summary as JsonObject).diagnostics as JsonObject[]).length > 0, true);
      assert(JSON.stringify(indexed.summary).includes("lsp-typescript"));
    } finally { process.argv[1] = previousEntry!; }
  } finally { f.close(); }
});

test("semantic onboarding persists a full graph in immutable bounded shards", async () => {
  const f = await fixture();
  try {
    const content = ["export function target() { return 1; }", "export function caller() { return target(); }",
      ...Array.from({ length: 10_001 }, (_, n) => `export const symbol${n}=1;`)].join("\n");
    f.write("large.ts", content);
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    assert.equal(result.index_depth, "semantic");
    const summary = result.summary as JsonObject;
    assert.equal(summary.certainty, "partial");
    const diagnostics = summary.diagnostics as JsonObject[];
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.budget_limited, false);
    const index = f.store.get("codebase_index", String(result.index_id));
    assert(Number(index.source_file_count) === 1);
    assert.equal(index.graph_storage, "project-sharded-v5");
    assert(Number(index.node_count) > 10_000);
    assert((index.shard_ids as string[]).length > 1);
    const graphDirectory = join(projectStorageDirectory(f.store.paths, f.repo), "codebase", "indexes", String(result.workspace_id), "graph_records");
    const shardIds = index.shard_ids as string[];
    assert.equal(f.store.find("codebase_index_shard", shardIds[0]!), null);
    const shards = shardIds.map(id => JSON.parse(readFileSync(join(graphDirectory, `${id}.json`), "utf8")) as JsonObject);
    assert.equal(shards.reduce((count, shard) => count + Number(shard.node_count), 0), index.node_count);
    const found = f.service.codebaseSymbolFind({ workspace_id: result.workspace_id, index_id: result.index_id, query: "symbol10000" });
    assert((found.symbols as JsonObject[]).some(node => node.name === "symbol10000"));
    const target = (f.service.codebaseSymbolFind({ workspace_id: result.workspace_id, index_id: result.index_id, query: "target" }).symbols as JsonObject[])[0]!;
    const callers = f.service.codebaseCallersFind({ workspace_id: result.workspace_id, index_id: result.index_id, symbol_id: target.id });
    assert((callers.callers as JsonObject[]).some(item => (item.caller as JsonObject).name === "caller"));
    const impact = f.service.codebaseImpactQuery({ workspace_id: result.workspace_id, index_id: result.index_id, node_id: target.id, max_depth: 1 });
    assert((impact.edges as JsonObject[]).some(edge => edge.kind === "calls"));
    assert.equal(f.store.find("codebase_index_edge_route", String((index.edge_route_shards as JsonObject[])[0]!.id)), null);
  } finally { f.close(); }
});

test("semantic onboarding packs small source files together without losing path or relation lookup", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "src"));
    f.write("src/caller-6.ts", "export function sharedSource() { return 1; }\n");
    f.write("src/caller-a.ts", 'import { sharedSource } from "./caller-6";\nexport function callerA() { return sharedSource(); }\n');
    f.write("src/caller-30.ts", 'import { sharedSource } from "./caller-6";\nexport function callerB() { return sharedSource(); }\n');
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    const index = f.store.get("codebase_index", String(result.index_id));
    assert.equal(index.source_file_count, 3);
    assert((index.shard_ids as string[]).length < Number(index.source_file_count), "small files should share durable graph records");
    const source = (f.service.codebaseSymbolFind({ workspace_id: result.workspace_id, index_id: result.index_id, query: "sharedSource" }).symbols as JsonObject[])
      .find(item => item.path === "src/caller-6.ts")!;
    const callers = f.service.codebaseCallersFind({ workspace_id: result.workspace_id, index_id: result.index_id, symbol_id: source.id });
    assert.deepEqual((callers.callers as JsonObject[]).map(item => String((item.caller as JsonObject).name)).sort(), ["callerA", "callerB"]);
    for (const path of ["src/caller-6.ts", "src/caller-a.ts", "src/caller-30.ts"]) {
      const symbols = f.service.codebaseSymbolsOverview({ workspace_id: result.workspace_id, index_id: result.index_id, path });
      assert.equal(symbols.path, path);
      assert((symbols.symbols as JsonObject[]).length > 0);
    }
  } finally { f.close(); }
});

test("semantic import reuses source bodies already verified against the published checkpoint", async () => {
  const f = await fixture();
  const sourcePath = "src/index.ts";
  try {
    mkdirSync(join(f.repo, "src"));
    f.write(sourcePath, "export function source() { return 1; }\nexport function caller() { return source(); }\n");
    const files = repositoryFiles(f.repo).files;
    const ensured = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const checkpoint = f.store.get("workspace_checkpoint", String(ensured.checkpoint_id));
    const snapshotFile = join(String(checkpoint.snapshot_root), sourcePath);
    unlinkSync(snapshotFile);
    try {
      const analysis = analyzeTypeScript(files, { include_file_units: true });
      const importFromVerifiedSources = (f.service.codebaseAnalysisImport as (args: JsonObject, sources: typeof files) => JsonObject).bind(f.service);
      const imported = importFromVerifiedSources({ workspace_id: ensured.workspace_id, checkpoint_id: ensured.checkpoint_id,
        index_id: "verified-memory-source-import", analysis }, files);
      assert.equal((imported.index as JsonObject).status, "ready");
      assert.throws(() => importFromVerifiedSources({ workspace_id: ensured.workspace_id, checkpoint_id: ensured.checkpoint_id,
        index_id: "outside-checkpoint-memory-source-import", analysis }, files.map(file => ({ ...file, path: "outside.ts" }))), /outside checkpoint/u);
      assert.throws(() => importFromVerifiedSources({ workspace_id: ensured.workspace_id, checkpoint_id: ensured.checkpoint_id,
        index_id: "duplicate-memory-source-import", analysis }, [files[0]!, files[0]!]), /source digest mismatch/u);
      assert.throws(() => importFromVerifiedSources({ workspace_id: ensured.workspace_id, checkpoint_id: ensured.checkpoint_id,
        index_id: "wrong-memory-source-digest-import", analysis }, files.map(file => ({ ...file, digest: "wrong" }))), /source digest mismatch/u);
      assert.throws(() => importFromVerifiedSources({ workspace_id: ensured.workspace_id, checkpoint_id: ensured.checkpoint_id,
        index_id: "same-size-memory-source-drift-import", analysis }, files.map(file => ({ ...file,
          content: file.content.replace("return 1", "return 2") }))), /source digest mismatch/u);
      const originalEntries = checkpoint.entries as JsonObject[];
      f.store.save("workspace_checkpoint", String(ensured.checkpoint_id), { ...checkpoint,
        entries: originalEntries.map(entry => entry.path === sourcePath ? { ...entry, size_bytes: Number(entry.size_bytes) + 1 } : entry) });
      try {
        assert.throws(() => importFromVerifiedSources({ workspace_id: ensured.workspace_id, checkpoint_id: ensured.checkpoint_id,
          index_id: "wrong-memory-source-size-import", analysis }, files), /source digest mismatch/u);
      } finally { f.store.save("workspace_checkpoint", String(ensured.checkpoint_id), checkpoint); }
      assert.throws(() => importFromVerifiedSources({ workspace_id: ensured.workspace_id, checkpoint_id: ensured.checkpoint_id,
        index_id: "mismatched-memory-source-import", analysis }, files.map(file => ({ ...file, content: `${file.content}\n// drift` }))), /source digest mismatch/u);
    } finally { writeFileSync(snapshotFile, files.find(file => file.path === sourcePath)!.content); }
  } finally { f.close(); }
});

test("semantic onboarding incrementally refreshes changed modules and matches a clean graph", async () => {
  const f = await fixture();
  try {
    f.write("a.ts", "export function source() { return 1; }\n");
    const callerText = 'import { source } from "./a";\nconst label = "😀";\nexport function caller() { return source(); }\n';
    f.write("b.ts", callerText);
    f.write("c.ts", "export function unrelated() { return 3; }\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(first.status, "ready");
    const firstIndex = f.store.get("codebase_index", String(first.index_id));
    const firstShardIds = firstIndex.shard_ids as string[];
    const firstRouteIds = (firstIndex.edge_route_shards as JsonObject[]).map(route => String(route.id));
    const firstUnits = projectAnalysis(f, String(first.workspace_id), "codebase_semantic_file_analysis", 10);
    assert.equal(firstUnits.length, 3);
    const firstVersions = new Map(firstUnits.map(unit => [String(unit.path), unit.version]));

    f.write("a.ts", "export function source() { return 2; }\n");
    const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(updated.status, "ready");
    assert.notEqual(updated.index_id, first.index_id);
    const updatedIndex = f.store.get("codebase_index", String(updated.index_id));
    const updatedShardIds = updatedIndex.shard_ids as string[];
    const updatedRouteIds = (updatedIndex.edge_route_shards as JsonObject[]).map(route => String(route.id));
    assert(updatedShardIds.filter(id => firstShardIds.includes(id)).length >= 2, "unchanged source files must reuse content-addressed graph shards");
    assert(updatedRouteIds.filter(id => firstRouteIds.includes(id)).length > 0, "unchanged route buckets must reuse content-addressed route records");
    const summary = updated.summary as JsonObject;
    const combined = (summary.diagnostics as JsonObject[])[0] as JsonObject;
    const component = (combined.languages as JsonObject[])[0] as JsonObject;
    const tsDiagnostics = component.diagnostics as JsonObject;
    assert.equal(tsDiagnostics.incremental_mode, "incremental");
    assert.equal(tsDiagnostics.incremental_reason, "changed_modules_and_reverse_import_closure");

    const currentFiles = repositoryFiles(f.repo).files.filter(file => /^(?:tsx?|mts|cts|jsx?|mjs|cjs)$/u.test(file.language))
      .map(file => ({ ...file, language: file.language === "tsx" ? "jsx" : file.language }));
    const clean = analyzeTypeScript(currentFiles);
    const sort = (items: JsonObject[]) => [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const units = projectAnalysis(f, String(updated.workspace_id), "codebase_semantic_file_analysis", 10);
    const updatedVersions = new Map(units.map(unit => [String(unit.path), unit.version]));
    assert.notEqual(updatedVersions.get("a.ts"), firstVersions.get("a.ts"), "changed source unit must be persisted");
    assert.equal(updatedVersions.get("b.ts"), firstVersions.get("b.ts"), "unchanged importer facts must not be rewritten");
    assert.equal(updatedVersions.get("c.ts"), firstVersions.get("c.ts"), "unrelated facts must not be rewritten");
    const actualNodes = sort(units.flatMap(unit => unit.nodes as JsonObject[]));
    const actualEdges = sort(units.flatMap(unit => unit.edges as JsonObject[]));
    assert.deepEqual(actualNodes, sort(clean.nodes as JsonObject[]));
    assert.deepEqual(actualEdges, sort(clean.edges as JsonObject[]));
    const indexRecord = f.store.get("codebase_index", String(updated.index_id));
    const graph = projectGraph(f, String(updated.workspace_id));
    const storedEdges = (indexRecord.shard_ids as string[]).flatMap(id => graph.read(id).edges as JsonObject[]);
    const callOffset = callerText.lastIndexOf("source();");
    const callEdge = storedEdges.find(edge => edge.kind === "calls" && (edge.source_span as JsonObject).start_offset === callOffset);
    assert(callEdge, "the imported call should have a stored source span");
    assert.equal((callEdge.source_span as JsonObject).start_line, 3);
    assert.equal((callEdge.source_span as JsonObject).start_column, callOffset - callerText.lastIndexOf("\n", callOffset - 1));
    const source = (f.service.codebaseSymbolFind({ workspace_id: updated.workspace_id, index_id: updated.index_id, query: "source" }).symbols as JsonObject[])[0]!;
    const callers = f.service.codebaseCallersFind({ workspace_id: updated.workspace_id, index_id: updated.index_id, symbol_id: source.id });
    assert((callers.callers as JsonObject[]).some(item => (item.caller as JsonObject).name === "caller"));
    const repeated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(repeated.reused, true);
  } finally { f.close(); }
});

test("TypeScript checker reuses bounded compiler programs and refreshes changed source", () => {
  const files = [{ path: "__program-reuse-fixture__/entry.ts", content: "export const value = 1", digest: "program-cache-v1", language: "ts" }];
  const first = analyzeTypeScript(files);
  const repeated = analyzeTypeScript(files);
  assert.equal((repeated.diagnostics as JsonObject).compiler_program_reused, true);
  const changed = analyzeTypeScript([{ ...files[0]!, content: "export const value = 2", digest: "program-cache-v2" }]);
  assert.equal((changed.diagnostics as JsonObject).compiler_program_reused, true);
  assert.notDeepEqual(changed.nodes, first.nodes);
});

test("TypeScript incremental analysis resolves unchanged dependency symbols without rewalking their AST", () => {
  const files = [
    { path: "__incremental-symbol-resolution__/dependency.ts", content: "export function dependency() { return 1; }", digest: "dependency-v1", language: "ts" },
    { path: "__incremental-symbol-resolution__/entry.ts", content: 'import { dependency } from "./dependency"; export function entry() { return dependency(); }', digest: "entry-v1", language: "ts" },
    { path: "__incremental-symbol-resolution__/anonymous.ts", content: "export default class {}", digest: "anonymous-v1", language: "ts" },
    { path: "__incremental-symbol-resolution__/anonymous-entry.ts", content: 'import Anonymous from "./anonymous"; export function useAnonymous() { return Anonymous; }', digest: "anonymous-entry-v1", language: "ts" },
    { path: "__incremental-symbol-resolution__/global.ts", content: "export function global() { return JSON.stringify(1); }", digest: "global-v1", language: "ts" },
  ];
  const full = analyzeTypeScript(files);
  const selected = analyzeTypeScript(files, { include_paths: [files[1]!.path, files[3]!.path, files[4]!.path], include_file_units: true });
  const target = (full.nodes as JsonObject[]).find(node => node.path === files[0]!.path && node.name === "dependency")!;
  const resolvedEdges = selected.edges as JsonObject[];
  assert(resolvedEdges.some(edge => edge.kind === "calls" && edge.to_node_id === target.id));
  assert(resolvedEdges.some(edge => edge.kind === "references" && edge.to_node_id === target.id));
  assert((selected.file_units as JsonObject[]).every(unit => Array.isArray(unit.nodes) && Array.isArray(unit.edges)));
});

test("TypeScript call edges belong to the enclosing callable instead of local initializer variables", () => {
  const files = [{ path: "__call-owner-fixture__/entry.ts", language: "ts", digest: "call-owner-v1", content: [
    "export function dependency() { return 1; }",
    "export function caller() { const result = dependency(); return [result].map(value => dependency()); }",
    "export const callback = () => dependency();",
    "export const topLevel = dependency();",
  ].join("\n") }];
  const graph = analyzeTypeScript(files), nodes = graph.nodes as JsonObject[], edges = graph.edges as JsonObject[];
  const dependency = nodes.find(node => node.name === "dependency")!;
  const byId = new Map(nodes.map(node => [String(node.id), node]));
  const callers = edges.filter(edge => edge.kind === "calls" && edge.to_node_id === dependency.id)
    .map(edge => String(byId.get(String(edge.from_node_id))?.name)).sort();
  assert.deepEqual(callers, ["callback", "caller", "caller", "topLevel"]);
});

test("semantic onboarding reuses unchanged TypeScript facts and rebuilds when the file set changes", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function source() { return 1; }\n");
    f.write("component.tsx", "export function View() { return null; }\n");
    f.write("helper.py", "def helper():\n    return 1\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(first.status, "ready");

    f.write("helper.py", "def helper():\n    return 2\n");
    const pythonChanged = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const summary = pythonChanged.summary as JsonObject;
    const combined = (summary.diagnostics as JsonObject[])[0] as JsonObject;
    const component = (combined.languages as JsonObject[]).find(item => item.analyzer === "typescript-checker") as JsonObject;
    assert.equal((component.diagnostics as JsonObject).incremental_mode, "reuse");

    f.write("added.ts", "export function added() { return 3; }\n");
    const added = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const addedSummary = added.summary as JsonObject;
    const addedCombined = (addedSummary.diagnostics as JsonObject[])[0] as JsonObject;
    const addedComponent = (addedCombined.languages as JsonObject[]).find(item => item.analyzer === "typescript-checker") as JsonObject;
    assert.equal((addedComponent.diagnostics as JsonObject).incremental_mode, "full");
    assert.equal((addedComponent.diagnostics as JsonObject).incremental_reason, "source_file_set_changed");
    assert.equal(projectAnalysis(f, String(first.workspace_id), "codebase_semantic_file_analysis", 10).length, 3);
    rmSync(join(f.repo, "added.ts"));
    const deleted = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(deleted.status, "ready");
    assert.equal(projectAnalysis(f, String(first.workspace_id), "codebase_semantic_file_analysis", 10).length, 2);
  } finally { f.close(); }
});

test("repository onboarding repairs a missing index reference without reusing stale state", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function source() { return 1; }\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const stateId = `${first.workspace_id}_semantic`;
    const state = f.store.get("codebase_repository_state", stateId);
    f.store.save("codebase_repository_state", stateId, { ...state, index_id: "missing_index" });
    const repaired = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(repaired.status, "ready");
    assert.equal(repaired.index_id, first.index_id);
    assert.equal(repaired.reused, false);
    f.store.remove("codebase_repository_state", stateId);
    const missingState = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(missingState.status, "ready");
    assert.equal(missingState.index_id, first.index_id);
    assert.equal(missingState.reused, false);
  } finally { f.close(); }
});

test("repository onboarding treats stale policy and incomplete workspace metadata as cache misses", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function source() { return 1; }\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const stateId = `${first.workspace_id}_semantic`;
    const state = f.store.get("codebase_repository_state", stateId);
    const currentIndex = f.store.get("codebase_index", String(first.index_id));
    const workspace = f.store.get("workspace", String(first.workspace_id));
    const legacyIndexId = `repository_index_${stableDigest({ workspaceId: first.workspace_id, depth: "semantic", checkpointId: state.checkpoint_id,
      state_revision: workspace.state_revision, policy: 9, adapter_config: state.adapter_config_digest }).slice(-24)}`;
    const graph = projectGraph(f, String(first.workspace_id));
    for (const shardId of currentIndex.shard_ids as string[]) rmSync(join(graph.directory, `${shardId}.json`));
    for (const route of currentIndex.edge_route_shards as JsonObject[]) rmSync(join(graph.directory, `${String(route.id)}.json`));
    f.store.remove("codebase_index", String(first.index_id));
    f.store.save("codebase_index", legacyIndexId, { ...currentIndex, id: legacyIndexId });
    f.store.save("codebase_repository_state", stateId, { ...state, policy_version: 9, index_id: legacyIndexId });
    const stalePolicy = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(stalePolicy.status, "ready");
    assert.equal(stalePolicy.reused, false);
    assert.notEqual(stalePolicy.index_id, legacyIndexId, "semantic metadata storage changes must rebuild an existing same-checkpoint index");
    const rebuiltIndex = f.store.get("codebase_index", String(stalePolicy.index_id));
    const rebuiltSymbols = (rebuiltIndex.node_shard_ids as string[]).flatMap(id => graph.read(id).nodes as JsonObject[])
      .filter(node => node.kind === "symbol");
    assert.equal(rebuiltSymbols.find(node => node.name === "source")?.declaration_kind, "function");

    const currentState = f.store.get("codebase_repository_state", stateId);
    const originalFind = f.store.find.bind(f.store);
    let interceptWorkspaceWithState = true;
    (f.store as unknown as { find: typeof f.store.find }).find = ((kind: string, id: string) => {
      const value = originalFind(kind, id);
      if (interceptWorkspaceWithState && kind === "workspace" && value) {
        interceptWorkspaceWithState = false;
        return { ...value, latest_checkpoint_id: undefined };
      }
      return value;
    }) as typeof f.store.find;
    try {
      assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }).reused, true);
    } finally { f.store.find = originalFind; }

    let interceptMissingMetadata = true;
    (f.store as unknown as { find: typeof f.store.find }).find = ((kind: string, id: string) => {
      if (interceptMissingMetadata && kind === "workspace") {
        interceptMissingMetadata = false;
        const value = originalFind(kind, id);
        return value ? { ...value, latest_checkpoint_id: undefined } : value;
      }
      if (kind === "codebase_repository_state" && id === stateId) return undefined;
      return originalFind(kind, id);
    }) as typeof f.store.find;
    try {
      const rebuiltWithoutState = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      assert.equal(rebuiltWithoutState.status, "ready");
      assert.equal(rebuiltWithoutState.reused, false);
    } finally { f.store.find = originalFind; }

    f.store.save("codebase_repository_state", stateId, { ...currentState, checkpoint_id: "" });
    let interceptWorkspace = true;
    (f.store as unknown as { find: typeof f.store.find }).find = ((kind: string, id: string) => {
      const value = originalFind(kind, id);
      if (interceptWorkspace && kind === "workspace" && value) {
        interceptWorkspace = false;
        return { ...value, latest_checkpoint_id: undefined };
      }
      return value;
    }) as typeof f.store.find;
    try {
      const incompleteWorkspace = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      assert.equal(incompleteWorkspace.reused, true);
    } finally { f.store.find = originalFind; }

    const completeState = f.store.get("codebase_repository_state", stateId);
    const currentWorkspace = f.store.get("workspace", String(first.workspace_id));
    f.store.save("codebase_repository_state", stateId, { ...completeState, checkpoint_id: currentWorkspace.latest_checkpoint_id });
    let interceptState = true;
    (f.store as unknown as { find: typeof f.store.find }).find = ((kind: string, id: string) => {
      const value = originalFind(kind, id);
      if (interceptState && kind === "codebase_repository_state" && value) {
        interceptState = false;
        return { ...value, policy_version: 0 };
      }
      return value;
    }) as typeof f.store.find;
    try {
      const concurrentRepair = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      assert.equal(concurrentRepair.reused, true);
    } finally { f.store.find = originalFind; }
  } finally { f.close(); }
});

test("repository onboarding never reuses an index after its stored repository policy digest becomes stale", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function source() { return 1; }\n");
    f.write("other.ts", "export function retained() { return 2; }\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const stateId = `${first.workspace_id}_semantic`;
    const state = f.store.get("codebase_repository_state", stateId);
    f.store.save("codebase_repository_state", stateId, { ...state, repository_policy_digest: "stale-policy-digest" });
    f.write(".craft-codebase.json", JSON.stringify({ exclude_paths: ["main.ts"] }));

    const rebuilt = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });

    assert.equal(rebuilt.status, "ready");
    assert.equal(rebuilt.reused, false);
    assert.notEqual(rebuilt.index_id, first.index_id);
    assert.equal((f.store.get("codebase_repository_state", stateId)).repository_policy_digest, repositoryPolicyDigest(f.repo));
  } finally { f.close(); }
});

test("repository onboarding recovers a missing workspace pointer from the matching project snapshot", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function source() { return 1; }\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const workspaceId = String(first.workspace_id), stateId = `${workspaceId}_semantic`;
    const originalFind = f.store.find.bind(f.store);
    let workspaceReads = 0;
    f.store.find = ((kind: string, id: string) => {
      if (kind === "workspace" && id === workspaceId) {
        workspaceReads++;
        const value = originalFind(kind, id);
        if (workspaceReads === 2 && value) return { ...value, latest_checkpoint_id: undefined };
      }
      if (kind === "codebase_repository_state" && id === stateId) return undefined;
      return originalFind(kind, id);
    }) as typeof f.store.find;
    try {
      const recovered = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      assert.equal(recovered.status, "ready");
      assert.equal(recovered.reused, false);
      assert.equal(typeof recovered.checkpoint_id, "string");
    } finally { f.store.find = originalFind; }
  } finally { f.close(); }
});

test("Go workspace metadata drift before checkpoint publication is rejected", async () => {
  const f = await fixture();
  try {
    f.write("go.mod", "module example.test/workspace-drift\n\ngo 1.22\n");
    f.write("main.go", "package main\nfunc main() {}\n");
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "go", command: process.execPath, analyzer_version: "test-go-1" }] }));
    (f.service as unknown as { analyzeLsp: (request: JsonObject) => JsonObject }).analyzeLsp = request => {
      const document = (request.documents as JsonObject[])[0]!;
      return { format: "craft-static-analysis-v1", analyzer: "lsp-go", analyzer_version: "test-go-1",
        nodes: [{ id: "go_main", kind: "symbol", path: "main.go", language: "go", name: "main", source_digest: document.source_digest,
          span: { start_offset: 17, end_offset: 21 } }], edges: [] };
    };
    const checkpoint = f.service.workspaceCheckpointFromRepositoryFiles.bind(f.service);
    f.service.workspaceCheckpointFromRepositoryFiles = args => {
      const published = checkpoint(args);
      const row = published.checkpoint as JsonObject;
      const entries = (row.entries as JsonObject[]).map(entry => entry.path === "go.mod" ? { ...entry, digest: "0".repeat(64) } : entry);
      f.store.save("workspace_checkpoint", String(row.id), { ...row, entries });
      return published;
    };
    assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }), /workspace context changed during snapshot analysis/u);
  } finally { f.close(); }
});

test("repository ensure adopts a concurrent checkpoint published before a retryable snapshot race", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function checkpointRace() { return true; }\n");
    const checkpoint = f.service.workspaceCheckpointFromRepositoryFiles.bind(f.service);
    let calls = 0;
    f.service.workspaceCheckpointFromRepositoryFiles = args => {
      const published = checkpoint(args);
      calls += 1;
      if (calls === 1) throw new Error("Workspace changed before repository checkpoint publication");
      if (calls === 2) f.write("main.ts", "export function changedAfterCheckpoint() { return false; }\n");
      else {
        const row = published.checkpoint as JsonObject;
        f.store.save("workspace_checkpoint", String(row.id), { ...payload(row), snapshot_root: join(f.root, "wrong-checkpoint-root") });
      }
      throw new Error("Workspace changed before repository checkpoint publication");
    };
    const ensured = f.service.codebaseRepositoryEnsure({ project_root: f.repo });
    assert.equal(ensured.status, "ready");
    assert.equal(calls, 1);
    f.write("main.ts", "export function nextCheckpointRace() { return true; }\n");
    assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo }), /Workspace changed before repository checkpoint publication/u);
    assert.equal(calls, 2);
    assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo }), /Workspace changed before repository checkpoint publication/u);
    assert.equal(calls, 3);
    f.service.workspaceCheckpointFromRepositoryFiles = () => { throw "non-error checkpoint failure"; };
    assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo }), error => error === "non-error checkpoint failure");
  } finally { f.close(); }
});

test("repository ensure fails closed when a retryable checkpoint race has no published checkpoint", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function missingCheckpointRace() { return true; }\n");
    f.service.workspaceCheckpointFromRepositoryFiles = () => {
      throw new Error("Workspace changed before repository checkpoint publication");
    };
    assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo }), /Workspace changed before repository checkpoint publication/u);
  } finally { f.close(); }
});

test("repository ensure retries once when source digests change before the checkpoint is captured", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function initialVersion() { return 1; }\n");
    let analyzerCalls = 0;
    (f.service as unknown as { analyzeTypeScript: typeof analyzeTypeScript }).analyzeTypeScript = (files, options = {}) => {
      const result = analyzeTypeScript(files, options);
      analyzerCalls++;
      if (analyzerCalls === 1) f.write("main.ts", "export function latestVersion() { return 2; }\n");
      return result;
    };
    const ensured = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(ensured.status, "ready");
    assert.equal(analyzerCalls, 2, "a changed source/checkpoint pair should trigger one bounded retry");
    const symbols = f.service.codebaseSymbolFind({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: "latestVersion" });
    assert((symbols.symbols as JsonObject[]).some(symbol => symbol.name === "latestVersion"));
    const stale = f.service.codebaseSymbolFind({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: "initialVersion" });
    assert.equal((stale.symbols as JsonObject[]).some(symbol => symbol.name === "initialVersion"), false);
  } finally { f.close(); }
});

test("repository ensure preserves non-Error failures from index publication", async () => {
  const f = await fixture();
  const failure = { category: "analyzer_failure" };
  try {
    f.write("main.ts", "export function stableSource() { return 1; }\n");
    (f.service as unknown as { codebaseAnalysisImport: (args: JsonObject) => JsonObject }).codebaseAnalysisImport = () => { throw failure; };
    assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }),
      (error: unknown) => error === failure);
  } finally { f.close(); }
});

test("incomplete incremental analyzer output safely retries with a full TypeScript graph", async () => {
  for (const incomplete of ["units", "default_retry", "missing_affected", "missing_affected_default_retry"] as const) {
    const f = await fixture();
    try {
      f.write("a.ts", "export function source() { return 1; }\n");
      f.write("b.ts", 'import { source } from "./a"; export function caller() { return source(); }\n');
      f.write("c.ts", "export function unrelated() { return 3; }\n");
      const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      f.write("a.ts", "export function source() { return 2; }\n");
      const analyzerHost = f.service as unknown as { analyzeTypeScript?: typeof analyzeTypeScript };
      analyzerHost.analyzeTypeScript = (files, options = {}) => {
        const result = analyzeTypeScript(files, options);
        if (options.include_paths) {
          if (incomplete === "default_retry" || incomplete === "missing_affected_default_retry") analyzerHost.analyzeTypeScript = undefined;
          if (incomplete === "missing_affected") analyzerHost.analyzeTypeScript = (fullFiles, fullOptions = {}) =>
            ({ ...analyzeTypeScript(fullFiles, fullOptions), file_units: undefined });
          return incomplete === "missing_affected" || incomplete === "missing_affected_default_retry"
            ? { ...result, file_units: [] } : { ...result, file_units: undefined };
        }
        if (incomplete === "units" || incomplete === "missing_affected") return { ...result, file_units: undefined };
        return result;
      };
      const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      assert.equal(updated.status, "ready");
      const summary = updated.summary as JsonObject;
      const combined = (summary.diagnostics as JsonObject[])[0] as JsonObject;
      const component = (combined.languages as JsonObject[])[0] as JsonObject;
      const diagnostics = component.diagnostics as JsonObject;
      assert.equal(diagnostics.incremental_mode, "full");
      assert.equal(diagnostics.incremental_reason, "incremental_result_incomplete");
      assert.notEqual(updated.index_id, first.index_id);
    } finally { f.close(); }
  }
});

test("a global TypeScript graph budget preserves incremental analysis when file units are complete", async () => {
  const f = await fixture();
  try {
    f.write("a.ts", "export function source() { return 1; }\n");
    f.write("b.ts", 'import { source } from "./a"; export function caller() { return source(); }\n');
    f.write("c.ts", "export function unrelated() { return 3; }\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    f.write("a.ts", "export function source() { return 2; }\n");
    let partialCalls = 0;
    (f.service as unknown as { analyzeTypeScript: typeof analyzeTypeScript }).analyzeTypeScript = (files, options = {}) => {
      const result = analyzeTypeScript(files, options);
      if (options.include_paths) {
        partialCalls++;
        return { ...result, diagnostics: { ...(result.diagnostics as JsonObject), budget_limited: true } };
      }
      return result;
    };
    const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const combined = ((updated.summary as JsonObject).diagnostics as JsonObject[])[0] as JsonObject;
    const component = (combined.languages as JsonObject[])[0] as JsonObject;
    const diagnostics = component.diagnostics as JsonObject;
    assert.equal(updated.status, "ready");
    assert.notEqual(updated.index_id, first.index_id);
    assert.equal(partialCalls, 1, "complete per-file output must avoid redundant full analysis after a global graph budget signal");
    assert.equal(diagnostics.incremental_mode, "incremental");
  } finally { f.close(); }
});

test("sharded graph queries fail closed when an immutable shard is altered", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function safe() { return 1; }");
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const index = f.store.get("codebase_index", String(result.index_id));
    const shardId = String((index.shard_ids as string[])[0]);
    const graph = projectGraph(f, String(result.workspace_id));
    const shard = graph.read(shardId);
    writeFileSync(join(graph.directory, `${shardId}.json`), JSON.stringify({ ...shard, edges: [{ kind: "calls" }] }));
    assert.throws(() => f.service.codebaseSymbolFind({ workspace_id: result.workspace_id, index_id: result.index_id, query: "safe" }), /shard integrity/);
  } finally { f.close(); }
});

test("project graph records are not read when workspace storage binding changes", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export function bound() { return true; }\n");
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const workspace = f.store.get("workspace", String(result.workspace_id));
    f.store.save("workspace", String(result.workspace_id), { ...payload(workspace), snapshot_storage: "global" });
    assert.throws(() => f.service.codebaseSymbolFind({ workspace_id: result.workspace_id, index_id: result.index_id, query: "bound" }), /storage is not enabled/u);
  } finally { f.close(); }
});

test("edge route buckets deterministically sort multi-node adjacency and project semantic edges", async () => {
  const f = await fixture();
  try {
    const declarations = Array.from({ length: 500 }, (_, i) => `export function target${i}() { return ${i}; }\nexport function caller${i}() { return target${i}(); }`).join("\n");
    f.write("routes.ts", declarations);
    const ensured = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const index = f.store.get("codebase_index", String(ensured.index_id));
    const routes = index.edge_route_shards as JsonObject[];
    const graph = projectGraph(f, String(ensured.workspace_id));
    const routeRecords = routes.map(route => graph.read(String(route.id)));
    assert(routeRecords.some(route => Object.keys(route.incoming as JsonObject).length > 1));
    assert(routeRecords.some(route => Object.keys(route.outgoing as JsonObject).length > 1));
    const sameShardNodes = routeRecords.flatMap(route => {
      const groups = new Map<string, string[]>();
      for (const [nodeId, shardId] of Object.entries(route.nodes as Record<string, string>)) groups.set(shardId, [...(groups.get(shardId) ?? []), nodeId]);
      return [...groups.values()].filter(group => group.length > 1).map(group => group.slice(0, 2));
    })[0]!;
    const slice = f.service.codebaseContextSlice({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, node_ids: sameShardNodes, limit: 2 });
    assert.equal((slice.references as JsonObject[]).length, 2);
    const makeIdForBucket = (bucket: string, existing?: JsonObject): string => {
      for (let i = 0; i < 100_000; i++) {
        const id = `codebase_node_missing_${i}`;
        if (stableDigest(id).slice(-2) === bucket && !(existing && Object.hasOwn(existing.nodes as JsonObject, id))) return id;
      }
      throw new Error("could not generate a node id for route test");
    };
    const existingRoute = routeRecords[0]!;
    assert.throws(() => f.service.codebaseContextSlice({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, node_ids: [makeIdForBucket(String(existingRoute.bucket), existingRoute)] }), /not in index/);
    const missingBucket = String(existingRoute.bucket), missingRouteId = String(existingRoute.id);
    const withoutRoute = (index.edge_route_shards as JsonObject[]).filter(route => route.id !== missingRouteId);
    const manifest = { location_route_version: index.location_route_version, shard_ids: index.shard_ids, shard_digests: index.shard_digests, node_shard_ids: index.node_shard_ids, edge_shard_ids: index.edge_shard_ids,
      node_count: index.node_count, edge_count: index.edge_count, graph_digest: index.graph_digest, node_digest: index.node_digest, edge_digest: index.edge_digest, edge_route_shards: withoutRoute };
    f.store.save("codebase_index", String(index.id), { ...index, edge_route_shards: withoutRoute, graph_manifest_digest: stableDigest(manifest) });
    const missingNodeId = Object.keys(existingRoute.nodes as JsonObject)[0]!;
    assert.equal(stableDigest(missingNodeId).slice(-2), missingBucket);
    assert.throws(() => f.service.codebaseContextSlice({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, node_ids: [missingNodeId] }), /not in index/);
    f.store.save("codebase_index", String(index.id), index);
    const target = (f.service.codebaseSymbolFind({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: "target123" }).symbols as JsonObject[])[0]!;
    assert.equal((f.service.codebaseCallersFind({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, symbol_id: target.id }).callers as JsonObject[]).length, 1);
    const kernel = new CodebaseIndexKernel(f.store);
    const projectionArgs = { workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: "target123" };
    const projection = kernel.contextProjection(projectionArgs);
    assert((projection.candidates as JsonObject[]).length > 0);
    const repeatedProjection = kernel.contextProjection(projectionArgs);
    assert.deepEqual(repeatedProjection.candidates, projection.candidates);
    const firstIndex = f.store.get("codebase_index", String(ensured.index_id));
    f.store.save("codebase_index", String(firstIndex.id), payload(firstIndex));

    const instrument = kernel as unknown as {
      loadGraph(index: JsonObject): { nodes: JsonObject[]; edges: JsonObject[] };
      contextGraph(this: CodebaseIndexKernel, index: JsonObject): { nodes: JsonObject[]; edges: JsonObject[] };
    };
    const loadGraph = instrument.loadGraph.bind(kernel);
    let graphLoads = 0;
    instrument.loadGraph = index => { graphLoads++; return loadGraph(index); };
    const cachedProjection = kernel.contextProjection(projectionArgs);
    const repeatedCachedProjection = kernel.contextProjection(projectionArgs);
    assert.deepEqual(repeatedCachedProjection.candidates, cachedProjection.candidates);
    assert.equal(graphLoads, 1, "a repeated Context read should reuse its verified immutable graph");
    const latestIndex = f.store.get("codebase_index", String(ensured.index_id));
    f.store.save("codebase_index", String(latestIndex.id), payload(latestIndex));
    kernel.contextProjection(projectionArgs);
    assert.equal(graphLoads, 2, "a new index version must invalidate the process-local graph cache");

    const originalGraph = instrument.loadGraph;
    const oversizedGraph = { nodes: Array.from({ length: 8_001 }, (_, i) => ({ id: `node-${i}` })), edges: [] };
    instrument.loadGraph = () => { graphLoads++; return oversizedGraph; };
    const oversizedIndex = { id: "large-index", version: 1, graph_digest: "large-digest", node_count: 8_001, edge_count: 0 };
    instrument.contextGraph.call(kernel, oversizedIndex);
    instrument.contextGraph.call(kernel, oversizedIndex);
    assert.equal(graphLoads, 4, "graphs above the cache bound must be reread instead of retained");
    instrument.loadGraph = originalGraph;
  } finally { f.close(); }
});

test("semantic onboarding indexes Python calls, references and imports from the immutable checkpoint", async () => {
  const f = await fixture();
  try {
    f.write("pkg.py", "def target():\n    return 1\n");
    f.write("main.py", "from pkg import target\ndef caller():\n    return target()\n");
    mkdirSync(join(f.repo, "service"));
    f.write("service/http.py", "from pkg import target\ndef endpoint():\n    return target()\n");
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    const index = f.store.get("codebase_index", String(result.index_id));
    assert.equal(index.analyzer, "python-ast-static");
    const graph = projectGraph(f, String(result.workspace_id));
    const shards = (index.shard_ids as string[]).map(id => graph.read(id));
    const nodes = shards.flatMap(shard => shard.nodes as JsonObject[]);
    const target = nodes.find(node => node.name === "target" && node.path === "pkg.py")!;
    const caller = nodes.find(node => node.name === "caller")!;
    const edges = shards.flatMap(shard => shard.edges as JsonObject[]);
    const callEdge = edges.find(edge => edge.kind === "calls" && edge.from_node_id === caller.id && edge.to_node_id === target.id)!;
    assert(callEdge);
    assert.equal((callEdge.source_span as JsonObject).start_line, 3);
    assert.equal((callEdge.source_span as JsonObject).start_column, 12);
    const endpoint = nodes.find(node => node.name === "endpoint" && node.path === "service/http.py")!;
    assert(edges.some(edge => edge.kind === "calls" && edge.from_node_id === endpoint.id && edge.to_node_id === target.id),
      "absolute imports from nested Python modules must resolve from the repository root");
    assert(edges.some(edge => edge.kind === "references" && edge.to_node_id === target.id));
    assert(edges.some(edge => edge.kind === "imports"));
    assert.equal((index.analysis as JsonObject).certainty, "partial");
  } finally { f.close(); }
});

test("semantic onboarding incrementally refreshes Python importers and matches a clean graph", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "pkg"));
    f.write("pkg/base.py", "def target():\n    return 1\n");
    f.write("pkg/service.py", "from .base import target\ndef caller():\n    return target()\n");
    f.write("pkg/view.py", "def unrelated():\n    return 3\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(first.status, "ready");
    const firstUnits = projectAnalysis(f, String(first.workspace_id), "codebase_python_file_analysis", 10);
    assert.equal(firstUnits.length, 3);
    const firstVersions = new Map(firstUnits.map(unit => [String(unit.path), unit.version]));

    f.write("pkg/base.py", "def target():\n    return 2\n");
    const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(updated.status, "ready");
    const summary = updated.summary as JsonObject;
    const combined = (summary.diagnostics as JsonObject[])[0] as JsonObject;
    const python = (combined.languages as JsonObject[]).find(item => item.analyzer === "python-ast-static") as JsonObject;
    const diagnostics = python.diagnostics as JsonObject;
    assert.equal(diagnostics.incremental_mode, "incremental");
    assert.equal(diagnostics.incremental_reason, "changed_modules_and_reverse_import_closure");

    const files = repositoryFiles(f.repo).files.filter(file => file.language === "py");
    const clean = analyzePythonCheckpoint(files, { includeFileUnits: true }).analysis!;
    const units = projectAnalysis(f, String(first.workspace_id), "codebase_python_file_analysis", 10);
    const updatedVersions = new Map(units.map(unit => [String(unit.path), unit.version]));
    assert.notEqual(updatedVersions.get("pkg/base.py"), firstVersions.get("pkg/base.py"), "changed Python unit must be persisted");
    assert.equal(updatedVersions.get("pkg/service.py"), firstVersions.get("pkg/service.py"), "unchanged importer facts must not be rewritten");
    assert.equal(updatedVersions.get("pkg/view.py"), firstVersions.get("pkg/view.py"), "unrelated Python facts must not be rewritten");
    const sort = (items: JsonObject[]) => [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    assert.deepEqual(sort(units.flatMap(unit => unit.nodes as JsonObject[])), sort((clean.file_units as JsonObject[]).flatMap(unit => unit.nodes as JsonObject[])));
    assert.deepEqual(sort(units.flatMap(unit => unit.edges as JsonObject[])), sort((clean.file_units as JsonObject[]).flatMap(unit => unit.edges as JsonObject[])));
    const repeated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(repeated.reused, true);
  } finally { f.close(); }
});

test("Python incremental budget overflow retries a full graph when per-file caching is unavailable", async () => {
  const f = await fixture();
  try {
    f.write("main.py", "def target():\n    return 1\n");
    f.write("caller.py", "from main import target\ndef caller():\n    return target()\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    f.write("main.py", "def target():\n    return 2\n");
    let calls = 0;
    Object.assign(f.service, { analyzePython: (files: Parameters<typeof analyzePythonCheckpoint>[0], options?: Parameters<typeof analyzePythonCheckpoint>[1]) => {
      calls++;
      if (calls === 1) return { analysis: { nodes: [], edges: [], diagnostics: { budget_limited: true } } };
      return analyzePythonCheckpoint(files, { ...options, includeFileUnits: false });
    } });
    const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(updated.status, "ready");
    assert.equal(calls, 2);
    const summary = updated.summary as JsonObject;
    const python = ((summary.diagnostics as JsonObject[])[0].languages as JsonObject[]).find(item => item.analyzer === "python-ast-static") as JsonObject;
    assert.equal((python.diagnostics as JsonObject).incremental_mode, undefined);
    assert.equal(projectAnalysis(f, String(first.workspace_id), "codebase_python_file_analysis", 10).length, 2);
    assert(f.store.get("codebase_index", String(updated.index_id)));
  } finally { f.close(); }
});

test("Python incremental results from a changed analyzer version trigger a full cache refresh", async () => {
  const f = await fixture();
  try {
    f.write("main.py", "def target():\n    return 1\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    f.write("main.py", "def target():\n    return 2\n");
    let calls = 0;
    Object.assign(f.service, { analyzePython: (files: Parameters<typeof analyzePythonCheckpoint>[0], options?: Parameters<typeof analyzePythonCheckpoint>[1]) => {
      calls++;
      const full = analyzePythonCheckpoint(files, { ...options, includeFileUnits: true }).analysis!;
      const file_units = (full.file_units as JsonObject[]).map(unit => {
        const changed = { ...unit, analyzer_version: "changed" };
        return { ...changed, unit_digest: pythonFileUnitDigest(changed as never) };
      });
      return { analysis: { ...full, analyzer_version: "changed", file_units,
        diagnostics: { ...(full.diagnostics as JsonObject), incremental_mode: "full" } } };
    } });
    const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(updated.status, "ready");
    assert.equal(calls, 1);
    const summary = updated.summary as JsonObject;
    const python = (((summary.diagnostics as JsonObject[])[0] as JsonObject).languages as JsonObject[])
      .find(item => item.analyzer === "python-ast-static") as JsonObject;
    assert.equal((python.diagnostics as JsonObject).incremental_reason, "analyzer_version_changed");
    assert.equal(projectAnalysis(f, String(first.workspace_id), "codebase_python_file_analysis", 10)[0].source_digest,
      repositoryFiles(f.repo).files.find(file => file.path === "main.py")!.digest);
  } finally { f.close(); }
});

test("Python analyzer failure during incremental retry keeps basic index and reports the diagnostic", async () => {
  const f = await fixture();
  try {
    f.write("main.py", "def target():\n    return 1\n");
    f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    f.write("main.py", "def target():\n    return 2\n");
    let calls = 0;
    Object.assign(f.service, { analyzePython: () => {
      calls++;
      return calls === 1 ? {} : { diagnostic: { language: "python", status: "unavailable", reason: "python_runtime_unavailable" } };
    } });
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    assert.equal(calls, 2);
    const diagnostics = (result.summary as JsonObject).diagnostics as JsonObject[];
    assert(diagnostics.some(item => item.reason === "python_runtime_unavailable"));
  } finally { f.close(); }
});

test("Python incremental retry uses the default analyzer when the host adapter disappears", async () => {
  const f = await fixture();
  try {
    f.write("main.py", "def target():\n    return 1\n");
    f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    f.write("main.py", "def target():\n    return 2\n");
    let reads = 0;
    Object.defineProperty(f.service, "analyzePython", { configurable: true, get() {
      reads++;
      return reads === 1 ? () => ({ analysis: { nodes: [], edges: [], diagnostics: { budget_limited: true } } }) : undefined;
    } });
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    assert(reads >= 2);
  } finally { f.close(); }
});

test("Python full analyzer without file units imports its complete graph without caching units", async () => {
  const f = await fixture();
  try {
    f.write("main.py", "def target():\n    return 1\n");
    f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    f.write("extra.py", "def added():\n    return 2\n");
    Object.assign(f.service, { analyzePython: (files: Parameters<typeof analyzePythonCheckpoint>[0]) => ({
      analysis: analyzePythonCheckpoint(files, { includeFileUnits: false }).analysis,
    }) });
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    assert.equal(projectAnalysis(f, String(result.workspace_id), "codebase_python_file_analysis", 10).length, 1);
  } finally { f.close(); }
});

test("Python file-set deletion removes stale per-file graph units", async () => {
  const f = await fixture();
  try {
    f.write("keep.py", "def keep():\n    return 1\n");
    f.write("remove.py", "def remove():\n    return 2\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(projectAnalysis(f, String(first.workspace_id), "codebase_python_file_analysis", 10).length, 2);
    rmSync(join(f.repo, "remove.py"));
    const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const cached = projectAnalysis(f, String(first.workspace_id), "codebase_python_file_analysis", 10);
    assert.equal(updated.status, "ready");
    assert.deepEqual(cached.map(item => item.path), ["keep.py"]);
  } finally { f.close(); }
});

test("empty Python file-unit output safely falls back with a diagnostic", async () => {
  const f = await fixture();
  try {
    f.write("main.py", "def target():\n    return 1\n");
    Object.assign(f.service, { analyzePython: () => ({ analysis: {
      format: "craft-static-analysis-v1", analyzer: "python-test", analyzer_version: "test", nodes: [], edges: [],
      file_units: [], diagnostics: { budget_limited: false },
    } }) });
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    assert.equal(projectAnalysis(f, String(result.workspace_id), "codebase_python_file_analysis", 10).length, 0);
    assert((result.summary as JsonObject).diagnostics instanceof Array);
    assert(((result.summary as JsonObject).diagnostics as JsonObject[]).some(item => item.reason === "analysis_empty_or_missing_file_units"));
  } finally { f.close(); }
});

test("semantic onboarding reports adapter gaps and preserves basic indexing when analyzers are unavailable", async () => {
  const f = await fixture();
  try {
    f.write("Main.java", "class Main {}");
    f.write("main.ts", "export function target() {}\n");
    f.write("main.py", "def caller(): pass\n");
    f.write("infra.tf", "resource \"example\" \"one\" {}\n");
    f.write("project.yaml", "name: fixture\n");
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "cpp", command: process.execPath }] }));
    let typeScriptAnalyzerCalled = false;
    Object.assign(f.service, {
      analyzeTypeScript: () => { typeScriptAnalyzerCalled = true; throw new Error("private analyzer detail"); },
      analyzePython: () => ({ diagnostic: { language: "python", status: "unavailable", reason: "python_runtime_unavailable" } }),
      analyzeJava: () => ({ diagnostic: { language: "java", status: "unavailable", reason: "jdk_unavailable" } }),
    });
    assert.equal(typeof (f.service as unknown as { analyzeTypeScript?: unknown }).analyzeTypeScript, "function");
    const degraded = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(typeScriptAnalyzerCalled, true);
    const diagnostics = (degraded.summary as JsonObject).diagnostics as JsonObject[];
    assert.equal((degraded.summary as JsonObject).analyzer, "builtin-regex-static-v1");
    assert(diagnostics.some(item => item.language === "java" && item.reason === "jdk_unavailable"));
    assert(diagnostics.some(item => item.language === "typescript" && item.reason === "analysis_failed"));
    assert(diagnostics.some(item => item.language === "python" && item.reason === "python_runtime_unavailable"));
    assert(diagnostics.some(item => item.language === "tf" && item.reason === "no_semantic_adapter"));
    assert(diagnostics.some(item => item.language === "yaml" && item.reason === "unsupported_lsp_language"));
  } finally { f.close(); }
});

test("semantic analyzer returning no graph without a diagnostic uses the ordinary index fallback", async () => {
  const f = await fixture();
  try {
    f.write("main.py", "def value(): pass\n");
    Object.assign(f.service, { analyzePython: () => ({}) });
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(result.status, "ready");
    assert.equal((result.summary as JsonObject).analyzer, "builtin-regex-static-v1");
  } finally { f.close(); }
});

test("repository activation is rechecked after semantic analysis before index publication", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export const value = 1;\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo });
    f.write("main.ts", "export const changed = 2;\n");
    Object.assign(f.service, { analyzeTypeScript: () => {
      f.service.codebaseDeactivate({ workspace_id: String(first.workspace_id), actor: "test-revocation" });
      return {};
    } });
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(result.status, "disabled");
  } finally { f.close(); }
});

test("source discovery honors ignores, excludes, disabled and bounded reads without traversing links", async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo }).status, "empty");
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.root }).status, "skipped");
    assert.throws(() => repositoryRoot(null), /project_root/);
    assert.throws(() => repositoryRoot("  "), /project_root/);
    f.write("a.ts", "export const item = 1"); assert.throws(() => repositoryRoot(join(f.repo, "a.ts")), /directory/);
    f.write(".gitignore", "ignored.ts\n"); f.write("ignored.ts", "secret"); f.write("exclude.py", "def hidden(): pass");
    mkdirSync(join(f.repo, "path", "to", "venv", "lib", "python3.11", "site-packages"), { recursive: true });
    f.write("path/to/venv/lib/python3.11/site-packages/example.py", "class DependencyOnly: pass\n");
    f.git("add", "path/to/venv/lib/python3.11/site-packages/example.py");
    mkdirSync(join(f.repo, "dist")); f.write("dist/a.ts", "build output");
    symlinkSync(join(f.repo, "a.ts"), join(f.repo, "link.ts"));
    symlinkSync(join(f.repo, "missing-target.ts"), join(f.repo, "dangling.ts"));
    mkdirSync(join(f.repo, "linked-directory")); f.write("linked-directory/external.ts", "outside snapshot"); f.git("add", "linked-directory/external.ts");
    rmSync(join(f.repo, "linked-directory"), { recursive: true }); symlinkSync(f.root, join(f.repo, "linked-directory"), "dir");
    writeFileSync(join(f.root, "external.ts"), "external source must not be read");
    f.write("deleted.ts", "deleted from working tree"); f.git("add", "deleted.ts"); rmSync(join(f.repo, "deleted.ts"));
    f.write("null.ts", "\0"); f.write("huge.ts", "x".repeat(512 * 1024 + 1));
    f.write(".craft-codebase.json", JSON.stringify({ exclude_paths: ["exclude.py", "other/"] }));
    const files = repositoryFiles(f.repo); assert.deepEqual(files.files.map(file => file.path), ["a.ts"]); assert.equal(files.omitted, 5);
    assert.deepEqual(files.omitted_by_language, { "typescript-javascript": 5 });
    for (const config of ["null", "[]", '{"enabled":1}', '{"exclude_paths":"a"}', '{"exclude_paths":["../outside"]}', '{"exclude_paths":["/root"]}', '{"exclude_paths":["a\\\\b"]}', '{"exclude_paths":[""]}']) {
      f.write(".craft-codebase.json", config); assert.throws(() => repositoryFiles(f.repo));
    }
    rmSync(join(f.repo, ".craft-codebase.json")); symlinkSync(join(f.repo, "a.ts"), join(f.repo, ".craft-codebase.json")); assert.throws(() => repositoryFiles(f.repo), /regular file/); rmSync(join(f.repo, ".craft-codebase.json"));
    f.write(".craft-codebase.json", '{"enabled":false}'); assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo }).status, "disabled");
    f.write(".craft-codebase.json", '{}'); const before = process.env.CRAFT_CODEBASE_AUTO_INDEX;
    try { process.env.CRAFT_CODEBASE_AUTO_INDEX = "0"; assert.equal(repositoryFiles(f.repo).state, "disabled"); } finally { if (before === undefined) delete process.env.CRAFT_CODEBASE_AUTO_INDEX; else process.env.CRAFT_CODEBASE_AUTO_INDEX = before; }
    for (let i = 0; i < 1210; i++) f.write(`file${i}.ts`, "export const a=1;");
    f.write("zz-last.java", "class LastJava {}"); f.write("zzz-last.py", "class LastPython: pass\n");
    const balanced = repositoryFiles(f.repo);
    assert.equal(balanced.files.length, 1200);
    assert(balanced.files.some(file => file.path === "zz-last.java"));
    assert(balanced.files.some(file => file.path === "zzz-last.py"));
    assert.equal(balanced.files.filter(file => /^(?:tsx?|mts|cts|jsx?|mjs|cjs)$/u.test(file.language)).length, 1197);
    assert.equal(balanced.files.filter(file => file.language === "py").length, 2);
    assert.equal(balanced.omitted, 19);
    assert.deepEqual(balanced.omitted_by_language, { "typescript-javascript": 19 });
    assert.deepEqual(repositoryFiles(f.repo).files.map(file => [file.path, file.digest]), balanced.files.map(file => [file.path, file.digest]));
  } finally { f.close(); }
});

test("repository source discovery never indexes project Craft data even when Git does not ignore it", async () => {
  const f = await fixture();
  try {
    f.write("go.mod", "module example.com/project\n\ngo 1.23\n");
    mkdirSync(join(f.repo, ".craft_data", "codebase", "runtime"), { recursive: true });
    f.write(".craft_data/go.mod", "module example.com/private-data\n\ngo 1.23\n");
    f.write(".craft_data/codebase/runtime/snapshot.go", "package snapshot\nfunc InternalSnapshot() {}\n");

    const discovered = repositoryFiles(f.repo);

    assert.deepEqual(discovered.files.map(file => file.path), []);
    assert.deepEqual(discovered.context_files.map(file => file.path), ["go.mod"]);
    assert.equal(discovered.omitted, 0);
    assert.equal(discovered.context_files_omitted, 0);
  } finally { f.close(); }
});

test("repository policy digest detects same-path ignore and Codebase config edits", async () => {
  const f = await fixture();
  const oldXdg = process.env.XDG_CONFIG_HOME, oldGlobalConfig = process.env.GIT_CONFIG_GLOBAL, oldNoSystem = process.env.GIT_CONFIG_NOSYSTEM, oldAutoIndex = process.env.CRAFT_CODEBASE_AUTO_INDEX;
  try {
    process.env.XDG_CONFIG_HOME = join(f.root, "empty-xdg");
    process.env.GIT_CONFIG_GLOBAL = join(f.root, "empty-git-config");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
    const noConfiguredExclude = (root: string, args: string[], input?: string) => {
      if (args[0] === "config") throw Object.assign(new Error("No configured global exclude"), { status: 1 });
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"] });
    };
    const noExcludeSnapshot = repositoryPolicySnapshot(f.repo, noConfiguredExclude);
    assert.equal(repositoryPolicySnapshotCurrent(noExcludeSnapshot, noConfiguredExclude), true);
    const configCommandFailure = (root: string, args: string[], input?: string) => {
      if (args[0] === "config") throw Object.assign(new Error("Git config failed"), { status: 2 });
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"] });
    };
    assert.throws(() => repositoryPolicySnapshotCurrent(noExcludeSnapshot, configCommandFailure), /Git config failed/u);
    const configuredXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    const homeDefaultSnapshot = repositoryPolicySnapshot(f.repo, noConfiguredExclude);
    assert.equal(repositoryPolicySnapshotCurrent(homeDefaultSnapshot, noConfiguredExclude), true);
    process.env.XDG_CONFIG_HOME = configuredXdg;
    const initial = repositoryPolicyDigest(f.repo);
    f.write(".gitignore", "first.ts\n");
    const firstIgnore = repositoryPolicyDigest(f.repo);
    assert.notEqual(firstIgnore, initial);
    const snapshot = repositoryPolicySnapshot(f.repo);
    assert.equal(repositoryPolicySnapshotCurrent(snapshot), true);
    f.write(".gitignore", "second.ts\n");
    assert.equal(repositoryPolicySnapshotCurrent(snapshot), false);
    assert.notEqual(repositoryPolicyDigest(f.repo), firstIgnore);
    mkdirSync(join(f.root, "empty-xdg", "git"), { recursive: true });
    const temporaryIgnore = join(f.root, "empty-xdg", "git", "ignore");
    writeFileSync(temporaryIgnore, "temporary-ignore.ts\n");
    const ignoreSnapshot = repositoryPolicySnapshot(f.repo);
    unlinkSync(temporaryIgnore);
    assert.equal(repositoryPolicySnapshotCurrent(ignoreSnapshot), false);
    mkdirSync(temporaryIgnore);
    assert.throws(() => repositoryPolicySnapshotCurrent(ignoreSnapshot), /EISDIR|illegal operation on a directory/u);
    rmSync(temporaryIgnore, { recursive: true, force: true });
    rmSync(join(f.root, "empty-xdg", "git"), { recursive: true, force: true });
    f.write(".craft-codebase.json", JSON.stringify({ exclude_paths: ["generated"] }));
    const firstConfig = repositoryPolicyDigest(f.repo);
    const configSnapshot = repositoryPolicySnapshot(f.repo);
    assert.equal(repositoryPolicySnapshotCurrent(configSnapshot), true);
    f.write(".craft-codebase.json", JSON.stringify({ exclude_paths: ["fixtures"] }));
    assert.equal(repositoryPolicySnapshotCurrent(configSnapshot), false);
    assert.notEqual(repositoryPolicyDigest(f.repo), firstConfig);
    unlinkSync(join(f.repo, ".craft-codebase.json"));
    writeFileSync(join(f.root, "outside-config.json"), "{}");
    symlinkSync(join(f.root, "outside-config.json"), join(f.repo, ".craft-codebase.json"));
    assert.throws(() => repositoryPolicyDigest(f.repo), /regular file/u);
    assert.throws(() => repositoryPolicySnapshotCurrent(configSnapshot), /regular file/u);
    unlinkSync(join(f.repo, ".craft-codebase.json"));
    mkdirSync(join(f.repo, ".craft-codebase.json"));
    assert.throws(() => repositoryPolicyDigest(f.repo), /regular file/u);
    assert.throws(() => repositoryPolicySnapshotCurrent(configSnapshot), /regular file/u);
    rmSync(join(f.repo, ".craft-codebase.json"), { recursive: true });
    f.write(".git/info/exclude", "local-ignore.ts\n");
    const localExclude = repositoryPolicyDigest(f.repo);
    f.write(".git/info/exclude", "other-local-ignore.ts\n");
    assert.notEqual(repositoryPolicyDigest(f.repo), localExclude);
    const globalIgnore = join(f.root, "global-ignore");
    writeFileSync(globalIgnore, "first-global-ignore.ts\n");
    f.git("config", "core.excludesfile", globalIgnore);
    const configuredSnapshot = repositoryPolicySnapshot(f.repo);
    assert.equal(repositoryPolicySnapshotCurrent(configuredSnapshot), true);
    f.git("config", "core.excludesfile", join(f.root, "different-global-ignore"));
    assert.equal(repositoryPolicySnapshotCurrent(configuredSnapshot), false);
    f.git("config", "core.excludesfile", globalIgnore);
    process.env.CRAFT_CODEBASE_AUTO_INDEX = oldAutoIndex === "0" ? "1" : "0";
    assert.equal(repositoryPolicySnapshotCurrent(configuredSnapshot), false);
    const firstGlobal = repositoryPolicyDigest(f.repo);
    writeFileSync(globalIgnore, "second-global-ignore.ts\n");
    assert.notEqual(repositoryPolicyDigest(f.repo), firstGlobal);
    mkdirSync(join(f.root, "empty-xdg", "git"), { recursive: true });
    mkdirSync(join(f.root, "empty-xdg", "git", "ignore"));
    assert.throws(() => repositoryPolicyDigest(f.repo));
    const failConfig = (root: string, args: string[], input?: string) => {
      if (args[0] === "config") throw Object.assign(new Error("Command failed"), { status: 2 });
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"] });
    };
    assert.throws(() => repositoryPolicyDigest(f.repo, failConfig));
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldGlobalConfig;
    if (oldNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = oldNoSystem;
    if (oldAutoIndex === undefined) delete process.env.CRAFT_CODEBASE_AUTO_INDEX; else process.env.CRAFT_CODEBASE_AUTO_INDEX = oldAutoIndex;
    f.close();
  }
});

test("repository source selection recognizes supported source and configuration extensions", async () => {
  const f = await fixture();
  try {
    const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs", ".c", ".h", ".cc", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".cpp", ".mm", ".m", ".cs", ".rb", ".php", ".kt", ".kts", ".scala", ".sc", ".groovy", ".swift", ".dart", ".lua", ".sh", ".bash", ".ex", ".exs", ".hs", ".lhs", ".ml", ".mli", ".clj", ".cljs", ".cljc", ".edn", ".pl", ".pm", ".r", ".jl", ".zig", ".elm", ".erl", ".hrl", ".fs", ".fsi", ".fsx", ".sol", ".tf", ".tfvars", ".hcl", ".nix", ".vue", ".svelte", ".astro", ".html", ".css", ".scss", ".sass", ".less", ".sql", ".ps1", ".psm1", ".proto", ".toml", ".yaml", ".yml"];
    const paths = [...extensions.map((extension, index) => `source-${String(index).padStart(2, "0")}${extension}`), "s.TS", "Ä.ts", "z.ts"];
    for (const path of paths) f.write(path, "source");
    const selected = repositoryFiles(f.repo);
    assert.equal(selected.files.length, paths.length);
    assert.deepEqual(selected.files.map(file => file.path), [...paths].sort());
    assert.deepEqual(selected.omitted_by_language, {});
    assert.equal(selected.files.find(file => file.path === "s.TS")?.language, "ts");
    assert.equal(selected.files.find(file => file.path.endsWith(".kt"))?.language, "kt");
    assert.equal(selected.files.find(file => file.path.endsWith(".yaml"))?.language, "yaml");
  } finally { f.close(); }
});

test("repository source selection stops at its file-count limit", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "src"));
    for (let index = 0; index < 1_201; index++) f.write(`src/file-${index}.ts`, "export {};\n");
    const selected = repositoryFiles(f.repo);
    assert.equal(selected.files.length, 1_200);
    assert.equal(selected.omitted, 1);
  } finally { f.close(); }
});

test("repository Go context files omit missing, linked, oversized and binary inputs and honor filters", async () => {
  const f = await fixture();
  try {
    for (const directory of ["ignored", "vendor", "excluded", "large", "missing"]) mkdirSync(join(f.repo, directory));
    f.write("ignored/go.mod", "module ignored\n"); f.write("vendor/go.mod", "module vendor\n");
    f.write("excluded/go.sum", "excluded\n"); f.write("large/go.work", "x".repeat(512 * 1024 + 1));
    f.write("missing/go.mod", "module missing\n");
    f.git("add", "ignored/go.mod", "vendor/go.mod", "missing/go.mod");
    rmSync(join(f.repo, "missing/go.mod"));
    f.write(".gitignore", "ignored/go.mod\n");
    writeFileSync(join(f.repo, "go.mod"), "module root\n");
    writeFileSync(join(f.repo, "go.work.sum"), "github.com/example/module v1.0.0 h1:fixture=\n");
    writeFileSync(join(f.repo, "go.sum"), "binary\0body");
    writeFileSync(join(f.repo, "package.json"), "{}\n");
    writeFileSync(join(f.repo, "go-work-target"), "module linked target\n");
    symlinkSync(join(f.repo, "go-work-target"), join(f.repo, "go.work"));
    f.git("add", "go.mod", "go.work.sum", "package.json");
    f.write(".craft-codebase.json", JSON.stringify({ exclude_paths: ["excluded"] }));
    const selected = repositoryFiles(f.repo);
    assert.deepEqual(selected.context_files.map(item => item.path), ["go.mod", "go.work.sum"]);
    assert.equal(selected.context_files_omitted, 4);
  } finally { f.close(); }
});

test("repository file selection stops at the aggregate byte limit before visiting later languages", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "c")); mkdirSync(join(f.repo, "csharp")); mkdirSync(join(f.repo, "typescript"));
    // The final C source reaches the aggregate cap before the 24th C# file is visited.
    for (let index = 0; index < 24; index++) f.write(`c/file-${index}.c`, "x".repeat(index === 23 ? 524_277 : 524_268));
    for (let index = 0; index < 30; index++) f.write(`csharp/later-${index}.cs`, "x".repeat(20));
    f.write("typescript/main.ts", "x".repeat(11));
    const selected = repositoryFiles(f.repo);
    assert.equal(selected.files.length, 48);
    assert.equal(selected.files.filter(file => file.language === "c").length, 24);
    assert.equal(selected.files.filter(file => file.language === "cs").length, 23);
    assert.equal(selected.files.some(file => file.path === "typescript/main.ts"), true);
    assert.equal(selected.omitted, 7);
  } finally { f.close(); }
});

test("repository byte budget skips oversized remainder and reports language counts", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "src"));
    const content = "x".repeat(512 * 1024);
    for (let i = 0; i < 12; i++) f.write(`src/java${String(i).padStart(2, "0")}.java`, content);
    for (let i = 0; i < 12; i++) f.write(`src/python${String(i).padStart(2, "0")}.py`, content);
    for (let i = 0; i < 12; i++) f.write(`src/typescript${String(i).padStart(2, "0")}.ts`, content);
    const selected = repositoryFiles(f.repo);
    assert.equal(selected.files.length, 24);
    assert.equal(selected.omitted, 12);
    assert.deepEqual(selected.omitted_by_language, { "typescript-javascript": 4, java: 4, python: 4 });
    assert.deepEqual(Object.fromEntries(["java", "py", "ts"].map(language => [language, selected.files.filter(file => file.language === language).length])),
      { java: 8, py: 8, ts: 8 });
    assert.deepEqual(repositoryFiles(f.repo).files.map(file => [file.path, file.digest]), selected.files.map(file => [file.path, file.digest]));
  } finally { f.close(); }
});

test("repository file-byte limit skips an unfit large file and continues with a smaller language file", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "src"));
    const halfMiB = "x".repeat(512 * 1024);
    for (let i = 0; i < 23; i++) f.write(`src/a${String(i).padStart(2, "0")}.ts`, halfMiB);
    f.write("src/b-small.ts", "s".repeat(100 * 1024)); f.write("src/c-large.ts", halfMiB);
    const selected = repositoryFiles(f.repo);
    assert.equal(selected.files.length, 24);
    assert.equal(selected.files.some(file => file.path === "src/b-small.ts"), true);
    assert.equal(selected.files.some(file => file.path === "src/c-large.ts"), false);
    assert.deepEqual(selected.omitted_by_language, { "typescript-javascript": 1 });
  } finally { f.close(); }
});

test("repository Context pack carries language-level source omissions into partial diagnostics", async () => {
  const f = await fixture();
  try {
    f.write("oversized.py", "x".repeat(512 * 1024 + 1));
    const pack = await f.service.contextOpen({ project_root: f.repo, query: "Python implementation review" });
    const codebase = pack.codebase as JsonObject;
    assert.equal(codebase.status, "empty");
    assert.deepEqual(codebase.omitted_by_language, { python: 1 });
    assert.equal(pack.pack_status, "partial");
    assert((pack.pack_receipt as JsonObject).partial_reasons instanceof Array);
    assert(((pack.pack_receipt as JsonObject).partial_reasons as string[]).includes("codebase_files_omitted"));
  } finally { f.close(); }
});

test("repository ignore-check failures other than no matches fail closed", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export const value = 1;");
    const failIgnore = (root: string, args: string[], input?: string) => {
      if (args[0] === "check-ignore") throw Object.assign(new Error("Command failed"), { status: 2 });
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"] });
    };
    assert.throws(() => repositoryFiles(f.repo, "", failIgnore), /Command failed/);
  } finally { f.close(); }
});

test("aggregate MCP resolves bounded scope and code references while standalone surfaces remain isolated", async () => {
  const f = await fixture();
  try {
    f.write("a.ts", "export function alpha() { return 1; }");
    const server = new McpServer(f.service, "component-context-daily");
    const contextTool = server.tools.find(tool => tool.name === "craft_context_open") as JsonObject;
    assert.deepEqual((((contextTool.inputSchema as JsonObject).properties as JsonObject).response_detail as JsonObject).enum, ["compact", "full"]);
    const codebasePrototype = Object.getPrototypeOf(f.service.codebase) as { contextProjection(args: JsonObject): JsonObject };
    const originalProjection = codebasePrototype.contextProjection;
    let projectionLimit = 0;
    codebasePrototype.contextProjection = function (args) { projectionLimit = Number(args.limit); return originalProjection.call(this, args); };
    let pack: JsonObject;
    try { pack = await result(server, "craft_context_open", { project_root: f.repo, query: "alpha", include_codebase: true }); }
    finally { codebasePrototype.contextProjection = originalProjection; }
    assert.equal(pack.host_execution_authority, false); assert.equal((pack.codebase as JsonObject).status, "ready");
    assert.equal(projectionLimit, 4, "Codebase retrieval should keep one fallback while bounding candidates to the shared Context budget");
    assert.equal(((pack.codebase as JsonObject).references as unknown[]).length, 1);
    assert.equal((pack.pack_receipt as JsonObject).max_items, 3);
    assert.equal((pack.pack_receipt as JsonObject).max_chars, 1_200);
    assert.deepEqual((pack.receipt as JsonObject).members, ["experience", "knowledge", "memory"]);
    const raw = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "craft_context_open", arguments: { project_root: f.repo, query: "alpha", include_codebase: true } } }) as JsonObject;
    const rawResult = raw.result as JsonObject;
    const content = rawResult.content as JsonObject[];
    const contentText = String(content[0]?.text ?? "");
    const compact = rawResult.structuredContent as JsonObject;
    assert.deepEqual(JSON.parse(contentText), compact);
    assert(contentText.length < 4_000);
    assert(Number((compact.injection_measurement as JsonObject).response_estimated_tokens) <= 2_000);
    assert.equal((compact.receipt as JsonObject).id, (pack.receipt as JsonObject).id);
    const fullWithoutBudget = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "craft_context_open", arguments: { project_root: f.repo, query: "alpha", include_codebase: true, response_detail: "full" } } }) as JsonObject;
    assert.equal((fullWithoutBudget.error as JsonObject).code, -32602);
    const invalidDetail = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "craft_context_open", arguments: { project_root: f.repo, query: "alpha", include_codebase: true, response_detail: "everything" } } }) as JsonObject;
    assert.equal((invalidDetail.error as JsonObject).code, -32602);
    const full = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "craft_context_open", arguments: { project_root: f.repo, query: "alpha", include_codebase: true, response_detail: "full", max_tokens: 5_000 } } }) as JsonObject;
    const fullResult = (full.result as JsonObject).structuredContent as JsonObject;
    assert(Array.isArray((fullResult.receipt as JsonObject).deduplicated_refs));
    assert(estimateTokens(JSON.stringify(fullResult)) <= 5_000);
    assert.equal(String(((full.result as JsonObject).content as JsonObject[])[0]?.text), JSON.stringify(fullResult));
    const reduced = await result(server, "craft_context_open", { project_root: f.repo, query: "alpha", include_codebase: true, max_items: 1, max_chars: 400 });
    assert.equal((reduced.pack_receipt as JsonObject).max_items, 1);
    assert.equal((reduced.pack_receipt as JsonObject).max_chars, 400);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "alpha", max_items: 8 }), /configured maximum/);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "alpha", max_chars: 8_000 }), /configured maximum/);
    const tiny = await result(server, "craft_context_open", { project_root: f.repo, query: "alpha", include_codebase: true, max_chars: 1 });
    assert.equal((tiny.pack_receipt as JsonObject).total_used_chars, 0);
    const standalone = new McpServer(f.service, "component-codebase");
    assert.equal((await result(standalone, "craft_codebase_repository_ensure", { project_root: f.repo })).reused, true);
    assert(!standalone.tools.some(tool => tool.name === "craft_context_open"));
    assert(!new McpServer(f.service, "component-memory-daily").tools.some(tool => tool.name === "craft_codebase_repository_ensure"));
    f.write(".craft-codebase.json", "invalid");
    const degraded = await f.service.contextOpen({ project_root: f.repo, query: "alpha", include_codebase: true }); assert.equal((degraded.codebase as JsonObject).status, "unavailable"); assert(degraded.receipt);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "" }), /query/);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "a", index_depth: "invalid" }), /index_depth/);
    await f.service.contextOpen({ project_root: f.repo, query: "a", index_depth: "basic" });
    for (const budget of [0, 1.5]) await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "alpha", max_chars: budget }), /budget/);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "alpha", max_items: 0 }), /budget/);
  } finally { f.close(); }
});

test("Context Pack Receipt fails closed on a conflicting prior version and a concurrent conflicting publisher", async () => {
  const f = await fixture();
  const originalFind = f.store.find.bind(f.store);
  try {
    const conflictRecord = (id: string) => ({ id, identity_digest: "sha256:conflict" }) as unknown as NonNullable<ReturnType<CraftStore["find"]>>;
    f.store.find = ((kind: string, id: string, version?: number, hydrate?: boolean) => {
      if (kind === "context_pack_receipt" && id.startsWith("context_pack_")) return conflictRecord(id);
      return originalFind(kind, id, version, hydrate);
    }) as typeof f.store.find;
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "receipt conflict", include_codebase: false }), /idempotency conflict/u);

    let injected = false;
    const racingFind = (kind: string, id: string, version?: number, hydrate?: boolean) => {
      if (kind === "context_pack_receipt" && id.startsWith("context_pack_") && !injected) {
        injected = true;
        f.store.find = originalFind as typeof f.store.find;
        f.store.create(kind, id, { identity_digest: "sha256:concurrent-conflict" });
        f.store.find = racingFind as typeof f.store.find;
        return null;
      }
      return originalFind(kind, id, version, hydrate);
    };
    f.store.find = racingFind as typeof f.store.find;
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "receipt race", include_codebase: false }), /idempotency conflict/u);
    assert.equal(injected, true);
  } finally {
    f.store.find = originalFind as typeof f.store.find;
    f.close();
  }
});

test("context automatically ingests bounded project Knowledge into project data once", async () => {
  const f = await fixture();
  try {
    f.write("README.md", "# Project knowledge\nUse the checked local verification command.\n");
    f.write("AGENTS.md", "# Agent rules\nKeep project facts scoped to this repository.\n");
    mkdirSync(join(f.repo, ".serena", "memories"), { recursive: true });
    f.write(".serena/memories/workflow.md", "# Workflow\nRun focused checks before broad validation.\n");
    const server = new McpServer(f.service, "component-context-daily");
    const first = await result(server, "craft_context_open", { project_root: f.repo, query: "project verification workflow", include_codebase: false });
    const discovery = first.knowledge_source_discovery as JsonObject;
    assert.equal(discovery.status, "ready");
    assert.equal(discovery.sources_registered, 3);
    assert.equal(discovery.sources_ingested, 3);
    assert.equal(Number(discovery.candidates_created) > 0, true);
    assert.equal(((first.trace_correlation as JsonObject).operation), "craft_context_open");
    assert.equal((first.trace_correlation as JsonObject).auto_finalized, true);
    const scope = ((first.receipt as JsonObject).scope as JsonObject);
    const sources = f.store.list("knowledge_source", 20, row => (row.scope as JsonObject).kind === scope.kind && (row.scope as JsonObject).id === scope.id);
    assert.equal(sources.length, 3);
    assert(sources.every(source => source.trust === "bounded" && source.access === "read_only" && String(source.id).startsWith("project_autodiscovered_")));
    assert.equal(f.store.list("knowledge_fragment").length > 0, true);
    const contentRoot = join(projectStorageDirectory(f.store.paths, f.repo), "knowledge", "md");
    assert(sources.every(source => String(source.locator).startsWith(realpathSync(f.repo))));
    assert(f.store.list("knowledge_fragment").every(fragment => String((fragment.content_ref as JsonObject).path).startsWith(contentRoot)));
    assert.equal(f.store.find("knowledge_source", "project_autodiscovered_invalid"), null);
    const otherRepo = join(f.root, "other-project"); mkdirSync(otherRepo); execFileSync("git", ["-C", otherRepo, "init", "-q"]);
    const otherScope = ((f.service.scopeIdentityResolveProject({ project_root: otherRepo }).identity as JsonObject).canonical_scope as JsonObject);
    f.store.create("knowledge_source", "project_autodiscovered_other_project", { scope: otherScope, kind: "readme", status: "active", locator: "", trust: "bounded", access: "read_only" });
    const again = await result(server, "craft_context_open", { project_root: f.repo, query: "project verification workflow", include_codebase: false });
    assert.equal((again.knowledge_source_discovery as JsonObject).sources_registered, 0);
    assert.equal(f.store.list("knowledge_source", 20, row => (row.scope as JsonObject).kind === scope.kind && (row.scope as JsonObject).id === scope.id).length, 3);
    assert.equal(f.store.get("knowledge_source", "project_autodiscovered_other_project").status, "active");
    assert.equal(f.store.list("telemetry_event", 100, row => row.operation === "project_source_discovery").length >= 2, true);
  } finally { f.close(); }
});

test("project Knowledge discovery disables missing auto sources and reactivates them when restored", async () => {
  const f = await fixture();
  try {
    f.write("README.md", "# Temporary project source\nA bounded fact for source recovery.\n");
    mkdirSync(join(f.repo, ".serena", "memories"), { recursive: true });
    f.write(".serena/memories/workflow.md", "# Workflow\nA temporary Serena source.\n");
    const scope = ((f.service.scopeIdentityResolveProject({ project_root: f.repo }).identity as JsonObject).canonical_scope as JsonObject);
    f.service.knowledgeSourceRegister({ source_id: "manual-source", kind: "custom", label: "Manual source", scope_kind: "project", scope_id: scope.id,
      locator: join(f.root, "manual-source.md"), content_digest: "manual-source-digest", trust: "bounded", access: "read_only" });
    const first = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });
    assert.equal(first.sources_registered, 2);
    const sourceIds = first.source_refs as string[];
    const readmeSourceId = sourceIds.find(id => f.store.get("knowledge_source", id).kind === "readme")!;
    const serenaSourceId = sourceIds.find(id => f.store.get("knowledge_source", id).kind === "serena")!;
    rmSync(join(f.repo, "README.md"));
    rmSync(join(f.repo, ".serena", "memories"), { recursive: true, force: true });

    const missing = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });
    assert.equal(missing.sources_disabled, 2);
    assert.equal(f.store.get("knowledge_source", readmeSourceId).status, "disabled");
    assert.equal(f.store.get("knowledge_source", serenaSourceId).status, "disabled");
    assert.equal(f.store.get("knowledge_source", readmeSourceId).automatic_transition, "project_source_path_unavailable");
    assert.equal(f.store.get("knowledge_source", "manual-source").status, "active");

    f.write("README.md", "# Temporary project source\nA bounded fact for source recovery.\n");
    mkdirSync(join(f.repo, ".serena", "memories"), { recursive: true });
    f.write(".serena/memories/workflow.md", "# Workflow\nA temporary Serena source.\n");
    const restored = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });
    assert.equal(restored.sources_reactivated, 2);
    assert.equal(restored.sources_ingested, 2);
    assert.equal(f.store.get("knowledge_source", readmeSourceId).status, "active");
    assert.equal(f.store.get("knowledge_source", readmeSourceId).automatic_transition, null);
    assert.equal(f.store.get("knowledge_source", serenaSourceId).status, "active");

    const outside = join(f.root, "outside-memories"); mkdirSync(outside);
    rmSync(join(f.repo, ".serena", "memories"), { recursive: true, force: true });
    symlinkSync(outside, join(f.repo, ".serena", "memories"));
    const linked = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });
    assert.equal(linked.sources_disabled, 1);
    assert.equal(f.store.get("knowledge_source", serenaSourceId).status, "disabled");
    unlinkSync(join(f.repo, ".serena", "memories"));
    mkdirSync(join(f.repo, ".serena", "memories"), { recursive: true });
    f.write(".serena/memories/workflow.md", "# Workflow\nA temporary Serena source.\n");
    const unlinked = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });
    assert.equal(unlinked.sources_reactivated, 1);
    assert.equal(f.store.get("knowledge_source", serenaSourceId).status, "active");
  } finally { f.close(); }
});

test("project Knowledge source cleanup does not enumerate the global Source list", async () => {
  const f = await fixture();
  try {
    const scope = ((f.service.scopeIdentityResolveProject({ project_root: f.repo }).identity as JsonObject).canonical_scope as JsonObject);
    const otherRepo = join(f.root, "other-project"); mkdirSync(otherRepo); execFileSync("git", ["-C", otherRepo, "init", "-q"]);
    const otherScope = ((f.service.scopeIdentityResolveProject({ project_root: otherRepo }).identity as JsonObject).canonical_scope as JsonObject);
    const sourceId = (sourceScope: JsonObject, root: string, path: string) => `project_autodiscovered_${stableDigest({ scope: sourceScope, root: realpathSync(root), path }).slice(-24)}`;
    const missingHere = sourceId(scope, f.repo, "README.md"), missingElsewhere = sourceId(otherScope, otherRepo, "README.md");
    const wrongScopeKind = sourceId(scope, f.repo, "AGENTS.md"), wrongScopeId = sourceId(scope, f.repo, ".serena/memories");
    const missing = (id: string, projectId: string) => f.store.create("knowledge_source", id, {
      scope: { kind: "project", id: projectId }, kind: "readme", status: "active", locator: "", trust: "bounded", access: "read_only",
    });
    missing(missingHere, String(scope.id));
    missing(missingElsewhere, String(otherScope.id));
    f.store.create("knowledge_source", wrongScopeKind, { scope: { kind: "global", id: "global" }, kind: "readme", status: "active", locator: "", trust: "bounded", access: "read_only" });
    f.store.create("knowledge_source", wrongScopeId, { scope: otherScope, kind: "readme", status: "active", locator: "", trust: "bounded", access: "read_only" });
    const originalList = f.store.list;
    f.store.list = ((kind: string, ...args: unknown[]) => {
      if (kind === "knowledge_source") throw new Error("global Knowledge Source enumeration");
      return originalList.call(f.store, kind, ...args as [never]);
    }) as typeof f.store.list;

    const result = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });

    assert.equal(result.sources_disabled, 1);
    assert.equal(f.store.get("knowledge_source", missingHere).status, "disabled");
    assert.equal(f.store.get("knowledge_source", missingElsewhere).status, "active");
    assert.equal(f.store.get("knowledge_source", wrongScopeKind).status, "active");
    assert.equal(f.store.get("knowledge_source", wrongScopeId).status, "active");
  } finally { f.close(); }
});

test("project Knowledge discovery isolates automatic source transition failures", async () => {
  const f = await fixture();
  try {
    const scope = ((f.service.scopeIdentityResolveProject({ project_root: f.repo }).identity as JsonObject).canonical_scope as JsonObject);
    const sourceIds = ["README.md", "AGENTS.md", ".serena/memories"]
      .map(path => `project_autodiscovered_${stableDigest({ scope, root: realpathSync(f.repo), path }).slice(-24)}`);
    for (const source_id of sourceIds) f.store.create("knowledge_source", source_id, {
      scope, kind: "readme", status: "active", locator: join(f.root, `${source_id}.md`), trust: "bounded", access: "read_only",
    });
    f.store.create("knowledge_claim", "claim_for_broken_catalog", { source_id: sourceIds[0], scenario_key: "stale-scene",
      scope: `project:${scope.id}`, evidence_ids: [], status: "candidate" });
    const projectId = String(scope.id).replace(/^project:/u, "");
    mkdirSync(join(projectStorageDirectory(f.store.paths, f.repo), "knowledge", "projects", projectId, "knowledge-scenarios.json"), { recursive: true });
    const save = f.store.save.bind(f.store);
    Object.assign(f.store, { save(kind: string, id: string, data: JsonObject) {
      if (kind === "knowledge_source" && id === sourceIds[2]) throw new Error("private persistence failure");
      return save(kind, id, data);
    } });
    const transition = f.service.knowledgeSources.sourceTransition.bind(f.service.knowledgeSources);
    Object.assign(f.service.knowledgeSources, { sourceTransition(args: JsonObject, automaticTransition?: string) {
      if (args.source_id === sourceIds[1] || args.source_id === sourceIds[2]) throw new Error("private transition failure");
      return transition(args, automaticTransition);
    } });

    const result = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "source_transition_incomplete");
    assert.equal(result.sources_transition_failed, 3);
    assert.deepEqual(result.source_transition_failure_codes, ["OPERATION_FAILED"]);
    assert.equal(result.sources_disabled, 2);
    for (const sourceId of sourceIds.slice(0, 2)) {
      const source = f.store.get("knowledge_source", sourceId);
      assert.equal(source.status, "disabled");
      assert.equal(source.automatic_transition, "project_source_path_unavailable");
    }
    assert.equal(f.store.get("knowledge_source", sourceIds[2]).status, "active");
    assert.equal(JSON.stringify(result).includes("non-regular"), false);
  } finally { f.close(); }
});

test("project Knowledge discovery fails closed on unsafe roots and isolates individual ingest failures", async () => {
  const f = await fixture();
  try {
    const scope = ((f.service.scopeIdentityResolveProject({ project_root: f.repo }).identity as JsonObject).canonical_scope as JsonObject);
    f.write("regular-file", "not a directory");
    assert.equal(f.service.knowledgeSources.discoverProjectSources({ project_root: join(f.repo, "regular-file"), scope_kind: "project", scope_id: scope.id }).status, "skipped");
    const linkedRoot = join(f.root, "linked-repo"); symlinkSync(f.repo, linkedRoot);
    assert.equal(f.service.knowledgeSources.discoverProjectSources({ project_root: linkedRoot, scope_kind: "project", scope_id: scope.id }).reason, "project_root_not_regular_directory");
    assert.throws(() => f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "user", scope_id: "local" }), /project scope/u);

    f.write("README.md", "# Bounded source\nThis content is staged for review.\n");
    writeFileSync(join(f.root, "outside.md"), "# outside");
    symlinkSync(join(f.root, "outside.md"), join(f.repo, "AGENTS.md"));
    Object.assign(f.service.knowledgeSources, { sourceIngest(args: JsonObject) {
      assert(String(args.source_id).startsWith("project_autodiscovered_"));
      throw new Error("safe ingest failure");
    } });
    const result = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });
    assert.equal(result.sources_registered, 1);
    assert.equal(result.skipped_sources, 2);
    assert.equal(result.failed_ingests, 1);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "source_ingest_incomplete");
    assert.equal(f.store.list("knowledge_source", 20).length, 1);
  } finally { f.close(); }
});

test("project Knowledge discovery checks only its three deterministic source records", async () => {
  const f = await fixture();
  try {
    f.write("README.md", "# Stable source\n");
    const scope = ((f.service.scopeIdentityResolveProject({ project_root: f.repo }).identity as JsonObject).canonical_scope as JsonObject);
    f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });
    const originalListScoped = f.store.listScoped.bind(f.store);
    let wideKnowledgeSourceScans = 0;
    f.store.listScoped = ((kind, scopes, limit, predicate, temporal, options) => {
      if (kind === "knowledge_source" && limit === 100_000) wideKnowledgeSourceScans++;
      return originalListScoped(kind, scopes, limit, predicate, temporal, options);
    }) as typeof f.store.listScoped;

    const repeated = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });

    assert.equal(repeated.sources_registered, 0);
    assert.equal(wideKnowledgeSourceScans, 0);
  } finally { f.close(); }
});

test("Context returns its receipt when automatic Knowledge source discovery is unavailable", async () => {
  const f = await fixture();
  try {
    Object.assign(f.service.knowledgeSources, { discoverProjectSources() { throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }); } });
    const result = await f.service.contextOpen({ project_root: f.repo, query: "bounded context", include_codebase: false });
    assert.equal((result.knowledge_source_discovery as JsonObject).status, "unavailable");
    assert.equal((result.knowledge_source_discovery as JsonObject).reason, "project_source_discovery_failed");
    assert.equal((result.knowledge_source_discovery as JsonObject).failure_code, "STORAGE_BUSY");
    assert.equal(typeof (result.receipt as JsonObject).id, "string");
    assert.equal(result.pack_status, "partial");
    assert.equal(result.partial, true);
    assert(((result.pack_receipt as JsonObject).partial_reasons as string[]).includes("knowledge_source_discovery_unavailable"));
    assert.equal(JSON.stringify(result).includes("database is locked"), false);
    assert.equal(f.store.list("telemetry_event", 100, row => row.operation === "project_source_discovery" && row.outcome === "failed").length, 1);
  } finally { f.close(); }
});

test("project Knowledge discovery records bounded partial ingestion and skips malformed conventional paths", async () => {
  const f = await fixture();
  try {
    const scope = ((f.service.scopeIdentityResolveProject({ project_root: f.repo }).identity as JsonObject).canonical_scope as JsonObject);
    mkdirSync(join(f.repo, "README.md"));
    f.write("AGENTS.md", "# Local project rules\n");
    f.write(".serena", "not a directory");
    Object.assign(f.service.knowledgeSources, { sourceIngest() { return { status: "partial" }; } });
    const result = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "source_ingest_incomplete");
    assert.equal(result.partial_ingests, 1);
    assert.equal(result.sources_registered, 1);
    assert.equal(result.sources_ingested, 1);
    assert.equal(result.candidates_created, 0);
    assert.equal(result.skipped_sources, 2);
  } finally { f.close(); }
});

test("Context marks the pack partial when automatic Knowledge ingestion is incomplete", async () => {
  const f = await fixture();
  try {
    f.write("README.md", "# Bounded source\nA source that cannot be fully ingested.\n");
    Object.assign(f.service.knowledgeSources, { sourceIngest() { return { status: "partial" }; } });
    const result = await f.service.contextOpen({ project_root: f.repo, query: "bounded source", include_codebase: false });
    const discovery = result.knowledge_source_discovery as JsonObject;
    assert.equal(discovery.status, "partial");
    assert.equal(discovery.partial_ingests, 1);
    assert.equal(result.pack_status, "partial");
    assert.equal(result.partial, true);
    assert(((result.pack_receipt as JsonObject).partial_reasons as string[]).includes("knowledge_source_discovery_incomplete"));
  } finally { f.close(); }
});

test("project Knowledge discovery rejects a resolved source path outside the repository root", async () => {
  const f = await fixture();
  try {
    f.write("README.md", "# Project readme\n");
    const outside = join(f.root, "outside-readme.md"); writeFileSync(outside, "# Outside\n");
    Object.assign(f.service.knowledgeSources, { resolvePath(path: string) { return path.endsWith("README.md") ? outside : realpathSync(path); } });
    const scope = ((f.service.scopeIdentityResolveProject({ project_root: f.repo }).identity as JsonObject).canonical_scope as JsonObject);
    const result = f.service.knowledgeSources.discoverProjectSources({ project_root: f.repo, scope_kind: "project", scope_id: scope.id });
    assert.equal(result.sources_registered, 0);
    assert.equal(result.skipped_sources, 3);
    assert.equal(f.store.count("knowledge_source"), 0);
  } finally { f.close(); }
});

test("duplicate project documents merge provenance into one Knowledge candidate", async () => {
  const f = await fixture();
  try {
    const body = "# Shared rule\nRun the focused verification before completion.\n";
    f.write("README.md", body);
    f.write("AGENTS.md", body);
    const result = await f.service.contextOpen({ project_root: f.repo, query: "focused verification", include_codebase: false });
    assert.equal((result.knowledge_source_discovery as JsonObject).sources_registered, 2);
    const scope = ((result.receipt as JsonObject).scope as JsonObject);
    const claims = f.store.list("knowledge_claim", 20, claim => claim.scope === `${scope.kind}:${scope.id}` && claim.status === "candidate");
    assert.equal(claims.length, 1);
    assert.equal((claims[0]!.evidence_ids as string[]).length, 2);
    assert.equal(f.store.list("knowledge_ingest_candidate", 20, item => item.claim_id === claims[0]!.id).length, 2);
  } finally { f.close(); }
});

test("Knowledge deduplication recovers a legacy candidate without an evidence list", async () => {
  const f = await fixture();
  try {
    const body = "# Shared legacy rule\nKeep this fact scoped to the project.\n";
    mkdirSync(join(f.repo, "docs", "one"), { recursive: true });
    mkdirSync(join(f.repo, "docs", "two"), { recursive: true });
    writeFileSync(join(f.repo, "docs", "one", "shared.md"), body);
    writeFileSync(join(f.repo, "docs", "two", "shared.md"), body);
    const scope = ((f.service.scopeIdentityResolveProject({ project_root: f.repo }).identity as JsonObject).canonical_scope as JsonObject);
    f.service.knowledgeSourceRegister({ source_id: "legacy-source-one", kind: "project_note", label: "First project notes", scope_kind: "project", scope_id: scope.id,
      locator: join(f.repo, "docs", "one"), content_digest: "legacy-one", trust: "bounded", access: "read_only" });
    f.service.knowledgeSourceIngest({ source_id: "legacy-source-one" });
    const first = f.store.list("knowledge_claim", 10, claim => claim.scope === `${scope.kind}:${scope.id}`)[0]!;
    f.store.save("knowledge_claim", String(first.id), { ...first, evidence_ids: null });
    f.service.knowledgeSourceRegister({ source_id: "legacy-source-two", kind: "project_note", label: "Second project notes", scope_kind: "project", scope_id: scope.id,
      locator: join(f.repo, "docs", "two"), content_digest: "legacy-two", trust: "bounded", access: "read_only" });
    f.service.knowledgeSourceIngest({ source_id: "legacy-source-two" });
    const merged = f.store.get("knowledge_claim", String(first.id));
    assert.deepEqual(merged.evidence_ids, [`evidence_${f.store.list("knowledge_fragment", 10).find(fragment => fragment.source_id === "legacy-source-two")!.id}`]);
  } finally { f.close(); }
});

test("basic symbols cap declarations and retain only digest-linked structural facts", async () => {
  const f = await fixture();
  try {
    const files = [{ path: "a.ts", digest: "fixture", language: "ts", content: Array.from({ length: 22 }, (_, i) => `const a${i}=1;`).join("\n") }];
    const first = basicAnalysis(f.store, "demo", files); assert.equal((first.nodes as unknown[]).length, 16);
    assert.equal((first.diagnostics as JsonObject[])[0]!.omitted_symbols, 7);
    assert.equal((basicAnalysis(f.store, "demo", files).diagnostics as JsonObject[])[0]!.reused_files, 1);
    assert(!JSON.stringify(f.store.list("codebase_file_analysis")).includes("const a0"));
    const huge = Array.from({ length: 500 }, (_, i) => ({ path: `nested/${"p".repeat(200)}/file${i}.ts`, digest: String(i), language: "ts", content: Array.from({ length: 16 }, (_, n) => `const ${"a".repeat(180)}${n}=1;`).join("\n") + `const ${"b".repeat(201)}=1;` }));
    const bounded = basicAnalysis(f.store, "large", huge); assert(JSON.stringify(bounded).length < 2_000_000); assert(Number((bounded.diagnostics as JsonObject[])[0]!.omitted_symbols) > 500);
  } finally { f.close(); }
});

test("aggregate deduplicates repeated facts and keeps contributor failures explicit; strict standalone resolution still fails", async () => {
  const f = await fixture();
  try {
    const { ContextResolutionKernel } = await import("../core/context-resolution.ts");
    const facts = { member: "knowledge" as const, contribute: async () => ({ member: "knowledge" as const, receipt_id: "fixture", omitted_count: 0,
      items: [{ claim_id: "one", content: "alpha testing" }, { claim_id: "two", content: "alpha testing" }] }) };
    const procedures = { member: "experience" as const, contribute: async () => ({ member: "experience" as const, receipt_id: "procedures", omitted_count: 0, items: [{ procedure_id: "one", content: "alpha", steps: ["a"] }, { procedure_id: "two", content: "alpha", steps: ["b"] }] }) };
    const procedureResult = await new ContextResolutionKernel(f.store, [procedures]).resolve({ query: "alpha", scope_kind: "project", scope_id: "demo", deduplicate: true }); assert.equal((procedureResult.receipt as JsonObject).total_items, 2);
    const broken = { member: "experience" as const, contribute: async () => { throw new Error("fixture private upstream message"); } };
    const resolver = new ContextResolutionKernel(f.store, [facts, broken]);
    const args = { query: "alpha", scope_kind: "project", scope_id: "demo" };
    await assert.rejects(resolver.resolve(args), /fixture private/);
    const partial = await resolver.resolve({ ...args, allow_partial: true, deduplicate: true });
    const receipt = partial.receipt as JsonObject; assert.equal(receipt.partial, true); assert.equal(receipt.total_items, 1); assert.equal(receipt.deduplicated_count, 1);
    assert(!JSON.stringify(partial).includes("private upstream"));
    f.write("a.ts", "export function alpha() {}\nexport function beta() {}");
    const pack = await f.service.contextOpen({ project_root: f.repo, query: "review alpha beta alpha", max_items: 1, members: ["knowledge"] });
    assert.equal(((pack.codebase as JsonObject).references as JsonObject[]).length, 1);
    await f.service.contextOpen({ project_root: f.repo, query: "代码审查" });
    f.service.knowledgeMemoryInstallBuiltins();
    const scope = ((f.service.scopeIdentityResolveProject({ project_root: f.repo }).identity as JsonObject).canonical_scope as JsonObject);
    const fact = f.store.create("knowledge_claim", "fact", { status: "candidate", source_id: "builtin.evidence-wiki", scope: `${scope.kind}:${scope.id}`, content: "alpha", evidence_ids: [] });
    const { attachVerifiedPromotionFixture } = await import("./helpers/knowledge-promotion-proof.ts");
    attachVerifiedPromotionFixture(f.store, fact);
    const onlyFact = await f.service.contextOpen({ project_root: f.repo, query: "alpha", max_items: 1 });
    assert.equal((onlyFact.pack_receipt as JsonObject).total_items, 1); assert.equal(((onlyFact.codebase as JsonObject).references as unknown[]).length, 0);
  } finally { f.close(); }
});

test("Java onboarding reuses unaffected graph units and matches a fresh full analysis", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "src", "a"), { recursive: true });
    mkdirSync(join(f.repo, "src", "b"), { recursive: true });
    mkdirSync(join(f.repo, "src", "c"), { recursive: true });
    mkdirSync(join(f.repo, "src", "broken"), { recursive: true });
    f.write("src/a/Target.java", "package a; public class Target { public int value() { return 1; } }\n");
    f.write("src/b/Caller.java", "package b; import a.Target; public class Caller { public int call() { return new Target().value(); } }\n");
    f.write("src/c/Unrelated.java", "package c; public class Unrelated { public int spare() { return 3; } }\n");
    f.write("src/broken/Broken.java", "package broken; public class Broken { public int fail() { return missing(); } }\n");
    const requestedPaths: string[][] = [];
    Object.assign(f.service, { analyzeJava: (files: Parameters<typeof analyzeJavaCheckpoint>[0], options?: Parameters<typeof analyzeJavaCheckpoint>[1]) => {
      requestedPaths.push([...(options?.includePaths ?? files.map(file => file.path))]);
      return analyzeJavaCheckpoint(files, options);
    } });
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(first.status, "ready");
    const firstUnits = projectAnalysis(f, String(first.workspace_id), "codebase_java_file_analysis", 10);
    assert.equal(firstUnits.length, 4);
    assert.equal(firstUnits.find(unit => unit.path === "src/broken/Broken.java")!.incremental_safe, false);
    assert.equal(firstUnits.find(unit => unit.path === "src/c/Unrelated.java")!.incremental_safe, true);

    f.write("src/a/Target.java", "package a; public class Target { public int value() { return 2; } }\n");
    const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(updated.status, "ready");
    const javaDiagnostics = (((updated.summary as JsonObject).diagnostics as JsonObject[])[0]!.languages as JsonObject[])
      .find(language => language.analyzer === "jdk-compiler-tree")!.diagnostics as JsonObject;
    assert.equal(javaDiagnostics.incremental_mode, "incremental", JSON.stringify(javaDiagnostics));
    assert.equal(javaDiagnostics.compiler_errors, 1);
    assert.equal(javaDiagnostics.parsed_file_count, 3);
    assert.equal(javaDiagnostics.reused_file_count, 1);
    assert.equal(javaDiagnostics.graph_unit_rebuild_count, 3);
    assert.equal(javaDiagnostics.graph_unit_reuse_count, 1);
    assert.equal(javaDiagnostics.compiler_input_file_count, 4);
    assert.deepEqual(requestedPaths[1], ["src/a/Target.java", "src/b/Caller.java", "src/broken/Broken.java"]);

    const liveFiles = repositoryFiles(f.repo).files.filter(file => file.language === "java");
    const full = analyzeJavaCheckpoint(liveFiles).analysis!;
    const fullUnits = new Map((full.file_units as JsonObject[]).map(unit => [String(unit.path), String(unit.unit_digest)]));
    const incrementalUnits = projectAnalysis(f, String(first.workspace_id), "codebase_java_file_analysis", 10);
    assert.deepEqual(new Map(incrementalUnits.map(unit => [String(unit.path), String(unit.unit_digest)])), fullUnits);
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }).reused, true);
  } finally { f.close(); }
});

test("Java budget-limited file units stay partial and never enter the incremental cache", async () => {
  const f = await fixture();
  try {
    f.write("Main.java", "public class Main { public int value() { return 1; } }\n");
    Object.assign(f.service, { analyzeJava: (files: Parameters<typeof analyzeJavaCheckpoint>[0], options?: Parameters<typeof analyzeJavaCheckpoint>[1]) => {
      const result = analyzeJavaCheckpoint(files, options);
      if (!result.analysis || !Array.isArray(result.analysis.file_units)) return result;
      const file_units = (result.analysis.file_units as JsonObject[]).map(unit => ({ ...unit, budget_limited: true }));
      return { analysis: { ...result.analysis, file_units } };
    } });
    const indexed = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(indexed.status, "ready");
    const languages = (((indexed.summary as JsonObject).diagnostics as JsonObject[])[0]!.languages as JsonObject[]);
    const java = languages.find(item => item.analyzer === "jdk-compiler-tree")!.diagnostics as JsonObject;
    assert.equal(java.budget_limited, true);
    assert.equal(java.omitted_nodes, 1);
    assert.equal(projectAnalysis(f, String(indexed.workspace_id), "codebase_java_file_analysis", 10).length, 0);
  } finally { f.close(); }
});

test("Java graph caches reuse across non-Java edits and fall back safely when incremental analysis is incomplete", async () => {
  const reused = await fixture();
  try {
    reused.write("Main.java", "class Main { int value() { return 1; } }\n");
    reused.write("other.ts", "export const version = 1;\n");
    let javaCalls = 0;
    Object.assign(reused.service, { analyzeJava: (files: Parameters<typeof analyzeJavaCheckpoint>[0], options?: Parameters<typeof analyzeJavaCheckpoint>[1]) => {
      javaCalls++;
      return analyzeJavaCheckpoint(files, options);
    } });
    const first = reused.service.codebaseRepositoryEnsure({ project_root: reused.repo, index_depth: "semantic" });
    reused.write("other.ts", "export const version = 2;\n");
    const updated = reused.service.codebaseRepositoryEnsure({ project_root: reused.repo, index_depth: "semantic" });
    const java = (((updated.summary as JsonObject).diagnostics as JsonObject[])[0]!.languages as JsonObject[])
      .find(language => language.analyzer === "jdk-compiler-tree")!.diagnostics as JsonObject;
    assert.equal(java.incremental_mode, "reuse");
    assert.equal(java.parsed_file_count, 0);
    assert.equal(java.reused_file_count, 1);
    assert.equal(javaCalls, 1);
    assert.notEqual(updated.index_id, first.index_id);
    rmSync(join(reused.repo, "Main.java"));
    const deleted = reused.service.codebaseRepositoryEnsure({ project_root: reused.repo, index_depth: "semantic" });
    assert.equal(deleted.status, "ready");
    assert.equal(projectAnalysis(reused, String(first.workspace_id), "codebase_java_file_analysis", 10).length, 0);
  } finally { reused.close(); }

  for (const fallback of ["graph", "unavailable", "unavailable_without_partial_diagnostic", "unmapped_errors"] as const) {
    const f = await fixture();
    try {
      f.write("Main.java", "package main; public class Main { int value() { return 1; } }\n");
      f.write("Other.java", "package other; public class Other { int spare() { return 3; } }\n");
      const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      f.write("Main.java", "package main; public class Main { int value() { return 2; } }\n");
      let call = 0;
      Object.assign(f.service, { analyzeJava: (files: Parameters<typeof analyzeJavaCheckpoint>[0], options?: Parameters<typeof analyzeJavaCheckpoint>[1]) => {
        call++;
        if (fallback === "unmapped_errors" && options?.includePaths?.length !== files.length) {
          const partial = analyzeJavaCheckpoint(files, options).analysis!;
          return { analysis: { ...partial, diagnostics: { ...(partial.diagnostics as JsonObject), unmapped_compiler_errors: 1 } } };
        }
        if (options?.includePaths?.length !== files.length) return fallback === "unavailable_without_partial_diagnostic" ? {}
          : { diagnostic: { language: "java", status: "unavailable", reason: "partial_fixture_failure" } };
        if (fallback === "unmapped_errors") return analyzeJavaCheckpoint(files, options);
        if (fallback !== "graph") return { diagnostic: { language: "java", status: "unavailable", reason: "full_fixture_failure" } };
        const full = analyzeJavaCheckpoint(files, options).analysis!;
        const { file_units: _units, ...graph } = full;
        return { analysis: graph };
      } });
      const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
      assert.equal(updated.status, "ready");
      assert.equal(updated.reused, false);
      assert.equal(call, 2);
      if (fallback === "graph" || fallback === "unmapped_errors") assert(f.store.get("codebase_index", String(updated.index_id)));
      else if (fallback === "unavailable") assert(JSON.stringify(updated.summary).includes("partial_fixture_failure"));
      else assert(JSON.stringify(updated.summary).includes("analysis_empty_or_invalid"));
      assert.notEqual(updated.index_id, first.index_id);
    } finally { f.close(); }
  }
});

test("repository graph file publication does not hold the shared database writer lock", async () => {
  const f = await fixture();
  const { DatabaseSync } = await import("node:sqlite");
  const otherWriter = new DatabaseSync(f.store.paths.databaseFile);
  otherWriter.exec("PRAGMA busy_timeout=0");
  const put = ProjectGraphStore.prototype.put;
  const freshnessTarget = f.service.workspace as unknown as { freshness(args: JsonObject): JsonObject };
  const freshness = freshnessTarget.freshness.bind(freshnessTarget);
  const checkpointTarget = f.service as unknown as { workspaceCheckpointFromRepositoryFiles(args: JsonObject): JsonObject };
  const checkpoint = checkpointTarget.workspaceCheckpointFromRepositoryFiles.bind(checkpointTarget);
  let graphProbes = 0, freshnessProbes = 0, checkpointProbes = 0;
  const probeWriter = () => { otherWriter.exec("BEGIN IMMEDIATE"); otherWriter.exec("ROLLBACK"); };
  freshnessTarget.freshness = args => { probeWriter(); freshnessProbes++; return freshness(args); };
  checkpointTarget.workspaceCheckpointFromRepositoryFiles = args => { probeWriter(); checkpointProbes++; return checkpoint(args); };
  ProjectGraphStore.prototype.put = function (id, record) {
    probeWriter();
    graphProbes++;
    return put.call(this, id, record);
  };
  try {
    f.write("main.ts", "export function caller() { return target(); }\nexport function target() { return 1; }\n");
    const indexed = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(indexed.status, "ready");
    assert(freshnessProbes > 0, "repository freshness must run without the shared writer lock");
    assert(checkpointProbes > 0, "snapshot copying must run without the shared writer lock");
    assert(graphProbes > 0, "immutable graph files must be published without the shared writer lock");
  } finally {
    freshnessTarget.freshness = freshness;
    checkpointTarget.workspaceCheckpointFromRepositoryFiles = checkpoint;
    ProjectGraphStore.prototype.put = put;
    otherWriter.close();
    f.close();
  }
});

test("repository index publication rejects an activation revoked during graph file writes", async () => {
  const f = await fixture();
  const put = ProjectGraphStore.prototype.put;
  const workspaceId = `repository_${stableDigest(realpathSync(f.repo)).slice(-24)}`;
  let revoked = false;
  ProjectGraphStore.prototype.put = function (id, record) {
    const result = put.call(this, id, record);
    if (!revoked) {
      revoked = true;
      f.service.codebaseDeactivate({ workspace_id: workspaceId, actor: "test-revocation-race" });
    }
    return result;
  };
  try {
    f.write("main.ts", "export function caller() { return target(); }\nexport function target() { return 1; }\n");
    assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }), /snapshot changed before index publication/u);
    assert.equal(revoked, true);
    assert.equal(f.store.list("codebase_index", 1_000, item => item.workspace_id === workspaceId && item.status === "ready").length, 0);
  } finally {
    ProjectGraphStore.prototype.put = put;
    f.close();
  }
});

test("repository state publication rejects an activation version that changes after index creation", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export const value = 1;\n");
    const workspaceId = `repository_${stableDigest(realpathSync(f.repo)).slice(-24)}`;
    const importAnalysis = f.service.codebaseAnalysisImport.bind(f.service);
    f.service.codebaseAnalysisImport = args => {
      const result = importAnalysis(args);
      f.service.codebaseDeactivate({ workspace_id: workspaceId, actor: "repository-auto" });
      f.service.codebaseActivate({ workspace_id: workspaceId, actor: "repository-auto" });
      return result;
    };
    assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }), /activation changed before state publication/u);
    assert.equal(f.store.get("codebase_activation", `codebase_activation_${workspaceId}`).status, "active");
    assert.equal(f.store.find("codebase_repository_state", `${workspaceId}_semantic`), null);
  } finally { f.close(); }
});

test("repository state publication rejects workspace version and checkpoint drift after index creation", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  for (const drift of ["version", "checkpoint"] as const) {
    const f = await fixture();
    try {
      f.write("main.ts", "export const value = 1;\n");
      const workspaceId = `repository_${stableDigest(realpathSync(f.repo)).slice(-24)}`;
      const importAnalysis = f.service.codebaseAnalysisImport.bind(f.service);
      f.service.codebaseAnalysisImport = args => {
        const result = importAnalysis(args);
        const workspace = f.store.get("workspace", workspaceId);
        if (drift === "version") f.store.save("workspace", workspaceId, { ...payload(workspace), name: "concurrent workspace update" });
        else {
          const database = new DatabaseSync(f.store.paths.databaseFile);
          try {
            database.prepare("UPDATE records SET payload_json=? WHERE kind='workspace' AND id=? AND version=?")
              .run(JSON.stringify({ ...payload(workspace), latest_checkpoint_id: "concurrent_checkpoint" }), workspaceId, Number(workspace.version));
          } finally { database.close(); }
        }
        return result;
      };
      assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }), /snapshot changed before state publication/u);
    } finally { f.close(); }
  }
});

test("Codebase index publication rejects malformed repository guards", async () => {
  const f = await fixture();
  try {
    f.write("main.ts", "export const value = 1;\n");
    const indexed = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "basic" });
    const workspaceId = String(indexed.workspace_id);
    const invalid: unknown[] = [null, {}, { workspace_version: 0, checkpoint_id: "checkpoint", activation_version: 1 },
      { workspace_version: 1, checkpoint_id: "", activation_version: 1 },
      { workspace_version: 1, checkpoint_id: "checkpoint", activation_version: 0 }];
    for (const [index, publication_guard] of invalid.entries()) {
      assert.throws(() => f.service.codebaseIndexBuild({ workspace_id: workspaceId, index_id: `invalid_guard_${index}`, publication_guard } as JsonObject), /publication_guard/u);
    }
  } finally { f.close(); }
});
