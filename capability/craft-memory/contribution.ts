import { observeOperation } from "../../common/craft-common-log/src/index.ts";
import type { ContextContribution, ContextContributionProvider, ContextRequest } from "../../common/craft-common-base/src/capability-protocol.ts";
import { ContextBudget, contextAssetMatches, contextAssetRef } from "../../common/craft-common-base/src/context-assets.ts";
import { canonicalJson, stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { Bm25Index } from "../../common/craft-common-base/src/bm25.ts";
import { retrievalExcerpt } from "../../common/craft-common-base/src/retrieval-excerpt.ts";
import { temporalMemorySelect } from "../../common/craft-common-base/src/memory-temporal-policy.ts";
import { scopeAllows, scopeEnvelope, scopeEnvelopeReceipt, sourceAllows, type ScopeAccess } from "../../common/craft-common-base/src/scope-policy.ts";
import { text } from "../../common/craft-common-base/src/validation.ts";
import { contentReference } from "../../common/craft-common-store-local/src/content-store.ts";
import { ContextReadGuard, ContextAccessChangedError } from "../../common/craft-common-store-local/src/context-access-guard.ts";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { latestMemoryConfirmation } from "./memory-governance.ts";
import { MemoryLedgerKernel } from "./memory-ledger.ts";
import { memoryDecayWeight } from "./memory-signals.ts";

const MEMORY_INDEX_CACHE_TTL_MS = 60_000;
const MEMORY_INDEX_CACHE_MAX_ENTRIES = 4;
const MEMORY_INDEX_CACHE_MAX_SOURCE_CHARS = 256_000;
interface CachedMemoryIndex { index: Bm25Index; expires_at: number }

/** Owns Memory eligibility and read snapshots. Shared retrieval and pack budgets stay in Context. */
export class MemoryContribution implements ContextContributionProvider {
  readonly member = "memory" as const;
  readonly store: CraftStore;
  readonly ledger: MemoryLedgerKernel;
  readonly #searchIndexes = new Map<string, CachedMemoryIndex>();
  constructor(store: CraftStore) { this.store = store; this.ledger = new MemoryLedgerKernel(store); }

  async contribute(request: ContextRequest): Promise<ContextContribution> {
    return observeOperation(this.store, "memory", "contribute", request, () => this.readContribution(request));
  }

  private async readContribution(request: ContextRequest): Promise<ContextContribution> {
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
      return (request.history_view === true || item.status === "active" && this.ledger.promotionSupported(item)) && source?.status === "active" && source.trust !== "untrusted" && sourceAllows(source, access) && scopeAllows(envelope, access)
        && (item.kind !== "working" || request.include_working_notes === true || item.working_note !== true || requestedIds.includes(String(item.id)))
        && (request.allow_restricted === true || item.sensitivity !== "restricted")
        && (selectedSourceIds === null || selectedSourceIds.has(String(item.source_id)));
    };
    const records = this.records(request, readable, scopes);
    // Expired or not-yet-effective overrides must not hide a valid broader preference.
    const temporalParts = scopes.map(scope => temporalMemorySelect(records.filter(memory => canonicalJson(memory.scope) === canonicalJson(scope)), validAt, request.history_view === true));
    const temporal = { selected: temporalParts.flatMap(part => part.selected), excluded: temporalParts.flatMap(part => part.excluded) };
    const candidates = temporal.selected.map(memory => ({ memory }));
    const scopeRank = new Map(scopes.map((scope, index) => [canonicalJson(scope), index]));
    const preferred = new Map<string, number>();
    const topicOf = (memory: JsonObject) => typeof memory.topic === "string" && memory.topic ? memory.topic : `entry:${memory.id}`;
    for (const { memory } of candidates) {
      const topic = topicOf(memory), rank = scopeRank.get(canonicalJson(memory.scope))!;
      preferred.set(topic, Math.min(preferred.get(topic) ?? Number.MAX_SAFE_INTEGER, rank));
    }
    const scoped = candidates.filter(({ memory }) => request.history_view === true || scopeRank.get(canonicalJson(memory.scope))! === preferred.get(topicOf(memory)));
    const available = scoped;
    for (const item of available) { guard.track("memory_ledger", String(item.memory.id)); guard.track("knowledge_source", String(item.memory.source_id)); }
    const recheck = () => {
      sources.clear();
      if (available.some(item => !readable(item.memory))) throw new ContextAccessChangedError();
      guard.assertCurrent();
    };
    const feedback = this.store.list("context_feedback", 10_000, item => item.outcome === "helpful" && item.evidence_verified === true, false);
    const usages = new Map<string, number>();
    for (const item of feedback) {
      const references = Array.isArray(item.memory_refs) ? item.memory_refs as JsonObject[] : [];
      const used = new Set(references.filter(ref => ref && typeof ref.memory_id === "string" && typeof ref.content_digest === "string")
        .map(ref => canonicalJson([ref.memory_id, ref.content_digest])));
      for (const key of used) usages.set(key, (usages.get(key) ?? 0) + 1);
    }
    const snapshot = stableDigest({ scopes, access: { ...access, allow_restricted: request.allow_restricted === true, source_ids: selectedSourceIds ? [...selectedSourceIds].sort() : [] }, candidates: available.map(({ memory }) => ({
      id: memory.id, version: memory.version, content_digest: memory.content_digest, source_id: memory.source_id, source_version: memory.source_version,
      scope: memory.scope, scope_envelope: memory.scope_envelope, topic: memory.topic, kind: memory.kind, status: memory.status,
      valid_until: memory.valid_until, effective_from: memory.effective_from,
    })) });
    const cached = this.getSearchIndex(snapshot);
    const bodies = new Map<string, string>();
    let searchIndex = cached?.index;
    let bodyLoadCount = 0;
    let indexedSourceChars = 0;
    if (!searchIndex) {
      searchIndex = new Bm25Index();
      for (const { memory } of available) {
        const id = `${memory.id}@${memory.version}`;
        const body = this.content(memory);
        bodyLoadCount++;
        indexedSourceChars += body.length;
        bodies.set(id, body);
        if (body.trim()) searchIndex.add(id, body);
      }
      recheck();
      if (indexedSourceChars <= MEMORY_INDEX_CACHE_MAX_SOURCE_CHARS) this.cacheSearchIndex(snapshot, searchIndex);
    }
    const scores = new Map(searchIndex.score(request.query).map(hit => [hit.id, hit.score]));
    recheck();
    const items = available.map(({ memory }) => {
      const confirmedAt = latestMemoryConfirmation(this.store, memory, now.toISOString());
      const usage = usages.get(canonicalJson([memory.id, memory.content_digest])) ?? 0;
      const weight = memoryDecayWeight({ confirmed_at: confirmedAt ?? memory.observed_at ?? memory.updated_at, now: now.toISOString(), accesses: usage, trust: sourceOf(String(memory.source_id))!.trust === "verified" ? "verified" : "bounded" });
      return { memory, item: { memory_id: memory.id, memory_version: memory.version, source_id: memory.source_id, content_digest: memory.content_digest,
        sensitivity: memory.sensitivity, status: memory.status, scope: memory.scope, scope_envelope: scopeEnvelopeReceipt(scopeEnvelope(memory.scope_envelope, memory.scope as { kind: string; id: string })),
        ranking_weight: weight, confirmed_at: confirmedAt, execution_context: !historical } satisfies JsonObject };
    });
    const required = ({ item }: { item: JsonObject }) => requestedIds.includes(String(item.memory_id)) || requiredRefs.some(ref => contextAssetMatches(ref, contextAssetRef("memory", item, item.scope as JsonObject)));
    const ranked = items.filter(({ item }) => required({ item }) || scores.has(`${item.memory_id}@${item.memory_version}`))
      .sort((a, b) => Number(required(b)) - Number(required(a)) || (scores.get(`${b.item.memory_id}@${b.item.memory_version}`) ?? 0) - (scores.get(`${a.item.memory_id}@${a.item.memory_version}`) ?? 0) || Number(b.item.ranking_weight) - Number(a.item.ranking_weight) || String(a.item.memory_id).localeCompare(String(b.item.memory_id)));
    const matchingCount = ranked.length;
    for (const id of requestedIds) if (!ranked.some(({ item }) => item.memory_id === id)) throw new Error("Required Memory is unavailable in this Context");
    for (const ref of requiredRefs.filter(ref => ref.member === "memory")) if (!ranked.some(({ item }) => contextAssetMatches(ref, contextAssetRef("memory", item, item.scope as JsonObject)))) throw new Error("Required Context reference is unavailable");
    const selected: JsonObject[] = [];
    for (const { memory, item } of ranked) {
      if (selected.length >= budget.maxItems) break;
      const cachedBody = bodies.get(`${item.memory_id}@${item.memory_version}`);
      const body = cachedBody ?? this.content(memory);
      if (cachedBody === undefined) bodyLoadCount++;
      let projection: JsonObject = { ...item, content: body };
      if (request.candidate_mode === true && !required({ item }) && typeof body === "string") {
        const excerpt = retrievalExcerpt(body, request.query, 600);
        if (excerpt.reason !== "complete") projection = { ...projection, content: excerpt.text, content_excerpt: {
          source_start: excerpt.source_start, source_end: excerpt.source_end, source_chars: excerpt.source_chars, reason: excerpt.reason,
          ...(excerpt.matched_terms ? { matched_terms: excerpt.matched_terms } : {}),
        } };
      }
      const size = request.candidate_mode === true ? JSON.stringify(projection).length : body.length;
      if (budget.reserve(1, size, required({ item }), "Required Memory or Context reference exceeds Context budget")) selected.push(projection);
    }
    return this.store.transaction(() => {
      recheck();
      return { member: this.member, items: selected, receipt_id: `memory_contribution_${stableDigest(selected).slice(-24)}`, omitted_count: matchingCount - selected.length, read_refs: guard.refs(),
        diagnostics: { eligible_memory_count: records.length, after_scope_precedence_count: scoped.length, after_temporal_policy_count: candidates.length, temporal_excluded: temporal.excluded,
          retrieval_index_cache_hit: cached !== null, retrieval_index_candidate_count: available.length, retrieval_body_load_count: bodyLoadCount } };
    });
  }

  private records(request: ContextRequest, readable: (item: JsonObject) => boolean, scopes: readonly { kind: string; id: string }[]): JsonObject[] {
    if (request.history_view !== true && request.as_of === undefined && request.known_at === undefined) {
      const candidates = this.store.listScoped("memory_ledger", scopes, 10_001, readable, undefined, { hydrateContent: false });
      if (candidates.length > 10_000) throw new Error("Memory candidate budget exceeded; narrow scope or source selection");
      return candidates;
    }
    const knownAt = request.known_at ?? request.as_of;
    if (knownAt !== undefined && !Number.isFinite(Date.parse(knownAt))) throw new Error("known_at must be an ISO timestamp");
    const candidates = this.store.listScoped("memory_ledger", scopes, 10_001, readable, { known_at: knownAt, history: request.history_view === true }, { hydrateContent: false });
    if (candidates.length > 10_000) throw new Error("Memory history budget exceeded; narrow the ledger before historical retrieval");
    return candidates;
  }

  private content(memory: JsonObject): string {
    if (typeof memory.content === "string") return memory.content;
    if (!contentReference(memory.content_ref)) throw new Error("Memory content reference is missing");
    return this.store.contentStore.readCompatSync(memory.content_ref).body;
  }

  private getSearchIndex(snapshot: string): CachedMemoryIndex | null {
    const now = Date.now();
    for (const [key, value] of this.#searchIndexes) if (value.expires_at <= now) this.#searchIndexes.delete(key);
    const cached = this.#searchIndexes.get(snapshot);
    if (!cached) return null;
    this.#searchIndexes.delete(snapshot);
    this.#searchIndexes.set(snapshot, cached);
    return cached;
  }

  private cacheSearchIndex(snapshot: string, index: Bm25Index): void {
    this.#searchIndexes.delete(snapshot);
    this.#searchIndexes.set(snapshot, { index, expires_at: Date.now() + MEMORY_INDEX_CACHE_TTL_MS });
    while (this.#searchIndexes.size > MEMORY_INDEX_CACHE_MAX_ENTRIES) this.#searchIndexes.delete(this.#searchIndexes.keys().next().value!);
  }
}
