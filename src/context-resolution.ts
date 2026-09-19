/**
 * The context plane: retrieving accumulated material into a bounded, reproducible pack.
 *
 * This is the **read** side of every accumulating member, and it is the reason the members are
 * worth having. `resolve` takes a query and a scope, selects active memory entries whose Source
 * is active and trusted, ranks them by whether they were explicitly required and then by
 * keyword overlap, fits them into an item and character budget, and writes a
 * `ContextResolutionReceipt` that carries `query_digest` rather than the query.
 *
 * Three properties make the receipt trustworthy rather than decorative:
 *
 *  - **Content-free about the query.** Craft does not hold the conversation, so it stores a
 *    digest of the query and the refs it selected, never the text.
 *  - **Reproducible.** The identity digest covers the scope, adapter and version, the selected
 *    refs and the budget, so replaying the same resolution returns the same receipt
 *    (`idempotent: true`) and a changed one is a conflict rather than a silent second receipt.
 *  - **Fail-closed on a required item.** A memory asked for by id that is unavailable, or that
 *    does not fit the budget, raises instead of being quietly omitted. `omitted_count` records
 *    how many were dropped by the budget, so a caller can tell "nothing matched" from "the
 *    budget was too small".
 *
 * It belongs to the **core** and not to a capability, for a reason the projection already
 * encodes: `component-knowledge`, `component-memory` and `component-context` all expose
 * `craft_context_resolution_*` and `craft_retrieval_adapter_*`. A Host that loads only one
 * concern still has to be able to resolve what that concern holds, so the read side cannot
 * belong to either member's package.
 */
import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { noCredentialAssignment, object, optionalScope, sortedUniqueList, text } from "./validation.ts";
import { canonicalJson, stableDigest, payload } from "./digest.ts";
import { contentReference } from "./infrastructure/content-store.ts";
import type { ContextContribution, ContextContributionProvider, ContextRequest } from "./capability-protocol.ts";

const STRATEGIES = new Set(["keyword", "vector"]);
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token)/iu;

/**
 * Refuse credentials anywhere inside a retrieval adapter's configuration.
 *
 * A separate function from `noCredentialAssignment` on purpose: this one walks a structure and
 * rejects a **key** that names a credential, which catches `{api_key: "..."}` where the value
 * alone looks innocent. Merging the two would lose one of the two checks.
 */
function noSecretValue(value: unknown, name: string): void {
  if (typeof value === "string") { noCredentialAssignment(value, name); return; }
  if (Array.isArray(value)) { value.forEach((item) => noSecretValue(item, name)); return; }
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value as JsonObject)) {
    if (SECRET_KEY.test(key)) throw new Error(`${name} must not contain credentials or secrets`);
    noSecretValue(child, name);
  }
}

export class ContextResolutionKernel {
  readonly store: CraftStore;
  /**
   * The capabilities' read sides, in capability order.
   *
   * Passed in rather than imported, because which contributions exist is decided by assembly and
   * this module must not name a package. Empty is the normal case: only experience declares one, and
   * a core assembled without a capability set resolves exactly as it did before contributions
   * existed.
   */
  readonly contributors: readonly ContextContributionProvider[];
  constructor(store: CraftStore, contributors: readonly ContextContributionProvider[] = []) {
    this.store = store;
    this.contributors = contributors;
  }

