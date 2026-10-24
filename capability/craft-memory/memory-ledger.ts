/**
 * The Memory Ledger.
 *
 * A memory entry is **not** a note: it carries the Knowledge Source it came from (and that
 * Source's version at the time), a scope, a content digest, a sensitivity, a confidence and the
 * Evidence that backs it. Two rules make it a governed record rather than storage:
 *
 *  - **Provenance is mandatory.** `remember` refuses a Source that is not active, and refuses
 *    `procedural` or `confirmed` entries without Evidence. So the ledger cannot hold an
 *    assertion whose origin and support are unknown.
 *  - **Identity is content-addressed.** The identity digest covers the Source version and the
 *    content digest, so re-remembering the same thing is idempotent and re-remembering a
 *    *changed* thing under the same id is a conflict rather than an overwrite.
 *
 * This was the memory half of `KnowledgeMemoryRuntime`. Splitting it along the member boundary
 * is what lets `craft-memory` be a capability: before the split the class also held the
 * Knowledge Source registry, so it belonged to neither member's package and neither could
 * declare it.
 *
 * Storing is only half of the member. Reading it back is `ContextResolutionKernel.resolve`,
 * which stays in the core because both the knowledge and memory products need to resolve what
 * they hold.
 */
import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { noCredentialAssignment, optionalScope, parseScope, sortedUniqueList, text, type ScopeRef } from "../../common/craft-common-base/src/validation.ts";
import { canonicalJson, digestJson, stableDigest, payload } from "../../common/craft-common-base/src/digest.ts";
import { contentReference } from "../../common/craft-common-store-local/src/content-store.ts";
import { scopeAccess, scopeAllows, scopeEnvelope, sourceAllows, type ScopeAccess } from "../../common/craft-common-base/src/scope-policy.ts";
import { temporalMemorySelect } from "../../common/craft-common-base/src/memory-temporal-policy.ts";
import { MemoryFileStore } from "./memory-files.ts";

const MEMORY_KINDS = new Set(["working", "episodic", "preference", "procedural"]);
const MEMORY_STATUS = new Set(["active", "superseded", "revoked", "expired"]);
const SENSITIVITIES = new Set(["public", "internal", "restricted"]);
const CONFIDENCES = new Set(["confirmed", "bounded", "unverified"]);
const LEGACY_KINDS = new Set(["memory_item", "episodic_memory", "semantic_memory"]);

/** An absent or unparsable `valid_until` is `null`, which means "does not expire". */
function date(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  const result = new Date(text(value, name));
  if (Number.isNaN(result.valueOf())) throw new Error(`${name} must be an ISO timestamp`);
  return result.toISOString();
}

function supportCurrent(source: JsonObject): boolean {
  if (source.valid_until === undefined || source.valid_until === null) return true;
  if (typeof source.valid_until !== "string") return false;
  const until = Date.parse(source.valid_until);
  return Number.isFinite(until) && until >= Date.now();
}

export class MemoryLedgerKernel {
  readonly store: CraftStore;
  readonly files: MemoryFileStore;
  constructor(store: CraftStore) { this.store = store; this.files = new MemoryFileStore(store, memory => this.promotionSupported(memory)); }

  /** Promotion support is checked from current records, never from caller-supplied counts. */
  validatePromotionSupport(args: JsonObject): Array<{ kind: string; id: string; version: number }> {
    const automatic = args.proposed_by === "automatic-memory-promotion";
    const raw = args.promotion_support_refs;
    if (!automatic && raw === undefined) return [];
    if (!automatic || !Array.isArray(raw)) throw new Error("Automatic Memory promotion requires support references");
    const scopeKind = text(args.scope_kind, "scope_kind");
    const scopeId = text(args.scope_id, "scope_id");
    if (scopeKind !== "project" && scopeKind !== "global") throw new Error("Automatic Memory promotion scope is unsupported");
    const expectedKind = scopeKind === "project" ? "memory_observation" : "memory_ledger";
    const contentDigest = stableDigest(text(args.content, "content"));
    const topic = args.topic === undefined || args.topic === "" ? "" : text(args.topic, "topic");
    const identities = new Set<string>();
    const refs = raw.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Memory promotion support reference is malformed");
      const ref = value as JsonObject;
      if (ref.kind !== expectedKind || typeof ref.id !== "string" || !ref.id || !Number.isSafeInteger(ref.version) || Number(ref.version) < 1)
        throw new Error("Memory promotion support reference is malformed");
      const source = this.store.find(expectedKind, ref.id, undefined, false);
      if (!source || source.version !== ref.version || source.status !== "active" || source.content_digest !== contentDigest
        || source.kind !== args.kind || (source.topic ?? "") !== topic || !supportCurrent(source)
        || (expectedKind === "memory_ledger" && !this.promotionSupported(source)))
        throw new Error("Memory promotion support is no longer active");
      const identity = scopeKind === "project" ? String(source.session_digest ?? "") : String((source.scope as JsonObject | undefined)?.id ?? "");
      if (!identity || (scopeKind === "project" ? source.project_id !== scopeId
        || (source.scope as JsonObject | undefined)?.kind !== "project" || (source.scope as JsonObject | undefined)?.id !== scopeId
        : (source.scope as JsonObject | undefined)?.kind !== "project")
        || identities.has(identity)) throw new Error("Memory promotion support is not independent in scope");
      identities.add(identity);
      return { kind: expectedKind, id: ref.id as string, version: Number(ref.version) };
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (identities.size < (scopeKind === "project" ? 2 : 3)) throw new Error("Memory promotion support threshold is unmet");
    return refs;
  }

