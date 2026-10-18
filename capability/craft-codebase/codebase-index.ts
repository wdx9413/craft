import { observeOperation } from "../../common/craft-common-log/src/index.ts";
import { CodeSymbolSearchIndex, codeContextCandidates } from "./context-search.ts";
import { matchDefinitionEdges } from "./definition-query.ts";
import { buildControlFlowGraph } from "./control-flow.ts";
import { buildDataFlowGraph } from "./data-flow.ts";
import { queryCheckpointDiagnostics } from "./lsp-diagnostics-query.ts";
import { contextAssetMatches, contextAssetRef, requiredContextRef } from "../../common/craft-common-base/src/context-assets.ts";
import { assertContextReadCurrent, type ContextReadRef } from "../../common/craft-common-store-local/src/context-access-guard.ts";
import { analyzeTypeScript } from "./typescript-analysis.ts";
import { analyzePythonControlFlow, analyzePythonDataFlow } from "./python-analysis.ts";
import { analyzeJavaControlFlow } from "./java-analysis.ts";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { digestJson, stableDigest, stableDigestStreaming } from "../../common/craft-common-base/src/digest.ts";
import { CraftStore, type JsonObject, type SaveEntry } from "../../common/craft-common-store-local/src/store.ts";
import { ProjectGraphStore } from "./project-graph-store.ts";

const ANALYZER = "builtin-regex-static-v1";
const SOURCE_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);
const MAX_RESULTS = 100;
const MAX_GRAPH_NODES = 60_000;
const MAX_GRAPH_EDGES = 300_000;
const MAX_IMPORT_GRAPH_BYTES = 64 * 1024 * 1024;
const MAX_GRAPH_BYTES = 128 * 1024 * 1024;
const MAX_SHARD_BYTES = 1_000_000;
const MAX_ROUTE_BYTES = 64 * 1024 * 1024;
const MAX_ROUTE_SHARD_BYTES = 4 * 1024 * 1024;
const CURRENT_GRAPH_STORAGE = "sharded-v4";
const PROJECT_GRAPH_STORAGE = "project-sharded-v5";
const SEARCH_CONTEXT_DECLARATION_KINDS = new Set(["function", "method", "class", "interface", "type", "enum", "struct"]);
const SEARCH_CONTEXT_CONTAINER_KINDS = new Set(["class", "interface", "type", "enum", "struct"]);

type SourceFile = { readonly path: string; readonly digest: string; readonly content: string; readonly language: string };
type SymbolSearchContext = { readonly identifiers: Map<string, string>; readonly enclosingTypes: Map<string, string> };
type Node = JsonObject & { readonly id: string; readonly kind: "file" | "symbol"; readonly path: string; readonly name: string; readonly source_digest: string; readonly span: JsonObject };
type Edge = JsonObject & { readonly id: string; readonly kind: "imports" | "calls" | "references" | "definitions" | "implements" | "extends" | "type_definition"; readonly from_node_id: string; readonly to_node_id: string; readonly provenance: "extracted" | "heuristic"; readonly confidence: "high" | "partial"; readonly source_span: JsonObject };
type EdgeRoute = { bucket: string; id: string; digest: string };
type ImpactDependencies = { readonly routes: Set<string>; readonly shards: Set<string> };
type NodeReadCache = { readonly routes: Map<string, JsonObject>; readonly shards: Map<string, Node[]>; readonly dependencies?: ImpactDependencies };
type ImpactCacheEntry = { readonly fingerprint: string; readonly dependencies: ImpactDependencies; readonly result: JsonObject };
type AnalyzerFlowResult = { result?: JsonObject; diagnostic?: JsonObject };

/** Keep unavailable analyzer responses explicit and source-free. */
export function controlFlowFallback(flow: AnalyzerFlowResult, language: string): JsonObject {
  return flow.result ?? { status: "unavailable", language, blocks: [], edges: [],
    partial_reasons: [String(flow.diagnostic?.reason ?? "analysis_unavailable")], source_content_included: false };
}

/** Keep unavailable data-flow responses explicit and source-free. */
export function dataFlowFallback(flow: AnalyzerFlowResult, language: string, symbolId: string, variable: string): JsonObject {
  return flow.result ?? { status: "unavailable", language, symbol_id: symbolId, variable, candidates: [], definitions: [], uses: [], flows: [],
    partial_reasons: [String(flow.diagnostic?.reason ?? "analysis_unavailable")], source_content_included: false, interprocedural: false };
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[A-Za-z0-9_-]+$/u.test(result)) throw new Error(`${name} must contain only letters, numbers, _ or -`);
  return result;
}

function bounded(value: unknown, name: string, fallback: number, maximum = MAX_RESULTS): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return result;
}

const RELATION_COVERAGE_STATES = new Set(["analyzed", "partial", "not_analyzed", "not_requested"]);
const RELATION_DIAGNOSTIC_COUNTS = ["budget_omitted_edges", "compiler_errors", "syntax_errors", "omitted_edges", "omitted_nodes", "relation_omitted_count", "relation_query_failures", "unresolved_endpoint_edges", "unresolved_relations", "unresolved_calls", "unresolved_imports"] as const;

/** Content-free summary so Agents can distinguish an empty graph from an unrun relation analyzer. */
export function relationAnalysisSummary(analyzer: string, diagnostics: unknown, edges: readonly JsonObject[]): JsonObject {
  const records: JsonObject[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) collect(item); return; }
    if (!value || typeof value !== "object") return;
    const record = value as JsonObject; records.push(record);
    collect(record.diagnostics); collect(record.languages);
  };
  collect(diagnostics);
  const reportedStates = [...new Set(records.map(record => record.relations).filter((state): state is string => typeof state === "string" && RELATION_COVERAGE_STATES.has(state)))].sort();
  const partialReasons = new Set<string>();
  if (reportedStates.includes("partial")) partialReasons.add("provider_reported_partial");
  if (reportedStates.includes("analyzed") && (reportedStates.includes("not_analyzed") || reportedStates.includes("not_requested"))) partialReasons.add("mixed_language_relation_coverage");
  for (const record of records) {
    if (record.budget_limited === true) partialReasons.add("analysis_budget_limited");
    for (const key of RELATION_DIAGNOSTIC_COUNTS) if (typeof record[key] === "number" && Number(record[key]) > 0) partialReasons.add(key);
    if (Array.isArray(record.unsupported_relations) && record.unsupported_relations.length) partialReasons.add("unsupported_relations");
    if (Array.isArray(record.degraded_languages) && record.degraded_languages.length) partialReasons.add("degraded_languages");
  }
  const edgeKinds = [...new Set(edges.map(edge => String(edge.kind ?? "unknown")))].sort();
  const basicOnly = analyzer === "craft-basic-symbols" || (reportedStates.length > 0 && reportedStates.every(state => state === "not_analyzed" || state === "not_requested"));
  const builtinSemantic = ["typescript-checker", "python-ast", "jdk-compiler-tree", "multi-language-static"].includes(analyzer);
  const status = basicOnly ? "not_analyzed" : partialReasons.size ? "partial"
    : reportedStates.includes("analyzed") || builtinSemantic ? "analyzed" : edges.length ? "partial" : "unknown";
  if (status === "partial" && edges.length && !partialReasons.size) partialReasons.add("adapter_reported_relations");
  return { status, analyzer, edge_count: edges.length, relation_kinds: edgeKinds, reported_statuses: reportedStates,
    partial_reasons: [...partialReasons].sort(), ...(status === "not_analyzed" ? { next_action: "build_semantic_index" } : {}) };
}

function digest(content: string): string { return createHash("sha256").update(content).digest("hex"); }

function safeChild(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]+/u).includes("..")) throw new Error("Codebase snapshot path is unsafe");
  return resolve(root, path);
}

function extension(path: string): string { return path.slice(path.lastIndexOf(".") + 1).toLowerCase(); }
function language(path: string): string { const ext = extension(path); return ext === "tsx" || ext === "jsx" ? "jsx" : ext; }
function span(content: string, offset: number, length: number): JsonObject {
  const prefix = content.slice(0, offset); const startLine = prefix.split("\n").length; const startColumn = offset - prefix.lastIndexOf("\n");
  const ending = content.slice(0, offset + length); const endLine = ending.split("\n").length; const endColumn = offset + length - ending.lastIndexOf("\n");
  return { start_offset: offset, end_offset: offset + length, start_line: startLine, start_column: startColumn, end_line: endLine, end_column: endColumn };
}

