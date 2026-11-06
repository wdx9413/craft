/**
 * Deterministic shell / PowerShell analysis.
 *
 * These languages have no semantic adapter, so indexing reported every `.sh`,
 * `.bash`, `.ps1` and `.psm1` file as a degraded language and contributed no
 * symbols or relations at all. A script is still source code: "which script
 * calls deploy?" needs the function definitions and the call/source edges, not
 * a language server.
 *
 * Byte-level and bounded: it never runs a shell, never calls a model, and only
 * emits edges whose endpoints are emitted nodes (the importer rejects dangling
 * edges outright).
 */
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import type { RepositoryFile } from "./repository-files.ts";
import { GRAPH_BUDGET } from "./graph-budget.ts";

export const SHELL_ANALYZER = "shell-static";
export const SHELL_ANALYZER_VERSION = "1";
const SHELL_LANGUAGES = new Set(["sh", "bash", "ps1", "psm1"]);
const POWERSHELL_LANGUAGES = new Set(["ps1", "psm1"]);
const MAX_SYMBOLS_PER_FILE = 400;
const MAX_CALLS_PER_FILE = 2_000;
// Definition and call names are matched verbatim, so only identifier-shaped
// names are accepted: none of these characters is a regular-expression
// metacharacter outside a class, which keeps the call scan escape-free.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

