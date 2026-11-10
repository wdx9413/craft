import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

const DEFINITION_EDGE_KINDS = new Set(["definitions", "references", "calls", "imports", "type_definition"]);

/** Match an indexed relation at a zero-based UTF-16 source offset. */
export function matchDefinitionEdges(edges: readonly JsonObject[], offset: number, limit: number): JsonObject {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Definition offset must be a non-negative safe integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Definition limit must be between 1 and 100");
  const matches = edges.filter(edge => {
    if (!DEFINITION_EDGE_KINDS.has(String(edge.kind)) || typeof edge.to_node_id !== "string" || !edge.to_node_id) return false;
    const range = edge.source_span as JsonObject | undefined;
    const start = range?.start_offset, end = range?.end_offset;
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number(start) >= 0 && Number(end) > Number(start)
      && Number(start) <= offset && offset < Number(end);
  }).slice().sort((left, right) => String(left.to_node_id).localeCompare(String(right.to_node_id))
    || Number((left.source_span as JsonObject).start_offset) - Number((right.source_span as JsonObject).start_offset)
    || String(left.id).localeCompare(String(right.id)));
  const byTarget = new Map<string, JsonObject>();
  for (const edge of matches) if (!byTarget.has(String(edge.to_node_id))) byTarget.set(String(edge.to_node_id), edge);
  const candidates = [...byTarget.values()];
  return { candidates: candidates.slice(0, limit), candidate_count: candidates.length, omitted_count: Math.max(0, candidates.length - limit), ambiguous: candidates.length > 1 };
}
