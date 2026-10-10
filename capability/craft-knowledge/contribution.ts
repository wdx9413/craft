import { observeOperation } from "../../common/craft-common-log/src/index.ts";
/**
 * The governed Knowledge read side.
 *
 * Knowledge is eligible for a Host context only after review.  A search may show a
 * candidate to a person for diagnosis, but a candidate is not an instruction for
 * an execution Host.  Keeping that distinction here prevents an import or a
 * draft Wiki page from silently changing future behaviour.
 */
import type { ContextContribution, ContextContributionProvider, ContextRequest } from "../../common/craft-common-base/src/capability-protocol.ts";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { ContextReadGuard, type ContextReadRef } from "../../common/craft-common-store-local/src/context-access-guard.ts";
import { contentReference } from "../../common/craft-common-store-local/src/content-store.ts";
import { scopeAllows, scopeEnvelope, sourceAllows, type ScopeAccess } from "../../common/craft-common-base/src/scope-policy.ts";
import { KeywordRetrievalPort } from "../../common/craft-common-base/src/keyword-retrieval.ts";

function recordScope(value: unknown): { kind: string; id: string } {
  if (value === "global") return { kind: "global", id: "global" };
  const [kind, ...rest] = String(value).split(":");
  return { kind, id: rest.join(":") };
}

function scopeMatches(claimScope: unknown, request: ContextRequest, projectAliases: readonly string[]): boolean {
  const scopes = request.scope_stack ?? [{ kind: request.scope_kind, id: request.scope_id }];
  return scopes.some((scope) => claimScope === `${scope.kind}:${scope.id}` || claimScope === "global" && scope.kind === "global") || request.scope_kind === "project" && projectAliases.includes(String(claimScope));
}

function access(request: ContextRequest): ScopeAccess {
  return { principal_id: request.principal_id, principal_ids: request.principal_ids, tenant_id: request.tenant_id, purpose: request.cognitive_purpose };
}

function validAt(value: unknown, now: number): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;
  const expiry = Date.parse(value);
  return Number.isFinite(expiry) && expiry >= now;
}

/** A small, receipt-bearing projection of reviewed evidence-backed claims. */
export class KnowledgeContribution implements ContextContributionProvider {
  readonly member = "knowledge" as const;
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  async contribute(request: ContextRequest): Promise<ContextContribution> {
    return observeOperation(this.store, "knowledge", "contribute", request, () => this.readContribution(request));
  }

  private async readContribution(request: ContextRequest): Promise<ContextContribution> {
    return this.search(request, false);
  }

