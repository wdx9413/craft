import type { JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { stableDigest } from "./digest.ts";
import { KeywordRetrievalPort, OpenAiCompatibleEmbeddingRetrievalPort } from "./retrieval-port.ts";
import { fuseRankings } from "./context-retrieval-capture.ts";

/** Runs the supplied labelled corpus; caller-reported scores cannot authorize retrieval. */
export async function runRetrievalEvaluation(adapter: JsonObject, value: unknown): Promise<JsonObject> {
  const dataset = object(value, "dataset");
  if (!Array.isArray(dataset.documents) || !dataset.documents.length || dataset.documents.length > 1000
    || !Array.isArray(dataset.cases) || !dataset.cases.length || dataset.cases.length > 100
    || JSON.stringify(dataset).length > 2_000_000) throw new Error("Retrieval dataset exceeds budget or is empty");
  const docs = dataset.documents.map(raw => {
    const doc = object(raw, "document");
    return { id: text(doc.id, "document.id"), body: text(doc.body, "document.body"), scope: text(doc.scope, "document.scope") };
  });
  if (new Set(docs.map(doc => doc.id)).size !== docs.length) throw new Error("Retrieval document IDs must be unique");
  const cases = dataset.cases.map(raw => {
    const item = object(raw, "case"), scope = text(item.scope, "case.scope");
    const query = text(item.query, "case.query");
    if (!Array.isArray(item.expected_ids) || new Set(item.expected_ids).size !== item.expected_ids.length
      || item.expected_ids.some(id => typeof id !== "string" || !docs.some(doc => doc.id === id && doc.scope === scope))) throw new Error("Expected retrieval IDs must exist in the case scope");
    const limit = Number(item.top_k ?? 5);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Retrieval top_k must be in 1..100");
    return { query, scope, expected_ids: item.expected_ids as string[], limit };
  });
  const keyword = new KeywordRetrievalPort(), configuration = object(adapter.configuration, "configuration");
  const port = adapter.strategy === "keyword" ? keyword : new OpenAiCompatibleEmbeddingRetrievalPort(configuration);
  const results: JsonObject[] = []; let measuredCost: number | null = 0;
  for (const item of cases) {
    const corpus = docs.filter(doc => doc.scope === item.scope);
    const result = await port.search(item.query, corpus);
    const hits = adapter.strategy === "hybrid" && result.execution.used === "vector"
      ? fuseRankings([result.hits, (await keyword.search(item.query, corpus)).hits]) : result.hits;
    const ids = hits.slice(0, item.limit).map(hit => hit.id);
    const correct = ids.filter(id => item.expected_ids.includes(id));
    const noAnswer = item.expected_ids.length === 0;
    const price = configuration.cost_per_million_input_units;
    const units = result.execution.cost_summary?.billable_units;
    if (adapter.strategy !== "keyword") {
      if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || typeof units !== "number" || !Number.isFinite(units)) measuredCost = null;
      else if (measuredCost !== null) measuredCost += units * price / 1_000_000;
    }
    results.push({ query_digest: stableDigest(item.query), scope_digest: stableDigest(item.scope), expected_ids: item.expected_ids, returned_ids: ids,
      recall: noAnswer ? Number(ids.length === 0) : correct.length / item.expected_ids.length,
      precision: ids.length === 0 ? Number(noAnswer) : correct.length / ids.length,
      abstained: ids.length === 0, false_positive_count: ids.length - correct.length,
      no_answer_false_positive_count: noAnswer ? ids.length : 0,
      reciprocal_rank: correct.length ? 1 / (ids.indexOf(correct[0]!) + 1) : 0,
      cross_project_leak_count: ids.filter(id => !corpus.some(doc => doc.id === id)).length,
      latency_ms: result.execution.latency_ms, execution: result.execution });
  }
  const executed = results.every(result => (result.execution as JsonObject).used === (adapter.strategy === "hybrid" ? "vector" : adapter.strategy));
  return { dataset_digest: stableDigest(dataset), corpus_digest: stableDigest(docs), case_count: cases.length, results,
    provenance: "runtime_executed", adapter_identity_digest: adapter.identity_digest, execution_complete: executed,
    metrics: { recall: results.reduce((n, result) => n + Number(result.recall), 0) / cases.length,
      precision: results.reduce((n, result) => n + Number(result.precision), 0) / cases.length,
      negative_case_count: cases.filter(item => item.expected_ids.length === 0).length,
      false_positive_count: results.reduce((n, result) => n + Number(result.false_positive_count), 0),
      no_answer_false_positive_count: results.reduce((n, result) => n + Number(result.no_answer_false_positive_count), 0),
      abstention_accuracy: cases.some(item => item.expected_ids.length === 0)
        ? results.filter((_, index) => cases[index]!.expected_ids.length === 0).reduce((n, result) => n + Number(result.abstained), 0) / cases.filter(item => item.expected_ids.length === 0).length : null,
      mrr: results.reduce((n, result) => n + Number(result.reciprocal_rank), 0) / cases.length,
      cross_project_leak_count: results.reduce((n, result) => n + Number(result.cross_project_leak_count), 0),
      latency_ms: Math.max(...results.map(result => Number(result.latency_ms))), cost_usd: measuredCost }, content_free: true };
}
