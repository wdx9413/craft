import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

type SymbolRange = { readonly node: JsonObject; readonly start: number; readonly end: number };
type TextIndex = { offset(raw: JsonObject | undefined): number | undefined };
type DocumentInfo = { readonly path: string; readonly content: string; readonly uri: string; readonly index: TextIndex; readonly symbols: readonly SymbolRange[] };

/** Spread a bounded relation budget across checkpoint files instead of exhausting it in the first large file. */
export function selectLspRelationSymbols(nodes: readonly JsonObject[], limit: number, prioritizeCallables = false): JsonObject[] {
  if (!Number.isSafeInteger(limit) || limit < 1) return [];
  const byPath = new Map<string, JsonObject[]>();
  for (const node of nodes) {
    const path = String(node.path ?? "");
    const group = byPath.get(path) ?? [];
    group.push(node);
    byPath.set(path, group);
  }
  const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const compareSymbol = (left: JsonObject, right: JsonObject): number => {
    const leftSpan = left.span && typeof left.span === "object" ? left.span as JsonObject : {};
    const rightSpan = right.span && typeof right.span === "object" ? right.span as JsonObject : {};
    const leftStart = Number.isSafeInteger(leftSpan.start_offset) ? Number(leftSpan.start_offset) : Number.MAX_SAFE_INTEGER;
    const rightStart = Number.isSafeInteger(rightSpan.start_offset) ? Number(rightSpan.start_offset) : Number.MAX_SAFE_INTEGER;
    return leftStart - rightStart || compareText(String(left.name ?? ""), String(right.name ?? "")) || compareText(String(left.id ?? ""), String(right.id ?? ""));
  };
  const groups = [...byPath.entries()].sort(([left], [right]) => compareText(left, right)).map(([, group]) => group.sort((left, right) => {
    if (prioritizeCallables) {
      const leftCallable = [6, 9, 12].includes(Number(left.symbol_kind));
      const rightCallable = [6, 9, 12].includes(Number(right.symbol_kind));
      const callableOrder = Number(rightCallable) - Number(leftCallable);
      if (callableOrder) return callableOrder;
    }
    return compareSymbol(left, right);
  }));
  const selected: JsonObject[] = [];
  for (let offset = 0; selected.length < limit; offset++) {
    const candidates = groups.map(group => group[offset]).filter((node): node is JsonObject => node !== undefined);
    if (!candidates.length) break;
    const remaining = limit - selected.length;
    if (candidates.length <= remaining) { selected.push(...candidates); continue; }
    const slots = remaining;
    for (let slot = 0; slot < slots; slot++) {
      const index = slots === 1 ? Math.floor((candidates.length - 1) / 2)
        : Math.floor(slot * (candidates.length - 1) / (slots - 1));
      selected.push(candidates[index]!);
    }
  }
  return selected;
}