function nodeId(kind: "file" | "symbol", path: string, name: string, at = ""): string {
  return `codebase_node_${stableDigest({ kind, path, name, at }).slice(-20)}`;
}
function edgeId(kind: string, from: string, to: string, sourceSpan: JsonObject): string {
  // The object shape and property order are fixed here, so JSON-order-sensitive
  // hashing avoids canonical key sorting for every edge in a large graph.
  return `codebase_edge_${digestJson({ kind, from, to, sourceSpan }).slice(-20)}`;
}
function edgeRouteBucket(nodeId: string): string { return stableDigest(nodeId).slice(-2); }
function locationRouteKey(path: string): string { return `source-location:${path}`; }
function edgeRoutePayload(route: JsonObject): JsonObject {
  return { ...(route.index_id === undefined ? {} : { index_id: route.index_id }), bucket: route.bucket,
    ...(route.nodes === undefined ? {} : { nodes: route.nodes }), incoming: route.incoming, outgoing: route.outgoing,
    ...(route.locations === undefined ? {} : { locations: route.locations }) };
}
function edgeRouteMatches(index: JsonObject, route: JsonObject, bucket: string, digest: string): boolean {
  const indexBindingValid = index.graph_storage === "sharded-v3" || index.graph_storage === "sharded-v4" || index.graph_storage === PROJECT_GRAPH_STORAGE ? route.index_id === undefined : route.index_id === index.id;
  return indexBindingValid && route.bucket === bucket && route.route_digest === digest && stableDigestStreaming(edgeRoutePayload(route)) === digest;
}
function recordPayload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _createdAt, updated_at: _updatedAt, ...payload } = record;
  return payload;
}
function compareCodePoint(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sorted<T extends { readonly id: string }>(items: readonly T[]): T[] { return [...items].sort((left, right) => compareCodePoint(left.id, right.id)); }
function isShardedGraph(index: JsonObject): boolean { return ["sharded-v1", "sharded-v2", "sharded-v3", CURRENT_GRAPH_STORAGE, PROJECT_GRAPH_STORAGE].includes(String(index.graph_storage)); }
function graphPayloadDigest(index: JsonObject, value: unknown): string {
  return index.graph_storage !== "sharded-v1" ? digestJson(value) : stableDigest(value);
}

function componentShardDigest(index: JsonObject, kind: "nodes" | "edges"): string {
  const shardIds = index.shard_ids as string[], shardDigests = index.shard_digests as string[];
  const selected = new Set(index[`${kind === "nodes" ? "node" : "edge"}_shard_ids`] as string[]);
  return digestJson(shardIds.flatMap((id, ordinal) => selected.has(id) ? [shardDigests[ordinal]!] : []));
}

export function contentAddressedShardIds(shardDigests: readonly string[]): string[] {
  const shardIds = shardDigests.map(value => `codebase_shard_${value.slice(-32)}`);
  if (new Set(shardIds).size !== shardIds.length) throw new Error("Codebase graph produced duplicate content shards");
  return shardIds;
}

/**
 * A deep, rebuildable module for a Workspace checkpoint.  Its public interface
 * contains no filesystem root and no raw source body: callers can activate a
 * declared Workspace, build a revision, then ask four bounded structural
 * questions.  The implementation deliberately stores only paths, digests,
 * spans and relations.
 */
export class CodebaseIndexKernel {
  readonly store: CraftStore;
  readonly #symbolSearchCache = new Map<string, { fingerprint: string; search: CodeSymbolSearchIndex }>();
  readonly #impactCache = new Map<string, ImpactCacheEntry>();
  constructor(store: CraftStore) { this.store = store; }

  activate(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id"); this.store.get("workspace", workspaceId);
    const activationId = String(args.activation_id ?? `codebase_activation_${workspaceId}`); const actor = text(args.actor ?? "explicit-user", "actor");
    const existing = this.store.find("codebase_activation", activationId);
    const identity = { workspace_id: workspaceId, effect: "read_only", actor };
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Codebase activation idempotency conflict");
      if (existing.status === "active") return { activation: existing, idempotent: true };
      const activation = this.store.save("codebase_activation", activationId, { ...recordPayload(existing), status: "active", activated_at: new Date().toISOString() });
      return { activation, idempotent: false };
    }
    const activation = this.store.create("codebase_activation", activationId, { ...identity, identity_digest: stableDigest(identity), status: "active", activated_at: new Date().toISOString() });
    return { activation, idempotent: false };
  }

  deactivate(args: JsonObject): JsonObject {
    const activation = this.activation(args); const actor = text(args.actor ?? "explicit-user", "actor");
    if (activation.status === "disabled") return { activation, idempotent: true };
    const saved = this.store.save("codebase_activation", String(activation.id), { ...recordPayload(activation), status: "disabled", deactivated_by: actor, deactivated_at: new Date().toISOString() });
    return { activation: saved, idempotent: false };
  }

  status(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id"); const workspace = this.store.get("workspace", workspaceId);
    const activation = this.store.find("codebase_activation", String(args.activation_id ?? `codebase_activation_${workspaceId}`)) ?? null;
    const indexes = this.store.list("codebase_index", 1_000, (item) => item.workspace_id === workspaceId).map((index) => this.indexStatus(index, workspace));
    const ordered = indexes.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    const readiness = activation?.status !== "active" ? "disabled" : ordered.length === 0 ? "index_required" : ordered[0]!.status === "ready" ? "ready" : "rebuild_required";
    const recent = ordered.slice(0, 25);
    return { workspace_id: workspaceId, enabled: activation?.status === "active", activation, analyzer: ordered[0]?.analyzer ?? "typescript-checker", readiness,
      indexes: recent.map(index => ({ id: index.id, workspace_id: index.workspace_id, checkpoint_id: index.checkpoint_id, status: index.status,
        analyzer: index.analyzer, analyzer_version: index.analyzer_version, created_at: index.created_at, node_count: index.node_count,
        edge_count: index.edge_count, graph_storage: index.graph_storage, graph_digest: index.graph_digest,
        relation_analysis: index.relation_analysis, stale_reason: index.stale_reason })), omitted_index_count: Math.max(0, ordered.length - recent.length) };
  }

  build(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id"); const workspace = this.store.get("workspace", workspaceId); this.requireActive(args, workspaceId);
    const checkpointId = identifier(args.checkpoint_id ?? workspace.latest_checkpoint_id, "checkpoint_id"); const checkpoint = this.store.get("workspace_checkpoint", checkpointId);
    if (checkpoint.workspace_id !== workspaceId) throw new Error("Codebase checkpoint does not belong to workspace");
    const entries = Array.isArray(checkpoint.entries) ? checkpoint.entries as JsonObject[] : [];
    const sourceEntries = entries.filter((entry) => SOURCE_EXTENSIONS.has(extension(String(entry.path))));
    const files = sourceEntries.map((entry) => this.sourceFile(String(checkpoint.snapshot_root), entry));
    if (args.analyzer !== "heuristic" && files.length) {
      if (args.analyzer !== undefined && args.analyzer !== "typescript") throw new Error("Unsupported Codebase analyzer");
      return this.importAnalysis({ ...args, checkpoint_id: checkpointId, analysis: analyzeTypeScript(files) });
    }
    const unsupportedEntries = entries.filter((entry) => !SOURCE_EXTENSIONS.has(extension(String(entry.path))));
    const snapshotDigest = stableDigest(entries.map((entry) => ({ path: entry.path, digest: entry.digest, size_bytes: entry.size_bytes })));
    const identity = { workspace_id: workspaceId, checkpoint_id: checkpointId, snapshot_digest: snapshotDigest, analyzer: ANALYZER };
    const indexId = String(args.index_id ?? `codebase_index_${stableDigest(identity).slice(-20)}`); const existing = this.store.find("codebase_index", indexId);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Codebase index idempotency conflict");
      return { index: this.indexStatus(existing, workspace), idempotent: true };
    }
    const graph = this.graph(files);
    const analysis = {
      analyzer: ANALYZER,
      certainty: "partial",
      scope_digest: stableDigest({ workspace_id: workspaceId, checkpoint_id: checkpointId, allowed_paths: workspace.include_paths, snapshot_digest: snapshotDigest }),
      allowed_paths: workspace.include_paths,
      total_checkpoint_file_count: entries.length,
      supported_file_count: sourceEntries.length,
      unsupported_file_count: unsupportedEntries.length,
      supported_languages: [...new Set(files.map((file) => file.language))].sort(),
      diagnostics_count: graph.diagnostics.length,
      relation_analysis: relationAnalysisSummary(ANALYZER, graph.diagnostics, graph.edges),
    };
    const index = this.persistIndex(identity, indexId, files.length, analysis, graph.nodes, graph.edges, graph.diagnostics);
    return { index: this.indexStatus(index, workspace), idempotent: false };
  }

  /** Normalized adapter boundary: no executable plugins or source bodies enter the store. */
  importAnalysis(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id"); const workspace = this.store.get("workspace", workspaceId); this.requireActive(args, workspaceId);
    const checkpointId = identifier(args.checkpoint_id, "checkpoint_id"); const checkpoint = this.store.get("workspace_checkpoint", checkpointId);
    if (checkpoint.workspace_id !== workspaceId || workspace.latest_checkpoint_id !== checkpointId) throw new Error("Analysis requires the latest workspace checkpoint");
    const input = args.analysis as JsonObject;
    if (!input || Array.isArray(input) || typeof input !== "object" || input.format !== "craft-static-analysis-v1") throw new Error("Unsupported analysis format");
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_IMPORT_GRAPH_BYTES) throw new Error("Analysis exceeds 64 MiB budget");
    const analyzer = text(input.analyzer, "analysis.analyzer"); const analyzerVersion = text(input.analyzer_version, "analysis.analyzer_version");
    if (analyzer.length > 100 || analyzerVersion.length > 100) throw new Error("Analyzer identity exceeds budget");
    if (!Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > MAX_GRAPH_NODES || !Array.isArray(input.edges) || input.edges.length > MAX_GRAPH_EDGES) throw new Error("Analysis nodes/edges exceed budget or are missing");
    const entries = new Map((checkpoint.entries as JsonObject[]).map((entry) => [String(entry.path), entry]));
    const files = new Map<string, SourceFile>();
    const lineStartsByPath = new Map<string, number[]>();
    const fileAt = (path: string): SourceFile => {
      const cached = files.get(path); if (cached) return cached;
      const entry = entries.get(path); if (!entry) throw new Error("Analysis path is outside checkpoint");
      const file = this.sourceFile(String(checkpoint.snapshot_root), entry); files.set(path, file); return file;
    };
    const position = (lineStarts: readonly number[], offset: number): { line: number; column: number } => {
      let low = 0, high = lineStarts.length;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (lineStarts[middle]! <= offset) low = middle; else high = middle;
      }
      return { line: low + 1, column: offset - lineStarts[low]! + 1 };
    };
    const range = (value: unknown, file: SourceFile): JsonObject => {
      const offsets = value as JsonObject; const start = offsets?.start_offset; const end = offsets?.end_offset;
      if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 0 || Number(end) < Number(start) || Number(end) > file.content.length) throw new Error("Analysis span is outside snapshot (UTF-16 offsets required)");
      let lineStarts = lineStartsByPath.get(file.path);
      if (!lineStarts) {
        lineStarts = [0];
        for (let offset = 0; offset < file.content.length; offset++) if (file.content.charCodeAt(offset) === 10) lineStarts.push(offset + 1);
        lineStartsByPath.set(file.path, lineStarts);
      }
      const startPosition = position(lineStarts, Number(start)), endPosition = position(lineStarts, Number(end));
      return { start_offset: Number(start), end_offset: Number(end), start_line: startPosition.line, start_column: startPosition.column,
        end_line: endPosition.line, end_column: endPosition.column };
    };
    const relationEdges = (input.edges as unknown[]).filter((edge): edge is JsonObject => Boolean(edge) && typeof edge === "object" && !Array.isArray(edge));
    const identity = { workspace_id: workspaceId, checkpoint_id: checkpointId, analyzer, analyzer_version: analyzerVersion,
      input_digest: stableDigestStreaming({ ...input, diagnostics: relationAnalysisSummary(analyzer, input.diagnostics, relationEdges) }) };
    const indexId = identifier(args.index_id ?? `codebase_index_${stableDigest(identity).slice(-20)}`, "index_id");
    const existing = this.store.find("codebase_index", indexId);
    if (existing) { if (existing.identity_digest !== stableDigest(identity)) throw new Error("Codebase index idempotency conflict"); return { index: this.indexStatus(existing, workspace), idempotent: true }; }
    const nodes: Node[] = input.nodes.map((raw) => {
      const item = raw as JsonObject; const path = text(item.path, "node.path"); const file = fileAt(path);
      if (item.source_digest !== file.digest) throw new Error(`Analysis source digest mismatch: ${path}`);
      if (item.kind !== "file" && item.kind !== "symbol") throw new Error("Unsupported analysis node kind");
      if (item.declaration_kind !== undefined && (typeof item.declaration_kind !== "string" || !item.declaration_kind.trim() || item.declaration_kind.length > 100))
        throw new Error("Analysis declaration kind must be a non-empty string of at most 100 characters");
      return { id: identifier(item.id, "node.id"), kind: item.kind, path, name: text(item.name, "node.name"), source_digest: file.digest, span: range(item.span, file), language: text(item.language, "node.language"),
        ...(item.declaration_kind === undefined ? {} : { declaration_kind: item.declaration_kind }),
        ...(item.declaration_span === undefined ? {} : { declaration_span: range(item.declaration_span, file) }) };
    });
    const byId = new Map(nodes.map((node) => [node.id, node])); if (byId.size !== nodes.length) throw new Error("Analysis node ids must be unique");
    const edges: Edge[] = input.edges.map((raw) => {
      const item = raw as JsonObject; const from = byId.get(String(item.from_node_id)); const to = byId.get(String(item.to_node_id));
      if (!from || !to) throw new Error("Analysis edge endpoint is missing");
      if (!["calls", "imports", "references", "definitions", "implements", "extends", "type_definition"].includes(String(item.kind))) throw new Error("Unsupported analysis edge kind");
      const sourceSpan = range(item.source_span, fileAt(from.path));
      return { id: edgeId(String(item.kind), from.id, to.id, sourceSpan), kind: item.kind as Edge["kind"], from_node_id: from.id, to_node_id: to.id, source_span: sourceSpan, provenance: "extracted", confidence: "partial", producer: "external_adapter" };
    });
    const uniqueEdges = [...new Map(edges.map(edge => [edge.id, edge])).values()];
    const analysis = { analyzer, analyzer_version: analyzerVersion, provenance: "adapter_reported", certainty: "partial", offset_encoding: "utf-16", supported_languages: [...new Set(nodes.map((node) => node.language))].sort(), supported_file_count: files.size, unsupported_file_count: entries.size - files.size, total_checkpoint_file_count: entries.size, scope_digest: stableDigest({ workspace_id: workspaceId, checkpoint_id: checkpointId, allowed_paths: workspace.include_paths }), allowed_paths: workspace.include_paths,
      relation_analysis: relationAnalysisSummary(analyzer, input.diagnostics, uniqueEdges) };
    const index = this.persistIndex(identity, indexId, files.size, analysis, nodes, uniqueEdges, Array.isArray(input.diagnostics) ? input.diagnostics as JsonObject[] : []);
    return { index: this.indexStatus(index, workspace), idempotent: false };
  }

  /** Governed code candidates, not an accumulated Context member or raw index. */
  contextProjection(args: JsonObject): JsonObject {
    return observeOperation(this.store, "codebase", "context_projection", args, () => this.projectContext(args));
  }

  private projectContext(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const { index, workspace } = this.readyIndex(args);
      const query = text(args.query, "query"), limit = bounded(args.limit, "limit", 100);
      if (args.required_refs !== undefined && !Array.isArray(args.required_refs)) throw new Error("required_refs must be an array");
      const required = ((args.required_refs ?? []) as unknown[]).map(requiredContextRef).filter(ref => ref.member === "codebase");
      const scope = args.scope as JsonObject | undefined ?? { kind: "workspace", id: workspace.id };
      const normalize = (node: JsonObject): JsonObject => ({ node_id: node.id, path: node.path, name: node.name, kind: node.kind, language: node.language, selection_reason: node.selection_reason, span: node.span, source_digest: node.source_digest, version: index.version, index_id: index.id, checkpoint_id: index.checkpoint_id });
      const graph = this.loadGraph(index);
      const found = codeContextCandidates({ ...graph }, query, limit);
      const candidates = [...found.symbols as JsonObject[]];
      for (const node of graph.nodes) if (required.some(ref => contextAssetMatches(ref, contextAssetRef("codebase", normalize(node), scope))) && !candidates.some(candidate => candidate.id === node.id)) candidates.unshift(node);
      const references = candidates.map(normalize);
      for (const ref of required) if (!references.some(item => contextAssetMatches(ref, contextAssetRef("codebase", item, scope)))) throw new Error("Required Codebase reference is unavailable");
      const activation = this.store.get("codebase_activation", String(args.activation_id ?? `codebase_activation_${workspace.id}`));
      const checkpoint = this.store.get("workspace_checkpoint", String(index.checkpoint_id));
      const readRefs: ContextReadRef[] = [
        { kind: "codebase_index", id: String(index.id), version: Number(index.version) },
        { kind: "workspace", id: String(workspace.id), version: Number(workspace.version) },
        { kind: "workspace_checkpoint", id: String(checkpoint.id), version: Number(checkpoint.version) },
        { kind: "codebase_activation", id: String(activation.id), version: Number(activation.version) },
      ];
      return { workspace_id: workspace.id, index_id: index.id, checkpoint_id: index.checkpoint_id, activation_id: activation.id,
        candidates: references, query_omitted_count: found.omitted_count, read_refs: readRefs, configuration_digest: this.repositoryConfigurationDigest(workspace), candidate_only: true };
    });
  }

  /** Revalidate the exact index/activation and selected file digests after shared Context awaits. */
  assertContextProjectionCurrent(projection: JsonObject, selected: readonly JsonObject[]): void {
    assertContextReadCurrent(this.store, projection);
    const { index, workspace } = this.readyIndex(projection);
    if (this.repositoryConfigurationDigest(workspace) !== projection.configuration_digest) throw new Error("Codebase repository configuration changed during recall");
    const checkpoint = this.store.get("workspace_checkpoint", String(index.checkpoint_id));
    const entries = new Map((checkpoint.entries as JsonObject[]).map(entry => [String(entry.path), entry]));
    for (const item of selected) if (!(projection.candidates as JsonObject[]).some(candidate => stableDigest(candidate) === stableDigest(item))) throw new Error("Codebase reference was not projected");
    for (const path of new Set(selected.map(item => String(item.path)))) {
      const entry = entries.get(path);
      if (!entry) throw new Error("Codebase projection path is outside checkpoint");
      this.sourceFile(String(workspace.root_path), entry);
    }
  }

  findSymbol(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args); const query = text(args.query, "query"); const limit = bounded(args.limit, "limit", 20);
    const ranked = this.symbolSearch(index).rank(query, Number.MAX_SAFE_INTEGER);
    const nodes = ranked.slice(0, limit).map(item => item.node);
    return this.receipt("symbol_find", index, workspace, { query_digest: stableDigest(query.toLowerCase()), returned_node_ids: nodes.map((node) => node.id), omitted_count: Math.max(0, ranked.length - nodes.length) }, { symbols: nodes });
  }

  /** Agent-oriented symbol exploration: retrieve candidates and their bounded snapshot relations in one call. */
  exploreSymbols(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args);
    const query = text(args.query, "query"), limit = bounded(args.symbol_limit, "symbol_limit", 8, 10);
    if (Buffer.byteLength(query, "utf8") > 2_000) throw new Error("query exceeds the Codebase symbol exploration budget");
    const relationLimit = bounded(args.relation_limit, "relation_limit", 10, 20);
    const direction = args.direction === undefined ? "both" : text(args.direction, "direction");
    if (direction !== "incoming" && direction !== "outgoing" && direction !== "both") throw new Error("direction must be incoming, outgoing or both");
    const allowedKinds = ["calls", "imports", "references", "definitions", "implements", "extends", "type_definition"];
    const kinds = args.relation_kinds === undefined ? allowedKinds : args.relation_kinds;
    if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => typeof kind !== "string" || !allowedKinds.includes(kind))
      || new Set(kinds).size !== kinds.length) throw new Error("relation_kinds must contain unique supported relation kinds");
    const relationKinds = kinds as string[];
    const path = args.path === undefined ? undefined : text(args.path, "path");
    if (path !== undefined) {
      if (isAbsolute(path) || path.split(/[\\/]+/u).includes("..")) throw new Error("Codebase path must stay below the checkpoint");
      const checkpoint = this.store.get("workspace_checkpoint", String(index.checkpoint_id));
      if (!(checkpoint.entries as JsonObject[]).some(entry => entry.path === path)) throw new Error("Codebase path is outside checkpoint");
    }
    const ranked = this.symbolSearch(index).rank(query, Number.MAX_SAFE_INTEGER).filter(item => path === undefined || item.node.path === path);
    const selected = ranked.slice(0, limit), exact = ranked.filter(item => String(item.node.name).toLowerCase() === query.toLowerCase());
    const resolution = exact.length === 1 ? "exact_unique" : exact.length > 1 ? "exact_ambiguous" : selected.length === 0 ? "not_found" : selected.length === 1 ? "candidate" : "ambiguous";
    const nodeCache: NodeReadCache = { routes: new Map(), shards: new Map() };
    let omittedRelations = 0;
    const candidates = selected.map(({ node, score }) => {
      const edges = new Map<string, Edge>();
      for (const kind of relationKinds) {
        if (direction === "incoming" || direction === "both") for (const edge of this.loadIncidentEdges(index, String(node.id), "incoming", kind)) edges.set(edge.id, edge);
        if (direction === "outgoing" || direction === "both") for (const edge of this.loadIncidentEdges(index, String(node.id), "outgoing", kind)) edges.set(edge.id, edge);
      }
      const ordered = [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
      const relations = ordered.slice(0, relationLimit).map(edge => ({ edge, from: this.findNode(index, edge.from_node_id, nodeCache), to: this.findNode(index, edge.to_node_id, nodeCache) }));
      const omitted = Math.max(0, ordered.length - relations.length); omittedRelations += omitted;
      return { symbol: node, score, relations, omitted_relations: omitted };
    });
    const relationAnalysis = index.analysis && typeof index.analysis === "object" && (index.analysis as JsonObject).relation_analysis
      ? (index.analysis as JsonObject).relation_analysis as JsonObject
      : relationAnalysisSummary(String(index.analyzer), index.diagnostics, this.loadGraph(index).edges);
    return this.receipt("symbol_explore", index, workspace,
      { query_digest: stableDigest(query), path: path ?? null, relation_kinds: relationKinds, direction, returned_node_ids: selected.map(item => item.node.id),
        resolution, omitted_symbols: Math.max(0, ranked.length - selected.length), omitted_relations: omittedRelations },
      { query, path: path ?? null, candidates, candidate_count: ranked.length, resolution, relation_kinds: relationKinds, direction,
        omitted_symbols: Math.max(0, ranked.length - selected.length), omitted_relations: omittedRelations, relation_analysis: relationAnalysis, candidate_only: true, content_included: false });
  }

  /** Return a bounded symbol outline for one immutable checkpoint path. */
  symbolsOverview(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args);
    const path = text(args.path, "path"), limit = bounded(args.limit, "limit", 100, 500);
    if (isAbsolute(path) || path.split(/[\\/]+/u).includes("..")) throw new Error("Codebase path must stay below the checkpoint");
    const checkpoint = this.store.get("workspace_checkpoint", String(index.checkpoint_id));
    if (!(checkpoint.entries as JsonObject[]).some(entry => entry.path === path)) throw new Error("Codebase path is outside checkpoint");
    let candidates: Node[];
    if (Array.isArray(index.nodes)) candidates = index.nodes as Node[];
    else if (Number(index.location_route_version) >= 2) {
      this.assertManifest(index);
      const bucket = edgeRouteBucket(locationRouteKey(path));
      const descriptor = (index.edge_route_shards as EdgeRoute[]).find(item => item.bucket === bucket);
      if (!descriptor) candidates = [];
      else {
        const route = this.graphRecord(index, "codebase_index_edge_route", descriptor.id);
        if (!edgeRouteMatches(index, route, bucket, descriptor.digest))
          throw new Error("Codebase source location route integrity failure");
        const shardIds = (route.locations as Record<string, unknown> | undefined)?.[path];
        if (shardIds !== undefined && (!Array.isArray(shardIds) || shardIds.some(id => typeof id !== "string"))) throw new Error("Codebase source location route is malformed");
        const allowed = new Set(index.shard_ids as string[]);
        if (Array.isArray(shardIds) && shardIds.some(id => !allowed.has(String(id)))) throw new Error("Codebase source location route references an unknown shard");
        candidates = [];
        const pathShardIds = (shardIds as string[] | undefined) ?? [];
        if (pathShardIds.length) for (const shardId of pathShardIds) candidates.push(...(this.readShard(index, shardId).nodes as Node[]));
      }
    } else candidates = this.loadNodes(index);
    const symbols = candidates.filter(node => node.kind === "symbol" && node.path === path)
      .sort((left, right) => Number((left.span as JsonObject).start_offset) - Number((right.span as JsonObject).start_offset)
        || Number((right.span as JsonObject).end_offset) - Number((left.span as JsonObject).end_offset)
        || left.name.localeCompare(right.name));
    const selected = symbols.slice(0, limit);
    return this.receipt("symbols_overview", index, workspace,
      { path, returned_node_ids: selected.map(node => node.id), candidate_count: symbols.length, omitted_count: Math.max(0, symbols.length - selected.length) },
      { path, symbols: selected, candidate_count: symbols.length, omitted_count: Math.max(0, symbols.length - selected.length), truncated: symbols.length > selected.length, content_included: false });
  }

  /** Read a bounded source window around an indexed symbol from its immutable checkpoint. */
  symbolRead(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args);
    const symbol = this.findNode(index, text(args.node_id, "node_id"));
    if (symbol.kind !== "symbol") throw new Error("Codebase source read requires a symbol node");
    const checkpoint = this.store.get("workspace_checkpoint", String(index.checkpoint_id));
    const entry = (checkpoint.entries as JsonObject[]).find(item => item.path === symbol.path);
    if (!entry) throw new Error("Codebase symbol path is outside the checkpoint");
    const source = this.sourceFile(String(checkpoint.snapshot_root), entry);
    if (source.digest !== symbol.source_digest) throw new Error("Codebase symbol source digest does not match the index");
    const maxLines = bounded(args.max_lines, "max_lines", 80, 120);
    const maxBytes = bounded(args.max_bytes, "max_bytes", 10_000, 12_000);
    const startOffset = Number((symbol.span as JsonObject).start_offset);
    const lineStarts = [0];
    for (let offset = 0; offset < source.content.length; offset++) if (source.content.charCodeAt(offset) === 10) lineStarts.push(offset + 1);
    const lineAt = (offset: number): number => {
      let low = 0, high = lineStarts.length;
      while (low + 1 < high) { const middle = (low + high) >>> 1; if (lineStarts[middle]! <= offset) low = middle; else high = middle; }
      return low + 1;
    };
    const symbolLine = lineAt(startOffset), fallbackFirstLine = Math.max(1, symbolLine - 2);
    const declarationSpan = symbol.declaration_span as JsonObject | undefined;
    const declarationStart = Number(declarationSpan?.start_offset), declarationEnd = Number(declarationSpan?.end_offset);
    const hasDeclarationSpan = Number.isSafeInteger(declarationStart) && Number.isSafeInteger(declarationEnd)
      && declarationStart >= 0 && declarationEnd >= declarationStart && declarationEnd <= source.content.length;
    const readStart = hasDeclarationSpan ? declarationStart : lineStarts[fallbackFirstLine - 1]!;
    const readEnd = hasDeclarationSpan ? declarationEnd : source.content.length;
    let pageStart = readStart;
    const continuation = args.continuation === undefined ? undefined : text(args.continuation, "continuation");
    if (continuation !== undefined) {
      if (Buffer.byteLength(continuation, "utf8") > 2_048) throw new Error("Codebase continuation exceeds budget");
      let value: unknown;
      try { value = JSON.parse(Buffer.from(continuation, "base64url").toString("utf8")); }
      catch { throw new Error("Codebase continuation is invalid"); }
      const token = value as JsonObject;
      if (!token || token.version !== 1 || token.index_id !== index.id || token.node_id !== symbol.id || token.source_digest !== source.digest)
        throw new Error("Codebase continuation does not match this symbol snapshot");
      if (!Number.isSafeInteger(token.next_offset)) throw new Error("Codebase continuation offset is invalid");
      pageStart = Number(token.next_offset);
      if (pageStart < readStart || pageStart >= readEnd) throw new Error("Codebase continuation is outside the symbol source range");
    }
    const firstLine = lineAt(pageStart);
    const lastLine = Math.min(hasDeclarationSpan ? Number(declarationSpan!.end_line) : lineStarts.length, firstLine + maxLines - 1);
    const lineBoundEnd = lastLine < lineStarts.length ? lineStarts[lastLine]! : source.content.length;
    const pageEnd = Math.min(readEnd, lineBoundEnd);
    const fullExcerpt = source.content.slice(pageStart, pageEnd);
    let sourceText = "", bytesUsed = 0;
    for (const point of fullExcerpt) {
      const pointBytes = Buffer.byteLength(point, "utf8");
      if (bytesUsed + pointBytes > maxBytes) break;
      sourceText += point; bytesUsed += pointBytes;
    }
    if (!sourceText && fullExcerpt) throw new Error("max_bytes is too small for the next UTF-8 code point");
    const nextOffset = pageStart + sourceText.length;
    const truncated = nextOffset < readEnd;
    const nextContinuation = truncated ? Buffer.from(JSON.stringify({ version: 1, index_id: index.id, node_id: symbol.id,
      source_digest: source.digest, next_offset: nextOffset }), "utf8").toString("base64url") : undefined;
    const endLine = sourceText ? lineAt(nextOffset - 1) : firstLine;
    return this.receipt("symbol_read", index, workspace,
      { node_id: symbol.id, path: symbol.path, source_digest: source.digest, start_line: firstLine, end_line: endLine,
        truncated, continuation_digest: continuation === undefined ? null : stableDigest(continuation) },
      { symbol, path: symbol.path, source_digest: source.digest, start_line: firstLine,
        end_line: endLine, source: sourceText, truncated, ...(nextContinuation ? { continuation: nextContinuation } : {}),
        read_mode: hasDeclarationSpan ? "declaration" : "source_window", max_lines: maxLines, max_bytes: maxBytes, source_is_untrusted_evidence: true });
  }

  findCallers(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args);
    const symbol = this.findNode(index, text(args.symbol_id ?? args.node_id, args.symbol_id === undefined ? "node_id" : "symbol_id"));
    if (symbol.kind !== "symbol") throw new Error("Codebase caller lookup requires a symbol node");
    const limit = bounded(args.limit, "limit", 20);
    const all = this.loadIncidentEdges(index, symbol.id, "incoming", "calls");
    const edges = all.slice(0, limit), nodeCache: NodeReadCache = { routes: new Map(), shards: new Map() };
    const callers = edges.map((edge) => ({ edge, caller: this.findNode(index, edge.from_node_id, nodeCache) }));
    return this.receipt("callers_find", index, workspace, { symbol_id: symbol.id, returned_edge_ids: edges.map((edge) => edge.id), omitted_count: Math.max(0, all.length - edges.length) }, { symbol, callers });
  }

  /** Query imported semantic relations without upgrading adapter assertions to runtime proof. */
  findRelations(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args);
    const nodeCache: NodeReadCache = { routes: new Map(), shards: new Map() };
    const target = this.findNode(index, text(args.node_id, "node_id"), nodeCache);
    const kind = text(args.relation_kind, "relation_kind");
    if (!["calls", "imports", "references", "definitions", "implements", "extends", "type_definition"].includes(kind)) throw new Error("Unsupported Codebase relation kind");
    const direction = args.direction === undefined ? "incoming" : text(args.direction, "direction");
    if (direction !== "incoming" && direction !== "outgoing") throw new Error("direction must be incoming or outgoing");
    const limit = bounded(args.limit, "limit", 20);
    const all = this.loadIncidentEdges(index, target.id, direction, kind);
    const selected = all.slice(0, limit);
    const relations = selected.map(edge => ({ edge, from: this.findNode(index, edge.from_node_id, nodeCache), to: this.findNode(index, edge.to_node_id, nodeCache) }));
    return this.receipt("relations_find", index, workspace,
      { target_node_id: target.id, relation_kind: kind, direction, returned_edge_ids: selected.map(edge => edge.id), omitted_count: all.length - selected.length },
      { target, relation_kind: kind, direction, relations, omitted_count: all.length - selected.length, truncated: all.length > selected.length, candidate_only: true });
  }

  /** Resolve one snapshot source position using only digest-bound indexed relation spans. */
  findDefinition(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args);
    const path = text(args.path, "path"), offset = Number(args.offset), limit = bounded(args.limit, "limit", 20);
    if (isAbsolute(path) || path.split(/[\\/]+/u).includes("..")) throw new Error("Definition path must stay below the checkpoint");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Definition offset must be a non-negative safe integer");
    const checkpoint = this.store.get("workspace_checkpoint", String(index.checkpoint_id));
    if (!(checkpoint.entries as JsonObject[]).some(entry => entry.path === path)) throw new Error("Definition path is outside checkpoint");
    const nodeCache: NodeReadCache = { routes: new Map(), shards: new Map() };
    let edges: Edge[] = [];
    if (Array.isArray(index.edges)) {
      const nodes = this.loadNodes(index), pathByNode = new Map(nodes.map(node => [node.id, node.path]));
      edges = (index.edges as Edge[]).filter(edge => pathByNode.get(edge.from_node_id) === path);
    } else {
      this.assertManifest(index);
      const routeBucket = edgeRouteBucket(locationRouteKey(path));
      const descriptor = (index.edge_route_shards as EdgeRoute[]).find(item => item.bucket === routeBucket);
      if (descriptor) {
        const route = this.graphRecord(index, "codebase_index_edge_route", descriptor.id);
        if (!edgeRouteMatches(index, route, routeBucket, descriptor.digest))
          throw new Error("Codebase source location route integrity failure");
      if (route.locations === undefined) edges = this.loadEdges(index); // Legacy sharded indexes predate source-location routes.
        else {
          const shardIds = (route.locations as Record<string, unknown>)[path];
          if (shardIds !== undefined && (!Array.isArray(shardIds) || shardIds.some(id => typeof id !== "string"))) throw new Error("Codebase source location route is malformed");
          const allowed = new Set(index.shard_ids as string[]);
          if (Array.isArray(shardIds) && shardIds.some(id => !allowed.has(String(id)))) throw new Error("Codebase source location route references an unknown shard");
          for (const shardId of (shardIds as string[] | undefined) ?? []) edges.push(...(this.readShard(index, shardId).edges as Edge[]));
        }
      } else if (index.location_route_version === undefined) edges = this.loadEdges(index);
      edges = edges.filter(edge => {
        const from = this.findNode(index, edge.from_node_id, nodeCache);
        return from.path === path;
      });
    }
    const result = matchDefinitionEdges(edges, offset, limit), candidates = result.candidates as Edge[];
    const relations = candidates.map(edge => ({ edge, from: this.findNode(index, edge.from_node_id, nodeCache), to: this.findNode(index, edge.to_node_id, nodeCache) }));
    const definitions = relations.map(relation => relation.to);
    return this.receipt("definition_find", index, workspace,
      { path, offset, returned_node_ids: definitions.map(node => node.id), candidate_count: result.candidate_count, omitted_count: result.omitted_count, ambiguous: result.ambiguous },
      { path, offset, definitions, relations, candidate_count: result.candidate_count, omitted_count: result.omitted_count, ambiguous: result.ambiguous, candidate_only: true, content_included: false });
  }

  /** Build a bounded, source-free statement CFG from one fresh TS/JS snapshot symbol. */
  controlFlow(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args);
    const symbol = this.findNode(index, text(args.node_id, "node_id"));
    if (symbol.kind !== "symbol") throw new Error("Control-flow query requires an indexed symbol");
    const language = String(symbol.language);
    const supportsPython = ["python", "py"].includes(language);
    const supportsJava = language === "java";
    if (!supportsPython && !supportsJava && !["typescript", "javascript", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(language)) throw new Error("Control-flow query currently supports TypeScript, JavaScript, Python and Java symbols only");
    const checkpoint = this.store.get("workspace_checkpoint", String(index.checkpoint_id));
    const entry = (checkpoint.entries as JsonObject[]).find(item => item.path === symbol.path);
    if (!entry) throw new Error("Control-flow symbol path is outside the checkpoint");
    const source = this.sourceFile(String(checkpoint.snapshot_root), entry);
    if (source.digest !== symbol.source_digest) throw new Error("Control-flow symbol source digest does not match the index");
    const startOffset = Number((symbol.span as JsonObject).start_offset);
    const flow = supportsPython
      ? analyzePythonControlFlow({ ...source, language }, { id: symbol.id, name: symbol.name, startOffset })
      : supportsJava ? analyzeJavaControlFlow(source, { id: symbol.id, name: symbol.name, startOffset })
        : { result: buildControlFlowGraph(source.content, source.path, symbol.id, startOffset) };
    const result = controlFlowFallback(flow, supportsJava ? "java" : "python");
    return this.receipt("control_flow_query", index, workspace,
      { node_id: symbol.id, source_digest: source.digest }, { ...result, path: symbol.path, source_digest: source.digest });
  }

  /** Compute bounded, intra-procedural may-reaching definitions from a pinned TS/JS/Python snapshot. */
  dataFlow(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args);
    const symbol = this.findNode(index, text(args.node_id, "node_id"));
    if (symbol.kind !== "symbol") throw new Error("Data-flow query requires an indexed symbol");
    const language = String(symbol.language);
    const supportsPython = ["python", "py"].includes(language);
    const supportsTypeScript = ["typescript", "javascript", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(language);
    if (!supportsPython && !supportsTypeScript)
      throw new Error("Data-flow query currently supports TypeScript, JavaScript and Python symbols only");
    const checkpoint = this.store.get("workspace_checkpoint", String(index.checkpoint_id));
    const entry = (checkpoint.entries as JsonObject[]).find(item => item.path === symbol.path);
    if (!entry) throw new Error("Data-flow symbol path is outside the checkpoint");
    const source = this.sourceFile(String(checkpoint.snapshot_root), entry);
    if (source.digest !== symbol.source_digest) throw new Error("Data-flow symbol source digest does not match the index");
    const variable = text(args.variable, "variable");
    const flow = supportsPython
      ? analyzePythonDataFlow({ ...source, language }, { id: symbol.id, name: symbol.name,
        startOffset: Number((symbol.span as JsonObject).start_offset) }, variable)
      : { result: buildDataFlowGraph(source.content, source.path, symbol.id, Number((symbol.span as JsonObject).start_offset), variable) };
    const result = dataFlowFallback(flow, language, symbol.id, variable);
    return this.receipt("data_flow_query", index, workspace,
      { node_id: symbol.id, variable, source_digest: source.digest }, { ...result, path: symbol.path, source_digest: source.digest });
  }

  diagnostics(args: JsonObject): Promise<JsonObject> {
    return observeOperation(this.store, "codebase", "diagnostics_find", args, async () => {
      const { index, workspace } = this.readyIndex(args);
      const checkpoint = this.store.get("workspace_checkpoint", String(index.checkpoint_id));
      const result = await queryCheckpointDiagnostics({ store: this.store, checkpoint, path: text(args.path, "path"),
        limit: bounded(args.limit, "limit", 100, 500), readSource: (root, entry) => this.sourceFile(root, entry) });
      this.readyIndex(args);
      return this.receipt("diagnostics_find", index, workspace, result.query, result.payload);
    });
  }

  impact(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args);
    const seedId = text(args.node_id, "node_id"), depth = bounded(args.max_depth, "max_depth", 2, 5), limit = bounded(args.limit, "limit", 40);
    const direction = args.direction === undefined ? "both" : text(args.direction, "direction");
    if (direction !== "incoming" && direction !== "outgoing" && direction !== "both") throw new Error("direction must be incoming, outgoing or both");
    const relationKind = args.relation_kind === undefined ? undefined : text(args.relation_kind, "relation_kind");
    if (relationKind !== undefined && !["calls", "imports", "references", "definitions", "implements", "extends", "type_definition"].includes(relationKind)) throw new Error("Unsupported Codebase relation kind");
    const cacheKey = isShardedGraph(index) ? stableDigest({ index_id: index.id, identity_digest: index.identity_digest,
      graph_manifest_digest: index.graph_manifest_digest, seed_id: seedId, depth, limit, direction, relation_kind: relationKind ?? "all" }) : undefined;
    if (cacheKey) {
      const cached = this.#impactCache.get(cacheKey);
      if (cached && this.impactDependencyDigest(index, cached.dependencies) === cached.fingerprint) {
        this.#impactCache.delete(cacheKey); this.#impactCache.set(cacheKey, cached);
        return JSON.parse(JSON.stringify(cached.result)) as JsonObject;
      }
      if (cached) this.#impactCache.delete(cacheKey);
    }
    const dependencies: ImpactDependencies = { routes: new Set(), shards: new Set() };
    const nodeCache: NodeReadCache = { routes: new Map(), shards: new Map(), dependencies };
    const seed = this.findNode(index, seedId, nodeCache);
    const seen = new Set([seed.id]); const seenEdges = new Set<string>(); const selected: Edge[] = []; const edgeCache = new Map<string, Edge[]>(); let frontier = [seed.id]; let truncated = false;
    for (let level = 0; level < depth && frontier.length && !truncated; level += 1) {
      const next = new Set<string>();
      for (const nodeId of frontier) {
        for (const edge of this.loadIncidentEdges(index, nodeId, direction, relationKind, edgeCache, dependencies)) {
          if (seenEdges.has(edge.id)) continue;
          if (selected.length >= limit) { truncated = true; break; }
          seenEdges.add(edge.id); selected.push(edge);
          for (const neighbour of [edge.from_node_id, edge.to_node_id]) if (!seen.has(neighbour)) { seen.add(neighbour); next.add(neighbour); }
        }
        if (truncated) break;
      }
      frontier = [...next];
    }
    const impacted = [...seen].map((id) => this.findNode(index, id, nodeCache)).sort((left, right) => left.id.localeCompare(right.id));
    const result = this.receipt("impact_query", index, workspace,
      { seed_node_id: seed.id, max_depth: depth, direction, relation_kind: relationKind ?? "all", returned_node_ids: impacted.map((node) => node.id), returned_edge_ids: selected.map((edge) => edge.id), truncated },
      { candidate_only: true, seed, direction, relation_kind: relationKind ?? "all", max_depth: depth, truncated, nodes: impacted, edges: selected });
    if (cacheKey && dependencies.routes.size && dependencies.shards.size) {
      const entry: ImpactCacheEntry = { fingerprint: this.impactDependencyDigest(index, dependencies), dependencies: { routes: new Set(dependencies.routes), shards: new Set(dependencies.shards) }, result: JSON.parse(JSON.stringify(result)) as JsonObject };
      this.#impactCache.set(cacheKey, entry);
      while (this.#impactCache.size > 8) this.#impactCache.delete(this.#impactCache.keys().next().value as string);
    }
    return result;
  }

  contextSlice(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args); const limit = bounded(args.limit, "limit", 20); const requested = Array.isArray(args.node_ids) ? args.node_ids.map((item) => text(item, "node_ids")) : [];
    if (!requested.length || new Set(requested).size !== requested.length) throw new Error("node_ids must contain unique node ids");
    const nodeCache: NodeReadCache = { routes: new Map(), shards: new Map() };
    const nodes = requested.map(id => this.findNode(index, id, nodeCache)).slice(0, limit).map(node => ({ node_id: node.id, path: node.path, span: node.span, source_digest: node.source_digest, kind: node.kind, name: node.name }));
    return this.receipt("context_slice", index, workspace, { requested_node_ids: requested, returned_node_ids: nodes.map((node) => node.node_id), omitted_count: requested.length - nodes.length }, { references: nodes, content_included: false });
  }

  private activation(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id"); return this.store.get("codebase_activation", String(args.activation_id ?? `codebase_activation_${workspaceId}`));
  }
  private requireActive(args: JsonObject, workspaceId: string): void {
    const activation = this.store.find("codebase_activation", String(args.activation_id ?? `codebase_activation_${workspaceId}`));
    if (!activation || activation.workspace_id !== workspaceId || activation.status !== "active") throw new Error("Codebase is not explicitly active for this workspace");
  }
  private repositoryConfigurationDigest(workspace: JsonObject): string | null {
    const path = safeChild(String(workspace.root_path), ".craft-codebase.json");
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Repository config must be a regular file");
    return digest(readFileSync(path, "utf8"));
  }
  private readyIndex(args: JsonObject): { index: JsonObject; workspace: JsonObject } {
    const index = this.store.get("codebase_index", identifier(args.index_id, "index_id")); const workspace = this.store.get("workspace", String(index.workspace_id)); this.requireActive(args, String(index.workspace_id));
    if (args.workspace_id !== undefined && args.workspace_id !== index.workspace_id) throw new Error("Index does not belong to requested workspace");
    const status = this.indexStatus(index, workspace); if (status.status !== "ready") throw new Error(`Codebase index is ${status.status}`);
    return { index, workspace };
  }
  private projectGraphStore(index: JsonObject): ProjectGraphStore {
    const workspace = this.store.get("workspace", String(index.workspace_id));
    if (workspace.snapshot_storage !== "project_codebase") throw new Error("Project Codebase graph storage is not enabled for this workspace");
    return new ProjectGraphStore(String(workspace.root_path), String(workspace.id));
  }
  private graphRecord(index: JsonObject, kind: "codebase_index_shard" | "codebase_index_edge_route", id: string): JsonObject {
    return index.graph_storage === PROJECT_GRAPH_STORAGE ? this.projectGraphStore(index).read(id) : this.store.get(kind, id);
  }
  private persistIndex(identity: JsonObject, indexId: string, sourceFileCount: number, analysis: JsonObject,
    rawNodes: readonly Node[], rawEdges: readonly Edge[], diagnostics: readonly JsonObject[]): JsonObject {
    const nodes = sorted(rawNodes);
    const edges = sorted(rawEdges);
    if (nodes.length > MAX_GRAPH_NODES || edges.length > MAX_GRAPH_EDGES) throw new Error("Codebase graph exceeds storage budget");
    const nodeIds = new Set(nodes.map(node => node.id));
    if (nodeIds.size !== nodes.length || edges.some(edge => !nodeIds.has(edge.from_node_id) || !nodeIds.has(edge.to_node_id))) throw new Error("Codebase graph has duplicate nodes or dangling edges");
    const shards: Array<{ nodes: Node[]; edges: Edge[]; bytes: number }> = [];
    let graphBytes = 0;
    const nodesByPath = new Map<string, Node[]>(), edgesByPath = new Map<string, Edge[]>();
    for (const node of nodes) {
      const pathNodes = nodesByPath.get(node.path) ?? [];
      pathNodes.push(node);
      nodesByPath.set(node.path, pathNodes);
    }
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    for (const edge of edges) {
      const path = nodeById.get(edge.from_node_id)!.path;
      const pathEdges = edgesByPath.get(path) ?? [];
      pathEdges.push(edge);
      edgesByPath.set(path, pathEdges);
    }
    const paths = [...nodesByPath.keys()].sort(compareCodePoint);
    for (const path of paths) {
      const fileShards: Array<{ nodes: Node[]; edges: Edge[]; bytes: number }> = [{ nodes: [], edges: [], bytes: 128 }];
      const append = (key: "nodes" | "edges", item: Node | Edge): void => {
      const encoded = JSON.stringify(item); const size = Buffer.byteLength(encoded, "utf8") + 1;
      graphBytes += size;
      if (graphBytes > MAX_GRAPH_BYTES) throw new Error("Codebase graph exceeds storage byte budget");
      if (size > MAX_SHARD_BYTES) throw new Error("Codebase graph item exceeds shard budget");
      let shard = fileShards[fileShards.length - 1]!;
      if (shard.bytes + size > MAX_SHARD_BYTES) { shard = { nodes: [], edges: [], bytes: 128 }; fileShards.push(shard); }
      (shard[key] as (Node | Edge)[]).push(item); shard.bytes += size;
      };
      for (const node of nodesByPath.get(path)!) append("nodes", node);
      for (const edge of edgesByPath.get(path) ?? []) append("edges", edge);
      // Every path comes from at least one node; overflow shards receive the item
      // that caused the split, so no empty shard can be emitted here.
      shards.push(...fileShards);
    }
    const shardDigests = shards.map(shard => digestJson({ nodes: shard.nodes, edges: shard.edges }));
    const shardIds = contentAddressedShardIds(shardDigests);
    const nodeShardIds = shards.flatMap((shard, ordinal) => shard.nodes.length ? [shardIds[ordinal]!] : []);
    const edgeShardIds = shards.flatMap((shard, ordinal) => shard.edges.length ? [shardIds[ordinal]!] : []);
    const shardDigestById = new Map(shardIds.map((id, ordinal) => [id, shardDigests[ordinal]!]));
    const nodeDigest = digestJson(nodeShardIds.map(id => shardDigestById.get(id)));
    const edgeDigest = digestJson(edgeShardIds.map(id => shardDigestById.get(id)));
    const graphDigest = digestJson({ node_digest: nodeDigest, edge_digest: edgeDigest });
    // A node can participate in many edges. Hash each node/path once while
    // building the routing table instead of recomputing SHA-256 per edge end.
    const routeBucketsByKey = new Map<string, string>();
    const routeBucketFor = (key: string): string => {
      const cached = routeBucketsByKey.get(key);
      if (cached !== undefined) return cached;
      const bucket = edgeRouteBucket(key);
      routeBucketsByKey.set(key, bucket);
      return bucket;
    };
    const routeBuckets = new Map<string, { nodes: Map<string, string>; incoming: Map<string, Set<string>>; outgoing: Map<string, Set<string>>; locations: Map<string, Set<string>> }>();
    shards.forEach((shard, ordinal) => { for (const node of shard.nodes) {
      const bucket = routeBucketFor(node.id); const routes = routeBuckets.get(bucket) ?? { nodes: new Map(), incoming: new Map(), outgoing: new Map(), locations: new Map() };
      routes.nodes.set(node.id, shardIds[ordinal]!); routeBuckets.set(bucket, routes);
    } });
    const route = (nodeId: string, direction: "incoming" | "outgoing", shardId: string): void => {
      const bucket = routeBucketFor(nodeId); const routes = routeBuckets.get(bucket)!;
      const byNode = routes[direction]; const shardSet = byNode.get(nodeId) ?? new Set<string>(); shardSet.add(shardId); byNode.set(nodeId, shardSet); routeBuckets.set(bucket, routes);
    };
    const routeLocation = (path: string, shardId: string): void => {
      const key = locationRouteKey(path), bucket = routeBucketFor(key);
      const routes = routeBuckets.get(bucket) ?? { nodes: new Map(), incoming: new Map(), outgoing: new Map(), locations: new Map() };
      const shardSet = routes.locations.get(path) ?? new Set<string>(); shardSet.add(shardId); routes.locations.set(path, shardSet); routeBuckets.set(bucket, routes);
    };
    shards.forEach((shard, ordinal) => { for (const node of shard.nodes) routeLocation(node.path, shardIds[ordinal]!); });
    shards.forEach((shard, ordinal) => { for (const edge of shard.edges) {
      route(edge.to_node_id, "incoming", shardIds[ordinal]!); route(edge.from_node_id, "outgoing", shardIds[ordinal]!);
      // persistIndex validated every endpoint against nodeIds before building shards.
      const source = nodeById.get(edge.from_node_id)!;
      routeLocation(source.path, shardIds[ordinal]!);
    } });
    const edgeRouteRecords: Array<{ descriptor: EdgeRoute; payload: JsonObject }> = [...routeBuckets].sort(([a], [b]) => compareCodePoint(a, b)).map(([bucket, routes]) => {
      const nodes = Object.fromEntries([...routes.nodes].sort(([a], [b]) => compareCodePoint(a, b)));
      const incoming = Object.fromEntries([...routes.incoming].sort(([a], [b]) => compareCodePoint(a, b)).map(([nodeId, ids]) => [nodeId, [...ids].sort()]));
      const outgoing = Object.fromEntries([...routes.outgoing].sort(([a], [b]) => compareCodePoint(a, b)).map(([nodeId, ids]) => [nodeId, [...ids].sort()]));
      const locations = Object.fromEntries([...routes.locations].sort(([a], [b]) => compareCodePoint(a, b)).map(([path, ids]) => [path, [...ids].sort()]));
      const payload = { bucket, nodes, incoming, outgoing, locations };
      const routeDigest = stableDigestStreaming(payload);
      return { descriptor: { bucket, id: `codebase_edge_route_${routeDigest.slice(-32)}`, digest: routeDigest }, payload };
    });
    let routeBytes = 0;
    for (const item of edgeRouteRecords) {
      const bytes = Buffer.byteLength(JSON.stringify(item.payload), "utf8"); routeBytes += bytes;
      if (bytes > MAX_ROUTE_SHARD_BYTES || routeBytes > MAX_ROUTE_BYTES) throw new Error("Codebase graph adjacency routes exceed storage byte budget");
    }
    const edgeRouteShards = edgeRouteRecords.map(item => item.descriptor);
    const manifest = { location_route_version: 2, shard_ids: shardIds, shard_digests: shardDigests, node_shard_ids: nodeShardIds, edge_shard_ids: edgeShardIds,
      node_count: nodes.length, edge_count: edges.length, graph_digest: graphDigest, node_digest: nodeDigest, edge_digest: edgeDigest, edge_route_shards: edgeRouteShards };
    const workspace = this.store.get("workspace", String(identity.workspace_id));
    const projectGraphStore = workspace.snapshot_storage === "project_codebase" ? new ProjectGraphStore(String(workspace.root_path), String(identity.workspace_id)) : null;
    const immutableGraphRecords: SaveEntry[] = shards.map((shard, ordinal) => ({ kind: "codebase_index_shard", id: shardIds[ordinal]!, payload: {
      node_count: shard.nodes.length, edge_count: shard.edges.length, nodes: shard.nodes, edges: shard.edges, graph_digest: shardDigests[ordinal] } }));
    if (projectGraphStore) {
      for (const record of immutableGraphRecords) projectGraphStore.put(record.id, { ...record.payload, id: record.id, version: 1 });
      for (const route of edgeRouteRecords) projectGraphStore.put(route.descriptor.id,
        { ...route.payload, route_digest: route.descriptor.digest, id: route.descriptor.id, version: 1 });
    }
    return this.store.transaction(() => {
      const existingShards = projectGraphStore ? new Map<string, JsonObject>()
        : new Map(this.store.findMany("codebase_index_shard", shardIds, false).map(record => [String(record.id), record]));
      const newGraphRecords = immutableGraphRecords.filter(record => {
        const existing = existingShards.get(record.id);
        if (!existing) return true;
        const payloadDigest = digestJson({ nodes: existing.nodes, edges: existing.edges });
        if (existing.graph_digest !== record.payload.graph_digest || payloadDigest !== record.payload.graph_digest) throw new Error("Codebase content shard integrity failure");
        return false;
      });
      const routeIds = edgeRouteRecords.map(route => route.descriptor.id);
      const existingRoutes = projectGraphStore ? new Map<string, JsonObject>()
        : new Map(this.store.findMany("codebase_index_edge_route", routeIds, false).map(record => [String(record.id), record]));
      const newRouteRecords = edgeRouteRecords.filter(route => {
        const existing = existingRoutes.get(route.descriptor.id);
        if (!existing) return true;
        if (existing.route_digest !== route.descriptor.digest || stableDigestStreaming(edgeRoutePayload(existing)) !== route.descriptor.digest) throw new Error("Codebase content route integrity failure");
        return false;
      }).map(route => ({ kind: "codebase_index_edge_route", id: route.descriptor.id,
        payload: { ...route.payload, route_digest: route.descriptor.digest } }));
      if (!projectGraphStore) this.store.createBatch([...newGraphRecords, ...newRouteRecords]);
      for (const previous of this.store.list("codebase_index", 1_000, item => item.workspace_id === identity.workspace_id && item.status === "ready" && item.checkpoint_id !== identity.checkpoint_id))
        this.store.save("codebase_index", String(previous.id), { ...recordPayload(previous), status: "stale", stale_reason: "new_workspace_checkpoint" });
      return this.store.create("codebase_index", indexId, { ...identity, identity_digest: stableDigest(identity), status: "ready", source_file_count: sourceFileCount, analysis,
        graph_storage: projectGraphStore ? PROJECT_GRAPH_STORAGE : CURRENT_GRAPH_STORAGE, ...manifest, graph_manifest_digest: stableDigest(manifest),
        diagnostics, raw_content_stored: false });
    });
  }
  private loadNodes(index: JsonObject): Node[] {
    if (Array.isArray(index.nodes)) return index.nodes as Node[];
    const nodes = sorted(this.readShards(index, "nodes").flatMap(shard => shard.nodes as Node[]));
    if (nodes.length !== index.node_count || (index.graph_storage === "sharded-v4" || index.graph_storage === PROJECT_GRAPH_STORAGE
      ? componentShardDigest(index, "nodes") : graphPayloadDigest(index, nodes)) !== index.node_digest) throw new Error("Codebase node manifest digest mismatch");
    return nodes;
  }
  private symbolSearch(index: JsonObject): CodeSymbolSearchIndex {
    const shardIds = Array.isArray(index.node_shard_ids) ? index.node_shard_ids as string[] : [];
    const payloadDigest = shardIds.length
      ? index.graph_storage === PROJECT_GRAPH_STORAGE ? this.projectGraphStore(index).recordsDigest(shardIds)
        : this.store.latestRecordsDigest("codebase_index_shard", shardIds)
      : stableDigest(Array.isArray(index.nodes) ? index.nodes : []);
    const fingerprint = stableDigest({ index_id: index.id, identity_digest: index.identity_digest, node_digest: index.node_digest,
      node_shard_ids: shardIds, shard_digests: index.shard_digests, payload_digest: payloadDigest });
    const cached = this.#symbolSearchCache.get(String(index.id));
    if (cached?.fingerprint === fingerprint) {
      this.#symbolSearchCache.delete(String(index.id));
      this.#symbolSearchCache.set(String(index.id), cached);
      return cached.search;
    }
    const symbols = this.loadNodes(index).filter(node => node.kind === "symbol");
    const searchContext = this.symbolSearchContext(index, symbols);
    const search = new CodeSymbolSearchIndex(symbols, searchContext.identifiers, searchContext.enclosingTypes);
    this.#symbolSearchCache.set(String(index.id), { fingerprint, search });
    while (this.#symbolSearchCache.size > 2) this.#symbolSearchCache.delete(this.#symbolSearchCache.keys().next().value as string);
    return search;
  }
  /** Build ephemeral identifier-only search terms from digest-verified declarations. */
  private symbolSearchContext(index: JsonObject, symbols: readonly Node[]): SymbolSearchContext {
    const spans = symbols.filter(node => SEARCH_CONTEXT_DECLARATION_KINDS.has(String(node.declaration_kind ?? ""))
      && node.declaration_span && typeof node.declaration_span === "object");
    if (!spans.length) return { identifiers: new Map(), enclosingTypes: new Map() };
    const checkpoint = this.store.get("workspace_checkpoint", String(index.checkpoint_id));
    const entries = new Map((checkpoint.entries as JsonObject[]).map(entry => [String(entry.path), entry]));
    const byPath = new Map<string, Node[]>();
    for (const symbol of spans) byPath.set(symbol.path, [...(byPath.get(symbol.path) ?? []), symbol]);
    const contexts = new Map<string, string>(), enclosingTypes = new Map<string, string>();
    const perPathBudget = Math.floor(2_000_000 / byPath.size);
    for (const [path, fileSymbols] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
      const entry = entries.get(path);
      if (!entry || fileSymbols.some(symbol => symbol.source_digest !== entry.digest)) continue;
      const source = this.sourceFile(String(checkpoint.snapshot_root), entry);
      const orderedSymbols = fileSymbols.sort((a, b) => Number((a.declaration_span as JsonObject).start_offset) - Number((b.declaration_span as JsonObject).start_offset) || a.id.localeCompare(b.id));
      const perSymbolBudget = Math.floor(perPathBudget / orderedSymbols.length);
      const containers: JsonObject[] = [];
      for (const symbol of orderedSymbols) {
        const range = symbol.declaration_span as JsonObject;
        const start = Number(range.start_offset), end = Number(range.end_offset);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.content.length) continue;
        while (containers.length && Number((containers.at(-1)!.declaration_span as JsonObject).end_offset) < end) containers.pop();
        const ownerNames = containers.slice(-8).map(owner => String(owner.name)).filter(Boolean);
        if (ownerNames.length) enclosingTypes.set(symbol.id, ownerNames.join(" "));
        const snippet = source.content.slice(start, Math.min(end, start + Math.min(16_000, perSymbolBudget)));
        // Keep only code-like identifiers in the process-local BM25 corpus. Source prose and
        // bodies are neither persisted nor returned by symbol search.
        const identifiers = snippet.match(/[A-Za-z_$][\w$]*/gu) ?? [];
        if (identifiers.length) contexts.set(symbol.id, identifiers.join(" "));
        if (SEARCH_CONTEXT_CONTAINER_KINDS.has(String(symbol.declaration_kind))) containers.push(symbol);
      }
    }
    return { identifiers: contexts, enclosingTypes };
  }
  private impactDependencyDigest(index: JsonObject, dependencies: ImpactDependencies): string {
    const routes = [...dependencies.routes].sort(), shards = [...dependencies.shards].sort();
    if (index.graph_storage === PROJECT_GRAPH_STORAGE) return this.projectGraphStore(index).recordsDigest([...routes, ...shards]);
    return stableDigest({ routes: this.store.latestRecordsDigest("codebase_index_edge_route", routes),
      shards: this.store.latestRecordsDigest("codebase_index_shard", shards) });
  }
  private findNode(index: JsonObject, nodeId: string, cache: NodeReadCache = { routes: new Map(), shards: new Map() }): Node {
    if (Array.isArray(index.nodes)) return this.node(index.nodes as Node[], nodeId);
    this.assertManifest(index);
    const bucket = edgeRouteBucket(nodeId);
    const descriptor = (index.edge_route_shards as EdgeRoute[]).find(item => item.bucket === bucket);
    if (!descriptor) throw new Error("Codebase node is not in index");
    let route = cache.routes.get(bucket);
    if (!route) {
      cache.dependencies?.routes.add(descriptor.id);
      route = this.graphRecord(index, "codebase_index_edge_route", descriptor.id);
      const routePayload = edgeRoutePayload(route);
      if (!edgeRouteMatches(index, route, bucket, descriptor.digest))
        throw new Error("Codebase edge route integrity failure");
      cache.routes.set(bucket, route);
    }
    if (route.nodes === undefined) return this.node(this.loadNodes(index), nodeId);
    const shardId = (route.nodes as Record<string, unknown>)[nodeId];
    if (typeof shardId !== "string" || !(index.node_shard_ids as string[]).includes(shardId)) throw new Error("Codebase node is not in index");
    let nodes = cache.shards.get(shardId);
    if (!nodes) { nodes = this.readShard(index, shardId, cache.dependencies).nodes as Node[]; cache.shards.set(shardId, nodes); }
    return this.node(nodes, nodeId);
  }
  private loadEdges(index: JsonObject): Edge[] {
    const edges = sorted(this.readShards(index, "edges").flatMap(shard => shard.edges as Edge[]));
    if (edges.length !== index.edge_count || (index.graph_storage === "sharded-v4" || index.graph_storage === PROJECT_GRAPH_STORAGE
      ? componentShardDigest(index, "edges") : graphPayloadDigest(index, edges)) !== index.edge_digest) throw new Error("Codebase edge manifest digest mismatch");
    return edges;
  }
  private loadIncidentEdges(index: JsonObject, nodeId: string, direction: "incoming" | "outgoing" | "both", kind?: string, cache = new Map<string, Edge[]>(), dependencies?: ImpactDependencies): Edge[] {
    if (Array.isArray(index.edges)) return (index.edges as Edge[]).filter(edge => edge.kind === (kind ?? edge.kind)
      && (direction === "both" ? edge.from_node_id === nodeId || edge.to_node_id === nodeId
        : direction === "incoming" ? edge.to_node_id === nodeId : edge.from_node_id === nodeId));
    this.assertManifest(index);
    const bucket = edgeRouteBucket(nodeId);
    const descriptor = (index.edge_route_shards as EdgeRoute[]).find(item => item.bucket === bucket);
    if (!descriptor) throw new Error("Codebase node is not in index");
    dependencies?.routes.add(descriptor.id);
    const route = this.graphRecord(index, "codebase_index_edge_route", descriptor.id);
    const routePayload = edgeRoutePayload(route);
    if (!edgeRouteMatches(index, route, bucket, descriptor.digest))
      throw new Error("Codebase edge route integrity failure");
    const incoming = route.incoming as Record<string, unknown>, outgoing = route.outgoing as Record<string, unknown>;
    const shardIds = new Set<string>();
    if (direction === "incoming" || direction === "both") for (const id of incoming[nodeId] as string[] | undefined ?? []) shardIds.add(id);
    if (direction === "outgoing" || direction === "both") for (const id of outgoing[nodeId] as string[] | undefined ?? []) shardIds.add(id);
    const allowed = new Set(index.edge_shard_ids as string[]);
    if ([...shardIds].some(id => !allowed.has(id))) throw new Error("Codebase edge route references an unknown shard");
    const edges: Edge[] = [];
    for (const id of [...shardIds].sort()) {
      let shardEdges = cache.get(id);
      if (!shardEdges) { shardEdges = this.readShard(index, id, dependencies).edges as Edge[]; cache.set(id, shardEdges); }
      edges.push(...shardEdges.filter(edge => edge.kind === (kind ?? edge.kind)
        && (direction === "both" ? edge.from_node_id === nodeId || edge.to_node_id === nodeId
          : direction === "incoming" ? edge.to_node_id === nodeId : edge.from_node_id === nodeId)));
    }
    return sorted(edges);
  }
  private assertManifest(index: JsonObject): void {
    const manifest = { ...(index.location_route_version === undefined ? {} : { location_route_version: index.location_route_version }), shard_ids: index.shard_ids, shard_digests: index.shard_digests, node_shard_ids: index.node_shard_ids, edge_shard_ids: index.edge_shard_ids,
      node_count: index.node_count, edge_count: index.edge_count, graph_digest: index.graph_digest, node_digest: index.node_digest, edge_digest: index.edge_digest,
      edge_route_shards: index.edge_route_shards };
    if (!isShardedGraph(index) || stableDigest(manifest) !== index.graph_manifest_digest) throw new Error("Codebase graph shard manifest is invalid");
  }
  private readShard(index: JsonObject, id: string, dependencies?: ImpactDependencies): JsonObject {
    const shardIds = index.shard_ids as string[]; const ordinal = shardIds.indexOf(id);
    if (ordinal < 0) throw new Error("Codebase graph shard routing is invalid");
    dependencies?.shards.add(id);
    const shard = this.graphRecord(index, "codebase_index_shard", id);
    const ownershipValid = index.graph_storage === "sharded-v3" || index.graph_storage === "sharded-v4" || index.graph_storage === PROJECT_GRAPH_STORAGE ? shard.index_id === undefined && shard.ordinal === undefined
      : shard.index_id === index.id && shard.ordinal === ordinal;
    if (!ownershipValid || !Array.isArray(shard.nodes) || !Array.isArray(shard.edges)
      || shard.graph_digest !== (index.shard_digests as string[])[ordinal] || shard.graph_digest !== graphPayloadDigest(index, { nodes: shard.nodes, edges: shard.edges }))
      throw new Error("Codebase graph shard integrity failure");
    if ((index.graph_storage === "sharded-v3" || index.graph_storage === "sharded-v4" || index.graph_storage === PROJECT_GRAPH_STORAGE) && id !== `codebase_shard_${String(shard.graph_digest).slice(-32)}`)
      throw new Error("Codebase content shard address mismatch");
    return shard;
  }
  private readShards(index: JsonObject, kind: "nodes" | "edges"): JsonObject[] {
    if (!isShardedGraph(index) || !Array.isArray(index.shard_ids) || index.shard_ids.length > 2048
      || !Array.isArray(index.shard_digests) || index.shard_digests.length !== index.shard_ids.length
      || !Array.isArray(index[`${kind === "nodes" ? "node" : "edge"}_shard_ids`])) throw new Error("Codebase graph shard manifest is invalid");
    this.assertManifest(index);
    const routeIds = index[`${kind === "nodes" ? "node" : "edge"}_shard_ids`] as string[];
    const selected = new Set(routeIds);
    if (selected.size !== routeIds.length || routeIds.some(id => !(index.shard_ids as string[]).includes(id))) throw new Error("Codebase graph shard routing is invalid");
    if (routeIds.length === 0) {
      const count = Number(index[kind === "nodes" ? "node_count" : "edge_count"]);
      if (count !== 0 || componentShardDigest(index, kind) !== (index[kind === "nodes" ? "node_digest" : "edge_digest"]))
        throw new Error("Codebase graph component manifest is invalid");
      return [];
    }
    const shards: JsonObject[] = [];
    for (let ordinal = 0; ordinal < index.shard_ids.length; ordinal++) {
      const id = String(index.shard_ids[ordinal]);
      if (!selected.has(id)) continue;
      const shard = this.readShard(index, id);
      shards.push(shard);
    }
    return shards;
  }
  private loadGraph(index: JsonObject): { nodes: Node[]; edges: Edge[] } {
    if (Array.isArray(index.nodes) && Array.isArray(index.edges)) return { nodes: index.nodes as Node[], edges: index.edges as Edge[] };
    const nodes = this.loadNodes(index), edges = this.loadEdges(index);
    const graphDigest = index.graph_storage === "sharded-v4" || index.graph_storage === PROJECT_GRAPH_STORAGE
      ? digestJson({ node_digest: index.node_digest, edge_digest: index.edge_digest })
      : graphPayloadDigest(index, { nodes, edges });
    if (graphDigest !== index.graph_digest) throw new Error("Codebase graph manifest digest mismatch");
    return { nodes, edges };
  }
  private indexStatus(index: JsonObject, workspace: JsonObject): JsonObject {
    const stale = index.status === "stale" || workspace.latest_checkpoint_id !== index.checkpoint_id;
    return { ...index, status: stale ? "stale" : index.status, stale_reason: stale && index.stale_reason === undefined ? "workspace_checkpoint_changed" : index.stale_reason };
  }
  private sourceFile(root: string, entry: JsonObject): SourceFile {
    const path = text(entry.path, "workspace_checkpoint.entries.path"); const file = safeChild(root, path); const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Codebase snapshots support regular files only"); const content = readFileSync(file, "utf8");
    if (digest(content) !== entry.digest) throw new Error("Codebase snapshot file changed since checkpoint"); return { path, digest: String(entry.digest), content, language: language(path) };
  }
  private graph(files: readonly SourceFile[]): { nodes: Node[]; edges: Edge[]; diagnostics: JsonObject[] } {
    const nodes: Node[] = []; const edges: Edge[] = []; const diagnostics: JsonObject[] = []; const fileNodes = new Map<string, Node>(); const declarations = new Map<string, Node[]>();
    for (const file of files) {
      const fileNode: Node = { id: nodeId("file", file.path, file.path), kind: "file", path: file.path, name: file.path, source_digest: file.digest, language: file.language, span: span(file.content, 0, 0) }; fileNodes.set(file.path, fileNode); nodes.push(fileNode);
      const declaration = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
      for (const match of file.content.matchAll(declaration)) {
        const name = String(match[1]); const at = Number(match.index) + String(match[0]).lastIndexOf(name); const symbol: Node = { id: nodeId("symbol", file.path, name, String(at)), kind: "symbol", path: file.path, name, source_digest: file.digest, language: file.language, span: span(file.content, at, name.length) }; nodes.push(symbol); declarations.set(name, [...(declarations.get(name) ?? []), symbol]);
      }
    }
    for (const file of files) {
      const source = fileNodes.get(file.path)!; const imports = /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;
      for (const match of file.content.matchAll(imports)) {
        const specifier = String(match[1]); const target = this.resolveImport(file.path, specifier, fileNodes); if (!target) { diagnostics.push({ kind: "unresolved_import", path: file.path, specifier, source_span: span(file.content, Number(match.index), String(match[0]).length) }); continue; }
        const sourceSpan = span(file.content, Number(match.index), String(match[0]).length); edges.push({ id: edgeId("imports", source.id, target.id, sourceSpan), kind: "imports", from_node_id: source.id, to_node_id: target.id, provenance: "extracted", confidence: "high", source_span: sourceSpan });
      }
      const calls = /\b([A-Za-z_$][\w$]*)\s*\(/gu;
      for (const match of file.content.matchAll(calls)) {
        const name = String(match[1]); const at = Number(match.index); if (/\b(?:function|class|if|for|while|switch|catch)\s*$/u.test(file.content.slice(Math.max(0, at - 16), at))) continue;
        const targets = declarations.get(name) ?? []; if (targets.length === 1) { const sourceSpan = span(file.content, at, name.length); const target = targets[0]; edges.push({ id: edgeId("calls", source.id, target.id, sourceSpan), kind: "calls", from_node_id: source.id, to_node_id: target.id, provenance: "heuristic", confidence: "partial", source_span: sourceSpan }); }
        else if (targets.length > 1) diagnostics.push({ kind: "ambiguous_call", path: file.path, name, candidate_node_ids: targets.map((target) => target.id).sort(), source_span: span(file.content, at, name.length) });
      }
    }
    return { nodes, edges: [...new Map(edges.map((edge) => [edge.id, edge])).values()], diagnostics: diagnostics.sort((left, right) => compareCodePoint(stableDigest(left), stableDigest(right))) };
  }
  private resolveImport(path: string, specifier: string, files: ReadonlyMap<string, Node>): Node | undefined {
    if (!specifier.startsWith(".")) return undefined; const base = resolve("/", path, ".."); const raw = relative("/", resolve(base, specifier)).replaceAll("\\", "/");
    const candidates = [raw, ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((ext) => `${raw}.${ext}`), ...["ts", "tsx", "js", "jsx"].map((ext) => `${raw}/index.${ext}`)]; return candidates.map((candidate) => files.get(candidate)).find((node) => node !== undefined);
  }
  private node(nodes: readonly Node[], id: string): Node { const node = nodes.find((candidate) => candidate.id === id); if (!node) throw new Error("Codebase node is not in index"); return node; }
  private receipt(kind: string, index: JsonObject, workspace: JsonObject, query: JsonObject, result: JsonObject): JsonObject {
    const identity = { kind, index_id: index.id, index_revision_digest: index.identity_digest, workspace_id: workspace.id, query, result_digest: stableDigest(result) }; const receiptId = `codebase_receipt_${stableDigest(identity).slice(-20)}`;
    return this.store.transaction(() => {
      const existing = this.store.find("codebase_query_receipt", receiptId);
      const receipt = existing ?? this.store.create("codebase_query_receipt", receiptId, { ...identity, receipt_digest: stableDigest(identity), content_free: true, analyzer: index.analyzer, analysis: index.analysis });
      return { ...result, receipt, index: this.indexStatus(index, workspace) };
    });
  }
}
