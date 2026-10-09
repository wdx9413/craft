import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { retrievalTerms } from "../../common/craft-common-base/src/retrieval-terms.ts";

const INTENTS: Record<string, string[]> = {
  登录: ["login", "auth", "session"], 用户: ["user", "account"], 权限: ["permission", "access", "policy"],
  记忆: ["memory"], 知识: ["knowledge", "claim"], 经验: ["experience", "procedure"], 上下文: ["context"],
  版本: ["version", "revision"], 工作流: ["workflow", "graph"], 代码: ["code", "codebase"],
  测试: ["test", "assert", "verify"], 缓存: ["cache"], 检索: ["search", "retrieval"],
  支付: ["payment", "pay"], 订单: ["order"], 数据库: ["database", "store"], 网络: ["http", "request"],
};

export function codeQueryTerms(query: string): string[] {
  return [...new Set([...retrievalTerms(query), ...Object.entries(INTENTS).filter(([word]) => query.includes(word)).flatMap(([, values]) => values)])];
}

/** Bounded lexical seeds and their analyzed dependency neighbourhood. No source bodies. */
export function codeContextCandidates(index: JsonObject, query: string, limit = 100): JsonObject {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Code Context limit must be between 1 and 1000");
  const aliases = Object.entries(INTENTS).filter(([word]) => query.includes(word)).flatMap(([, values]) => values);
  const terms = codeQueryTerms(query);
  const nodes = index.nodes as JsonObject[];
  const ranked = nodes.map(node => ({ node, score: terms.reduce((sum, term) => sum + Number(String(node.name).toLowerCase().includes(term)) * 3 + Number(String(node.path).toLowerCase().includes(term)), 0) }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score || String(a.node.path).localeCompare(String(b.node.path)) || String(a.node.id).localeCompare(String(b.node.id)));
  const edges = (index.edges ?? []) as JsonObject[];
  const seeds = ranked.slice(0, edges.length ? Math.ceil(limit * 2 / 3) : limit);
  const candidates = new Map<string, JsonObject>(seeds.map(row => [String(row.node.id), { ...row.node, score: row.score, selection_reason: "lexical_match" }]));
  const byId = new Map(nodes.map(node => [String(node.id), node]));
  const neighbours = new Map<string, JsonObject>();
  for (const edge of edges) {
    const from = String(edge.from_node_id), to = String(edge.to_node_id);
    for (const [seedId, neighbourId] of [[from, to], [to, from]]) {
      const seed = candidates.get(seedId), neighbour = byId.get(neighbourId);
      if (!seed || !neighbour || candidates.has(neighbourId)) continue;
      const prior = neighbours.get(neighbourId), score = Number(seed.score) / 4;
      if (!prior || Number(prior.score) < score) neighbours.set(neighbourId, { ...neighbour, score, selection_reason: "dependency_neighbour" });
    }
  }
  const orderedNeighbours = [...neighbours.values()].sort((a, b) => Number(b.score) - Number(a.score) || String(a.path).localeCompare(String(b.path)) || String(a.id).localeCompare(String(b.id)));
  const complete = new Map<string, JsonObject>([...candidates.values(), ...orderedNeighbours, ...ranked.slice(seeds.length).map((row): JsonObject => ({ ...row.node, score: row.score, selection_reason: "lexical_match" }))].map(node => [String(node.id), node]));
  const symbols = [...complete.values()].slice(0, limit);
  const selected = new Set(symbols.map(node => String(node.id)));
  const mapEdges = edges.filter(edge => selected.has(String(edge.from_node_id)) && selected.has(String(edge.to_node_id)));
  return { symbols, omitted_count: complete.size - symbols.length, query_aliases: aliases, candidate_only: true,
    repo_map: { node_ids: [...selected], edges: mapEdges.slice(0, limit * 2), omitted_edges: Math.max(0, mapEdges.length - limit * 2), depth: 1, relations_analyzed: edges.length > 0 } };
}
