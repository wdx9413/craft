import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { digestJson } from "./digest.ts";

export const RISK_REVIEW_CRITERION = "risk_independent_review";
const RISKS = new Set(["permission_change", "data_migration", "cross_project_write", "extension_boundary", "asset_promotion", "external_write"]);
/** Structured declaration only: neither prompt classification nor authorization. */
export function reviewRisks(value: unknown, effects: string[]): string[] {
  if (value !== undefined && !Array.isArray(value)) throw new Error("review_risks must be an array");
  const risks = value === undefined ? [] : value as unknown[];
  if (risks.some(risk => typeof risk !== "string" || !RISKS.has(risk)) || new Set(risks).size !== risks.length) throw new Error("review_risks must contain unique supported risks");
  return [...new Set([...(risks as string[]), ...(effects.includes("external_write") ? ["external_write"] : [])])].sort();
}
export function taskReviewRisk(store: CraftStore, taskId: string): JsonObject | null {
  const contracts = store.list("task_control_contract", Number.MAX_SAFE_INTEGER, item => item.task_id === taskId && (item.review_risks !== undefined || (Array.isArray(item.allowed_effects) && item.allowed_effects.includes("external_write"))));
  if (!contracts.length) return null;
  const risks = [...new Set(contracts.flatMap(item => reviewRisks(item.review_risks, (item.allowed_effects as string[] | undefined) ?? [])))].sort();
  if (!risks.length) return null;
  const inputs = contracts.map(item => ({ id: item.id, version: item.version, review_risks: reviewRisks(item.review_risks, (item.allowed_effects as string[] | undefined) ?? []) })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { policy_version: 1, risks, rule_ids: risks.map(risk => `independent_review:${risk}`), input_refs: inputs, input_digest: digestJson(inputs), criterion_id: RISK_REVIEW_CRITERION, decision: "require_frozen_independent_review" };
}
export function riskReviewCriteria(criteria: unknown, risk: JsonObject | null): unknown {
  if (!risk) return criteria;
  if (!Array.isArray(criteria) || !criteria.some(item => item?.method === "program" && item.required !== false)) throw new Error("Risk review requires a mandatory deterministic program acceptance criterion");
  const reserved = criteria.filter(item => item?.id === RISK_REVIEW_CRITERION);
  if (reserved.length > 1 || reserved.some(item => item.method !== "human" || item.required === false)) throw new Error("Risk review criterion cannot be downgraded");
  return reserved.length ? criteria : [...criteria, { id: RISK_REVIEW_CRITERION, name: "风险触发的独立成果审查", method: "human", required: true }];
}
