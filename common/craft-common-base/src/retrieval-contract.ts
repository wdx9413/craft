import type { JsonObject } from "../../craft-common-store-local/src/store.ts";

export type RetrievalHit = { readonly id: string; readonly score: number; readonly reason: string };
export type RetrievalExecution = { readonly requested: string; readonly used: string; readonly provider: string | null; readonly model: string | null; readonly latency_ms: number; readonly cost_summary: JsonObject | null; readonly unavailable_reason: string | null };
export interface RetrievalPort { search(query: string, documents: readonly { id: string; body: string }[]): Promise<{ hits: RetrievalHit[]; execution: RetrievalExecution }>; }

