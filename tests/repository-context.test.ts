import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { repositoryRoot, repositoryFiles } from "../capability/craft-codebase/repository-files.ts";
import { basicAnalysis } from "../capability/craft-codebase/basic-analysis.ts";
import { CodebaseIndexKernel } from "../capability/craft-codebase/codebase-index.ts";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import { analyzeTypeScript } from "../capability/craft-codebase/typescript-analysis.ts";
import { analyzePythonCheckpoint } from "../capability/craft-codebase/python-analysis.ts";
import { pythonFileUnitDigest } from "../capability/craft-codebase/python-incremental.ts";
import { analyzeJavaCheckpoint } from "../capability/craft-codebase/java-analysis.ts";
import { cacheLspDocumentSymbols, lspDocumentSymbolsDigest } from "../capability/craft-codebase/lsp-adapter.ts";

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
    const again = f.service.codebaseRepositoryEnsure({ project_root: f.repo }); assert.equal(again.index_id, first.index_id); assert.equal(again.reused, true);
    const anotherHost = new CraftService(f.store);
    assert.equal(anotherHost.codebaseRepositoryEnsure({ project_root: f.repo }).index_id, first.index_id);
    f.write("a.ts", "export function gamma() { return 3; }");
    const changed = f.service.codebaseRepositoryEnsure({ project_root: f.repo }); assert.notEqual(changed.index_id, first.index_id);
    assert.equal(((changed.summary as JsonObject).diagnostics as JsonObject[])[0]!.reused_files, 1); assert.equal(((changed.summary as JsonObject).diagnostics as JsonObject[])[0]!.analyzed_files, 1);
    const matches = f.service.codebaseSymbolFind({ workspace_id: changed.workspace_id, index_id: changed.index_id, query: "gamma" }); assert.equal((matches.symbols as unknown[]).length, 1);
    assert.throws(() => f.service.codebaseSymbolFind({ workspace_id: first.workspace_id, index_id: first.index_id, query: "alpha" }), /stale/);
    const semantic = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }); assert.equal(semantic.status, "ready");
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
    const firstUnits = f.store.list("codebase_lsp_file_analysis", 10, item => item.workspace_id === first.workspace_id);
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

    const targetCache = f.store.list("codebase_lsp_file_analysis", 10, item => item.workspace_id === second.workspace_id)
      .find(item => item.path === "src/target.cpp")!;
    f.store.save("codebase_lsp_file_analysis", String(targetCache.id), { ...targetCache, cached_symbols_digest: "tampered" });
    f.write("src/main.cpp", "int caller() { return target() + 3; }\n");
    const third = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(third.status, "ready");
    assert.notEqual(third.index_id, second.index_id);
    const fourthDocuments = requests[3]!;
    assert.equal(fourthDocuments.find(document => document.path === "src/target.cpp")!.cached_symbols, undefined);
    const refreshedTarget = f.store.list("codebase_lsp_file_analysis", 10, item => item.workspace_id === third.workspace_id)
      .find(item => item.path === "src/target.cpp")!;
    assert.equal(refreshedTarget.cached_symbols_digest, lspDocumentSymbolsDigest({ analyzer: "lsp-cpp", analyzer_version: "1",
      path: "src/target.cpp", language: "cpp", source_digest: String(refreshedTarget.source_digest), symbols: refreshedTarget.symbols }));

    rmSync(join(f.repo, "src/target.cpp"));
    const fifth = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(fifth.status, "ready");
    assert.deepEqual(f.store.list("codebase_lsp_file_analysis", 10, item => item.workspace_id === fifth.workspace_id).map(item => item.path), ["src/main.cpp"]);
  } finally { f.close(); }
});

