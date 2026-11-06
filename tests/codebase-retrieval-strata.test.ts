import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRetrievalByLanguage } from "../scripts/eval/codebase-retrieval-strata.ts";

test("retrieval metrics stay separated by source language and include Agent evidence rates", () => {
  assert.deepEqual(summarizeRetrievalByLanguage([
    { path: "ui/ConversationViewer.jsx", rank: 2, explore_rank: 1, default_explore_rank: 1, source_read_verified: true },
    { path: "ui/ConversationViewer.jsx", rank: null, explore_rank: 6, default_explore_rank: null, source_read_verified: false },
    { path: "service/agent.py", rank: 5, explore_rank: 2, default_explore_rank: 3, source_read_verified: true },
    { path: "notes/guide.unknown", rank: 1, explore_rank: 1, default_explore_rank: 1, source_read_verified: true },
    { path: "README", rank: null, explore_rank: null, default_explore_rank: null, source_read_verified: false },
  ]), {
    javascript: { query_count: 2, mrr: 0.25, symbol_explore_mrr: 7 / 12, recall_at_5: 0.5,
      symbol_explore_recall_at_5: 0.5, default_candidate_coverage: 0.5, source_read_verified_rate: 0.5 },
    other: { query_count: 2, mrr: 0.5, symbol_explore_mrr: 0.5, recall_at_5: 0.5,
      symbol_explore_recall_at_5: 0.5, default_candidate_coverage: 0.5, source_read_verified_rate: 0.5 },
    python: { query_count: 1, mrr: 0.2, symbol_explore_mrr: 0.5, recall_at_5: 1,
      symbol_explore_recall_at_5: 1, default_candidate_coverage: 1, source_read_verified_rate: 1 },
  });
  assert.deepEqual(summarizeRetrievalByLanguage([]), {});
});
