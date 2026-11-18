import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEvolutionValue, EVOLUTION_VALUE_ACTIONS } from "../core/evolution-value-gate.ts";

test("value gate emits only declared actions with deterministic provenance", () => {
  assert.equal(EVOLUTION_VALUE_ACTIONS.length, 6);
  const first = evaluateEvolutionValue({ statement: "本项目约定：提交前必须运行 pnpm test。", domain: "coding" });
  const second = evaluateEvolutionValue({ statement: "本项目约定：提交前必须运行 pnpm test。", domain: "coding" });
  assert.equal(first.action, "store_as_fact");
  assert.equal(first.reason, "explicit rule or convention");
  assert.equal(first.digest, second.digest);
  assert.equal((first.scope as Record<string, unknown>).domain, "coding");
  assert.equal(first.gate_version, "evolution-value-gate.v1");
});

test("value gate rejects secrets, opt-outs and ordinary chatter", () => {
  const braces = String.fromCharCode(123, 123);
  assert.equal(evaluateEvolutionValue({ statement: `api_key=${braces}SECRET_abc123${braces}` }).action, "ignore");
  assert.equal(evaluateEvolutionValue({ statement: "这件事不要记住" }).action, "ignore");
  assert.equal(evaluateEvolutionValue({ statement: "帮我打开网页然后点击登录" }).action, "ignore");
});

test("value gate gates inferred candidates and classifications", () => {
  assert.equal(evaluateEvolutionValue({ statement: "我偏好深色模式" }).action, "store_as_preference");
  assert.equal(evaluateEvolutionValue({ statement: "如何操作 PPT：先打开文件，再选择模板，最后导出", verification: "passed" }).action, "candidate_procedure");
  assert.equal(evaluateEvolutionValue({ statement: "如何操作 PPT：先打开文件，再选择模板" }).action, "needs_review");
  assert.equal(evaluateEvolutionValue({ statement: "页面登录失败", source_kind: "failure", evidence_ids: [{ kind: "evidence", id: "e1" }] }).action, "candidate_mod");
  assert.equal(evaluateEvolutionValue({ statement: "页面登录失败", source_kind: "failure" }).action, "needs_review");
});

test("value gate binds candidates to device, directory and file Craft Notes refs", () => {
  const noteRefs = [
    { member: "craft_notes", subject_type: "device", id: "device-note", version: 1 },
    { member: "craft_notes", subject_type: "directory", id: "directory-note", version: 2 },
    { member: "craft_notes", subject_type: "file", id: "file-note", version: 3 },
  ];
  const result = evaluateEvolutionValue({ statement: "本项目约定：提交前运行 pnpm test。", domain: "coding",
    device_id: "laptop", path: "/work/craft", note_refs: noteRefs });
  assert.equal(result.action, "store_as_fact");
  assert.deepEqual(result.scope, { domain: "coding", device_id: "laptop", path: "/work/craft", note_refs: noteRefs });
  assert.deepEqual(result.note_refs, noteRefs);
});
