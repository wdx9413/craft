import { assertReviewVerificationsStopped } from "./work-review-verification.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { digestJson, payload, stableDigest } from "./digest.ts";
import { object, text } from "./validation.ts";
import { assertTaskAssignmentOwner } from "./task-assignment.ts";
import { assertExecutionRootActive, registerExecutionFence } from "./task-execution-fence.ts";
import { workRetryPolicy } from "./work-retry-policy.ts";
import { workAttemptBudget } from "./work-attempt-budget.ts";

function safe(value: unknown, name: string): string { const id = text(value, name); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error(`${name} must be a safe identifier`); return id; }
function sourceState(store: CraftStore, launchId: string): JsonObject {
  const launch = store.get("work_launch", launchId), task = store.get("task", String(launch.task_id));
  assertReviewVerificationsStopped(store, String(task.id));
  assertExecutionRootActive(store, launch);
  if (store.list("work_launch", 1, item => item.retry_of === launch.id).length) throw new Error("Replan must target the latest attempt");
  if (launch.deferred_start === true || launch.activation_plan_id) throw new Error("Managed or activation-bound work requires its original planning entry");
  const rootId = workRetryPolicy(store, launch).root_launch_id;
  for (const related of store.list("work_launch", Number.MAX_SAFE_INTEGER, item => item.task_id === task.id)) {
    if (workRetryPolicy(store, related).root_launch_id !== rootId) continue;
    const run = related.run_id ? store.get("host_run", String(related.run_id)) : null;
    if (run && (!["completed", "failed", "cancelled", "interrupted"].includes(String(run.status)) || run.cleanup_unconfirmed === true || (run.status === "interrupted" && (run.stopped_confirmation as JsonObject | undefined)?.source !== "explicit_operator_confirmation"))) throw new Error("Confirm original execution and cleanup have stopped before replanning");
    if (store.list("budget_reservation", 1, item => item.budget_id === `internal_budget_${related.dispatch_id}` && item.status === "reserved").length) throw new Error("Replan cannot discard unresolved model cost");
  }
  const host = launch.run_id ? store.get("host_run", String(launch.run_id)) : null;
  const plan = launch.acceptance_plan_id ? store.get("acceptance_plan", String(launch.acceptance_plan_id)) : null;
  const assessment = plan ? store.find("acceptance_assessment", `assessment_${plan.id}`) : null;
  const budget = workAttemptBudget(store, launch);
  if (!(budget?.exhausted || (host && ["failed", "cancelled", "interrupted"].includes(String(host.status))) || (host?.status === "completed" && assessment?.plan_version === plan?.version && ["failed", "blocked"].includes(String(assessment?.status))) || launch.status === "denied")) throw new Error("Replan requires stopped failed work or an exhausted budget");
  const runs = store.list("task_run", 2, item => item.launch_id === launch.id);
  if (runs.length > 1) throw new Error("Replan source has ambiguous Task Runs");
  const run = runs[0] ?? null;
  const contract = run ? store.get("task_control_contract", String(run.contract_id)) : null;
  const assignment = store.find("task_assignment", `task_assignment_${task.id}`);
  const scopedBudget = contract?.budget_account ? store.get("budget_account", String((contract.budget_account as JsonObject).id)) : null;
  const stableBudget = budget ? Object.fromEntries(["root_launch_id", "total_timeout_ms", "total_budget_usd", "deadline_at", "spent_usd", "reserved_usd", "remaining_usd", "unknown_reservations"].map(key => [key, budget[key]])) : null;
  return { contract_ref: contract ? { id: contract.id, version: contract.version, status: contract.status } : null, assignment_ref: assignment ? { id: assignment.id, version: assignment.version, owner: assignment.owner, status: assignment.status } : null, scoped_budget_ref: scopedBudget ? { id: scopedBudget.id, version: scopedBudget.version, status: scopedBudget.status } : null, task_id: task.id, task_version: task.version, launch_id: launch.id, launch_version: launch.version, host_run_id: host?.id ?? null, host_run_version: host?.version ?? null, task_run_id: run?.id ?? null, task_run_version: run?.version ?? null, plan_id: plan?.id ?? null, plan_version: plan?.version ?? null, root_launch_id: rootId, source_finished_at: host?.finished_at ?? launch.created_at, budget: stableBudget };
}
function evidenceSnapshot(store: CraftStore, refs: JsonObject[], taskId: string, since: unknown, type: string): JsonObject[] {
  const minimum = Date.parse(String(since));
  if (!Number.isFinite(minimum)) throw new Error("Replan source lacks a valid stopped timestamp");
  if (!refs.length || refs.length > 20 || new Set(refs.map(ref => ref.id)).size !== refs.length) throw new Error("Replan requires 1 to 20 unique evidence references");
  return refs.map(ref => {
    const evidence = store.get("evidence", text(ref.id, "evidence.id"));
    const metadata = evidence.metadata as JsonObject;
    const observed = Date.parse(String(evidence.observed_at));
    if (evidence.version !== ref.version || metadata.task_id !== taskId || metadata.revoked === true || metadata.retracted === true || !Number.isFinite(observed) || observed < minimum || observed > Date.now() || !["confirmed", "bounded"].includes(String(evidence.confidence))) throw new Error("Replan evidence is stale, revoked, unbound or not yet observed");
    if (type !== "plan_change" && (evidence.source_type !== "program" || evidence.confidence !== "confirmed" || evidence.record_origin === "caller_asserted")) throw new Error("Repair or new-evidence replans require confirmed program evidence");
    if (store.find("task_replan_evidence_use", digestJson([taskId, evidence.id, evidence.version]))) throw new Error("Replan evidence has already authorized another plan");
    return { id: evidence.id, version: evidence.version, digest: digestJson(payload(evidence)) };
  });
}
function validateProposal(store: CraftStore, proposal: JsonObject, actor: unknown): JsonObject {
  assertTaskAssignmentOwner(store, String(proposal.task_id), actor);
  const expires = Date.parse(String(proposal.expires_at));
  if (!Number.isFinite(expires) || Date.now() >= expires) throw new Error("Replan approval expired; prepare a current proposal");
  const source = sourceState(store, String(proposal.source_launch_id));
  if (digestJson(source) !== proposal.source_digest) throw new Error("Replan source changed; prepare a current proposal");
  const evidence = evidenceSnapshot(store, proposal.evidence_refs as JsonObject[], String(proposal.task_id), source.source_finished_at, String(proposal.change_type));
  if (digestJson(evidence) !== proposal.evidence_digest) throw new Error("Replan evidence changed");
  const fence = store.get("task_execution_fence", `task_execution_fence_${proposal.task_id}`);
  if (fence.version !== proposal.fence_version) throw new Error("Replan fence changed; continue the approved plan");
  return source;
}
export function prepareTaskReplan(store: CraftStore, args: JsonObject, makeEvidence: (args: JsonObject) => JsonObject): JsonObject {
  const id = safe(args.proposal_id, "proposal_id"), newRunId = safe(args.new_task_run_id, "new_task_run_id");
  const actor = text(args.actor, "actor"), summary = text(args.change_summary, "change_summary"), prompt = text(args.prompt, "prompt");
  if (prompt.length > 128000 || summary.length > 8000) throw new Error("Replan instructions or change summary exceed their size limit");
  const type = text(args.change_type, "change_type");
  if (!["plan_change", "environment_repair", "new_evidence"].includes(type)) throw new Error("Replan change_type is unsupported");
  const refs = args.evidence_refs === undefined ? [] : (Array.isArray(args.evidence_refs) ? args.evidence_refs.map(value => object(value, "evidence_ref")) : (() => { throw new Error("evidence_refs must be an array"); })());
  const requestDigest = stableDigest({ ...args, prompt: digestJson(prompt) });
  return store.transaction(() => {
    const existing = store.find("task_replan_proposal", id);
    if (existing) { if (existing.request_digest !== requestDigest) throw new Error("Replan proposal idempotency conflict"); return { proposal: existing, idempotent: true }; }
    const source = sourceState(store, text(args.source_launch_id, "source_launch_id"));
    if (source.task_version !== args.task_version || source.launch_version !== args.launch_version || source.host_run_version !== (args.host_run_version ?? null)) throw new Error("Replan source version changed");
    assertTaskAssignmentOwner(store, String(source.task_id), actor);
    const launch = store.get("work_launch", String(source.launch_id));
    registerExecutionFence(store, launch, true);
    const fence = store.get("task_execution_fence", `task_execution_fence_${source.task_id}`);
    const budget = source.budget as JsonObject | null;
    const timeout = args.total_timeout_ms ?? budget?.total_timeout_ms ?? null, usd = args.total_budget_usd ?? budget?.total_budget_usd ?? null;
    if (timeout !== null && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 86400000)) throw new Error("New total_timeout_ms must be between 1000 and 86400000");
    if (usd !== null && (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0)) throw new Error("New total_budget_usd must be positive and finite");
    if (usd !== null && launch.host !== "internal") throw new Error("Cumulative USD replanning requires the internal Host");
    const run = source.task_run_id ? store.get("task_run", String(source.task_run_id)) : null;
    if (run && (run.environment_digest !== digestJson(args.environment ?? {}) || run.budget_digest !== digestJson(args.budget ?? {}))) throw new Error("Replan requires the source environment and budget snapshots");
    const actualRefs = [...refs];
    if (type === "plan_change" && !actualRefs.length) {
      const evidence = makeEvidence({ evidence_id: `evidence_replan_${id}`, source_type: "human", confidence: "bounded", claim: summary, locator: `task-replan:${id}`, metadata: { task_id: source.task_id, source_launch_id: source.launch_id, prompt_digest: digestJson(prompt), basis: "operator_reported_plan_change" } });
      actualRefs.push({ id: evidence.id, version: evidence.version });
    }
    const evidence = evidenceSnapshot(store, actualRefs, String(source.task_id), source.source_finished_at, type);
    const proposal = store.create("task_replan_proposal", id, { task_id: source.task_id, source_launch_id: source.launch_id, source_digest: digestJson(source), source_snapshot: source, fence_version: fence.version, actor, change_type: type, change_summary: summary, prompt_digest: digestJson(prompt), instruction: prompt, new_task_run_id: newRunId, new_launch_id: `replan_launch_${newRunId}`, total_timeout_ms: timeout, total_budget_usd: usd, environment_digest: digestJson(args.environment ?? {}), budget_digest: digestJson(args.budget ?? {}), evidence_refs: evidence, evidence_digest: digestJson(evidence), status: "pending", expires_at: new Date(Date.now() + 3600000).toISOString(), request_digest: requestDigest });
    store.appendEvent(`task:${source.task_id}`, "task.replan_proposed", { proposal_id: proposal.id, actor, evidence_refs: evidence, source_launch_id: source.launch_id });
    return { proposal, idempotent: false };
  });
}
export function decideTaskReplan(store: CraftStore, args: JsonObject): JsonObject {
  const actor = text(args.actor, "actor"), decision = text(args.decision, "decision");
  if (!["approve", "reject", "revoke"].includes(decision)) throw new Error("Replan decision is unsupported");
  const digest = stableDigest(args);
  return store.transaction(() => {
    const proposal = store.get("task_replan_proposal", text(args.proposal_id, "proposal_id"));
    if (proposal.decision_digest === digest) return { proposal, idempotent: true };
    if (proposal.version !== args.proposal_version) throw new Error("Replan proposal version changed");
    assertTaskAssignmentOwner(store, String(proposal.task_id), actor);
    if ((decision === "revoke" ? proposal.status !== "approved" : proposal.status !== "pending")) throw new Error("Replan decision does not match proposal state");
    if (decision === "approve") { if (args.confirmed_new_plan_and_budget !== true) throw new Error("Approval requires explicit new plan and budget confirmation"); validateProposal(store, proposal, actor); }
    const saved = store.save("task_replan_proposal", String(proposal.id), { ...payload(proposal), status: decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "revoked", decided_by: actor, decision_digest: digest });
    store.appendEvent(`task:${proposal.task_id}`, `task.replan_${decision}`, { proposal_id: proposal.id, actor });
    return { proposal: saved, idempotent: false };
  });
}
export function consumeTaskReplan(store: CraftStore, args: JsonObject, execute: (proposal: JsonObject, source: JsonObject) => JsonObject): JsonObject {
  const actor = text(args.actor, "actor");
  return store.transaction(() => {
    const proposal = store.get("task_replan_proposal", text(args.proposal_id, "proposal_id"));
    const prompt = text(args.prompt ?? proposal.instruction, "prompt");
    if (proposal.prompt_digest !== digestJson(prompt) || proposal.environment_digest !== digestJson(args.environment ?? {}) || proposal.budget_digest !== digestJson(args.budget ?? {})) throw new Error("Execution does not match the approved replan");
    const consumed = store.find("task_replan_consumption", String(proposal.id));
    if (consumed) { assertTaskAssignmentOwner(store, String(proposal.task_id), actor); return { consumption: consumed, launch: store.get("work_launch", String(consumed.launch_id)), task_run: store.get("task_run", String(consumed.task_run_id)), idempotent: true }; }
    if (proposal.status !== "approved" || proposal.version !== args.proposal_version) throw new Error("Replan requires its exact approved version");
    const source = validateProposal(store, proposal, actor);
    const prepared = execute(proposal, source);
    const fence = store.get("task_execution_fence", `task_execution_fence_${proposal.task_id}`);
    store.save("task_execution_fence", String(fence.id), { ...payload(fence), active_root_launch_id: proposal.new_launch_id, generation: Number(fence.generation) + 1, proposal_id: proposal.id });
    for (const ref of proposal.evidence_refs as JsonObject[]) store.create("task_replan_evidence_use", digestJson([proposal.task_id, ref.id, ref.version]), { task_id: proposal.task_id, proposal_id: proposal.id, evidence_id: ref.id, evidence_version: ref.version });
    store.save("task_replan_execution_permit", String(proposal.new_launch_id), { status: "consumed", proposal_id: proposal.id, task_id: proposal.task_id });
    const consumption = store.create("task_replan_consumption", String(proposal.id), { proposal_id: proposal.id, task_id: proposal.task_id, task_run_id: proposal.new_task_run_id, launch_id: proposal.new_launch_id, actor });
    store.save("task_replan_proposal", String(proposal.id), { ...payload(proposal), status: "consumed", consumption_id: consumption.id });
    store.appendEvent(`task:${proposal.task_id}`, "task.replan_consumed", { proposal_id: proposal.id, new_task_run_id: proposal.new_task_run_id, actor });
    return { ...prepared, consumption, idempotent: false };
  });
}