  async search(request: ContextRequest, includeCandidates: boolean): Promise<ContextContribution> {
    const now = request.now === undefined ? Date.now() : Date.parse(request.now);
    if (!Number.isFinite(now)) throw new Error("Knowledge Context now must be a valid timestamp");
    // A reviewed claim is not automatically trustworthy merely because its review record
    // exists.  Sources can be revoked after review; Context must fail closed in that case.
    const sources = new Map<string, JsonObject | null>();
    const dependencies = new Map<string, { source: JsonObject; document: JsonObject | null }>();
    const sourceFor = (sourceId: string): JsonObject | null => {
      if (sources.has(sourceId)) return sources.get(sourceId)!;
      const source = this.store.find("knowledge_source", sourceId);
      if (sources.size < 10_001) sources.set(sourceId, source);
      return source;
    };
    const aliases = request.scope_kind === "project"
      ? this.store.list("scope_alias", 10_001, (alias) => alias.status === "active" && JSON.stringify(alias.scope) === JSON.stringify({ kind: "project", id: request.scope_id }))
      : [];
    const projectAliases = aliases.map(alias => `project:${String(alias.alias)}`);
    if (projectAliases.length > 10_000) throw new Error("Knowledge candidate budget exceeded; narrow project aliases");
    // SQL scope selection and metadata predicates precede content hydration.
    const eligible = this.store.listScoped("knowledge_claim", [...(request.scope_stack ?? [{ kind: request.scope_kind, id: request.scope_id }]), ...projectAliases.map(alias => recordScope(alias))], 10_001, (claim) => {
        const applicability = recordScope(claim.scope);
        if ((claim.status !== "reviewed" && !(includeCandidates && claim.status === "candidate")) || !scopeMatches(claim.scope, request, projectAliases) || !scopeAllows(scopeEnvelope(claim.scope_envelope, applicability), access(request))
          || claim.sensitivity === "restricted" && request.allow_restricted !== true || !validAt(claim.valid_until, now)) return false;
        // Legacy records without a persisted source cannot become execution Context
        // merely because an old Markdown frontmatter happened to name one.  The
        // database record is the governed authority.  Fresh claims always persist
        // `source_id`; imported claims must be revalidated/re-attributed first.
        const sourceId = typeof claim.source_id === "string" ? claim.source_id : null;
        if (!sourceId) return false;
        const source = sourceFor(sourceId);
        if (source && (source.status !== "active" || source.trust === "untrusted")) return false;
        // A missing explicit source is never silently treated as trusted.  The built-in
        // Evidence Wiki remains backwards-compatible because it is installed locally by
        // Craft and does not represent an external trust assertion.
        if (!source || !sourceAllows(source, access(request))) return false;
        if (request.source_ids?.length && !request.source_ids.includes(sourceId)) return false;
        const document = claim.document_id ? this.store.find("knowledge_document", String(claim.document_id)) : null;
        if (claim.document_id && (!document || document.status !== "current" || document.content_digest !== claim.document_digest)) return false;
        const review = claim.review as JsonObject | undefined;
        if (claim.status === "reviewed" && review?.source_digest !== undefined && review.source_digest !== source.content_digest) return false;
        dependencies.set(String(claim.id), { source, document }); return true;
      });
    if (eligible.length > 10_000) throw new Error("Knowledge candidate budget exceeded; narrow scope or source filters");
    // Capture the exact authorized corpus before the first await. Dependencies are
    // revision metadata, so SDK callers share the same read fence as Context.
    const refs: ContextReadRef[] = aliases.map(alias => ({ kind: "scope_alias", id: String(alias.id), version: Number(alias.version) }));
    for (const claim of eligible) {
      refs.push({ kind: "knowledge_claim", id: String(claim.id), version: Number(claim.version) });
      const { source, document } = dependencies.get(String(claim.id))!;
      refs.push({ kind: "knowledge_source", id: String(source.id), version: Number(source.version) });
      if (document) refs.push({ kind: "knowledge_document", id: String(document.id), version: Number(document.version) });
    }
    const guard = new ContextReadGuard(this.store, refs);
    for (const ref of refs) guard.track(ref.kind, ref.id);
    const matches = eligible.map((claim) => {
        const content = this.content(claim);
        const haystack = `${content} ${Array.isArray(claim.tags) ? claim.tags.join(" ") : ""}`.toLowerCase();
        return { claim, content, body: haystack };
      });
    const ranking = await new KeywordRetrievalPort().search(request.query, matches.map(match => ({ id: String(match.claim.id), body: match.body })));
    guard.assertCurrent();
    const scores = new Map(ranking.hits.map(hit => [hit.id, hit.score]));
    const ranked = matches.filter(match => request.candidate_mode || scores.has(String(match.claim.id)))
      .sort((a, b) => (scores.get(String(b.claim.id)) ?? 0) - (scores.get(String(a.claim.id)) ?? 0) || String(a.claim.id).localeCompare(String(b.claim.id)));

    const items: JsonObject[] = [];
    let usedChars = 0;
    for (const match of ranked) {
      if (items.length >= request.max_items) break;
      const item = {
        kind: "knowledge_claim",
        scope: recordScope(match.claim.scope),
        claim_id: match.claim.id,
        claim_version: match.claim.version,
        status: match.claim.status,
        content: match.content,
        retrieval_text: match.body,
        content_digest: match.claim.content_digest,
        evidence_ids: match.claim.evidence_ids,
        source_id: match.claim.source_id,
        reason: match.claim.status === "reviewed" ? "reviewed_bm25" : "candidate_diagnostic_only",
      } satisfies JsonObject;
      const size = JSON.stringify(item).length;
      if (usedChars + size > request.max_chars) continue;
      usedChars += size;
      items.push(item);
    }
    guard.assertCurrent();
    return {
      member: this.member,
      items,
      receipt_id: `knowledge_contribution_${items.map((item) => `${String(item.claim_id)}@${String(item.claim_version)}`).join("+") || "none"}`,
      omitted_count: ranked.length - items.length,
    };
  }

  private content(claim: JsonObject): string {
    if (typeof claim.content === "string") return claim.content;
    if (!contentReference(claim.content_ref)) throw new Error("Knowledge content reference is missing");
    return this.store.contentStore.readCompatSync(claim.content_ref).body;
  }
}
