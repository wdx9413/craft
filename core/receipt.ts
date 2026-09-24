import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { digestJson, payload, stableDigest } from "./digest.ts";

/**
 * The evidence receipt: what a conclusion rests on, and who supplied each value.
 *
 * The plan makes this the foundation of the whole architecture (section 11): a system
 * that cannot show why it was right has to be watched, and a watched system is the
 * "browser tab with an input box" the plan exists to replace. Three requirements shape
 * this kernel, and each one closes a failure that looks like success:
 *
 *  1. **A receipt must be recomputable (10.1).** Someone holding the raw values and their
 *     timestamps must be able to reach the same conclusion independently. A conclusion
 *     that cannot be re-derived is a screenshot, not evidence, so `assess` re-runs the
 *     comparison from the stored inputs rather than trusting the recorded verdict.
 *
 *  2. **A verdict needs two observations (10.2).** One snapshot cannot tell "catching up"
 *     from "stuck": a lag of 1200 is healthy when it is shrinking and an incident when it
 *     is not. A receipt carrying a single state therefore has no verdict to give, and
 *     `trend` refuses rather than guessing.
 *
 *  3. **Every value must name its source (11.5).** The half-automatic path replaces an
 *     arithmetic error with a transcription error, and the transcription error is worse
 *     because it is invisible: the receipt is faithful, recomputable, digest-valid, and
 *     wrong. Marking provenance does not make a mistyped value correct — it makes the
 *     dependency visible, which is the difference between "the machine computed this"
 *     and "a person read this off a screen".
 *
 * The third requirement also bounds L1: a value a human transcribed has no deterministic
 * checker behind it (section 4.3), so a receipt resting on one may not be the basis for
 * silent execution unless an independent source confirms the same value.
 */

export type ProvenanceSource = "machine_observed" | "human_transcription";
export type Verdict = "settled" | "catching_up" | "stuck";

const PROVENANCE_SOURCES = new Set<string>(["machine_observed", "human_transcription"]);
const METRIC_NAME = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * Remediation per verdict (section 10).
 *
 * Typed as a total record so a new verdict cannot be added without deciding what a
 * person can actually do about it. The plan is explicit that an exit is not remediation:
 * "retry" and "reject" are placeholders that leave the operator where they started, and
 * a card whose only exit is one of those has no failure path at all. The forbidden set is
 * asserted in the test rather than checked here, because it is a property of this
 * constant, not of any call.
 */
export const REMEDIATION: Readonly<Record<Verdict, readonly string[]>> = {
  // Nothing to fix; the remaining step is to hand the result on as a credential.
  settled: ["issue_acceptance_receipt"],
  // May resolve itself, so the cheap action is to look again rather than intervene.
  catching_up: ["recheck_after_delay", "issue_receipt_with_trend_note"],
  // Will not resolve itself: this is the case the plan calls the product's value.
  stuck: ["locate_conflicting_key", "skip_conflicting_key", "rebuild_sync"],
};

export const NON_REMEDIATION_EXITS: readonly string[] = ["retry", "reject", "reject_change", "try_again"];

