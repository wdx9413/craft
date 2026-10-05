/** Normalize LSP DocumentSymbol responses. The caller runs its language server on the pinned checkpoint. */
import { createHash } from "node:crypto";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

export function normalizeLspSymbols(input: JsonObject): JsonObject {
  if (typeof input.analyzer !== "string" || !input.analyzer || typeof input.analyzer_version !== "string" || !input.analyzer_version) throw new Error("LSP analyzer identity required");
  if (!Array.isArray(input.documents) || input.documents.length > 1000) throw new Error("LSP documents exceed budget");
  const nodes: JsonObject[] = []; const paths = new Set<string>();
  for (const raw of input.documents) {
    const doc = raw as JsonObject;
    if (!doc || typeof doc.path !== "string" || paths.has(doc.path) || typeof doc.content !== "string" || doc.content.length > 2_000_000 || typeof doc.language !== "string" || !Array.isArray(doc.symbols)) throw new Error("Invalid or duplicate LSP document");
    paths.add(doc.path);
    const sourceDigest = createHash("sha256").update(doc.content).digest("hex");
    if (sourceDigest !== doc.source_digest) throw new Error("LSP source digest mismatch");
    const lines = doc.content.split("\n"), offsets = [0];
    for (let i = 0; i < lines.length - 1; i++) offsets.push(offsets[i]! + lines[i]!.length + 1);
    const offset = (position: JsonObject): number => {
      const line = position?.line, character = position?.character;
      if (!Number.isInteger(line) || !Number.isInteger(character) || Number(line) < 0 || Number(line) >= lines.length || Number(character) < 0 || Number(character) > lines[Number(line)]!.replace(/\r$/, "").length) throw new Error("LSP position is outside snapshot");
      return offsets[Number(line)]! + Number(character);
    };
    const visit = (symbols: unknown[], depth: number) => {
      if (depth > 32) throw new Error("LSP symbol nesting exceeds budget");
      for (const rawSymbol of symbols) {
        const symbol = rawSymbol as JsonObject;
        if (!symbol || typeof symbol.name !== "string" || !symbol.name || symbol.name.length > 512 || /[\r\n]/.test(symbol.name)) throw new Error("Invalid LSP symbol name");
        const range = (symbol.selectionRange ?? symbol.range) as JsonObject;
        const start = offset(range?.start as JsonObject), end = offset(range?.end as JsonObject);
        if (end < start) throw new Error("LSP range is reversed");
        const id = `lsp_${createHash("sha256").update(JSON.stringify([doc.path, symbol.name, start, end])).digest("hex").slice(0, 24)}`;
        nodes.push({ id, kind: "symbol", path: doc.path, language: doc.language, name: symbol.name, source_digest: sourceDigest, span: { start_offset: start, end_offset: end } });
        if (nodes.length > 10_000) throw new Error("LSP symbol count exceeds budget");
        if (symbol.children !== undefined) { if (!Array.isArray(symbol.children)) throw new Error("LSP children must be an array"); visit(symbol.children, depth + 1); }
      }
    };
    visit(doc.symbols, 0);
  }
  const relations = input.relations ?? [];
  if (!Array.isArray(relations) || relations.length > 20_000) throw new Error("LSP relation budget exceeded");
  const edges = relations.map(raw => {
    const relation = raw as JsonObject;
    if (!relation || !["calls", "imports", "references", "implements", "type_definition"].includes(String(relation.kind))) throw new Error("Invalid LSP relation kind");
    const endpoint = (value: unknown): JsonObject => {
      const ref = value as JsonObject;
      const found = nodes.find(node => node.path === ref?.path && (node.span as JsonObject).start_offset === ref.start_offset);
      if (!found) throw new Error("LSP relation endpoint is outside supplied symbols");
      return found;
    };
    const from = endpoint(relation.from), to = endpoint(relation.to);
    const source = (input.documents as unknown[]).find(raw => (raw as JsonObject).path === from.path) as JsonObject;
    const span = relation.source_span as JsonObject;
    if (!Number.isSafeInteger(span?.start_offset) || !Number.isSafeInteger(span?.end_offset) || Number(span.start_offset) < 0
      || Number(span.end_offset) < Number(span.start_offset) || Number(span.end_offset) > String(source.content).length) throw new Error("LSP relation span is outside source");
    return { kind: relation.kind, from_node_id: from.id, to_node_id: to.id, source_span: span };
  });
  return { format: "craft-static-analysis-v1", analyzer: input.analyzer, analyzer_version: input.analyzer_version, nodes, edges };
}
