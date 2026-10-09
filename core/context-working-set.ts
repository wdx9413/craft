import { assertContextReadCurrent } from "./context-access-guard.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";
import { text } from "./validation.ts";
import type { ContextResolutionKernel } from "./context-resolution.ts";
import { ContextBudget, ContextBudgetError, contextAssetKey, contextAssetRef, contextAssetMatches, requiredContextRef } from "../common/craft-common-base/src/context-assets.ts";

export const CONTEXT_WORKING_SET_MEMBERS = ["history", "knowledge", "memory", "experience", "state"] as const;
export type ContextWorkingSetMember = typeof CONTEXT_WORKING_SET_MEMBERS[number];
const RETRIEVABLE = new Set<ContextWorkingSetMember>(["knowledge", "memory", "experience"]);

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
    const selectedMembers = members(args.members);
    const query = text(args.query, "query");
    const retrievalMembers = selectedMembers.filter((item) => RETRIEVABLE.has(item));
    if (args.required_refs !== undefined && !Array.isArray(args.required_refs)) throw new Error("required_refs must be an array");
    const required = Array.isArray(args.required_refs) ? args.required_refs : [];
    const sourceIds = required.filter(item => typeof item === "string").map(item => text(item, "required_refs"));
    const hostRefs = selectedMembers.filter(member => !RETRIEVABLE.has(member)).flatMap(member => {
      const values = args[`${member}_refs`] ?? [];
      if (!Array.isArray(values)) throw new Error(`${member}_refs must be an array`);
      return values.map(item => contextAssetRef(member, item, { kind: args.scope_kind, id: args.scope_id }));
    });
    const typedRequired = required.filter(item => typeof item !== "string").map(requiredContextRef);
    for (const ref of typedRequired.filter(ref => ["history", "state"].includes(String(ref.member)))) if (!hostRefs.some(actual => contextAssetMatches(ref, actual))) throw new Error("Required Host reference is unavailable");
    const hostChars = JSON.stringify(hostRefs).length - 2, maxItems = Number(args.max_items ?? 12), maxChars = Number(args.max_chars ?? 12000);
    const budget = new ContextBudget(maxItems, maxChars);
    budget.reserve(hostRefs.length, hostChars, true, "Host references exceed Context budget or budget is invalid");
    if (args.empty_budget === true && hostRefs.length > 0) throw new ContextBudgetError("Required Host references exceed Context budget");
    // Codebase is a task projection, not a sixth accumulative Context member.
    // Open authenticates its index before supplying normalized, content-free candidates.
    if (args.codebase_candidates !== undefined && !Array.isArray(args.codebase_candidates)) throw new Error("codebase_candidates must be an array");
    const scope = { kind: args.scope_kind, id: args.scope_id };
    const codeRequired = typedRequired.filter(ref => ref.member === "codebase");
    const codeCandidates = ((args.codebase_candidates ?? []) as JsonObject[]).map(item => ({ item, ref: contextAssetRef("codebase", item, scope) }));
    for (const ref of codeRequired) if (!codeCandidates.some(candidate => contextAssetMatches(ref, candidate.ref))) throw new Error("Required Codebase reference is unavailable");
    codeCandidates.sort((a, b) => Number(codeRequired.some(ref => contextAssetMatches(ref, b.ref))) - Number(codeRequired.some(ref => contextAssetMatches(ref, a.ref))));
    const retrievalRequired = typedRequired.filter(ref => !["history", "state", "codebase"].includes(String(ref.member)));
    const references: JsonObject[] = []; let budgetOmitted = 0; let budgetRebalanced = false;
    const requiredCode = (ref: JsonObject) => codeRequired.some(required => contextAssetMatches(required, ref));
    const selectCode = (itemLimit: number) => {
      for (const candidate of codeCandidates) {
        const mandatory = requiredCode(candidate.ref);
        if (!mandatory && references.length >= itemLimit || !budget.reserve(1, JSON.stringify(candidate.item).length, mandatory, "Required Codebase reference exceeds Context budget")) {
          budgetOmitted++; continue;
        }
        references.push(candidate.item);
      }
    };
    const codeFirst = args.prefer_codebase === true || codeRequired.length > 0;
    const memoryIds = Array.isArray(args.memory_ids) ? args.memory_ids : [];
    const mandatoryRetrievalCount = new Set([...retrievalRequired.map(ref => `${ref.member}:${ref.id}`), ...memoryIds.map(id => `memory:${id}`)]).size;
    if (retrievalMembers.length === 0 && mandatoryRetrievalCount > 0) throw new Error("Required Context reference is excluded by members");
    if (args.empty_budget === true && codeRequired.length > 0) throw new ContextBudgetError("Required Codebase reference exceeds Context budget");
    if (codeFirst && args.empty_budget !== true) selectCode(Math.max(codeRequired.length, Math.min(Math.ceil(maxItems / 3), Math.max(0, maxItems - hostRefs.length - mandatoryRetrievalCount))));
    const resolve = async (): Promise<JsonObject> => {
      const exhausted = args.empty_budget === true || budget.items === maxItems || budget.chars === maxChars;
      if (exhausted && (retrievalRequired.length > 0 || memoryIds.length)) throw new ContextBudgetError("Required Context reference exceeds Context budget");
      return retrievalMembers.length === 0 || exhausted ? { items: [], contributions: [], receipt: null, skipped: true, reason: exhausted ? "context_budget_exhausted" : "only_host_owned_members" }
        : this.resolver.resolve({ ...args, query, max_items: maxItems - budget.items, max_chars: maxChars - budget.chars, members: retrievalMembers, required_refs: retrievalRequired, ...(sourceIds.length ? { source_ids: sourceIds } : {}) });
    };
    let base: JsonObject;
    try { base = await resolve(); }
    catch (error) {
      const mandatory = references.filter(item => requiredCode(contextAssetRef("codebase", item, scope)));
      if (!(error instanceof ContextBudgetError) || mandatory.length === references.length) throw error;
      budgetOmitted += references.length - mandatory.length; references.splice(0, references.length, ...mandatory); budgetRebalanced = true;
      budget.items = hostRefs.length + references.length;
      budget.chars = hostChars + references.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
      base = await resolve();
    }
    assertContextReadCurrent(this.store, base.receipt as JsonObject | null);
    const receipt = base.receipt as JsonObject | null;
    budget.reserve(Number(receipt?.total_items ?? 0), Number(receipt?.total_used_chars ?? 0), true, "Recalled Context exceeds Context budget");
    if (!codeFirst && args.empty_budget !== true) selectCode(maxItems - budget.items);
    const projection = { codebase_references: references, codebase_budget_omitted_count: budgetOmitted, codebase_budget_rebalanced: budgetRebalanced, total_items: budget.items, total_used_chars: budget.chars };
    const assetRefs = [ ...hostRefs,
      ...((base.items as JsonObject[] | undefined) ?? []).map(item => contextAssetRef("memory", item, scope)),
      ...((base.contributions as JsonObject[] | undefined) ?? []).flatMap(part => Array.isArray(part.items) ? (part.items as JsonObject[]).map(item => contextAssetRef(String(part.member), item, scope)) : []),
      ...references.map(item => contextAssetRef("codebase", item, scope)),
    ];
    const selectedRefs = [...new Set(assetRefs.map(contextAssetKey))].sort();
    const omittedCount = Number(receipt?.omitted_count ?? 0) + ((base.contributions as JsonObject[] | undefined) ?? []).reduce((sum, part) => sum + Number(part.omitted_count), 0) + budgetOmitted;
    const selectionReasons = selectedRefs.map((ref) => ({ ref, reason: ref.startsWith("codebase:") ? "codebase_projection" : ref.startsWith("history:") || ref.startsWith("state:") ? "host_reference" : "scoped_retrieval" }));
    const identity = { codebase_projection: { asset_refs: references.map(item => contextAssetRef("codebase", item, scope)), budget_omitted_count: budgetOmitted, budget_rebalanced: budgetRebalanced }, total_items: budget.items, total_used_chars: budget.chars, query_digest: stableDigest(query), task_id: args.task_id ?? null, session_id: args.session_id ?? null, turn_id: args.turn_id ?? null, source_receipt_id: (base.receipt as JsonObject | null)?.id ?? null, members: [...selectedMembers].sort(), retrieval_members: [...retrievalMembers].sort(), host_refs: hostRefs, asset_refs: assetRefs, selected_refs: selectedRefs, omitted_count: omittedCount,
      scope: args.scope_kind === undefined ? null : { kind: text(args.scope_kind, "scope_kind"), id: text(args.scope_id, "scope_id") }, budget: { max_items: Number(args.max_items ?? 12), max_chars: Number(args.max_chars ?? 12_000) }, retrieval_adapter_id: args.retrieval_adapter_id ?? null };
    const workingSetId = args.working_set_id === undefined ? `context_working_set_${stableDigest(identity).slice(-32)}` : text(args.working_set_id, "working_set_id");
    return this.store.transaction(() => {
      assertContextReadCurrent(this.store, base.receipt as JsonObject | null);
      const existing = this.store.find("context_working_set_receipt", workingSetId);
      if (existing) {
        if (existing.identity_digest !== stableDigest(identity)) throw new Error("Context Working Set idempotency conflict");
        return { ...base, ...projection, working_set: existing, host_used_chars: hostChars, host_items: hostRefs.length, host_refs: hostRefs, asset_refs: assetRefs, selected_refs: selectedRefs, selection_reasons: selectionReasons, omitted_refs: [], omitted_count: omittedCount, idempotent: true };
      }
      const workingSet = this.store.create("context_working_set_receipt", workingSetId, { ...identity, identity_digest: stableDigest(identity), omitted_refs: [], content_free: true,
        asset_refs: assetRefs, host_owned_members: selectedMembers.filter((item) => !RETRIEVABLE.has(item)), source_receipt_id: (base.receipt as JsonObject | null)?.id ?? null });
      return { ...base, ...projection, working_set: workingSet, host_used_chars: hostChars, host_items: hostRefs.length, host_refs: hostRefs, asset_refs: assetRefs, selected_refs: selectedRefs, omitted_refs: [], selection_reasons: selectionReasons, omitted_count: omittedCount, idempotent: false };
    });
  }

  /** A Hook emission is a transport fact, not verified model use or permanent recall permission. */
  recordEmission(args: JsonObject, resolved: JsonObject): void {
    if (!args.session_id || !args.turn_id) return;
    const identity = { session_id: args.session_id, turn_id: args.turn_id, query_digest: stableDigest(args.query), scope: { kind: args.scope_kind, id: args.scope_id } };
    const emissionId = `context_emission_${stableDigest(identity).slice(-24)}`;
    const refs = resolved.asset_refs as JsonObject[];
    const prior = this.store.find("context_emission", emissionId);
    if (prior && stableDigest(prior.asset_refs) === stableDigest(refs)) return;
    this.store.save("context_emission", emissionId, { ...identity, asset_refs: refs, source_receipt_id: (resolved.receipt as JsonObject | null)?.id ?? null, provenance: "hook_output_emitted", model_use_verified: false, content_free: true });
  }

  emittedRefs(args: JsonObject, refs: JsonObject[]): JsonObject[] {
    if (!args.session_id || !args.turn_id) return [];
    const identity = { session_id: args.session_id, turn_id: args.turn_id, query_digest: stableDigest(args.query), scope: { kind: args.scope_kind, id: args.scope_id } };
    const prior = this.store.find("context_emission", `context_emission_${stableDigest(identity).slice(-24)}`);
    if (!prior) return [];
    return refs.filter(ref => (prior.asset_refs as JsonObject[]).some(emitted => contextAssetMatches(emitted, ref)));
  }

  get(args: JsonObject): JsonObject { return { working_set: this.store.get("context_working_set_receipt", text(args.working_set_id, "working_set_id"), args.version === undefined ? undefined : Number(args.version)) }; }
}