/** Convert protocol Locations and CallHierarchy results into checkpoint-local graph facts. */
export function collectLspRelations(input: JsonObject): JsonObject {
  if (typeof input.cwd !== "string" || !Array.isArray(input.documents) || !Array.isArray(input.nodes)
    || !Array.isArray(input.references) || !Array.isArray(input.calls)) throw new Error("Invalid LSP relation collection input");
  const root = resolve(input.cwd);
  const byUri = new Map<string, DocumentInfo>(), byPath = new Map<string, DocumentInfo>();
  const nodesById = new Map((input.nodes as JsonObject[]).map(node => [String(node.id), node]));
  const nodesByPathOffset = new Map<string, Map<number, JsonObject>>();
  for (const node of input.nodes as JsonObject[]) {
    const path = String(node.path), offset = Number((node.span as JsonObject).start_offset);
    if (!nodesByPathOffset.has(path)) nodesByPathOffset.set(path, new Map());
    const at = nodesByPathOffset.get(path)!;
    if (!at.has(offset)) at.set(offset, node);
  }
  for (const raw of input.documents as JsonObject[]) {
    const path = String(raw.path), content = String(raw.content), uri = String(raw.uri);
    const index = textIndex(content), symbols = flatten(raw.symbols as unknown[], index, nodesByPathOffset.get(path) ?? new Map());
    const info = { path, content, uri, index, symbols };
    byUri.set(uri, info); byPath.set(path, info);
  }
  const edges: JsonObject[] = [], seen = new Set<string>();
  let omitted = 0;
  const omittedStages = new Map<string, number>();
  const omit = (stage: string): void => { omitted++; omittedStages.set(stage, (omittedStages.get(stage) ?? 0) + 1); };
  const append = (kind: "references" | "calls" | "definitions" | "implements" | "extends" | "type_definition", from: JsonObject, to: JsonObject, source: JsonObject): void => {
    const start = source.start_offset, end = source.end_offset;
    const key = `${kind}\0${from.id}\0${to.id}\0${start}\0${end}`;
    if (seen.has(key)) return;
    if (edges.length >= 20_000) { omit("edge_budget_exceeded"); return; }
    seen.add(key);
    edges.push({ kind, from: { path: from.path, start_offset: Number((from.span as JsonObject).start_offset) },
      to: { path: to.path, start_offset: Number((to.span as JsonObject).start_offset) },
      source_span: { start_offset: start, end_offset: end } });
  };
  for (const raw of input.references as JsonObject[]) {
    const target = nodesById.get(String(raw.symbol_id));
    if (!target || !Array.isArray(raw.locations)) { omit("reference_target_or_locations_invalid"); continue; }
    for (const location of raw.locations as JsonObject[]) {
      const info = documentForUri(String(location.uri), root, byUri, byPath);
      const range = location.range as JsonObject | undefined;
      const start = info?.index.offset(range?.start as JsonObject | undefined);
      const end = info?.index.offset(range?.end as JsonObject | undefined);
      const source = info && start !== undefined ? enclosingSymbol(info.symbols, start) : undefined;
      if (!source || start === undefined || end === undefined || end < start) { omit("reference_location_unmapped"); continue; }
      append("references", source.node, target, { start_offset: start, end_offset: end });
    }
  }
  for (const raw of input.calls as JsonObject[]) {
    const target = nodesById.get(String(raw.symbol_id));
    if (!target) { omit("call_target_or_incoming_invalid"); continue; }
    if (raw.incoming_calls !== undefined && !Array.isArray(raw.incoming_calls)) { omit("call_target_or_incoming_invalid"); continue; }
    for (const incoming of (raw.incoming_calls ?? []) as JsonObject[]) {
      const sourceItem = incoming.from as JsonObject | undefined;
      const sourceDoc = sourceItem && documentForUri(String(sourceItem.uri), root, byUri, byPath);
      const selection = sourceItem?.selectionRange as JsonObject | undefined;
      const sourceOffset = sourceDoc?.index.offset(selection?.start as JsonObject | undefined);
      const source = sourceDoc && sourceOffset !== undefined
        ? sourceDoc.symbols.find(symbol => Number((symbol.node.span as JsonObject).start_offset) === sourceOffset)?.node
          ?? enclosingSymbol(sourceDoc.symbols, sourceOffset)?.node : undefined;
      if (!source || !sourceDoc || !Array.isArray(incoming.fromRanges)) { omit("call_source_unmapped"); continue; }
      for (const range of incoming.fromRanges as JsonObject[]) {
        const start = sourceDoc.index.offset(range.start as JsonObject | undefined);
        const end = sourceDoc.index.offset(range.end as JsonObject | undefined);
        if (start === undefined || end === undefined || end < start) { omit("call_range_invalid"); continue; }
        append("calls", source, target, { start_offset: start, end_offset: end });
      }
    }
    if (raw.outgoing_calls !== undefined && !Array.isArray(raw.outgoing_calls)) { omit("call_source_or_outgoing_invalid"); continue; }
    const sourceDocument = byPath.get(String(target.path));
    if (!sourceDocument) { if ((raw.outgoing_calls as unknown[] | undefined)?.length) omit("call_source_unmapped"); continue; }
    for (const outgoing of (raw.outgoing_calls ?? []) as JsonObject[]) {
      const targetItem = outgoing.to as JsonObject | undefined;
      const targetDocument = targetItem && documentForUri(String(targetItem.uri), root, byUri, byPath);
      const selection = targetItem?.selectionRange as JsonObject | undefined;
      const targetOffset = targetDocument?.index.offset(selection?.start as JsonObject | undefined);
      const callee = targetDocument && targetOffset !== undefined
        ? nodesByPathOffset.get(targetDocument.path)?.get(targetOffset) : undefined;
      if (!callee) { omit("outgoing_call_target_unmapped"); continue; }
      if (!Array.isArray(outgoing.fromRanges)) { omit("outgoing_call_ranges_invalid"); continue; }
      for (const range of outgoing.fromRanges as JsonObject[]) {
        const start = sourceDocument.index.offset(range.start as JsonObject | undefined);
        const end = sourceDocument.index.offset(range.end as JsonObject | undefined);
        if (start === undefined || end === undefined || end < start) { omit("outgoing_call_range_invalid"); continue; }
        append("calls", target, callee, { start_offset: start, end_offset: end });
      }
    }
  }
  for (const raw of (input.implementations as JsonObject[] | undefined) ?? []) {
    const contract = nodesById.get(String(raw.symbol_id));
    if (!contract || !Array.isArray(raw.locations)) { omit("implementation_target_or_locations_invalid"); continue; }
    for (const location of raw.locations as JsonObject[]) {
      const info = documentForUri(String(location.uri), root, byUri, byPath);
      const range = location.range as JsonObject | undefined;
      const start = info?.index.offset(range?.start as JsonObject | undefined);
      const end = info?.index.offset(range?.end as JsonObject | undefined);
      const implementation = info && start !== undefined ? enclosingSymbol(info.symbols, start) : undefined;
      if (!implementation || start === undefined || end === undefined || end < start) { omit("implementation_location_unmapped"); continue; }
      if (implementation.node.id !== contract.id) append("implements", implementation.node, contract, { start_offset: start, end_offset: end });
    }
  }
  for (const raw of (input.type_definitions as JsonObject[] | undefined) ?? []) {
    const source = nodesById.get(String(raw.symbol_id));
    if (!source || !Array.isArray(raw.locations)) { omit("type_definition_source_or_locations_invalid"); continue; }
    const sourceStart = Number((source.span as JsonObject).start_offset), sourceEnd = Number((source.span as JsonObject).end_offset);
    for (const location of raw.locations as JsonObject[]) {
      const info = documentForUri(String(location.uri), root, byUri, byPath);
      const range = location.range as JsonObject | undefined;
      const start = info?.index.offset(range?.start as JsonObject | undefined);
      const target = info && start !== undefined ? enclosingSymbol(info.symbols, start) : undefined;
      if (!target || start === undefined) { omit("type_definition_location_unmapped"); continue; }
      if (target.node.id !== source.id) append("type_definition", source, target.node, { start_offset: sourceStart, end_offset: sourceEnd });
    }
  }
  for (const raw of (input.definitions as JsonObject[] | undefined) ?? []) {
    const reference = raw.reference as JsonObject | undefined;
    if (!reference || !Array.isArray(raw.locations)) { omit("definition_reference_or_locations_invalid"); continue; }
    const sourceInfo = documentForUri(String(reference.uri), root, byUri, byPath);
    if (!sourceInfo) { omit("definition_reference_unmapped"); continue; }
    const sourceRange = reference.range as JsonObject | undefined;
    const sourceStart = sourceInfo?.index.offset(sourceRange?.start as JsonObject | undefined);
    const sourceEnd = sourceInfo?.index.offset(sourceRange?.end as JsonObject | undefined);
    const source = sourceInfo && sourceStart !== undefined ? enclosingSymbol(sourceInfo.symbols, sourceStart)?.node : undefined;
    if (!source || sourceStart === undefined || sourceEnd === undefined || sourceEnd < sourceStart) { omit("definition_reference_unmapped"); continue; }
    const selection = source.span as JsonObject, selectionStart = Number(selection.start_offset), selectionEnd = Number(selection.end_offset);
    const token = sourceInfo.content.slice(sourceStart, sourceEnd), sourceName = String(source.name);
    if (sourceStart === selectionStart && sourceEnd === selectionEnd) continue;
    if (sourceStart >= selectionStart && sourceStart <= selectionEnd + 1
      && (token === sourceName || token === sourceName.replace(/^~/u, ""))) continue;
    for (const location of raw.locations as JsonObject[]) {
      const info = documentForUri(String(location.uri), root, byUri, byPath);
      const range = location.range as JsonObject | undefined;
      const start = info?.index.offset(range?.start as JsonObject | undefined);
      const target = info && start !== undefined ? enclosingSymbol(info.symbols, start) : undefined;
      if (!target || start === undefined) { omit("definition_location_unmapped"); continue; }
      append("definitions", source, target.node, { start_offset: sourceStart, end_offset: sourceEnd });
    }
  }
  for (const raw of (input.type_hierarchy as JsonObject[] | undefined) ?? []) {
    const source = nodesById.get(String(raw.symbol_id));
    if (!source || !Array.isArray(raw.supertypes) || !Array.isArray(raw.subtypes)) { omit("type_hierarchy_source_or_items_invalid"); continue; }
    const sourceSpan = { start_offset: Number((source.span as JsonObject).start_offset), end_offset: Number((source.span as JsonObject).end_offset) };
    const mapItem = (item: JsonObject): JsonObject | undefined => {
      const uri = typeof item.uri === "string" ? item.uri : "", info = documentForUri(uri, root, byUri, byPath);
      const selection = item.selectionRange as JsonObject | undefined;
      const at = info?.index.offset(selection?.start as JsonObject | undefined);
      return info && at !== undefined ? info.symbols.find(symbol => Number((symbol.node.span as JsonObject).start_offset) === at)?.node : undefined;
    };
    for (const item of raw.supertypes as JsonObject[]) {
      const target = mapItem(item);
      if (!target) { omit("type_hierarchy_supertype_unmapped"); continue; }
      if (target.id !== source.id) append("extends", source, target, sourceSpan);
    }
    for (const item of raw.subtypes as JsonObject[]) {
      const subtype = mapItem(item);
      if (!subtype) { omit("type_hierarchy_subtype_unmapped"); continue; }
      if (subtype.id !== source.id) append("extends", subtype, source, { start_offset: Number((subtype.span as JsonObject).start_offset), end_offset: Number((subtype.span as JsonObject).end_offset) });
    }
  }
  return { relations: edges, omitted_relation_count: omitted, omitted_relation_stages: [...omittedStages].map(([stage, count]) => ({ stage, count })) };
}

