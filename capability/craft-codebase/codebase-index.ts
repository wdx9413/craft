import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { stableDigest } from "../../core/digest.ts";
import { CraftStore, type JsonObject } from "../../core/infrastructure/store.ts";

const ANALYZER = "builtin-regex-static-v1";
const SOURCE_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);
const MAX_RESULTS = 100;

type SourceFile = { readonly path: string; readonly digest: string; readonly content: string; readonly language: string };
type Node = JsonObject & { readonly id: string; readonly kind: "file" | "symbol"; readonly path: string; readonly name: string; readonly source_digest: string; readonly span: JsonObject };
type Edge = JsonObject & { readonly id: string; readonly kind: "imports" | "calls"; readonly from_node_id: string; readonly to_node_id: string; readonly provenance: "extracted" | "heuristic"; readonly confidence: "high" | "partial"; readonly source_span: JsonObject };

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

function nodeId(indexId: string, kind: "file" | "symbol", path: string, name: string, at = ""): string {
  return `codebase_node_${stableDigest({ indexId, kind, path, name, at }).slice(-20)}`;
}
function edgeId(indexId: string, kind: string, from: string, to: string, sourceSpan: JsonObject): string {
  return `codebase_edge_${stableDigest({ indexId, kind, from, to, sourceSpan }).slice(-20)}`;
}
function recordPayload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _createdAt, updated_at: _updatedAt, ...payload } = record;
  return payload;
}
function sorted<T extends { readonly id: string }>(items: readonly T[]): T[] { return [...items].sort((left, right) => left.id.localeCompare(right.id)); }

/**
 * A deep, rebuildable module for a Workspace checkpoint.  Its public interface
 * contains no filesystem root and no raw source body: callers can activate a
 * declared Workspace, build a revision, then ask four bounded structural
 * questions.  The implementation deliberately stores only paths, digests,
 * spans and relations.
 */
