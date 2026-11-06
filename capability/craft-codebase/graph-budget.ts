/**
 * One source of truth for the semantic-graph budgets.
 *
 * These limits used to be declared independently in typescript-analysis.ts
 * (60k nodes / 150k edges / 32 MiB) and codebase-index.ts (60k / 300k / 64 MiB).
 * A real Craft checkout produces ~85k nodes / ~384k edges / ~90 MiB, so the
 * importer rejected the analyzer's output; repository-onboarding swallowed that
 * failure into a silent `degraded` state and the caller/impact graph lost its
 * cross-file edges. Drifting constants are the root cause, not any single cap.
 *
 * Everything is bounded: shards are still 1 MiB each, and the totals have a
 * hard ceiling so an adversarial repository cannot grow without limit.
 */
export const GRAPH_BUDGET = Object.freeze({
  maxNodes: 120_000,
  maxEdges: 500_000,
  /** Upper bound on the serialized analysis passed to importAnalysis. */
  maxImportBytes: 128 * 1024 * 1024,
  /** Upper bound on the serialized graph written to shards. */
  maxGraphBytes: 192 * 1024 * 1024,
} as const);
