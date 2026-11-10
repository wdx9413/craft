import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { payload, stableDigest } from "./digest.ts";

/**
 * Browser driving: three levels of adjudication, and why two tempting rules are wrong.
 *
 * Section 13A draws a hard line between *looking* at a browser and *driving* one. Looking is
 * a product feature with no approval needed. Driving is an autonomy capability, and this
 * kernel implements the conditions under which it may act without a person watching.
 *
 * The section is unusual in that it records two corrections to its own earlier drafts, and
 * both corrections are the substance of the design:
 *
 *  1. **The judge is the checker, not the tool.** An earlier draft banned driving actions
 *     from L1 outright. That is too broad, and it violates 4.3's structure: 4.3 judges the
 *     *checker*, not the implementation. A Playwright script with an independent side-check
 *     is exactly as self-certifying as an API call. Rejecting by implementation would deny
 *     automatic execution to things that can prove themselves, which contradicts 4.6's whole
 *     point. So the question is never "did a browser do this" but "can the result be
 *     confirmed from outside the browser".
 *
 *  2. **A passing check does not grant permission.** A bypass check proves the action was
 *     done *correctly*; the approval chain decides whether it *should* be done. These are not
 *     substitutes, so R3 goes through the approval chain even when a bypass checker exists.
 *     Dropping this would let "we verified it worked" stand in for "we decided to do it".
 *
 * Two further rules are enforced because their justification is a failure mode rather than a
 * preference. VLM guessing (13A.4) is forbidden not for being inaccurate but because its
 * failures cannot be discovered automatically — clicking the wrong thing can still look like
 * success, and a model grading its own click is the same self-certification 4.2 rejects for
 * `confidence_score`. And fuzzy waiting (13A.6) is refused because `waitForTimeout(N)` is
 * unassertable: it hides the failure probability rather than exposing it.
 */

export type DrivingOutcome = "L1" | "L2_prepare_release" | "L2_prepare_release_with_approval_chain" | "forbidden";

/** 13A.2.3: the level follows the action, not the fact that a browser is involved. */
const ACTION_RISK: Readonly<Record<string, string>> = {
  navigate: "R0", observe: "R0", fill: "R1", click: "R2", submit: "R2", production_change: "R3",
};
const RISK_ORDER: Readonly<Record<string, number>> = { R0: 0, R1: 1, R2: 2, R3: 3 };

