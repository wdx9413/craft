import { ProcedureDefinitionStore, procedureDefinitionRef } from "./procedure-definition.ts";
import { observeOperation } from "../../common/craft-common-log/src/index.ts";
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
import type { ContextRequest, ContextContribution, ContextContributionProvider } from "../../common/craft-common-base/src/capability-protocol.ts";
import { contextFeedbackWeights } from "../../core/context-feedback-weight.ts";
import { experienceGatePenalty } from "./gate-signals.ts";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { scopeAllows, scopeEnvelope, type ScopeAccess } from "../../common/craft-common-base/src/scope-policy.ts";
import { activeProcedure } from "./procedure-release.ts";
import { retrievalTerms } from "../../common/craft-common-base/src/retrieval-terms.ts";
import { contextAssetMatches, contextAssetRef } from "../../common/craft-common-base/src/context-assets.ts";

/** Tokenize a query the same way `ContextResolutionKernel.resolve` does, so matching agrees. */
function terms(query: string): string[] {
  return retrievalTerms(query);
}

function recordScope(value: unknown): { kind: string; id: string } {
  const [kind, ...rest] = String(value).split(":");
  return { kind, id: rest.join(":") };
}

function scopeKey(scope: { kind: string; id: string }): string {
  return scope.id.startsWith(`${scope.kind}:`) ? scope.id : `${scope.kind}:${scope.id}`;
}

function matchesScope(stored: unknown, scope: { kind: string; id: string }): boolean {
  return stored === scopeKey(scope) || stored === `${scope.kind}:${scope.id}`;
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
    return observeOperation(this.store, "experience", "contribute", request, () => this.readContribution(request));
  }

  private async readContribution(request: ContextRequest): Promise<ContextContribution> {
    const wanted = terms(request.query);
    const scopes = request.scope_stack ?? [{ kind: request.scope_kind, id: request.scope_id }];
    const access: ScopeAccess = { principal_id: request.principal_id, principal_ids: request.principal_ids, tenant_id: request.tenant_id, purpose: request.cognitive_purpose };
    // Filter the complete collection before applying the candidate cap. Store.list
    // still scans all records; unrelated projects must not consume this scope's budget.
    const scoped = this.store.listScoped("experience_procedure", scopes, 10_001, procedure =>
      scopes.some(scope => matchesScope(procedure.scope, scope))
      && scopeAllows(scopeEnvelope(procedure.scope_envelope, recordScope(procedure.scope)), access));
    const hasDraft = this.store.listScoped("experience_graph_draft", scopes, 1, draft =>
      scopes.some(scope => matchesScope(draft.scope, scope))
      && scopeAllows(scopeEnvelope(draft.scope_envelope, recordScope(draft.scope)), access)).length > 0;
    const eligible = scoped.map(latest => activeProcedure(this.store, String(latest.id))).filter((item): item is JsonObject => item !== null);
    if (eligible.length > 10_000) throw new Error("Experience candidate budget exceeded; narrow the scope stack");
    const descriptions = new Map(eligible.map(procedure => [String(procedure.id), this.describe(procedure)]));
    const feedback = contextFeedbackWeights(this.store, "experience", eligible.map(procedure => String(procedure.id)));
    const gatePenalty = experienceGatePenalty(this.store, eligible.map(procedure => String(procedure.id)));
    const isRequired = (procedure: JsonObject) => (request.required_refs ?? []).some(ref => {
      const description = descriptions.get(String(procedure.id));
      return Boolean(description && contextAssetMatches(ref, contextAssetRef("experience", description, description.scope as JsonObject)));
    });
    const procedures = eligible
      .map((procedure) => {
        const weight = feedback.get(String(procedure.id))!.weight * gatePenalty.get(String(procedure.id))!;
        const score = wanted.reduce((sum, term) => sum + Number(String(descriptions.get(String(procedure.id))!.retrieval_text).toLowerCase().includes(term)), 0);
        return { procedure, weight, score: (score + Number(request.candidate_mode === true)) * weight };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => Number(isRequired(right.procedure)) - Number(isRequired(left.procedure)) || right.score - left.score || String(left.procedure.id).localeCompare(String(right.procedure.id)));

    const selected: Array<{ item: JsonObject; reference: string }> = procedures
      .map((candidate) => ({ item: { ...descriptions.get(String(candidate.procedure.id))!, ranking_weight: candidate.weight },
        reference: `procedure:${String(candidate.procedure.id)}@${Number(candidate.procedure.version)}` }));
    const items: JsonObject[] = [];
    let usedChars = 0;
    const selectedReferences: string[] = [];
    for (const candidate of selected) {
      if (items.length >= request.max_items) break;
      const size = JSON.stringify(candidate.item).length;
      // The budget is respected by stopping, not by truncating an item: a partial reference would
      // be a reference that does not resolve.
      if (usedChars + size > request.max_chars) continue;
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
      diagnostics: { scoped_procedure_count: scoped.length, has_draft: hasDraft, routeable_count: eligible.length, candidate_count: scoped.filter(p => p.lifecycle === "candidate").length,
        reason: eligible.length ? items.length ? "recalled_not_bound" : "query_or_budget_not_matched" : scoped.length ? "no_promoted_release" : hasDraft ? "draft_not_submitted" : "no_accessible_procedure_in_scope",
        next_tool: "craft_experience_graph_inspect", next_action: "diagnose", execution_started: false },
    };
  }

  /** The Gate state makes the Procedure projection safe for this bounded Context. */
  private describe(procedure: JsonObject): JsonObject {
    const definition = procedure.procedure_kind === "graph" && procedureDefinitionRef(procedure.definition_ref)
      ? new ProcedureDefinitionStore(this.store).read(procedure.definition_ref).definition : null;
    const control = definition?.graph_control as JsonObject | undefined;
    const routes = Array.isArray(control?.subscenarios) ? (control.subscenarios as JsonObject[]).map(s => ({ id: s.id, title: s.title, entry_id: s.entry_id, exit_id: s.exit_id })) : [];
    return {
      kind: "experience_procedure",
      scope: recordScope(procedure.scope),
      content_version: procedure.content_version ?? (procedure.definition_ref as JsonObject | undefined)?.procedure_version ?? procedure.version,
      procedure_id: String(procedure.id),
      procedure_version: Number(procedure.version),
      procedure_kind: String(procedure.procedure_kind),
      trigger: String(procedure.trigger),
      retrieval_text: `${String(procedure.trigger)} ${String(procedure.title)} ${JSON.stringify(procedure.entrypoints ?? [])} ${JSON.stringify(routes)}`,
      ...(Array.isArray(procedure.entrypoints) ? { entrypoints: procedure.entrypoints } : {}),
      acceptance_ref: String(procedure.acceptance_ref),
      scenario_signature: procedure.scenario_signature,
      content_digest: procedure.content_digest,
      // A Context contribution is a routeable pointer, never an instruction
      // payload.  A Host must explicitly materialize a procedure under its
      // Task/Policy receipt before it can read the checked body or definition.
      definition_digest: procedure.definition_digest ?? null,
      routeable: true,
      host_next_step: procedure.procedure_kind === "graph" ? "match_graph_then_plan_and_bind" : "select_entry_exit_then_plan_and_bind",
      execution_started: false,
    };
  }

}
