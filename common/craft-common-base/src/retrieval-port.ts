/** Compatibility entry. Local readers import keyword-retrieval without HTTP or SQLite providers. */
export type { RetrievalHit, RetrievalExecution, RetrievalPort } from "./retrieval-contract.ts";
export { KeywordRetrievalPort } from "./keyword-retrieval.ts";
export { OpenAiCompatibleEmbeddingRetrievalPort } from "./embedding-retrieval.ts";
export { temporalMemorySelect } from "./memory-temporal-policy.ts";
