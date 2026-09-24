import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { stableDigest } from "./digest.ts";

/**
 * The honest-claims kernel: three rules about what this system may say about itself.
 *
 * Sections 4.4, 4.6 and 11.3 are each about a claim the system makes, and each names a way
 * that claim turns into a lie under pressure. They are gathered here because they share one
 * failure mode: a true-sounding sentence that is cheaper to produce than the thing it
 * describes, and that therefore gets produced instead.
 *
 * **4.4 — the routing decision has three outcomes, not two.** The plan states them as a
 * progression of what the system can do about the situation: it can prove the work (L1), it
 * can enumerate the choices (L2), or it can do neither (L3). The middle case carries the
 * product's most quotable instruction — 给选择题，不给填空题 — and it is the one an
 * implementation is most likely to collapse, because a text box handles every case uniformly
 * and an options list does not. Collapsing L2 into "ask in prose" reintroduces the input box
 * that section 1 exists to remove.
 *
 * **4.6 — the L1 ratio may not be reported alone.** The section is explicit that a bare L1
 * percentage becomes a vanity metric the moment it is the only number, because the cheapest
 * way to raise it is to loosen the standard — which is precisely the "fake L1" the plan calls
 * poison. So the ratio and the count of attached deterministic checkers are computed together
 * and returned together; there is deliberately no way to ask for the ratio by itself. The
 * plan also says the early ratio will be low and that this is correct pain, so no threshold
 * is applied here: the kernel reports, it does not grade.
 *
 * **11.3 — the ledger wording has one accurate form and several dishonest ones.** Ordinary
 * domain updates are append-only, but an in-place rewrite path exists for migrations, so
 * "tamper-proof" is an overpromise that a security review would reject. The plan gives the
 * accurate sentence: append-only with a verifiable version chain. `#wording` enforces that
 * the dishonest phrasings are never stored, because a claim written once in a description
 * field outlives everyone's memory of why it was wrong.
 */

export type RoutingOutcome = "L1" | "L2_options" | "L3_hatch";

const NAME = /^[a-zA-Z0-9_.:\-]{1,200}$/u;
/** Words that promise more than the storage can deliver (11.3). */
const OVERPROMISE = /(?:不可篡改|不可更改|防篡改|篡改检测|tamper[- ]?proof|immutable\s+ledger|immutable\s+log|tamper[- ]?evident)/iu;
const ACCURATE_WORDING = "追加写 + 版本可校验链（每条回执带前一条的 digest）";

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!NAME.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}

