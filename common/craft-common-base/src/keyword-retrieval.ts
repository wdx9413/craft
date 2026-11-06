import { Bm25Index } from "./bm25.ts";
import type { RetrievalPort, RetrievalHit, RetrievalExecution } from "./retrieval-contract.ts";

export class KeywordRetrievalPort implements RetrievalPort {
  async search(query: string, documents: readonly { id: string; body: string }[]): Promise<{ hits: RetrievalHit[]; execution: RetrievalExecution }> {
    const started = Date.now(), index = new Bm25Index();
    for (const document of documents) if (document.body.trim()) index.add(document.id, document.body);
    const hits = query.trim() ? index.score(query).map(hit => ({ id: hit.id, score: hit.score, reason: "keyword_bm25" })) : [];
    return { hits, execution: { requested: "keyword", used: "keyword", provider: null, model: null, latency_ms: Date.now() - started, cost_summary: null, unavailable_reason: null } };
  }
}

