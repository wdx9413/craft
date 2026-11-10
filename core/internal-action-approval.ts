import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { digestJson } from "./digest.ts";

export type InternalApprovalPolicy = (action: string, effect: string, args: JsonObject) => "allow" | "deny" | "ask";

type Waiter = { resolve: (value: JsonObject) => void; reject: (error: Error) => void };
const KIND = "internal_action_approval";
const MAX_PENDING = 64;
const TTL_MS = 5 * 60_000;

function isUnexpired(record: JsonObject, now: number): boolean {
  const expiry = Date.parse(String(record.expires_at));
  return Number.isFinite(expiry) && expiry > now;
}

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

  async authorize(action: string, args: JsonObject, effect: string, signal?: AbortSignal): Promise<JsonObject> {
    if (signal?.aborted) throw new Error(`Internal action cancelled: ${action}`);
    if (effect === "read_only") return { approval_ref: null, effect, action };
    const decision = this.policy(action, effect, args);
    if (decision !== "allow" && decision !== "deny" && decision !== "ask") throw new Error("Internal approval policy returned an invalid decision");
    if (decision === "deny") throw new Error(`Internal action denied by host policy: ${action}`);
    const argsDigest = digestJson(args);
    const approvalId = `internal_approval_${randomUUID().replaceAll("-", "")}`;
    this.store.transaction(() => {
      if (decision === "ask" && this.pending().length >= MAX_PENDING) throw new Error("Internal approval queue is full");
      this.store.create(KIND, approvalId, {
        action, effect, args_digest: argsDigest, status: decision === "allow" ? "approved" : "pending",
        expires_at: new Date(Date.now() + TTL_MS).toISOString(), task_id: typeof args.task_id === "string" ? args.task_id : null,
      });
    });
    if (decision === "allow") return { approval_ref: approvalId, effect, action };
    return new Promise<JsonObject>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); clearInterval(poller); signal?.removeEventListener("abort", cancel); this.waiters.delete(approvalId); };
      const cancel = () => {
        cleanup();
        const current = this.store.find(KIND, approvalId);
        if (current && current.status === "pending") this.store.save(KIND, approvalId, { ...current, status: "cancelled", cancelled_at: new Date().toISOString() });
        reject(new Error(`Internal action cancelled: ${action}`));
      };
      this.waiters.set(approvalId, { resolve: () => { cleanup(); resolve({ approval_ref: approvalId, effect, action }); }, reject: (error) => { cleanup(); reject(error); } });
      const timer = setTimeout(() => {
        cleanup();
        try {
          const current = this.store.find(KIND, approvalId);
          if (current && current.status === "pending") this.store.save(KIND, approvalId, { ...current, status: "expired", expired_at: new Date().toISOString() });
        } catch {
          // The original timeout remains authoritative.
        }
        reject(new Error(`Internal action approval timed out: ${action}`));
      }, TTL_MS);
      const poller = setInterval(() => {
        let current: JsonObject | null;
        try { current = this.store.find(KIND, approvalId); } catch { return; }
        if (current?.status === "pending") return;
        const waiter = this.waiters.get(approvalId);
        if (current?.status === "approved" && isUnexpired(current, Date.now())) waiter?.resolve({ approval_ref: approvalId, effect, action });
        else waiter?.reject(new Error(`Internal action approval is no longer available: ${action}`));
      }, 250);
      poller.unref?.();
      timer.unref?.();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      this.store.appendEvent(`internal-approval:${approvalId}`, "approval.requested", { action, effect, args_digest: argsDigest });
    });
  }

  decide(approvalId: string, decision: "accept" | "decline"): JsonObject {
    if (decision !== "accept" && decision !== "decline") throw new Error("Internal approval decision must be accept or decline");
    const saved = this.store.transaction(() => {
    const record = this.store.get(KIND, approvalId);
    if (record.status !== "pending") throw new Error("Internal approval is not pending");
    if (!isUnexpired(record, Date.now())) throw new Error("Internal approval expired");
    const status = decision === "accept" ? "approved" : "denied";
    return this.store.save(KIND, approvalId, { ...record, status, decided_at: new Date().toISOString() });
    });
    const waiter = this.waiters.get(approvalId);
    this.waiters.delete(approvalId);
    if (waiter) {
      if (decision === "accept") waiter.resolve({ approval_ref: approvalId, effect: saved.effect, action: saved.action });
      else waiter.reject(new Error(`Internal action denied: ${saved.action}`));
    }
    return { approval: saved };
  }

  consume(approvalRef: string, action: string, args: JsonObject, effect: string): JsonObject {
    return this.store.transaction(() => {
    const record = this.store.get(KIND, approvalRef);
    if (record.status !== "approved") throw new Error("Internal approval is not approved");
    if (!isUnexpired(record, Date.now())) throw new Error("Internal approval expired");
    if (record.action !== action || record.effect !== effect || record.args_digest !== digestJson(args)) {
      throw new Error("Internal approval does not match the action");
    }
    return { approval: this.store.save(KIND, approvalRef, { ...record, status: "consumed", consumed_at: new Date().toISOString() }) };
    });
  }

  pending(): JsonObject[] {
    const now = Date.now();
    return this.store.list(KIND, 100, (record) => record.status === "pending" && isUnexpired(record, now));
  }

  close(): void {
    this.store.transaction(() => {
      for (const id of this.waiters.keys()) {
        const current = this.store.find(KIND, id);
        if (current && current.status === "pending") this.store.save(KIND, id, { ...current, status: "cancelled", cancelled_at: new Date().toISOString() });
      }
    });
    for (const [id, waiter] of this.waiters) waiter.reject(new Error(`Internal approval cancelled: ${id}`));
    this.waiters.clear();
  }
}

