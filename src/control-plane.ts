import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject, type SaveEntry } from "./store.ts";

function id(value: unknown, name: string, prefix: string): string {
  const result = value === undefined ? `${prefix}_${randomUUID().replaceAll("-", "")}` : String(value).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error(`${name} must contain only letters, numbers, _ or -`);
  return result;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
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
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest;
}
function add(left: JsonObject, right: JsonObject, direction = 1): JsonObject {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return Object.fromEntries([...keys].map((key) => [key, Number(left[key] ?? 0) + direction * Number(right[key] ?? 0)]));
}
function available(account: JsonObject): JsonObject {
  const limits = account.limits as JsonObject; const used = account.used as JsonObject; const reserved = account.reserved as JsonObject;
  return Object.fromEntries(Object.entries(limits).map(([key, limit]) => [key, Number(limit) - Number(used[key] ?? 0) - Number(reserved[key] ?? 0)]));
}
function fits(requested: JsonObject, capacity: JsonObject): boolean {
  return Object.entries(requested).every(([key, amount]) => Object.hasOwn(capacity, key) && Number(amount) <= Number(capacity[key]));
}

export class ControlPlaneKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  budgetOpen(args: JsonObject): JsonObject {
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
  }

  budgetReserve(args: JsonObject): JsonObject {
    const account = this.store.get("budget_account", text(args.budget_id, "budget_id"));
    if (account.status !== "active") throw new Error("Budget account is not active");
    const reservationId = id(args.reservation_id, "reservation_id", "reservation"); const requested = amounts(args.resources, "resources");
    const existing = this.store.find("budget_reservation", reservationId);
    if (existing) {
      if (existing.budget_id !== account.id || JSON.stringify(existing.resources) !== JSON.stringify(requested)) throw new Error("Reservation idempotency conflict");
      return { reservation: existing, account, available: available(account), idempotent: true };
    }
    const remaining = available(account);
    if (!fits(requested, remaining)) throw new Error("Budget reservation exceeds available resources");
    const [reservation, savedAccount] = this.store.saveBatch([
      { kind: "budget_reservation", id: reservationId, version: 1, payload: { budget_id: account.id, resources: requested, status: "reserved", purpose: args.purpose ?? null } },
      { kind: "budget_account", id: String(account.id), payload: { ...payload(account), reserved: add(account.reserved as JsonObject, requested) } },
    ]);
    return { reservation, account: savedAccount, available: available(savedAccount), idempotent: false };
  }

  budgetSettle(args: JsonObject): JsonObject {
    const reservation = this.store.get("budget_reservation", text(args.reservation_id, "reservation_id"));
    if (reservation.status !== "reserved") return { reservation, idempotent: true };
    const actual = amounts(args.actual ?? {}, "actual");
    if (!fits(actual, reservation.resources as JsonObject)) throw new Error("Actual resources exceed the reservation");
    const account = this.store.get("budget_account", String(reservation.budget_id));
    const [savedReservation, savedAccount] = this.store.saveBatch([
      { kind: "budget_reservation", id: String(reservation.id), payload: { ...payload(reservation), actual, status: "settled" } },
      { kind: "budget_account", id: String(account.id), payload: { ...payload(account), used: add(account.used as JsonObject, actual),
        reserved: add(account.reserved as JsonObject, reservation.resources as JsonObject, -1) } },
    ]);
    return { reservation: savedReservation, account: savedAccount, available: available(savedAccount), idempotent: false };
  }

  budgetClose(args: JsonObject): JsonObject {
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