const NAME = /^[a-zA-Z0-9_.:\-]{1,200}$/u;
const SELECTOR = /^[#.a-zA-Z][a-zA-Z0-9_\-.#>\[\]="':\s]{0,200}$/u;

/** Patterns that make a script wait without asserting anything (13A.6 rule 2). */
const FUZZY_WAIT = /\b(?:waitForTimeout|sleep|setTimeout|delay)\s*\(/u;
/**
 * Ways of locating or acting on an element visually rather than by selector (13A.4).
 *
 * The pattern matches the concept rather than a list of library names, because naming a
 * fixed set only catches the spellings someone thought of: `find_by_vision` slipped past an
 * earlier version that listed `vision` and `vlm` as whole words. What matters is whether the
 * script decides where to act from pixels, so the check looks for that idea — vision,
 * screenshot, OCR, image or template matching, coordinates, or a computer-use call — under
 * any identifier that contains it.
 */
const VISION_LOCATION = /(?:vision|vlm|screenshot|ocr|image_?match|template_?match|computer_?use|pixel|coordinate|bounding_?box|getBoundingClientRect)/iu;

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!NAME.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}

export class BrowserDrivingKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Register a site's permitted driving surface (13A.6 rule 3).
   *
   * Per-site rather than global, following the existing `allowed_operations` convention on
   * connectors. A driving capability scoped to everything is the same blank cheque the
   * subscription rules exist to prevent, one layer down.
   */
  registerSite(args: JsonObject): JsonObject {
    const siteId = identifier(args.site_id, "site_id");
    if (!Array.isArray(args.allowed_operations) || !args.allowed_operations.length) {
      throw new Error("allowed_operations must be a non-empty array; a site with no declared operations permits everything");
    }
    const allowed = args.allowed_operations.map((entry, index) => {
      const operation = text(entry, `allowed_operations[${index}]`);
      if (!Object.hasOwn(ACTION_RISK, operation)) throw new Error(`allowed_operations[${index}] is not a known operation`);
      return operation;
    });
    const identityDigest = stableDigest({ site_id: siteId, allowed_operations: [...allowed].sort() });
    const existing = this.store.find("driving_site", siteId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Driving site is already registered with different operations");
      return { site: existing, idempotent: true };
    }
    return { site: this.store.create("driving_site", siteId, { site_id: siteId, allowed_operations: [...allowed].sort(),
      // A bypass checker is what separates "can reach L1" from "can only prepare and release".
      bypass_checker: args.bypass_checker === undefined ? null : identifier(args.bypass_checker, "bypass_checker"),
      identity_digest: identityDigest }), idempotent: false };
  }

  /** Register a deterministic script for one site and operation (13A.6 rules 1 and 2). */
  registerScript(args: JsonObject): JsonObject {
    const scriptId = identifier(args.script_id, "script_id");
    const site = this.store.get("driving_site", identifier(args.site_id, "site_id"));
    const operation = text(args.operation, "operation");
    if (!Object.hasOwn(ACTION_RISK, operation)) throw new Error("operation is not a known driving operation");
    if (!(site.allowed_operations as string[]).includes(operation)) {
      throw new Error(`operation is not permitted for this site: ${operation}`);
    }
    // 13A.4: locating by vision is refused by name, because its failures cannot be discovered
    // automatically and a model grading its own click is self-certification.
    const body = text(args.script_body, "script_body");
    if (VISION_LOCATION.test(body)) {
      throw new Error("VLM or visual location is forbidden: its failures cannot be auto-discovered, so it violates 4.2");
    }
    // 13A.6 rule 2: fuzzy waiting hides the failure probability instead of asserting.
    if (FUZZY_WAIT.test(body)) {
      throw new Error("fuzzy wait is forbidden; assert a selector or a condition instead of waiting N seconds");
    }
    // 13A.6 rule 1: an explicit assertion is what makes the script deterministic.
    if (!Array.isArray(args.assertions) || !args.assertions.length) {
      throw new Error("assertions must be a non-empty array; a script with no assertion cannot fail detectably");
    }
    const assertions = args.assertions.map((entry, index) => {
      const assertion = object(entry, `assertions[${index}]`);
      const selector = text(assertion.selector, `assertions[${index}].selector`);
      if (!SELECTOR.test(selector)) throw new Error(`assertions[${index}].selector is not a valid selector`);
      const state = text(assertion.state, `assertions[${index}].state`);
      if (!new Set(["present", "absent", "enabled", "disabled", "text_equals"]).has(state)) {
        throw new Error(`assertions[${index}].state is unsupported`);
      }
      return { selector, state };
    });
    const identityDigest = stableDigest({ script_id: scriptId, site_id: String(site.id), operation,
      assertions, body_digest: stableDigest(body) });
    const existing = this.store.find("driving_script", scriptId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Driving script is already registered with different content");
      return { script: existing, idempotent: true };
    }
    return { script: this.store.create("driving_script", scriptId, { script_id: scriptId, site_id: String(site.id),
      operation, risk_level: ACTION_RISK[operation], assertions, script_digest: stableDigest(body),
      // Recorded on the script so the receipt can name what was asserted (13A.6 rule 4).
      body_stored: false, identity_digest: identityDigest }), idempotent: false };
  }

  /**
   * The adjudication formula (13A.3, corrected).
   *
   * Two corrections from the section are load-bearing here, and both are places where the
   * obvious answer is wrong:
   *
   *  - **R1 never reaches L1**, even with a bypass checker. R1 means reversible *with external
   *    effect*, and reversibility does not undo an external effect: recalling a message does
   *    not un-see it. 6.1 says only R0 may reach L1, and this keeps the stricter rule.
   *  - **R3 always goes through the approval chain**, even with a bypass checker. A check
   *    proves the action was done correctly; the chain decides whether it should be done.
   */
  adjudicate(args: JsonObject): JsonObject {
    const script = this.store.get("driving_script", identifier(args.script_id, "script_id"));
    const site = this.store.get("driving_site", String(script.site_id));
    const risk = String(script.risk_level);
    // The bypass checker may be declared per script call or inherited from the site: it is
    // availability of confirmation, and availability does not depend on who states it.
    const bypass = args.bypass_checker === undefined
      ? (site.bypass_checker === null ? null : String(site.bypass_checker))
      : identifier(args.bypass_checker, "bypass_checker");
    const hasBypass = bypass !== null;

    // 13A.6 rule 5 and 13A.3: only R0 with a bypass checker runs unattended.
    const outcome: DrivingOutcome = risk === "R3"
      ? "L2_prepare_release_with_approval_chain"
      : risk === "R0" && hasBypass
        ? "L1"
        : "L2_prepare_release";
    return { script_id: String(script.id), site_id: String(site.id), operation: String(script.operation),
      risk_level: risk, bypass_checker: bypass, has_bypass_check: hasBypass, outcome,
      // Stated so a caller cannot read "has a checker" as "may proceed without a person".
      approval_chain_required: risk === "R3",
      // 13A.5's one-line criterion, spelled out for the case that fails it.
      reason: risk === "R3"
        ? "r3_requires_approval_chain_even_with_bypass_check"
        : risk === "R0" && hasBypass
          ? "r0_with_independent_bypass_check"
          : risk === "R0"
            ? "r0_without_bypass_check_prepare_and_release"
            // R1's reversibility does not undo an external effect, so it cannot be silent.
            : risk === "R1" ? "r1_never_reaches_l1_even_with_bypass_check" : "external_effect_requires_prepare_and_release",
      // 13A.2.1: the core never drives; the adapter does, and this does not change that.
      adapter_required: true, execution_authority: false };
  }

  /**
   * Record a driving receipt (13A.6 rule 4).
   *
   * The bypass result is part of the receipt rather than a separate record, because a receipt
   * that only contains what the page said is the failure 13A.5 names: a page can render
   * "Success" while being wrong. Without the bypass result recorded alongside, a reader cannot
   * tell which kind of confirmation they are looking at.
   */
  recordReceipt(args: JsonObject): JsonObject {
    const script = this.store.get("driving_script", identifier(args.script_id, "script_id"));
    const decision = this.adjudicate({ script_id: String(script.id) });
    const targetUrl = text(args.target_url, "target_url");
    const domDigest = text(args.dom_digest, "dom_digest");
    const assertionResults = args.assertion_results === undefined ? [] : object(args.assertion_results, "assertion_results");
    const bypass = args.bypass_result === undefined ? null : object(args.bypass_result, "bypass_result");
    // A bypass result is only a bypass result if it came from outside the page.
    if (bypass !== null) {
      const source = text(bypass.source, "bypass_result.source");
      if (source === "page" || source === "dom" || source === "browser") {
        throw new Error("bypass_result.source must be independent of the browser to count as a bypass check");
      }
      text(bypass.result, "bypass_result.result");
    }
    // No L1-without-bypass guard is needed here: `adjudicate` reaches L1 only when a bypass
    // checker exists, so that combination cannot be constructed. A check for it would be dead
    // code that reads as a safety net, which is worse than no check — it suggests a reachable
    // state that does not exist.
    const receiptId = args.receipt_id === undefined
      ? `driving_receipt_${stableDigest({ script_id: String(script.id), target_url: targetUrl, dom_digest: domDigest }).slice("sha256:".length, "sha256:".length + 20)}`
      : identifier(args.receipt_id, "receipt_id");
    const existing = this.store.find("driving_receipt", receiptId);
    if (existing) return { receipt: existing, idempotent: true };
    return { receipt: this.store.create("driving_receipt", receiptId, {
      script_id: String(script.id), site_id: String(script.site_id), operation: String(script.operation),
      risk_level: String(script.risk_level), outcome: decision.outcome, target_url: targetUrl,
      dom_digest: domDigest, assertions: script.assertions, assertion_results: assertionResults,
      bypass_result: bypass, bypass_checker: decision.bypass_checker,
      // 10.1: recomputable only when something outside the page confirms it.
      recomputable: bypass !== null, page_claim_only: bypass === null,
      adapter_required: true, execution_authority: false, page_content_stored: false }), idempotent: false };
  }

  getSite(args: JsonObject): JsonObject {
    return { site: this.store.get("driving_site", identifier(args.site_id, "site_id")) };
  }

  getScript(args: JsonObject): JsonObject {
    return { script: this.store.get("driving_script", identifier(args.script_id, "script_id")) };
  }

  /** The registered driving surface, so "how much can be driven" is answerable. */
  surface(args: JsonObject = {}): JsonObject {
    const sites = this.store.list("driving_site", 1_000);
    const scripts = this.store.list("driving_script", 1_000);
    return { sites: sites.length, scripts: scripts.length,
      // How many scripts can reach L1 today, and how many only because no bypass exists.
      l1_eligible: scripts.filter((script) => String(script.risk_level) === "R0"
        && (sites.find((site) => String(site.id) === String(script.site_id))?.bypass_checker ?? null) !== null).length,
      without_bypass: scripts.filter((script) => {
        const site = sites.find((entry) => String(entry.id) === String(script.site_id));
        return (site?.bypass_checker ?? null) === null;
      }).length };
  }

  /** Receipts for one script, so a reviewer can see which confirations were independent. */
  receipts(args: JsonObject): JsonObject {
    const scriptId = identifier(args.script_id, "script_id");
    return { receipts: this.store.list("driving_receipt", 1_000, (item) => item.script_id === scriptId)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))) };
  }
}