test("LSP adapter failures retain safe category and protocol stage in repository diagnostics", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.repo, "src"));
    writeFileSync(join(f.store.paths.configDir, "codebase-lsp.json"), JSON.stringify({ schema_version: 1,
      adapters: [{ language: "cpp", command: process.execPath }] }));
    const cases: Array<{ error: unknown; reason: string; stage?: string; signal?: string; exit_code?: number }> = [
      { error: new Error("Language server exited before completion during textDocument/documentSymbol (code null, signal SIGTRAP)"),
        reason: "server_crash", stage: "textDocument/documentSymbol", signal: "SIGTRAP" },
      { error: new Error("Language server request timed out during textDocument/documentSymbol"),
        reason: "request_timeout", stage: "textDocument/documentSymbol" },
      { error: new Error("Unable to start configured language server"), reason: "server_unavailable" },
      { error: new Error("Language server request failed (-32000)"), reason: "server_request_failed" },
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
    assert.equal(index.graph_storage, "sharded-v4");
    assert(Number(index.node_count) > 10_000);
    assert((index.shard_ids as string[]).length > 1);
    const shards = (index.shard_ids as string[]).map(id => f.store.get("codebase_index_shard", id));
    assert.equal(shards.reduce((count, shard) => count + Number(shard.node_count), 0), index.node_count);
    const found = f.service.codebaseSymbolFind({ workspace_id: result.workspace_id, index_id: result.index_id, query: "symbol10000" });
    assert((found.symbols as JsonObject[]).some(node => node.name === "symbol10000"));
    const target = (f.service.codebaseSymbolFind({ workspace_id: result.workspace_id, index_id: result.index_id, query: "target" }).symbols as JsonObject[])[0]!;
    const callers = f.service.codebaseCallersFind({ workspace_id: result.workspace_id, index_id: result.index_id, symbol_id: target.id });
    assert((callers.callers as JsonObject[]).some(item => (item.caller as JsonObject).name === "caller"));
    const originalGet = f.store.get.bind(f.store); const shardsRead = new Set<string>();
    f.store.get = ((collection: string, id: string) => { if (collection === "codebase_index_shard") shardsRead.add(id); return originalGet(collection, id); }) as typeof f.store.get;
    const impact = f.service.codebaseImpactQuery({ workspace_id: result.workspace_id, index_id: result.index_id, node_id: target.id, max_depth: 1 });
    assert((impact.edges as JsonObject[]).some(edge => edge.kind === "calls"));
    assert(shardsRead.size < (index.shard_ids as string[]).length, "impact reads only routed graph shards");
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
    const firstUnits = f.store.list("codebase_semantic_file_analysis", 10, item => item.workspace_id === first.workspace_id);
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
    const units = f.store.list("codebase_semantic_file_analysis", 10, item => item.workspace_id === updated.workspace_id);
    const updatedVersions = new Map(units.map(unit => [String(unit.path), unit.version]));
    assert.notEqual(updatedVersions.get("a.ts"), firstVersions.get("a.ts"), "changed source unit must be persisted");
    assert.equal(updatedVersions.get("b.ts"), firstVersions.get("b.ts"), "unchanged importer facts must not be rewritten");
    assert.equal(updatedVersions.get("c.ts"), firstVersions.get("c.ts"), "unrelated facts must not be rewritten");
    const actualNodes = sort(units.flatMap(unit => unit.nodes as JsonObject[]));
    const actualEdges = sort(units.flatMap(unit => unit.edges as JsonObject[]));
    assert.deepEqual(actualNodes, sort(clean.nodes as JsonObject[]));
    assert.deepEqual(actualEdges, sort(clean.edges as JsonObject[]));
    const indexRecord = f.store.get("codebase_index", String(updated.index_id));
    const storedEdges = (indexRecord.shard_ids as string[]).flatMap(id => f.store.get("codebase_index_shard", id).edges as JsonObject[]);
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
    assert.equal(f.store.list("codebase_semantic_file_analysis", 10, item => item.workspace_id === first.workspace_id).length, 3);
    rmSync(join(f.repo, "added.ts"));
    const deleted = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(deleted.status, "ready");
    assert.equal(f.store.list("codebase_semantic_file_analysis", 10, item => item.workspace_id === first.workspace_id).length, 2);
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
    for (const shardId of currentIndex.shard_ids as string[]) f.store.remove("codebase_index_shard", shardId);
    for (const route of currentIndex.edge_route_shards as JsonObject[]) f.store.remove("codebase_index_edge_route", String(route.id));
    f.store.remove("codebase_index", String(first.index_id));
    f.store.save("codebase_index", legacyIndexId, { ...currentIndex, id: legacyIndexId });
    f.store.save("codebase_repository_state", stateId, { ...state, policy_version: 9, index_id: legacyIndexId });
    const stalePolicy = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(stalePolicy.status, "ready");
    assert.equal(stalePolicy.reused, false);
    assert.notEqual(stalePolicy.index_id, legacyIndexId, "semantic metadata storage changes must rebuild an existing same-checkpoint index");
    const rebuiltIndex = f.store.get("codebase_index", String(stalePolicy.index_id));
    const rebuiltSymbols = (rebuiltIndex.node_shard_ids as string[]).flatMap(id => f.store.get("codebase_index_shard", id).nodes as JsonObject[])
      .filter(node => node.kind === "symbol");
    assert.equal(rebuiltSymbols.find(node => node.name === "source")?.declaration_kind, "function");

    const currentState = f.store.get("codebase_repository_state", stateId);
    f.store.save("codebase_repository_state", stateId, { ...currentState, checkpoint_id: "" });
    const originalFind = f.store.find.bind(f.store);
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
    const shard = f.store.get("codebase_index_shard", shardId);
    f.store.save("codebase_index_shard", shardId, { ...shard, edges: [{ kind: "calls" }] });
    assert.throws(() => f.service.codebaseSymbolFind({ workspace_id: result.workspace_id, index_id: result.index_id, query: "safe" }), /shard integrity/);
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
    const routeRecords = routes.map(route => f.store.get("codebase_index_edge_route", String(route.id)));
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
    const projection = new CodebaseIndexKernel(f.store).contextProjection({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: "target123" });
    assert((projection.candidates as JsonObject[]).length > 0);
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
    const shards = (index.shard_ids as string[]).map(id => f.store.get("codebase_index_shard", id));
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
    const firstUnits = f.store.list("codebase_python_file_analysis", 10, item => item.workspace_id === first.workspace_id);
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
    const units = f.store.list("codebase_python_file_analysis", 10, item => item.workspace_id === first.workspace_id);
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
    assert.equal(f.store.list("codebase_python_file_analysis", 10, item => item.workspace_id === first.workspace_id).length, 2);
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
    assert.equal(f.store.list("codebase_python_file_analysis", 10, item => item.workspace_id === first.workspace_id)[0].source_digest,
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
    assert.equal(f.store.list("codebase_python_file_analysis", 10, item => item.workspace_id === result.workspace_id).length, 1);
  } finally { f.close(); }
});

