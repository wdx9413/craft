import { CraftStore, type JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { contextFeedbackWeights } from "../../core/context-feedback-weight.ts";

function limit(value: unknown): number {
  const result = value === undefined ? 50 : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 100) throw new Error("limit must be an integer between 1 and 100");
  return result;
}

function pick(record: JsonObject, fields: string[]): JsonObject {
  return Object.fromEntries(fields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]));
}

/** A bounded, read-only projection for the Workbench knowledge screen. */
export class KnowledgeWorkbenchKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  view(args: JsonObject = {}): JsonObject {
    const max = limit(args.limit);
    const scope = typeof args.scope === "string" && args.scope ? args.scope : "global";
    const scoped = (kind: string) => this.store.list(kind, 10_000, undefined, true, undefined, scope);
    const claims = scoped("knowledge_claim");
    const pages = scoped("wiki_page");
    const bundles = scoped("wiki_context_bundle");
    const candidates = scoped("wiki_skill_candidate");
    const evaluations = scoped("knowledge_evaluation_run");
    const packages = scoped("wiki_candidate_publication_package");
    const claimById = new Map(claims.map((claim) => [String(claim.id), claim]));
    const feedback = contextFeedbackWeights(this.store, "knowledge", claims.map((claim) => String(claim.id)));
    const conflicts = this.store.list("knowledge_relation", 10_000, (relation) => relation.relation === "contradicts", true, undefined, scope).map((relation) => ({
      ...pick(relation, ["id", "from_claim_id", "to_claim_id", "relation", "created_at"]),
      from_status: claimById.get(String(relation.from_claim_id))?.status ?? "missing",
      to_status: claimById.get(String(relation.to_claim_id))?.status ?? "missing",
    }));
    const launches = this.store.list("work_launch", 10_000, (launch) => {
      if (launch.knowledge_binding === undefined) return false;
      const bindingScope = (launch.knowledge_binding as JsonObject).scope;
      if (typeof bindingScope === "string") return bindingScope === scope || scope === "global" && bindingScope === "user:local";
      if (!bindingScope || typeof bindingScope !== "object") return scope === "global";
      const parts = bindingScope as JsonObject;
      const key = parts.kind === "global" ? "global"
        : typeof parts.kind === "string" && typeof parts.id === "string"
          ? String(parts.id).indexOf(String(parts.kind) + ":") === 0 ? String(parts.id) : `${String(parts.kind)}:${String(parts.id)}`
          : "";
      return key === scope || scope === "global" && key === "user:local";
    }, true, undefined, scope).map((launch) => ({
      ...pick(launch, ["id", "task_id", "host", "workspace", "status", "updated_at"]),
      knowledge_binding: pick(launch.knowledge_binding as JsonObject, ["bundle_id", "bundle_version", "bundle_digest", "context_digest", "scope", "claim_refs"]),
    }));
    return {
      summary: {
        claims: claims.length,
        reviewed_claims: claims.filter((claim) => claim.status === "reviewed").length,
        pages: pages.length,
        bundles: bundles.length,
        conflicts: conflicts.length,
        candidates: candidates.length,
        evaluations: evaluations.length,
        publication_packages: packages.length,
        knowledge_bound_launches: launches.length,
      },
      // The weight is the same number the recall path ranks with, so "which
      // claims proved useful" is visible instead of only affecting ordering.
      claims: claims.slice(0, max).map((claim) => {
        const weight = feedback.get(String(claim.id));
        return { ...pick(claim, ["id", "version", "kind", "content", "scope", "evidence_ids", "tags", "valid_until", "status", "review", "proposed_by", "updated_at"]),
          recall_weight: weight?.weight ?? 1, helpful_signals: weight?.positive ?? 0, pending_corrections: weight?.negative ?? 0 };
      }),
      pages: pages.slice(0, max).map((page) => pick(page, ["id", "version", "title", "scope", "claim_ids", "body_digest", "revision_source", "updated_at"])),
      bundles: bundles.slice(0, max).map((bundle) => pick(bundle, ["id", "version", "query", "scope", "max_items", "max_chars", "context_digest", "claim_refs", "excluded", "used_chars", "updated_at"])),
      conflicts: conflicts.slice(0, max),
      candidates: candidates.slice(0, max).map((candidate) => pick(candidate, ["id", "version", "title", "kind", "status", "claim_refs", "evaluation_attestation_id", "publication_authorization_id", "publication_allowed", "execution_authority", "review", "updated_at"])),
      publication_packages: packages.slice(0, max).map((packageRecord) => pick(packageRecord, ["id", "version", "candidate_id", "candidate_version", "authorization_id", "target_host", "package_format", "content_digest", "manual_import_required", "execution_authority", "status", "updated_at"])),
      evaluations: evaluations.slice(0, max).map((run) => pick(run, ["id", "version", "status", "suite_id", "split", "summary", "updated_at"])),
      knowledge_bound_launches: launches.slice(0, max),
    };
  }
}
