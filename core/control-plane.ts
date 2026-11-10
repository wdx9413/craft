import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject, type SaveEntry } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { stableDigest, payload } from "./digest.ts";

function id(value: unknown, name: string, prefix: string): string {
  const result = value === undefined ? `${prefix}_${randomUUID().replaceAll("-", "")}` : String(value).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error(`${name} must contain only letters, numbers, _ or -`);
  return result;
}

function amounts(value: unknown, name: string): JsonObject {
  const result = object(value, name);
  for (const [resource, amount] of Object.entries(result)) if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new Error(`${name}.${resource} must be a non-negative finite number`);
  }
  return result;
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  return result;
}

export function decimalSum(...values: number[]): number {
  const parts = values.map(value => {
    const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
    const [whole, fraction = ""] = mantissa!.split(".");
    return { units: BigInt(whole! + fraction), exponent: Number(exponent) - fraction.length };
  });
  const exponent = Math.min(...parts.map(part => part.exponent));
  const units = parts.reduce((total, part) => total + part.units * 10n ** BigInt(part.exponent - exponent), 0n);
  const result = Number(`${units}e${exponent}`);
  if (!Number.isFinite(result)) throw new Error("Budget resource arithmetic exceeds numeric range");
  return result;
}

function add(left: JsonObject, right: JsonObject, direction = 1): JsonObject {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return Object.fromEntries([...keys].map((key) => [key, decimalSum(Number(left[key] ?? 0), direction * Number(right[key] ?? 0))]));
}
function available(account: JsonObject): JsonObject {
  const limits = account.limits as JsonObject; const used = account.used as JsonObject; const reserved = account.reserved as JsonObject;
  return Object.fromEntries(Object.entries(limits).map(([key, limit]) => [key, decimalSum(Number(limit), -Number(used[key] ?? 0), -Number(reserved[key] ?? 0))]));
}
function fits(requested: JsonObject, capacity: JsonObject): boolean {
  return Object.entries(requested).every(([key, amount]) => Object.hasOwn(capacity, key) && Number(amount) <= Number(capacity[key]));
}

