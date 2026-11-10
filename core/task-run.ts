import { assertExecutionRootActive, executionRootActive } from "./task-execution-fence.ts";
import { workAttemptBudget } from "./work-attempt-budget.ts";
import { assertTaskAssignmentOwner } from "./task-assignment.ts";
import { workRetryPolicy } from "./work-retry-policy.ts";
import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";
import { GenericCliHostKernel } from "./generic-driver.ts";
import type { HostDriver } from "./host-driver.ts";




function current(store: CraftStore, kind: string, id: unknown): JsonObject { return store.get(kind, text(id, `${kind}_id`)); }
function checkedTaskRun(store: CraftStore, args: JsonObject): JsonObject {
  const run = current(store, "task_run", args.task_run_id);
  if (args.task_run_version !== undefined && (!Number.isSafeInteger(args.task_run_version) || Number(args.task_run_version) < 1 || args.task_run_version !== run.version)) throw new Error("Task Run version changed; refresh before changing its lifecycle");
  return run;
}


/**
 * A small, durable seam over one already-prepared Work Launch. It never plans
 * model work or dispatches an unapproved effect; it turns observed facts into a
 * resumable task-level state and keeps the exact launch contract auditable.
 */
export class TaskRunKernel {
  readonly store: CraftStore;
  readonly hostDrivers: ReadonlyMap<string, HostDriver>;
  constructor(store: CraftStore, hostDrivers: ReadonlyMap<string, HostDriver> = new Map()) { this.store = store; this.hostDrivers = hostDrivers; }

