/**
 * Deterministic local execution for an already routeable Experience Procedure.
 *
 * This is intentionally narrower than an Agent runner: it executes only a
 * checked Workflow definition, never a Prompt or Graph, never external effects,
 * and persists a receipt, checkpoints, outcome and handoff for every attempt.
 * A host cron, tray process or CI runner may call `tick`; Craft never installs
 * one or silently turns a learned procedure into an operating-system service.
 */
import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "../../core/infrastructure/store.ts";
import { payload, stableDigest } from "../../core/digest.ts";
import { normalizeSteps, resolveInputs, substitute } from "../../core/workflow.ts";
import { ProcedureDefinitionStore, procedureDefinitionRef, type ProcedureDefinition } from "./procedure-definition.ts";

type TriggerKind = "manual" | "interval";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return result;
}

function timestamp(value: unknown, name: string, fallback = new Date().toISOString()): string {
  const result = value === undefined ? fallback : text(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}

function nextInterval(now: string, seconds: number): string { return new Date(Date.parse(now) + seconds * 1000).toISOString(); }

function declaredEffects(definition: ProcedureDefinition): Set<string> {
  const effects = new Set(definition.allowed_effects.map((effect) => effect === "read" ? "read_only" : effect));
  if ([...effects].some((effect) => !new Set(["read_only", "local_write"]).has(effect))) {
    throw new Error("Procedure Automation supports only read_only or local_write Effects");
  }
  return effects;
}

/**
 * A deep module with a deliberately small Interface: save/pause/run/tick/get.
 * Callers do not decide checkpoint format, retries, failure notices or the
 * restricted execution boundary; those are all implementation details here.
 */
export class ProcedureAutomationKernel {
  readonly store: CraftStore;
  readonly definitions: ProcedureDefinitionStore;
  constructor(store: CraftStore) { this.store = store; this.definitions = new ProcedureDefinitionStore(store.paths); }

  save(args: JsonObject): JsonObject {
    const procedure = this.routeableWorkflow(args.procedure_id);
    const definition = this.definition(procedure);
    const trigger = (args.trigger ?? "manual") as TriggerKind;
    if (trigger !== "manual" && trigger !== "interval") throw new Error("Automation trigger must be manual or interval");
    const intervalSeconds = trigger === "interval" ? integer(args.interval_seconds, "interval_seconds", 300, 60, 604_800) : null;
    const workspace = text(args.workspace, "workspace");
    const inputs = args.inputs === undefined ? {} : object(args.inputs, "inputs");
    const verifierStepId = text(args.verifier_step_id, "verifier_step_id");
    const steps = this.workflowSteps(definition, inputs);
    const verifier = steps.find((step) => step.id === verifierStepId);
    if (!verifier || !new Set(["assertion", "coverage_gate"]).has(String(verifier.type))) {
      throw new Error("Automation verifier_step_id must reference an assertion or coverage_gate step");
    }
    const effects = declaredEffects(definition);
    const allowLocalWrite = args.allow_local_write === true;
    if (effects.has("local_write") && !allowLocalWrite) throw new Error("Automation local_write requires allow_local_write: true");
    const now = timestamp(args.now, "now");
    const identity = {
      procedure_id: procedure.id, procedure_version: procedure.version, definition_digest: definition && procedure.definition_digest,
      workspace, trigger, interval_seconds: intervalSeconds, inputs, verifier_step_id: verifierStepId,
      allow_local_write: allowLocalWrite, max_attempts: integer(args.max_attempts, "max_attempts", 1, 1, 3),
      retry_delay_seconds: integer(args.retry_delay_seconds, "retry_delay_seconds", 60, 15, 3_600),
      quota_slots: integer(args.quota_slots, "quota_slots", 24, 1, 10_000),
      quota_window_seconds: integer(args.quota_window_seconds, "quota_window_seconds", 86_400, 60, 2_592_000),
      max_no_progress: integer(args.max_no_progress, "max_no_progress", 2, 1, 100),
      notification: args.notification === undefined ? "record_only" : text(args.notification, "notification"),
    };
    const jobId = String(args.job_id ?? `procedure_automation_job_${stableDigest(identity).slice(-20)}`);
    const existing = this.store.find("procedure_automation_job", jobId);
    const digest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest !== digest) throw new Error("Procedure Automation job idempotency conflict");
      return { job: existing, idempotent: true };
    }
    const job = this.store.create("procedure_automation_job", jobId, {
      ...identity, identity_digest: digest, status: "active", failure_count: 0,
      next_run_at: trigger === "interval" ? timestamp(args.next_run_at, "next_run_at", now) : null,
      last_run_id: null, last_outcome_id: null,
    });
    return { job, idempotent: false };
  }

  pause(args: JsonObject): JsonObject {
    const job = this.store.get("procedure_automation_job", text(args.job_id, "job_id"));
    const status = args.paused === false ? "active" : "paused";
    return { job: this.store.save("procedure_automation_job", String(job.id), {
      ...payload(job), status, paused_at: status === "paused" ? timestamp(args.now, "now") : null,
    }) };
  }

  run(args: JsonObject): JsonObject {
    const job = this.store.get("procedure_automation_job", text(args.job_id, "job_id"));
    if (job.status !== "active") return { status: "skipped", reason: `job_${String(job.status)}`, job };
    const now = timestamp(args.now, "now");
    const eligibility = this.eligibilityFor(job, now);
    if (eligibility.decision !== "run") return { status: "skipped", reason: eligibility.reason, job, eligibility };
    const runId = String(args.run_id ?? `procedure_automation_run_${randomUUID().replaceAll("-", "")}`);
    const existing = this.store.find("procedure_automation_run", runId);
    if (existing) {
      if (existing.job_id !== job.id) throw new Error("Procedure Automation run idempotency conflict");
      return { run: existing, idempotent: true };
    }
    const attempt = Number(job.failure_count ?? 0) + 1;
    const running = this.store.create("procedure_automation_run", runId, {
      job_id: job.id, job_version: job.version, procedure_id: job.procedure_id, procedure_version: job.procedure_version,
      started_at: now, attempt, status: "awaiting_host_dispatch", trigger: args.trigger ?? "manual",
    });
    const dispatch = this.store.create("procedure_automation_dispatch", `procedure_automation_dispatch_${runId}`, {
      run_id: running.id, job_id: job.id, procedure_id: job.procedure_id, procedure_version: job.procedure_version,
      definition_digest: job.definition_digest, workspace_ref: stableDigest({ workspace: job.workspace }), inputs_digest: stableDigest(job.inputs),
      allowed_effects: declaredEffects(this.definition(this.routeableWorkflow(String(job.procedure_id), Number(job.procedure_version)))).size === 0 ? [] : ["read_only", ...(job.allow_local_write === true ? ["local_write"] : [])],
      status: "awaiting_external_host", execution_authority: false, raw_content_stored: false,
    });
    this.store.appendEvent(`automation:${job.id}`, "automation.awaiting_host", { job_id: job.id, run_id: running.id, dispatch_id: dispatch.id });
    return { run: running, dispatch, job, idempotent: false };
  }

  /** External Codex/CI/cron records a terminal Host receipt; Craft never executes the workflow. */
  receiptRecord(args: JsonObject): JsonObject {
    const run = this.store.get("procedure_automation_run", text(args.run_id, "run_id"));
    if (run.status !== "awaiting_host_dispatch") throw new Error("Procedure Automation run is not awaiting a Host receipt");
    const job = this.store.get("procedure_automation_job", String(run.job_id));
    const session = this.store.get("host_session", text(args.host_session_id, "host_session_id"));
    if (session.status !== "terminal") throw new Error("Procedure Automation requires a terminal Host Session");
    const observation = this.store.get("outcome_observation", text(args.observation_id, "observation_id"));
    if (observation.trace_id !== session.trace_id || observation.observer_id === session.host_id) throw new Error("Procedure Automation requires an independent Outcome Observation");
    const evidenceIds = Array.isArray(args.acceptance_evidence_ids) ? args.acceptance_evidence_ids.map((value) => text(value, "acceptance_evidence_ids")) : [];
    if (!evidenceIds.length) throw new Error("Procedure Automation requires acceptance Evidence");
    evidenceIds.forEach((id) => this.store.get("evidence", id));
    const passed = observation.verdict === "passed";
    const receipt = this.store.create("procedure_automation_receipt", `procedure_automation_receipt_${run.id}`, {
      run_id: run.id, procedure_id: run.procedure_id, procedure_version: run.procedure_version, status: passed ? "passed" : "failed",
      verifier_step_id: job.verifier_step_id, host_session_id: session.id, host_session_version: session.version,
      observation_id: observation.id, observation_version: observation.version, acceptance_evidence_ids: evidenceIds.sort(), raw_output_stored: false,
    });
    const outcome = this.store.create("procedure_automation_outcome", `procedure_automation_outcome_${run.id}`, {
      run_id: run.id, receipt_id: receipt.id, status: passed ? "accepted" : "failed", acceptance_ref: this.store.get("experience_procedure", String(job.procedure_id)).acceptance_ref,
      acceptance_source: "independent_host_observation", observed_at: timestamp(args.observed_at, "observed_at"),
    });
    const completed = this.store.save("procedure_automation_run", String(run.id), { ...payload(run), status: passed ? "completed" : "failed", receipt_id: receipt.id, outcome_id: outcome.id, completed_at: timestamp(args.observed_at, "observed_at") });
    const progress = { digest: stableDigest({ receipt: receipt.id, observation: observation.id, verdict: observation.verdict }), changed: true, prior_digest: job.last_progress_digest ?? null, verifier_observed: true };
    const settlement = passed ? this.settleQuota(job, completed, outcome, timestamp(args.observed_at, "observed_at")) : null;
    const savedJob = this.afterRun(job, completed, outcome, timestamp(args.observed_at, "observed_at"), progress, settlement);
    return { run: completed, receipt, outcome, job: savedJob, progress, settlement };
  }

  tick(args: JsonObject = {}): JsonObject {
    const now = timestamp(args.now, "now");
    const serviceId = args.service_id === undefined ? null : text(args.service_id, "service_id");
    if (serviceId !== null) {
      const service = this.store.find("local_runtime_service", serviceId);
      if (!service || service.status !== "running") return { status: "skipped", reason: "local_service_not_running", processed: [] };
    }
    const limit = integer(args.limit, "limit", 20, 1, 100);
    const due = this.store.list("procedure_automation_job", 10_000, (job) => job.status === "active" && job.trigger === "interval"
      && typeof job.next_run_at === "string" && Date.parse(job.next_run_at) <= Date.parse(now))
      .sort((left, right) => String(left.next_run_at).localeCompare(String(right.next_run_at))).slice(0, limit);
    const processed = due.map((job) => this.run({ job_id: job.id, now, trigger: "interval" }));
    return { status: "completed", processed, count: processed.length, limited: due.length === limit };
  }

  get(args: JsonObject): JsonObject {
    const job = this.store.get("procedure_automation_job", text(args.job_id, "job_id"));
    const runs = this.store.list("procedure_automation_run", integer(args.limit, "limit", 20, 1, 100), (run) => run.job_id === job.id)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    const notices = this.store.list("procedure_automation_notice", 100, (notice) => notice.job_id === job.id);
    return { job, runs, notices, eligibility: this.eligibilityFor(job, timestamp(args.now, "now")) };
  }

  eligibility(args: JsonObject): JsonObject {
    const job = this.store.get("procedure_automation_job", text(args.job_id, "job_id"));
    return { job, eligibility: this.eligibilityFor(job, timestamp(args.now, "now")) };
  }

  private routeableWorkflow(procedureId: unknown, version?: number): JsonObject {
    const procedure = this.store.get("experience_procedure", text(procedureId, "procedure_id"), version);
    if (procedure.lifecycle !== "routeable" || procedure.routeable !== true) throw new Error("Only routeable Procedure can be automated");
    if (procedure.procedure_kind !== "workflow") throw new Error("Procedure Automation supports only workflow Procedures; Graph and Prompt require a Host Adapter");
    return procedure;
  }

  private definition(procedure: JsonObject): ProcedureDefinition {
    if (!procedureDefinitionRef(procedure.definition_ref)) throw new Error("Routeable Procedure has no checked definition");
    return this.definitions.read(procedure.definition_ref);
  }

  private workflowSteps(definition: ProcedureDefinition, inputs: JsonObject): JsonObject[] {
    const spec = object(definition.definition, "procedure.definition");
    const resolved = resolveInputs(Array.isArray(spec.inputs) ? spec.inputs as JsonObject[] : [], inputs);
    if (!Array.isArray(spec.steps) || !spec.steps.length) throw new Error("Workflow Procedure must contain steps");
    return normalizeSteps(substitute(spec.steps, resolved) as JsonObject[]);
  }

  private eligibilityFor(job: JsonObject, now: string): JsonObject {
    if (job.status === "requires_handoff") return { decision: "handoff", reason: "handoff_required", handoff_id: job.handoff_id ?? null };
    if (job.status !== "active") return { decision: "skip", reason: `job_${String(job.status)}` };
    const windowStart = new Date(Date.parse(now) - Number(job.quota_window_seconds) * 1_000).toISOString();
    const settlements = this.store.list("procedure_automation_quota_settlement", 10_000, (item) => item.job_id === job.id && String(item.settled_at) >= windowStart);
    const spentSlots = settlements.reduce((sum, item) => sum + Number(item.slots ?? 0), 0);
    if (spentSlots >= Number(job.quota_slots)) return { decision: "skip", reason: "quota_exhausted", spent_slots: spentSlots, quota_slots: job.quota_slots, window_start: windowStart };
    if (Number(job.no_progress_count ?? 0) >= Number(job.max_no_progress)) return { decision: "handoff", reason: "no_progress_limit", spent_slots: spentSlots, quota_slots: job.quota_slots, window_start: windowStart };
    return { decision: "run", reason: "eligible", spent_slots: spentSlots, quota_slots: job.quota_slots, window_start: windowStart };
  }

  private progress(job: JsonObject, receipt: JsonObject): JsonObject {
    const verifier = (receipt.step_receipts as JsonObject[]).find((item) => item.step_id === job.verifier_step_id) ?? null;
    const digest = stableDigest({ verifier, receipt_status: receipt.status });
    return { digest, changed: job.last_progress_digest !== digest, prior_digest: job.last_progress_digest ?? null, verifier_observed: verifier !== null };
  }

  private settleQuota(job: JsonObject, run: JsonObject, outcome: JsonObject, now: string): JsonObject {
    const id = `procedure_automation_quota_${stableDigest({ job: job.id, run: run.id }).slice(-20)}`;
    return this.store.create("procedure_automation_quota_settlement", id, {
      job_id: job.id, run_id: run.id, outcome_id: outcome.id, slots: 1, settled_at: now,
      reason: "accepted_independent_verifier_progress",
    });
  }

  private afterRun(job: JsonObject, run: JsonObject, outcome: JsonObject, now: string, progress: JsonObject, settlement: JsonObject | null): JsonObject {
    const passed = outcome.status === "accepted";
    const failed = Number(job.failure_count ?? 0) + (passed ? 0 : 1);
    const noProgress = passed && progress.changed !== true ? Number(job.no_progress_count ?? 0) + 1 : 0;
    const maxAttempts = Number(job.max_attempts);
    let status = "active";
    let nextRunAt: string | null = job.trigger === "interval" ? nextInterval(now, Number(job.interval_seconds)) : null;
    let handoffId: string | null = null;
    if (passed && noProgress >= Number(job.max_no_progress)) {
      status = "requires_handoff"; nextRunAt = null;
      handoffId = `procedure_automation_handoff_${stableDigest({ job: job.id, run: run.id, reason: "no_progress" }).slice(-20)}`;
      this.store.create("procedure_automation_handoff", handoffId, { job_id: job.id, run_id: run.id, outcome_id: outcome.id, reason: "no_progress_limit", action: "reconcile_workspace_or_wait_for_new_input", status: "open" });
      this.store.create("procedure_automation_notice", `procedure_automation_notice_${stableDigest({ job: job.id, run: run.id, reason: "no_progress" }).slice(-20)}`, { job_id: job.id, run_id: run.id, severity: "warning", delivery: job.notification, status: "pending_delivery", reason: "no_progress_limit", handoff_id: handoffId });
    } else if (!passed && failed >= maxAttempts) {
      status = "requires_handoff"; nextRunAt = null;
      handoffId = `procedure_automation_handoff_${stableDigest({ job: job.id, run: run.id }).slice(-20)}`;
      this.store.create("procedure_automation_handoff", handoffId, {
        job_id: job.id, run_id: run.id, outcome_id: outcome.id, reason: "retry_budget_exhausted",
        action: "inspect_procedure_or_workspace_then_resume", status: "open",
      });
      this.store.create("procedure_automation_notice", `procedure_automation_notice_${stableDigest({ job: job.id, run: run.id }).slice(-20)}`, {
        job_id: job.id, run_id: run.id, severity: "error", delivery: job.notification,
        status: "pending_delivery", reason: "retry_budget_exhausted", handoff_id: handoffId,
      });
    } else if (!passed && job.trigger === "interval") {
      nextRunAt = nextInterval(now, Number(job.retry_delay_seconds));
    }
    return this.store.save("procedure_automation_job", String(job.id), {
      ...payload(job), status, failure_count: passed ? 0 : failed, no_progress_count: noProgress,
      last_progress_digest: progress.digest, next_run_at: nextRunAt, last_run_id: run.id, last_outcome_id: outcome.id,
      last_quota_settlement_id: settlement?.id ?? null, handoff_id: handoffId,
    });
  }
}