export class ControlPlaneKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  budgetOpen(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
    const accountId = id(args.budget_id, "budget_id", "budget"); const limits = amounts(args.limits, "limits");
    const ownerType = text(args.owner_type, "owner_type"); const ownerId = text(args.owner_id, "owner_id");
    if (this.store.find("budget_account", accountId)) throw new Error(`Budget account already exists: ${accountId}`);
    if (args.parent_budget_id === undefined) {
      const account = this.store.create("budget_account", accountId, { owner_type: ownerType,
        owner_id: ownerId, limits, used: {}, reserved: {}, status: "active", parent_budget_id: null, parent_reservation_id: null });
      return { account, available: available(account) };
    }
    const parent = this.store.get("budget_account", text(args.parent_budget_id, "parent_budget_id"));
    if (parent.status !== "active") throw new Error("Parent budget account is not active");
    if (!fits(limits, available(parent))) throw new Error("Child budget limits exceed parent available resources");
    const allocationId = `budget_allocation_${accountId}`;
    const [allocation, savedParent, account] = this.store.saveBatch([
      { kind: "budget_reservation", id: allocationId, version: 1, payload: { budget_id: parent.id, resources: limits,
        status: "reserved", purpose: `child_budget:${accountId}` } },
      { kind: "budget_account", id: String(parent.id), payload: { ...payload(parent), reserved: add(parent.reserved as JsonObject, limits) } },
      { kind: "budget_account", id: accountId, version: 1, payload: { owner_type: ownerType, owner_id: ownerId,
        limits, used: {}, reserved: {}, status: "active", parent_budget_id: parent.id, parent_reservation_id: allocationId } },
    ]);
    return { account, parent: savedParent, allocation, available: available(account) };
    });
  }

  budgetReserve(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
    const account = this.store.get("budget_account", text(args.budget_id, "budget_id"));
    if (account.status !== "active") throw new Error("Budget account is not active");
    const reservationId = id(args.reservation_id, "reservation_id", "reservation"); const requested = amounts(args.resources, "resources");
    const existing = this.store.find("budget_reservation", reservationId);
    if (existing) {
      if (existing.budget_id !== account.id || stableDigest(existing.resources) !== stableDigest(requested)) throw new Error("Reservation idempotency conflict");
      return { reservation: existing, account, available: available(account), idempotent: true };
    }
    const remaining = available(account);
    if (!fits(requested, remaining)) throw new Error("Budget reservation exceeds available resources");
    const [reservation, savedAccount] = this.store.saveBatch([
      { kind: "budget_reservation", id: reservationId, version: 1, payload: { budget_id: account.id, resources: requested, status: "reserved", purpose: args.purpose ?? null } },
      { kind: "budget_account", id: String(account.id), payload: { ...payload(account), reserved: add(account.reserved as JsonObject, requested) } },
    ]);
    return { reservation, account: savedAccount, available: available(savedAccount), idempotent: false };
    });
  }

  budgetSettle(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
    const reservation = this.store.get("budget_reservation", text(args.reservation_id, "reservation_id"));
    if (reservation.status !== "reserved") {
      if (args.actual !== undefined && stableDigest(reservation.actual ?? {}) !== stableDigest(amounts(args.actual, "actual"))) throw new Error("Budget settlement idempotency conflict");
      return { reservation, idempotent: true };
    }
    const actual = amounts(args.actual ?? {}, "actual");
    const account = this.store.get("budget_account", String(reservation.budget_id));
    let confirmedOverrun = false;
    if (account.owner_type === "internal_dispatch") {
      const known = this.store.list("model_context_cache_receipt", 1, item => item.reservation_id === reservation.id && item.dispatch_id === account.owner_id && item.price != null && (item.price as JsonObject).cost_usd === actual.usd);
      const reconciliation = args.reconciliation_id === undefined ? null : this.store.find("model_cost_reconciliation", text(args.reconciliation_id, "reconciliation_id"));
      const evidence = reconciliation?.evidence_id && Number.isSafeInteger(reconciliation.evidence_version) ? this.store.find("evidence", String(reconciliation.evidence_id), Number(reconciliation.evidence_version)) : null;
      const metadata = evidence?.metadata as JsonObject | undefined;
      const reported = reconciliation?.reservation_id === reservation.id && reconciliation?.dispatch_id === account.owner_id && reconciliation?.actual_usd === actual.usd && reconciliation?.basis === "operator_reported_billing" && reconciliation?.confirmed_billing === true && evidence?.source_type === "human" && metadata?.dispatch_id === account.owner_id && metadata?.reservation_id === reservation.id && metadata?.actual_usd === actual.usd && metadata?.actor === reconciliation.actor;
      confirmedOverrun = Boolean(reported && reconciliation?.confirmed_overrun === true && metadata?.confirmed_overrun === true && Object.keys(actual).every(key => key === "usd"));
      if (actual.usd === undefined || (!known.length && !reported)) throw new Error("Model budget settlement requires known usage or explicit billing reconciliation");
    }

    if (!fits(actual, reservation.resources as JsonObject) && !confirmedOverrun) throw new Error("Actual resources exceed the reservation");
    const [savedReservation, savedAccount] = this.store.saveBatch([
      { kind: "budget_reservation", id: String(reservation.id), payload: { ...payload(reservation), actual, status: "settled" } },
      { kind: "budget_account", id: String(account.id), payload: { ...payload(account), used: add(account.used as JsonObject, actual),
        reserved: add(account.reserved as JsonObject, reservation.resources as JsonObject, -1) } },
    ]);
    return { reservation: savedReservation, account: savedAccount, available: available(savedAccount), idempotent: false };
    });
  }

  budgetClose(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
    const account = this.store.get("budget_account", text(args.budget_id, "budget_id"));
    if (account.status === "closed") return { account, idempotent: true };
    const activeChildren = this.store.list("budget_account", 10_000,
      (item) => item.parent_budget_id === account.id && item.status === "active");
    if (activeChildren.length) throw new Error("Budget account has active child budgets");
    const activeReservations = this.store.list("budget_reservation", 10_000,
      (item) => item.budget_id === account.id && item.status === "reserved");
    if (activeReservations.length) throw new Error("Budget account has unsettled reservations");
    if (!account.parent_budget_id) {
      const closed = this.store.save("budget_account", String(account.id), { ...payload(account), status: "closed" });
      return { account: closed, idempotent: false };
    }
    const parent = this.store.get("budget_account", String(account.parent_budget_id));
    const allocation = this.store.get("budget_reservation", String(account.parent_reservation_id));
    if (allocation.status !== "reserved") throw new Error("Parent budget allocation is not reserved");
    const actual = account.used as JsonObject;
    const [closed, settledAllocation, savedParent] = this.store.saveBatch([
      { kind: "budget_account", id: String(account.id), payload: { ...payload(account), status: "closed" } },
      { kind: "budget_reservation", id: String(allocation.id), payload: { ...payload(allocation), actual, status: "settled" } },
      { kind: "budget_account", id: String(parent.id), payload: { ...payload(parent), used: add(parent.used as JsonObject, actual),
        reserved: add(parent.reserved as JsonObject, allocation.resources as JsonObject, -1) } },
    ]);
    return { account: closed, allocation: settledAllocation, parent: savedParent, idempotent: false };
    });
  }

  waitCreate(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const condition = String(args.condition);
    if (!new Set(["approval", "event", "time"]).has(condition)) throw new Error("Wait condition is unsupported");
    const workspace = args.workspace_id === undefined ? null : this.store.get("workspace", text(args.workspace_id, "workspace_id"));
    const resumeAfter = args.resume_after === undefined ? null : text(args.resume_after, "resume_after");
    if (condition === "time" && (resumeAfter === null || Number.isNaN(Date.parse(resumeAfter)))) throw new Error("A time wait requires a valid resume_after");
    const wait = this.store.create("durable_wait", id(args.wait_id, "wait_id", "wait"), { task_id: task.id, workspace_id: workspace?.id ?? null,
      workspace_revision: workspace?.state_revision ?? null, condition, event_key: args.event_key ?? null, resume_after: resumeAfter,
      status: "waiting", snapshot_refs: args.snapshot_refs ?? [], policy_fingerprint: args.policy_fingerprint ?? null,
      trial_id: args.trial_id ?? null });
    return { wait, execution_environment: "releasable" };
  }

  waitResume(args: JsonObject): JsonObject {
    const wait = this.store.get("durable_wait", text(args.wait_id, "wait_id"));
    if (wait.status !== "waiting") return { wait, idempotent: true };
    const signal = text(args.signal, "signal"); const now = args.now === undefined ? Date.now() : Date.parse(text(args.now, "now"));
    if (Number.isNaN(now)) throw new Error("now must be an ISO timestamp");
    if (wait.condition === "time" ? now < Date.parse(String(wait.resume_after)) : signal !== wait.condition) throw new Error("Resume signal does not satisfy the wait condition");
    if (wait.condition === "event" && wait.event_key && args.signal_key !== wait.event_key) throw new Error("Resume event key does not match the wait condition");
    let status = "resumed"; let reason: string | null = null;
    if (wait.workspace_id) {
      const workspace = this.store.get("workspace", String(wait.workspace_id));
      if (workspace.state_revision !== wait.workspace_revision) { status = "needs_replan"; reason = "workspace_revision_changed"; }
    }
    if (wait.policy_fingerprint && args.policy_fingerprint === undefined) { status = "needs_replan"; reason = "policy_fingerprint_unavailable"; }
    else if (args.policy_fingerprint !== undefined && args.policy_fingerprint !== wait.policy_fingerprint) { status = "needs_replan"; reason = "policy_fingerprint_changed"; }
    const saved = this.store.save("durable_wait", String(wait.id), { ...payload(wait), status, resume_signal: signal, resume_reason: reason });
    return { wait: saved, idempotent: false };
  }

  fallbackSave(args: JsonObject): JsonObject {
    const strategy = String(args.strategy);
    if (!new Set(["model_replan", "workflow_replan", "human"]).has(strategy)) throw new Error("Fallback strategy is unsupported");
    const maxAttempts = Number(args.max_attempts ?? 1);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("max_attempts must be a positive integer");
    const subjectVersion = Number(args.subject_version);
    if (!Number.isInteger(subjectVersion) || subjectVersion < 1) throw new Error("subject_version must be a positive integer");
    if (args.budget_id) this.store.get("budget_account", String(args.budget_id));
    const contract = this.store.create("fallback_contract", id(args.contract_id, "contract_id", "fallback"), {
      subject_type: text(args.subject_type, "subject_type"), subject_id: text(args.subject_id, "subject_id"),
      subject_version: subjectVersion, triggers: strings(args.triggers, "triggers"), strategy, max_attempts: maxAttempts,
      budget_id: args.budget_id ?? null, estimated_resources: args.estimated_resources === undefined ? {} : amounts(args.estimated_resources, "estimated_resources") });
    return { contract };
  }

  fallbackEvaluate(args: JsonObject): JsonObject {
    const contract = this.store.get("fallback_contract", text(args.contract_id, "contract_id")); const trigger = text(args.trigger, "trigger");
    if (!(contract.triggers as string[]).includes(trigger)) return { decision: "continue", trigger_matched: false };
    const attempts = this.store.list("fallback_event", 10_000, (item) => item.contract_id === contract.id && item.decision === "fallback").length;
    let decision = attempts >= Number(contract.max_attempts) ? "blocked" : "fallback"; let reservation: JsonObject | null = null;
    if (decision === "fallback" && contract.budget_id && Object.keys(contract.estimated_resources as JsonObject).length) {
      try {
        reservation = this.budgetReserve({ budget_id: contract.budget_id, reservation_id: `${contract.id}_${attempts + 1}`,
          resources: contract.estimated_resources, purpose: `fallback:${contract.id}` }).reservation as JsonObject;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("exceeds available")) throw error;
        decision = "await_budget";
      }
    }
    const event = this.store.create("fallback_event", id(args.event_id, "event_id", "fallback_event"), { contract_id: contract.id,
      trigger, trigger_matched: true, decision, strategy: contract.strategy, reservation_id: reservation?.id ?? null,
      task_id: args.task_id ?? null, trial_id: args.trial_id ?? null, observation: args.observation ?? null,
      status: decision === "fallback" ? "running" : "terminal" });
    return { decision, trigger_matched: true, event, reservation };
  }
}
