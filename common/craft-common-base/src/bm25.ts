import { text } from "./validation.ts";

/** Characters that make a token an identifier rather than a word. */
const IDENTIFIER = /[A-Za-z]*\d|^[0-9a-f]{8,}$|[-_/.:]{1}/u;

function tokenize(value: string): string[] {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  return value.toLowerCase().split(/[^\p{L}\p{N}_.:/-]+/u).map(token => token.replace(/^[.:/]+|[.:/]+$/gu, "")).filter(Boolean).flatMap(word =>
    /\p{Script=Han}/u.test(word) ? [...segmenter.segment(word)].filter(part => part.isWordLike).map(part => part.segment) : [word]);
}

/** BM25 corpus with an inverted posting map, so scoring visits matching documents only. */
export class Bm25Index {
  readonly #entries = new Map<string, { length: number; joined: string }>();
  #totalLength = 0;
  readonly #documentFrequency = new Map<string, number>();
  readonly #postings = new Map<string, Map<string, number>>();
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
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    this.#entries.set(key, { length: tokens.length, joined: tokens.join(" ") });
    this.#totalLength += tokens.length;
    for (const [term, frequency] of frequencies) {
      this.#documentFrequency.set(term, (this.#documentFrequency.get(term) ?? 0) + 1);
      const posting = this.#postings.get(term) ?? new Map<string, number>();
      posting.set(key, frequency);
      this.#postings.set(term, posting);
    }
  }

  #averageLength(): number { return this.#totalLength / this.#entries.size; }

  score(query: string): Array<{ id: string; score: number; exact_identifier: boolean }> {
    const terms = tokenize(text(query, "query"));
    if (!terms.length || !this.#entries.size) return [];
    const total = this.#entries.size;
    const queryIdentifiers = terms.filter(term => IDENTIFIER.test(term));
    const scores = new Map<string, number>();
    const averageLength = this.#averageLength();
    for (const term of terms) {
      const posting = this.#postings.get(term);
      if (!posting) continue;
      const df = this.#documentFrequency.get(term)!;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      for (const [id, frequency] of posting) {
        const entry = this.#entries.get(id)!;
        const contribution = idf * ((frequency * (this.#k1 + 1)) / (frequency + this.#k1 * (1 - this.#b + this.#b * (entry.length / averageLength))));
        scores.set(id, (scores.get(id) ?? 0) + contribution);
      }
    }
    const results: Array<{ id: string; score: number; exact_identifier: boolean }> = [];
    for (const [id, score] of scores) {
      const exact = queryIdentifiers.some(term => this.#entries.get(id)!.joined.includes(term));
      results.push({ id, score: score + (exact ? 10 : 0), exact_identifier: exact });
    }
    return results.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  }
}
