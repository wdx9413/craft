import { CraftStore, type JsonObject } from "./infrastructure/store.ts";

/**
 * Operational metrics as a projection.
 *
 * Everything here is derived from records Craft already writes, so there is no
 * second bookkeeping path that could disagree with the receipts. The measure the
 * harness literature actually asks for is not "tokens spent" but **cost per
 * successful outcome**: a cheap run that fails is more expensive than a costly
 * run that passes, and per-turn token counts cannot express that.
 *
 * An empty store is reported as zero samples rather than as a perfect score.
 */

export interface MetricsBucket {
  /** Host runs observed. */
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  /** Completed runs over all runs, or null when there are none. */
  success_rate: number | null;
  duration_ms: number;
  /** Outcomes recorded, and how many of them passed. */
  outcomes: number;
  passed: number;
  tokens: number;
  cost_usd: number;
  /** Cost per passing outcome, or null when nothing passed yet. */
  cost_per_success: number | null;
}

export interface MetricsReport {
  totals: MetricsBucket;
  by_host: Record<string, MetricsBucket>;
  generated_at: string;
}

const EMPTY: MetricsBucket = { runs: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0,
  success_rate: null, duration_ms: 0, outcomes: 0, passed: 0, tokens: 0, cost_usd: 0, cost_per_success: null };

function number(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

/** Usage objects come from whatever the host reported, so every field is optional and untrusted. */
export function usageTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return 0;
  const body = usage as JsonObject;
  return number(body.total_tokens ?? body.tokens ?? body.totalTokens);
}

function runStatus(status: unknown): "completed" | "failed" | "cancelled" | "interrupted" | null {
  const value = String(status);
  return value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted"
    ? value : null;
}

function finalize(bucket: MetricsBucket): MetricsBucket {
  return { ...bucket,
    success_rate: bucket.runs === 0 ? null : bucket.completed / bucket.runs,
    cost_per_success: bucket.passed > 0 ? bucket.cost_usd / bucket.passed : null };
}

export class MetricsKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Aggregate host runs and outcomes. Runs are grouped by host; outcomes carry no
   * host of their own, so their cost accrues to the totals only.
   */
  report(args: JsonObject = {}): MetricsReport {
    const host = args.host === undefined || args.host === null ? null : String(args.host);
    const totals: MetricsBucket = { ...EMPTY };
    const byHost = new Map<string, MetricsBucket>();

    for (const run of this.store.list("host_run", Number.MAX_SAFE_INTEGER)) {
      const name = String(run.host ?? "unknown");
      if (host !== null && name !== host) continue;
      const bucket = byHost.get(name) ?? { ...EMPTY };
      bucket.runs += 1;
      const key = runStatus(run.status);
      if (key) bucket[key] += 1;
      const started = Date.parse(String(run.started_at ?? ""));
      const finished = Date.parse(String(run.finished_at ?? ""));
      if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
        bucket.duration_ms += finished - started;
      }
      byHost.set(name, bucket);

      totals.runs += 1;
      if (key) totals[key] += 1;
      if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
        totals.duration_ms += finished - started;
      }
    }

    for (const outcome of this.store.list("outcome", Number.MAX_SAFE_INTEGER)) {
      const costs = (outcome.costs && typeof outcome.costs === "object" && !Array.isArray(outcome.costs))
        ? outcome.costs as JsonObject : {};
      totals.outcomes += 1;
      if (String(outcome.verdict) === "passed") totals.passed += 1;
      totals.tokens += usageTokens(costs.usage);
      totals.cost_usd += number(costs.cost_usd);
    }

    const byHostReport: Record<string, MetricsBucket> = {};
    for (const [name, bucket] of [...byHost.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      byHostReport[name] = finalize(bucket);
    }
    return { totals: finalize(totals), by_host: byHostReport, generated_at: new Date().toISOString() };
  }
}
