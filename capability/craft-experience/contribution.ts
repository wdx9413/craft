/**
 * The Experience read side: routeable Procedures are the only Experience material
 * eligible for Context. Workflow and Graph additionally carry their checked JSON
 * definition; Prompt Procedures carry Markdown only.
 *
 * This is the constraint that shapes the whole file, and it is not a policy choice — it is what
 * the ledger's data model permits. `compile` stores
 * `hypothesis_digest` / `applicability_digest` / `counterexample_digest` and records
 * `content_free: true`; the prose a compiler wrote is **never persisted**. Every pattern also
 * carries `status: "diagnostic_only"` and `execution_visible: false`, and `craft_experience_ledger_compile`
 * says of itself: *"execution Hosts never receive it directly."*
 *
 * Diagnostic patterns remain in the Experience ledger for maintenance, evaluation and
 * reconsideration. They are not Context: a model must not mistake a partial diagnosis for a
 * reusable procedure. A procedure becomes usable Context only after shadow, held-out,
 * signoff and canary gates make it routeable.
 */
import type { ContextRequest, ContextContribution, ContextContributionProvider } from "../../core/capability-protocol.ts";
import type { CraftStore, JsonObject } from "../../core/infrastructure/store.ts";
import { scopeAllows, scopeEnvelope, type ScopeAccess } from "../../core/scope-policy.ts";

/** Tokenize a query the same way `ContextResolutionKernel.resolve` does, so matching agrees. */
function terms(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function recordScope(value: unknown): { kind: string; id: string } {
  const [kind, ...rest] = String(value).split(":");
  return { kind, id: rest.join(":") };
}

export class ExperienceContribution implements ContextContributionProvider {
  readonly member = "experience" as const;
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Select routeable Procedures that match this scoped decision point.
   *
   * Matching is deliberately scoped and bounded. Experience is a Context member alongside
   * Knowledge and Memory, but it never reads an unscoped legacy record or a diagnostic pattern.
   */
  async contribute(request: ContextRequest): Promise<ContextContribution> {
    const wanted = terms(request.query);
    const scopes = request.scope_stack ?? [{ kind: request.scope_kind, id: request.scope_id }];
    const access: ScopeAccess = { principal_id: request.principal_id, principal_ids: request.principal_ids, tenant_id: request.tenant_id, purpose: request.cognitive_purpose };
    const procedures = this.store.list("experience_procedure", 10_000)
      .map((procedure) => ({
        procedure,
        score: procedure.lifecycle === "routeable" && procedure.routeable === true && scopes.some((scope) => procedure.scope === `${scope.kind}:${scope.id}`)
          && scopeAllows(scopeEnvelope(procedure.scope_envelope, recordScope(procedure.scope)), access)
          ? wanted.reduce((sum, term) => sum + Number(`${String(procedure.trigger)} ${String(procedure.title)}`.toLowerCase().includes(term)), 0)
          : 0,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || String(left.procedure.id).localeCompare(String(right.procedure.id)));

    const selected: Array<{ item: JsonObject; reference: string }> = procedures
      .map((candidate) => ({ item: this.describe(candidate.procedure), reference: `procedure:${String(candidate.procedure.id)}@${Number(candidate.procedure.version)}` }));
    const items: JsonObject[] = [];
    let usedChars = 0;
    const selectedReferences: string[] = [];
    for (const candidate of selected) {
      if (items.length >= request.max_items) break;
      const size = JSON.stringify(candidate.item).length;
      // The budget is respected by stopping, not by truncating an item: a partial reference would
      // be a reference that does not resolve.
      if (usedChars + size > request.max_chars) break;
      usedChars += size;
      items.push(candidate.item); selectedReferences.push(candidate.reference);
    }

    return {
      member: this.member,
      items,
      // Content-free and reproducible: a digest of what was selected, so replaying the same
      // resolution produces the same receipt without the receipt holding the query.
      receipt_id: `experience_contribution_${selectedReferences.join("+") || "none"}`,
      omitted_count: selected.length - items.length,
    };
  }

  /** The Gate state makes the Procedure projection safe for this bounded Context. */
  private describe(procedure: JsonObject): JsonObject {
    return {
      kind: "experience_procedure",
      procedure_id: String(procedure.id),
      procedure_version: Number(procedure.version),
      procedure_kind: String(procedure.procedure_kind),
      trigger: String(procedure.trigger),
      acceptance_ref: String(procedure.acceptance_ref),
      scenario_signature: procedure.scenario_signature,
      content_digest: procedure.content_digest,
      // A Context contribution is a routeable pointer, never an instruction
      // payload.  A Host must explicitly materialize a procedure under its
      // Task/Policy receipt before it can read the checked body or definition.
      definition_digest: procedure.definition_digest ?? null,
      routeable: true,
    };
  }

}
