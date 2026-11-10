/** Normalize LSP DocumentSymbol responses. The caller runs its language server on the pinned checkpoint. */
import { createHash } from "node:crypto";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { lspDeclarationKind } from "./symbol-kind.ts";

const MAX_LSP_SYMBOLS = 60_000;

export function lspDocumentSymbolsDigest(input: { analyzer: string; analyzer_version: string; path: string; language: string; source_digest: string; symbols: unknown }): string {
  return stableDigest({ analyzer: input.analyzer, analyzer_version: input.analyzer_version, path: input.path, language: input.language,
    source_digest: input.source_digest, symbols: input.symbols });
}

/** Persist only the bounded symbol names, kinds and positions needed for re-normalization. */
export function cacheLspDocumentSymbols(symbols: readonly unknown[]): JsonObject[] {
  const position = (value: unknown): JsonObject | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as JsonObject;
    return Number.isSafeInteger(item.line) && Number(item.line) >= 0 && Number.isSafeInteger(item.character) && Number(item.character) >= 0
      ? { line: item.line, character: item.character } : undefined;
  };
  const range = (value: unknown): JsonObject | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as JsonObject, start = position(item.start), end = position(item.end);
    return start && end ? { start, end } : undefined;
  };
  const visit = (values: readonly unknown[]): JsonObject[] => values.map(raw => {
    const item = raw as JsonObject;
    const selectedRange = range(item.selectionRange), fullRange = range(item.range);
    return { name: item.name, ...(typeof item.kind === "number" && Number.isSafeInteger(item.kind) ? { kind: item.kind } : {}),
      ...(fullRange ? { range: fullRange } : {}), ...(selectedRange ? { selectionRange: selectedRange } : {}),
      ...(Array.isArray(item.children) ? { children: visit(item.children) } : {}) };
  });
  return visit(symbols);
}

export function normalizeLspSymbols(input: JsonObject): JsonObject {
  if (typeof input.analyzer !== "string" || !input.analyzer || typeof input.analyzer_version !== "string" || !input.analyzer_version) throw new Error("LSP analyzer identity required");
  if (!Array.isArray(input.documents) || input.documents.length > 1000) throw new Error("LSP documents exceed budget");
  const nodes: JsonObject[] = []; const documents = new Map<string, JsonObject>();
  const endpoints = new Map<string, Map<number, JsonObject>>();
  let omittedSymbols = 0;
  for (const raw of input.documents) {
    const doc = raw as JsonObject;
    if (!doc || typeof doc.path !== "string" || documents.has(doc.path) || typeof doc.content !== "string" || doc.content.length > 2_000_000 || typeof doc.language !== "string" || !Array.isArray(doc.symbols)) throw new Error("Invalid or duplicate LSP document");
    documents.set(doc.path, doc);
    const documentEndpoints = new Map<number, JsonObject>();
    endpoints.set(doc.path, documentEndpoints);
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
        const fullRange = symbol.range && typeof symbol.range === "object" && !Array.isArray(symbol.range) ? symbol.range as JsonObject : undefined;
        const selectedRange = symbol.selectionRange && typeof symbol.selectionRange === "object" && !Array.isArray(symbol.selectionRange)
          ? symbol.selectionRange as JsonObject : fullRange;
        const start = offset(selectedRange?.start as JsonObject), end = offset(selectedRange?.end as JsonObject);
        if (end < start) throw new Error("LSP range is reversed");
        if (nodes.length >= MAX_LSP_SYMBOLS) omittedSymbols++;
        else {
          const id = `lsp_${createHash("sha256").update(JSON.stringify([doc.path, symbol.name, start, end])).digest("hex").slice(0, 24)}`;
          const declarationKind = lspDeclarationKind(symbol.kind);
          const declarationStart = fullRange ? offset(fullRange.start as JsonObject) : undefined;
          const declarationEnd = fullRange ? offset(fullRange.end as JsonObject) : undefined;
          const node = { id, kind: "symbol", path: doc.path, language: doc.language, name: symbol.name, source_digest: sourceDigest,
            ...(declarationKind ? { symbol_kind: Number(symbol.kind), declaration_kind: declarationKind } : {}),
            span: { start_offset: start, end_offset: end },
            ...(declarationStart === undefined || declarationEnd === undefined ? {} : { declaration_span: { start_offset: declarationStart, end_offset: declarationEnd } }) };
          nodes.push(node);
          // Preserve the first matching symbol when nested symbols share a start position.
          if (!documentEndpoints.has(start)) documentEndpoints.set(start, node);
        }
        if (symbol.children !== undefined) { if (!Array.isArray(symbol.children)) throw new Error("LSP children must be an array"); visit(symbol.children, depth + 1); }
      }
    };
    visit(doc.symbols, 0);
  }
  const relations = input.relations ?? [];
  if (!Array.isArray(relations) || relations.length > 20_000) throw new Error("LSP relation budget exceeded");
  const edges = relations.map(raw => {
    const relation = raw as JsonObject;
    if (!relation || !["calls", "imports", "references", "definitions", "implements", "extends", "type_definition"].includes(String(relation.kind))) throw new Error("Invalid LSP relation kind");
    const endpoint = (value: unknown): JsonObject => {
      const ref = value as JsonObject;
      const found = typeof ref?.path === "string" && typeof ref.start_offset === "number"
        ? endpoints.get(ref.path)?.get(ref.start_offset) : undefined;
      if (!found) throw new Error("LSP relation endpoint is outside supplied symbols");
      return found;
    };
    const from = endpoint(relation.from), to = endpoint(relation.to);
    const source = documents.get(String(from.path))!;
    const span = relation.source_span as JsonObject;
    if (!Number.isSafeInteger(span?.start_offset) || !Number.isSafeInteger(span?.end_offset) || Number(span.start_offset) < 0
      || Number(span.end_offset) < Number(span.start_offset) || Number(span.end_offset) > String(source.content).length) throw new Error("LSP relation span is outside source");
    return { kind: relation.kind, from_node_id: from.id, to_node_id: to.id, source_span: span };
  });
  return { format: "craft-static-analysis-v1", analyzer: input.analyzer, analyzer_version: input.analyzer_version, nodes, edges,
    diagnostics: { budget_limited: omittedSymbols > 0, omitted_symbols: omittedSymbols } };
}