function finite(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${name} must be a finite number`);
  return result;
}
function instant(value: unknown, name: string): string {
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[a-zA-Z0-9_.:-]{1,200}$/u.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}

type Provenance = {
  source: ProvenanceSource;
  at: string;
  /** Present for `machine_observed`: which checker observed it. */
  checker: string | null;
  /** Present for `human_transcription`: who transcribed it, and from where. */
  by: string | null;
  origin: string | null;
};

/**
 * Validate one provenance block.
 *
 * Each source requires the fields that make it auditable: a machine observation names
 * its checker, and a transcription names the person and the screen it came from. Those
 * are the two facts a later "where did this number come from" question needs, and
 * neither can be recovered after the fact.
 */
function provenance(value: unknown, name: string): Provenance {
  const raw = object(value, name);
  const source = text(raw.source, `${name}.source`);
  if (!PROVENANCE_SOURCES.has(source)) {
    throw new Error(`${name}.source must be machine_observed or human_transcription`);
  }
  const at = instant(raw.at, `${name}.at`);
  if (source === "machine_observed") {
    return { source: "machine_observed", at, checker: text(raw.checker, `${name}.checker`), by: null, origin: null };
  }
  return { source: "human_transcription", at, checker: null,
    by: text(raw.by, `${name}.by`), origin: text(raw.origin, `${name}.origin`) };
}

/**
 * One observed state: a set of named numeric metrics plus the provenance of the reading.
 *
 * The metric values live beside `provenance` exactly as the plan writes them, so a
 * receipt reads as the document describes rather than as a normalized form only the code
 * understands. A field named `provenance` is therefore reserved and cannot be a metric.
 */
function state(value: unknown, name: string): { values: Record<string, number>; provenance: Provenance } {
  const raw = object(value, name);
  if (raw.provenance === undefined) throw new Error(`${name}.provenance is required; a value with no source cannot be audited`);
  const observed = provenance(raw.provenance, `${name}.provenance`);
  const values: Record<string, number> = {};
  for (const [key, metric] of Object.entries(raw)) {
    if (key === "provenance") continue;
    if (!METRIC_NAME.test(key)) throw new Error(`${name}.${key} is not a valid metric name`);
    values[key] = finite(metric, `${name}.${key}`);
  }
  if (!Object.keys(values).length) throw new Error(`${name} must carry at least one metric`);
  return { values, provenance: observed };
}

export class ReceiptKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Record a receipt.
   *
   * `check` is optional: a receipt may exist to record an observation rather than to
   * justify an action. What is never optional is provenance on both states, because a
   * receipt without it is the one artifact that cannot be audited later.
   */
  issue(args: JsonObject): JsonObject {
    const objectId = identifier(args.object_id, "object_id");
    const actionExecuted = identifier(args.action_executed, "action_executed");
    const pre = state(args.pre_state, "pre_state");
    const post = state(args.post_state, "post_state");
    const check = args.check === undefined ? null : this.#check(args.check);
    const proofs = this.#proofs(args.proofs);
    const crossChecks = this.#crossChecks(args.cross_checks);

    // Recomputation is decided from the inputs, never asserted by the caller. A receipt
    // whose own claim of recomputability was the basis for trusting it would be circular.
    const recomputable = this.#recomputable(pre, post);
    const metrics = [...new Set([...Object.keys(pre.values), ...Object.keys(post.values)])].sort();
    const readings = this.#readings(pre, post, crossChecks);

    const identity = { object_id: objectId, action_executed: actionExecuted, metrics,
      pre_digest: stableDigest(pre), post_digest: stableDigest(post), check, proofs, cross_checks: crossChecks };
    const identityDigest = digestJson(identity);
    const receiptId = String(args.receipt_id ?? `receipt_${identityDigest.slice(-24)}`);
    const existing = this.store.find("evidence_receipt", receiptId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Evidence receipt idempotency conflict");
      return { receipt: existing, idempotent: true };
    }

    const previous = args.prev_receipt_digest === undefined ? null : text(args.prev_receipt_digest, "prev_receipt_digest");
    const receipt = this.store.create("evidence_receipt", receiptId, {
      object_id: objectId, action_executed: actionExecuted,
      risk_level: text(args.risk_level, "risk_level"),
      metrics, pre_state: pre, post_state: post, check, proofs, cross_checks: crossChecks,
      recomputable, l1_eligible: readings.eligible, l1_reason: readings.reason,
      transcription_metrics: readings.transcriptionMetrics,
      unconfirmed_metrics: readings.unconfirmedMetrics,
      prev_receipt_digest: previous, identity_digest: identityDigest,
      // The chain link is the digest of this receipt's own content, which is what a
      // later receipt cites as its predecessor. It is not a claim of immutability.
      receipt_digest: stableDigest(identity),
      content_stored: false,
    });
    return { receipt, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    return { receipt: this.store.get("evidence_receipt", identifier(args.receipt_id, "receipt_id")) };
  }

  list(args: JsonObject): JsonObject {
    const objectId = identifier(args.object_id, "object_id");
    const limit = args.limit === undefined ? 100 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be an integer between 1 and 1000");
    return { receipts: this.store.list("evidence_receipt", limit, (item) => item.object_id === objectId) };
  }

  /**
   * Re-derive the receipt's conclusion from its stored inputs (10.1).
   *
   * Returns the comparison this kernel can defend, plus whether every metric appeared in
   * both states. A metric present in only one state cannot be compared, and the receipt
   * reports that rather than treating the missing side as zero — reading an absent
   * observation as 0 is how "we did not measure it" becomes "it is zero".
   */
  assess(args: JsonObject): JsonObject {
    const receipt = this.store.get("evidence_receipt", identifier(args.receipt_id, "receipt_id"));
    const pre = receipt.pre_state as { values: Record<string, number>; provenance: Provenance };
    const post = receipt.post_state as { values: Record<string, number>; provenance: Provenance };
    const shared = Object.keys(pre.values).filter((metric) => Object.hasOwn(post.values, metric)).sort();
    const onlyPre = Object.keys(pre.values).filter((metric) => !Object.hasOwn(post.values, metric)).sort();
    const onlyPost = Object.keys(post.values).filter((metric) => !Object.hasOwn(pre.values, metric)).sort();
    return {
      receipt_id: receipt.id,
      recomputable: shared.length > 0 && onlyPre.length === 0 && onlyPost.length === 0,
      compared_metrics: shared.map((metric) => ({ metric, pre: pre.values[metric], post: post.values[metric],
        delta: post.values[metric]! - pre.values[metric]! })),
      uncomparable_metrics: [...onlyPre.map((metric) => ({ metric, missing: "post_state" })),
        ...onlyPost.map((metric) => ({ metric, missing: "pre_state" }))],
      l1_eligible: receipt.l1_eligible,
      l1_reason: receipt.l1_reason,
      transcription_metrics: receipt.transcription_metrics,
      unconfirmed_metrics: receipt.unconfirmed_metrics,
    };
  }

  /**
   * The verdict for one metric, from two observations (10.2).
   *
   * `settled` when the lag reached zero, `catching_up` when it shrank, `stuck` when it did
   * not. The third case covers both "unchanged" and "grew" because they call for the same
   * response: a lag that is not shrinking will not shrink on its own, and waiting for it
   * is the mistake the plan describes.
   */
  trend(args: JsonObject): JsonObject {
    const receipt = this.store.get("evidence_receipt", identifier(args.receipt_id, "receipt_id"));
    const metric = text(args.metric, "metric");
    if (!METRIC_NAME.test(metric)) throw new Error("metric is not a valid metric name");
    const pre = receipt.pre_state as { values: Record<string, number>; provenance: Provenance };
    const post = receipt.post_state as { values: Record<string, number>; provenance: Provenance };
    if (!Object.hasOwn(pre.values, metric)) throw new Error(`pre_state does not observe metric: ${metric}`);
    if (!Object.hasOwn(post.values, metric)) throw new Error(`post_state does not observe metric: ${metric}`);
    const before = pre.values[metric]!;
    const after = post.values[metric]!;
    const verdict: Verdict = after === 0 ? "settled" : after < before ? "catching_up" : "stuck";
    return {
      receipt_id: receipt.id, metric, pre: before, post: after, delta: after - before,
      // Two observations are what make the verdict possible; the count is reported so a
      // reader can see the claim rests on two readings rather than on one.
      observations: 2,
      first_observed_at: pre.provenance.at, last_observed_at: post.provenance.at,
      verdict,
      remediation: REMEDIATION[verdict],
      // The card must always offer a way out, so the exit is part of the verdict rather
      // than something the caller has to remember to attach.
      exit: "none_required",
    };
  }

  /** The remediation actions for a verdict (section 10), independent of any receipt. */
  remediation(args: JsonObject): JsonObject {
    const verdict = text(args.verdict, "verdict");
    if (!Object.hasOwn(REMEDIATION, verdict)) throw new Error("verdict is unsupported");
    const actions = REMEDIATION[verdict as Verdict];
    return { verdict, actions, non_remediation: actions.filter((action) => NON_REMEDIATION_EXITS.includes(action)) };
  }

  #check(value: unknown): JsonObject {
    const raw = object(value, "check");
    const result = text(raw.result, "check.result");
    if (!new Set(["passed", "failed"]).has(result)) throw new Error("check.result is unsupported");
    return { checker: text(raw.checker, "check.checker"), result, independent: raw.independent === true };
  }

  #proofs(value: unknown): JsonObject[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("proofs must be an array");
    return value.map((raw, index) => {
      const proof = object(raw, `proofs[${index}]`);
      return { type: text(proof.type, `proofs[${index}].type`), value: text(proof.value, `proofs[${index}].value`),
        observed_at: instant(proof.observed_at, `proofs[${index}].observed_at`) };
    });
  }

  /**
   * Independent confirmations of transcribed values.
   *
   * A cross-check must come from a machine observation of the same metric; a second
   * person reading the same screen is not an independent source, because both readings
   * share the failure mode that matters here.
   */
  #crossChecks(value: unknown): JsonObject[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("cross_checks must be an array");
    return value.map((raw, index) => {
      const entry = object(raw, `cross_checks[${index}]`);
      const metric = text(entry.metric, `cross_checks[${index}].metric`);
      if (!METRIC_NAME.test(metric)) throw new Error(`cross_checks[${index}].metric is not a valid metric name`);
      const observed = provenance(entry.provenance, `cross_checks[${index}].provenance`);
      if (observed.source !== "machine_observed") {
        throw new Error(`cross_checks[${index}] must come from a machine observation to be independent`);
      }
      return { metric, value: finite(entry.value, `cross_checks[${index}].value`), provenance: observed };
    });
  }

  /** A receipt is recomputable when at least one metric appears in both states. */
  #recomputable(pre: { values: Record<string, number> }, post: { values: Record<string, number> }): boolean {
    return Object.keys(pre.values).some((metric) => Object.hasOwn(post.values, metric));
  }

  /**
   * Which readings rest on a person, and whether the receipt may support L1 (11.5 rule 2).
   *
   * Every `(state, metric)` reading is examined on its own, because the two states can
   * have different provenance: a value a machine measured before an action and a person
   * read afterwards is a transcription for the conclusion's purposes even though half of
   * it was automatic. A reading is trusted when the machine observed it, or when an
   * independent machine observation confirms the same metric at the same value.
   *
   * An independent confirmation must agree on the value. A machine reading that
   * contradicts the transcription is not a confirmation, and treating it as one would let
   * a cross-check launder a mistyped number.
   */
  #readings(
    pre: { values: Record<string, number>; provenance: Provenance },
    post: { values: Record<string, number>; provenance: Provenance },
    crossChecks: readonly JsonObject[],
  ): { transcriptionMetrics: string[]; unconfirmedMetrics: string[]; eligible: boolean; reason: string } {
    const transcriptionMetrics: string[] = [];
    const unconfirmedMetrics: string[] = [];
    for (const [label, observed] of [["pre_state", pre], ["post_state", post]] as const) {
      for (const [metric, value] of Object.entries(observed.values)) {
        if (observed.provenance.source === "machine_observed") continue;
        const confirmed = crossChecks.some((entry) => entry.metric === metric && entry.value === value);
        const name = `${label}.${metric}`;
        if (confirmed) continue;
        transcriptionMetrics.push(name);
        unconfirmedMetrics.push(name);
      }
    }
    transcriptionMetrics.sort();
    unconfirmedMetrics.sort();
    if (unconfirmedMetrics.length) return { transcriptionMetrics, unconfirmedMetrics, eligible: false, reason: "human_transcription_requires_cross_check" };
    // Nothing further to check here. Every metric comes from one of the two states, so
    // once no reading is an unconfirmed transcription, each one is either machine
    // observed or independently confirmed — the two bases that satisfy 4.3. There is no
    // third case, which is why this is the whole condition rather than a partial one.
    return { transcriptionMetrics, unconfirmedMetrics, eligible: true, reason: "machine_observed" };
  }
}