interface ShellSymbol {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

function nodeId(path: string, kind: string, name: string, start: number): string {
  return `shell_${stableDigest({ path, kind, name, start }).slice(-24)}`;
}

function edgeId(kind: string, from: string, to: string, start: number): string {
  return `shell_edge_${stableDigest({ kind, from, to, start }).slice(-24)}`;
}

/** Function definitions: POSIX `name()`, POSIX/PS `function name`, PS `filter|workflow name`. */
function definitions(file: RepositoryFile): ShellSymbol[] {
  const found: ShellSymbol[] = [];
  const starts = new Set<number>();
  const add = (name: string | undefined, start: number): void => {
    if (!name || !IDENTIFIER.test(name) || found.length >= MAX_SYMBOLS_PER_FILE || starts.has(start)) return;
    starts.add(start);
    found.push({ id: nodeId(file.path, "function", name, start), name, path: file.path, start, end: start + name.length });
  };
  if (POWERSHELL_LANGUAGES.has(file.language)) {
    for (const match of file.content.matchAll(/(?<!\S)(?:function|filter|workflow)\s+([A-Za-z_][A-Za-z0-9_-]*)/giu)) {
      add(match[1], match.index! + match[0].lastIndexOf(match[1]!));
    }
    return found;
  }
  for (const match of file.content.matchAll(/(?<![\w-])([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)/gu)) {
    // A definition sits at the start of a line; `out=$(name)` does not.
    const lineStart = file.content.lastIndexOf("\n", match.index!) + 1;
    if (file.content.slice(lineStart, match.index!).trim() !== "") continue;
    add(match[1], match.index!);
  }
  for (const match of file.content.matchAll(/(?<!\S)function\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    add(match[1], match.index! + match[0].lastIndexOf(match[1]!));
  }
  return found;
}

/** `source x` / `. x` and PowerShell `Import-Module x`. */
function importSpecifiers(file: RepositoryFile): string[] {
  const specifiers: string[] = [];
  for (const match of file.content.matchAll(/(?:^|\n)[ \t]*(?:source|\.)[ \t]+([^\s;#]+)/gu)) specifiers.push(match[1]!);
  if (POWERSHELL_LANGUAGES.has(file.language)) {
    for (const match of file.content.matchAll(/(?:^|\n)[ \t]*Import-Module[ \t]+([^\s;#]+)/giu)) specifiers.push(match[1]!);
  }
  return specifiers.filter((specifier) => !specifier.startsWith("-"));
}

function resolveImport(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null {
  const base = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/") + 1) : "";
  const raw = specifier.startsWith("/") ? specifier.slice(1) : `${base}${specifier}`;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { parts.pop(); continue; }
    parts.push(part);
  }
  const normalized = parts.join("/");
  for (const candidate of [normalized, ...["sh", "bash", "ps1", "psm1"].map((extension) => `${normalized}.${extension}`)]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

export function analyzeShell(files: readonly RepositoryFile[]): JsonObject {
  const shellFiles = files.filter((file) => SHELL_LANGUAGES.has(file.language));
  const nodes: JsonObject[] = [];
  const edges: JsonObject[] = [];
  const fileIds = new Map<string, string>();
  const symbolsByPath = new Map<string, ShellSymbol[]>();
  let omittedNodes = 0, omittedEdges = 0, unresolvedRelations = 0;

  for (const file of shellFiles) {
    const id = nodeId(file.path, "file", file.path, 0);
    fileIds.set(file.path, id);
    if (nodes.length < GRAPH_BUDGET.maxNodes) {
      nodes.push({ id, kind: "file", path: file.path, name: file.path, source_digest: file.digest,
        language: file.language, span: { start_offset: 0, end_offset: 0 } });
    } else omittedNodes++;
    const symbols = definitions(file);
    symbolsByPath.set(file.path, symbols);
    for (const symbol of symbols) {
      if (nodes.length >= GRAPH_BUDGET.maxNodes) { omittedNodes++; break; }
      nodes.push({ id: symbol.id, kind: "symbol", declaration_kind: "function", name: symbol.name, path: symbol.path,
        source_digest: file.digest, language: file.language, span: { start_offset: symbol.start, end_offset: symbol.end } });
    }
  }

  // A call only resolves when exactly one definition carries the name; a name
  // defined in several files stays ambiguous rather than inventing an edge.
  const byName = new Map<string, ShellSymbol[]>();
  for (const symbols of symbolsByPath.values()) for (const symbol of symbols) {
    const bucket = byName.get(symbol.name) ?? [];
    bucket.push(symbol);
    byName.set(symbol.name, bucket);
  }

  const addEdge = (kind: "calls" | "imports", from: string, to: string, start: number, end: number): void => {
    if (edges.length >= GRAPH_BUDGET.maxEdges) { omittedEdges++; return; }
    edges.push({ id: edgeId(kind, from, to, start), kind, from_node_id: from, to_node_id: to,
      provenance: "extracted", confidence: "partial", source_span: { start_offset: start, end_offset: end } });
  };

  const knownPaths = new Set(fileIds.keys());
  for (const file of shellFiles) {
    const sourceFileId = fileIds.get(file.path)!;
    for (const specifier of importSpecifiers(file)) {
      const target = resolveImport(file.path, specifier, knownPaths);
      if (target === null) { unresolvedRelations++; continue; }
      const start = Math.max(0, file.content.indexOf(specifier));
      addEdge("imports", sourceFileId, fileIds.get(target)!, start, start + specifier.length);
    }
    const own = [...(symbolsByPath.get(file.path) ?? [])].sort((left, right) => left.start - right.start);
    let calls = 0;
    for (const [name, targets] of byName) {
      if (calls >= MAX_CALLS_PER_FILE) break;
      if (targets.length !== 1) continue;
      // Cheap substring prefilter: compiling and running a regex for every
      // known name in every file is wasteful on a script-heavy repository.
      if (!file.content.includes(name)) continue;
      const target = targets[0]!;
      for (const match of file.content.matchAll(new RegExp(`(?<![\\w-])${name}(?![\\w-])`, "gu"))) {
        if (calls >= MAX_CALLS_PER_FILE) break;
        const start = match.index!;
        // Skip the definition's own name occurrence.
        if (target.path === file.path && start === target.start) continue;
        // Attribute the call to the innermost function that starts before it.
        const owner = own.filter((symbol) => symbol.start < start).pop();
        const from = owner && owner.id !== target.id ? owner.id : sourceFileId;
        addEdge("calls", from, target.id, start, start + name.length);
        calls++;
      }
    }
  }

  return { format: "craft-static-analysis-v1", analyzer: SHELL_ANALYZER, analyzer_version: SHELL_ANALYZER_VERSION,
    nodes, edges, diagnostics: { relations: "analyzed", analyzed_files: shellFiles.length,
      unresolved_relations: unresolvedRelations, omitted_nodes: omittedNodes, omitted_edges: omittedEdges,
      budget_limited: omittedNodes > 0 || omittedEdges > 0 } };
}
