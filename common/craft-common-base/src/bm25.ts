import { text } from "./validation.ts";

/** Characters that make a token an identifier rather than a word. */
const IDENTIFIER = /[A-Za-z]*\d|^[0-9a-f]{8,}$|[-_/.:]{1}/u;

function tokenize(value: string): string[] {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  return value.toLowerCase().split(/[^\p{L}\p{N}_.:/-]+/u).map(token => token.replace(/^[.:/]+|[.:/]+$/gu, "")).filter(Boolean).flatMap(word =>
    /\p{Script=Han}/u.test(word) ? [...segmenter.segment(word)].filter(part => part.isWordLike).map(part => part.segment) : [word]);
}

/**
 * BM25 over a small corpus.
 *
 * Craft's existing rerank() is substring scoring with an exact-name boost. It
 * has no notion of term rarity, so a query containing a common word is dominated
 * by that word. BM25 weights a term by how rare it is in the corpus, which is
 * what makes `TS-999` find the one record that mentions it.
 *
 * The identifier boost is the Contextual-Retrieval lesson applied to Craft's
 * own data: digests, ticket ids and record kinds are exactly where embeddings
 * fail, so an exact identifier hit must outrank a semantic near-miss.
 */
export class Bm25Index {
  // Tokens and their length live in one entry so a document can never be
  // half-registered, which removes the need for defensive fallbacks in score().
  readonly #entries = new Map<string, { tokens: string[]; length: number }>();
  #totalLength = 0;
  readonly #documentFrequency = new Map<string, number>();

  /** Standard BM25 saturation and length-normalisation constants. */
  readonly #k1: number;
  readonly #b: number;

  constructor(options: { k1?: number; b?: number } = {}) {
    this.#k1 = options.k1 ?? 1.2;
    this.#b = options.b ?? 0.75;
    if (!(this.#k1 > 0)) throw new Error("BM25 k1 must be positive");
    if (!(this.#b >= 0 && this.#b <= 1)) throw new Error("BM25 b must be between 0 and 1");
  }

  get size(): number { return this.#entries.size; }

  add(id: string, value: string): void {
    const key = text(id, "id");
    if (this.#entries.has(key)) throw new Error(`BM25 document ${key} already exists`);
    const tokens = tokenize(text(value, "value"));
    this.#entries.set(key, { tokens, length: tokens.length });
    this.#totalLength += tokens.length;
    for (const term of new Set(tokens)) {
      this.#documentFrequency.set(term, (this.#documentFrequency.get(term) ?? 0) + 1);
    }
  }

  /**
   * Mean document length. Only ever called with at least one document — score()
   * returns early on an empty index — so there is no empty-corpus case to guard.
   */
  #averageLength(): number {
    return this.#totalLength / this.#entries.size;
  }

  score(query: string): Array<{ id: string; score: number; exact_identifier: boolean }> {
    const terms = tokenize(text(query, "query"));
    if (!terms.length || !this.#entries.size) return [];
    const total = this.#entries.size;
    const queryIdentifiers = terms.filter((term) => IDENTIFIER.test(term));
    const results: Array<{ id: string; score: number; exact_identifier: boolean }> = [];

    for (const [id, entry] of this.#entries) {
      const frequencies = new Map<string, number>();
      for (const token of entry.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      let score = 0;
      for (const term of terms) {
        const frequency = frequencies.get(term) ?? 0;
        // A term absent from this document contributes nothing. A term present
        // in the document was necessarily indexed, so its document frequency is
        // always defined; score() never has to invent one.
        if (!frequency) continue;
        const df = this.#documentFrequency.get(term) as number;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        score += idf * ((frequency * (this.#k1 + 1)) / (frequency + this.#k1 * (1 - this.#b + this.#b * (entry.length / this.#averageLength()))));
      }
      if (score <= 0) continue;
      // The join is what the identifier boost keys off.
      const joined = entry.tokens.join(" ");
      const exact = queryIdentifiers.some((term) => joined.includes(term));
      if (exact) score += 10;
      results.push({ id, score, exact_identifier: exact });
    }
    return results.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  }
}