  retrievalConfigure(args: JsonObject): JsonObject {
    const strategy = text(args.strategy, "strategy"); if (!STRATEGIES.has(strategy)) throw new Error("Retrieval strategy is unsupported");
    const config = object(args.configuration ?? {}, "configuration"); noSecretValue(config, "configuration"); const adapterId = String(args.adapter_id ?? `retrieval_adapter_${randomUUID().replaceAll("-", "")}`);
    const identity = { strategy, provider_fingerprint: args.provider_fingerprint === undefined ? null : text(args.provider_fingerprint, "provider_fingerprint"), configuration_digest: stableDigest(config) };
    if (strategy === "vector" && identity.provider_fingerprint === null) throw new Error("Vector Retrieval Adapter requires provider_fingerprint");
    const existing = this.store.find("retrieval_adapter", adapterId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Retrieval Adapter idempotency conflict"); return { adapter: existing, idempotent: true }; }
    return { adapter: this.store.create("retrieval_adapter", adapterId, { ...identity, identity_digest: identityDigest, status: strategy === "keyword" ? "eligible" : "configured" }), idempotent: false };
  }

  /**
   * Evaluate an adapter, and let only a passing evaluation make a vector adapter selectable.
   *
   * A keyword adapter is eligible on configuration alone, because it has nothing to measure. A
   * vector adapter must clear recall, **zero** cross-project leakage, latency and cost — the
   * leakage term is an equality rather than a threshold because one leaked cross-project record
   * is not a quality tradeoff.
   */
  retrievalEvaluate(args: JsonObject): JsonObject {
    const adapter = this.store.get("retrieval_adapter", text(args.adapter_id, "adapter_id")); const metrics = object(args.metrics, "metrics");
    const recall = Number(metrics.recall); const leakage = Number(metrics.cross_project_leak_count); const latency = Number(metrics.latency_ms); const cost = Number(metrics.cost_usd);
    if (![recall, leakage, latency, cost].every(Number.isFinite) || recall < 0 || recall > 1 || leakage < 0 || latency < 0 || cost < 0) throw new Error("Retrieval evaluation metrics are invalid");
    const minimumRecall = Number(args.minimum_recall ?? 0.8); const maxLatency = Number(args.max_latency_ms ?? Number.MAX_SAFE_INTEGER); const maxCost = Number(args.max_cost_usd ?? Number.MAX_SAFE_INTEGER);
    if (![minimumRecall, maxLatency, maxCost].every(Number.isFinite) || minimumRecall < 0 || minimumRecall > 1 || maxLatency < 0 || maxCost < 0) throw new Error("Retrieval evaluation thresholds are invalid");
    const eligible = adapter.strategy === "keyword" || recall >= minimumRecall && leakage === 0 && latency <= maxLatency && cost <= maxCost;
    const evaluationId = String(args.evaluation_id ?? `retrieval_evaluation_${randomUUID().replaceAll("-", "")}`); const identity = { adapter_id: adapter.id, adapter_version: adapter.version, metrics, minimum_recall: minimumRecall, max_latency_ms: maxLatency, max_cost_usd: maxCost };
    const existing = this.store.find("retrieval_evaluation", evaluationId); const identityDigest = stableDigest(identity);
    if (existing) {
      const replayIdentity = { ...identity, adapter_version: existing.adapter_version };
      if (existing.identity_digest !== stableDigest(replayIdentity)) throw new Error("Retrieval evaluation idempotency conflict");
      return { evaluation: existing, adapter, idempotent: true };
    }
    const evaluation = this.store.create("retrieval_evaluation", evaluationId, { ...identity, identity_digest: identityDigest, verdict: eligible ? "eligible" : "rejected" });
    const saved = this.store.save("retrieval_adapter", String(adapter.id), { ...payload(adapter), status: eligible ? "eligible" : "rejected", latest_evaluation_id: evaluation.id });
    return { evaluation, adapter: saved, idempotent: false };
  }

  async resolve(args: JsonObject): Promise<JsonObject> {
    const query = noCredentialAssignment(text(args.query, "query"), "query"); const requestedScope = optionalScope(args);
    // Without a scope this returns nothing and says why. It does not search every scope, and it
    // writes no receipt for a resolution that did not happen.
    if (requestedScope === null) return { query, scope: null, items: [], contributions: [], receipt: null, skipped: true, reason: "scope_unavailable" };
    const now = new Date(args.now === undefined ? Date.now() : text(args.now, "now")); if (Number.isNaN(now.valueOf())) throw new Error("now must be an ISO timestamp");
    const maxItems = Number(args.max_items ?? 12); const maxChars = Number(args.max_chars ?? 12_000); if (!Number.isInteger(maxItems) || maxItems < 1 || !Number.isInteger(maxChars) || maxChars < 1) throw new Error("Context budget is invalid");
    const sourceIds = sortedUniqueList(args.source_ids, "source_ids"); const requestedIds = sortedUniqueList(args.memory_ids, "memory_ids"); const allowRestricted = args.allow_restricted === true; const adapter = args.retrieval_adapter_id === undefined ? null : this.store.get("retrieval_adapter", text(args.retrieval_adapter_id, "retrieval_adapter_id"));
    const retrievalMode = adapter?.status === "eligible" ? adapter.strategy : "keyword";
    const queryTerms = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []; const selectedSourceIds = sourceIds.length ? new Set(sourceIds) : null;
    const sources = new Map(this.store.list("knowledge_source", 10_000).map((source) => [String(source.id), source]));
    for (const sourceId of sourceIds) {
      const source = sources.get(sourceId);
      if (!source || source.status !== "active" || source.trust === "untrusted") throw new Error("Requested Knowledge Source is unavailable in this Context");
    }
    const candidates = this.store.list("memory_ledger", 10_000, (item) => {
      const source = sources.get(String(item.source_id));
      return item.status === "active" && source?.status === "active" && source.trust !== "untrusted" && canonicalJson(item.scope) === canonicalJson(requestedScope)
        && (item.valid_until === null || Date.parse(String(item.valid_until)) >= now.valueOf()) && (allowRestricted || item.sensitivity !== "restricted")
        && (selectedSourceIds === null || selectedSourceIds.has(String(item.source_id)));
    })
      .map((item) => { const body = this.content(item); return { memory: item, body, required: requestedIds.includes(String(item.id)), score: queryTerms.reduce((sum, term) => sum + Number(body.toLowerCase().includes(term)), 0) }; })
      .filter((item) => item.required || item.score > 0).sort((left, right) => Number(right.required) - Number(left.required) || right.score - left.score || String(left.memory.id).localeCompare(String(right.memory.id)));
    for (const memoryId of requestedIds) if (!candidates.some((item) => item.memory.id === memoryId)) throw new Error("Required Memory is unavailable in this Context");
    const items: JsonObject[] = []; let usedChars = 0;
    for (const candidate of candidates) { const size = candidate.body.length; if (items.length >= maxItems) break; if (usedChars + size > maxChars) { if (candidate.required) throw new Error("Required Memory exceeds Context budget"); continue; } usedChars += size; items.push({ memory_id: candidate.memory.id, memory_version: candidate.memory.version, source_id: candidate.memory.source_id, content: candidate.body, content_digest: candidate.memory.content_digest, sensitivity: candidate.memory.sensitivity, reason: candidate.required ? "required" : retrievalMode === "vector" ? "evaluated_vector_adapter" : "keyword_overlap" }); }
    // The capabilities' read sides, asked after the memory selection so their budgets are separate
    // from the memory budget: a contributor that filled the memory budget would be deciding how
    // much memory a turn gets, which is not its call.
    const contributions: ContextContribution[] = [];
    for (const contributor of this.contributors) {
      contributions.push(await contributor.contribute({
        query, scope_kind: requestedScope.kind as ContextRequest["scope_kind"], scope_id: requestedScope.id,
        max_items: maxItems, max_chars: maxChars,
      }));
    }
    const receiptId = String(args.receipt_id ?? `context_resolution_${randomUUID().replaceAll("-", "")}`); const identity = { query_digest: stableDigest(query), scope: requestedScope, retrieval_adapter_id: adapter?.id ?? null, retrieval_adapter_version: adapter?.version ?? null, retrieval_mode: retrievalMode, allow_restricted: allowRestricted, memory_refs: items.map((item) => ({ memory_id: item.memory_id, memory_version: item.memory_version, content_digest: item.content_digest, reason: item.reason })), max_items: maxItems, max_chars: maxChars, used_chars: usedChars,
      // What the contributions selected is part of the receipt's identity, so replaying the same
      // resolution against changed compiled experience is a conflict rather than a silent second
      // receipt describing a different pack.
      contributions: contributions.map((contribution) => ({ member: contribution.member, receipt_id: contribution.receipt_id, item_count: contribution.items.length, omitted_count: contribution.omitted_count })) };
    const existing = this.store.find("context_resolution_receipt", receiptId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Context Resolution Receipt idempotency conflict"); return { receipt: existing, items, contributions, idempotent: true }; }
    return { receipt: this.store.create("context_resolution_receipt", receiptId, { ...identity, identity_digest: identityDigest, omitted_count: candidates.length - items.length, content_free: true }), items, contributions, idempotent: false };
  }

  receiptGet(args: JsonObject): JsonObject { return { receipt: this.store.get("context_resolution_receipt", text(args.receipt_id, "receipt_id"), args.version === undefined ? undefined : Number(args.version)) }; }

  /**
   * One entry's body, from wherever it lives.
   *
   * A record written before the content store existed still carries `content` inline; otherwise
   * the body is read back through its reference, so a moved or edited file cannot be mistaken
   * for the memory the receipt names.
   */
  private content(memory: JsonObject): string {
    if (typeof memory.content === "string") return memory.content;
    const ref = memory.content_ref;
    if (!contentReference(ref)) throw new Error("Memory content reference is missing");
    return this.store.contentStore.readCompatSync(ref).body;
  }
}
