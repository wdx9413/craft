import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { RepositoryFile } from "./repository-files.ts";

type Definition = { id: string; name: string; path: string; indent: number; start: number; end: number; kind: string };

const DEFINITION = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/u;
const CALL = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu;
const KEYWORDS = new Set(["if", "for", "while", "return", "class", "def", "with", "except", "raise", "assert", "lambda", "print"]);

function nodeId(path: string, name: string, start: number): string {
  return `python_symbol_${stableDigest({ path, name, start }).slice(-24)}`;
}

/**
 * Lightweight Python symbol/call extraction used only when no Python runtime is
 * available. It is deliberately marked partial: it extracts definitions and
 * heuristic call edges, not full AST semantics.
 */
export function analyzePythonFallback(files: readonly RepositoryFile[]): JsonObject {
  const nodes: JsonObject[] = [];
  const edges: JsonObject[] = [];
  const definitions: Definition[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    let offset = 0;
    const fileId = `python_file_${stableDigest(file.path).slice(-24)}`;
    nodes.push({ id: fileId, kind: "file", path: file.path, name: file.path, language: "python",
      source_digest: file.digest, span: { start_offset: 0, end_offset: 0 } });
    const starts: Array<{ line: number; offset: number }> = [];
    for (const line of lines) { starts.push({ line: offset, offset }); offset += line.length + 1; }

    for (let index = 0; index < lines.length; index += 1) {
      const match = DEFINITION.exec(lines[index]!);
      if (!match) continue;
      const indent = match[1]!.length, name = match[3]!;
      const lineOffset = starts[index]!.offset;
      const start = lineOffset + match[0].length - name.length;
      let endLine = index;
      for (let next = index + 1; next < lines.length; next += 1) {
        const text = lines[next]!;
        if (!text.trim() || text.trimStart().startsWith("#")) continue;
        if (text.length - text.trimStart().length <= indent) break;
        endLine = next;
      }
      const end = starts[endLine]!.offset + lines[endLine]!.length;
      const id = nodeId(file.path, name, start);
      const kind = match[2] === "class" ? "class" : indent > 0 ? "method" : "function";
      nodes.push({ id, kind: "symbol", path: file.path, name, language: "python", declaration_kind: kind,
        source_digest: file.digest, span: { start_offset: start, end_offset: start + name.length },
        declaration_span: { start_offset: lineOffset, end_offset: end } });
      definitions.push({ id, name, path: file.path, indent, start, end, kind });
    }
  }
  for (const definition of definitions) {
    const body = files.find(file => file.path === definition.path)!.content.slice(definition.start, definition.end);
    for (const match of body.matchAll(CALL)) {
      const name = match[1]!;
      if (name === definition.name || KEYWORDS.has(name)) continue;
      const targets = definitions.filter(candidate => candidate.name === name);
      if (targets.length !== 1) continue;
      const callStart = definition.start + match.index;
      edges.push({ id: `python_call_${stableDigest({ from: definition.id, to: targets[0]!.id, callStart }).slice(-24)}`,
        kind: "calls", from_node_id: definition.id, to_node_id: targets[0]!.id, provenance: "heuristic", confidence: "partial",
        source_span: { start_offset: callStart, end_offset: callStart + name.length } });
    }
  }
  const units: JsonObject[] = files.map(file => {
    const fileNodes = nodes.filter(node => node.path === file.path);
    const fileNodeIds = new Set(fileNodes.map(node => String(node.id)));
    const fileEdges = edges.filter(edge => fileNodeIds.has(String(edge.from_node_id)));
    return { path: file.path, source_digest: file.digest, analyzer: "python-regex-fallback",
      analyzer_version: "craft-python-regex-v2", nodes: fileNodes, edges: fileEdges,
      class_methods: [], unresolved_calls: 0, unresolved_imports: 0, unresolved_relations: fileEdges.length,
      // Call targets depend on name uniqueness across the entire file set.
      incremental_safe: false, budget_limited: false };
  });
  return { format: "craft-static-analysis-v1", analyzer: "python-regex-fallback", analyzer_version: "craft-python-regex-v2",
    nodes, edges, diagnostics: { fallback: true, python_runtime: "unavailable", unresolved_calls: 0 }, file_units: units };
}
