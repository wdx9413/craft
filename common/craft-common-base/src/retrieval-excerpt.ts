export interface RetrievalExcerpt {
  text: string;
  source_start: number | null;
  source_end: number | null;
  source_chars: number;
  reason: "complete" | "matched_passage" | "no_lexical_match" | "requires_expansion";
  /** Bounded exact query terms, for ranking a reference; never instruction text. */
  matched_terms?: string[];
}

function terms(value: string): string[] {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  return value.toLowerCase().split(/[^\p{L}\p{N}_.:/-]+/u)
    .map(token => token.replace(/^[.:/]+|[.:/]+$/gu, "")).filter(Boolean)
    .flatMap(word => /\p{Script=Han}/u.test(word)
      ? [...segmenter.segment(word)].filter(part => part.isWordLike).map(part => part.segment)
      : [word]);
}

function sentenceSegments(value: string): Array<{ segment: string; index: number }> {
  const result: Array<{ segment: string; index: number }> = [];
  const boundary = /[。！？!?\n]+|\.(?=\s|$)/gu;
  let start = 0, match: RegExpExecArray | null;
  while ((match = boundary.exec(value)) !== null) {
    const end = boundary.lastIndex;
    const leading = /^\s*/u.exec(value.slice(start, end))![0].length;
    if (end > start + leading) result.push({ segment: value.slice(start + leading, end), index: start + leading });
    start = end;
  }
  const leading = /^\s*/u.exec(value.slice(start))![0].length;
  if (start + leading < value.length) result.push({ segment: value.slice(start + leading), index: start + leading });
  return result;
}

/** Return a complete query-bearing sentence. Oversized sentences expose only their
 * source range for explicit expansion; arbitrary windows can invert instructions. */
export function retrievalExcerpt(value: string, query: string, maxChars = 600): RetrievalExcerpt {
  if (typeof value !== "string" || typeof query !== "string") throw new Error("Excerpt source and query must be strings");
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("Excerpt maxChars must be a positive integer");
  if (value.length <= maxChars) return { text: value, source_start: 0, source_end: value.length, source_chars: value.length, reason: "complete" };

  const queryTerms = [...new Set(terms(query))];
  const segments = sentenceSegments(value);
  const ranked = segments.map(part => {
    const sentenceTerms = new Set(terms(part.segment));
    const matches = queryTerms.filter(term => sentenceTerms.has(term));
    return { text: part.segment, start: part.index, score: matches.length, terms: matches };
  }).filter(part => part.score > 0)
    .sort((left, right) => right.score - left.score || left.start - right.start);
  const best = ranked[0];
  if (!best) return { text: "", source_start: null, source_end: null, source_chars: value.length, reason: "no_lexical_match" };

  const start = best.start, end = start + best.text.length;
  if (best.text.length > maxChars) {
    return { text: "", source_start: start, source_end: end, source_chars: value.length, reason: "requires_expansion",
      matched_terms: best.terms.filter(term => term.length <= 64).slice(0, 8) };
  }
  return { text: value.slice(start, end), source_start: start, source_end: end, source_chars: value.length, reason: "matched_passage" };
}
