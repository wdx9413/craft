import { observeOperation } from "../common/craft-common-log/src/index.ts";
import { ContextBudget } from "../common/craft-common-base/src/context-assets.ts";
import { MemoryContribution } from "../capability/craft-memory/contribution.ts";
import { ContextReadGuard } from "./context-access-guard.ts";
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
 * The core owns shared retrieval and pack selection. Each capability owns candidate
 * eligibility, temporal/access rules and its content projection through contribution.
 */
import { runRetrievalEvaluation } from "./retrieval-evaluation.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { noCredentialAssignment, object, optionalScope, sortedUniqueList, text } from "./validation.ts";
import { stableDigest, payload } from "./digest.ts";
import { CONTEXT_MEMBERS, type ContextContribution, type ContextContributionProvider, type ContextMember, type ContextRequest } from "./capability-protocol.ts";
import { ScopeIdentityKernel } from "./scope-identity.ts";
import { KeywordRetrievalPort, OpenAiCompatibleEmbeddingRetrievalPort } from "./retrieval-port.ts";
import { scopeAccess, sourceAllows } from "./scope-policy.ts";
import { contextAssetMatches, contextAssetRef, requiredContextRef } from "../common/craft-common-base/src/context-assets.ts";

const STRATEGIES = new Set(["keyword", "vector", "hybrid"]);
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
  /** Registered contributions; an explicit Memory provider replaces the legacy default adapter. */
  readonly contributors: readonly ContextContributionProvider[];
  readonly scopes: ScopeIdentityKernel;
  constructor(store: CraftStore, contributors: readonly ContextContributionProvider[] = []) {
    this.store = store;
    this.contributors = contributors.some(provider => provider.member === "memory") ? contributors : [new MemoryContribution(store), ...contributors];
    this.scopes = new ScopeIdentityKernel(store);
  }

  async searchKnowledge(args: JsonObject): Promise<JsonObject> {
    const legacy = typeof args.scope === "string" ? args.scope.split(":") : [];
    const scope = optionalScope(legacy.length > 1 ? { ...args, scope_kind: legacy[0], scope_id: legacy.slice(1).join(":") } : args);
    if (!scope) return { hits: [], skipped: true, reason: "scope_unavailable" };
    const query = noCredentialAssignment(text(args.query, "query"), "query");
    const limit = Number(args.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Knowledge search limit must be between 1 and 100");
    const scopes = this.scopes.resolveStack(scope, args);
    const provider = this.contributors.find((item) => item.member === "knowledge");
    if (!provider?.search) return { hits: [], skipped: true, reason: "knowledge_unavailable" };
    const access = scopeAccess(args);
    const guard = new ContextReadGuard(this.store, undefined, scopes.attempted_scopes, sortedUniqueList(args.source_ids, "source_ids"));
    for (const alias of scopes.matched_aliases) guard.track("scope_alias", String(alias.id), Number(alias.version));
    const result = await provider.search({ query, scope_kind: scopes.canonical_scope.kind as ContextRequest["scope_kind"], scope_id: scopes.canonical_scope.id,
      scope_stack: scopes.attempted_scopes, max_items: limit, max_chars: 12_000, ...access, cognitive_purpose: access.purpose }, args.include_candidates === true);
    for (const item of result.items) guard.contribution("knowledge", item);
    guard.assertCurrent();
    return { hits: result.items, scope: scopes.canonical_scope, include_candidates: args.include_candidates === true,
      omitted_count: result.omitted_count, receipt_id: result.receipt_id, execution_context: false };
  }

  retrievalConfigure(args: JsonObject): JsonObject {
    const strategy = text(args.strategy, "strategy"); if (!STRATEGIES.has(strategy)) throw new Error("Retrieval strategy is unsupported");
    const config = object(args.configuration ?? {}, "configuration"); noSecretValue(config, "configuration"); const adapterId = String(args.adapter_id ?? `retrieval_adapter_${randomUUID().replaceAll("-", "")}`);
    // Configuration contains only a provider endpoint, model and credential *reference*.
    // Persisting it is required for a later Context resolution to actually construct the
    // adapter; the validation above keeps secret material out of the local fact store.
    const identity = { strategy, provider_fingerprint: args.provider_fingerprint === undefined ? null : text(args.provider_fingerprint, "provider_fingerprint"), configuration: config, configuration_digest: stableDigest(config) };
    if ((strategy === "vector" || strategy === "hybrid") && identity.provider_fingerprint === null) throw new Error("Vector Retrieval Adapter requires provider_fingerprint");
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
  async retrievalRun(args: JsonObject): Promise<JsonObject> {
    const adapter = this.store.get("retrieval_adapter", text(args.adapter_id, "adapter_id"));
    const report = await runRetrievalEvaluation(adapter, args.dataset);
    const current = this.store.get("retrieval_adapter", String(adapter.id));
    if (current.version !== adapter.version) throw new Error("Retrieval adapter changed during evaluation");
    const run = this.store.create("retrieval_evaluation_run", `retrieval_run_${randomUUID()}`, report);
    return this.retrievalEvaluate({ ...args, metrics: report.metrics, run_id: run.id });
  }

  retrievalEvaluate(args: JsonObject): JsonObject {
    const adapter = this.store.get("retrieval_adapter", text(args.adapter_id, "adapter_id")); const metrics = object(args.metrics, "metrics");
    const recall = Number(metrics.recall); const leakage = Number(metrics.cross_project_leak_count); const latency = Number(metrics.latency_ms); const cost = metrics.cost_usd === null ? 0 : Number(metrics.cost_usd);
    const negativeCases = metrics.negative_case_count === undefined ? 0 : Number(metrics.negative_case_count);
    const falsePositives = metrics.false_positive_count === undefined ? 0 : Number(metrics.false_positive_count);
    const noAnswerFalsePositives = metrics.no_answer_false_positive_count === undefined ? null : Number(metrics.no_answer_false_positive_count);
    if (![recall, leakage, latency, cost].every(Number.isFinite) || recall < 0 || recall > 1 || leakage < 0 || latency < 0 || cost < 0
      || !Number.isSafeInteger(negativeCases) || negativeCases < 0 || !Number.isSafeInteger(falsePositives) || falsePositives < 0
      || noAnswerFalsePositives !== null && (!Number.isSafeInteger(noAnswerFalsePositives) || noAnswerFalsePositives < 0 || noAnswerFalsePositives > falsePositives)) throw new Error("Retrieval evaluation metrics are invalid");
    const minimumRecall = Number(args.minimum_recall ?? 0.8); const maxLatency = Number(args.max_latency_ms ?? Number.MAX_SAFE_INTEGER); const maxCost = Number(args.max_cost_usd ?? Number.MAX_SAFE_INTEGER);
    if (![minimumRecall, maxLatency, maxCost].every(Number.isFinite) || minimumRecall < 0 || minimumRecall > 1 || maxLatency < 0 || maxCost < 0) throw new Error("Retrieval evaluation thresholds are invalid");
    const run = args.run_id === undefined ? null : this.store.get("retrieval_evaluation_run", text(args.run_id, "run_id"));
    const verified = run?.provenance === "runtime_executed" && run.adapter_identity_digest === adapter.identity_digest && stableDigest(run.metrics) === stableDigest(metrics) && run.execution_complete === true;
    const eligible = adapter.strategy === "keyword" || verified && recall >= minimumRecall && leakage === 0 && latency <= maxLatency
      && (negativeCases === 0 || noAnswerFalsePositives === 0)
      && (args.max_cost_usd === undefined || metrics.cost_usd !== null && cost <= maxCost);
    const evaluationId = String(args.evaluation_id ?? `retrieval_evaluation_${randomUUID().replaceAll("-", "")}`); const identity = { run_id: run?.id ?? null, provenance: verified ? "runtime_executed" : "caller_reported", adapter_id: adapter.id, adapter_version: adapter.version, metrics, minimum_recall: minimumRecall, max_latency_ms: maxLatency, max_cost_usd: maxCost };
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
    return observeOperation(this.store, "context", "resolve", args, () => this.resolveContext(args));
  }

  private async resolveContext(args: JsonObject): Promise<JsonObject> {
    const query = noCredentialAssignment(text(args.query, "query"), "query"); const requestedScope = optionalScope(args);
    // Without a scope this returns nothing and says why. It does not search every scope, and it
    // writes no receipt for a resolution that did not happen.
    if (requestedScope === null) return { query, scope: null, items: [], contributions: [], receipt: null, skipped: true, reason: "scope_unavailable" };
    const now = new Date(args.now === undefined ? Date.now() : text(args.now, "now")); if (Number.isNaN(now.valueOf())) throw new Error("now must be an ISO timestamp");
    const scopeResolution = this.scopes.resolveStack(requestedScope, args);
    const access = scopeAccess(args);
    const maxItems = Number(args.max_items ?? 12); const maxChars = Number(args.max_chars ?? 12_000); const budget = new ContextBudget(maxItems, maxChars);
    const sourceIds = sortedUniqueList(args.source_ids, "source_ids"); const requestedIds = sortedUniqueList(args.memory_ids, "memory_ids"); const allowRestricted = args.allow_restricted === true; const adapter = args.retrieval_adapter_id === undefined ? null : this.store.get("retrieval_adapter", text(args.retrieval_adapter_id, "retrieval_adapter_id"));
    const guard = new ContextReadGuard(this.store, undefined, scopeResolution.attempted_scopes, sourceIds);
    for (const alias of scopeResolution.matched_aliases) guard.track("scope_alias", String(alias.id), Number(alias.version));
    if (args.required_refs !== undefined && !Array.isArray(args.required_refs)) throw new Error("required_refs must be an array");
    const requiredRefs = ((args.required_refs ?? []) as unknown[]).map(requiredContextRef);
    const members = this.members(args.members);
    const includeMemory = members === null || members.has("memory");
    const health = adapter ? this.retrievalHealth(adapter, now) : null;
    const circuitOpen = health?.status === "open" && Date.parse(String(health.open_until)) > now.valueOf();
    const requestedStrategy = adapter?.status === "eligible" && !circuitOpen ? adapter.strategy : "keyword";
    for (const sourceId of sourceIds) {
      guard.track("knowledge_source", sourceId);
      const source = this.store.find("knowledge_source", sourceId);
      if (!source || source.status !== "active" || source.trust === "untrusted" || !sourceAllows(source, access)) throw new Error("Requested Knowledge Source is unavailable in this Context");
    }
    const historical = args.history_view === true || args.as_of !== undefined || args.known_at !== undefined;
    if (args.as_of !== undefined && !Number.isFinite(Date.parse(text(args.as_of, "as_of")))) throw new Error("as_of must be an ISO timestamp");
    const recheck = () => guard.assertCurrent();
    const port = (requestedStrategy === "vector" || requestedStrategy === "hybrid") && adapter ? new OpenAiCompatibleEmbeddingRetrievalPort((adapter.configuration ?? {}) as JsonObject, join(this.store.paths.root, "retrieval-embeddings.sqlite"), recheck) : new KeywordRetrievalPort();
    // All members enumerate only authorized candidates; a single corpus controls ranking.
    const recalled: ContextContribution[] = [];
    let memoryPart: ContextContribution | undefined;
    const contributorFailures: JsonObject[] = [];
    for (const contributor of this.contributors) {
      if (members !== null && !members.has(contributor.member)) continue;
      let contribution: ContextContribution;
      try { contribution = await contributor.contribute({ query,
        scope_kind: scopeResolution.canonical_scope.kind as ContextRequest["scope_kind"], scope_id: scopeResolution.canonical_scope.id,
        max_items: 10_000, max_chars: 8_000_000, candidate_mode: true,
        now: now.toISOString(), source_ids: sourceIds, scope_stack: scopeResolution.attempted_scopes, ...access, cognitive_purpose: access.purpose,
        memory_ids: requestedIds, required_refs: requiredRefs, allow_restricted: allowRestricted, include_working_notes: args.include_working_notes === true, history_view: args.history_view === true, as_of: args.as_of as string | undefined, known_at: args.known_at as string | undefined });
        if (contribution.member !== contributor.member || !Number.isSafeInteger(contribution.omitted_count) || contribution.omitted_count < 0) throw new Error("Context contributor returned invalid member or omission count");
        if (contribution.items.length > 10_000 || contribution.items.reduce((n, item) => n + JSON.stringify(item).length, 0) > 8_000_000)
          throw new Error("Context contributor exceeded the aggregate budget");
      }
      catch (error) {
        if (contributor.member === "memory" || args.allow_partial !== true) throw error;
        contributorFailures.push({ member: contributor.member, reason: "contribution_unavailable" });
        continue;
      }
      for (const ref of contribution.read_refs ?? []) guard.track(ref.kind, ref.id, ref.version);
      for (const item of contribution.items) guard.contribution(contribution.member, item);
      if (contributor.member === "memory") memoryPart = contribution;
      else recalled.push(contribution);
    }
    const available = (memoryPart?.items ?? []).map(item => ({ item, body: String(item.content), required: requestedIds.includes(String(item.memory_id)) || requiredRefs.some(ref => contextAssetMatches(ref, contextAssetRef("memory", item, item.scope as JsonObject))), key: historical ? `${item.memory_id}@${item.memory_version}` : String(item.memory_id) }));
    const memoryDiagnostics = memoryPart?.diagnostics ?? { eligible_memory_count: available.length, after_scope_precedence_count: available.length, after_temporal_policy_count: available.length, temporal_excluded: [] };
    const extra = recalled.flatMap((part, group) => part.items.map((item, index) => ({
      id: `contribution:${group}:${index}`, group, item,
      body: String(item.retrieval_text ?? item.content ?? item.trigger ?? ""),
      required: requiredRefs.some(ref => contextAssetMatches(ref, contextAssetRef(part.member, item, scopeResolution.canonical_scope as unknown as JsonObject))),
    })));
    const documents = [...available.map(item => ({ id: item.key, body: item.body })), ...extra];
    recheck(); // Recheck after contributors and before any corpus can leave the process.
    let retrieval = await port.search(query, documents);
    recheck(); // A failed provider must never turn revocation into a keyword fallback.
    if (circuitOpen && adapter && adapter.strategy !== "keyword") {
      retrieval = { ...retrieval, execution: { ...retrieval.execution, requested: String(adapter.strategy), provider: "openai-compatible", model: typeof (adapter.configuration as JsonObject | undefined)?.model === "string" ? String((adapter.configuration as JsonObject).model) : null, unavailable_reason: "embedding_circuit_open" } };
    }
    if (adapter && adapter.status !== "eligible" && adapter.strategy !== "keyword") retrieval.execution = {
      ...retrieval.execution, requested: String(adapter.strategy), unavailable_reason: "retrieval_evaluation_required" };
    const providerExecution = retrieval.execution;
    if (adapter && (requestedStrategy === "vector" || requestedStrategy === "hybrid")) this.recordRetrievalHealth(adapter, providerExecution, now);
    // A configured-but-unavailable embedding provider must not turn an otherwise valid
    // Context request into an empty result.  The receipt still says the requested vector
    // retrieval was unavailable, while its actual hits come from the verified local path.
    if ((requestedStrategy === "vector" || requestedStrategy === "hybrid") && retrieval.execution.used === "keyword") {
      const fallback = await new KeywordRetrievalPort().search(query, documents);
      retrieval = { hits: fallback.hits, execution: { ...fallback.execution, requested: requestedStrategy, provider: retrieval.execution.provider, model: retrieval.execution.model, unavailable_reason: retrieval.execution.unavailable_reason } };
    } else if (requestedStrategy === "hybrid") {
      const keyword = await new KeywordRetrievalPort().search(query, documents);
      retrieval = { hits: reciprocalRankFuse(retrieval.hits, keyword.hits), execution: { ...retrieval.execution, requested: "hybrid", used: "hybrid" } };
    }
    recheck();
    const hitScores = new Map(retrieval.hits.map((hit) => [hit.id, hit]));
    const candidatesRanked = available.map((item) => ({ ...item, hit: hitScores.get(item.key) ?? null, score: hitScores.get(item.key)?.score ?? 0 }))
      .filter((item) => item.required || item.score > 0).sort((left, right) => Number(right.required) - Number(left.required) || right.score - left.score || String(left.item.memory_id).localeCompare(String(right.item.memory_id)));
    if (!includeMemory && requestedIds.length) throw new Error("Requested Memory is excluded by Context members");
    for (const memoryId of requestedIds) if (!candidatesRanked.some((item) => item.item.memory_id === memoryId)) throw new Error("Required Memory is unavailable in this Context");
    const items: JsonObject[] = []; let usedChars = 0;
    const selectedExtras = new Set<string>(); let contributionChars = 0;
    const pool = [
      ...candidatesRanked.map(candidate => ({ id: candidate.key, required: candidate.required, score: candidate.score, weight: Number(candidate.item.ranking_weight ?? 1), size: candidate.body.length, memory: candidate, extra: null })),
      ...extra.filter(candidate => hitScores.has(candidate.id) || candidate.required).map(candidate => ({ id: candidate.id, required: candidate.required, score: hitScores.get(candidate.id)?.score ?? 0, weight: 1,
        size: JSON.stringify(candidate.item).length, memory: null, extra: candidate })),
    ].sort((a, b) => Number(b.required) - Number(a.required) || b.score - a.score || b.weight - a.weight || a.id.localeCompare(b.id));
    for (const required of requiredRefs) {
      const present = pool.some(candidate => contextAssetMatches(required, candidate.memory
        ? contextAssetRef("memory", candidate.memory.item, candidate.memory.item.scope as JsonObject)
        : contextAssetRef(recalled[candidate.extra!.group]!.member, candidate.extra!.item, scopeResolution.canonical_scope as unknown as JsonObject)));
      if (!present) throw new Error("Required Context reference is unavailable");
    }
    const selectedContent = new Map<string, JsonObject>(); let duplicates = 0;
    const duplicateRefs: JsonObject[] = [];
    for (const candidate of pool) {
      // Retrieval text may be lowercased or enriched with tags; it is not the fact's content.
      const contentKey = candidate.memory ? stableDigest(candidate.memory.body) : candidate.extra!.item.procedure_id ? stableDigest(candidate.extra!.item) : stableDigest(candidate.extra!.item.content ?? candidate.extra!.body);
      const reference = candidate.memory ? { member: "memory", id: candidate.memory.item.memory_id, version: candidate.memory.item.memory_version, source_id: candidate.memory.item.source_id }
        : { member: recalled[candidate.extra!.group]!.member, id: candidate.extra!.item.claim_id ?? candidate.extra!.item.procedure_id, version: candidate.extra!.item.claim_version ?? candidate.extra!.item.procedure_version, source_id: candidate.extra!.item.source_id ?? null };
      if (args.deduplicate === true && !historical && !candidate.required && selectedContent.has(contentKey)) {
        duplicates++;
        if (duplicateRefs.length < 100) duplicateRefs.push({ omitted: reference, retained: selectedContent.get(contentKey)!, content_digest: contentKey });
        continue;
      }
      if (!budget.reserve(1, candidate.size, candidate.required, "Required Memory or Context reference exceeds Context budget")) continue;
      if (candidate.memory) {
        const value = candidate.memory;
        usedChars += candidate.size;
        const { confirmed_at: _confirmedAt, ...projection } = value.item;
        items.push({ ...projection, ranking_weight: candidate.weight, reason: value.required ? "required" : value.hit?.reason ?? "not_selected", score: candidate.score });
      } else {
        selectedExtras.add(candidate.id); contributionChars += candidate.size;
      }
      selectedContent.set(contentKey, reference);
    }
    const contributionItems = selectedExtras.size;
    const contributions = recalled.map((part, group) => {
      const selected = extra.filter(candidate => candidate.group === group && selectedExtras.has(candidate.id)).map(candidate => candidate.item);
      const matches = extra.filter(candidate => candidate.group === group && (hitScores.has(candidate.id) || candidate.required)).length;
      const diagnostics = part.member === "experience" ? { ...part.diagnostics, matching_count: matches, selected_count: selected.length,
        reason: selected.length ? "recalled_not_bound" : matches ? "budget_excluded" : part.items.length ? "query_not_matched" : part.diagnostics?.reason,
        execution_started: false } : part.diagnostics;
      return { ...part, diagnostics, items: selected, receipt_id: `contribution_${stableDigest(selected).slice(-24)}`,
        omitted_count: part.omitted_count + extra.filter(candidate => candidate.group === group && (hitScores.has(candidate.id) || candidate.required)).length - selected.length };
    });
    const executionIdentity = { requested: retrieval.execution.requested, used: retrieval.execution.used, provider: retrieval.execution.provider, model: retrieval.execution.model, unavailable_reason: retrieval.execution.unavailable_reason };
    const selectedGuard = new ContextReadGuard(this.store, guard.refs());
    for (const alias of scopeResolution.matched_aliases) selectedGuard.track("scope_alias", String(alias.id));
    for (const sourceId of sourceIds) selectedGuard.track("knowledge_source", sourceId);
    for (const item of items) selectedGuard.contribution("memory", item);
    for (const contribution of contributions) for (const item of contribution.items) selectedGuard.contribution(contribution.member, item);
    const identity = { read_refs: selectedGuard.refs(), history_view: args.history_view === true, as_of: args.as_of ?? null, known_at: args.known_at ?? null, execution_context: !historical, query_digest: stableDigest(query), scope: requestedScope, canonical_scope: scopeResolution.canonical_scope, attempted_scopes: scopeResolution.attempted_scopes, scope_access: { principal_present: Boolean(access.principal_id || access.principal_ids?.length), tenant_present: Boolean(access.tenant_id), purpose: access.purpose ?? null }, retrieval_adapter_id: adapter?.id ?? null, retrieval_adapter_version: adapter?.version ?? null, retrieval_mode: retrieval.execution.used, retrieval_execution: executionIdentity, allow_restricted: allowRestricted, memory_refs: items.map((item) => ({ memory_id: item.memory_id, memory_version: item.memory_version, content_digest: item.content_digest, reason: item.reason, score: item.score, confirmed_at: available.find(candidate => candidate.item.memory_id === item.memory_id && candidate.item.memory_version === item.memory_version)!.item.confirmed_at ?? null })), max_items: maxItems, max_chars: maxChars, used_chars: usedChars,
      // What the contributions selected is part of the receipt's identity, so replaying the same
      // resolution against changed compiled experience is a conflict rather than a silent second
      // receipt describing a different pack.
      total_used_chars: usedChars + contributionChars, total_items: items.length + contributionItems,
      deduplicated_count: duplicates, deduplicated_refs: duplicateRefs, deduplicated_refs_omitted_count: duplicates - duplicateRefs.length,
      contributor_failures: contributorFailures, partial: contributorFailures.length > 0,
      members: members === null ? null : [...members].sort(),
      contributions: contributions.map((contribution) => ({ member: contribution.member, receipt_id: contribution.receipt_id, item_count: contribution.items.length, omitted_count: contribution.omitted_count, diagnostics: contribution.diagnostics,
        references: contribution.items.map(item => ({ id: item.claim_id ?? item.procedure_id, version: item.claim_version ?? item.procedure_version,
          digest: item.content_digest, source_id: item.source_id ?? null, reason: item.reason ?? "routeable_scope_match" })) })) };
    const identityDigest = stableDigest(identity);
    const receiptId = String(args.receipt_id ?? `context_resolution_${stableDigest({ identityDigest, access, task_id: args.task_id ?? null, session_id: args.session_id ?? null, turn_id: args.turn_id ?? null }).slice(-32)}`);
    return this.store.transaction(() => {
      recheck();
      const existing = this.store.find("context_resolution_receipt", receiptId);
      if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Context Resolution Receipt idempotency conflict"); return { receipt: existing, items, contributions, idempotent: true }; }
      return { receipt: this.store.create("context_resolution_receipt", receiptId, { ...identity, retrieval_execution: retrieval.execution, scope_aliases: scopeResolution.matched_aliases.map((alias) => ({ id: alias.id, alias_kind: alias.alias_kind, alias_digest: alias.alias_digest })), excluded_scopes: [...scopeResolution.excluded_scopes, ...(memoryDiagnostics.temporal_excluded as JsonObject[])], identity_digest: identityDigest, omitted_count: candidatesRanked.length - items.length, explanation: { eligible_memory_count: memoryDiagnostics.eligible_memory_count, after_scope_precedence_count: memoryDiagnostics.after_scope_precedence_count, after_temporal_policy_count: memoryDiagnostics.after_temporal_policy_count, matching_memory_count: candidatesRanked.length, selected_memory_count: items.length, budget_omitted_count: candidatesRanked.length - items.length, selection: "policy_per_scope_then_scope_precedence_then_shared_bm25_or_hybrid_then_required_and_budget" }, content_free: true }), items, contributions, idempotent: false };
    });
  }

  feedback(args: JsonObject): JsonObject {
    const receiptId = text(args.receipt_id, "receipt_id");
    const receipt = this.store.find("context_pack_receipt", receiptId) ?? this.store.get("context_resolution_receipt", receiptId);
    const outcome = text(args.outcome, "outcome");
    if (!["helpful", "irrelevant", "incorrect", "stale"].includes(outcome)) throw new Error("Unsupported Context feedback outcome");
    const members = this.members(args.members);
    if (members && (!Array.isArray(receipt.members) || (receipt.members as string[]).some(member => !members.has(member as "knowledge" | "memory" | "experience")))) throw new Error("Feedback receipt belongs to another component");
    const evidenceIds = sortedUniqueList(args.evidence_ids, "evidence_ids"); evidenceIds.forEach(id => this.store.get("evidence", id));
    const evidenceVerified = evidenceIds.some(id => {
      const evidence = this.store.get("evidence", id), meta = evidence.metadata as JsonObject | undefined;
      return evidence.source_type === "program" && evidence.confidence === "confirmed" && meta?.context_receipt_id === receipt.id && meta?.verdict === "passed";
    });
    const availableRefs: JsonObject[] = Array.isArray(receipt.asset_refs) ? receipt.asset_refs as JsonObject[] : [
      ...(receipt.memory_refs as JsonObject[]).map(ref => ({ member: "memory", id: ref.memory_id, version: ref.memory_version, digest: ref.content_digest })),
      ...((receipt.contributions as JsonObject[] | undefined) ?? []).flatMap(part => (part.references as JsonObject[]).map(ref => ({ member: part.member, ...ref }))),
    ];
    const usageStage = args.usage_stage ?? "shown";
    if (!["selected", "shown", "used", "verified"].includes(String(usageStage))) throw new Error("Unsupported Context usage_stage");
    if (usageStage === "verified" && !evidenceVerified) throw new Error("Verified Context usage requires same-receipt program Evidence");
    if (args.asset_refs !== undefined && !Array.isArray(args.asset_refs)) throw new Error("asset_refs must be an array");
    const refs = args.asset_refs === undefined ? availableRefs : (args.asset_refs as JsonObject[]).map(ref => {
      const exact = availableRefs.find(candidate => contextAssetMatches(ref, candidate));
      if (!exact) throw new Error("Feedback reference was not selected by this receipt");
      return exact;
    });
    const tokenMeasurement = Object.fromEntries(["injected_tokens", "schema_tokens", "history_tokens"].filter(key => args[key] !== undefined).map(key => {
      const count = args[key]; if (!Number.isSafeInteger(count) || Number(count) < 0) throw new Error("Host token measurement must contain non-negative integers");
      return [key, count];
    }));
    const identity = { token_measurement: tokenMeasurement, token_provenance: "host_reported", asset_refs: refs, usage_stage: usageStage, evidence_verified: evidenceVerified, memory_refs: refs.filter(ref => ref.member === "memory").map(ref => ({ memory_id: ref.id, memory_version: ref.version, content_digest: ref.digest })), receipt_id: receipt.id, receipt_digest: receipt.identity_digest, scope: receipt.scope, outcome, evidence_ids: evidenceIds, provenance: "host_reported", changes_source_status: false };
    const id = String(args.feedback_id ?? `context_feedback_${stableDigest(identity).slice(-24)}`); const existing = this.store.find("context_feedback", id);
    if (existing) { if (existing.identity_digest !== stableDigest(identity)) throw new Error("Context feedback idempotency conflict"); return { feedback: existing, idempotent: true }; }
    return this.store.transaction(() => {
      const feedback = this.store.create("context_feedback", id, { ...identity, identity_digest: stableDigest(identity) });
      const corrections = ["incorrect", "stale"].includes(outcome) ? refs.filter(ref => !["history", "state"].includes(String(ref.member))).map(ref => this.store.create("context_correction_task", `${id}:${ref.member}:${ref.id}@${ref.version}`, { feedback_id: id, asset_ref: ref, outcome, status: "pending_review", changes_source_status: false })) : [];
      return { feedback, corrections, idempotent: false };
    });
  }

  receiptGet(args: JsonObject): JsonObject { return { receipt: this.store.get("context_resolution_receipt", text(args.receipt_id, "receipt_id"), args.version === undefined ? undefined : Number(args.version)) }; }

  private members(value: unknown): Set<ContextMember> | null {
    if (value === undefined) return null;
    if (!Array.isArray(value) || !value.length) throw new Error("members must be a non-empty Context member list");
    const selected = new Set<ContextMember>();
    for (const item of value) {
      const member = text(item, "members") as ContextMember;
      if (!CONTEXT_MEMBERS.includes(member)) throw new Error("members contains an unsupported Context member");
      if (member === "history" || member === "state") throw new Error("members may select only accumulated Context members");
      selected.add(member);
    }
    return selected;
  }

  private retrievalHealth(adapter: JsonObject, now: Date): JsonObject | null {
    const health = this.store.find("retrieval_adapter_health", `retrieval_adapter_health_${String(adapter.id)}`);
    if (!health || health.status !== "open") return health;
    if (Date.parse(String(health.open_until)) <= now.valueOf()) {
      return this.store.save("retrieval_adapter_health", String(health.id), { ...payload(health), status: "half_open", open_until: null, updated_at: now.toISOString() });
    }
    return health;
  }

  private recordRetrievalHealth(adapter: JsonObject, execution: { used: string; unavailable_reason: string | null }, now: Date): void {
    const id = `retrieval_adapter_health_${String(adapter.id)}`; const prior = this.store.find("retrieval_adapter_health", id);
    if (execution.used === "vector" || execution.used === "hybrid") {
      if (prior) this.store.save("retrieval_adapter_health", id, { ...payload(prior), status: "ready", consecutive_transient_failures: 0, open_until: null, last_error: null, updated_at: now.toISOString() });
      else this.store.create("retrieval_adapter_health", id, { adapter_id: adapter.id, adapter_version: adapter.version, status: "ready", consecutive_transient_failures: 0, open_until: null, last_error: null, updated_at: now.toISOString() });
      return;
    }
    const reason = execution.unavailable_reason ?? "embedding_request_failed";
    const transient = /(?:timeout|fetch|network|http_5\d\d|request_failed)/iu.test(reason);
    const failures = transient ? Number(prior?.consecutive_transient_failures ?? 0) + 1 : Number(prior?.consecutive_transient_failures ?? 0);
    const next = { adapter_id: adapter.id, adapter_version: adapter.version, status: transient && failures >= 3 ? "open" : "degraded", consecutive_transient_failures: failures,
      open_until: transient && failures >= 3 ? new Date(now.valueOf() + 5 * 60_000).toISOString() : null, last_error: reason, updated_at: now.toISOString() };
    if (prior) this.store.save("retrieval_adapter_health", id, { ...payload(prior), ...next }); else this.store.create("retrieval_adapter_health", id, next);
  }
}

/** Rank fusion keeps incomparable BM25 and cosine scales from distorting Hybrid retrieval. */
function reciprocalRankFuse(vector: readonly { id: string }[], keyword: readonly { id: string }[]): { id: string; score: number; reason: string }[] {
  const scores = new Map<string, number>(); const add = (items: readonly { id: string }[]): void => items.forEach((item, index) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (60 + index + 1)));
  add(vector); add(keyword);
  return [...scores.entries()].map(([id, score]) => ({ id, score, reason: "hybrid_rrf" })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
