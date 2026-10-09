import type { ContextContribution, ContextContributionProvider, ContextRequest } from "../../common/craft-common-base/src/capability-protocol.ts";
import { ContextBudget, contextAssetMatches, contextAssetRef } from "../../common/craft-common-base/src/context-assets.ts";
import { canonicalJson, stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { KeywordRetrievalPort, temporalMemorySelect } from "../../common/craft-common-base/src/retrieval-port.ts";
import { scopeAllows, scopeEnvelope, scopeEnvelopeReceipt, sourceAllows, type ScopeAccess } from "../../common/craft-common-base/src/scope-policy.ts";
import { text } from "../../common/craft-common-base/src/validation.ts";
import { contentReference } from "../../common/craft-common-store-local/src/content-store.ts";
import { ContextReadGuard, ContextAccessChangedError } from "../../common/craft-common-store-local/src/context-access-guard.ts";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { latestMemoryConfirmation } from "./memory-governance.ts";
import { memoryDecayWeight } from "./memory-signals.ts";

/** Owns Memory eligibility and read snapshots. Shared retrieval and pack budgets stay in Context. */
export class MemoryContribution implements ContextContributionProvider {
  readonly member = "memory" as const;
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  async contribute(request: ContextRequest): Promise<ContextContribution> {
    const budget = new ContextBudget(request.max_items, request.max_chars);
    const now = new Date(request.now === undefined ? Date.now() : text(request.now, "now"));
    if (!Number.isFinite(now.valueOf())) throw new Error("now must be an ISO timestamp");
    const validAt = request.as_of === undefined ? now : new Date(text(request.as_of, "as_of"));
    if (!Number.isFinite(validAt.valueOf())) throw new Error("as_of must be an ISO timestamp");
    const historical = request.history_view === true || request.as_of !== undefined || request.known_at !== undefined;
    const scopes = request.scope_stack ?? [{ kind: request.scope_kind, id: request.scope_id }];
    const requestedIds = request.memory_ids ?? [], requiredRefs = request.required_refs ?? [];
    const sourceIds = request.source_ids ?? [], selectedSourceIds = sourceIds.length ? new Set(sourceIds) : null;
    const access: ScopeAccess = { principal_id: request.principal_id, principal_ids: request.principal_ids, tenant_id: request.tenant_id, purpose: request.cognitive_purpose };
    const guard = new ContextReadGuard(this.store, undefined, scopes, sourceIds);
    const sources = new Map<string, JsonObject | null>();
    const sourceOf = (id: string) => {
      if (!sources.has(id)) {
        const source = this.store.find("knowledge_source", id, undefined, false);
        if (sources.size >= 10_001) return source;
        sources.set(id, source);
      }
      return sources.get(id);
    };
    for (const sourceId of sourceIds) {
      guard.track("knowledge_source", sourceId);
      const source = sourceOf(sourceId);
      if (!source || source.status !== "active" || source.trust === "untrusted" || !sourceAllows(source, access)) throw new Error("Requested Knowledge Source is unavailable in this Context");
    }
    const readable = (item: JsonObject) => {
      const source = sourceOf(String(item.source_id));
      const envelope = scopeEnvelope(item.scope_envelope, item.scope as { kind: string; id: string });
      const latest = this.store.find("memory_ledger", String(item.id), undefined, false);
      if (!latest) return false;
      if (!scopeAllows(scopeEnvelope(latest.scope_envelope, latest.scope as { kind: string; id: string }), access)
        || canonicalJson(latest.scope) !== canonicalJson(item.scope) || request.allow_restricted !== true && latest.sensitivity === "restricted") return false;
      return (request.history_view === true || item.status === "active") && source?.status === "active" && source.trust !== "untrusted" && sourceAllows(source, access) && scopeAllows(envelope, access)
        && (item.kind !== "working" || request.include_working_notes === true || item.working_note !== true || requestedIds.includes(String(item.id)))
        && (request.allow_restricted === true || item.sensitivity !== "restricted")
        && (selectedSourceIds === null || selectedSourceIds.has(String(item.source_id)));
    };
    const records = this.records(request, readable, scopes);
    const candidates = records.map(memory => ({ memory, body: this.content(memory) }));
    const scopeRank = new Map(scopes.map((scope, index) => [canonicalJson(scope), index]));
    const preferred = new Map<string, number>();
    const topicOf = (memory: JsonObject) => typeof memory.topic === "string" && memory.topic ? memory.topic : `entry:${memory.id}`;
    for (const { memory } of candidates) {
      const topic = topicOf(memory), rank = scopeRank.get(canonicalJson(memory.scope))!;
      preferred.set(topic, Math.min(preferred.get(topic) ?? Number.MAX_SAFE_INTEGER, rank));
    }
    const scoped = candidates.filter(({ memory }) => request.history_view === true || scopeRank.get(canonicalJson(memory.scope))! === preferred.get(topicOf(memory)));
    const temporal = temporalMemorySelect(scoped.map(item => item.memory), validAt, request.history_view === true);
    const available = scoped.filter(item => temporal.selected.some(memory => memory.id === item.memory.id && memory.version === item.memory.version));
    for (const item of available) { guard.track("memory_ledger", String(item.memory.id)); guard.track("knowledge_source", String(item.memory.source_id)); }
    const recheck = () => {
      sources.clear();
      if (available.some(item => !readable(item.memory))) throw new ContextAccessChangedError();
      guard.assertCurrent();
    };
    const feedback = this.store.list("context_feedback", 10_000, item => item.outcome === "helpful" && item.evidence_verified === true, false);
    const items = available.map(({ memory, body }) => {
      const confirmedAt = latestMemoryConfirmation(this.store, memory, now.toISOString());
      const usage = feedback.filter(item => (item.memory_refs as JsonObject[]).some(ref => ref.memory_id === memory.id && ref.content_digest === memory.content_digest)).length;
      const weight = memoryDecayWeight({ confirmed_at: confirmedAt ?? memory.observed_at ?? memory.updated_at, now: now.toISOString(), accesses: usage, trust: sourceOf(String(memory.source_id))!.trust === "verified" ? "verified" : "bounded" });
      return { memory_id: memory.id, memory_version: memory.version, source_id: memory.source_id, content: body, content_digest: memory.content_digest,
        sensitivity: memory.sensitivity, status: memory.status, scope: memory.scope, scope_envelope: scopeEnvelopeReceipt(scopeEnvelope(memory.scope_envelope, memory.scope as { kind: string; id: string })),
        ranking_weight: weight, confirmed_at: confirmedAt, execution_context: !historical } satisfies JsonObject;
    });
    const required = (item: JsonObject) => requestedIds.includes(String(item.memory_id)) || requiredRefs.some(ref => contextAssetMatches(ref, contextAssetRef("memory", item, item.scope as JsonObject)));
    let selected = items, matchingCount = items.length;
    if (request.candidate_mode !== true) {
      recheck();
      const ranking = await new KeywordRetrievalPort().search(request.query, items.map(item => ({ id: `${item.memory_id}@${item.memory_version}`, body: String(item.content) })));
      recheck();
      const scores = new Map(ranking.hits.map(hit => [hit.id, hit.score]));
      const ranked = items.filter(item => required(item) || scores.has(`${item.memory_id}@${item.memory_version}`)).sort((a, b) => Number(required(b)) - Number(required(a)) || (scores.get(`${b.memory_id}@${b.memory_version}`) ?? 0) - (scores.get(`${a.memory_id}@${a.memory_version}`) ?? 0) || b.ranking_weight - a.ranking_weight || String(a.memory_id).localeCompare(String(b.memory_id)));
      matchingCount = ranked.length;
      for (const id of requestedIds) if (!ranked.some(item => item.memory_id === id)) throw new Error("Required Memory is unavailable in this Context");
      for (const ref of requiredRefs.filter(ref => ref.member === "memory")) if (!ranked.some(item => contextAssetMatches(ref, contextAssetRef("memory", item, item.scope as JsonObject)))) throw new Error("Required Context reference is unavailable");
      selected = ranked.filter(item => budget.reserve(1, String(item.content).length, required(item), "Required Memory or Context reference exceeds Context budget"));
    } else if (items.length > request.max_items || items.reduce((n, item) => n + JSON.stringify(item).length, 0) > request.max_chars) throw new Error("Memory candidate budget exceeded; narrow scope or source selection");
    return this.store.transaction(() => {
      recheck();
      return { member: this.member, items: selected, receipt_id: `memory_contribution_${stableDigest(selected).slice(-24)}`, omitted_count: matchingCount - selected.length, read_refs: guard.refs(),
        diagnostics: { eligible_memory_count: candidates.length, after_scope_precedence_count: scoped.length, after_temporal_policy_count: available.length, temporal_excluded: temporal.excluded } };
    });
  }

  private records(request: ContextRequest, readable: (item: JsonObject) => boolean, scopes: readonly { kind: string; id: string }[]): JsonObject[] {
    if (request.history_view !== true && request.as_of === undefined && request.known_at === undefined) {
      const candidates = this.store.listScoped("memory_ledger", scopes, 10_001, readable);
      if (candidates.length > 10_000) throw new Error("Memory candidate budget exceeded; narrow scope or source selection");
      return candidates;
    }
    const knownAt = request.known_at ?? request.as_of;
    if (knownAt !== undefined && !Number.isFinite(Date.parse(knownAt))) throw new Error("known_at must be an ISO timestamp");
    const candidates = this.store.listScoped("memory_ledger", scopes, 10_001, readable, { known_at: knownAt, history: request.history_view === true });
    if (candidates.length > 10_000) throw new Error("Memory history budget exceeded; narrow the ledger before historical retrieval");
    return candidates;
  }

  private content(memory: JsonObject): string {
    if (typeof memory.content === "string") return memory.content;
    if (!contentReference(memory.content_ref)) throw new Error("Memory content reference is missing");
    return this.store.contentStore.readCompatSync(memory.content_ref).body;
  }
}
