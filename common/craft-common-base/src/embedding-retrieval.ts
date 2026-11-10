import { DatabaseSync } from "node:sqlite";
import { stableDigest } from "./digest.ts";
import type { JsonObject } from "../../craft-common-store-local/src/store.ts";
import type { RetrievalPort, RetrievalHit, RetrievalExecution } from "./retrieval-contract.ts";

function cosine(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * right[index]!, 0);
  const norm = (values: readonly number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  const leftNorm = norm(left), rightNorm = norm(right);
  return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0;
}

/** Validate and order the whole response before publishing anything to cache. */
function embeddingRows(value: unknown, expected: number): number[][] {
  const data = value && typeof value === "object" ? (value as JsonObject).data : undefined;
  if (!Array.isArray(data) || data.length !== expected) throw new Error("invalid_embedding_response");
  const result: number[][] = [], indices = new Set<number>();
  data.forEach((item: unknown, position) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid_embedding_response");
    const row = item as JsonObject, index = row.index === undefined ? position : row.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= expected || indices.has(index)) throw new Error("invalid_embedding_response");
    const vector = row.embedding;
    if (!Array.isArray(vector) || !vector.length || vector.length > 8192 || vector.some(n => typeof n !== "number" || !Number.isFinite(n))
      || !Number.isFinite(vector.reduce((sum, n) => sum + n * n, 0))) throw new Error("invalid_embedding_response");
    indices.add(index); result[index] = vector;
  });
  return result;
}

