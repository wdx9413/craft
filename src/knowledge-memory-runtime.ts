import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const SOURCE_KINDS = new Set(["evidence_wiki", "serena", "kefu_wiki", "project_note", "readme", "custom"]);
const TRUSTS = new Set(["untrusted", "bounded", "verified"]);
const ACCESS = new Set(["read_only", "proposal_only"]);
const MEMORY_KINDS = new Set(["working", "episodic", "preference", "procedural"]);
const MEMORY_STATUS = new Set(["active", "superseded", "revoked", "expired"]);
const SENSITIVITIES = new Set(["public", "internal", "restricted"]);
const SCOPE_KINDS = new Set(["user", "project", "workspace", "task", "session"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function object(value: unknown, name: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject; }
function strings(value: unknown, name: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  return result.sort();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function noSecret(value: string, name: string): string { if (SECRET.test(value)) throw new Error(`${name} must not contain credentials or secrets`); return value; }
function noSecretValue(value: unknown, name: string): void {
  if (typeof value === "string") { noSecret(value, name); return; }
  if (Array.isArray(value)) { value.forEach((item) => noSecretValue(item, name)); return; }
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value as JsonObject)) {
    if (/(?:api[_-]?key|authorization|cookie|password|secret|token)/iu.test(key)) throw new Error(`${name} must not contain credentials or secrets`);
    noSecretValue(child, name);
  }
}
function date(value: unknown, name: string): string | null { if (value === undefined || value === null) return null; const result = new Date(text(value, name)); if (Number.isNaN(result.valueOf())) throw new Error(`${name} must be an ISO timestamp`); return result.toISOString(); }
function scope(args: JsonObject): JsonObject {
  const kind = text(args.scope_kind, "scope_kind"); if (!SCOPE_KINDS.has(kind)) throw new Error("scope_kind is unsupported");
  return { kind, id: text(args.scope_id, "scope_id") };
}

/**
 * One control-plane module for background sources, durable memories and the
 * exact bounded context supplied to a Host. It never writes an external source
 * and never lets retrieval selection grant capability or execution authority.
 */
export class KnowledgeMemoryRuntime {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  installBuiltins(): JsonObject {
    const sources = [
      this.sourceRegister({ source_id: "builtin.evidence-wiki", kind: "evidence_wiki", label: "Craft Evidence Wiki", scope_kind: "user", scope_id: "local", locator: "~/.craft_data/wiki", content_digest: "builtin:evidence-wiki:v1", trust: "verified", access: "proposal_only" }).source,
      this.sourceRegister({ source_id: "builtin.serena-project-knowledge", kind: "serena", label: "Serena project knowledge", scope_kind: "project", scope_id: "selected-project", locator: ".serena/memories", content_digest: "builtin:serena-project-knowledge:v1", trust: "bounded", access: "read_only" }).source,
    ];
    return { sources };
  }

  sourceRegister(args: JsonObject): JsonObject {
    const kind = text(args.kind, "kind"); if (!SOURCE_KINDS.has(kind)) throw new Error("Knowledge Source kind is unsupported");
    const trust = text(args.trust ?? "untrusted", "trust"); if (!TRUSTS.has(trust)) throw new Error("Knowledge Source trust is unsupported");
    const access = text(args.access ?? "read_only", "access"); if (!ACCESS.has(access)) throw new Error("Knowledge Source access is unsupported");
    const sourceScope = scope(args); const identity = { kind, label: noSecret(text(args.label, "label"), "label"), scope: sourceScope,
      locator: noSecret(text(args.locator, "locator"), "locator"), content_digest: text(args.content_digest, "content_digest"), trust, access };
    const sourceId = String(args.source_id ?? `knowledge_source_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("knowledge_source", sourceId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Knowledge Source idempotency conflict"); return { source: existing, idempotent: true }; }
    return { source: this.store.create("knowledge_source", sourceId, { ...identity, identity_digest: identityDigest, status: "active" }), idempotent: false };
  }

  sourceList(args: JsonObject = {}): JsonObject {
    const scopeKind = args.scope_kind === undefined ? null : text(args.scope_kind, "scope_kind"); const scopeId = args.scope_id === undefined ? null : text(args.scope_id, "scope_id");
    if ((scopeKind === null) !== (scopeId === null)) throw new Error("Knowledge Source scope_kind and scope_id must be supplied together");
    return { sources: this.store.list("knowledge_source", Number(args.limit ?? 100), (item) => item.status === "active" && (scopeKind === null || (item.scope as JsonObject).kind === scopeKind && (item.scope as JsonObject).id === scopeId)) };
  }

  sourceTransition(args: JsonObject): JsonObject {
    const source = this.store.get("knowledge_source", text(args.source_id, "source_id")); const status = text(args.status, "status");
    if (!new Set(["disabled", "revoked"]).has(status)) throw new Error("Knowledge Source status is unsupported");
    return { source: this.store.save("knowledge_source", String(source.id), { ...payload(source), status, transition_reason_digest: digest(noSecret(text(args.reason, "reason"), "reason")) }) };
  }

  remember(args: JsonObject): JsonObject {
    const source = this.store.get("knowledge_source", text(args.source_id, "source_id")); if (source.status !== "active") throw new Error("Knowledge Source is not active");
    const kind = text(args.kind, "kind"); if (!MEMORY_KINDS.has(kind)) throw new Error("Memory kind is unsupported");
    const sensitivity = text(args.sensitivity ?? "internal", "sensitivity"); if (!SENSITIVITIES.has(sensitivity)) throw new Error("Memory sensitivity is unsupported");
    const memoryScope = scope(args); const evidenceIds = strings(args.evidence_ids, "evidence_ids"); evidenceIds.forEach((item) => this.store.get("evidence", item));
    const content = noSecret(text(args.content, "content"), "content"); const confidence = text(args.confidence ?? "bounded", "confidence");
    if (!new Set(["confirmed", "bounded", "unverified"]).has(confidence)) throw new Error("Memory confidence is unsupported");
    if ((kind === "procedural" || confidence === "confirmed") && !evidenceIds.length) throw new Error("Procedural or confirmed Memory requires Evidence");
    const explicitValidUntil = date(args.valid_until, "valid_until");
    const validUntil = explicitValidUntil ?? (kind === "working" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : kind === "episodic" ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null);
    const identity = { source_id: source.id, source_version: source.version, kind, scope: memoryScope, content, content_digest: digest(content), sensitivity, confidence, evidence_ids: evidenceIds, valid_until: validUntil };
    const memoryId = String(args.memory_id ?? `memory_ledger_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("memory_ledger", memoryId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Memory Ledger idempotency conflict"); return { memory: existing, idempotent: true }; }
    return { memory: this.store.create("memory_ledger", memoryId, { ...identity, identity_digest: identityDigest, status: "active", supersedes_id: null }), idempotent: false };
  }

  transition(args: JsonObject): JsonObject {
    const memory = this.store.get("memory_ledger", text(args.memory_id, "memory_id")); const status = text(args.status, "status");
    if (!MEMORY_STATUS.has(status) || status === "active") throw new Error("Memory status is unsupported");
    const replacementId = args.replacement_id === undefined ? null : text(args.replacement_id, "replacement_id");
    if (status === "superseded") {
      if (!replacementId) throw new Error("Superseded Memory requires replacement_id");
      const replacement = this.store.get("memory_ledger", replacementId);
      if (replacement.status !== "active" || canonical(replacement.scope) !== canonical(memory.scope)) throw new Error("Memory replacement must be active in the same scope");
    }
    return { memory: this.store.save("memory_ledger", String(memory.id), { ...payload(memory), status, replacement_id: replacementId, transition_reason_digest: digest(noSecret(text(args.reason, "reason"), "reason")) }) };
  }

  compatBind(args: JsonObject): JsonObject {
    const legacyKind = text(args.legacy_kind, "legacy_kind"); if (!new Set(["memory_item", "episodic_memory", "semantic_memory"]).has(legacyKind)) throw new Error("Legacy Memory kind is unsupported");
    const legacy = this.store.get(legacyKind, text(args.legacy_id, "legacy_id")); const source = this.store.get("knowledge_source", text(args.source_id, "source_id"));
    const bindingId = String(args.binding_id ?? `memory_compat_${legacyKind}_${legacy.id}`); const identity = { legacy_kind: legacyKind, legacy_id: legacy.id, legacy_version: legacy.version, source_id: source.id, source_version: source.version, legacy_digest: digest(legacy) };
    const existing = this.store.find("memory_compat_binding", bindingId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Memory compatibility binding idempotency conflict"); return { binding: existing, idempotent: true }; }
    return { binding: this.store.create("memory_compat_binding", bindingId, { ...identity, identity_digest: identityDigest, mode: "reference_only", migration_performed: false }), idempotent: false };
  }

  retrievalConfigure(args: JsonObject): JsonObject {
    const strategy = text(args.strategy, "strategy"); if (!new Set(["keyword", "vector"]).has(strategy)) throw new Error("Retrieval strategy is unsupported");
    const config = object(args.configuration ?? {}, "configuration"); noSecretValue(config, "configuration"); const adapterId = String(args.adapter_id ?? `retrieval_adapter_${randomUUID().replaceAll("-", "")}`);
    const identity = { strategy, provider_fingerprint: args.provider_fingerprint === undefined ? null : text(args.provider_fingerprint, "provider_fingerprint"), configuration_digest: digest(config) };
    if (strategy === "vector" && identity.provider_fingerprint === null) throw new Error("Vector Retrieval Adapter requires provider_fingerprint");
    const existing = this.store.find("retrieval_adapter", adapterId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Retrieval Adapter idempotency conflict"); return { adapter: existing, idempotent: true }; }
    return { adapter: this.store.create("retrieval_adapter", adapterId, { ...identity, identity_digest: identityDigest, status: strategy === "keyword" ? "eligible" : "configured" }), idempotent: false };
  }

  retrievalEvaluate(args: JsonObject): JsonObject {
    const adapter = this.store.get("retrieval_adapter", text(args.adapter_id, "adapter_id")); const metrics = object(args.metrics, "metrics");
    const recall = Number(metrics.recall); const leakage = Number(metrics.cross_project_leak_count); const latency = Number(metrics.latency_ms); const cost = Number(metrics.cost_usd);
    if (![recall, leakage, latency, cost].every(Number.isFinite) || recall < 0 || recall > 1 || leakage < 0 || latency < 0 || cost < 0) throw new Error("Retrieval evaluation metrics are invalid");
    const minimumRecall = Number(args.minimum_recall ?? 0.8); const maxLatency = Number(args.max_latency_ms ?? Number.MAX_SAFE_INTEGER); const maxCost = Number(args.max_cost_usd ?? Number.MAX_SAFE_INTEGER);
    if (![minimumRecall, maxLatency, maxCost].every(Number.isFinite) || minimumRecall < 0 || minimumRecall > 1 || maxLatency < 0 || maxCost < 0) throw new Error("Retrieval evaluation thresholds are invalid");
    const eligible = adapter.strategy === "keyword" || recall >= minimumRecall && leakage === 0 && latency <= maxLatency && cost <= maxCost;
    const evaluationId = String(args.evaluation_id ?? `retrieval_evaluation_${randomUUID().replaceAll("-", "")}`); const identity = { adapter_id: adapter.id, adapter_version: adapter.version, metrics, minimum_recall: minimumRecall, max_latency_ms: maxLatency, max_cost_usd: maxCost };
    const existing = this.store.find("retrieval_evaluation", evaluationId); const identityDigest = digest(identity);
    if (existing) {
      const replayIdentity = { ...identity, adapter_version: existing.adapter_version };
      if (existing.identity_digest !== digest(replayIdentity)) throw new Error("Retrieval evaluation idempotency conflict");
      return { evaluation: existing, adapter, idempotent: true };
    }
    const evaluation = this.store.create("retrieval_evaluation", evaluationId, { ...identity, identity_digest: identityDigest, verdict: eligible ? "eligible" : "rejected" });
    const saved = this.store.save("retrieval_adapter", String(adapter.id), { ...payload(adapter), status: eligible ? "eligible" : "rejected", latest_evaluation_id: evaluation.id });
    return { evaluation, adapter: saved, idempotent: false };
  }

  resolve(args: JsonObject): JsonObject {
    const query = noSecret(text(args.query, "query"), "query"); const requestedScope = scope(args); const now = new Date(args.now === undefined ? Date.now() : text(args.now, "now")); if (Number.isNaN(now.valueOf())) throw new Error("now must be an ISO timestamp");
    const maxItems = Number(args.max_items ?? 12); const maxChars = Number(args.max_chars ?? 12_000); if (!Number.isInteger(maxItems) || maxItems < 1 || !Number.isInteger(maxChars) || maxChars < 1) throw new Error("Context budget is invalid");
    const sourceIds = strings(args.source_ids, "source_ids"); const requestedIds = strings(args.memory_ids, "memory_ids"); const allowRestricted = args.allow_restricted === true; const adapter = args.retrieval_adapter_id === undefined ? null : this.store.get("retrieval_adapter", text(args.retrieval_adapter_id, "retrieval_adapter_id"));
    const retrievalMode = adapter?.status === "eligible" ? adapter.strategy : "keyword";
    const queryTerms = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []; const selectedSourceIds = sourceIds.length ? new Set(sourceIds) : null;
    const sources = new Map(this.store.list("knowledge_source", 10_000).map((source) => [String(source.id), source]));
    for (const sourceId of sourceIds) {
      const source = sources.get(sourceId);
      if (!source || source.status !== "active" || source.trust === "untrusted") throw new Error("Requested Knowledge Source is unavailable in this Context");
    }
    const candidates = this.store.list("memory_ledger", 10_000, (item) => {
      const source = sources.get(String(item.source_id));
      return item.status === "active" && source?.status === "active" && source.trust !== "untrusted" && canonical(item.scope) === canonical(requestedScope)
        && (item.valid_until === null || Date.parse(String(item.valid_until)) >= now.valueOf()) && (allowRestricted || item.sensitivity !== "restricted")
        && (selectedSourceIds === null || selectedSourceIds.has(String(item.source_id)));
    })
      .map((item) => ({ memory: item, required: requestedIds.includes(String(item.id)), score: queryTerms.reduce((sum, term) => sum + Number(String(item.content).toLowerCase().includes(term)), 0) }))
      .filter((item) => item.required || item.score > 0).sort((left, right) => Number(right.required) - Number(left.required) || right.score - left.score || String(left.memory.id).localeCompare(String(right.memory.id)));
    for (const memoryId of requestedIds) if (!candidates.some((item) => item.memory.id === memoryId)) throw new Error("Required Memory is unavailable in this Context");
    const items: JsonObject[] = []; let usedChars = 0;
    for (const candidate of candidates) { const size = String(candidate.memory.content).length; if (items.length >= maxItems) break; if (usedChars + size > maxChars) { if (candidate.required) throw new Error("Required Memory exceeds Context budget"); continue; } usedChars += size; items.push({ memory_id: candidate.memory.id, memory_version: candidate.memory.version, source_id: candidate.memory.source_id, content: candidate.memory.content, content_digest: candidate.memory.content_digest, sensitivity: candidate.memory.sensitivity, reason: candidate.required ? "required" : retrievalMode === "vector" ? "evaluated_vector_adapter" : "keyword_overlap" }); }
    const receiptId = String(args.receipt_id ?? `context_resolution_${randomUUID().replaceAll("-", "")}`); const identity = { query_digest: digest(query), scope: requestedScope, retrieval_adapter_id: adapter?.id ?? null, retrieval_adapter_version: adapter?.version ?? null, retrieval_mode: retrievalMode, allow_restricted: allowRestricted, memory_refs: items.map((item) => ({ memory_id: item.memory_id, memory_version: item.memory_version, content_digest: item.content_digest, reason: item.reason })), max_items: maxItems, max_chars: maxChars, used_chars: usedChars };
    const existing = this.store.find("context_resolution_receipt", receiptId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Context Resolution Receipt idempotency conflict"); return { receipt: existing, items, idempotent: true }; }
    return { receipt: this.store.create("context_resolution_receipt", receiptId, { ...identity, identity_digest: identityDigest, omitted_count: candidates.length - items.length, content_free: true }), items, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { memory: this.store.get("memory_ledger", text(args.memory_id, "memory_id"), args.version === undefined ? undefined : Number(args.version)) }; }
  receiptGet(args: JsonObject): JsonObject { return { receipt: this.store.get("context_resolution_receipt", text(args.receipt_id, "receipt_id"), args.version === undefined ? undefined : Number(args.version)) }; }
}