function flatten(rawSymbols: unknown[], index: TextIndex, nodesAtOffset: Map<number, JsonObject>): SymbolRange[] {
  const result: SymbolRange[] = [];
  const visit = (symbols: unknown[]): void => {
    for (const raw of symbols) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const symbol = raw as JsonObject, selection = (symbol.selectionRange ?? symbol.range) as JsonObject | undefined;
      const range = symbol.range as JsonObject | undefined;
      const selectedAt = index.offset(selection?.start as JsonObject | undefined);
      const start = index.offset(range?.start as JsonObject | undefined);
      const end = index.offset(range?.end as JsonObject | undefined);
      const node = selectedAt === undefined ? undefined : nodesAtOffset.get(selectedAt);
      if (node && start !== undefined && end !== undefined && end >= start) result.push({ node, start, end });
      if (Array.isArray(symbol.children)) visit(symbol.children);
    }
  };
  visit(rawSymbols);
  return result;
}

function documentForUri(uri: string, root: string, byUri: Map<string, DocumentInfo>, byPath: Map<string, DocumentInfo>): DocumentInfo | undefined {
  const exact = byUri.get(uri);
  if (exact) return exact;
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return undefined;
    const path = relative(root, resolve(fileURLToPath(url)));
    if (!path || path === ".." || path.startsWith(`..${sep}`)) return undefined;
    return byPath.get(path);
  } catch { return undefined; }
}

function textIndex(content: string): TextIndex {
  const lines = content.split("\n"), offsets = [0], lengths = lines.map(line => line.replace(/\r$/u, "").length);
  for (let index = 0; index < lines.length - 1; index++) offsets.push(offsets[index]! + lines[index]!.length + 1);
  return { offset(raw) {
    if (!raw || !Number.isInteger(raw.line) || !Number.isInteger(raw.character) || Number(raw.line) < 0 || Number(raw.character) < 0) return undefined;
    const line = Number(raw.line), character = Number(raw.character);
    if (line >= lines.length || character > lengths[line]!) return undefined;
    return offsets[line]! + character;
  } };
}

function enclosingSymbol(symbols: readonly SymbolRange[], offset: number): SymbolRange | undefined {
  return symbols.filter(symbol => symbol.start <= offset && offset <= symbol.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
}
