/**
 * Read model for one Attention card: the structured decision package NEEDREAD
 * §2 requires (trigger reason, latest evidence, options, impact, recommended
 * next step and uncertainty). It is derived from the card itself, not stored,
 * so a source-version change cannot leave a stale brief behind.
 */
import type { JsonObject } from "./infrastructure/store.ts";

export interface DecisionOption { id: string; label: string; effect: string; destructive: boolean }

export interface DecisionBrief {
  trigger: string;
  evidence: JsonObject;
  options: DecisionOption[];
  impact: string;
  recommendation: string;
  /** Explicit unknowns; an empty list is only allowed when the source is fully bound. */
  uncertainty: string[];
  /** True when the card's source is a stale or missing reference. */
  source_stale: boolean;
}

const ACTION_OPTIONS: Record<string, DecisionOption[]> = {
  review_authorization: [
    { id: "approve_once", label: "仅批准本次", effect: "consume one action grant", destructive: false },
    { id: "reject", label: "拒绝动作", effect: "deny the pending action", destructive: false },
    { id: "remember", label: "批准并记住", effect: "create a reusable grant", destructive: false },
  ],
  review_work_launch: [
    { id: "approve_launch", label: "批准启动", effect: "start the workspace-write launch", destructive: true },
    { id: "reject_launch", label: "拒绝启动", effect: "deny the launch", destructive: false },
  ],
  complete_acceptance: [
    { id: "accept", label: "接受交付", effect: "record the outcome", destructive: false },
    { id: "rework", label: "要求返工", effect: "open a new attempt", destructive: true },
  ],
  replan_with_evidence: [
    { id: "replan", label: "带证据重新规划", effect: "start a bounded successor", destructive: true },
    { id: "handoff", label: "转交人工", effect: "stop automatic retries", destructive: false },
  ],
  inspect_acceptance_evaluator: [
    { id: "retry_evaluator", label: "重试评测器", effect: "re-run the domain check", destructive: false },
    { id: "handoff", label: "人工核验", effect: "record a human verdict", destructive: false },
  ],
  inspect_maintenance: [
    { id: "retry_component", label: "重试组件", effect: "run one bounded maintenance cycle", destructive: false },
    { id: "pause_component", label: "暂停组件", effect: "suspend background work", destructive: false },
  ],
  review_speculative_candidate: [
    { id: "use_candidate", label: "采用候选", effect: "consume before its expiry", destructive: false },
    { id: "discard", label: "丢弃候选", effect: "release the speculative budget", destructive: false },
  ],
  resume_due_wait: [
    { id: "resume", label: "恢复等待", effect: "resume the durable wait", destructive: false },
    { id: "drop", label: "放弃等待", effect: "retire the recovery item", destructive: false },
  ],
};

const DEFAULT_OPTIONS: DecisionOption[] = [
  { id: "open", label: "打开详情", effect: "inspect the source record", destructive: false },
  { id: "dismiss", label: "稍后处理", effect: "defer this card", destructive: false },
];

function uncertaintyFor(item: JsonObject): string[] {
  const unknown: string[] = [];
  if (item.task_id === undefined || item.task_id === null) unknown.push("卡片未绑定 Task，无法判断与当前工作的关系");
  if (typeof item.source_id !== "string" || typeof item.source_kind !== "string") unknown.push("来源引用缺失，决定前必须刷新");
  const details = item.details && typeof item.details === "object" && !Array.isArray(item.details) ? item.details as JsonObject : {};
  if (details.expires_at !== undefined) unknown.push("候选有有效期，过期后不可再采用");
  if (details.next_retry_at !== undefined) unknown.push("后台重试时间由维护组件决定，非人工即时生效");
  return unknown;
}

export function attentionDecisionBrief(item: JsonObject): DecisionBrief {
  const action = String(item.action ?? "open");
  const options = ACTION_OPTIONS[action] ?? DEFAULT_OPTIONS;
  const recommended = options.find((option) => !option.destructive) ?? options[0]!;
  const destructive = options.filter((option) => option.destructive).length;
  const uncertainty = uncertaintyFor(item);
  const sourceStale = uncertainty.some((line) => line.includes("来源引用缺失"));
  return {
    trigger: String(item.reason ?? "Work currently deserves attention"),
    // The latest evidence is the card's own typed source snapshot, not free text.
    evidence: {
      source_kind: item.source_kind ?? null,
      source_id: item.source_id ?? null,
      source_version: item.source_version ?? null,
      source_status: item.source_status ?? null,
      task_id: item.task_id ?? null,
      details: item.details && typeof item.details === "object" && !Array.isArray(item.details) ? item.details : {},
    },
    options,
    impact: destructive
      ? `${destructive} 个选项会产生写入或返工，批准前须核对来源版本与对象范围`
      : "选项仅改变关注状态或消费一次授权；不改变执行事实",
    recommendation: sourceStale
      ? "先刷新来源，再决定；当前证据不足以批准任何动作"
      : `建议：${recommended.label}（${recommended.effect}）`,
    uncertainty,
    source_stale: sourceStale,
  };
}
