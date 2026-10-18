import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bm25Index } from "../../common/craft-common-base/src/bm25.ts";
import { retrievalTerms } from "../../common/craft-common-base/src/retrieval-terms.ts";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";
import { scoreImpactSet, summarizeImpactCases, type ImpactCaseScore } from "./codebase-impact-evaluation.ts";
import { summarizeRetrievalByLanguage } from "./codebase-retrieval-strata.ts";
import { readCodebaseEvaluationSymbolNodes } from "./codebase-evaluation-graph.ts";
import { assertEvaluationStateStable, checkpointManifestDigest, digestEvaluationMaterial, readGitEvaluationState } from "./codebase-evaluation-provenance.ts";
import { CODEBASE_LSP_CONFIG } from "../../capability/craft-codebase/lsp-config.ts";

type RetrievalCase = { query: string; path: string; name: string; language?: string };
type CallGraphCase = { target_path: string; target_name: string; callers: Array<{ path: string; name: string }>;
  impact_callers?: Array<{ path: string; name: string }> };
type ImpactCase = { target_path: string; target_name: string; direction: "incoming" | "outgoing" | "both"; relation_kind: string; max_depth: number; nodes: Array<{ path: string; name: string }> };
type EvaluationSuite = { cases: RetrievalCase[]; call_graph_cases?: CallGraphCase[]; impact_cases?: ImpactCase[] };

/** Curated task-shaped queries with source-reviewed exact symbol targets. */
const defaultCases: RetrievalCase[] = [
  { query: "python incremental plan", path: "capability/craft-codebase/python-incremental.ts", name: "planPythonIncremental" },
  { query: "Python 仓库增量重建怎么规划", path: "capability/craft-codebase/python-incremental.ts", name: "planPythonIncremental", language: "zh-en" },
  { query: "TypeScript semantic checker analyzer", path: "capability/craft-codebase/typescript-analysis.ts", name: "analyzeTypeScript" },
  { query: "TypeScript 语义检查器如何分析", path: "capability/craft-codebase/typescript-analysis.ts", name: "analyzeTypeScript", language: "zh-en" },
  { query: "LSP relation collector", path: "capability/craft-codebase/lsp-relations.ts", name: "collectLspRelations" },
  { query: "LSP 关系收集器", path: "capability/craft-codebase/lsp-relations.ts", name: "collectLspRelations", language: "zh-en" },
  { query: "Codebase context candidate retrieval", path: "capability/craft-codebase/context-search.ts", name: "codeContextCandidates" },
  { query: "查找仓库代码上下文候选", path: "capability/craft-codebase/context-search.ts", name: "codeContextCandidates", language: "zh-en" },
  { query: "workspace create immutable checkpoint", path: "core/workspace.ts", name: "checkpoint" },
  { query: "persist graph shards and routes", path: "capability/craft-codebase/codebase-index.ts", name: "persistIndex" },
  { query: "MCP Codebase callers find", path: "core/application/use-cases/codebase.ts", name: "codebaseCallersFind" },
  { query: "Python analyzer analyze checkpoint", path: "capability/craft-codebase/python-analysis.ts", name: "analyzePythonCheckpoint" },
  { query: "Python import module path resolution", path: "capability/craft-codebase/analyzers/analyze-python.py", name: "_module_path", language: "python" },
  { query: "resolve definition at source offset", path: "capability/craft-codebase/codebase-index.ts", name: "findDefinition" },
  { query: "start language server snapshot analysis", path: "capability/craft-codebase/lsp-stdio-client.ts", name: "analyzeLspSnapshot" },
];
/** Direct production call-site goldens, reviewed against the immutable source paths below. */
const defaultCallGraphCases: CallGraphCase[] = [
  { target_path: "core/application/use-cases/codebase.ts", target_name: "codebaseSymbolRead",
    callers: [{ path: "core/application/actions/action-handlers.ts", name: "createActionHandlers" }] },
  { target_path: "core/application/use-cases/codebase.ts", target_name: "codebaseRepositoryEnsure",
    callers: [{ path: "core/application/actions/action-handlers.ts", name: "createActionHandlers" }] },
  { target_path: "capability/craft-codebase/codebase-index.ts", target_name: "persistIndex",
    callers: [{ path: "capability/craft-codebase/codebase-index.ts", name: "build" },
      { path: "capability/craft-codebase/codebase-index.ts", name: "importAnalysis" }] },
  { target_path: "capability/craft-codebase/lsp-relations.ts", target_name: "collectLspRelations",
    callers: [{ path: "capability/craft-codebase/lsp-stdio-client.ts", name: "analyzeLspSnapshot" }] },
  { target_path: "capability/craft-codebase/python-analysis.ts", target_name: "analyzePythonCheckpoint",
    callers: [{ path: "capability/craft-codebase/repository-onboarding.ts", name: "ensureRepositoryAttempt" }] },
  { target_path: "capability/craft-codebase/repository-onboarding.ts", target_name: "ensureRepositoryAttempt",
    callers: [{ path: "capability/craft-codebase/repository-onboarding.ts", name: "ensureRepository" },
      { path: "capability/craft-codebase/repository-onboarding.ts", name: "ensureRepositoryAttempt" }],
    impact_callers: [{ path: "capability/craft-codebase/repository-onboarding.ts", name: "ensureRepository" }] },
  { target_path: "capability/craft-codebase/analyzers/analyze-python.py", target_name: "_module_path",
    callers: [{ path: "capability/craft-codebase/analyzers/analyze-python.py", name: "analyze_with_ast" }] },
];
const defaultImpactCases: ImpactCase[] = [
  { target_path: "capability/craft-codebase/codebase-index.ts", target_name: "persistIndex", direction: "incoming", relation_kind: "calls", max_depth: 2,
    nodes: [
      { path: "capability/craft-codebase/codebase-index.ts", name: "build" },
      { path: "capability/craft-codebase/codebase-index.ts", name: "importAnalysis" },
      { path: "core/application/use-cases/codebase.ts", name: "installCodebaseMethods" },
    ] },
];