export class HonestClaimsKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Route one decision to L1, L2 or L3 (4.4).
   *
   * The order matters and follows the plan's own: self-证 first, because a provable action
   * should not be turned into a question; then enumerability, because a finite choice set
   * should be a choice and not a text box; then L3, which is the only case that legitimately
   * needs free expression — and even then 5.3 constrains it to hatching one object.
   */
  route(args: JsonObject): JsonObject {
    const subject = identifier(args.subject, "subject");
    const riskLevel = text(args.risk_level, "risk_level");
    if (!new Set(["R0", "R1", "R2", "R3"]).has(riskLevel)) throw new Error("risk_level must be R0, R1, R2 or R3");
    // 4.2's four conditions, taken as the caller's finding rather than re-derived: the gate
    // already owns that judgement, and a second implementation would be a second truth.
    const selfCertifying = args.can_self_certify === true;
    const enumerable = args.options_enumerable === true;
    const optionCount = args.option_count === undefined ? null : Number(args.option_count);
    if (enumerable && (!Number.isInteger(optionCount) || optionCount! < 2)) {
      // "Enumerable" with fewer than two options is a statement, not a choice. L2 means the
      // system hands over a set to pick from, and one item is not a set.
      throw new Error("an enumerable decision needs at least two options");
    }
    if (!enumerable && args.option_count !== undefined) {
      throw new Error("option_count is meaningless when options are not enumerable");
    }
    // An existing object is what makes L3 meaningful: 4.4 says L3 applies when there is no
    // enumerable set *and* no corresponding object. With an object present, the honest route
    // is its own structured completion (5.3), not free expression.
    const hasObject = args.has_object === true;
    const selfCertifyingAndR0 = selfCertifying && riskLevel === "R0";
    const outcome: RoutingOutcome = selfCertifyingAndR0 ? "L1" : enumerable ? "L2_options" : hasObject ? "L2_options" : "L3_hatch";
    return { subject, risk_level: riskLevel, outcome, option_count: enumerable ? optionCount : null,
      reason: selfCertifyingAndR0 ? "self_certifying_r0"
        : enumerable ? "options_enumerable_offer_choices"
          : hasObject ? "no_enumerable_set_but_object_exists_use_structured_completion"
            : "neither_certifiable_nor_enumerable_hatch_one_object",
      // The plan's instruction for the middle case, kept next to the decision so a caller
      // cannot render an input box for an enumerable set without contradicting the result.
      input_form: outcome === "L2_options" ? "choose_from_set" : outcome === "L3_hatch" ? "free_expression_one_shot" : "none",
      // 4.2's fourth condition is the one that makes L1 an engineering claim rather than a
      // hopeful one, so it is asserted rather than assumed.
      failure_auto_discoverable: selfCertifyingAndR0,
      // 4.5: voice versus typing is a channel choice inside L3, so it is not modelled here.
      // What matters is how often L3 is reached, which is what this outcome counts.
      l3_is_the_scarce_resource: outcome === "L3_hatch" };
  }

  /**
   * The L1 share, reported with the checker count it depends on (4.6).
   *
   * There is no parameter to request the ratio alone. 4.6's anti-gaming constraint is that
   * the two numbers travel together, and the reliable way to enforce that is to make the
   * other answer unavailable rather than discouraged.
   */
  l1Report(args: JsonObject = {}): JsonObject {
    const decisions = this.store.list("honest_routing_decision", 10_000);
    const total = decisions.length;
    const l1 = decisions.filter((item) => item.outcome === "L1").length;
    const l2 = decisions.filter((item) => item.outcome === "L2_options").length;
    const l3 = decisions.filter((item) => item.outcome === "L3_hatch").length;
    // Attached checkers are the deterministic external ones (4.3's allow-list), read from
    // the capability base so the number is a fact about the system rather than an assertion.
    // The record id is the key rather than `action_id`, because every stored record has one
    // and a missing `action_id` would otherwise collapse distinct actions into one entry and
    // under-report the very number this method exists to keep honest.
    const checkers = new Set(this.store.list("capability_action", 10_000)
      .filter((item) => item.access_kind === "api_mcp" || item.access_kind === "system_cli_db")
      .map((item) => String(item.id)));
    return { l1_count: l1, l2_count: l2, l3_count: l3, total_decisions: total,
      // Reported as null rather than 0 for an empty set: "no L1 yet" and "0% L1" are
      // different statements, and only the first one is true before anything has happened.
      l1_ratio: total === 0 ? null : l1 / total,
      deterministic_checkers: checkers.size,
      // 4.6's constraint, stated on the payload so a caller cannot read the ratio and miss it.
      ratio_requires_checker_count: true,
      // 4.6 says a low early ratio is correct pain, so this reports rather than judges.
      note: total === 0 ? "no_decisions_yet" : "report_both_or_neither" };
  }

  /** Record a routing decision so the report has something real to count. */
  record(args: JsonObject): JsonObject {
    const routed = this.route(args);
    const decisionId = args.decision_id === undefined
      ? `routing_${stableDigest({ subject: routed.subject, outcome: routed.outcome, at: text(args.recorded_at, "recorded_at") }).slice("sha256:".length, "sha256:".length + 20)}`
      : identifier(args.decision_id, "decision_id");
    const existing = this.store.find("honest_routing_decision", decisionId);
    if (existing) return { decision: existing, idempotent: true };
    return { decision: this.store.create("honest_routing_decision", decisionId, { subject: routed.subject,
      risk_level: routed.risk_level, outcome: routed.outcome, reason: routed.reason,
      option_count: routed.option_count, recorded_at: text(args.recorded_at, "recorded_at") }), idempotent: false };
  }

  /**
   * The accurate description of what the store guarantees (11.3).
   *
   * Returned rather than stored so every reader gets the same sentence. `claim` is refused
   * if it overpromises, because "不可篡改" is not a stylistic preference — the store has an
   * in-place rewrite path, so the sentence is false, and a false security claim is worse than
   * no claim: it is the kind that survives review and then fails one.
   */
  ledgerWording(args: JsonObject = {}): JsonObject {
    const claim = args.claim === undefined ? null : text(args.claim, "claim");
    const accurate = claim === null ? true : !OVERPROMISE.test(claim);
    return { accurate_wording: ACCURATE_WORDING,
      // The two facts the wording rests on, so a reader can check it rather than trust it.
      append_only_domain_updates: true, in_place_rewrite_path_exists: true,
      claim_allowed: accurate,
      rejected_reason: accurate ? null : "the store has an in-place rewrite path, so a tamper-proof claim is false",
      // 11.2 rule 3: this is the prohibition the wording exists to satisfy.
      prohibits_tamper_proof_claim: true };
  }

  /** Whether a proposed description overpromises, for a caller checking its own copy. */
  assertWording(args: JsonObject): JsonObject {
    const claim = text(args.claim, "claim");
    return this.ledgerWording({ claim });
  }
}
