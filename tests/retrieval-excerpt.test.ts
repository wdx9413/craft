import assert from "node:assert/strict";
import test from "node:test";
import { retrievalExcerpt } from "../common/craft-common-base/src/retrieval-excerpt.ts";

test("short retrieval content remains complete", () => {
  assert.deepEqual(retrievalExcerpt("短事实。", "事实", 10), {
    text: "短事实。", source_start: 0, source_end: 4, source_chars: 4, reason: "complete",
  });
});

test("long Chinese content returns the most query-relevant sentence with source offsets", () => {
  const source = "发布前备份。无关的历史说明。冲突时先核对文件摘要，再决定是否覆盖。发布后执行回归测试。";
  const result = retrievalExcerpt(source, "冲突 文件摘要", 25);
  assert.equal(result.text, "冲突时先核对文件摘要，再决定是否覆盖。");
  assert.equal(source.slice(result.source_start!, result.source_end!), result.text);
  assert.equal(result.source_chars, source.length);
  assert.equal(result.reason, "matched_passage");
});

test("a long matching sentence requires expansion of its complete source range", () => {
  const source = `前缀。${"背景说明 ".repeat(30)}关键配置${" 后续说明".repeat(30)}。尾部。`;
  const result = retrievalExcerpt(source, "关键配置", 40);
  assert.equal(result.text, "");
  assert.equal(result.reason, "requires_expansion");
  assert.equal(source.slice(result.source_start!, result.source_end!), source.slice(3, -3));
});

test("a long semantic-only hit is not replaced with an unverified prefix", () => {
  const result = retrievalExcerpt("旧版本说明。".repeat(100), "current rollout", 50);
  assert.equal(result.text, "");
  assert.equal(result.source_start, null);
  assert.equal(result.source_end, null);
  assert.equal(result.reason, "no_lexical_match");
});

test("sentence ranking uses query coverage and stable source order", () => {
  const source = "update delayed. update succeeded after cache flush. update delayed again.";
  const result = retrievalExcerpt(source, "update cache flush", 40);
  assert.equal(result.text, "update succeeded after cache flush.");
  assert.equal(source.slice(result.source_start!, result.source_end!), result.text);
});

test("over-budget prohibitions and conditions never become cropped affirmative instructions", () => {
  for (const prefix of ["不要在未满足以下条件时", "只有在以下条件全部满足后才能", "本项目约定仅允许在"]) {
    const sentence = prefix + "背景说明 ".repeat(30) + "执行 Redis 清理。";
    const source = `无关背景。${sentence}其他说明。`;
    const result = retrievalExcerpt(source, "Redis", 60);
    assert.equal(result.text, "");
    assert.equal(result.reason, "requires_expansion");
    assert.equal(source.slice(result.source_start!, result.source_end!), sentence);
  }
  const sentence = `不要跳过以下校验；${"背景说明 ".repeat(30)}执行 Redis 清理。`;
  assert.equal(retrievalExcerpt(sentence, "Redis", 60).source_start, 0);
  assert.equal(retrievalExcerpt(sentence, "Redis", 60).reason, "requires_expansion");
});

test("complete sentence excerpts retain emoji and words without arbitrary character windows", () => {
  const sentence = "Redis 清理前必须检查 😀 与 abcdef。";
  const source = `无关说明。${sentence}尾部补充说明。`;
  assert.equal(retrievalExcerpt(source, "Redis", sentence.length).text, sentence);
  assert.equal(retrievalExcerpt(source, "Redis", sentence.length - 1).text, "");
});

test("excerpt arguments fail closed", () => {
  assert.throws(() => retrievalExcerpt("x", "q", 0), /positive integer/u);
  assert.throws(() => retrievalExcerpt("x", "q", 1.5), /positive integer/u);
  assert.throws(() => retrievalExcerpt(1 as unknown as string, "q"), /must be strings/u);
  assert.throws(() => retrievalExcerpt("x", null as unknown as string), /must be strings/u);
});

test("sentence parsing ignores empty whitespace runs and whitespace-only tails", () => {
  assert.equal(retrievalExcerpt(`${" ".repeat(1)}\n${"z".repeat(100)}`, "missing", 10).reason, "no_lexical_match");
  assert.equal(retrievalExcerpt(" ".repeat(100), "missing", 10).reason, "no_lexical_match");
});