function loadEvaluationSuite(content: string): EvaluationSuite {
  const raw: unknown = JSON.parse(content);
  assert.ok(raw !== null && typeof raw === "object" && !Array.isArray(raw), "evaluation suite must be a JSON object");
  const suite = raw as Partial<EvaluationSuite>;
  assert.ok(Array.isArray(suite.cases) && suite.cases.length > 0, "evaluation suite must include at least one retrieval case");
  for (const item of suite.cases) {
    assert.ok(item !== null && typeof item === "object" && typeof item.query === "string" && item.query.trim().length > 0
      && typeof item.path === "string" && item.path.length > 0 && typeof item.name === "string" && item.name.length > 0,
    "each retrieval case needs a query, repository-relative path, and exact symbol name");
    assert.ok(item.language === undefined || typeof item.language === "string", "retrieval case language must be a string when provided");
  }
  assert.ok(suite.call_graph_cases === undefined || Array.isArray(suite.call_graph_cases), "call_graph_cases must be an array when provided");
  for (const item of suite.call_graph_cases ?? []) {
    assert.ok(item !== null && typeof item === "object" && typeof item.target_path === "string" && item.target_path.length > 0
      && typeof item.target_name === "string" && item.target_name.length > 0 && Array.isArray(item.callers),
    "each call graph case needs an exact target and caller list");
    for (const caller of item.callers) assert.ok(caller !== null && typeof caller === "object"
      && typeof caller.path === "string" && caller.path.length > 0 && typeof caller.name === "string" && caller.name.length > 0,
    "each expected caller needs a repository-relative path and exact symbol name");
    assert.ok(item.impact_callers === undefined || Array.isArray(item.impact_callers),
      "impact_callers must be an array when provided");
    for (const caller of item.impact_callers ?? []) assert.ok(caller !== null && typeof caller === "object"
      && typeof caller.path === "string" && caller.path.length > 0 && typeof caller.name === "string" && caller.name.length > 0,
    "each expected impact caller needs a repository-relative path and exact symbol name");
  }
  assert.ok(suite.impact_cases === undefined || Array.isArray(suite.impact_cases), "impact_cases must be an array when provided");
  for (const item of suite.impact_cases ?? []) {
    assert.ok(item !== null && typeof item === "object" && typeof item.target_path === "string" && item.target_path.length > 0
      && typeof item.target_name === "string" && item.target_name.length > 0
      && (item.direction === "incoming" || item.direction === "outgoing" || item.direction === "both")
      && typeof item.relation_kind === "string" && ["calls", "imports", "references", "definitions", "implements", "extends", "type_definition"].includes(item.relation_kind)
      && Number.isInteger(item.max_depth) && item.max_depth >= 1 && item.max_depth <= 5 && Array.isArray(item.nodes) && item.nodes.length > 0,
    "each impact case needs a target, supported direction and relation, depth 1-5, and expected nodes");
    for (const node of item.nodes) assert.ok(node !== null && typeof node === "object"
      && typeof node.path === "string" && node.path.length > 0 && typeof node.name === "string" && node.name.length > 0,
    "each expected impact node needs a repository-relative path and exact symbol name");
  }
  return suite as EvaluationSuite;
}
const intentAliases: Record<string, string[]> = { 登录: ["login", "auth", "session"], 用户: ["user", "account"], 权限: ["permission", "access", "policy"],
  记忆: ["memory"], 知识: ["knowledge", "claim"], 经验: ["experience", "procedure"], 上下文: ["context"],
  版本: ["version", "revision"], 工作流: ["workflow", "graph"], 代码: ["code", "codebase"], 测试: ["test", "assert", "verify"],
  缓存: ["cache"], 检索: ["search", "retrieval"], 支付: ["payment", "pay"], 订单: ["order"], 数据库: ["database", "store"], 网络: ["http", "request"] };

