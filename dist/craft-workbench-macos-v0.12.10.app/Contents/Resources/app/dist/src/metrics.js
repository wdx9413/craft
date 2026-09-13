import { CraftStore } from "./store.js";
const EMPTY = { runs: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0,
    success_rate: null, duration_ms: 0, outcomes: 0, passed: 0, tokens: 0, cost_usd: 0, cost_per_success: null };
function number(value) {
    const result = Number(value);
    return Number.isFinite(result) ? result : 0;
}
/** Usage objects come from whatever the host reported, so every field is optional and untrusted. */
export function usageTokens(usage) {
    if (!usage || typeof usage !== "object" || Array.isArray(usage))
        return 0;
    const body = usage;
    return number(body.total_tokens ?? body.tokens ?? body.totalTokens);
}
function runStatus(status) {
    const value = String(status);
    return value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted"
        ? value : null;
}
function finalize(bucket) {
    return { ...bucket,
        success_rate: bucket.runs === 0 ? null : bucket.completed / bucket.runs,
        cost_per_success: bucket.passed > 0 ? bucket.cost_usd / bucket.passed : null };
}
export class MetricsKernel {
    store;
    constructor(store) { this.store = store; }
    /**
     * Aggregate host runs and outcomes. Runs are grouped by host; outcomes carry no
     * host of their own, so their cost accrues to the totals only.
     */
    report(args = {}) {
        const host = args.host === undefined || args.host === null ? null : String(args.host);
        const totals = { ...EMPTY };
        const byHost = new Map();
        for (const run of this.store.list("host_run", Number.MAX_SAFE_INTEGER)) {
            const name = String(run.host ?? "unknown");
            if (host !== null && name !== host)
                continue;
            const bucket = byHost.get(name) ?? { ...EMPTY };
            bucket.runs += 1;
            const key = runStatus(run.status);
            if (key)
                bucket[key] += 1;
            const started = Date.parse(String(run.started_at ?? ""));
            const finished = Date.parse(String(run.finished_at ?? ""));
            if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
                bucket.duration_ms += finished - started;
            }
            byHost.set(name, bucket);
            totals.runs += 1;
            if (key)
                totals[key] += 1;
            if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
                totals.duration_ms += finished - started;
            }
        }
        for (const outcome of this.store.list("outcome", Number.MAX_SAFE_INTEGER)) {
            const costs = (outcome.costs && typeof outcome.costs === "object" && !Array.isArray(outcome.costs))
                ? outcome.costs : {};
            totals.outcomes += 1;
            if (String(outcome.verdict) === "passed")
                totals.passed += 1;
            totals.tokens += usageTokens(costs.usage);
            totals.cost_usd += number(costs.cost_usd);
        }
        const byHostReport = {};
        for (const [name, bucket] of [...byHost.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
            byHostReport[name] = finalize(bucket);
        }
        return { totals: finalize(totals), by_host: byHostReport, generated_at: new Date().toISOString() };
    }
}
//# sourceMappingURL=metrics.js.map