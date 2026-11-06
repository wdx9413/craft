import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

const MAX_NODES = 60_000;
// Preserve large first-party repositories such as Craft (over 170k emitted
// relations) while keeping graph publication behind explicit byte ceilings.
const MAX_EDGES = 300_000;
const MAX_CHARS = 64_000_000;

/** Keep each language represented while producing one importable bounded graph. */
export function combineLanguageAnalyses(analyses: readonly JsonObject[], diagnostics: readonly JsonObject[] = []): JsonObject | undefined {
  const usable = analyses.filter(item => Array.isArray(item.nodes) && Array.isArray(item.edges));
  if (!usable.length) return undefined;
  const fileNodes = usable.flatMap(item => (item.nodes as JsonObject[]).filter(node => node.kind === "file"));
  const symbols = usable.map(item => (item.nodes as JsonObject[]).filter(node => node.kind !== "file"));
  const nodes: JsonObject[] = [];
  let chars = 512;
  let omittedNodes = 0;
  const addNode = (node: JsonObject): boolean => {
    const size = Buffer.byteLength(JSON.stringify(node), "utf8") + (nodes.length ? 1 : 0);
    if (nodes.length >= MAX_NODES || chars + size > MAX_CHARS) { omittedNodes++; return false; }
    nodes.push(node); chars += size; return true;
  };
  for (const node of fileNodes) if (!addNode(node)) throw new Error("Required file nodes exceed combined analysis budget");
  const maxRounds = Math.max(0, ...symbols.map(items => items.length));
  for (let round = 0; round < maxRounds; round++) for (const items of symbols) {
    const node = items[round]; if (node) addNode(node);
  }
  const nodeIds = new Set(nodes.map(node => String(node.id)));
  const edges: JsonObject[] = [];
  let omittedEdges = 0, unresolvedEndpointEdges = 0, budgetOmittedEdges = 0;
  const unresolvedEndpointKinds: Record<string, number> = {}, budgetOmittedKinds: Record<string, number> = {};
  const countKind = (counts: Record<string, number>, edge: JsonObject): void => {
    const kind = String(edge.kind ?? "unknown"); counts[kind] = (counts[kind] ?? 0) + 1;
  };
  const edgeGroups = usable.map(item => item.edges as JsonObject[]);
  const maxEdges = Math.max(0, ...edgeGroups.map(items => items.length));
  for (let round = 0; round < maxEdges; round++) for (const items of edgeGroups) {
    const edge = items[round]; if (!edge) continue;
    if (!nodeIds.has(String(edge.from_node_id)) || !nodeIds.has(String(edge.to_node_id))) {
      omittedEdges++; unresolvedEndpointEdges++; countKind(unresolvedEndpointKinds, edge); continue;
    }
    const size = Buffer.byteLength(JSON.stringify(edge), "utf8") + (edges.length ? 1 : 0);
    if (edges.length >= MAX_EDGES || chars + size > MAX_CHARS) {
      omittedEdges++; budgetOmittedEdges++; countKind(budgetOmittedKinds, edge); continue;
    }
    edges.push(edge); chars += size;
  }
  const componentDiagnostics = usable.map(item => ({ analyzer: item.analyzer, diagnostics: item.diagnostics ?? {} }));
  const combinedDiagnostics = { languages: componentDiagnostics, degraded_languages: [...diagnostics], omitted_nodes: omittedNodes, omitted_edges: omittedEdges,
    unresolved_endpoint_edges: unresolvedEndpointEdges, unresolved_endpoint_edges_by_kind: unresolvedEndpointKinds,
    budget_omitted_edges: budgetOmittedEdges, budget_omitted_edges_by_kind: budgetOmittedKinds,
    budget_limited: omittedNodes > 0 || budgetOmittedEdges > 0 || usable.some(item => (item.diagnostics as JsonObject | undefined)?.budget_limited === true) };
  const analyzerNames = [...new Set(usable.map(item => String(item.analyzer)))].sort();
  const versions = [...new Set(usable.map(item => String(item.analyzer_version)))].sort();
  return { format: "craft-static-analysis-v1", analyzer: analyzerNames.length === 1 ? analyzerNames[0]! : "multi-language-static",
    analyzer_version: versions.join("+"), nodes, edges, diagnostics: combinedDiagnostics };
}
