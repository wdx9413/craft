import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { object, text } from "../../validation.ts";

const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value as JsonObject[] : [];

/** Local operator projection. Bodies and privileged receipts never enter this view. */
export class ContextUsageWorkbench {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  retire(args: JsonObject, transition: (member: string, id: string, version: number) => JsonObject): JsonObject {
    const member = text(args.member, "member");
    if (member !== "knowledge" && member !== "memory") throw new Error("Only Knowledge and Memory can be retired here");
    const id = text(args.id, "id"), scope = { kind: text(args.scope_kind, "scope_kind"), id: text(args.scope_id, "scope_id") };
    return this.store.transaction(() => {
      const current = this.store.get(member === "knowledge" ? "knowledge_claim" : "memory_ledger", id);
      const currentScope = typeof current.scope === "string" ? current.scope : `${(current.scope as JsonObject).kind}:${(current.scope as JsonObject).id}`;
      if (currentScope !== `${scope.kind}:${scope.id}` || current.sensitivity === "restricted" || current.version !== args.expected_version) throw new Error("Context scope or version changed; reload before retiring");
      return transition(member, id, Number(current.version));
    });
  }
  get(args: JsonObject): JsonObject {
    const scope = { kind: text(args.scope_kind, "scope_kind"), id: text(args.scope_id, "scope_id") };
    const matches = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value)
      && (value as JsonObject).kind === scope.kind && (value as JsonObject).id === scope.id;
    const found = this.store.list("context_resolution_receipt", 101, item => {
      const access = object(item.scope_access ?? {}, "scope_access");
      return (matches(item.scope) || matches(item.canonical_scope)) && !item.allow_restricted && !access.principal_present && !access.tenant_present;
    });
    const receipts = found.slice(0, 100).map(receipt => {
      const refs = rows(receipt.memory_refs).map(ref => ({ member: "memory", id: ref.memory_id, version: ref.memory_version, digest: ref.content_digest, reason: ref.reason }));
      for (const part of rows(receipt.contributions)) for (const ref of rows(part.references)) refs.push({ member: String(part.member), id: ref.id, version: ref.version, digest: ref.digest, reason: ref.reason });
      const references = refs.map(ref => {
        const kinds: Record<string, string> = { memory: "memory_ledger", knowledge: "knowledge_claim", experience: "experience_procedure" };
        const current = this.store.find(kinds[ref.member]!, String(ref.id));
        const visible = current && current.sensitivity !== "restricted" && (matches(current.scope) || current.scope === `${scope.kind}:${scope.id}`);
        return { ...ref, current_version: visible ? current.version : null, current_status: visible ? current.status ?? current.lifecycle : "unavailable",
          source_id: visible ? current.source_id ?? null : null, author: visible ? current.author ?? current.proposed_by ?? "unknown" : "unknown" };
      });
      const feedback = this.store.list("context_feedback", 100, item => item.receipt_id === receipt.id);
      const decisions = this.store.list("decision_context_gate", 100, item => item.context_receipt_id === receipt.id);
      return { id: receipt.id, created_at: receipt.created_at, execution_context: receipt.execution_context !== false,
        references, contributions: receipt.contributions, retrieval: receipt.retrieval_execution ?? null,
        budget: { max_items: receipt.max_items, max_chars: receipt.max_chars, omitted_count: typeof receipt.omitted_count === "number" && rows(receipt.contributions).every(part => typeof part.omitted_count === "number")
          ? receipt.omitted_count + rows(receipt.contributions).reduce((sum, part) => sum + Number(part.omitted_count), 0) : null },
        explanation: receipt.explanation ?? null, exclusions: receipt.excluded_scopes ?? [],
        task_ids: [...new Set(decisions.map(item => item.task_id))], host_id: null,
        provided: true, followed: "unknown", outcome_verified: feedback.some(item => item.evidence_verified === true),
        feedback: feedback.map(item => ({ outcome: item.outcome, evidence_verified: item.evidence_verified === true })),
        legacy_references_incomplete: rows(receipt.contributions).some(item => Number(item.item_count) > 0 && !Array.isArray(item.references)) };
    });
    return { scope, receipts, truncated: found.length > 100, count: receipts.length, count_basis: "visible_receipts_in_exact_scope", model_effect_proven: false };
  }
}
