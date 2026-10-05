/** Stable local word segmentation shared by the governed cognitive readers. */
export function retrievalTerms(value: string): string[] {
  const words = value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  return [...new Set(words.flatMap((word) => /\p{Script=Han}/u.test(word)
    ? [...segmenter.segment(word)].filter((part) => part.isWordLike).map((part) => part.segment)
    : [word]))];
}
