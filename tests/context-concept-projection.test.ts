import assert from "node:assert/strict";
import test from "node:test";
import { projectKnowledgeRetrieval, projectMemoryRetrieval } from "../core/context-resolution.ts";

test("concept-tagged context hits carry a human-readable selection reason", () => {
  const knowledge = projectKnowledgeRetrieval({
    claim_id: "c1", concept_kind: "rule", content: "Use pnpm, not npm, for this monorepo.",
  }, "pnpm");
  assert.equal(knowledge.concept_kind, "rule");
  assert.equal(knowledge.concept_selection_reason, "团队约定或约束，执行时须遵守");

  const memory = projectMemoryRetrieval({
    memory_id: "m1", concept_kind: "preference", content: "Prefer dark mode.",
  }, "dark", false);
  assert.equal(memory.concept_kind, "preference");
  assert.equal(memory.concept_selection_reason, "可接受选项间的偏好，非强制规则");
});

test("untagged historical records are projected unchanged", () => {
  const item = { claim_id: "legacy", content: "old record" };
  assert.deepEqual(projectKnowledgeRetrieval(item, "old"), item);
  assert.deepEqual(projectMemoryRetrieval({ ...item }, "old", false), { ...item });
});