  private automaticPromotion(memory: JsonObject): boolean {
    if (Array.isArray(memory.promotion_support_refs) && memory.promotion_support_refs.length > 0) return true;
    const scope = memory.scope as ScopeRef;
    const contentDigest = String(memory.content_digest);
    const kind = memory.kind, topic = memory.topic ?? "";
    const candidateId = scope.kind === "project"
      ? `memory_candidate_project_${digestJson({ contentDigest, projectId: scope.id, kind, topic }).slice(-32)}`
      : scope.kind === "global" ? `memory_candidate_global_${digestJson({ contentDigest, kind, topic }).slice(-32)}` : "";
    const candidate = candidateId ? this.store.find("memory_candidate", candidateId, undefined, false) : null;
    return candidate !== null && candidate.ledger_memory_id === memory.id && candidate.proposed_by === "automatic-memory-promotion";
  }

  /** Exact support revisions fail closed; legacy automatic entries use the original repeat threshold. */
  promotionSupported(memory: JsonObject): boolean {
    if (!this.automaticPromotion(memory)) return true;
    const scope = memory.scope as ScopeRef;
    const expectedKind = scope.kind === "project" ? "memory_observation" : scope.kind === "global" ? "memory_ledger" : "";
    if (!expectedKind) return false;
    const refs = memory.promotion_support_refs;
    const sources = Array.isArray(refs) && refs.length > 0
      ? refs.map(value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const ref = value as JsonObject;
        if (ref.kind !== expectedKind || typeof ref.id !== "string" || !Number.isSafeInteger(ref.version)) return null;
        const source = this.store.find(expectedKind, ref.id, undefined, false);
        return source?.version === ref.version ? source : null;
      })
      : this.store.list(expectedKind, 10_000, source => source.status === "active" && supportCurrent(source) && source.content_digest === memory.content_digest
        && source.kind === memory.kind && (source.topic ?? "") === (memory.topic ?? "")
        && (scope.kind === "project" ? source.project_id === scope.id && (source.scope as ScopeRef | undefined)?.kind === "project"
          && (source.scope as ScopeRef).id === scope.id && typeof source.session_digest === "string" && !!source.session_digest
          : (source.scope as ScopeRef | undefined)?.kind === "project" && typeof (source.scope as ScopeRef).id === "string"
            && !!(source.scope as ScopeRef).id), false);
    if (sources.some(source => source === null)) return false;
    const identities = new Set<string>();
    for (const source of sources as JsonObject[]) {
      if (source.status !== "active" || source.content_digest !== memory.content_digest || source.kind !== memory.kind
        || (source.topic ?? "") !== (memory.topic ?? "") || !supportCurrent(source)) return false;
      if (scope.kind === "project") {
        const sourceScope = source.scope as ScopeRef | undefined;
        if (source.project_id !== scope.id || sourceScope?.kind !== "project" || sourceScope.id !== scope.id
          || typeof source.session_digest !== "string" || !source.session_digest) return false;
        identities.add(source.session_digest);
      } else {
        const sourceScope = source.scope as ScopeRef | undefined;
        if (sourceScope?.kind !== "project" || typeof sourceScope.id !== "string" || !sourceScope.id
          || !this.promotionSupported(source)) return false;
        identities.add(sourceScope.id);
      }
    }
    return identities.size >= (scope.kind === "project" ? 2 : 3);
  }

  remember(args: JsonObject): JsonObject {
    const source = this.store.get("knowledge_source", text(args.source_id, "source_id")); if (source.status !== "active") throw new Error("Knowledge Source is not active");
    const kind = text(args.kind, "kind"); if (!MEMORY_KINDS.has(kind)) throw new Error("Memory kind is unsupported");
    const sensitivity = text(args.sensitivity ?? "internal", "sensitivity"); if (!SENSITIVITIES.has(sensitivity)) throw new Error("Memory sensitivity is unsupported");
    const memoryScope = parseScope(args); const envelope = scopeEnvelope(args.scope_envelope, memoryScope); const evidenceIds = sortedUniqueList(args.evidence_ids, "evidence_ids"); evidenceIds.forEach((item) => this.store.get("evidence", item));
    if (memoryScope.kind === "session") {
      this.files.pathFor(memoryScope);
      if (this.files.isSessionArchived(memoryScope.id)) throw new Error("Archived session Memory cannot be written");
    }
    const content = noCredentialAssignment(text(args.content, "content"), "content"); const confidence = text(args.confidence ?? "bounded", "confidence");
    if (!CONFIDENCES.has(confidence)) throw new Error("Memory confidence is unsupported");
    if ((kind === "procedural" || confidence === "confirmed") && !evidenceIds.length) throw new Error("Procedural or confirmed Memory requires Evidence");
    const memoryId = String(args.memory_id ?? `memory_ledger_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("memory_ledger", memoryId);
    const explicitValidUntil = args.valid_until === undefined && existing
      ? (typeof existing.valid_until === "string" ? existing.valid_until : null)
      : date(args.valid_until, "valid_until");
    // A working note and an episode are both about now, so they get a default lifetime; a
    // preference or a procedure is meant to outlive the turn that wrote it and does not.
    const validUntil = explicitValidUntil ?? (kind === "working" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : kind === "episodic" ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null);
    // `topic` is optional for compatibility, but when supplied it provides the
    // stable subject key used by governed conflict resolution (for example
    // `preference:diet:sugar`).  It is deliberately not inferred from prose:
    // an LLM guess must not silently merge two unrelated memories.
    const topic = args.topic === undefined ? undefined : text(args.topic, "topic");
    const observedAt = args.observed_at === undefined && typeof existing?.observed_at === "string"
      ? existing.observed_at
      : (date(args.observed_at, "observed_at") ?? new Date().toISOString());
    const effectiveFrom = args.effective_from === undefined && typeof existing?.effective_from === "string"
      ? existing.effective_from
      : (date(args.effective_from, "effective_from") ?? observedAt);
    // `working_note:true` is the new task/session-only form.  Older callers still
    // write `kind: working`; keep those records readable as a migration bridge
    // instead of silently making existing projects lose their current notes.
    const workingNote = kind === "working" && args.working_note === true;
    const supportRefs = this.validatePromotionSupport(args);
    const identity = { source_id: source.id, source_version: source.version, kind, scope: memoryScope, scope_envelope: envelope, content_digest: stableDigest(content), sensitivity, confidence, evidence_ids: evidenceIds, valid_until: validUntil, observed_at: observedAt, effective_from: effectiveFrom, working_note: workingNote, ...(topic === undefined ? {} : { topic }), ...(supportRefs.length ? { promotion_support_refs: supportRefs } : {}) };
    const identityDigest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Memory Ledger idempotency conflict");
      const projection = this.files.sync(memoryScope);
      return { memory: existing, projection, idempotent: true };
    }
    // The body lives in the content store; the record keeps the reference and the digest, so
    // the Ledger indexes memory rather than holding it, and a rewritten body is a drift error.
    const contentRef = this.store.contentStore.writeSync({ kind: "memory", record_id: memoryId, version: 1, scope: `${memoryScope.kind}:${memoryScope.id}`, status: "active", sensitivity, source_id: String(source.id), body: content,
      ...(typeof args.project_root === "string" ? { project_root: args.project_root } : {}) });
    const memory = this.store.create("memory_ledger", memoryId, { ...identity, content_ref: contentRef, identity_digest: identityDigest, status: "active", supersedes_id: null, contradiction_ids: [], derived_from_ids: supportRefs.map(ref => ref.id), ...(workingNote ? {} : { working_legacy_compatibility: kind === "working" }) });
    return { memory, projection: this.files.sync(memoryScope), idempotent: false };
  }

  /**
   * Supersede, revoke or expire one entry, keeping the record.
   *
   * A supersession must name an **active** replacement in the **same scope**; anything else
   * would leave the ledger pointing at an entry a reader cannot use, or silently move a fact
   * between scopes where a different policy applies.
   */
  transition(args: JsonObject): JsonObject {
    const memoryId = text(args.memory_id, "memory_id"); const status = text(args.status, "status");
    if (!MEMORY_STATUS.has(status) || status === "active") throw new Error("Memory status is unsupported");
    const replacementId = args.replacement_id === undefined ? null : text(args.replacement_id, "replacement_id");
    const reasonDigest = stableDigest(noCredentialAssignment(text(args.reason, "reason"), "reason"));
    const result = this.store.transaction(() => {
      const memory = this.store.get("memory_ledger", memoryId);
      if (status === "superseded") {
        if (!replacementId) throw new Error("Superseded Memory requires replacement_id");
        const replacement = this.store.get("memory_ledger", replacementId);
        if (replacement.status !== "active" || canonicalJson(replacement.scope) !== canonicalJson(memory.scope)) throw new Error("Memory replacement must be active in the same scope");
      }
      const expectedVersion = args.expected_version ?? memory.version;
      if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) throw new Error("expected_version must be a positive integer");
      const scope = memory.scope as ScopeRef;
      const idempotent = memory.status === status && memory.replacement_id === replacementId && memory.transition_reason_digest === reasonDigest;
      if (memory.status !== "active" && !idempotent) throw new Error("Memory transition requires an active entry");
      const updated = idempotent ? memory : this.store.updateIfVersion("memory_ledger", memoryId, Number(expectedVersion), {
        ...payload(memory), status, replacement_id: replacementId, transition_reason_digest: reasonDigest,
      });
      const scopes: ScopeRef[] = [scope], retired: JsonObject[] = [];
      const sameFact = (item: JsonObject) => item.content_digest === memory.content_digest && item.kind === memory.kind && (item.topic ?? "") === (memory.topic ?? "");
      const retire = (item: JsonObject) => {
        const saved = this.store.updateIfVersion("memory_ledger", String(item.id), Number(item.version), { ...payload(item), status: "revoked", replacement_id: null,
          transition_reason_digest: stableDigest({ supporting_memory_id: memoryId, supporting_version: memory.version }) });
        retired.push(saved); scopes.push(saved.scope as ScopeRef);
      };
      const changedProjects = new Set<string>();
      if (scope.kind === "session") {
        const observations = this.store.list("memory_observation", 10_000, item => item.status === "active" && sameFact(item)
          && item.session_digest === digestJson(scope.id), false);
        for (const observation of observations) {
          if (typeof observation.project_id !== "string" || !observation.project_id.trim()) throw new Error("Memory observation project scope is missing");
          this.store.updateIfVersion("memory_observation", String(observation.id), Number(observation.version), { ...payload(observation), status: "revoked", invalidated_by: memoryId });
          changedProjects.add(observation.project_id);
        }
      }
      if (scope.kind === "project") changedProjects.add(scope.id);
      for (const projectId of changedProjects) {
        if (scope.kind === "project") {
          const observations = this.store.list("memory_observation", 10_000, item => item.status === "active" && sameFact(item) && item.project_id === projectId, false);
          for (const observation of observations) this.store.updateIfVersion("memory_observation", String(observation.id), Number(observation.version), {
            ...payload(observation), status: "revoked", invalidated_by: memoryId,
          });
        }
        const projects = this.store.listScoped("memory_ledger", [{ kind: "project", id: projectId }], 10_000,
          item => item.status === "active" && sameFact(item), undefined, { hydrateContent: false });
        for (const project of projects) if (this.automaticPromotion(project) && !this.promotionSupported(project)) retire(project);
      }
      if (changedProjects.size > 0) {
        const globals = this.store.listScoped("memory_ledger", [{ kind: "global", id: "global" }], 10_000,
          item => item.status === "active" && sameFact(item), undefined, { hydrateContent: false });
        for (const global of globals) if (this.automaticPromotion(global) && !this.promotionSupported(global)) retire(global);
      }
      return { memory: updated, idempotent, scopes, retired };
    });
    const projections = result.scopes.map(scope => this.files.sync(scope));
    return { memory: result.memory, projection: projections[0], derived_transitions: result.retired, idempotent: result.idempotent };
  }

  /**
   * Reference a pre-Ledger memory record through the Ledger, without migrating it.
   *
   * `mode: "reference_only"` and `migration_performed: false` are recorded on the binding rather
   * than left implicit, so the claim "no destructive migration happened" is a fact a reader can
   * check on the record itself.
   */
  compatBind(args: JsonObject): JsonObject {
    const legacyKind = text(args.legacy_kind, "legacy_kind"); if (!LEGACY_KINDS.has(legacyKind)) throw new Error("Legacy Memory kind is unsupported");
    const legacy = this.store.get(legacyKind, text(args.legacy_id, "legacy_id")); const source = this.store.get("knowledge_source", text(args.source_id, "source_id"));
    const bindingId = String(args.binding_id ?? `memory_compat_${legacyKind}_${legacy.id}`); const identity = { legacy_kind: legacyKind, legacy_id: legacy.id, legacy_version: legacy.version, source_id: source.id, source_version: source.version, legacy_digest: stableDigest(legacy) };
    const existing = this.store.find("memory_compat_binding", bindingId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Memory compatibility binding idempotency conflict"); return { binding: existing, idempotent: true }; }
    return { binding: this.store.create("memory_compat_binding", bindingId, { ...identity, identity_digest: identityDigest, mode: "reference_only", migration_performed: false }), idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const memoryId = text(args.memory_id, "memory_id");
    const current = this.store.get("memory_ledger", memoryId);
    const scope = optionalScope(args), access = scopeAccess(args), allowRestricted = args.allow_restricted === true;
    if (!this.visible(current, scope, access, allowRestricted)) throw new Error("Memory scope or audience denied");
    if (current.status === "active" && !this.promotionSupported(current)) throw new Error("Memory promotion support is unavailable");
    const memory = args.version === undefined ? current : this.store.get("memory_ledger", memoryId, Number(args.version));
    if (canonicalJson(memory.scope) !== canonicalJson(current.scope) || !this.visible(memory, scope, access, allowRestricted)) throw new Error("Memory historical scope or audience denied");
    this.files.sync(memory.scope as ScopeRef);
    return { memory: { ...memory, content: this.content(memory) } };
  }

  /**
   * List a bounded, explicitly scoped view of the ledger.
   *
   * There is intentionally no "all memories" fallback here.  A standalone Memory
   * MCP must be useful without becoming a cross-project history reader: callers
   * name the same scope they would use to resolve Context, and history is opt-in
   * because superseded or revoked entries are diagnostic evidence rather than
   * active advice.
   */
  list(args: JsonObject): JsonObject {
    const scope = parseScope(args);
    const limit = args.limit === undefined ? 50 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer between 1 and 100");
    if (args.include_history !== undefined && typeof args.include_history !== "boolean") throw new Error("include_history must be boolean");
    const includeHistory = args.include_history === true;
    const access = scopeAccess(args), allowRestricted = args.allow_restricted === true;
    const listed = this.store.listScoped("memory_ledger", [scope], limit, (item) => this.visible(item, scope, access, allowRestricted)
      && (includeHistory || item.status === "active" && this.promotionSupported(item)));
    const memories = temporalMemorySelect(listed, new Date(), includeHistory).selected
      .map((memory) => ({ ...memory, content: this.content(memory) }));
    this.files.sync(scope);
    return { scope, include_history: includeHistory, count: memories.length, memories };
  }

  private visible(memory: JsonObject, requestedScope: ScopeRef | null, access: ScopeAccess, allowRestricted: boolean): boolean {
    const scope = memory.scope as ScopeRef;
    if (requestedScope !== null && canonicalJson(scope) !== canonicalJson(requestedScope)
      || !scopeAllows(scopeEnvelope(memory.scope_envelope, scope), access) || memory.sensitivity === "restricted" && !allowRestricted) return false;
    const source = this.store.find("knowledge_source", String(memory.source_id));
    return source !== null && sourceAllows(source, access);
  }

  /**
   * One entry's body, from wherever it lives.
   *
   * A record written before the content store existed still carries `content` inline and is
   * returned as it is; otherwise the body is read back through the reference, so a moved or
   * edited file is a failure rather than a silently different memory.
   */
  private content(memory: JsonObject): string {
    if (typeof memory.content === "string") return memory.content;
    const ref = memory.content_ref;
    if (!contentReference(ref)) throw new Error("Memory content reference is missing");
    return this.store.contentStore.readCompatSync(ref).body;
  }
}
