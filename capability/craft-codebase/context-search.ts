import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { Bm25Index } from "../../common/craft-common-base/src/bm25.ts";
import { retrievalTerms } from "../../common/craft-common-base/src/retrieval-terms.ts";

const INTENTS: Record<string, string[]> = {
  登录: ["login", "auth", "session"], 用户: ["user", "account"], 权限: ["permission", "access", "policy"],
  记忆: ["memory"], 知识: ["knowledge", "claim"], 经验: ["experience", "procedure"], 上下文: ["context"],
  版本: ["version", "revision"], 工作流: ["workflow", "graph"], 代码: ["code", "codebase"],
  测试: ["test", "assert", "verify"], 缓存: ["cache"], 检索: ["search", "retrieval"],
  支付: ["payment", "pay"], 订单: ["order"], 数据库: ["database", "store"], 网络: ["http", "request"],
};

const CODE_TERM_ALIASES: Record<string, readonly string[]> = {
  analysis: ["analyze"], analyzer: ["analyze"], analyzing: ["analyze"], execute: ["run"], fetch: ["get"], obtain: ["get"],
  application: ["app"], initialize: ["init", "get"], ticket: ["token"], profile: ["user", "info"], credentials: ["passport", "token", "ticket"],
  constructor: ["new", "create", "make"], instantiate: ["new", "create"], load: ["get", "query", "read"], lookup: ["find", "get", "query"], query: ["get", "find"], find: ["get", "query"], read: ["get", "load"],
  authentication: ["auth"],
  checker: ["check"], checking: ["check"], collector: ["collect"], collection: ["collect"],
  retrieval: ["search", "find", "candidate"], resolve: ["find", "lookup"], resolving: ["resolve"], records: ["record", "data"], cached: ["cache"],
  enabled: ["open"], counter: ["count"], daily: ["day", "today"], monthly: ["month"],
  server: ["lsp"], callers: ["call"], implementations: ["implement"], definitions: ["definition"],
  routes: ["route"], shards: ["shard"], graph: ["index"], codebase: ["code", "repository", "workspace"],
  分析: ["analyze", "analysis"], 解析: ["parse", "analyze"], 检查: ["check", "analyze"], 语义: ["semantic"],
  索引: ["index"], 仓库: ["repository", "workspace"], 增量: ["incremental"], 重建: ["rebuild", "build"], 规划: ["plan"],
  入口: ["entry", "start"], 查找: ["find", "search"], 收集: ["collect"], 调用: ["call", "caller"], 引用: ["reference", "references"],
  实现: ["implement", "implementation"], 关系: ["relation", "relations"], 候选: ["candidate"], 影响: ["impact"], 依赖: ["dependency", "import"],
  持久化: ["persist", "store"], 分片: ["shard"], 路由: ["route"], 错误: ["error", "failure"], 故障: ["error", "failure"],
  处理: ["handle"], 配置: ["config", "configuration"], 写入: ["write", "persist", "append"],
  对话: ["conversation", "conversations", "dialogue", "chat"], conversation: ["conversations"], dialogue: ["conversation", "chat"],
  combine: ["build", "merge"], merge: ["build", "combine"], simulated: ["simulate", "simulation"], 并发: ["concurrent", "concurrency", "parallel"], 多: ["multiple"],
  启动: ["start", "launch", "run"], 仿真: ["simulation", "simu"], 任务: ["task", "job"], 接口: ["api", "endpoint", "handler"],
};
const ACTION_TERMS = new Set(["analyze", "build", "call", "cancel", "clear", "collect", "combine", "create", "delete", "execute", "fetch", "find", "get", "launch", "list", "logout", "lookup", "merge", "normalize", "persist", "plan", "read", "reload", "remove", "resolve", "run", "search", "simulate", "start", "stop", "update"]);
const SYMBOL_ACTION_TERMS = new Set([...ACTION_TERMS]);
const GENERIC_ACTION_TERMS = new Set(["build", "call", "create", "execute", "fetch", "get", "run", "start"]);
const STRUCTURE_TERMS = new Set(["adapter", "agent", "client", "controller", "engine", "factory", "manager", "processor", "repository", "scheduler", "server", "service", "store", "worker"]);
const STRUCTURAL_DECLARATION_KINDS = new Set(["class", "enum", "interface", "struct", "type"]);
const GENERIC_TASK_TERMS = new Set([...ACTION_TERMS, "api", "endpoint", "handler", "task", "job", "http", "multiple", "concurrent", "concurrency", "parallel"]);
const GENERIC_SYMBOL_IDENTIFIERS = new Set([...GENERIC_TASK_TERMS, "a", "after", "any", "before", "by", "conversation", "extract", "file", "for", "from", "id", "import", "in", "into", "is", "it", "module", "name", "of", "on", "or", "path", "request", "result", "the", "to", "turn", "type", "valid", "value", "with"]);

