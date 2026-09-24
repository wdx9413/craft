/**
 * The governed Knowledge read side.
 *
 * Knowledge is eligible for a Host context only after review.  A search may show a
 * candidate to a person for diagnosis, but a candidate is not an instruction for
 * an execution Host.  Keeping that distinction here prevents an import or a
 * draft Wiki page from silently changing future behaviour.
 */
import type { ContextContribution, ContextContributionProvider, ContextRequest } from "../../core/capability-protocol.ts";
import type { CraftStore, JsonObject } from "../../core/infrastructure/store.ts";
import { contentReference } from "../../core/infrastructure/content-store.ts";
import { scopeAllows, scopeEnvelope, type ScopeAccess } from "../../core/scope-policy.ts";

function terms(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function recordScope(value: unknown): { kind: string; id: string } {
  if (value === "global") return { kind: "global", id: "global" };
  const [kind, ...rest] = String(value ?? "").split(":");
  return { kind: kind || "project", id: rest.join(":") || "unresolved" };
}

function scopeMatches(claimScope: unknown, request: ContextRequest, projectAliases: readonly string[]): boolean {
  const scopes = request.scope_stack ?? [{ kind: request.scope_kind, id: request.scope_id }];
  return scopes.some((scope) => claimScope === `${scope.kind}:${scope.id}` || claimScope === "global" && scope.kind === "global") || request.scope_kind === "project" && projectAliases.includes(String(claimScope));
}

function access(request: ContextRequest): ScopeAccess {
  return { principal_id: request.principal_id, principal_ids: request.principal_ids, tenant_id: request.tenant_id, purpose: request.cognitive_purpose };
}

/** A small, receipt-bearing projection of reviewed evidence-backed claims. */
export class KnowledgeContribution implements ContextContributionProvider {
  readonly member = "knowledge" as const;
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  async contribute(request: ContextRequest): Promise<ContextContribution> {
    const wanted = terms(request.query);
    const now = Date.now();
    // A reviewed claim is not automatically trustworthy merely because its review record
    // exists.  Sources can be revoked after review; Context must fail closed in that case.
    const sources = new Map(this.store.list("knowledge_source", 10_000).map((source) => [String(source.id), source]));
    const projectAliases = request.scope_kind === "project"
      ? this.store.list("scope_alias", 10_000, (alias) => alias.status === "active" && JSON.stringify(alias.scope) === JSON.stringify({ kind: "project", id: request.scope_id }))
        .map((alias) => `project:${String(alias.alias)}`)
      : [];
    const matches = this.store.list("knowledge_claim", 10_000)
      .flatMap((claim) => {
        const claimScope = String(claim.scope ?? "");
        const applicability = recordScope(claimScope);
        if (claim.status !== "reviewed" || !scopeMatches(claim.scope, request, projectAliases) || !scopeAllows(scopeEnvelope(claim.scope_envelope, applicability), access(request))
          || claim.valid_until !== null && claim.valid_until !== undefined && Date.parse(String(claim.valid_until)) < now) return [];
        // Legacy records without a persisted source cannot become execution Context
        // merely because an old Markdown frontmatter happened to name one.  The
        // database record is the governed authority.  Fresh claims always persist
        // `source_id`; imported claims must be revalidated/re-attributed first.
        const sourceId = typeof claim.source_id === "string" ? claim.source_id : null;
        if (!sourceId) return [];
        const source = sources.get(sourceId);
        if (source && (source.status !== "active" || source.trust === "untrusted")) return [];
        // A missing explicit source is never silently treated as trusted.  The built-in
        // Evidence Wiki remains backwards-compatible because it is installed locally by
        // Craft and does not represent an external trust assertion.
        if (!source) return [];
        const content = this.content(claim);
        const haystack = `${content} ${Array.isArray(claim.tags) ? claim.tags.join(" ") : ""}`.toLowerCase();
        const score = wanted.reduce((total, term) => total + Number(haystack.includes(term)), 0);
        return score > 0 ? [{ claim, content, score }] : [];
      })
      .sort((left, right) => right.score - left.score || String(left.claim.id).localeCompare(String(right.claim.id)));

    const items: JsonObject[] = [];
    let usedChars = 0;
    for (const match of matches) {
      if (items.length >= request.max_items) break;
      const item = {
        kind: "knowledge_claim",
        claim_id: match.claim.id,
        claim_version: match.claim.version,
        content: match.content,
        content_digest: match.claim.content_digest,
        evidence_ids: match.claim.evidence_ids,
        source_id: match.claim.source_id,
        reason: "reviewed_keyword_overlap",
      } satisfies JsonObject;
      const size = JSON.stringify(item).length;
      if (usedChars + size > request.max_chars) break;
      usedChars += size;
      items.push(item);
    }
    return {
      member: this.member,
      items,
      receipt_id: `knowledge_contribution_${items.map((item) => `${String(item.claim_id)}@${String(item.claim_version)}`).join("+") || "none"}`,
      omitted_count: matches.length - items.length,
    };
  }

  private content(claim: JsonObject): string {
    if (typeof claim.content === "string") return claim.content;
    if (!contentReference(claim.content_ref)) throw new Error("Knowledge content reference is missing");
    return this.store.contentStore.readCompatSync(claim.content_ref).body;
  }
}