test("Python file-set deletion removes stale per-file graph units", async () => {
  const f = await fixture();
  try {
    f.write("keep.py", "def keep():\n    return 1\n");
    f.write("remove.py", "def remove():\n    return 2\n");
    const first = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    assert.equal(f.store.list("codebase_python_file_analysis", 10, item => item.workspace_id === first.workspace_id).length, 2);
    rmSync(join(f.repo, "remove.py"));
    const updated = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" });
    const cached = f.store.list("codebase_python_file_analysis", 10, item => item.workspace_id === first.workspace_id);
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
    assert.equal(f.store.list("codebase_python_file_analysis", 10, item => item.workspace_id === result.workspace_id).length, 0);
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
  const originalPath = process.env.PATH;
  try {
    f.write("main.ts", "export const value = 1;");
    const wrapperDir = join(f.root, "fake-bin"); mkdirSync(wrapperDir);
    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = join(wrapperDir, "git");
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$3" = "check-ignore" ]; then exit 2; fi\nexec ${gitPath} "$@"\n`);
    chmodSync(wrapper, 0o755); process.env.PATH = `${wrapperDir}:${originalPath ?? ""}`;
    assert.throws(() => repositoryFiles(f.repo), /Command failed/);
  } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; f.close(); }
});

test("aggregate MCP resolves bounded scope and code references while standalone surfaces remain isolated", async () => {
  const f = await fixture();
  try {
    f.write("a.ts", "export function alpha() { return 1; }");
    const server = new McpServer(f.service, "component-context-daily");
    const pack = await result(server, "craft_context_open", { project_root: f.repo, query: "alpha" });
    assert.equal(pack.host_execution_authority, false); assert.equal((pack.codebase as JsonObject).status, "ready");
    assert.equal(((pack.codebase as JsonObject).references as unknown[]).length, 1);
    assert.deepEqual((pack.receipt as JsonObject).members, ["experience", "knowledge", "memory"]);
    const tiny = await result(server, "craft_context_open", { project_root: f.repo, query: "alpha", max_chars: 1 });
    assert.equal((tiny.pack_receipt as JsonObject).total_used_chars, 0);
    const standalone = new McpServer(f.service, "component-codebase");
    assert.equal((await result(standalone, "craft_codebase_repository_ensure", { project_root: f.repo })).reused, true);
    assert(!standalone.tools.some(tool => tool.name === "craft_context_open"));
    assert(!new McpServer(f.service, "component-memory-daily").tools.some(tool => tool.name === "craft_codebase_repository_ensure"));
    f.write(".craft-codebase.json", "invalid");
    const degraded = await f.service.contextOpen({ project_root: f.repo, query: "alpha" }); assert.equal((degraded.codebase as JsonObject).status, "unavailable"); assert(degraded.receipt);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "" }), /query/);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "a", index_depth: "invalid" }), /index_depth/);
    await f.service.contextOpen({ project_root: f.repo, query: "a", index_depth: "basic" });
    for (const budget of [0, 1.5]) await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "alpha", max_chars: budget }), /budget/);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "alpha", max_items: 0 }), /budget/);
  } finally { f.close(); }
});