function identifierTerms(value: string): string[] {
  const expanded = value.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2").replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_./\\-]+/gu, " ");
  return [...new Set([...retrievalTerms(value), ...retrievalTerms(expanded)])];
}

export function codeQueryTerms(query: string): string[] {
  const terms = identifierTerms(query);
  const aliases = terms.flatMap(term => CODE_TERM_ALIASES[term] ?? []);
  const intents = Object.entries(INTENTS).filter(([word]) => query.includes(word)).flatMap(([, values]) => values);
  return [...new Set([...terms, ...aliases, ...intents])];
}

/** Reusable BM25 corpus for a verified immutable snapshot. */
export class CodeSymbolSearchIndex {
  readonly #index = new Bm25Index();
  readonly #byId = new Map<string, JsonObject>();
  readonly #nameTermsById = new Map<string, ReadonlySet<string>>();
  readonly #pathTermsById = new Map<string, ReadonlySet<string>>();
  readonly #ownerTermsById = new Map<string, ReadonlySet<string>>();
  readonly #contextTermsById = new Map<string, ReadonlySet<string>>();
  readonly #partialNamesByTrigram = new Map<string, Set<string>>();
  readonly #methodNames = new Set<string>();

  constructor(nodes: readonly JsonObject[], searchContext: ReadonlyMap<string, string> = new Map(),
    enclosingTypeContext: ReadonlyMap<string, string> = new Map()) {
    for (const node of nodes) {
      const id = String(node.id ?? "");
      if (!id || this.#byId.has(id)) continue;
      const name = String(node.name ?? "");
      const path = String(node.path ?? "");
      const context = searchContext.get(id) ?? "";
      const nameTerms = identifierTerms(name), pathTerms = identifierTerms(path);
      const contextTerms = identifierTerms(context);
      this.#index.add(id, [...nameTerms, ...pathTerms, identifierTerms(context), String(node.kind ?? ""), String(node.declaration_kind ?? ""), String(node.language ?? "")].join(" "));
      this.#byId.set(id, node);
      this.#nameTermsById.set(id, new Set(nameTerms));
      this.#pathTermsById.set(id, new Set(pathTerms));
      this.#ownerTermsById.set(id, new Set(identifierTerms(enclosingTypeContext.get(id) ?? "")));
      this.#contextTermsById.set(id, new Set(contextTerms));
      if (node.declaration_kind === "method") this.#methodNames.add(name.toLowerCase());
      const characters = [...name.toLowerCase()];
      for (let offset = 0; offset + 3 <= characters.length; offset++) {
        const trigram = characters.slice(offset, offset + 3).join("");
        const matches = this.#partialNamesByTrigram.get(trigram) ?? new Set<string>();
        matches.add(id);
        this.#partialNamesByTrigram.set(trigram, matches);
      }
    }
  }

  rank(query: string, limit: number): Array<{ node: JsonObject; score: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Code symbol limit must be a positive integer");
    const queryText = query.trim();
    if (!queryText) return [];
    const terms = codeQueryTerms(queryText);
    const bm25 = this.#index.score(terms.join(" "));
    const queryTerms = new Set(terms);
    const queryActionTerms = new Set(terms.filter(term => SYMBOL_ACTION_TERMS.has(term)));
    const queryNameTerms = identifierTerms(queryText);
    const queryStructureTerms = new Set([...queryTerms].filter(term => STRUCTURE_TERMS.has(term)));
    const queryIdentifiers = (queryText.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? []);
    const queryIdentifierNames = new Set(queryIdentifiers.map(term => term.toLowerCase()));
    const queryCodeIdentifiers = new Set(queryIdentifiers.filter(term => /[a-z][A-Z]/u.test(term)).map(term => term.toLowerCase()));
    const explicitMethodMentioned = [...queryCodeIdentifiers].some(name => this.#methodNames.has(name));
    const queryTypeIdentifiers = new Set(queryIdentifiers.filter(term => /^[A-Z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*$/u.test(term)));
    const explicitTerms = new Set(queryNameTerms);
    const analyzerIntent = identifierTerms(queryText).includes("analyzer");
    const actionIntent = terms.some(term => ACTION_TERMS.has(term));
    const lowered = queryText.toLowerCase();
    const results = new Map(bm25.map(hit => {
      const node = this.#byId.get(hit.id)!;
      const name = typeof node.name === "string" ? node.name.toLowerCase() : "";
      const nameTerms = this.#nameTermsById.get(hit.id)!;
      const pathTerms = this.#pathTermsById.get(hit.id)!;
      const ownerTerms = this.#ownerTermsById.get(hit.id)!;
      const ticketNameMatch = queryNameTerms.includes("ticket") && nameTerms.has("ticket") ? 112 : 0;
      const contextMatches = [...queryTerms].filter(term => !GENERIC_TASK_TERMS.has(term)
        && !nameTerms.has(term) && !pathTerms.has(term) && this.#contextTermsById.get(hit.id)!.has(term)).length;
      const nameMatches = [...queryTerms].filter(term => nameTerms.has(term)).length;
      const pathMatches = [...queryTerms].filter(term => pathTerms.has(term)).length;
      const domainMatches = [...queryTerms].filter(term => !explicitTerms.has(term) && !GENERIC_TASK_TERMS.has(term) && nameTerms.has(term)).length;
      const ownerDomainMatches = [...queryTerms].filter(term => !GENERIC_TASK_TERMS.has(term)
        && !nameTerms.has(term) && !pathTerms.has(term) && ownerTerms.has(term)).length;
      const ownerDomainMatch = ownerDomainMatches * 18;
      const declarationKind = String(node.declaration_kind ?? "");
      const genericNamePenalty = GENERIC_SYMBOL_IDENTIFIERS.has(name)
        && queryNameTerms.some(term => !GENERIC_SYMBOL_IDENTIFIERS.has(term)) ? 88 : 0;
      const compositeNamePenalty = name.length > 64 || /[\r\n{}]/u.test(String(node.name ?? "")) ? 120 : 0;
      const structureMatch = !explicitMethodMentioned && STRUCTURAL_DECLARATION_KINDS.has(declarationKind)
        && [...queryStructureTerms].some(term => nameTerms.has(term)) ? 24 : 0;
      const declarationMatch = (terms.includes("function") || analyzerIntent) && declarationKind === "function" ? 24 : 0;
      const actionMatch = actionIntent && ["function", "method"].includes(declarationKind) ? 36 : 0;
      const exactIdentifierMatch = queryCodeIdentifiers.has(name)
        ? 44 + (declarationKind === "method" ? 16 : 0) : 0;
      const exactWordMatch = queryIdentifierNames.has(name) && !GENERIC_SYMBOL_IDENTIFIERS.has(name) && !queryCodeIdentifiers.has(name)
        ? 44 + (declarationKind === "method" ? 16 : 0) : 0;
      const namedMethodMatch = declarationKind === "method" && queryTypeIdentifiers.size > 0 && queryCodeIdentifiers.has(name) ? 48 : 0;
      const constructorTerms = queryNameTerms.filter(term => !GENERIC_TASK_TERMS.has(term) && nameTerms.has(term)).length;
      const constructorMatch = queryIdentifierNames.has("constructor") && declarationKind === "function"
        && name.startsWith("new") && constructorTerms >= 2 ? 88 : 0;
      const matchedActionTerms = [...queryTerms].filter(term => ACTION_TERMS.has(term) && nameTerms.has(term));
      const distinctiveNameMatches = [...queryTerms].filter(term => !GENERIC_TASK_TERMS.has(term) && nameTerms.has(term)).length;
      const namedActionMatch = actionIntent && ["function", "method"].includes(declarationKind)
        && matchedActionTerms.some(term => !GENERIC_ACTION_TERMS.has(term) || distinctiveNameMatches >= 2) ? 36 : 0;
      const fieldMatch = nameMatches * 25 + pathMatches * 12;
      const testPath = /(?:^|\/)(?:tests?|specs?)(?:\/|$)|(?:^|[._-])(?:test|spec)(?:[._-]|$)/u.test(String(node.path ?? ""));
      const testPathPenalty = testPath && !queryTerms.has("test") ? 88 : 0;
      const symbolActionTerms = [...nameTerms].filter(term => SYMBOL_ACTION_TERMS.has(term));
      const actionConflictPenalty = queryActionTerms.size > 0 && symbolActionTerms.length > 0
        && !symbolActionTerms.some(term => queryActionTerms.has(term)) ? 32 : 0;
      return [hit.id, { node, score: hit.score + fieldMatch + domainMatches * 30 + ownerDomainMatch + contextMatches * 28 + structureMatch + declarationMatch + actionMatch + exactIdentifierMatch + exactWordMatch + namedMethodMatch + constructorMatch + namedActionMatch + ticketNameMatch - genericNamePenalty - compositeNamePenalty - testPathPenalty
        - actionConflictPenalty + (name === lowered ? 20 : name.startsWith(lowered) ? 5 : name.includes(lowered) ? 2 : 0) }] as const;
    }));
    // Preserve partial-name discovery such as `ensureRepo` -> `ensureRepository`.
    const characters = [...lowered];
    const partialCandidates = characters.length >= 3
      ? [...(this.#partialNamesByTrigram.get(characters.slice(0, 3).join("")) ?? [])].map(id => [id, this.#byId.get(id)!] as const)
      : [...this.#byId.entries()];
    for (const [id, node] of partialCandidates) {
      const name = String(node.name ?? "").toLowerCase();
      if (!results.has(id) && name.includes(lowered)) results.set(id, { node, score: 1 });
    }
    return [...results.values()].sort((a, b) => b.score - a.score || String(a.node.path).localeCompare(String(b.node.path)) || String(a.node.id).localeCompare(String(b.node.id))).slice(0, limit);
  }
}

/** BM25 symbol retrieval with stable exact-name and partial-name boosts. */
export function rankCodeSymbols(nodes: readonly JsonObject[], query: string, limit: number): Array<{ node: JsonObject; score: number }> {
  return new CodeSymbolSearchIndex(nodes).rank(query, limit);
}

/** Bounded lexical seeds and their analyzed dependency neighbourhood. No source bodies. */
export function codeContextCandidates(index: JsonObject, query: string, limit = 100): JsonObject {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Code Context limit must be between 1 and 1000");
  const aliases = Object.entries(INTENTS).filter(([word]) => query.includes(word)).flatMap(([, values]) => values);
  const nodes = index.nodes as JsonObject[];
  const ranked = rankCodeSymbols(nodes, query, Math.max(1, nodes.length)).filter(row => row.score > 0);
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
  const complete = new Map<string, JsonObject>([...candidates.values(), ...orderedNeighbours, ...ranked.map((row): JsonObject => ({ ...row.node, score: row.score, selection_reason: "lexical_match" }))].map(node => [String(node.id), node]));
  const ordered = [...complete.values()].sort((a, b) => Number(b.score) - Number(a.score)
    || Number(a.selection_reason === "dependency_neighbour") - Number(b.selection_reason === "dependency_neighbour")
    || String(a.path).localeCompare(String(b.path)) || String(a.id).localeCompare(String(b.id)));
  const symbols = ordered.slice(0, limit);
  const selected = new Set(symbols.map(node => String(node.id)));
  const mapEdges = edges.filter(edge => selected.has(String(edge.from_node_id)) && selected.has(String(edge.to_node_id)));
  return { symbols, omitted_count: complete.size - symbols.length, query_aliases: aliases, candidate_only: true,
    repo_map: { node_ids: [...selected], edges: mapEdges.slice(0, limit * 2), omitted_edges: Math.max(0, mapEdges.length - limit * 2), depth: 1, relations_analyzed: edges.length > 0 } };
}
