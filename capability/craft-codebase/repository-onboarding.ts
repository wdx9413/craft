import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { payload, stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { repositoryFiles, repositoryRoot } from "./repository-files.ts";
import { basicAnalysis } from "./basic-analysis.ts";
import { analyzeTypeScript, TYPESCRIPT_ANALYZER_VERSION, type TypeScriptFileUnit } from "./typescript-analysis.ts";
import { planTypeScriptIncremental } from "./typescript-incremental.ts";
import { planPythonIncremental, type PythonFileUnit } from "./python-incremental.ts";
import { analyzePythonCheckpoint } from "./python-analysis.ts";
import { analyzeJavaCheckpoint } from "./java-analysis.ts";
import { JAVA_ANALYZER_VERSION, planJavaIncremental, type JavaFileUnit } from "./java-incremental.ts";
import { combineLanguageAnalyses } from "./multi-language-analysis.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageIdForFile, readTrustedLspConfig, type TrustedLspAdapter } from "./lsp-config.ts";
import { lspDocumentSymbolsDigest } from "./lsp-adapter.ts";
import { CODEBASE_LSP_WORKER_FLAG } from "./lsp-worker.ts";
import { stageLspSnapshotFiles } from "./lsp-snapshot-files.ts";
import type { RepositoryContextFile } from "./repository-files.ts";
import type { LspStdioRequest } from "./lsp-stdio-client.ts";
export interface RepositoryOnboardingPort {
  store: CraftStore;
  workspace: { freshness(args: JsonObject): JsonObject };
  workspaceOpen(args: JsonObject): JsonObject;
  workspaceCheckpoint(args: JsonObject): JsonObject;
  codebaseActivate(args: JsonObject): JsonObject;
  codebaseAnalysisImport(args: JsonObject): JsonObject;
  codebaseIndexBuild(args: JsonObject): JsonObject;
  analyzeTypeScript?: typeof analyzeTypeScript;
  analyzePython?: typeof analyzePythonCheckpoint;
  analyzeJava?: typeof analyzeJavaCheckpoint;
  analyzeLsp?: (request: LspStdioRequest, timeoutMs: number) => JsonObject;
}
const REPOSITORY_INDEX_POLICY = 12;
const SEMANTIC_RETRY_DELAY_MS = 5 * 60 * 1_000;

function hasSemanticAdapterFailure(prior: JsonObject | null | undefined): boolean {
  const diagnostics = Array.isArray((prior?.summary as JsonObject | undefined)?.diagnostics)
    ? (prior!.summary as JsonObject).diagnostics as JsonObject[] : [];
  return diagnostics.some(diagnostic => Array.isArray(diagnostic.degraded_languages)
    && (diagnostic.degraded_languages as JsonObject[]).some(language => language.semantic_adapter_status === "unavailable"));
}

function repositoryStateReusable(prior: JsonObject | null | undefined): boolean {
  if (typeof prior?.semantic_retry_after !== "string") return !hasSemanticAdapterFailure(prior);
  const retryAfter = Date.parse(prior.semantic_retry_after);
  return Number.isFinite(retryAfter) && retryAfter > Date.now();
}

function lspFailureDiagnostic(error: unknown): JsonObject {
  const message = error instanceof Error ? error.message : "";
  const stage = /(?:during|at) ([a-zA-Z][\w/.-]*)/u.exec(message)?.[1];
  const signal = /signal (SIG[A-Z0-9]+)/u.exec(message)?.[1];
  const exitCode = /\(code (-?\d+), signal/u.exec(message)?.[1];
  const protocolCode = /(?:protocol code |Language server request failed[^\n]*\()(-?\d+)\)/u.exec(message)?.[1];
  const reason = /timed out/iu.test(message) ? "request_timeout"
    : signal ? "server_crash"
    : /Unable to start configured language server/u.test(message) ? "server_unavailable"
    : /worker_unavailable/u.test(message) ? "worker_unavailable"
    : /Language server request failed/u.test(message) ? "server_request_failed"
    : "analysis_failed";
  return { reason, ...(stage ? { failure_stage: stage } : {}), ...(signal ? { signal } : {}),
    ...(exitCode && Number.isSafeInteger(Number(exitCode)) ? { exit_code: Number(exitCode) } : {}),
    ...(protocolCode !== undefined && Number.isSafeInteger(Number(protocolCode)) ? { protocol_error_code: Number(protocolCode) } : {}) };
}

type LspSourceFile = { readonly path: string; readonly content: string; readonly digest: string; readonly cached_symbols?: JsonObject[]; readonly cached_symbols_digest?: string };

function runConfiguredLsp(adapter: TrustedLspAdapter, files: readonly LspSourceFile[], service: RepositoryOnboardingPort,
  contextFiles: readonly RepositoryContextFile[] = []): JsonObject {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-lsp-"));
  try {
    stageLspSnapshotFiles(root, files, contextFiles);
    const request: LspStdioRequest = { command: adapter.command, args: adapter.args, cwd: root, analyzer: `lsp-${adapter.language}`,
      analyzer_version: adapter.analyzer_version, relations: adapter.relations as LspStdioRequest["relations"], relation_symbol_limit: adapter.relation_symbol_limit,
      request_timeout_ms: adapter.request_timeout_ms,
      documents: files.map(file => ({ path: file.path, language: languageIdForFile(file.path)!, content: file.content, source_digest: file.digest,
        ...(file.cached_symbols ? { cached_symbols: file.cached_symbols, cached_symbols_digest: file.cached_symbols_digest } : {}) })) };
    let result: JsonObject;
    if (service.analyzeLsp) result = service.analyzeLsp(request, adapter.request_timeout_ms);
    else {
      const entry = process.argv[1];
      if (!entry) throw new Error("worker_unavailable");
      const entryArgs = entry.endsWith(".ts") ? ["--experimental-strip-types", entry, CODEBASE_LSP_WORKER_FLAG] : [entry, CODEBASE_LSP_WORKER_FLAG];
      const output = execFileSync(process.execPath, entryArgs, { input: JSON.stringify(request), encoding: "utf8", timeout: 120_000,
        maxBuffer: 96 * 1024 * 1024, shell: false, stdio: ["pipe", "pipe", "ignore"] });
      result = JSON.parse(output) as JsonObject;
    }
    if (result.format === "craft-lsp-worker-failure-v1") {
      const reason = String(result.reason ?? "analysis_failed");
      const stage = typeof result.failure_stage === "string" ? ` during ${result.failure_stage}` : "";
      const protocolCode = Number.isSafeInteger(result.protocol_error_code) ? ` (protocol code ${String(result.protocol_error_code)})` : "";
      throw new Error(`${reason === "server_request_failed" ? "Language server request failed" : reason}${stage}${protocolCode}`);
    }
    return contextFiles.length ? { ...result, diagnostics: { ...(result.diagnostics as JsonObject), workspace_file_digests: contextFiles.map(({ path, digest }) => ({ path, digest })) } } : result;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function typeScriptGraph(units: readonly TypeScriptFileUnit[], mode: string, reason: string): JsonObject {
  const nodes = units.flatMap(unit => unit.nodes), edges = units.flatMap(unit => unit.edges);
  return { format: "craft-static-analysis-v1", analyzer: "typescript-checker", analyzer_version: TYPESCRIPT_ANALYZER_VERSION, nodes, edges,
    diagnostics: { unresolved_relations: units.reduce((sum, unit) => sum + unit.unresolved_relations, 0), omitted_nodes: 0, omitted_edges: 0,
      budget_limited: units.some(unit => unit.budget_limited), selected_file_count: units.length, incremental_mode: mode, incremental_reason: reason } };
}

function typeScriptCacheId(workspaceId: string, path: string): string {
  return `codebase_semantic_file_${stableDigest({ workspaceId, path }).slice(-24)}`;
}
function pythonCacheId(workspaceId: string, path: string): string {
  return `codebase_python_file_${stableDigest({ workspaceId, path }).slice(-24)}`;
}
function javaCacheId(workspaceId: string, path: string): string {
  return `codebase_java_file_${stableDigest({ workspaceId, path }).slice(-24)}`;
}
function pythonGraph(units: readonly PythonFileUnit[], mode: string, reason: string, parsedFileCount = mode === "reuse" ? 0 : units.length,
  reusedFileCount = mode === "reuse" ? units.length : 0): JsonObject {
  return { format: "craft-static-analysis-v1", analyzer: units[0]!.analyzer, analyzer_version: units[0]!.analyzer_version,
    nodes: units.flatMap(unit => unit.nodes), edges: units.flatMap(unit => unit.edges), diagnostics: {
      unresolved_calls: units.reduce((sum, unit) => sum + unit.unresolved_calls, 0),
      unresolved_imports: units.reduce((sum, unit) => sum + unit.unresolved_imports, 0),
      unresolved_relations: units.reduce((sum, unit) => sum + unit.unresolved_relations, 0),
      omitted_nodes: 0, omitted_edges: 0, budget_limited: false, incremental_mode: mode, incremental_reason: reason,
      parsed_file_count: parsedFileCount, reused_file_count: reusedFileCount,
    } };
}
function javaGraph(units: readonly JavaFileUnit[], mode: string, reason: string, parsedFileCount = mode === "reuse" ? 0 : units.length,
  reusedFileCount = mode === "reuse" ? units.length : 0, diagnostics: JsonObject = {}): JsonObject {
  return { format: "craft-static-analysis-v1", analyzer: "jdk-compiler-tree", analyzer_version: units[0]!.analyzer_version,
    nodes: units.flatMap(unit => unit.nodes), edges: units.flatMap(unit => unit.edges), diagnostics: {
      ...diagnostics, unresolved_calls: units.reduce((sum, unit) => sum + unit.unresolved_calls, 0),
      unresolved_imports: units.reduce((sum, unit) => sum + unit.unresolved_imports, 0),
      omitted_nodes: units.reduce((sum, unit) => sum + (unit.budget_limited ? 1 : 0), 0), omitted_edges: 0,
      budget_limited: units.some(unit => unit.budget_limited), incremental_mode: mode, incremental_reason: reason,
      parsed_file_count: parsedFileCount, reused_file_count: reusedFileCount,
      graph_unit_rebuild_count: parsedFileCount, graph_unit_reuse_count: reusedFileCount,
    } };
}

/** Same real worktree + same data space yields the same identity across all Hosts. */
export function ensureRepository(service: RepositoryOnboardingPort, args: JsonObject): JsonObject {
  return ensureRepositoryAttempt(service, args, 0);
}

function ensureRepositoryAttempt(service: RepositoryOnboardingPort, args: JsonObject, sourceRetry: number): JsonObject {
  const { root, isRepository } = repositoryRoot(args.project_root);
  const workspaceId = `repository_${stableDigest(root).slice(-24)}`;
  const base = { root_path: root, workspace_id: workspaceId };
  if (!isRepository) return { ...base, status: "skipped", reason: "not_repository" };
  if (args.index_depth !== undefined && !["basic", "semantic"].includes(String(args.index_depth))) throw new Error("index_depth must be basic or semantic");
  if (service.store.find("codebase_activation", `codebase_activation_${workspaceId}`)?.status === "disabled") return { ...base, status: "disabled", reason: "project_opt_out" };
  const selected = repositoryFiles(root);
  const lspConfig = readTrustedLspConfig(service.store.paths.configDir);
  const hasGoLspAdapter = lspConfig.adapters.some(adapter => adapter.language === "go");
  const workspaceContextFiles = args.index_depth === "semantic" && hasGoLspAdapter && selected.files.some(file => file.language === "go")
    ? selected.context_files : [];
  const depth = args.index_depth ?? "basic";
  const stateId = `${workspaceId}_${depth}`;
  const priorState = service.store.find("codebase_repository_state", stateId);
  const typeScriptPathSetDigest = stableDigest(selected.files.filter(file => /^(?:tsx?|mts|cts|jsx?|mjs|cjs)$/u.test(file.language)
    && !(languageIdForFile(file.path) && lspConfig.adapters.some(adapter => adapter.language === languageIdForFile(file.path)))).map(file => file.path).sort());
  const includes = [...selected.files.map(file => file.path), ...workspaceContextFiles.map(file => file.path)].sort();
  // A current snapshot and policy can be returned without invoking language
  // analyzers. This is the common path for repeated Context calls.
  const existingWorkspace = service.store.find("workspace", workspaceId);
  if (existingWorkspace && JSON.stringify(existingWorkspace.include_paths) === JSON.stringify(includes)
    && service.workspace.freshness({ workspace_id: workspaceId }).status === "current") {
    const checkpointId = String(existingWorkspace.latest_checkpoint_id ?? "");
    const prior = service.store.find("codebase_repository_state", `${workspaceId}_${depth}`);
    const cachedIndex = prior ? service.store.find("codebase_index", String(prior.index_id)) : undefined;
    if (prior?.checkpoint_id === checkpointId && prior.policy_version === REPOSITORY_INDEX_POLICY && prior.adapter_config_digest === lspConfig.digest
      && cachedIndex?.status === "ready" && repositoryStateReusable(prior))
      return { ...base, status: "ready", index_id: prior.index_id, checkpoint_id: checkpointId, index_depth: depth, reused: true, omitted_files: selected.omitted, omitted_by_language: selected.omitted_by_language, summary: prior.summary };
  }
  // Parsing and per-file cache publication must not retain the checkpoint/index
  // writer transaction. The import below validates every source digest against
  // the checkpoint, so file changes between discovery and publication fail closed.
  const configuredLanguages = new Set(lspConfig.adapters.map(adapter => adapter.language));
  const semanticFiles = selected.files.filter(file => /^(?:tsx?|mts|cts|jsx?|mjs|cjs)$/u.test(file.language)
    && !(languageIdForFile(file.path) && configuredLanguages.has(languageIdForFile(file.path)!)));
  const pythonFiles = selected.files.filter(file => file.language === "py"
    && !(languageIdForFile(file.path) && configuredLanguages.has(languageIdForFile(file.path)!)));
  const javaFiles = selected.files.filter(file => file.language === "java"
    && !(languageIdForFile(file.path) && configuredLanguages.has(languageIdForFile(file.path)!)));
  const adapterlessFiles = selected.files.filter(file => depth === "semantic" && !semanticFiles.includes(file)
    && !pythonFiles.includes(file) && !javaFiles.includes(file));
  const degraded: JsonObject[] = [];
  const semanticAnalyses: JsonObject[] = [];
  let semanticAdapterFailed = false;
  let semanticFileUnits: TypeScriptFileUnit[] = [];
  let pythonFileUnits: PythonFileUnit[] = [];
  let javaFileUnits: JavaFileUnit[] = [];
  let lspFileUnits: JsonObject[] = [];
  let cachedTypeScriptUnits: TypeScriptFileUnit[] = [];
  let cachedPythonUnits: PythonFileUnit[] = [];
  let cachedJavaUnits: JavaFileUnit[] = [];
  const cachedLspFileUnits = depth === "semantic"
    ? service.store.list("codebase_lsp_file_analysis", 1_000, item => item.workspace_id === workspaceId) as JsonObject[] : [];
  if (selected.state === "ready" && depth === "semantic") {
    degraded.push(...lspConfig.diagnostics);
    if (hasGoLspAdapter && selected.files.some(file => file.language === "go") && selected.context_files_omitted > 0)
      degraded.push({ language: "go", status: "partial", reason: "workspace_context_file_omitted", omitted_files: selected.context_files_omitted });
    const adaptedPaths = new Set<string>();
    for (const adapter of lspConfig.adapters) {
      const languageFiles = adapterlessFiles.filter(file => languageIdForFile(file.path) === adapter.language);
      if (!languageFiles.length) continue;
      const bounded = languageFiles.slice(0, adapter.max_documents);
      bounded.forEach(file => adaptedPaths.add(file.path));
      const analyzer = `lsp-${adapter.language}`;
      const adapterContextFiles = adapter.language === "go" ? workspaceContextFiles : [];
      const adapterConfigDigest = stableDigest({ config_digest: lspConfig.digest, workspace_files: adapterContextFiles.map(({ path, digest }) => ({ path, digest })) });
      const cachedByPath = new Map(cachedLspFileUnits.filter(item => item.language === adapter.language).map(item => [String(item.path), item]));
      const filesWithCache = bounded.map(file => {
        const cached = cachedByPath.get(file.path);
        if (!cached || cached.source_digest !== file.digest || cached.analyzer !== analyzer || cached.analyzer_version !== adapter.analyzer_version
          || cached.adapter_config_digest !== adapterConfigDigest || !Array.isArray(cached.symbols)) return file;
        const expectedDigest = lspDocumentSymbolsDigest({ analyzer, analyzer_version: adapter.analyzer_version, path: file.path,
          language: languageIdForFile(file.path)!, source_digest: file.digest, symbols: cached.symbols });
        if (cached.cached_symbols_digest !== expectedDigest) return file;
        return { ...file, cached_symbols: cached.symbols as JsonObject[], cached_symbols_digest: expectedDigest };
      });
      try {
        const lspAnalysis = runConfiguredLsp(adapter, filesWithCache, service, adapterContextFiles);
        semanticAnalyses.push(lspAnalysis);
        if (Array.isArray(lspAnalysis.document_symbol_cache)) lspFileUnits.push(...(lspAnalysis.document_symbol_cache as JsonObject[]).map(unit => ({ ...unit,
          analyzer, analyzer_version: adapter.analyzer_version, adapter_config_digest: adapterConfigDigest })));
      }
      catch (error) {
        semanticAdapterFailed = true;
        const failure = lspFailureDiagnostic(error);
        if (adapter.language === "go") {
          semanticAnalyses.push(basicAnalysis(service.store, workspaceId, languageFiles));
          degraded.push({ language: "go", status: "partial", reason: failure.reason, semantic_adapter_status: "unavailable",
            failure_stage: failure.failure_stage, protocol_error_code: failure.protocol_error_code,
            fallback_analyzer: "craft-basic-symbols", relations: "not_analyzed" });
        } else degraded.push({ language: adapter.language, status: "unavailable", ...failure });
      }
      if (languageFiles.length > bounded.length) degraded.push({ language: adapter.language, status: "partial", reason: "document_limit", omitted_documents: languageFiles.length - bounded.length });
    }
    for (const language of [...new Set(adapterlessFiles.filter(file => !adaptedPaths.has(file.path)).map(file => file.language))].sort()) {
      if (language === "go" && !configuredLanguages.has("go")) continue;
      const configuredLanguage = adapterlessFiles.filter(file => file.language === language).map(file => languageIdForFile(file.path)).find(Boolean);
      if (configuredLanguage && configuredLanguages.has(configuredLanguage)) continue;
      degraded.push({ language, status: "unavailable", reason: configuredLanguage ? "no_semantic_adapter" : "unsupported_lsp_language" });
    }
    const goFiles = selected.files.filter(file => file.language === "go" && !configuredLanguages.has("go"));
    if (goFiles.length) {
      semanticAnalyses.push(basicAnalysis(service.store, workspaceId, goFiles));
      degraded.push({ language: "go", status: "partial", reason: "no_semantic_adapter", fallback_analyzer: "craft-basic-symbols", relations: "not_analyzed" });
    }
    if (semanticFiles.length) {
      try {
        const files = semanticFiles.map(file => ({ ...file, language: file.language === "tsx" ? "jsx" : file.language }));
        cachedTypeScriptUnits = service.store.list("codebase_semantic_file_analysis", 1_000, item => item.workspace_id === workspaceId) as TypeScriptFileUnit[];
        const cached = cachedTypeScriptUnits;
        const plan = planTypeScriptIncremental(files, cached, TYPESCRIPT_ANALYZER_VERSION,
          typeof priorState?.typescript_path_set_digest === "string" ? priorState.typescript_path_set_digest : undefined);
        let tsAnalysis: JsonObject;
        if (plan.mode === "reuse") {
            semanticFileUnits = cached;
          tsAnalysis = typeScriptGraph(semanticFileUnits, plan.mode, plan.reason);
        } else if (plan.mode === "incremental") {
          const partial = (service.analyzeTypeScript ?? analyzeTypeScript)(files, { include_paths: plan.affected_paths, include_file_units: true });
          if (!Array.isArray(partial.file_units)) {
            const full = (service.analyzeTypeScript ?? analyzeTypeScript)(files, { include_file_units: true });
            semanticFileUnits = (full.file_units ?? []) as TypeScriptFileUnit[];
            tsAnalysis = { ...full, diagnostics: { ...(full.diagnostics as JsonObject), incremental_mode: "full", incremental_reason: "incremental_result_incomplete" } };
          } else {
            const refreshed = new Map((partial.file_units as TypeScriptFileUnit[]).map(unit => [unit.path, unit]));
            const cachedByPath = new Map(cached.map(unit => [unit.path, unit]));
            if (plan.affected_paths.some(path => !refreshed.has(path))) {
              const full = (service.analyzeTypeScript ?? analyzeTypeScript)(files, { include_file_units: true });
              semanticFileUnits = (full.file_units ?? []) as TypeScriptFileUnit[];
              tsAnalysis = { ...full, diagnostics: { ...(full.diagnostics as JsonObject), incremental_mode: "full", incremental_reason: "incremental_result_incomplete" } };
            } else {
              semanticFileUnits = files.map(file => refreshed.get(file.path) ?? cachedByPath.get(file.path)!);
              tsAnalysis = typeScriptGraph(semanticFileUnits, plan.mode, plan.reason);
            }
          }
        } else {
          const full = (service.analyzeTypeScript ?? analyzeTypeScript)(files, { include_file_units: true });
          semanticFileUnits = (full.file_units ?? []) as TypeScriptFileUnit[];
          tsAnalysis = semanticFileUnits.length === files.length
            ? typeScriptGraph(semanticFileUnits, "full", plan.reason)
            : { ...full, diagnostics: { ...(full.diagnostics as JsonObject), incremental_mode: "full", incremental_reason: plan.reason } };
        }
        const { file_units: _fileUnits, ...importableAnalysis } = tsAnalysis;
        semanticAnalyses.push(importableAnalysis);
      }
      catch { degraded.push({ language: "typescript", status: "unavailable", reason: "analysis_failed" }); }
    }
    if (pythonFiles.length) {
      cachedPythonUnits = service.store.list("codebase_python_file_analysis", 1_000, item => item.workspace_id === workspaceId) as PythonFileUnit[];
      const cached = cachedPythonUnits;
      const plan = planPythonIncremental(pythonFiles, cached);
      if (plan.mode === "reuse") {
        pythonFileUnits = cached;
        semanticAnalyses.push(pythonGraph(pythonFileUnits, plan.mode, plan.reason));
      } else if (plan.mode === "incremental") {
        const reused = new Set(plan.reused_paths);
        const partial = (service.analyzePython ?? analyzePythonCheckpoint)(pythonFiles, { includePaths: plan.affected_paths, includeFileUnits: true,
          cachedFileUnits: cached.filter(unit => reused.has(String(unit.path))) });
        const units = partial.analysis?.file_units;
        const expectedVersion = String((cached[0] as JsonObject).analyzer_version);
        const unitPaths = Array.isArray(units) ? new Set(units.map(unit => String(unit.path))) : new Set<string>();
        const completeUnits = Array.isArray(units) && unitPaths.size === pythonFiles.length
          && pythonFiles.every(file => unitPaths.has(file.path));
        const unitVersionChanged = Array.isArray(units) && units.some(unit => unit.analyzer_version !== expectedVersion);
        const analyzerCompletedFullFallback = (partial.analysis?.diagnostics as JsonObject | undefined)?.incremental_mode === "full" && completeUnits;
        if (!partial.analysis || !Array.isArray(units) || (partial.analysis.diagnostics as JsonObject | undefined)?.budget_limited === true
          || units.some(unit => unit.budget_limited !== false) || ((unitVersionChanged || analyzerCompletedFullFallback) && !completeUnits)) {
          const full = (service.analyzePython ?? analyzePythonCheckpoint)(pythonFiles, { includeFileUnits: true });
          if (full.analysis && Array.isArray(full.analysis.file_units) && full.analysis.file_units.length > 0) {
            pythonFileUnits = full.analysis.file_units as PythonFileUnit[];
            semanticAnalyses.push(pythonGraph(pythonFileUnits, "full", "incremental_result_incomplete_or_analyzer_changed"));
          } else if (full.analysis && Array.isArray(full.analysis.nodes) && full.analysis.nodes.length > 0) semanticAnalyses.push(full.analysis);
          else degraded.push({ language: "python", status: "unavailable", reason: "analysis_empty_or_missing_file_units" });
          if (full.diagnostic) degraded.push(full.diagnostic);
        } else if (completeUnits && (unitVersionChanged || analyzerCompletedFullFallback)) {
          pythonFileUnits = units as PythonFileUnit[];
          semanticAnalyses.push(pythonGraph(pythonFileUnits, "full", String((partial.analysis.diagnostics as JsonObject | undefined)?.incremental_reason ?? "analyzer_version_changed")));
        } else {
          const refreshed = new Map((units as PythonFileUnit[]).map(unit => [unit.path, unit]));
          pythonFileUnits = pythonFiles.map(file => refreshed.get(file.path) ?? cached.find(unit => unit.path === file.path) as PythonFileUnit);
          const incrementalUsed = (partial.analysis.diagnostics as JsonObject | undefined)?.incremental_mode === "incremental";
          semanticAnalyses.push(pythonGraph(pythonFileUnits, incrementalUsed ? plan.mode : "full",
            incrementalUsed ? plan.reason : "analyzer_did_not_confirm_incremental_reuse",
            incrementalUsed ? plan.affected_paths.length : pythonFiles.length,
            incrementalUsed ? plan.reused_paths.length : 0));
        }
      } else {
        const full = (service.analyzePython ?? analyzePythonCheckpoint)(pythonFiles, { includeFileUnits: true });
        if (full.analysis && Array.isArray(full.analysis.file_units) && full.analysis.file_units.length > 0) {
          pythonFileUnits = full.analysis.file_units as PythonFileUnit[];
          semanticAnalyses.push(pythonGraph(pythonFileUnits, "full", plan.reason));
        } else if (full.analysis && Array.isArray(full.analysis.nodes) && full.analysis.nodes.length > 0) semanticAnalyses.push(full.analysis);
        else degraded.push({ language: "python", status: "unavailable", reason: "analysis_empty_or_missing_file_units" });
        if (full.diagnostic) degraded.push(full.diagnostic);
      }
    }
    if (javaFiles.length) {
      cachedJavaUnits = service.store.list("codebase_java_file_analysis", 2_000, item => item.workspace_id === workspaceId) as JavaFileUnit[];
      const analyze = (includePaths: readonly string[]) => (service.analyzeJava ?? analyzeJavaCheckpoint)(javaFiles, { includePaths });
      const completeUnits = (units: unknown, paths: readonly string[]): units is JavaFileUnit[] => Array.isArray(units)
        && units.length === paths.length && new Set(units.map(unit => String((unit as JsonObject).path))).size === paths.length
        && paths.every(path => units.some(unit => (unit as JsonObject).path === path));
      const publishFull = (reason: string): boolean => {
        const full = analyze(javaFiles.map(file => file.path));
        const units = full.analysis?.file_units;
        if (full.analysis && completeUnits(units, javaFiles.map(file => file.path)) && units!.length > 0) {
          javaFileUnits = units;
          semanticAnalyses.push(javaGraph(javaFileUnits, "full", reason, undefined, undefined, full.analysis.diagnostics as JsonObject));
          return true;
        }
        if (full.analysis && Array.isArray(full.analysis.nodes) && full.analysis.nodes.length > 0 && Array.isArray(full.analysis.edges)) {
          const { file_units: _units, ...graph } = full.analysis;
          semanticAnalyses.push(graph);
          return true;
        }
        if (full.diagnostic) degraded.push(full.diagnostic);
        return false;
      };
      const plan = planJavaIncremental(javaFiles, cachedJavaUnits, JAVA_ANALYZER_VERSION);
      if (plan.mode === "reuse") {
        javaFileUnits = cachedJavaUnits;
        semanticAnalyses.push(javaGraph(javaFileUnits, plan.mode, plan.reason));
      } else if (plan.mode === "incremental") {
        const partial = analyze(plan.affected_paths);
        const refreshed = partial.analysis?.file_units;
        const completeAffected = completeUnits(refreshed, plan.affected_paths);
        const refreshedByPath = new Map((completeAffected ? refreshed : []).map(unit => [unit.path, unit]));
        const cachedByPath = new Map(cachedJavaUnits.map(unit => [unit.path, unit]));
        const combined = javaFiles.map(file => refreshedByPath.get(file.path) ?? cachedByPath.get(file.path)).filter(Boolean) as JavaFileUnit[];
        const unmappedCompilerErrors = Number((partial.analysis?.diagnostics as JsonObject | undefined)?.unmapped_compiler_errors ?? 0);
        if (!partial.analysis || !completeAffected || combined.length !== javaFiles.length
          || unmappedCompilerErrors > 0 || plan.affected_paths.some(path => refreshedByPath.get(path)?.budget_limited)) {
          if (!publishFull("incremental_result_incomplete_or_unsafe")) degraded.push(partial.diagnostic ?? { language: "java", status: "unavailable", reason: "analysis_empty_or_invalid" });
        } else {
          javaFileUnits = combined;
          semanticAnalyses.push(javaGraph(javaFileUnits, plan.mode, plan.reason, plan.affected_paths.length, plan.reused_paths.length,
            partial.analysis.diagnostics as JsonObject));
        }
      } else if (!publishFull(plan.reason)) degraded.push({ language: "java", status: "unavailable", reason: "analysis_empty_or_invalid" });
    }
  }
  const analysis = selected.state !== "ready" || selected.files.length === 0 ? undefined
    : depth === "basic" ? basicAnalysis(service.store, workspaceId, selected.files)
    : combineLanguageAnalyses(semanticAnalyses, degraded);
  // Serialize cache/checkpoint publication across processes sharing this data space.
  const publish = () => service.store.transaction(() => {
    const activation = service.store.find("codebase_activation", `codebase_activation_${workspaceId}`);
    if (activation?.status === "disabled") return { ...base, status: "disabled", reason: "project_opt_out" };
    if (selected.state === "disabled") return { ...base, status: "disabled", reason: "project_opt_out" };
    const old = service.store.find("workspace", workspaceId);
    if (!old && !includes.length) return { ...base, status: "empty", omitted_files: selected.omitted, omitted_by_language: selected.omitted_by_language };
    if (!old) service.workspaceOpen({ workspace_id: workspaceId, root_path: root, include_paths: includes, name: root });
    else if (JSON.stringify(old.include_paths) !== JSON.stringify(includes)) service.store.save("workspace", workspaceId, { ...payload(old), include_paths: includes });
    const freshness = service.workspace.freshness({ workspace_id: workspaceId });
    if (freshness.status !== "current") service.workspaceCheckpoint({ workspace_id: workspaceId, label: "automatic repository snapshot" });
    const workspace = service.store.get("workspace", workspaceId);
    if (!activation) service.codebaseActivate({ workspace_id: workspaceId, actor: "repository-auto" });
    if (!includes.length) return { ...base, status: "empty", checkpoint_id: workspace.latest_checkpoint_id, omitted_files: selected.omitted, omitted_by_language: selected.omitted_by_language };
    const checkpointId = String(workspace.latest_checkpoint_id);
    if (workspaceContextFiles.length) {
      const checkpoint = service.store.get("workspace_checkpoint", checkpointId);
      const checkpointDigests = new Map((checkpoint.entries as JsonObject[]).map(entry => [String(entry.path), String(entry.digest)]));
      if (workspaceContextFiles.some(file => checkpointDigests.get(file.path) !== file.digest)) throw new Error("Go workspace context changed during snapshot analysis");
    }
    const stateId = `${workspaceId}_${depth}`;
    const prior = priorState;
    const cachedIndex = prior ? service.store.find("codebase_index", String(prior.index_id)) : undefined;
    if (prior?.checkpoint_id === checkpointId && prior.policy_version === REPOSITORY_INDEX_POLICY && prior.adapter_config_digest === lspConfig.digest
      && cachedIndex?.status === "ready" && repositoryStateReusable(prior)) return { ...base, status: "ready", index_id: prior.index_id, checkpoint_id: checkpointId, index_depth: depth, reused: true, omitted_files: selected.omitted, omitted_by_language: selected.omitted_by_language, summary: prior.summary };
    // Restoring a checkpoint must not revive the stale index previously attached to it.
    const indexId = `repository_index_${stableDigest({ workspaceId, depth, checkpointId, state_revision: workspace.state_revision,
      policy: REPOSITORY_INDEX_POLICY, adapter_config: lspConfig.digest,
      ...(typeof priorState?.semantic_retry_after === "string" ? { semantic_retry_after: priorState.semantic_retry_after } : {}),
      ...(hasSemanticAdapterFailure(priorState) && typeof priorState?.index_id === "string" ? { previous_index_id: priorState.index_id } : {}) }).slice(-24)}`;
    const built = analysis ? service.codebaseAnalysisImport({ workspace_id: workspaceId, checkpoint_id: checkpointId, index_id: indexId, analysis })
      : service.codebaseIndexBuild({ workspace_id: workspaceId, index_id: indexId, analyzer: "heuristic" });
    const index = built.index as JsonObject;
    const details = index.analysis as JsonObject;
    const rawDiagnostics = analysis?.diagnostics ?? index.diagnostics;
    const diagnostics = Array.isArray(rawDiagnostics) ? rawDiagnostics : [rawDiagnostics];
    if (!analysis) diagnostics.push(...degraded);
    const summary = { analyzer: details.analyzer, certainty: details.certainty, supported_file_count: details.supported_file_count, unsupported_file_count: details.unsupported_file_count,
      omitted_files: selected.omitted, omitted_by_language: selected.omitted_by_language, diagnostic_count: diagnostics.length, diagnostics: diagnostics.slice(0, 10) };
    service.store.save("codebase_repository_state", stateId, { workspace_id: workspaceId, checkpoint_id: checkpointId, policy_version: REPOSITORY_INDEX_POLICY,
      adapter_config_digest: lspConfig.digest, index_id: index.id, summary,
      ...(semanticAdapterFailed ? { semantic_retry_after: new Date(Date.now() + SEMANTIC_RETRY_DELAY_MS).toISOString() } : {}),
      ...(depth === "semantic" ? { typescript_path_set_digest: typeScriptPathSetDigest } : {}) });
    if (depth === "semantic" && semanticFileUnits.length === semanticFiles.length) {
      const cacheableUnits = semanticFileUnits.filter(unit => unit.budget_limited === false);
      const livePaths = new Set(cacheableUnits.map(unit => unit.path));
      const oldUnits = semanticFiles.length ? cachedTypeScriptUnits : service.store.list("codebase_semantic_file_analysis", 1_000, item => item.workspace_id === workspaceId) as TypeScriptFileUnit[];
      const oldByPath = new Map(oldUnits.map(unit => [unit.path, unit]));
      for (const oldUnit of oldUnits)
        if (!livePaths.has(String(oldUnit.path))) service.store.remove("codebase_semantic_file_analysis", String(oldUnit.id));
      for (const unit of cacheableUnits) if (oldByPath.get(unit.path)?.unit_digest !== unit.unit_digest)
        service.store.save("codebase_semantic_file_analysis", typeScriptCacheId(workspaceId, unit.path), { workspace_id: workspaceId, ...unit });
    }
    if (depth === "semantic" && pythonFileUnits.length === pythonFiles.length && pythonFileUnits.every(unit => unit.budget_limited === false)) {
      const livePaths = new Set(pythonFileUnits.map(unit => unit.path));
      const oldUnits = pythonFiles.length ? cachedPythonUnits : service.store.list("codebase_python_file_analysis", 1_000, item => item.workspace_id === workspaceId) as PythonFileUnit[];
      const oldByPath = new Map(oldUnits.map(unit => [unit.path, unit]));
      for (const oldUnit of oldUnits)
        if (!livePaths.has(String(oldUnit.path))) service.store.remove("codebase_python_file_analysis", String(oldUnit.id));
      for (const unit of pythonFileUnits) if (oldByPath.get(unit.path)?.unit_digest !== unit.unit_digest)
        service.store.save("codebase_python_file_analysis", pythonCacheId(workspaceId, unit.path), { workspace_id: workspaceId, ...unit });
    }
    if (depth === "semantic" && javaFileUnits.length === javaFiles.length && javaFileUnits.every(unit => unit.budget_limited === false)) {
      const livePaths = new Set(javaFileUnits.map(unit => unit.path));
      const oldUnits = javaFiles.length ? cachedJavaUnits : service.store.list("codebase_java_file_analysis", 2_000, item => item.workspace_id === workspaceId) as JavaFileUnit[];
      const oldByPath = new Map(oldUnits.map(unit => [unit.path, unit]));
      for (const oldUnit of oldUnits) if (!livePaths.has(String(oldUnit.path)))
        service.store.remove("codebase_java_file_analysis", String(oldUnit.id));
      for (const unit of javaFileUnits) if (oldByPath.get(unit.path)?.unit_digest !== unit.unit_digest)
        service.store.save("codebase_java_file_analysis", javaCacheId(workspaceId, unit.path), { workspace_id: workspaceId, ...unit });
    }
    if (depth === "semantic") {
      const configuredLanguages = new Set(lspConfig.adapters.map(adapter => adapter.language));
      const livePaths = new Set(selected.files.map(file => `${languageIdForFile(file.path) ?? ""}\0${file.path}`));
      for (const oldUnit of cachedLspFileUnits) if (!configuredLanguages.has(String(oldUnit.language))
        || !livePaths.has(`${String(oldUnit.language)}\0${String(oldUnit.path)}`)) service.store.remove("codebase_lsp_file_analysis", String(oldUnit.id));
      for (const unit of lspFileUnits) {
        const cacheId = lspCacheId(workspaceId, String(unit.language), String(unit.path));
        service.store.save("codebase_lsp_file_analysis", cacheId, { workspace_id: workspaceId, ...unit });
      }
    }
    return { ...base, status: "ready", index_id: index.id, checkpoint_id: checkpointId, index_depth: depth, reused: false, omitted_files: selected.omitted, omitted_by_language: selected.omitted_by_language,
      summary };
  });
  try { return publish(); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    const snapshotChanged = /Analysis source digest mismatch:|Go workspace context changed during snapshot analysis/u.test(message);
    if (snapshotChanged && sourceRetry < 1) return ensureRepositoryAttempt(service, args, sourceRetry + 1);
    throw error;
  }
}

function lspCacheId(workspaceId: string, language: string, path: string): string {
  return `codebase_lsp_file_${stableDigest({ workspaceId, language, path }).slice(-24)}`;
}
