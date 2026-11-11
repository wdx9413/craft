import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { DEFAULT_CONTEXT_RESPONSE_MAX_TOKENS } from "./context-response-projection.ts";

const SCAN_LIMIT = 100_000;
const RECENT_LIMIT = 20;

function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Compact, content-free status line for a Host or Workbench footer. Never reads prompt bodies. */
export function contextUsageStatusline(store: CraftStore, args: JsonObject = {}): JsonObject {
  const sessionId = typeof args.session_id === "string" && args.session_id.trim() ? args.session_id.trim() : null;
  const host = typeof args.session_host === "string" && args.session_host.trim() ? args.session_host.trim() : null;
  const receipts = store.list("context_resolution_receipt", SCAN_LIMIT, item =>
    (sessionId === null || item.session_id === sessionId) && (host === null || item.session_host === host), false);
  const receiptIds = new Set(receipts.map(item => String(item.id)));
  const feedback = store.list("context_feedback", SCAN_LIMIT, item =>
    typeof item.receipt_id === "string" && receiptIds.has(item.receipt_id), false);
  const workingSets = store.list("context_working_set_receipt", SCAN_LIMIT, undefined, false);
  const emissions = store.list("context_emission", SCAN_LIMIT, undefined, false);
  let injected = 0, schema = 0, history = 0, measured = 0;
  for (const item of feedback) {
    const measurement = object(item.token_measurement);
    const values = [nonNegative(measurement.injected_tokens), nonNegative(measurement.schema_tokens), nonNegative(measurement.history_tokens)];
    if (values[0] !== null) { injected += values[0]; measured += 1; }
    if (values[1] !== null) schema += values[1];
    if (values[2] !== null) history += values[2];
  }
  const outcomes: Record<string, number> = {};
  for (const item of feedback) {
    const outcome = typeof item.outcome === "string" ? item.outcome : "unknown";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  let selectedItems = 0, selectedChars = 0, estimatedTokens = 0, omitted = 0;
  for (const item of receipts) {
    selectedItems += Number(item.total_items ?? 0);
    selectedChars += Number(item.total_used_chars ?? 0);
    omitted += Number(item.omitted_count ?? 0);
  }
  estimatedTokens = Math.ceil(selectedChars / 3);
  const hostMeasured = measured > 0;
  const totalTokens = hostMeasured ? injected + schema + history : estimatedTokens;
  const recent = feedback.slice(-RECENT_LIMIT).reverse().map(item => {
    const measurement = object(item.token_measurement);
    return { outcome: item.outcome ?? "unknown", usage_stage: item.usage_stage ?? "shown",
      turn_outcome: item.turn_outcome ?? null, injected_tokens: nonNegative(measurement.injected_tokens),
      schema_tokens: nonNegative(measurement.schema_tokens), history_tokens: nonNegative(measurement.history_tokens),
      asset_ref_count: Array.isArray(item.asset_refs) ? item.asset_refs.length : 0 };
  });
  const unrated = outcomes.unrated ?? 0;
  return {
    session_id: sessionId, session_host: host,
    line: `${hostMeasured ? "measured" : "estimated"} context ${totalTokens} tok · ${selectedItems} refs · ${omitted} omitted · ${feedback.length} feedback (${unrated} unrated)`,
    tokens: { injected, schema, history, estimated: estimatedTokens, total: totalTokens,
      provenance: hostMeasured ? "host_reported" : "estimated", measured_feedback: measured,
      estimate_rule: "ceil(selected_chars / 3)" },
    selected: { receipts: receipts.length, working_sets: workingSets.length, emissions: emissions.length,
      items: selectedItems, chars: selectedChars, omitted },
    feedback: { records: feedback.length, outcomes, unrated_ratio: feedback.length ? Math.round(unrated / feedback.length * 100) / 100 : 0 },
    response_budget: { compact_default_tokens: DEFAULT_CONTEXT_RESPONSE_MAX_TOKENS, max_chars_is_token_budget: false },
    recent,
    content_free: true,
    execution_context: false,
  };
}
