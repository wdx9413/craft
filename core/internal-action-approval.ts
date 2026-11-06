import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { digestJson } from "./digest.ts";

export type InternalApprovalPolicy = (action: string, effect: string, args: JsonObject) => "allow" | "deny" | "ask";

type Waiter = { resolve: (value: JsonObject) => void; reject: (error: Error) => void };
const KIND = "internal_action_approval";
const MAX_PENDING = 64;
const TTL_MS = 5 * 60_000;

/**
 * Human approval for Craft's own loop. A tool argument cannot mint approval:
 * the host policy creates or waits for a one-time, digest-bound record.
 */
export class InternalActionApprovalBroker {
  readonly store: CraftStore;
  policy: InternalApprovalPolicy;
  private readonly waiters = new Map<string, Waiter>();

  constructor(store: CraftStore, policy: InternalApprovalPolicy = () => "ask") {
    this.store = store;
    this.policy = policy;
  }

  setPolicy(policy: InternalApprovalPolicy): void {
    this.policy = policy;
  }

  async authorize(action: string, args: JsonObject, effect: string): Promise<JsonObject> {
    if (effect === "read_only") return { approval_ref: null, effect, action };
    const decision = this.policy(action, effect, args);
    if (decision === "deny") throw new Error(`Internal action denied by host policy: ${action}`);
    const argsDigest = digestJson(args);
    const approvalId = `internal_approval_${randomUUID().replaceAll("-", "")}`;
    const record = this.store.create(KIND, approvalId, {
      action, effect, args_digest: argsDigest, status: decision === "allow" ? "approved" : "pending",
      expires_at: new Date(Date.now() + TTL_MS).toISOString(), task_id: typeof args.task_id === "string" ? args.task_id : null,
    });
    if (decision === "allow") return { approval_ref: approvalId, effect, action };
    if (this.pending().length >= MAX_PENDING) throw new Error("Internal approval queue is full");
    return new Promise<JsonObject>((resolve, reject) => {
      this.waiters.set(approvalId, { resolve: () => resolve({ approval_ref: approvalId, effect, action }), reject });
      const timer = setTimeout(() => {
        this.waiters.delete(approvalId);
        try {
          const current = this.store.find(KIND, approvalId);
          if (current && current.status === "pending") this.store.save(KIND, approvalId, { ...current, status: "expired", expired_at: new Date().toISOString() });
        } catch {
          // The original timeout remains authoritative.
        }
        reject(new Error(`Internal action approval timed out: ${action}`));
      }, TTL_MS);
      timer.unref?.();
      this.store.appendEvent(`internal-approval:${approvalId}`, "approval.requested", { action, effect, args_digest: argsDigest });
    });
  }

  decide(approvalId: string, decision: "accept" | "decline"): JsonObject {
    const record = this.store.get(KIND, approvalId);
    if (record.status !== "pending") throw new Error("Internal approval is not pending");
    if (Date.parse(String(record.expires_at)) <= Date.now()) throw new Error("Internal approval expired");
    const status = decision === "accept" ? "approved" : "denied";
    const saved = this.store.save(KIND, approvalId, { ...record, status, decided_at: new Date().toISOString() });
    const waiter = this.waiters.get(approvalId);
    this.waiters.delete(approvalId);
    if (waiter) {
      if (decision === "accept") waiter.resolve({ approval_ref: approvalId, effect: record.effect, action: record.action });
      else waiter.reject(new Error(`Internal action denied: ${record.action}`));
    }
    return { approval: saved };
  }

  consume(approvalRef: string, action: string, args: JsonObject, effect: string): JsonObject {
    const record = this.store.get(KIND, approvalRef);
    if (record.status !== "approved") throw new Error("Internal approval is not approved");
    if (Date.parse(String(record.expires_at)) <= Date.now()) throw new Error("Internal approval expired");
    if (record.action !== action || record.effect !== effect || record.args_digest !== digestJson(args)) {
      throw new Error("Internal approval does not match the action");
    }
    return { approval: this.store.save(KIND, approvalRef, { ...record, status: "consumed", consumed_at: new Date().toISOString() }) };
  }

  pending(): JsonObject[] {
    return this.store.list(KIND, 100, (record) => record.status === "pending");
  }

  close(): void {
    for (const [id, waiter] of this.waiters) waiter.reject(new Error(`Internal approval cancelled: ${id}`));
    this.waiters.clear();
  }
}