  create(args: JsonObject): JsonObject {
    const contract = current(this.store, "task_control_contract", args.contract_id);
    const launch = current(this.store, "work_launch", args.launch_id);
    if (digestJson([contract.status, contract.launch_id, contract.task_id]) !== digestJson(["active", launch.id, launch.task_id])) throw new Error("Task Run requires an active Task Control contract bound to the Work Launch");
    const dispatchKind = (launch.dispatch_kind as string | undefined)
      ?? ({ "codex-cli": "codex_dispatch", "claude-code": "claude_dispatch" } as Record<string, string>)[String(launch.host)]
      ?? null;
    if (!dispatchKind) throw new Error("Task Run host is unsupported");
    const dispatch = current(this.store, dispatchKind, launch.dispatch_id);
    const environmentDigest = digestJson(args.environment ?? {}); const budgetDigest = digestJson(args.budget ?? {});
    const identity = { contract_id: contract.id, contract_version: contract.version, launch_id: launch.id, launch_identity: { task_id: launch.task_id, host: launch.host, dispatch_id: launch.dispatch_id, workspace: launch.workspace, sandbox: launch.sandbox, prompt_digest: launch.prompt_digest }, dispatch_id: dispatch.id, dispatch_request_digest: dispatch.request_digest, activation_profile: contract.activation_profile ?? null, budget_account: contract.budget_account ?? null, acceptance_plan_id: launch.acceptance_plan_id ?? null, environment_digest: environmentDigest, budget_digest: budgetDigest };
    const runId = String(args.task_run_id ?? `task_run_${launch.id}`); const existing = this.store.find("task_run", runId); const identityDigest = digestJson(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Task Run idempotency conflict"); return { run: existing, idempotent: true }; }
    const stabilityDigest = digestJson({ contract_status: contract.status, contract_version: contract.version, activation_profile: contract.activation_profile ?? null, budget_account: contract.budget_account ?? null, task_id: launch.task_id, workspace: launch.workspace, prompt_digest: launch.prompt_digest, environment_digest: environmentDigest, budget_digest: budgetDigest });
    return { run: this.store.create("task_run", runId, { ...identity, identity_digest: identityDigest, stability_digest: stabilityDigest, lifecycle: "active", paused_reason: null, handoff_reason: null }), idempotent: false };
  }

  refresh(args: JsonObject): JsonObject {
    const run = current(this.store, "task_run", args.task_run_id); const contract = current(this.store, "task_control_contract", run.contract_id); const launch = current(this.store, "work_launch", run.launch_id);
    const observedEnvironment = args.environment === undefined ? String(run.environment_digest) : digestJson(args.environment);
    const observedBudget = args.budget === undefined ? String(run.budget_digest) : digestJson(args.budget);
    const observedStability = digestJson({ contract_status: contract.status, contract_version: contract.version, activation_profile: contract.activation_profile ?? null, budget_account: contract.budget_account ?? null, task_id: launch.task_id, workspace: launch.workspace, prompt_digest: launch.prompt_digest, environment_digest: observedEnvironment, budget_digest: observedBudget });
    const drift = observedStability !== run.stability_digest;
    const hostRun = launch.run_id ? this.store.find("host_run", String(launch.run_id)) : null;
    const unlinkedHostRuns = launch.run_id ? [] : this.store.list("host_run", 2, item => item.dispatch_id === run.dispatch_id && item.host === (run.launch_identity as JsonObject)?.host && item.task_id === (run.launch_identity as JsonObject)?.task_id);
    const observedLoop = this.store.find("delivery_loop", `delivery_loop_${launch.id}`);
    const assessment = launch.acceptance_plan_id ? this.store.find("acceptance_assessment", `assessment_${launch.acceptance_plan_id}`) : null;
    // A cached delivery decision is guidance only for the exact facts it saw.
    // Refreshing a Task Run must not promote stale acceptance or silently rerun it.
    const loop = observedLoop && digestJson([observedLoop.launch_id, observedLoop.launch_version,
      observedLoop.run_id, observedLoop.run_version, observedLoop.assessment_id, observedLoop.assessment_version])
      === digestJson([launch.id, launch.version, hostRun?.id ?? null, hostRun?.version ?? null,
        assessment?.id ?? null, assessment?.version ?? null]) ? observedLoop : null;
    const cancellationPending = run.lifecycle === "cancelled" && (hostRun ? [hostRun] : unlinkedHostRuns)
      .some(item => item.cleanup_unconfirmed === true || !["completed", "failed", "cancelled", "interrupted"].includes(String(item.status)));
    const state = cancellationPending ? { status: "cancellation_pending", action: "observe_host_termination", actor: "human" }
      : run.lifecycle === "cancelled" && !hostRun && launch.run_id
        ? { status: "result_unknown", action: "human_handoff", actor: "human" }
      : run.lifecycle === "cancelled" && !hostRun && unlinkedHostRuns.length > 0
        ? { status: "result_unknown", action: "reconcile_host_run", actor: "human" }
      : run.lifecycle === "cancelled" && hostRun
        ? { status: "cancelled_with_host_result", action: "review_host_outcome", actor: "human" }
      : run.lifecycle === "active" && !drift && unlinkedHostRuns.length > 0
      ? { status: "result_unknown", action: "reconcile_host_run", actor: "human" }
      : this.state(run, launch, hostRun, loop, drift);
    const identity = { task_run_id: run.id, task_run_version: run.version, lifecycle: run.lifecycle, launch_id: launch.id, launch_version: launch.version, host_run_id: hostRun?.id ?? null, host_run_version: hostRun?.version ?? null, missing_host_run_id: !hostRun && launch.run_id ? launch.run_id : null, unlinked_host_run_refs: unlinkedHostRuns.map(item => ({ id: item.id, version: item.version })), delivery_loop_id: loop?.id ?? null, delivery_loop_version: loop?.version ?? null, observed_environment_digest: observedEnvironment, observed_budget_digest: observedBudget, drift, ...state };
    const stateId = `task_run_state_${run.id}`; const existing = this.store.find("task_run_state", stateId); const stateDigest = digestJson(identity);
    if (existing?.state_digest === stateDigest) return { state: existing, idempotent: true };
    const saved = existing ? this.store.save("task_run_state", stateId, { ...identity, state_digest: stateDigest, task_id: run.launch_identity && (run.launch_identity as JsonObject).task_id }) : this.store.create("task_run_state", stateId, { ...identity, state_digest: stateDigest, task_id: run.launch_identity && (run.launch_identity as JsonObject).task_id });
    return { state: saved, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const run = current(this.store, "task_run", args.task_run_id); return { run, assignment: this.store.find("task_assignment", `task_assignment_${current(this.store, "work_launch", run.launch_id).task_id}`), state: this.store.find("task_run_state", `task_run_state_${run.id}`), handoffs: this.store.list("task_run_handoff", 1000, (item) => item.task_run_id === run.id) };
  }

  /** Link one observed terminal Host run; this never executes or accepts work. */
  reconcileHost(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const run = current(this.store, "task_run", args.task_run_id);
      const launch = current(this.store, "work_launch", run.launch_id);
      const host = current(this.store, "host_run", args.host_run_id);
      const actor = text(args.actor, "actor");
      if (launch.run_id === host.id) return { launch, host_run: host, idempotent: true };
      if (launch.run_id) throw new Error("Work Launch is already linked to another Host Run");
      for (const [name, value, actual] of [["task_run_version", args.task_run_version, run.version], ["launch_version", args.launch_version, launch.version], ["host_run_version", args.host_run_version, host.version]] as const) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value !== actual) throw new Error(`${name} is missing or changed; refresh the snapshot`);
      }
      if (!["prepared", "awaiting_approval", "approval_starting", "running"].includes(String(launch.status))) throw new Error("Work Launch cannot be reconciled in its current state");
      const identity = run.launch_identity as JsonObject;
      if (!identity || digestJson(identity) !== digestJson({ task_id: launch.task_id, host: launch.host, dispatch_id: launch.dispatch_id, workspace: launch.workspace, sandbox: launch.sandbox, prompt_digest: launch.prompt_digest })) throw new Error("Work Launch identity drifted");
      const contract = current(this.store, "task_control_contract", run.contract_id);
      const stability = digestJson({ contract_status: contract.status, contract_version: contract.version, activation_profile: contract.activation_profile ?? null, budget_account: contract.budget_account ?? null, task_id: launch.task_id, workspace: launch.workspace, prompt_digest: launch.prompt_digest, environment_digest: run.environment_digest, budget_digest: run.budget_digest });
      if (stability !== run.stability_digest) throw new Error("Task Run contract drifted");
      if (host.host !== launch.host || host.dispatch_id !== run.dispatch_id || host.task_id !== launch.task_id) throw new Error("Host Run does not match the Task Run");
      const matches = this.store.list("host_run", 2, item => item.host === host.host && item.dispatch_id === host.dispatch_id);
      if (matches.length !== 1 || matches[0].id !== host.id) throw new Error("Host Run is ambiguous");
      if (!["completed", "failed", "cancelled", "interrupted"].includes(String(host.status))) throw new Error("Host Run is not terminal; observe or stop it first");
      const kinds: Record<string, [string, string, string]> = { "codex-cli": ["codex_dispatch", "codex_receipt", "codex"], "claude-code": ["claude_dispatch", "claude_receipt", "claude"], internal: ["internal_dispatch", "internal_receipt", "internal"] };
      const driver = this.hostDrivers.get(String(host.host));
      const hostKinds = Object.hasOwn(kinds, String(host.host)) ? kinds[String(host.host)] : driver instanceof GenericCliHostKernel ? [driver.dispatchKind, `${driver.dispatchKind}_receipt`, driver.host] : undefined;
      if (!hostKinds || launch.dispatch_kind !== hostKinds[0]) throw new Error("Host Run kind is unsupported");
      const dispatch = current(this.store, hostKinds[0], run.dispatch_id);
      if (dispatch.request_digest !== run.dispatch_request_digest || dispatch.task_id !== launch.task_id || dispatch.workspace !== launch.workspace || dispatch.sandbox !== launch.sandbox || dispatch.prompt_digest !== launch.prompt_digest) throw new Error("Host dispatch identity drifted");
      if (driver instanceof GenericCliHostKernel && dispatch.profile_digest !== digestJson(driver.profile)) throw new Error("Host profile changed since dispatch was prepared");
      let authorizationId: unknown;
      if (host.status === "completed") {
        const receipt = current(this.store, hostKinds[1], host.receipt_id);
        if (dispatch.status !== "completed" || dispatch.receipt_id !== receipt.id || receipt.dispatch_id !== dispatch.id || receipt.task_id !== launch.task_id || receipt.host !== host.host || receipt.sandbox !== launch.sandbox || receipt.status !== "completed" || receipt.cancelled !== false) throw new Error("Host receipt does not prove the completed dispatch");
        if (host.host === "internal" ? receipt.workspace !== launch.workspace || receipt.failure !== null || (receipt.loop as JsonObject | undefined)?.status !== "completed" : receipt.timed_out !== false || receipt.output_limited !== false || receipt.exit_code !== 0 || receipt.signal !== null) throw new Error("Host receipt does not prove the completed dispatch");
        if (driver instanceof GenericCliHostKernel && receipt.profile_digest !== dispatch.profile_digest) throw new Error("Host receipt profile does not match the dispatch");
        if (launch.sandbox === "workspace-write") {
          const consumption = current(this.store, "autonomy_consumption", dispatch.authorization_consumption_id);
          const request = current(this.store, "autonomy_request", consumption.request_id);
          if (request.status !== "consumed" || request.consumption_id !== consumption.id || consumption.task_id !== launch.task_id || consumption.action !== "sandbox_write" || consumption.target !== launch.workspace || consumption.request_digest !== dispatch.request_digest || consumption.idempotency_key !== `${hostKinds[2]}:${dispatch.id}` || request.task_id !== consumption.task_id || request.action !== consumption.action || request.target !== consumption.target || request.request_digest !== consumption.request_digest) throw new Error("Host write authorization does not match the dispatch");
          authorizationId = request.id;
        }
      }
      const saved = this.store.save("work_launch", String(launch.id), { ...payload(launch), status: "running", run_id: host.id, reconciled_by: actor, ...(authorizationId === undefined ? {} : { authorization_request_id: authorizationId }) });
      this.store.appendEvent(`task:${launch.task_id}`, "task.host_run_reconciled", { task_run_id: run.id, launch_id: saved.id, launch_version: saved.version, host_run_id: host.id, host_run_version: host.version, actor });
      return { launch: saved, host_run: host, idempotent: false };
    });
  }

  pause(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
    const run = checkedTaskRun(this.store, args); assertExecutionRootActive(this.store, current(this.store, "work_launch", run.launch_id)); assertTaskAssignmentOwner(this.store, String(current(this.store, "work_launch", run.launch_id).task_id), args.actor); const reason = text(args.reason, "reason");
    if (run.lifecycle === "cancelled") throw new Error("Cancelled Task Run cannot be paused");
    if (run.lifecycle === "paused" && run.paused_reason === reason) return { run, idempotent: true };
    return { run: this.store.save("task_run", String(run.id), { ...payload(run), lifecycle: "paused", paused_reason: reason }), idempotent: false };
    });
  }

  resume(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
    const run = checkedTaskRun(this.store, args); assertExecutionRootActive(this.store, current(this.store, "work_launch", run.launch_id)); assertTaskAssignmentOwner(this.store, String(current(this.store, "work_launch", run.launch_id).task_id), args.actor);
    if (run.lifecycle === "cancelled") throw new Error("Cancelled Task Run cannot be resumed");
    if (run.lifecycle === "active") return { run, state: this.refresh({ task_run_id: run.id, environment: args.environment, budget: args.budget }).state, idempotent: true };
    const saved = this.store.save("task_run", String(run.id), { ...payload(run), lifecycle: "active", paused_reason: null });
    return { run: saved, state: this.refresh({ task_run_id: saved.id, environment: args.environment, budget: args.budget }).state, idempotent: false };
    });
  }

  cancel(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
    const run = checkedTaskRun(this.store, args); assertTaskAssignmentOwner(this.store, String(current(this.store, "work_launch", run.launch_id).task_id), args.actor); const reason = text(args.reason, "reason");
    if (run.lifecycle === "cancelled") return { run, idempotent: true };
    return { run: this.store.save("task_run", String(run.id), { ...payload(run), lifecycle: "cancelled", paused_reason: null, cancelled_reason: reason }), idempotent: false };
    });
  }

  handoff(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
    const run = checkedTaskRun(this.store, args); const reason = text(args.reason, "reason"); const state = this.refresh({ task_run_id: run.id }).state as JsonObject;
    if (current(this.store, "task_run", run.id).version !== state.task_run_version) throw new Error("Task Run changed during handoff; retry");
    const task = current(this.store, "task", state.task_id); const launch = current(this.store, "work_launch", state.launch_id);
    if (launch.version !== state.launch_version) throw new Error("Task Run launch changed during handoff; retry");
    if (state.host_run_id && current(this.store, "host_run", state.host_run_id).version !== state.host_run_version) throw new Error("Task Run host changed during handoff; retry");
    const acceptance = launch.acceptance_plan_id ? current(this.store, "acceptance_plan", launch.acceptance_plan_id) : null;
    const assignment = this.store.find("task_assignment", `task_assignment_${task.id}`);
    const identity = { task_run_id: run.id, task_run_version: run.version, state_id: state.id, state_version: state.version, reason, resume_action: state.action,
      assignment_ref: assignment ? { id: assignment.id, version: assignment.version, owner: assignment.owner } : null,
      task_ref: { id: task.id, version: task.version }, launch_ref: { id: state.launch_id, version: state.launch_version },
      host_run_ref: state.host_run_id ? { id: state.host_run_id, version: state.host_run_version } : null,
      missing_host_run_id: state.missing_host_run_id,
      unlinked_host_run_refs: state.unlinked_host_run_refs,
      acceptance_plan_id: launch.acceptance_plan_id ?? null, acceptance_plan_ref: acceptance ? { id: acceptance.id, version: acceptance.version } : null,
      state_status: state.status, next_actor: state.actor };
    const identityDigest = digestJson(identity); const handoffId = String(args.handoff_id ?? `task_run_handoff_${run.id}_${identityDigest.slice(-16)}`); const existing = this.store.find("task_run_handoff", handoffId);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Task Run handoff idempotency conflict"); return { handoff: existing, idempotent: true }; }
    return { handoff: this.store.create("task_run_handoff", handoffId, { ...identity, identity_digest: identityDigest }), idempotent: false };
    });
  }

  private state(run: JsonObject, launch: JsonObject, hostRun: JsonObject | null, loop: JsonObject | null, drift: boolean): JsonObject {
    if (run.lifecycle === "cancelled") return { status: "cancelled", action: "none", actor: "none" };
    if (!executionRootActive(this.store, launch)) return { status: "superseded", action: "continue_approved_plan", actor: "human" };
    if (run.lifecycle === "paused") return { status: "paused", action: "resume_or_handoff", actor: "human" };
    if (drift) return { status: "needs_replan", action: "revalidate_inputs", actor: "human" };
    const attemptBudget = workAttemptBudget(this.store, launch);
    if (!hostRun && attemptBudget?.exhausted) return { status: "attempt_budget_exhausted", action: "replan_with_evidence", actor: "human" };
    if (launch.status === "awaiting_approval") return { status: "awaiting_approval", action: "review_work_launch", actor: "human" };
    if (launch.status === "approval_starting" && !hostRun) return { status: "result_unknown", action: "human_handoff", actor: "human" };
    if (hostRun?.cleanup_unconfirmed === true) return { status: "result_unknown", action: "human_handoff", actor: "human" };
    if (!hostRun && launch.status === "prepared") return { status: "awaiting_start", action: "start_host", actor: "human" };
    if (!hostRun || !["completed", "failed", "cancelled", "interrupted"].includes(String(hostRun.status))) return { status: "running", action: "wait_for_host", actor: "host" };
    const action = String(loop?.action ?? "wait_for_host");
    if (action === "deliver") return { status: "ready_for_delivery", action, actor: "human" };
    if (action === "collect_acceptance") return { status: "awaiting_acceptance", action, actor: "human" };
    if (action === "retry_or_handoff") {
      if (attemptBudget?.exhausted) return { status: "attempt_budget_exhausted", action: "replan_with_evidence", actor: "human" };
      if (workRetryPolicy(this.store, launch).exhausted) return { status: "rework_limit", action: "replan_with_evidence", actor: "human" };
      return { status: "recovery", action, actor: "human" };
    }
    return { status: "blocked", action: "human_handoff", actor: "human" };
  }
}
