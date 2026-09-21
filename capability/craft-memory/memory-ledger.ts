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
import type { CraftStore, JsonObject } from "../../src/infrastructure/store.ts";
import { noCredentialAssignment, parseScope, sortedUniqueList, text } from "../../src/validation.ts";
import { canonicalJson, stableDigest, payload } from "../../src/digest.ts";
import { contentReference } from "../../src/infrastructure/content-store.ts";
import { scopeEnvelope } from "../../src/scope-policy.ts";

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

export class MemoryLedgerKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  remember(args: JsonObject): JsonObject {
    const source = this.store.get("knowledge_source", text(args.source_id, "source_id")); if (source.status !== "active") throw new Error("Knowledge Source is not active");
    const kind = text(args.kind, "kind"); if (!MEMORY_KINDS.has(kind)) throw new Error("Memory kind is unsupported");
    const sensitivity = text(args.sensitivity ?? "internal", "sensitivity"); if (!SENSITIVITIES.has(sensitivity)) throw new Error("Memory sensitivity is unsupported");
    const memoryScope = parseScope(args); const envelope = scopeEnvelope(args.scope_envelope, memoryScope); const evidenceIds = sortedUniqueList(args.evidence_ids, "evidence_ids"); evidenceIds.forEach((item) => this.store.get("evidence", item));
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
    const identity = { source_id: source.id, source_version: source.version, kind, scope: memoryScope, scope_envelope: envelope, content_digest: stableDigest(content), sensitivity, confidence, evidence_ids: evidenceIds, valid_until: validUntil, observed_at: observedAt, effective_from: effectiveFrom, working_note: workingNote, ...(topic === undefined ? {} : { topic }) };
    const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Memory Ledger idempotency conflict"); return { memory: existing, idempotent: true }; }
    // The body lives in the content store; the record keeps the reference and the digest, so
    // the Ledger indexes memory rather than holding it, and a rewritten body is a drift error.
    const contentRef = this.store.contentStore.writeSync({ kind: "memory", record_id: memoryId, version: 1, scope: `${memoryScope.kind}:${memoryScope.id}`, status: "active", sensitivity, source_id: String(source.id), body: content });
    return { memory: this.store.create("memory_ledger", memoryId, { ...identity, content_ref: contentRef, identity_digest: identityDigest, status: "active", supersedes_id: null, contradiction_ids: [], derived_from_ids: [], ...(workingNote ? {} : { working_legacy_compatibility: kind === "working" }) }), idempotent: false };
  }

  /**
   * Supersede, revoke or expire one entry, keeping the record.
   *
   * A supersession must name an **active** replacement in the **same scope**; anything else
   * would leave the ledger pointing at an entry a reader cannot use, or silently move a fact
   * between scopes where a different policy applies.
   */
  transition(args: JsonObject): JsonObject {
    const memory = this.store.get("memory_ledger", text(args.memory_id, "memory_id")); const status = text(args.status, "status");
    if (!MEMORY_STATUS.has(status) || status === "active") throw new Error("Memory status is unsupported");
    const replacementId = args.replacement_id === undefined ? null : text(args.replacement_id, "replacement_id");
    if (status === "superseded") {
      if (!replacementId) throw new Error("Superseded Memory requires replacement_id");
      const replacement = this.store.get("memory_ledger", replacementId);
      if (replacement.status !== "active" || canonicalJson(replacement.scope) !== canonicalJson(memory.scope)) throw new Error("Memory replacement must be active in the same scope");
    }
    return { memory: this.store.save("memory_ledger", String(memory.id), { ...payload(memory), status, replacement_id: replacementId, transition_reason_digest: stableDigest(noCredentialAssignment(text(args.reason, "reason"), "reason")) }) };
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
    const memory = this.store.get("memory_ledger", text(args.memory_id, "memory_id"), args.version === undefined ? undefined : Number(args.version));
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
    const scopeDigest = canonicalJson(scope);
    const memories = this.store.list("memory_ledger", limit, (item) => canonicalJson(item.scope) === scopeDigest && (includeHistory || item.status === "active"))
      .map((memory) => ({ ...memory, content: this.content(memory) }));
    return { scope, include_history: includeHistory, count: memories.length, memories };
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