function baselineIndex(nodes: readonly Record<string, unknown>[]) {
  const index = new Bm25Index(), byId = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const id = String(node.id ?? ""); if (!id || byId.has(id)) continue;
    const name = String(node.name ?? ""), path = String(node.path ?? "");
    const expandedName = name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2");
    const expandedPath = path.replace(/[._/\\-]+/gu, " ");
    index.add(id, `${name} ${expandedName} ${path} ${expandedPath} ${String(node.kind ?? "")} ${String(node.language ?? "")}`);
    byId.set(id, node);
  }
  return (query: string, limit: number): Array<{ node: Record<string, unknown>; score: number }> => {
    const aliases = Object.entries(intentAliases).filter(([word]) => query.includes(word)).flatMap(([, values]) => values);
    const hits = index.score([...new Set([...retrievalTerms(query), ...aliases])].join(" "));
    return hits.map(hit => {
      const node = byId.get(hit.id)!; const name = String(node.name ?? "").toLowerCase(), lowered = query.toLowerCase();
      return { node, score: hit.score + (name === lowered ? 20 : name.startsWith(lowered) ? 5 : name.includes(lowered) ? 2 : 0) };
    }).sort((a, b) => b.score - a.score || String(a.node.path).localeCompare(String(b.node.path)) || String(a.node.id).localeCompare(String(b.node.id))).slice(0, limit);
  };
}

