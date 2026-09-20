/**
 * Resolve context at the moment an irreversible or high-leverage decision is
 * about to be made.  A Context receipt produced after the decision is useful
 * for audit, but cannot prevent the original error; this gate makes the timing
 * explicit without creating a second memory store.
 */
import { createHash, randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import type { ContextResolutionKernel } from "./context-resolution.ts";
import { text } from "./validation.ts";

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export class DecisionPointContextGate {
  readonly store: CraftStore;
  readonly context: ContextResolutionKernel;
  constructor(store: CraftStore, context: ContextResolutionKernel) { this.store = store; this.context = context; }

  async open(args: JsonObject): Promise<JsonObject> {
    const decisionKind = text(args.decision_kind, "decision_kind");
    const query = text(args.query, "query");
    const taskId = args.task_id === undefined ? null : text(args.task_id, "task_id");
    if (taskId !== null) this.store.get("task", taskId);
    const required = args.require_context === true;
    const resolution = await this.context.resolve({ query, scope_kind: args.scope_kind, scope_id: args.scope_id,
      memory_ids: args.memory_ids, source_ids: args.source_ids, retrieval_adapter_id: args.retrieval_adapter_id,
      max_items: args.max_items, max_chars: args.max_chars, allow_restricted: args.allow_restricted, receipt_id: args.context_receipt_id });
    const items = (resolution.items as JsonObject[] | undefined) ?? [];
    const receipt = resolution.receipt as JsonObject | null | undefined;
    const skipped = resolution.skipped === true;
    const status = skipped ? "skipped" : required && items.length === 0 ? "blocked" : "ready";
    const action = status === "ready" ? "continue" : status === "blocked" ? "clarify_or_replan" : "declare_scope";
    const identity = { task_id: taskId, decision_kind: decisionKind, query_digest: digest(query), scope_kind: args.scope_kind ?? null, scope_id: args.scope_id ?? null,
      context_receipt_id: receipt?.id ?? null, context_receipt_version: receipt?.version ?? null, required, status, action };
    const gateId = String(args.gate_id ?? `decision_context_gate_${randomUUID().replaceAll("-", "")}`);
    const existing = this.store.find("decision_context_gate", gateId); const identityDigest = digest(identity);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Decision Context Gate idempotency conflict");
      return { gate: existing, resolution, idempotent: true };
    }
    const gate = this.store.create("decision_context_gate", gateId, { ...identity, identity_digest: identityDigest,
      selected_memory_count: items.length, skipped_reason: skipped ? resolution.reason ?? "scope_unavailable" : null });
    return { gate, resolution, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { gate: this.store.get("decision_context_gate", text(args.gate_id, "gate_id")) }; }
}
