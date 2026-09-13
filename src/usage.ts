import { CraftStore, type JsonObject } from "./store.ts";

export interface UsageBucket { input_tokens: number; output_tokens: number; total_tokens: number; requests: number }
export interface UsageReport { from: string | null; to: string | null; totals: UsageBucket; daily: Record<string, UsageBucket>; weekly: Record<string, UsageBucket>; monthly: Record<string, UsageBucket>; yearly: Record<string, UsageBucket>; by_host: Record<string, UsageBucket>; generated_at: string }

const RECEIPT_KINDS = ["codex_receipt", "claude_receipt", "internal_receipt", "generic_receipt", "outcome", "autonomous_turn"];
const EMPTY: UsageBucket = { input_tokens: 0, output_tokens: 0, total_tokens: 0, requests: 0 };
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; }
function add(left: UsageBucket, right: UsageBucket): UsageBucket { return { input_tokens: left.input_tokens + right.input_tokens, output_tokens: left.output_tokens + right.output_tokens, total_tokens: left.total_tokens + right.total_tokens, requests: left.requests + right.requests }; }
function usage(value: unknown): UsageBucket {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY };
  const body = value as JsonObject;
  const input = number(body.input_tokens ?? body.inputTokens ?? body.prompt_tokens ?? body.promptTokens);
  const output = number(body.output_tokens ?? body.outputTokens ?? body.completion_tokens ?? body.completionTokens);
  const explicit = number(body.total_tokens ?? body.totalTokens ?? body.tokens);
  const total = explicit || input + output;
  return { input_tokens: input, output_tokens: output, total_tokens: total, requests: 1 };
}
function recordUsage(record: JsonObject): UsageBucket {
  if (record.kind === "autonomous_turn") return usage({ tokens: record.tokens });
  if (record.kind === "outcome") {
    const costs = record.costs && typeof record.costs === "object" && !Array.isArray(record.costs) ? record.costs as JsonObject : {};
    return usage(costs.usage);
  }
  return usage(record.usage ?? record.loop);
}
function timestamp(record: JsonObject): number | null {
  for (const key of ["completed_at", "finished_at", "created_at", "updated_at", "observed_at"]) {
    const value = Date.parse(String(record[key] ?? "")); if (Number.isFinite(value)) return value;
  }
  return null;
}
function weekKey(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7; day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return `${day.getUTCFullYear()}-W${String(Math.ceil((((day.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)).padStart(2, "0")}`;
}
function put(target: Record<string, UsageBucket>, key: string, item: UsageBucket): void { target[key] = add(target[key] ?? { ...EMPTY }, item); }

export class UsageKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  report(args: JsonObject = {}): UsageReport {
    const from = args.from === undefined ? null : Date.parse(String(args.from));
    const to = args.to === undefined ? null : Date.parse(String(args.to));
    if (from !== null && !Number.isFinite(from)) throw new Error("from must be an ISO timestamp");
    if (to !== null && !Number.isFinite(to)) throw new Error("to must be an ISO timestamp");
    if (from !== null && to !== null && from > to) throw new Error("from must not be after to");
    const totals = { ...EMPTY }; const daily: Record<string, UsageBucket> = {}; const weekly: Record<string, UsageBucket> = {};
    const monthly: Record<string, UsageBucket> = {}; const yearly: Record<string, UsageBucket> = {}; const byHost: Record<string, UsageBucket> = {};
    for (const kind of RECEIPT_KINDS) for (const raw of this.store.list(kind, Number.MAX_SAFE_INTEGER)) {
      const time = timestamp(raw); if (time === null || (from !== null && time < from) || (to !== null && time > to)) continue;
      const item = recordUsage({ ...raw, kind }); if (item.total_tokens === 0 && item.input_tokens === 0 && item.output_tokens === 0) continue;
      const date = new Date(time); const day = date.toISOString().slice(0, 10); const month = day.slice(0, 7); const year = day.slice(0, 4);
      const host = String(raw.host ?? (kind === "autonomous_turn" ? "internal" : "unknown"));
      Object.assign(totals, add(totals, item)); put(daily, day, item); put(weekly, weekKey(date), item); put(monthly, month, item); put(yearly, year, item); put(byHost, host, item);
    }
    return { from: args.from === undefined ? null : String(args.from), to: args.to === undefined ? null : String(args.to), totals, daily, weekly, monthly, yearly, by_host: byHost, generated_at: new Date().toISOString() };
  }
}
