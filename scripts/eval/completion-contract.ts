import type { JsonObject } from "../../core/infrastructure/store.ts";
import { stableDigest } from "../../core/digest.ts";

/** Synthetic observations, independent expected decisions; no production data or scores supplied by a model. */
export const COMPLETION_CASES = [
  { id: "queued", observation: { job_id: "a", status: "queued", file: null }, expected: { outcome: "pending", action: "poll_original" } },
  { id: "ready", observation: { job_id: "b", status: "succeeded", file: { readable: true, range_matches: true } }, expected: { outcome: "completed", action: "deliver" } },
  { id: "sync", observation: { file: { readable: true, range_matches: true } }, expected: { outcome: "completed", action: "deliver" } },
  { id: "failed", observation: { job_id: "c", status: "failed", file: null }, expected: { outcome: "failed", action: "handoff" } },
  { id: "cancelled", observation: { job_id: "d", status: "cancelled", file: null }, expected: { outcome: "cancelled", action: "stop" } },
  { id: "timeout", observation: { job_id: "e", status: "unknown", error: "poll_timeout" }, expected: { outcome: "unknown", action: "reconcile_original" } },
  { id: "duplicate", observation: { existing_job_id: "f", request_key: "same", status: "running" }, expected: { outcome: "pending", action: "poll_original" } },
  { id: "wrong_file", observation: { job_id: "g", status: "succeeded", file: { readable: true, range_matches: false } }, expected: { outcome: "failed", action: "handoff" } },
] as const;

export const COMPLETION_RULE = "受理或任务编号不代表完成。异步任务须成功且文件可读、范围正确；同步直接返回的完整文件无需任务编号。queued/running 跟踪原任务；轮询超时或结果未知先对账原任务；相同请求不得新建重复任务；失败交接；取消停止；文件范围不符不可交付。";
export const COMPLETION_DATASET_DIGEST = stableDigest(COMPLETION_CASES);

export function completionPrompt(candidate: boolean): string {
  return `根据以下已观察的合成导出状态给出下一步，不调用工具或执行任务。输出 JSON：{"decisions":[{"id":"...","outcome":"...","action":"..."}]}。outcome 只能是 pending/completed/failed/cancelled/unknown；action 只能是 poll_original/deliver/handoff/stop/reconcile_original。\n${candidate ? COMPLETION_RULE : "请准确判断任务是否完成并选择下一步。"}\n${JSON.stringify(COMPLETION_CASES.map(({ id, observation }) => ({ id, observation })))}`;
}

export function gradeCompletion(answer: JsonObject | null | undefined): JsonObject {
  const decisions = answer?.decisions;
  if (!Array.isArray(decisions) || decisions.length !== COMPLETION_CASES.length || new Set(decisions.map(d => (d as JsonObject)?.id)).size !== decisions.length) return { status: "invalid", passed: 0, total: COMPLETION_CASES.length, failures: ["missing_or_duplicate_decisions"] };
  const failures = COMPLETION_CASES.filter(item => !decisions.some(raw => {
    const decision = raw as JsonObject;
    return decision?.id === item.id && decision.outcome === item.expected.outcome && decision.action === item.expected.action;
  })).map(item => item.id);
  return { status: failures.length ? "failed" : "passed", passed: COMPLETION_CASES.length - failures.length, total: COMPLETION_CASES.length, failures };
}

/** Caller supplies fresh Host outputs with fingerprints; this never promotes a Procedure. */
export function compareCompletion(runs: JsonObject[]): JsonObject {
  if (runs.length < 6 || runs.length > 200 || runs.length % 2 !== 0) throw new Error("Require 3..100 paired trials");
  const fingerprints = runs.map(run => stableDigest([run.host, run.model, run.budget, run.dataset_digest]));
  if (new Set(fingerprints).size !== 1 || runs.some(run => !run.host || !run.model || !run.budget || run.dataset_digest !== COMPLETION_DATASET_DIGEST)) throw new Error("Paired trial context differs or is missing");
  if (runs.some(run => !Number.isInteger(run.trial) || Number(run.trial) < 0 || !["baseline", "candidate"].includes(String(run.arm))) || new Set(runs.map(run => `${run.trial}:${run.arm}`)).size !== runs.length) throw new Error("Invalid trial identity");
  const trials = [...new Set(runs.map(run => run.trial))];
  if (trials.some(trial => runs.filter(run => run.trial === trial).length !== 2)) throw new Error("Missing trial pair");
  const results = runs.map(run => ({ trial: run.trial, arm: run.arm, output_digest: stableDigest(run.output ?? null), grade: gradeCompletion(run.output as JsonObject) }));
  const score = (arm: string) => results.filter(run => run.arm === arm).reduce((sum, run) => sum + Number(run.grade.passed), 0) / (trials.length * COMPLETION_CASES.length);
  const baseline = score("baseline"), candidate = score("candidate");
  const complete = results.every(run => run.grade.status !== "invalid");
  return { dataset_digest: COMPLETION_DATASET_DIGEST, context_fingerprint: fingerprints[0], paired_trials: trials.length, results, baseline_pass_rate: baseline, candidate_pass_rate: candidate,
    verdict: !complete ? "inconclusive" : candidate < baseline ? "regressed" : candidate > baseline ? "improved_on_fixture" : "no_measured_gain",
    verification_provenance: "host_attested", model_effect_proven: false, production_effect_proven: false, promotion_eligible: false };
}
