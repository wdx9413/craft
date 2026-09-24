/** Real, optional retrieval adapters. Keyword is always local; vector never lies
 * about running when its provider is absent or its evaluation has not passed. */
import { stableDigest } from "./digest.ts";
import type { JsonObject } from "./infrastructure/store.ts";

export type RetrievalHit = { readonly id: string; readonly score: number; readonly reason: string };
export type RetrievalExecution = { readonly requested: string; readonly used: string; readonly provider: string | null; readonly model: string | null; readonly latency_ms: number; readonly cost_summary: JsonObject | null; readonly unavailable_reason: string | null };
export interface RetrievalPort { search(query: string, documents: readonly { id: string; body: string }[]): Promise<{ hits: RetrievalHit[]; execution: RetrievalExecution }>; }

function terms(value: string): string[] { return value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []; }
export class KeywordRetrievalPort implements RetrievalPort {
  async search(query: string, documents: readonly { id: string; body: string }[]): Promise<{ hits: RetrievalHit[]; execution: RetrievalExecution }> {
    const started = Date.now(); const queryTerms = terms(query);
    const hits = documents.map((document) => ({ id: document.id, score: queryTerms.reduce((sum, term) => sum + Number(document.body.toLowerCase().includes(term)), 0), reason: "keyword_bm25" }))
      .filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { hits, execution: { requested: "keyword", used: "keyword", provider: null, model: null, latency_ms: Date.now() - started, cost_summary: null, unavailable_reason: null } };
  }
}

function cosine(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  const norm = (values: readonly number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm(left) && norm(right) ? dot / (norm(left) * norm(right)) : 0;
}

/** OpenAI-compatible embeddings, deliberately invoked only after an eligible evaluation. */
export class OpenAiCompatibleEmbeddingRetrievalPort implements RetrievalPort {
  /** Process-local cache; its key pins both model revision and content digest. */
  private static readonly embeddings = new Map<string, number[]>();
  readonly endpoint: string; readonly model: string; readonly credentialEnv: string;
  constructor(configuration: JsonObject) {
    this.endpoint = typeof configuration.endpoint === "string" ? configuration.endpoint : "";
    this.model = typeof configuration.model === "string" ? configuration.model : "";
    this.credentialEnv = typeof configuration.credential_env === "string" ? configuration.credential_env : "";
  }
  async search(query: string, documents: readonly { id: string; body: string }[]): Promise<{ hits: RetrievalHit[]; execution: RetrievalExecution }> {
    const started = Date.now(); const key = this.credentialEnv ? process.env[this.credentialEnv] : undefined;
    if (!this.endpoint || !this.model || !key) return { hits: [], execution: { requested: "vector", used: "keyword", provider: this.endpoint ? "openai-compatible" : null, model: this.model || null, latency_ms: Date.now() - started, cost_summary: null, unavailable_reason: "embedding_provider_unavailable" } };
    const input = [query, ...documents.map((item) => item.body)];
    const cacheKeys = input.map((value) => stableDigest({ endpoint: this.endpoint, model: this.model, value }));
    const missing = [...new Set(cacheKeys.filter((cacheKey) => !OpenAiCompatibleEmbeddingRetrievalPort.embeddings.has(cacheKey)))];
    try {
      let usage: JsonObject | undefined;
      if (missing.length) {
        const inputs = missing.map((cacheKey) => input[cacheKeys.indexOf(cacheKey)]!);
        const response = await fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: this.model, input: inputs }), signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`http_${response.status}`);
        const body = await response.json() as { data?: { embedding?: number[] }[]; usage?: JsonObject };
        const vectors = body.data?.map((item) => item.embedding) ?? [];
        if (vectors.length !== missing.length || vectors.some((item) => !Array.isArray(item))) throw new Error("invalid_embedding_response");
        missing.forEach((cacheKey, index) => OpenAiCompatibleEmbeddingRetrievalPort.embeddings.set(cacheKey, vectors[index]!)); usage = body.usage;
      }
      const vectors = cacheKeys.map((cacheKey) => OpenAiCompatibleEmbeddingRetrievalPort.embeddings.get(cacheKey));
      if (vectors.some((item) => !Array.isArray(item))) throw new Error("embedding_cache_incomplete");
      const queryVector = vectors[0]!;
      const hits = documents.map((document, index) => ({ id: document.id, score: cosine(queryVector, vectors[index + 1]!), reason: "vector_cosine" }))
        .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return { hits, execution: { requested: "vector", used: "vector", provider: "openai-compatible", model: this.model, latency_ms: Date.now() - started, cost_summary: usage ? { usage_digest: stableDigest(usage) } : null, unavailable_reason: null } };
    } catch (error) {
      return { hits: [], execution: { requested: "vector", used: "keyword", provider: "openai-compatible", model: this.model, latency_ms: Date.now() - started, cost_summary: null, unavailable_reason: error instanceof Error ? error.message : "embedding_request_failed" } };
    }
  }
}

export function temporalMemorySelect<T extends JsonObject>(items: readonly T[], now: Date, history: boolean): { selected: T[]; excluded: JsonObject[] } {
  const groups = new Map<string, T[]>(); const excluded: JsonObject[] = [];
  for (const item of items) {
    if (!history && item.status !== "active") { excluded.push({ memory_id: item.id, reason: "not_current" }); continue; }
    if (item.valid_until && Date.parse(String(item.valid_until)) < now.valueOf()) { excluded.push({ memory_id: item.id, reason: "expired" }); continue; }
    const key = typeof item.topic === "string" && item.topic ? item.topic : `entry:${item.id}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const selected: T[] = [];
  for (const [topic, group] of groups) {
    const current = group.sort((left, right) => Date.parse(String(right.effective_from ?? right.updated_at ?? 0)) - Date.parse(String(left.effective_from ?? left.updated_at ?? 0)) || Number(right.version) - Number(left.version));
    if (current.length > 1 && !history && current[0]!.content_digest !== current[1]!.content_digest && current[0]!.status === "active" && current[1]!.status === "active") {
      excluded.push(...current.map((item) => ({ memory_id: item.id, topic, reason: "temporal_conflict_abstain" })));
    } else selected.push(...(history ? current : current.slice(0, 1)));
  }
  return { selected, excluded };
}