/** OpenAI-compatible embeddings, deliberately invoked only after an eligible evaluation. */
export class OpenAiCompatibleEmbeddingRetrievalPort implements RetrievalPort {
  /** Process-local cache pinned to endpoint, configured model identifier and content.
   * A mutable provider model alias is not an attested model revision. */
  private static readonly embeddings = new Map<string, number[]>();
  readonly endpoint: string; readonly model: string; readonly credentialEnv: string;
  readonly cachePath?: string;
  readonly revision: string;
  readonly beforeRequest?: () => void;
  constructor(configuration: JsonObject, cachePath?: string, beforeRequest?: () => void) {
    this.cachePath = cachePath; this.beforeRequest = beforeRequest;
    this.revision = typeof configuration.model_revision === "string" ? configuration.model_revision : "unversioned";
    this.endpoint = typeof configuration.endpoint === "string" ? configuration.endpoint : "";
    this.model = typeof configuration.model === "string" ? configuration.model : "";
    this.credentialEnv = typeof configuration.credential_env === "string" ? configuration.credential_env : "";
  }
  async search(query: string, documents: readonly { id: string; body: string }[]): Promise<{ hits: RetrievalHit[]; execution: RetrievalExecution }> {
    const started = Date.now(); const key = this.credentialEnv ? process.env[this.credentialEnv] : undefined;
    if (!this.endpoint || !this.model || !key) return { hits: [], execution: { requested: "vector", used: "keyword", provider: this.endpoint ? "openai-compatible" : null, model: this.model || null, latency_ms: Date.now() - started, cost_summary: null, unavailable_reason: "embedding_provider_unavailable" } };
    const input = [query, ...documents.map((item) => item.body)];
    if (input.length > 10_001 || input.reduce((n, body) => n + body.length, 0) > 8_000_000 || input.some(body => body.length > 32_000))
      return { hits: [], execution: { requested: "vector", used: "keyword", provider: "openai-compatible", model: this.model, latency_ms: Date.now() - started, cost_summary: null, unavailable_reason: "embedding_input_budget_exceeded" } };
    const cacheKeys = input.map((value) => stableDigest({ endpoint: this.endpoint, model: this.model, revision: this.revision, value }));
    const inputsByKey = new Map(cacheKeys.map((cacheKey, index) => [cacheKey, input[index]!]));
    const cache = new Map(OpenAiCompatibleEmbeddingRetrievalPort.embeddings);
    let database: DatabaseSync | undefined;
    let unavailableReason = "embedding_request_failed";
    let result: { hits: RetrievalHit[]; execution: RetrievalExecution };
    try {
      if (this.cachePath) {
        database = new DatabaseSync(this.cachePath);
        database.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector TEXT NOT NULL, touched INTEGER NOT NULL)");
        for (const cacheKey of new Set(cacheKeys)) {
          const row = database.prepare("SELECT vector FROM embeddings WHERE key=?").get(cacheKey);
          if (row) cache.set(cacheKey, embeddingRows({ data: [{ embedding: JSON.parse(String(row.vector)) }] }, 1)[0]!);
        }
      }
      const missing = [...new Set(cacheKeys.filter(cacheKey => !cache.has(cacheKey)))];
      let usage: JsonObject | undefined;
      let usageComplete = true;
      const pending = new Map<string, number[]>();
      const deadline = AbortSignal.timeout(60_000);
      for (let offset = 0; offset < missing.length;) {
        const batch: string[] = []; let chars = 0;
        while (offset < missing.length && batch.length < 32) {
          const cacheKey = missing[offset]!, value = inputsByKey.get(cacheKey)!;
          if (batch.length && chars + value.length > 32_000) break;
          batch.push(cacheKey); chars += value.length; offset++;
        }
        const inputs = batch.map(cacheKey => inputsByKey.get(cacheKey)!);
        unavailableReason = "embedding_request_failed";
        this.beforeRequest?.();
        const response = await fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: this.model, input: inputs }), signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]) });
        if (!response.ok) { unavailableReason = `http_${response.status}`; throw new Error(unavailableReason); }
        unavailableReason = "invalid_embedding_response";
        const body = await response.json();
        const vectors = embeddingRows(body, batch.length);
        batch.forEach((cacheKey, index) => pending.set(cacheKey, vectors[index]!));
        const units = body.usage?.total_tokens;
        if (typeof units !== "number" || !Number.isSafeInteger(units) || units < 0) usageComplete = false;
        else usage = { batches: Number(usage?.batches ?? 0) + 1, total_tokens: Number(usage?.total_tokens ?? 0) + units };
      }
      const vectors = cacheKeys.map((cacheKey) => pending.get(cacheKey) ?? cache.get(cacheKey)!);
      // A provider may change dimensions between requests while retaining its model name.
      // Reject the mixed result before caching it; existing valid entries remain intact.
      if (new Set(vectors.map(vector => vector.length)).size !== 1) throw new Error("invalid_embedding_response");
      this.beforeRequest?.(); // Do not publish embeddings computed from a revoked corpus.
      if (database) {
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const [cacheKey, vector] of pending) database.prepare("INSERT OR REPLACE INTO embeddings VALUES(?,?,?)").run(cacheKey, JSON.stringify(vector), Date.now());
          database.exec("DELETE FROM embeddings WHERE key IN (SELECT key FROM embeddings ORDER BY touched DESC,key LIMIT -1 OFFSET 10000); COMMIT");
        } catch (error) { database.exec("ROLLBACK"); throw error; }
      }
      for (const [cacheKey, vector] of pending) OpenAiCompatibleEmbeddingRetrievalPort.embeddings.set(cacheKey, vector);
      while (OpenAiCompatibleEmbeddingRetrievalPort.embeddings.size > 4096) OpenAiCompatibleEmbeddingRetrievalPort.embeddings.delete(OpenAiCompatibleEmbeddingRetrievalPort.embeddings.keys().next().value!);
      const queryVector = vectors[0]!;
      const hits = documents.map((document, index) => ({ id: document.id, score: cosine(queryVector, vectors[index + 1]!), reason: "vector_cosine" }))
        .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      result = { hits, execution: { requested: "vector", used: "vector", provider: "openai-compatible", model: this.model, latency_ms: Date.now() - started, cost_summary: { usage_digest: usage ? stableDigest(usage) : null, billable_units: usageComplete ? Number(usage?.total_tokens ?? 0) : null }, unavailable_reason: null } };
    } catch {
      result = { hits: [], execution: { requested: "vector", used: "keyword", provider: "openai-compatible", model: this.model, latency_ms: Date.now() - started, cost_summary: null, unavailable_reason: unavailableReason } };
    } finally {
      if (database) database.close();
    }
    return result;
  }
}