export class CodebaseIndexKernel {
  readonly store: CraftStore;
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
    return { workspace_id: workspaceId, enabled: activation?.status === "active", activation, analyzer: ANALYZER, readiness, indexes: ordered };
  }

  build(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id"); const workspace = this.store.get("workspace", workspaceId); this.requireActive(args, workspaceId);
    const checkpointId = identifier(args.checkpoint_id ?? workspace.latest_checkpoint_id, "checkpoint_id"); const checkpoint = this.store.get("workspace_checkpoint", checkpointId);
    if (checkpoint.workspace_id !== workspaceId) throw new Error("Codebase checkpoint does not belong to workspace");
    const entries = Array.isArray(checkpoint.entries) ? checkpoint.entries as JsonObject[] : [];
    const sourceEntries = entries.filter((entry) => SOURCE_EXTENSIONS.has(extension(String(entry.path))));
    const files = sourceEntries.map((entry) => this.sourceFile(String(checkpoint.snapshot_root), entry));
    const unsupportedEntries = entries.filter((entry) => !SOURCE_EXTENSIONS.has(extension(String(entry.path))));
    const snapshotDigest = stableDigest(entries.map((entry) => ({ path: entry.path, digest: entry.digest, size_bytes: entry.size_bytes })));
    const identity = { workspace_id: workspaceId, checkpoint_id: checkpointId, snapshot_digest: snapshotDigest, analyzer: ANALYZER };
    const indexId = String(args.index_id ?? `codebase_index_${stableDigest(identity).slice(-20)}`); const existing = this.store.find("codebase_index", indexId);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Codebase index idempotency conflict");
      return { index: this.indexStatus(existing, workspace), idempotent: true };
    }
    const graph = this.graph(indexId, files);
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
    };
    for (const previous of this.store.list("codebase_index", 1_000, (item) => item.workspace_id === workspaceId && item.status === "ready")) {
      if (previous.checkpoint_id !== checkpointId) this.store.save("codebase_index", String(previous.id), { ...recordPayload(previous), status: "stale", stale_reason: "new_workspace_checkpoint" });
    }
    const index = this.store.create("codebase_index", indexId, { ...identity, identity_digest: stableDigest(identity), status: "ready", source_file_count: files.length, analysis, nodes: graph.nodes, edges: graph.edges, diagnostics: graph.diagnostics, raw_content_stored: false });
    return { index: this.indexStatus(index, workspace), idempotent: false };
  }

  findSymbol(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args); const query = text(args.query, "query").toLowerCase(); const limit = bounded(args.limit, "limit", 20);
    const nodes = (index.nodes as Node[]).filter((node) => node.kind === "symbol" && (node.name.toLowerCase() === query || node.name.toLowerCase().includes(query))).sort((left, right) => Number(right.name.toLowerCase() === query) - Number(left.name.toLowerCase() === query) || left.id.localeCompare(right.id)).slice(0, limit);
    return this.receipt("symbol_find", index, workspace, { query_digest: stableDigest(query), returned_node_ids: nodes.map((node) => node.id), omitted_count: Math.max(0, (index.nodes as Node[]).filter((node) => node.kind === "symbol" && node.name.toLowerCase().includes(query)).length - nodes.length) }, { symbols: nodes });
  }

  findCallers(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args); const symbol = this.symbol(index, args); const limit = bounded(args.limit, "limit", 20);
    const edges = (index.edges as Edge[]).filter((edge) => edge.kind === "calls" && edge.to_node_id === symbol.id).slice(0, limit);
    const nodes = new Map((index.nodes as Node[]).map((node) => [node.id, node])); const callers = edges.map((edge) => ({ edge, caller: nodes.get(edge.from_node_id) }));
    return this.receipt("callers_find", index, workspace, { symbol_id: symbol.id, returned_edge_ids: edges.map((edge) => edge.id), omitted_count: Math.max(0, (index.edges as Edge[]).filter((edge) => edge.kind === "calls" && edge.to_node_id === symbol.id).length - edges.length) }, { symbol, callers });
  }

  impact(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args); const seed = this.node(index, text(args.node_id, "node_id")); const depth = bounded(args.max_depth, "max_depth", 2, 5); const limit = bounded(args.limit, "limit", 40);
    const edges = index.edges as Edge[]; const seen = new Set([seed.id]); const seenEdges = new Set<string>(); const selected: Edge[] = []; let frontier = [seed.id];
    for (let level = 0; level < depth && frontier.length && selected.length < limit; level += 1) {
      const next = new Set<string>();
      const frontierSet = new Set(frontier);
      for (const edge of edges.filter((candidate) => frontierSet.has(candidate.from_node_id) || frontierSet.has(candidate.to_node_id))) {
        if (selected.length >= limit) break;
        if (seenEdges.has(edge.id)) continue;
        seenEdges.add(edge.id); selected.push(edge);
        for (const neighbour of [edge.from_node_id, edge.to_node_id]) if (!seen.has(neighbour)) { seen.add(neighbour); next.add(neighbour); }
      }
      frontier = [...next];
    }
    const nodes = new Map((index.nodes as Node[]).map((node) => [node.id, node])); const impacted = [...seen].map((id) => nodes.get(id)).filter((node): node is Node => node !== undefined).sort((left, right) => left.id.localeCompare(right.id));
    return this.receipt("impact_query", index, workspace, { seed_node_id: seed.id, max_depth: depth, returned_node_ids: impacted.map((node) => node.id), returned_edge_ids: selected.map((edge) => edge.id), truncated: selected.length >= limit }, { candidate_only: true, seed, nodes: impacted, edges: selected });
  }

  contextSlice(args: JsonObject): JsonObject {
    const { index, workspace } = this.readyIndex(args); const limit = bounded(args.limit, "limit", 20); const requested = Array.isArray(args.node_ids) ? args.node_ids.map((item) => text(item, "node_ids")) : [];
    if (!requested.length || new Set(requested).size !== requested.length) throw new Error("node_ids must contain unique node ids");
    const nodes = requested.map((id) => this.node(index, id)).slice(0, limit).map((node) => ({ node_id: node.id, path: node.path, span: node.span, source_digest: node.source_digest, kind: node.kind, name: node.name }));
    return this.receipt("context_slice", index, workspace, { requested_node_ids: requested, returned_node_ids: nodes.map((node) => node.node_id), omitted_count: requested.length - nodes.length }, { references: nodes, content_included: false });
  }

  private activation(args: JsonObject): JsonObject {
    const workspaceId = identifier(args.workspace_id, "workspace_id"); return this.store.get("codebase_activation", String(args.activation_id ?? `codebase_activation_${workspaceId}`));
  }
  private requireActive(args: JsonObject, workspaceId: string): void {
    const activation = this.store.find("codebase_activation", String(args.activation_id ?? `codebase_activation_${workspaceId}`));
    if (!activation || activation.workspace_id !== workspaceId || activation.status !== "active") throw new Error("Codebase is not explicitly active for this workspace");
  }
  private readyIndex(args: JsonObject): { index: JsonObject; workspace: JsonObject } {
    const index = this.store.get("codebase_index", identifier(args.index_id, "index_id")); const workspace = this.store.get("workspace", String(index.workspace_id)); this.requireActive(args, String(index.workspace_id));
    const status = this.indexStatus(index, workspace); if (status.status !== "ready") throw new Error(`Codebase index is ${status.status}`);
    return { index, workspace };
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
  private graph(indexId: string, files: readonly SourceFile[]): { nodes: Node[]; edges: Edge[]; diagnostics: JsonObject[] } {
    const nodes: Node[] = []; const edges: Edge[] = []; const diagnostics: JsonObject[] = []; const fileNodes = new Map<string, Node>(); const declarations = new Map<string, Node[]>();
    for (const file of files) {
      const fileNode: Node = { id: nodeId(indexId, "file", file.path, file.path), kind: "file", path: file.path, name: file.path, source_digest: file.digest, language: file.language, span: span(file.content, 0, 0) }; fileNodes.set(file.path, fileNode); nodes.push(fileNode);
      const declaration = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
      for (const match of file.content.matchAll(declaration)) {
        const name = String(match[1]); const at = Number(match.index) + String(match[0]).lastIndexOf(name); const symbol: Node = { id: nodeId(indexId, "symbol", file.path, name, String(at)), kind: "symbol", path: file.path, name, source_digest: file.digest, language: file.language, span: span(file.content, at, name.length) }; nodes.push(symbol); declarations.set(name, [...(declarations.get(name) ?? []), symbol]);
      }
    }
    for (const file of files) {
      const source = fileNodes.get(file.path)!; const imports = /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;
      for (const match of file.content.matchAll(imports)) {
        const specifier = String(match[1]); const target = this.resolveImport(file.path, specifier, fileNodes); if (!target) { diagnostics.push({ kind: "unresolved_import", path: file.path, specifier, source_span: span(file.content, Number(match.index), String(match[0]).length) }); continue; }
        const sourceSpan = span(file.content, Number(match.index), String(match[0]).length); edges.push({ id: edgeId(indexId, "imports", source.id, target.id, sourceSpan), kind: "imports", from_node_id: source.id, to_node_id: target.id, provenance: "extracted", confidence: "high", source_span: sourceSpan });
      }
      const calls = /\b([A-Za-z_$][\w$]*)\s*\(/gu;
      for (const match of file.content.matchAll(calls)) {
        const name = String(match[1]); const at = Number(match.index); if (/\b(?:function|class|if|for|while|switch|catch)\s*$/u.test(file.content.slice(Math.max(0, at - 16), at))) continue;
        const targets = declarations.get(name) ?? []; if (targets.length === 1) { const sourceSpan = span(file.content, at, name.length); const target = targets[0]; edges.push({ id: edgeId(indexId, "calls", source.id, target.id, sourceSpan), kind: "calls", from_node_id: source.id, to_node_id: target.id, provenance: "heuristic", confidence: "partial", source_span: sourceSpan }); }
        else if (targets.length > 1) diagnostics.push({ kind: "ambiguous_call", path: file.path, name, candidate_node_ids: targets.map((target) => target.id).sort(), source_span: span(file.content, at, name.length) });
      }
    }
    return { nodes: sorted(nodes), edges: sorted([...new Map(edges.map((edge) => [edge.id, edge])).values()]), diagnostics: diagnostics.sort((left, right) => stableDigest(left).localeCompare(stableDigest(right))) };
  }
  private resolveImport(path: string, specifier: string, files: ReadonlyMap<string, Node>): Node | undefined {
    if (!specifier.startsWith(".")) return undefined; const base = resolve("/", path, ".."); const raw = relative("/", resolve(base, specifier)).replaceAll("\\", "/");
    const candidates = [raw, ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((ext) => `${raw}.${ext}`), ...["ts", "tsx", "js", "jsx"].map((ext) => `${raw}/index.${ext}`)]; return candidates.map((candidate) => files.get(candidate)).find((node) => node !== undefined);
  }
  private node(index: JsonObject, id: string): Node { const node = (index.nodes as Node[]).find((candidate) => candidate.id === id); if (!node) throw new Error("Codebase node is not in index"); return node; }
  private symbol(index: JsonObject, args: JsonObject): Node { const node = args.symbol_id === undefined ? this.node(index, text(args.node_id, "node_id")) : this.node(index, text(args.symbol_id, "symbol_id")); if (node.kind !== "symbol") throw new Error("Codebase caller lookup requires a symbol node"); return node; }
  private receipt(kind: string, index: JsonObject, workspace: JsonObject, query: JsonObject, result: JsonObject): JsonObject {
    const identity = { kind, index_id: index.id, index_revision_digest: index.identity_digest, workspace_id: workspace.id, query, result_digest: stableDigest(result) }; const receiptId = `codebase_receipt_${stableDigest(identity).slice(-20)}`; const existing = this.store.find("codebase_query_receipt", receiptId);
    const receipt = existing ?? this.store.create("codebase_query_receipt", receiptId, { ...identity, receipt_digest: stableDigest(identity), content_free: true, analyzer: ANALYZER, analysis: index.analysis });
    return { ...result, receipt, index: this.indexStatus(index, workspace) };
  }
}
