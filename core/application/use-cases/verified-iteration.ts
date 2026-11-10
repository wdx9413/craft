import { createHash, randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { payload } from "../../digest.ts";
import { text } from "../../validation.ts";

function valueDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }

export function assessVerifiedIteration(store: CraftStore, args: JsonObject, validateFeedback: (value: unknown) => string): JsonObject {
  const observed = store.get("verified_iteration", text(args.iteration_id, "iteration_id"));
  if (observed.status !== "active") return { iteration: observed, action: "terminal", idempotent: true };
  return store.transaction(() => {
    const iteration = store.get("verified_iteration", text(args.iteration_id, "iteration_id"));
    if (iteration.status !== "active") return { iteration, action: "terminal", idempotent: true };
    const assessment = store.get("acceptance_assessment", text(args.assessment_id, "assessment_id"));
    const plan = store.get("acceptance_plan", String(iteration.acceptance_plan_id));
    if (assessment.plan_id !== plan.id || assessment.plan_version !== plan.version || assessment.plan_version !== iteration.acceptance_plan_version
      || iteration.acceptance_plan_digest !== valueDigest(payload(plan)))
      throw new Error("Acceptance assessment does not belong to the frozen plan version for this verified iteration");
    if (store.list("iteration_attempt", 10_000, item => item.iteration_id === iteration.id && item.assessment_id === assessment.id).length)
      throw new Error("Acceptance assessment was already consumed by this verified iteration");
    const launch = store.get("work_launch", String(iteration.launch_id));
    const classification = text(args.classification, "classification");
    if (!new Set(["task_failure", "verification_configuration", "environment", "scope_violation", "no_progress"]).has(classification))
      throw new Error("Verified iteration classification is unsupported");
    const attemptNo = Number(iteration.attempts_started) + 1;
    const feedback = validateFeedback(args.feedback ?? `Acceptance ${assessment.status}.`);
    const assessmentDigest = valueDigest({ id: assessment.id, version: assessment.version, plan_id: assessment.plan_id, plan_version: assessment.plan_version,
      status: assessment.status, missing: assessment.missing, failed: assessment.failed, blocked: assessment.blocked, checked: assessment.checked, total: assessment.total });
    const launchDigest = valueDigest({ id: launch.id, version: launch.version, task_id: launch.task_id, host: launch.host, dispatch_id: launch.dispatch_id,
      dispatch_kind: launch.dispatch_kind, workspace: launch.workspace, sandbox: launch.sandbox, prompt_digest: launch.prompt_digest });
    const attempt = store.create("iteration_attempt", String(args.attempt_id ?? id("iteration_attempt")), {
      iteration_id: iteration.id, number: attemptNo, assessment_id: assessment.id, assessment_version: assessment.version,
      assessment_digest: assessmentDigest, acceptance_plan_version: plan.version, launch_version: launch.version, launch_digest: launchDigest,
      assessment_status: assessment.status, classification, feedback_digest: valueDigest(feedback), raw_feedback_stored: false,
    });
    let status = "active", action = "retry", terminalReason: string | null = null;
    if (assessment.status === "passed") { status = "passed"; action = "passed"; terminalReason = "acceptance_passed"; }
    else if (classification === "verification_configuration" || classification === "environment") { status = "blocked"; action = "handoff"; terminalReason = classification; }
    else if (classification === "scope_violation" || classification === "no_progress") { status = "unresolved"; action = "handoff"; terminalReason = classification; }
    else if (attemptNo >= Number(iteration.max_attempts)) { status = "unresolved"; action = "handoff"; terminalReason = "attempt_budget_exhausted"; }
    const saved = store.save("verified_iteration", String(iteration.id), { ...payload(iteration), status, attempts_started: attemptNo,
      last_assessment_id: assessment.id, terminal_reason: terminalReason });
    const next = action === "retry"
      ? { action: "retry", prompt_feedback: feedback, remaining_attempts: Number(saved.max_attempts) - attemptNo, allowed_paths: saved.allowed_paths }
      : { action, reason: terminalReason };
    return { iteration: saved, attempt, next, idempotent: false };
  });
}
