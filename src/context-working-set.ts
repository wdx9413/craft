import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";
import { text } from "./validation.ts";
import type { ContextResolutionKernel } from "./context-resolution.ts";

export const CONTEXT_WORKING_SET_MEMBERS = ["history", "knowledge", "memory", "experience", "state"] as const;
export type ContextWorkingSetMember = typeof CONTEXT_WORKING_SET_MEMBERS[number];
const RETRIEVABLE = new Set<ContextWorkingSetMember>(["knowledge", "memory", "experience"]);

function id(value: unknown): string {
  return value === undefined ? `context_working_set_${randomUUID().replaceAll("-", "")}` : text(value, "working_set_id");
}

function members(value: unknown): ContextWorkingSetMember[] {
  const result = value === undefined ? [...CONTEXT_WORKING_SET_MEMBERS] : value;
  if (!Array.isArray(result) || result.length === 0) throw new Error("members must be a non-empty Context member list");
  const unique = [...new Set(result.map((item) => text(item, "members") as ContextWorkingSetMember))];
  if (unique.some((item) => !CONTEXT_WORKING_SET_MEMBERS.includes(item))) throw new Error("members contains an unsupported Context member");
  return unique;
}

/**
 * A stable seam around ContextResolutionKernel. Host history and runtime state
 * are fixed members, but are not silently treated as searchable memory. Only
 * accumulated members cross the retrieval adapter; the receipt explains this.
 */
export class ContextWorkingSetKernel {
  readonly store: CraftStore;
  readonly resolver: ContextResolutionKernel;
  constructor(store: CraftStore, resolver: ContextResolutionKernel) { this.store = store; this.resolver = resolver; }

  async resolve(args: JsonObject): Promise<JsonObject> {
    const workingSetId = id(args.working_set_id); const selectedMembers = members(args.members);
    const query = text(args.query, "query");
    const retrievalMembers = selectedMembers.filter((item) => RETRIEVABLE.has(item));
    const sourceIds = Array.isArray(args.required_refs) ? args.required_refs.map((item) => text(item, "required_refs")) : [];
    const base = retrievalMembers.length === 0 ? { items: [], contributions: [], receipt: null, skipped: true, reason: "only_host_owned_members" }
      : await this.resolver.resolve({ ...args, query, members: retrievalMembers, ...(sourceIds.length ? { source_ids: sourceIds } : {}) });
    const selectedRefs = [
      ...((base.items as JsonObject[] | undefined) ?? []).map((item) => `${String(item.source_id ?? item.memory_id)}@${String(item.memory_version ?? "latest")}`),
      ...((base.contributions as JsonObject[] | undefined) ?? []).flatMap((item) => Array.isArray(item.items) ? (item.items as JsonObject[]).map((entry) => `${String(entry.ref_id ?? entry.memory_id ?? entry.id)}@${String(entry.version ?? "latest")}`) : []),
    ].filter((value, index, all) => all.indexOf(value) === index).sort();
    const omittedCount = Number((base.receipt as JsonObject | null)?.omitted_count ?? ((base.items as JsonObject[] | undefined)?.length ? 0 : 0));
    const selectionReasons = selectedRefs.map((ref) => ({ ref, reason: "scoped_retrieval" }));
    const identity = { query_digest: stableDigest(query), members: [...selectedMembers].sort(), retrieval_members: [...retrievalMembers].sort(), selected_refs: selectedRefs, omitted_count: omittedCount,
      scope: args.scope_kind === undefined ? null : { kind: text(args.scope_kind, "scope_kind"), id: text(args.scope_id, "scope_id") }, budget: { max_items: Number(args.max_items ?? 12), max_chars: Number(args.max_chars ?? 12_000) }, retrieval_adapter_id: args.retrieval_adapter_id ?? null };
    const existing = this.store.find("context_working_set_receipt", workingSetId);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Context Working Set idempotency conflict");
      return { working_set: existing, selected_refs: selectedRefs, selection_reasons: selectionReasons, idempotent: true };
    }
    const workingSet = this.store.create("context_working_set_receipt", workingSetId, { ...identity, identity_digest: stableDigest(identity), omitted_refs: [], content_free: true,
      host_owned_members: selectedMembers.filter((item) => !RETRIEVABLE.has(item)), source_receipt_id: (base.receipt as JsonObject | null)?.id ?? null });
    return { working_set: workingSet, selected_refs: selectedRefs, omitted_refs: [], selection_reasons: selectionReasons, omitted_count: omittedCount, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { working_set: this.store.get("context_working_set_receipt", text(args.working_set_id, "working_set_id"), args.version === undefined ? undefined : Number(args.version)) }; }
}
