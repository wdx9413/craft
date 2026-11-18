import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";
import { evaluateEvolutionValue } from "./evolution-value-gate.ts";

const STEP_PREFIX = /^(?:[\p{Script=Han}A-Za-z\s]{0,12}(?:流程|步骤|操作)|网页操作流程|网页操作步骤|网站操作流程|网站操作步骤|browser\s+(?:workflow|steps)|web\s+(?:workflow|steps)|如何|怎么|步骤|操作|流程|workflow|steps?|how\s+to)(?:[^。.!?]{0,40})[:：]\s*(?:先|first\b|then\b)/iu;
const SECRET = /\{\{\s*[A-Z][A-Za-z0-9_]*\s*\}\}|(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{6,}/iu;
const APPLICABLE_WHEN = ["用户口述的操作步骤"];
const EXCLUDED_WHEN = ["未经人工评审", "未获得独立验证证据"];

export interface UserStatedRunbookInput {
  readonly statement: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly source_refs?: readonly JsonObject[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Extract explicit step declarations without interpreting ordinary task prompts. */
export function extractUserStatedOperatingSteps(value: unknown): string[] {
  const source = text(value);
  if (!source || source.length > 300 || SECRET.test(source) || source.includes("{{")) return [];
  return source.split(/(?<=[。！!？?]\s*)|(?<=[.!?]\s+)/u).map(item => item.trim())
    .some(item => STEP_PREFIX.test(item)) ? [source] : [];
}

function requiredText(value: unknown, name: string): string {
  const result = text(value);
  if (!result || result.length > 1_000 || SECRET.test(result) || /[\0]/u.test(result)) throw new Error(`${name} is missing or unsafe`);
  return result;
}

/** Persist user-stated steps as a diagnostic-only Experience Runbook candidate. */
export function captureUserStatedRunbook(store: CraftStore, input: UserStatedRunbookInput): JsonObject {
  const statement = requiredText(input.statement, "statement");
  if (!extractUserStatedOperatingSteps(statement).length) throw new Error("statement does not contain explicit operating steps");
  const sessionId = requiredText(input.session_id, "session_id");
  const turnId = requiredText(input.turn_id, "turn_id");
  const sourceRefs = Array.isArray(input.source_refs) ? input.source_refs.filter(item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
  if (!sourceRefs.length) throw new Error("source statement reference is required");
  const decision = evaluateEvolutionValue({ statement, source_kind: "user-statement", artifact_refs: sourceRefs, explicit: true, verification: "passed" });
  if (decision.action !== "candidate_procedure") throw new Error("operating steps require a candidate_procedure decision");

  const identity = { kind: "user-stated-runbook", statement, session_id: sessionId, turn_id: turnId, source_refs: sourceRefs.slice(0, 20), gate_digest: decision.digest };
  const id = `experience_procedure_user_runbook_${stableDigest(identity).slice(-20)}`;
  const existing = store.find("experience_procedure", id);
  if (existing) {
    if (existing.identity_digest !== stableDigest(identity)) throw new Error("Runbook candidate idempotency conflict");
    return { procedure: existing, diagnostic_only: true, idempotent: true };
  }
  const prior = store.list("experience_procedure", 1, item => item.user_stated_runbook === true && item.statement === statement);
  if (prior.length) throw new Error("A different Runbook candidate already exists for these operating steps");

  const body = [
    "# " + statement.slice(0, 120), "",
    "> 待验证：用户口述步骤的诊断性 Runbook 候选，不是可执行 Procedure。", "",
    "## 用户原话", statement, "",
    "## 适用条件", ...APPLICABLE_WHEN, "",
    "## 排除条件", ...EXCLUDED_WHEN, "",
    "## 完成标准", "步骤可在同项目中由人工按记录复核", "",
    "## 失败处理", "停止执行并交由人工评审或撤销候选", "",
    "## 来源语句引用", ...sourceRefs.map(item => JSON.stringify(item)), "",
  ].join("\n");
  const contentRef = store.contentStore.writeSync({ kind: "experience", record_id: id, version: 1, scope: "project:self-evolution", status: "candidate",
    sensitivity: "internal", source_id: `user-statement:${sessionId}:${turnId}`, title: statement.slice(0, 120), body, folder: "prompts",
    frontmatter: { runbook_candidate: "true", routeable: "false", diagnostic_only: "true" } });
  const procedure = store.create("experience_procedure", id, { ...identity, version: 1, user_stated_runbook: true, runbook_candidate: true,
    provenance: "user-stated", diagnostic_only: true, lifecycle: "candidate", procedure_kind: "prompt", domain: "coding",
    scenario_signature: { domain: "coding", kind: "user-stated-operating-steps" },
    title: statement.slice(0, 120), scope: "project:self-evolution", project_id: "self-evolution", trigger: statement,
    applies_when: APPLICABLE_WHEN.join("；"), exclude_when: EXCLUDED_WHEN.join("；"), pitfall: `用户口述步骤尚未经过独立验证：${statement}`,
    correct_method: statement, applies_when_list: APPLICABLE_WHEN, excludes_when: EXCLUDED_WHEN,
    applicable_when: APPLICABLE_WHEN, excluded_when: EXCLUDED_WHEN,
    completion_criteria: "步骤可在同项目中由人工按记录复核", failure_handling: "停止执行并交由人工评审或撤销候选",
    source_statement_refs: sourceRefs, identity_digest: stableDigest(identity), concept_kind: "procedure",
    content_ref: contentRef, content_digest: contentRef.digest, completed_gates: [], routeable: false,
    publication_allowed: false, execution_visible: false });
  return { procedure, diagnostic_only: true, idempotent: false };
}