test("context automatically ingests bounded project Knowledge into the central data root once", async () => {
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
    const contentRoot = String(f.store.paths.knowledgeDir);
    assert(sources.every(source => String(source.locator).startsWith(realpathSync(f.repo))));
    assert(f.store.list("knowledge_fragment").every(fragment => String((fragment.content_ref as JsonObject).path).includes(contentRoot)));
    assert.equal(f.store.find("knowledge_source", "project_autodiscovered_invalid"), null);
    const again = await result(server, "craft_context_open", { project_root: f.repo, query: "project verification workflow", include_codebase: false });
    assert.equal((again.knowledge_source_discovery as JsonObject).sources_registered, 0);
    assert.equal(f.store.list("knowledge_source", 20, row => (row.scope as JsonObject).kind === scope.kind && (row.scope as JsonObject).id === scope.id).length, 3);
    assert.equal(f.store.list("telemetry_event", 100, row => row.operation === "project_source_discovery").length >= 2, true);
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
    assert.equal(f.store.list("knowledge_source", 20).length, 1);
  } finally { f.close(); }
});

test("Context returns its receipt when automatic Knowledge source discovery is unavailable", async () => {
  const f = await fixture();
  try {
    Object.assign(f.service.knowledgeSources, { discoverProjectSources() { throw new Error("private source location"); } });
    const result = await f.service.contextOpen({ project_root: f.repo, query: "bounded context", include_codebase: false });
    assert.equal((result.knowledge_source_discovery as JsonObject).status, "unavailable");
    assert.equal((result.knowledge_source_discovery as JsonObject).reason, "project_source_discovery_failed");
    assert.equal(typeof (result.receipt as JsonObject).id, "string");
    assert.equal(JSON.stringify(result).includes("private source location"), false);
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
    assert.equal(result.sources_registered, 1);
    assert.equal(result.sources_ingested, 1);
    assert.equal(result.candidates_created, 0);
    assert.equal(result.skipped_sources, 2);
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
    f.store.create("knowledge_claim", "fact", { status: "reviewed", source_id: "builtin.evidence-wiki", scope: `${scope.kind}:${scope.id}`, content: "alpha", evidence_ids: [] });
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
    const firstUnits = f.store.list("codebase_java_file_analysis", 10, item => item.workspace_id === first.workspace_id);
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
    const incrementalUnits = f.store.list("codebase_java_file_analysis", 10, item => item.workspace_id === first.workspace_id);
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
    assert.equal(f.store.list("codebase_java_file_analysis", 10, item => item.workspace_id === indexed.workspace_id).length, 0);
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
    assert.equal(reused.store.list("codebase_java_file_analysis", 10, item => item.workspace_id === first.workspace_id).length, 0);
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