const args = process.argv.slice(2);
const suiteOption = args.indexOf("--suite");
const suitePath = suiteOption >= 0 ? args[suiteOption + 1] : undefined;
assert.ok(suiteOption < 0 || (suitePath && suitePath.length > 0), "--suite requires a JSON suite path");
if (suiteOption >= 0) args.splice(suiteOption, 2);
const lspConfigOption = args.indexOf("--lsp-config");
const lspConfigPath = lspConfigOption >= 0 ? args[lspConfigOption + 1] : undefined;
assert.ok(lspConfigOption < 0 || (lspConfigPath && lspConfigPath.length > 0), "--lsp-config requires a trusted LSP config path");
if (lspConfigOption >= 0) args.splice(lspConfigOption, 2);
const suiteMaterial = suitePath ? readFileSync(resolve(suitePath)) : undefined;
const lspConfigMaterial = lspConfigPath ? readFileSync(resolve(lspConfigPath)) : undefined;
const suite = suiteMaterial ? loadEvaluationSuite(suiteMaterial.toString("utf8")) : undefined;
const cases = suite?.cases ?? defaultCases;
const callGraphCases = suite?.call_graph_cases ?? defaultCallGraphCases;
const impactCases = suite ? suite.impact_cases ?? [] : defaultImpactCases;
const temporaryRoot = mkdtempSync(join(tmpdir(), "craft-codebase-retrieval-eval-"));
const store = await new CraftStore(craftPaths(join(temporaryRoot, "data"))).open();
try {
  if (lspConfigMaterial) writeFileSync(join(store.paths.configDir, CODEBASE_LSP_CONFIG), lspConfigMaterial, { flag: "wx" });
  const service = new CraftService(store);
  const repository = resolve(args[0] ?? process.cwd());
  const craftRoot = resolve(import.meta.dirname, "../..");
  const craftStateBefore = readGitEvaluationState(craftRoot);
  const repositoryStateBefore = readGitEvaluationState(repository);
  assert.ok(craftStateBefore.revision, "Craft checkout must have Git provenance for evaluation");
  assert.ok(repositoryStateBefore.revision, "evaluation repository must have Git provenance");
  const previousEntry = process.argv[1];
  process.argv[1] = resolve(import.meta.dirname, "../../bin/craft-mcp.ts");
  let ready: ReturnType<typeof service.codebaseRepositoryEnsure>;
  try { ready = service.codebaseRepositoryEnsure({ project_root: repository, index_depth: "semantic" }); }
  finally { process.argv[1] = previousEntry!; }
  assert.equal(ready.status, "ready", "evaluation repository must have a ready semantic index");
  const indexRecord = store.get("codebase_index", String(ready.index_id));
  const nodes = readCodebaseEvaluationSymbolNodes(store, repository, String(ready.workspace_id), indexRecord);
  const callGraphRows = callGraphCases.map(item => {
    const targets = service.codebaseSymbolFind({ workspace_id: ready.workspace_id, index_id: ready.index_id, query: item.target_name, limit: 100 })
      .symbols as Array<{ readonly id: string; readonly name: string; readonly path: string }>;
    const target = targets.find(symbol => symbol.path === item.target_path && symbol.name === item.target_name);
    const observed = new Set(target ? (service.codebaseCallersFind({ workspace_id: ready.workspace_id, index_id: ready.index_id,
      symbol_id: target.id, limit: 100 }).callers as Array<{ readonly caller: { readonly name: string; readonly path: string } }>).
      map(({ caller }) => `${caller.path}\u0000${caller.name}`).filter(key => !/^(?:tests|scripts|plugins)\//u.test(key)) : []);
    const impactObserved = new Set(target ? (service.codebaseImpactQuery({ workspace_id: ready.workspace_id, index_id: ready.index_id,
      node_id: target.id, direction: "incoming", relation_kind: "calls", max_depth: 1, limit: 100 }).nodes as Array<{ readonly id: string; readonly name: string; readonly path: string }>).
      filter(node => node.id !== target.id && !/^(?:tests|scripts|plugins)\//u.test(node.path))
      .map(node => `${node.path}\u0000${node.name}`) : []);
    const expected = new Set(item.callers.map(caller => `${caller.path}\u0000${caller.name}`));
    const expectedImpact = new Set((item.impact_callers ?? item.callers).map(caller => `${caller.path}\u0000${caller.name}`));
    const truePositives = [...observed].filter(key => expected.has(key)).length;
    const impactTruePositives = [...impactObserved].filter(key => expectedImpact.has(key)).length;
    return { target_path: item.target_path, target_name: item.target_name, target_found: target !== undefined,
      expected_callers: [...expected].sort(), observed_callers: [...observed].sort(),
      expected_impact_callers: [...expectedImpact].sort(),
      true_positives: truePositives, false_positives: observed.size - truePositives, false_negatives: expected.size - truePositives,
      impact_observed_callers: [...impactObserved].sort(), impact_true_positives: impactTruePositives,
      impact_false_positives: impactObserved.size - impactTruePositives, impact_false_negatives: expectedImpact.size - impactTruePositives };
  });
  const graphTruePositives = callGraphRows.reduce((sum, row) => sum + row.true_positives, 0);
  const graphFalsePositives = callGraphRows.reduce((sum, row) => sum + row.false_positives, 0);
  const graphFalseNegatives = callGraphRows.reduce((sum, row) => sum + row.false_negatives, 0);
  const graphPrecision = graphTruePositives / (graphTruePositives + graphFalsePositives);
  const graphRecall = graphTruePositives / (graphTruePositives + graphFalseNegatives);
  const impactTruePositives = callGraphRows.reduce((sum, row) => sum + row.impact_true_positives, 0);
  const impactFalsePositives = callGraphRows.reduce((sum, row) => sum + row.impact_false_positives, 0);
  const impactFalseNegatives = callGraphRows.reduce((sum, row) => sum + row.impact_false_negatives, 0);
  const impactPrecision = impactTruePositives / (impactTruePositives + impactFalsePositives);
  const impactRecall = impactTruePositives / (impactTruePositives + impactFalseNegatives);
  const multiHopImpactCases: Array<ImpactCaseScore & { target_path: string; target_name: string; max_depth: number }> = impactCases.map(item => {
    const targets = service.codebaseSymbolFind({ workspace_id: ready.workspace_id, index_id: ready.index_id, query: item.target_name, limit: 100 })
      .symbols as Array<{ readonly id: string; readonly name: string; readonly path: string }>;
    const target = targets.find(symbol => symbol.path === item.target_path && symbol.name === item.target_name);
    const impact = target ? service.codebaseImpactQuery({ workspace_id: ready.workspace_id, index_id: ready.index_id,
      node_id: target.id, direction: item.direction, relation_kind: item.relation_kind, max_depth: item.max_depth, limit: 100 }) : undefined;
    const nodes = (impact?.nodes ?? []) as Array<{ readonly id: string; readonly name: string; readonly path: string }>;
    const observed = nodes.filter(node => node.id !== target?.id && !/^(?:tests|scripts|plugins)\//u.test(node.path))
      .map(node => `${node.path}\u0000${node.name}`);
    const impactNodeById = new Map(nodes.map(node => [node.id, node]));
    const observedEdges = ((impact?.edges ?? []) as Array<{ readonly kind: string; readonly from_node_id: string; readonly to_node_id: string }>).map(edge => {
      const from = impactNodeById.get(edge.from_node_id), to = impactNodeById.get(edge.to_node_id);
      return { kind: edge.kind, from: from ? { path: from.path, name: from.name } : null, to: to ? { path: to.path, name: to.name } : null };
    });
    const expected = item.nodes.map(node => `${node.path}\u0000${node.name}`);
    return { target_path: item.target_path, target_name: item.target_name, max_depth: item.max_depth,
      ...scoreImpactSet(expected, observed), observed_edges: observedEdges, target_found: target !== undefined, truncated: impact?.truncated === true };
  });
  const multiHopImpactSummary = summarizeImpactCases(multiHopImpactCases);
  const rankBaseline = baselineIndex(nodes);
  const checkpointRecord = store.get("workspace_checkpoint", String(ready.checkpoint_id));
  const analysisRecord = indexRecord.analysis as Record<string, unknown>;
  const craftRevision = assertEvaluationStateStable("Craft checkout", craftStateBefore, readGitEvaluationState(craftRoot));
  const repositoryRevision = assertEvaluationStateStable("evaluation repository", repositoryStateBefore, readGitEvaluationState(repository));
  const evaluationSuiteMaterial = suiteMaterial ?? JSON.stringify({ cases, callGraphCases, impactCases });
  const provenance = {
    repository_revision: repositoryRevision,
    craft_revision: craftRevision,
    evaluation_suite_sha256: digestEvaluationMaterial(evaluationSuiteMaterial),
    checkpoint_id: ready.checkpoint_id,
    checkpoint_manifest_digest: checkpointManifestDigest(checkpointRecord.entries as Record<string, unknown>[]),
    graph_manifest_digest: String(indexRecord.graph_manifest_digest ?? ""),
    analyzer: analysisRecord.analyzer ?? null,
    analyzer_version: analysisRecord.analyzer_version ?? null,
    relation_analysis: analysisRecord.relation_analysis ?? null,
    lsp_config_sha256: lspConfigMaterial ? digestEvaluationMaterial(lspConfigMaterial) : null,
    node_version: process.version,
  };
  const rows = cases.map(item => {
    const result = service.codebaseSymbolFind({ workspace_id: ready.workspace_id, index_id: ready.index_id, query: item.query, limit: 100 });
    const symbols = result.symbols as Array<{ readonly name: string; readonly path: string }>;
    const rank = symbols.findIndex(symbol => symbol.path === item.path && symbol.name === item.name) + 1;
    const explored = service.codebaseSymbolExplore({ workspace_id: ready.workspace_id, index_id: ready.index_id, query: item.query, symbol_limit: 10 });
    const candidates = explored.candidates as Array<{ readonly symbol: { readonly id: string; readonly name: string; readonly path: string; readonly source_digest: string }; readonly relations: unknown[]; readonly score: number }>;
    const exploreRank = candidates.findIndex(candidate => candidate.symbol.path === item.path && candidate.symbol.name === item.name) + 1;
    const defaultExplored = service.codebaseSymbolExplore({ workspace_id: ready.workspace_id, index_id: ready.index_id, query: item.query });
    const defaultCandidates = defaultExplored.candidates as Array<{ readonly symbol: { readonly name: string; readonly path: string } }>;
    const defaultExploreRank = defaultCandidates.findIndex(candidate => candidate.symbol.path === item.path && candidate.symbol.name === item.name) + 1;
    const baseline = rankBaseline(item.query, 100);
    const baselinePosition = baseline.findIndex(hit => hit.node.path === item.path && hit.node.name === item.name) + 1;
    const target = candidates.find(candidate => candidate.symbol.path === item.path && candidate.symbol.name === item.name);
    let sourceRead = target ? service.codebaseSymbolRead({ workspace_id: ready.workspace_id, index_id: ready.index_id,
      node_id: String(target.symbol.id), max_lines: 80, max_bytes: 10_000 }) : undefined;
    let sourceReadText = sourceRead ? String(sourceRead.source) : "";
    let sourceReadChunks = sourceRead ? 1 : 0;
    while (sourceRead?.truncated && typeof sourceRead.continuation === "string" && sourceReadChunks < 100) {
      sourceRead = service.codebaseSymbolRead({ workspace_id: ready.workspace_id, index_id: ready.index_id,
        node_id: String(target!.symbol.id), continuation: sourceRead.continuation, max_lines: 80, max_bytes: 10_000 });
      sourceReadText += String(sourceRead.source);
      sourceReadChunks++;
    }
    const sourceReadComplete = sourceRead !== undefined && sourceRead.truncated === false;
    const sourceReadVerified = sourceReadComplete && sourceRead?.path === item.path
      && sourceRead?.source_digest === target?.symbol.source_digest && sourceReadText.includes(item.name);
    return { ...item, baseline_rank: baselinePosition || null, rank: rank || null, explore_rank: exploreRank || null, default_explore_rank: defaultExploreRank || null,
      target_relation_count: target?.relations.length ?? 0, source_read_verified: sourceReadVerified,
      source_read_mode: sourceRead?.read_mode ?? null, source_read_complete: sourceReadComplete,
      source_read_chunks: sourceReadChunks, source_read_truncated: sourceRead?.truncated ?? null, resolution: explored.resolution,
      top_hits: symbols.slice(0, 3).map(symbol => ({ name: symbol.name, path: symbol.path })),
      top_explore_hits: candidates.slice(0, 6).map(candidate => ({ name: candidate.symbol.name, path: candidate.symbol.path,
        score: candidate.score, relation_count: candidate.relations.length })) };
  });
  const reciprocalRanks = rows.map(row => row.rank === null ? 0 : 1 / row.rank);
  const baselineReciprocalRanks = rows.map(row => row.baseline_rank === null ? 0 : 1 / row.baseline_rank);
  const exploreReciprocalRanks = rows.map(row => row.explore_rank === null ? 0 : 1 / row.explore_rank);
  const mrr = reciprocalRanks.reduce((sum, value) => sum + value, 0) / reciprocalRanks.length;
  const recallAt5 = rows.filter(row => row.rank !== null && row.rank <= 5).length / rows.length;
  const exploreMrr = exploreReciprocalRanks.reduce((sum, value) => sum + value, 0) / exploreReciprocalRanks.length;
  const exploreRecallAt5 = rows.filter(row => row.explore_rank !== null && row.explore_rank <= 5).length / rows.length;
  const defaultExploreTargetCoverage = rows.filter(row => row.default_explore_rank !== null).length / rows.length;
  const bilingualRows = rows.filter(row => /\p{Script=Han}/u.test(row.query));
  const bilingualRecallAt5 = bilingualRows.filter(row => row.explore_rank !== null && row.explore_rank <= 5).length / bilingualRows.length;
  const bilingualDefaultCoverage = bilingualRows.filter(row => row.default_explore_rank !== null).length / bilingualRows.length;
  const sourceReadRate = rows.filter(row => row.source_read_verified).length / rows.length;
  const languageMetrics = summarizeRetrievalByLanguage(rows);
  const declarationReadRate = rows.filter(row => row.source_read_mode === "declaration").length / rows.length;
  const minimumMrr = 0.6, minimumRecallAt5 = 0.9;
  const evaluationPass = mrr >= minimumMrr && recallAt5 >= minimumRecallAt5 && exploreMrr >= minimumMrr
    && exploreRecallAt5 >= minimumRecallAt5 && sourceReadRate === 1 && declarationReadRate === 1
    && defaultExploreTargetCoverage === 1 && (bilingualRows.length === 0 || bilingualDefaultCoverage === 1)
    && callGraphRows.every(row => row.target_found) && graphPrecision === 1 && graphRecall === 1
    && impactPrecision === 1 && impactRecall === 1
    && impactCases.length > 0
    && multiHopImpactSummary.target_found_count === multiHopImpactSummary.case_count
    && multiHopImpactSummary.truncated_case_count === 0
    && multiHopImpactSummary.precision === 1 && multiHopImpactSummary.recall === 1;
  const summary = {
    repository,
    provenance,
    index_id: ready.index_id,
    source_file_count: store.get("codebase_index", String(ready.index_id)).source_file_count,
    relation_analysis: (store.get("codebase_index", String(ready.index_id)).analysis as Record<string, unknown>).relation_analysis,
    repository_summary: ready.summary ?? null,
    query_count: cases.length,
    baseline_mrr: baselineReciprocalRanks.reduce((sum, value) => sum + value, 0) / baselineReciprocalRanks.length,
    hit_rate_at_10: rows.filter(row => row.rank !== null && row.rank <= 10).length / rows.length,
    mrr,
    symbol_explore_mrr: exploreMrr,
    symbol_explore_recall_at_5: exploreRecallAt5,
    default_symbol_explore_target_coverage: defaultExploreTargetCoverage,
    bilingual_task_query_count: bilingualRows.length,
    bilingual_symbol_explore_recall_at_5: bilingualRecallAt5,
    bilingual_default_target_coverage: bilingualDefaultCoverage,
    symbol_explore_single_call_with_relation_rate: rows.filter(row => row.target_relation_count > 0).length / rows.length,
    symbol_read_verified_rate: sourceReadRate,
    symbol_read_complete_rate: rows.filter(row => row.source_read_complete).length / rows.length,
    symbol_read_max_chunks: Math.max(...rows.map(row => row.source_read_chunks)),
    retrieval_metrics_by_source_language: languageMetrics,
    direct_call_graph_precision: graphPrecision,
    direct_call_graph_recall: graphRecall,
    direct_call_graph_case_count: callGraphRows.length,
    direct_impact_precision: impactPrecision,
    direct_impact_recall: impactRecall,
    multi_hop_impact_case_count: multiHopImpactSummary.case_count,
    multi_hop_impact_target_found_count: multiHopImpactSummary.target_found_count,
    multi_hop_impact_truncated_case_count: multiHopImpactSummary.truncated_case_count,
    multi_hop_impact_precision: multiHopImpactSummary.precision,
    multi_hop_impact_recall: multiHopImpactSummary.recall,
    symbol_read_declaration_rate: declarationReadRate,
    baseline_recall_at_5: rows.filter(row => row.baseline_rank !== null && row.baseline_rank <= 5).length / rows.length,
    recall_at_5: recallAt5,
    minimum_mrr: minimumMrr,
    minimum_recall_at_5: minimumRecallAt5,
    minimum_symbol_explore_mrr: minimumMrr,
    minimum_symbol_explore_recall_at_5: minimumRecallAt5,
    evaluation_pass: evaluationPass,
    cases: rows,
    direct_call_graph_cases: callGraphRows,
    multi_hop_impact_cases: multiHopImpactCases,
  };
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(summary.evaluation_pass, true, "Codebase retrieval quality regressed below the fixed local acceptance thresholds");
} finally {
  store.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
