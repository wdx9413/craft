import { createHash, randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { text } from "../../common/craft-common-base/src/validation.ts";
import { scopeEnvelope, scopeFromKey } from "../../common/craft-common-base/src/scope-policy.ts";
import { claimReadable } from "./claim-access.ts";
import { knowledgeScenarioCanClassify, updateKnowledgeScenarioClaim, validateKnowledgeScenarioDefinition } from "./scenario-catalog.ts";
import { knowledgeDirectoryForScope } from "../../core/project-knowledge-content.ts";
import { recordKnowledgeSessionEvidence } from "./session-evidence.ts";
const KNOWLEDGE_KINDS = new Set(["fact", "rule", "decision", "term", "failure_mode"]);
const KNOWLEDGE_REVIEW_EXIT_STATUSES = new Set(["disputed", "superseded", "expired", "stale"]);
function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function valueDigest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function rawContentDigest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
const SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*[^\s]+/iu;
function document(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}
function finiteInteger(value: unknown, name: string, fallback: number, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}
function uniqueTextArray(value: unknown, name: string, minimum = 1): string[] {
  const values = array(value, name).map((item) => text(item, name));
  if (values.length < minimum || new Set(values).size !== values.length) {
    throw new Error(`${name} must contain at least ${minimum} unique values`);
  }
  return values;
}
function optionalTextArray(value: unknown, name: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  const values = array(value, name).map((item) => text(item, name));
  if (new Set(values).size !== values.length) throw new Error(`${name} must contain unique values`);
  return values;
}
function assertNoSecret(value: string, name: string): string {
  if (SECRET_ASSIGNMENT.test(value)) throw new Error(`${name} must not contain sensitive assignments`);
  return value;
}

function validIsoTime(value: unknown, name: string): number {
  const parsed = Date.parse(text(value, name));
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an ISO timestamp`);
  return parsed;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function recordPayload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
  if (payload.content_ref !== undefined) delete payload.content;
  return payload;
}

export class KnowledgeClaimGovernance {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  knowledgeSessionEvidenceRecord(args: JsonObject): JsonObject { return recordKnowledgeSessionEvidence(this.store, args); }
  knowledgeClaimSave(args: JsonObject): JsonObject {
    const kind = text(args.kind, "kind"); if (!KNOWLEDGE_KINDS.has(kind)) throw new Error("Knowledge claim kind is unsupported");
    const content = assertNoSecret(document(args.content, "content"), "content"); const scope = text(args.scope, "scope");
    const evidenceIds = uniqueTextArray(args.evidence_ids, "evidence_ids"); evidenceIds.forEach((item) => this.store.get("evidence", item));
    const tags = optionalTextArray(args.tags, "tags"); const validUntil = args.valid_until === undefined ? null : new Date(validIsoTime(args.valid_until, "valid_until")).toISOString();
    const claimId = String(args.claim_id ?? id("knowledge_claim")); const existing = this.store.find("knowledge_claim", claimId);
    const contentDigest = valueDigest(content);
    const title = args.title === undefined ? undefined : assertNoSecret(text(args.title, "title"), "title");
    // The source is part of a claim's identity and must survive outside its Markdown
    // reference.  Otherwise a source revocation cannot stop an already-reviewed claim from
    // entering Context after a database reload or bundle import.
    const sourceId = String(args.source_id ?? "builtin.evidence-wiki");
    const envelope = scopeEnvelope(args.scope_envelope, scopeFromKey(scope));
    const scenarioKey = args.scenario_key === undefined ? undefined : text(args.scenario_key, "scenario_key");
    const coarseScenarioKey = args.coarse_scenario_key === undefined ? undefined : text(args.coarse_scenario_key, "coarse_scenario_key");
    const scenarioDefinition = validateKnowledgeScenarioDefinition(args.scenario_definition);
    const coarseScenarioDefinition = validateKnowledgeScenarioDefinition(args.coarse_scenario_definition);
    if (coarseScenarioDefinition && !coarseScenarioKey) throw new Error("coarse scenario definition requires coarse_scenario_key");
    if (coarseScenarioKey && !scenarioKey) throw new Error("coarse_scenario_key requires scenario_key");
    const scenarioScope = scopeFromKey(scope);
    if ((scenarioKey || coarseScenarioKey) && scenarioScope.kind !== "project" && scenarioScope.kind !== "global") {
      throw new Error("Knowledge scenario classification requires project or global scope");
    }
    const scenarioScopeKind = scenarioScope.kind === "global" ? "global" : "project";
    if ((scenarioKey && !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(scenarioKey)) || (coarseScenarioKey && !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(coarseScenarioKey))
      || scenarioKey !== undefined && scenarioKey === coarseScenarioKey) throw new Error("Knowledge scenario keys must be distinct bounded stable identifiers");
    const knowledgeDir = knowledgeDirectoryForScope(this.store, scope, {
      ...(typeof args.project_root === "string" ? { project_root: args.project_root } : {}),
      ...(typeof (existing?.content_ref as JsonObject | undefined)?.path === "string" ? { reference_path: String((existing!.content_ref as JsonObject).path) } : {}),
    });
    if (scenarioKey && !knowledgeScenarioCanClassify(knowledgeDir, scenarioScope.id, scenarioKey, scenarioScopeKind)
      || coarseScenarioKey && !knowledgeScenarioCanClassify(knowledgeDir, scenarioScope.id, coarseScenarioKey, scenarioScopeKind)) {
      throw new Error("Knowledge scenario is conflicted or retired and cannot receive classifications");
    }
    const identity = { kind, content_digest: contentDigest, scope, scope_envelope: envelope, source_id: sourceId, evidence_ids: evidenceIds, tags, valid_until: validUntil, ...(title ? { title } : {}) };
    if (existing) {
      // v0.12.33 claims did not persist source_id in their identity.  Keep a
      // one-way compatibility match so a previously completed import remains
      // idempotent; it does not make the legacy record eligible for a newly
      // revoked external Source, because it still resolves as the built-in
      // source until a reviewed migration explicitly re-attributes it.
      const legacyIdentity = { kind, content_digest: contentDigest, scope, source_id: sourceId, evidence_ids: evidenceIds, tags, valid_until: validUntil, ...(title ? { title } : {}) };
      const olderIdentity = { kind, content_digest: contentDigest, scope, evidence_ids: evidenceIds, tags, valid_until: validUntil, ...(title ? { title } : {}) };
      const classifiedIdentity = { ...identity, ...(scenarioKey ? { scenario_key: scenarioKey } : {}), ...(coarseScenarioKey ? { coarse_scenario_key: coarseScenarioKey } : {}) };
      // Source-ingested Claims use a stronger Source Revision/Document/Fragment identity digest.
      // Allow only an exact match of the currently persisted claim fields so a classifier can add
      // scenario metadata without replacing that provenance identity or the review decision.
      const currentClaimIdentity = { kind: existing.kind, content_digest: existing.content_digest, scope: existing.scope,
        scope_envelope: existing.scope_envelope, source_id: existing.source_id,
        evidence_ids: Array.isArray(existing.evidence_ids) ? existing.evidence_ids : [],
        tags: Array.isArray(existing.tags) ? existing.tags : [], valid_until: existing.valid_until ?? null,
        ...(typeof existing.title === "string" ? { title: existing.title } : {}) };
      let ingestedBodyMatches = false;
      if (existing.ingest_generated === true && existing.content_ref) {
        try {
          ingestedBodyMatches = this.store.contentStore.readCompatSync(existing.content_ref as never, typeof existing.scope === "string" ? existing.scope : undefined).body === content
            && existing.content_digest === rawContentDigest(content);
        } catch { /* A missing or invalid protected body cannot authorize a classification write. */ }
      }
      const ingestedIdentity = { ...identity, content_digest: existing.content_digest };
      const exactIngestedClaim = ingestedBodyMatches && existing.ingest_generated === true
        && valueDigest(ingestedIdentity) === valueDigest(currentClaimIdentity);
      if (existing.identity_digest !== valueDigest(identity) && existing.identity_digest !== valueDigest(classifiedIdentity)
        && existing.identity_digest !== valueDigest(legacyIdentity) && existing.identity_digest !== valueDigest(olderIdentity) && !exactIngestedClaim) {
        throw new Error("Knowledge claim idempotency conflict");
      }
      let saved = existing;
      let previousScenarioCatalog: JsonObject | null = null;
      if (scenarioKey && (existing.scenario_key !== scenarioKey || (existing.coarse_scenario_key ?? null) !== (coarseScenarioKey ?? null))) {
        if (typeof existing.scenario_key === "string") previousScenarioCatalog = updateKnowledgeScenarioClaim(knowledgeDir, existing, "inactive");
        saved = this.store.save("knowledge_claim", String(existing.id), { ...recordPayload(existing), scenario_key: scenarioKey,
          ...(coarseScenarioKey ? { coarse_scenario_key: coarseScenarioKey } : { coarse_scenario_key: null }) });
      }
      const scenarioCatalog = updateKnowledgeScenarioClaim(knowledgeDir, { ...saved,
        ...(scenarioDefinition ? { scenario_definition: scenarioDefinition } : {}), ...(coarseScenarioDefinition ? { coarse_scenario_definition: coarseScenarioDefinition } : {}) });
      return { claim: saved, idempotent: saved === existing, ...(scenarioCatalog ? { scenario_catalog: scenarioCatalog } : {}),
        ...(previousScenarioCatalog ? { previous_scenario_catalog: previousScenarioCatalog } : {}) };
    }
    const contentRef = this.store.contentStore.writeSync({ kind: "knowledge", record_id: claimId, version: 1, scope, status: "candidate", sensitivity: "internal", source_id: sourceId, title, body: content,
      ...(typeof args.project_root === "string" ? { project_root: args.project_root } : {}) });
    const claim = this.store.create("knowledge_claim", claimId, { ...identity, ...(scenarioKey ? { scenario_key: scenarioKey } : {}),
      ...(coarseScenarioKey ? { coarse_scenario_key: coarseScenarioKey } : {}), content_ref: contentRef, identity_digest: valueDigest(identity), status: "candidate", review: null });
    const scenarioCatalog = updateKnowledgeScenarioClaim(knowledgeDir, { ...claim,
      ...(scenarioDefinition ? { scenario_definition: scenarioDefinition } : {}), ...(coarseScenarioDefinition ? { coarse_scenario_definition: coarseScenarioDefinition } : {}) });
    return { claim, idempotent: false, ...(scenarioCatalog ? { scenario_catalog: scenarioCatalog } : {}) };
  }
  knowledgeClaimGet(args: JsonObject): JsonObject {
    const id = text(args.claim_id, "claim_id");
    const current = this.store.get("knowledge_claim", id);
    if (!claimReadable(this.store, current, args)) throw new Error("Knowledge claim scope or audience denied");
    const claim = args.version === undefined ? current : this.store.get("knowledge_claim", id, finiteInteger(args.version, "version", 1));
    if (!claimReadable(this.store, claim, args) || claim.scope !== current.scope) throw new Error("Knowledge claim historical scope or audience denied");
    return { claim };
  }
  knowledgeClaimList(args: JsonObject): JsonObject {
    const query = String(args.query ?? "").toLowerCase();
    const hydrated = new Map<string, JsonObject>();
    const selected = this.store.list("knowledge_claim", finiteInteger(args.limit, "limit", 20, 1, 1_000), claim => {
      if (!claimReadable(this.store, claim, args)) return false;
      const material = this.store.get("knowledge_claim", String(claim.id), Number(claim.version));
      if (query && !JSON.stringify(material).toLowerCase().includes(query)) return false;
      hydrated.set(String(claim.id), material); return true;
    }, false);
    return { claims: selected.map(claim => hydrated.get(String(claim.id))!) };
  }
  knowledgeClaimReview(args: JsonObject): JsonObject {
    const claim = this.store.get("knowledge_claim", text(args.claim_id, "claim_id")); const status = text(args.status, "status");
    if (status === "reviewed") throw new Error("Formal Knowledge promotion requires managed Host review and independent effectiveness evaluation");
    if (!KNOWLEDGE_REVIEW_EXIT_STATUSES.has(status)) throw new Error("Knowledge claim review status is unsupported");
    const reviewer = text(args.reviewer, "reviewer"); const reason = assertNoSecret(document(args.reason, "reason"), "reason");
    const saved = this.store.save("knowledge_claim", String(claim.id), { ...recordPayload(claim), status,
      review: { reviewer, reason_digest: valueDigest(reason), reviewed_at: new Date().toISOString() } });
    const scenarioCatalog = updateKnowledgeScenarioClaim(knowledgeDirectoryForScope(this.store, String(claim.scope ?? "global"), {
      ...((claim.content_ref as JsonObject | undefined)?.path ? { reference_path: String((claim.content_ref as JsonObject).path) } : {}),
    }), saved);
    return { claim: saved, ...(scenarioCatalog ? { scenario_catalog: scenarioCatalog } : {}) };
  }
  synchronize(args: JsonObject = {}): JsonObject {
    const now = new Date(args.now === undefined ? Date.now() : text(args.now, "now"));
    if (!Number.isFinite(now.valueOf())) throw new Error("now must be an ISO timestamp");
    const affected: JsonObject[] = [];
    const dependencies = { source_ids: optionalTextArray(args.source_ids, "source_ids"), document_ids: optionalTextArray(args.document_ids, "document_ids") };
    const contradictions = new Set(this.store.list("knowledge_relation", 100_000, relation => relation.relation === "contradicts" && relation.valid_to === null && ["bounded", "confirmed"].includes(String(relation.confidence)), false).flatMap(relation => [relation.source, relation.target] as JsonObject[]).filter(ref => ref.kind === "knowledge_claim").map(ref => String(ref.id)));
    for (const claim of this.store.list("knowledge_claim", 100_000, item => item.status === "reviewed", false, dependencies)) {
      const source = this.store.find("knowledge_source", String(claim.source_id));
      const document = claim.document_id ? this.store.find("knowledge_document", String(claim.document_id)) : null;
      const status = claim.valid_until && Date.parse(String(claim.valid_until)) < now.valueOf() ? "expired"
        : !source || source.status !== "active" || source.trust === "untrusted" || (claim.review as JsonObject | null)?.source_digest !== undefined && (claim.review as JsonObject).source_digest !== source.content_digest
          || claim.document_id && (!document || document.status !== "current" || document.content_digest !== claim.document_digest) ? "stale"
        : contradictions.has(String(claim.id)) ? "disputed" : null;
      if (status) {
        const saved = this.store.save("knowledge_claim", String(claim.id), { ...recordPayload(claim), status, revalidation_required: true, synchronization_at: now.toISOString() });
        updateKnowledgeScenarioClaim(knowledgeDirectoryForScope(this.store, String(saved.scope ?? "global"), {
          ...((saved.content_ref as JsonObject | undefined)?.path ? { reference_path: String((saved.content_ref as JsonObject).path) } : {}),
        }), saved, "inactive");
        affected.push(saved);
      }
    }
    return { affected, count: affected.length, now: now.toISOString() };
  }

}
