export type RetrievalMetricCase = {
  readonly path: string;
  readonly rank: number | null;
  readonly explore_rank: number | null;
  readonly default_explore_rank: number | null;
  readonly source_read_verified: boolean;
};

const extensionLanguage: Readonly<Record<string, string>> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript",
  cjs: "javascript", jsx: "javascript", py: "python", java: "java", go: "go", rs: "rust", c: "c", h: "cpp",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", swift: "swift", kt: "kotlin", rb: "ruby", php: "php",
};

function reciprocalRank(rank: number | null): number {
  return rank === null ? 0 : 1 / rank;
}

export function summarizeRetrievalByLanguage(rows: readonly RetrievalMetricCase[]) {
  const grouped = new Map<string, RetrievalMetricCase[]>();
  for (const row of rows) {
    const extension = row.path.substring(row.path.lastIndexOf(".") + 1).toLowerCase();
    const language = extensionLanguage[extension] ?? "other";
    const group = grouped.get(language) ?? [];
    group.push(row);
    grouped.set(language, group);
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([language, cases]) => [language, {
    query_count: cases.length,
    mrr: cases.reduce((sum, item) => sum + reciprocalRank(item.rank), 0) / cases.length,
    symbol_explore_mrr: cases.reduce((sum, item) => sum + reciprocalRank(item.explore_rank), 0) / cases.length,
    recall_at_5: cases.filter(item => item.rank !== null && item.rank <= 5).length / cases.length,
    symbol_explore_recall_at_5: cases.filter(item => item.explore_rank !== null && item.explore_rank <= 5).length / cases.length,
    default_candidate_coverage: cases.filter(item => item.default_explore_rank !== null).length / cases.length,
    source_read_verified_rate: cases.filter(item => item.source_read_verified).length / cases.length,
  }]));
}
