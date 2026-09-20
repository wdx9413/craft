/**
 * The Experience read side: **which** compiled experience applies, never **what it says**.
 *
 * This is the constraint that shapes the whole file, and it is not a policy choice — it is what
 * the ledger's data model permits. `compile` stores
 * `hypothesis_digest` / `applicability_digest` / `counterexample_digest` and records
 * `content_free: true`; the prose a compiler wrote is **never persisted**. Every pattern also
 * carries `status: "diagnostic_only"` and `execution_visible: false`, and `craft_experience_ledger_compile`
 * says of itself: *"execution Hosts never receive it directly."*
 *
 * So a contribution that handed a Host "the proven strategy" is not merely disallowed, it is
 * impossible: there is no text to hand over. What a contribution *can* honestly say is that
 * compiled experience exists for this scenario, at which version, of which kind, backed by how
 * many independent observations, and whether anything for it has reached Signoff — which is
 * exactly what a routing policy needs in order to decide to consult the ledger through a governed
 * path.
 *
 * That is why every item this provider returns is a reference and a statement about provenance.
 * A test asserts that no item carries a `hypothesis`, `applicability` or `counterexample` field,
 * because the way this file could go wrong is by growing one.
 */
import type { ContextRequest, ContextContribution, ContextContributionProvider } from "../../src/capability-protocol.ts";
import type { CraftStore, JsonObject } from "../../src/infrastructure/store.ts";

/** Tokenize a query the same way `ContextResolutionKernel.resolve` does, so matching agrees. */
function terms(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

export class ExperienceContribution implements ContextContributionProvider {
  readonly member = "experience" as const;
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Select the patterns that mention this query, bounded, and described only by provenance.
   *
   * Matching is on `scenario_key`, because that is the only handle a pattern has: a pattern is
 * keyed by the scenario and its source scope.  Older unscoped patterns remain diagnostic
 * records, but cannot enter a Host Context: pretending an unknown scope matched the current
 * project would create exactly the cross-project memory leak the Context boundary prevents.
   */
  async contribute(request: ContextRequest): Promise<ContextContribution> {
    const wanted = terms(request.query);
    const patterns = this.store.list("experience_pattern", 10_000)
      .map((pattern) => ({
        pattern,
        // A scenario is a match when any query term appears in its key. Deliberately loose: this
        // decides what to *point at*, and the consumer reads the record before acting on it.
        score: pattern.scope && (pattern.scope as JsonObject).kind === request.scope_kind && (pattern.scope as JsonObject).id === request.scope_id
          ? wanted.reduce((sum, term) => sum + Number(String(pattern.scenario_key).toLowerCase().includes(term)), 0)
          : 0,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || String(left.pattern.id).localeCompare(String(right.pattern.id)));

    const items: JsonObject[] = [];
    let usedChars = 0;
    for (const candidate of patterns) {
      if (items.length >= request.max_items) break;
      const item = this.describe(candidate.pattern);
      const size = JSON.stringify(item).length;
      // The budget is respected by stopping, not by truncating an item: a partial reference would
      // be a reference that does not resolve.
      if (usedChars + size > request.max_chars) break;
      usedChars += size;
      items.push(item);
    }

    return {
      member: this.member,
      items,
      // Content-free and reproducible: a digest of what was selected, so replaying the same
      // resolution produces the same receipt without the receipt holding the query.
      receipt_id: `experience_contribution_${items.map((item) => `${String(item.pattern_id)}@${String(item.pattern_version)}`).join("+") || "none"}`,
      omitted_count: patterns.length - items.length,
    };
  }

  /** One pattern, as a reference plus its provenance. No hypothesis, no applicability, no prose. */
  private describe(pattern: JsonObject): JsonObject {
    const observations = (pattern.observation_refs as JsonObject[] | undefined) ?? [];
    const evidence = (pattern.evidence_ids as string[] | undefined) ?? [];
    const accepted = this.store.list("experience_intervention", 10_000, (intervention) =>
      intervention.lifecycle === "accepted"
      && (intervention.pattern_refs as JsonObject[]).some((ref) => ref.id === pattern.id && Number(ref.version) === Number(pattern.version)));
    return {
      kind: "experience_pattern",
      pattern_id: String(pattern.id),
      pattern_version: Number(pattern.version),
      scenario_key: String(pattern.scenario_key),
      pattern_kind: String(pattern.kind),
      // The digests travel; the text they digest does not exist in Craft at all.
      hypothesis_digest: pattern.hypothesis_digest,
      applicability_digest: pattern.applicability_digest,
      observation_count: observations.length,
      evidence_count: evidence.length,
      status: String(pattern.status),
      // Read from the record rather than asserted here: if the ledger ever marks a pattern
      // execution-visible, this reflects it instead of contradicting it.
      execution_visible: pattern.execution_visible === true,
      // What a consumer needs to decide whether to route through a governed path.
      accepted_intervention_ids: accepted.map((intervention) => String(intervention.id)).sort(),
      requires_governed_route: true,
    };
  }
}
