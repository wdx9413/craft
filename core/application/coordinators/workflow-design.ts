import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { object, text } from "../../validation.ts";

export const DESIGN_QUESTIONS = [
  ["example", "最近一次，你怎样完成这件重复工作？"],
  ["trigger", "什么情况触发？重复触发怎样识别？"],
  ["inputs", "输入来自哪里？缺失或重复时怎样处理？"],
  ["steps", "具体步骤是什么？哪些判断必须由人决定？"],
  ["outputs", "交付物给谁、放在哪里？怎样验证内容正确？"],
  ["limits", "允许做什么？时间、费用和重试上限是多少？"],
  ["failure", "失败或结果未知时怎样停止、对账和交接？哪些操作可恢复或补偿？"],
  ["samples", "分别写出正常、空值、重复、失败样例及预期结果。"],
] as const;

/** Human design is persistent but never an execution or Experience authority. */
export class WorkflowDesignWorkbench {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  save(args: JsonObject): JsonObject {
    const scope = text(args.scope, "scope"), name = text(args.name, "name");
    const answers = object(args.answers, "answers");
    const allowed = new Set<string>(DESIGN_QUESTIONS.map(([key]) => key));
    for (const [key, value] of Object.entries(answers)) {
      if (!allowed.has(key) || typeof value !== "string" || value.length > 8000) throw new Error("Invalid design answer");
    }
    if (!/^(project|user|task):.+$/u.test(scope) || name.length > 200) throw new Error("Explicit design scope and bounded name required");
    if (/(?:api[_-]?key|password|secret|authorization|cookie|token)["']?\s*[:=]\s*[^\s]{6,}/iu.test(JSON.stringify({ name, answers }))) throw new Error("Design must not contain credentials");
    const id = args.design_id === undefined ? `workflow_design_${randomUUID()}` : text(args.design_id, "design_id");
    return this.store.transaction(() => {
      const current = this.store.find("workflow_design", id);
      if (current && (current.scope !== scope || args.expected_version !== current.version)) throw new Error("Design scope or version conflict; reload before saving");
      if (!current && args.expected_version !== undefined) throw new Error("Design no longer exists");
      const value = { name, scope, answers, author: "user", lifecycle: "draft", execution_authorized: false, routeable: false };
      const design = current ? this.store.save("workflow_design", id, value) : this.store.create("workflow_design", id, value);
      return this.describe(design);
    });
  }
  get(args: JsonObject): JsonObject {
    const design = this.store.get("workflow_design", text(args.design_id, "design_id"));
    if (design.scope !== text(args.scope, "scope")) throw new Error("Design scope mismatch");
    return this.describe(design);
  }
  list(args: JsonObject): JsonObject {
    const scope = text(args.scope, "scope");
    const designs = this.store.list("workflow_design", 101, item => item.scope === scope);
    return { question_catalog: DESIGN_QUESTIONS.map(([key, question]) => ({ key, question })), designs: designs.slice(0, 100).map(item => this.describe(item)), truncated: designs.length > 100 };
  }
  private describe(design: JsonObject): JsonObject {
    const answers = design.answers as Record<string, string>;
    const questions = DESIGN_QUESTIONS.filter(([key]) => !answers[key]?.trim()).map(([key, question]) => ({ key, question }));
    const markdown = [`# ${design.name}`, `范围：${design.scope}`, `版本：${design.version}；设计草稿，尚未执行或验证。`,
      ...DESIGN_QUESTIONS.map(([key, question]) => `## ${question}\n\n${answers[key]?.trim() || "待确认"}`),
      "## 交接\n\n先核对样例、未决问题和权限，再接入现有工作流实现与验收。此规格不是已验证经验，不授予执行权限。"].join("\n\n");
    return { design, questions, next_question: questions[0] ?? null, status: questions.length ? "needs_input" : "ready_for_review", markdown,
      execution_authorized: false, acceptance_status: "not_evaluated" };
  }
}
