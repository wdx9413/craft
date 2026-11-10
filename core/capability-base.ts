import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { payload, stableDigest } from "./digest.ts";

/**
 * The capability base: one shape for an action, and one obligation about how it was reached.
 *
 * Section 13 makes an argument about where breadth comes from. It is not from writing an
 * adapter per system, and it is not from a long feature list — it is from the base plus the
 * context model. The base is a single shape every capability is expressed in (13.1), so that
 * "what can this do, what does it need, what does it produce, how risky is it, what must stay
 * true" is answered the same way for an MCP tool and for a fallback script.
 *
 * Two of the five fields deserve their own note because they are the ones an implementer is
 * tempted to skip:
 *
 *  - **`scope_invariants` is not optional.** Section 6.3 makes invariants the mandatory part
 *    of a learned rule; an action that cannot state what must remain true cannot have its
 *    authorization checked later, and the check silently becomes "it worked last time".
 *  - **`receipt_format` is a commitment, not documentation.** It is what a receipt will
 *    contain, and the plan freezes the receipt format at phase 0 precisely so it stops
 *    moving. Recording it per action is what makes that freeze checkable.
 *
 * The second half of this kernel is 13A.7, which is the sharpest rule in the section. Access
 * has a fixed priority — native API or MCP, then system CLI or database, then GUI automation
 * as a last resort — and the fallback carries an obligation rather than a preference: when the
 * upstream exposes an API, the GUI adapter **must** be replaced, not merely may be. The reason
 * given is the one that makes this worth enforcing in code: a GUI script is technical debt
 * that keeps working until the day the upstream changes, so nothing forces anyone to revisit
 * it. Counting them is what turns "how much of this is held together by scripts" from a
 * feeling into a number, and the plan says that number must be visible or it grows in silence.
 */

export type AccessKind = "api_mcp" | "system_cli_db" | "gui_automation";

/** Fixed by 13A.7. Lower is preferred; the numbers are the priority, not an ordering hint. */
const ACCESS_RANK: Readonly<Record<AccessKind, number>> = { api_mcp: 0, system_cli_db: 1, gui_automation: 2 };
const ACCESS_KINDS = new Set<string>(["api_mcp", "system_cli_db", "gui_automation"]);
const RISK_LEVELS = new Set(["R0", "R1", "R2", "R3"]);

const NAME = /^[a-zA-Z0-9_.:\-]{1,200}$/u;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/u;

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!NAME.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}
function fieldName(value: unknown, name: string): string {
  const result = text(value, name);
  if (!FIELD.test(result)) throw new Error(`${name} is not a valid field name`);
  return result;
}
function instant(value: unknown, name: string): string {
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}

/** A declarative receipt commitment: which fields a receipt for this action will carry. */
function receiptFormat(value: unknown): { fields: string[]; recomputable: boolean } {
  const raw = object(value, "receipt_format");
  if (!Array.isArray(raw.fields) || !raw.fields.length) {
    throw new Error("receipt_format.fields must be a non-empty array; a receipt with no fields is a screenshot");
  }
  const fields = raw.fields.map((entry, index) => fieldName(entry, `receipt_format.fields[${index}]`));
  if (new Set(fields).size !== fields.length) throw new Error("receipt_format.fields must contain unique values");
  // Recomputability is not a comment: 10.1 says someone holding the raw values must reach the
  // same conclusion, so the format has to say whether it carries enough to do that.
  if (typeof raw.recomputable !== "boolean") throw new Error("receipt_format.recomputable must be a boolean");
  return { fields: [...fields].sort(), recomputable: raw.recomputable };
}

function scopeInvariants(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) {
    // 6.3: an action with no stated invariant cannot have its authorization checked later.
    throw new Error("scope_invariants must be a non-empty array; an action with no invariant cannot be re-checked");
  }
  const invariants = value.map((entry, index) => fieldName(entry, `scope_invariants[${index}]`));
  if (new Set(invariants).size !== invariants.length) throw new Error("scope_invariants must contain unique values");
  return [...invariants].sort();
}

function requiredPermission(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error("required_permission must be a non-empty array; an action needing nothing needs no authorization");
  }
  return [...new Set(value.map((entry, index) => identifier(entry, `required_permission[${index}]`)))].sort();
}

export class CapabilityBaseKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Register one capability in the base's single shape (13.1).
   *
   * Registration is refused when the same action name already exists under a different
   * shape, because two shapes for one name is how "the base" becomes a set of special cases.
   */
  register(args: JsonObject): JsonObject {
    const actionId = identifier(args.action_id, "action_id");
    const input = object(args.input, "input");
    const accessKind = text(args.access_kind, "access_kind");
    if (!ACCESS_KINDS.has(accessKind)) throw new Error("access_kind must be api_mcp, system_cli_db or gui_automation");
    const riskLevel = text(args.risk_level, "risk_level");
    if (!RISK_LEVELS.has(riskLevel)) throw new Error("risk_level must be R0, R1, R2 or R3");
    const shape = {
      input, required_permission: requiredPermission(args.required_permission),
      receipt_format: receiptFormat(args.receipt_format), risk_level: riskLevel,
      scope_invariants: scopeInvariants(args.scope_invariants),
    };
    const identityDigest = stableDigest({ action_id: actionId, access_kind: accessKind, ...shape });
    const existing = this.store.find("capability_action", actionId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) {
        throw new Error("Capability action is already registered with a different shape");
      }
      return { action: existing, idempotent: true };
    }
    return { action: this.store.create("capability_action", actionId, { action_id: actionId,
      ...shape, access_kind: accessKind, access_rank: ACCESS_RANK[accessKind as AccessKind],
      // A GUI action starts life carrying the obligation; an API one has nothing to repay.
      replacement_required: accessKind === "gui_automation",
      replaced_at: null, replaced_by_adapter: null, replacement_reason: null,
      registered_at: instant(args.registered_at, "registered_at"), identity_digest: identityDigest,
      content_stored: false }), idempotent: false };
  }

  /**
   * Whether a capability exists in a stronger form than the one recorded.
   *
   * 13A.7 rule 1 is that GUI automation is only a bridge for a missing API. This answers
   * whether the bridge is still needed by comparing the recorded access against what is now
   * available — the comparison is the caller's observation, the rule is this kernel's.
   */
  checkAccess(args: JsonObject): JsonObject {
    const action = this.store.get("capability_action", identifier(args.action_id, "action_id"));
    const available = text(args.available_access_kind, "available_access_kind");
    if (!ACCESS_KINDS.has(available)) throw new Error("available_access_kind must be api_mcp, system_cli_db or gui_automation");
    const recorded = String(action.access_kind) as AccessKind;
    // Lower rank is stronger. A weaker access becoming available is not an upgrade.
    const stronger = ACCESS_RANK[available as AccessKind] < ACCESS_RANK[recorded];
    // 13A.7 rule 2 names API specifically: "一旦上游开放 API，必须用 API Adapter 替换掉 GUI
    // 脚本". A CLI is a genuine upgrade over a script, but it is not the obligation the rule
    // states, and reporting it as mandatory would make the debt count demand work the plan
    // does not. So the mandatory flag tracks the named case, and an ordinary upgrade is
    // reported as available rather than required.
    const mandatory = stronger && recorded === "gui_automation" && available === "api_mcp";
    return { action_id: String(action.id), recorded_access_kind: recorded, available_access_kind: available,
      upgrade_available: stronger, replacement_required: mandatory,
      // 13A.7 rule 2 is stated as "必须替换", so when it applies the answer is not advisory.
      reason: mandatory
        ? "upstream_api_available_gui_adapter_must_be_replaced"
        : stronger ? "stronger_access_available" : "no_stronger_access_available" };
  }

  /**
   * Record the replacement (13A.7 rule 3).
   *
   * The plan requires a record of which action moved from a GUI adapter to an API adapter and
   * when, because the debt is the kind that keeps working and therefore keeps being forgotten.
   * The action's shape is preserved; only the access changes, so the authorization and receipt
   * behaviour a caller depends on does not shift underneath them.
   */
  replaceAdapter(args: JsonObject): JsonObject {
    const action = this.store.get("capability_action", identifier(args.action_id, "action_id"));
    const accessKind = text(args.access_kind, "access_kind");
    if (!ACCESS_KINDS.has(accessKind)) throw new Error("access_kind must be api_mcp, system_cli_db or gui_automation");
    const current = String(action.access_kind) as AccessKind;
    if (ACCESS_RANK[accessKind as AccessKind] >= ACCESS_RANK[current]) {
      // Replacement only ever moves up the fixed priority. Recording a sideways or backwards
      // move would make the debt count wrong without anyone noticing.
      throw new Error("Adapter replacement must move to a higher-priority access kind");
    }
    const at = instant(args.replaced_at, "replaced_at");
    const record = this.store.create("adapter_replacement", `${action.id}_${at}`, {
      action_id: String(action.id), from_access_kind: current, to_access_kind: accessKind,
      replaced_at: at, replaced_by: identifier(args.replaced_by, "replaced_by"),
      reason: text(args.reason, "reason") });
    return { action: this.store.save("capability_action", String(action.id), { ...payload(action),
      access_kind: accessKind, access_rank: ACCESS_RANK[accessKind as AccessKind],
      previous_access_kind: current, replacement_required: false, replaced_at: at,
      replaced_by_adapter: accessKind, replacement_reason: record.reason }), replacement: record };
  }

  /**
   * How much of the base is held together by fallback scripts.
   *
   * 13A.7 says this number must be visible or the fragile layer grows in silence, and 13.3
   * gives it a sense of scale: three GUI scripts are a fallback, thirty are a self-built
   * brittle layer.
   */
  debt(args: JsonObject = {}): JsonObject {
    const actions = this.store.list("capability_action", 10_000);
    const gui = actions.filter((item) => item.access_kind === "gui_automation");
    const replacements = this.store.list("adapter_replacement", 10_000);
    return { total_actions: actions.length,
      by_access_kind: { api_mcp: actions.filter((item) => item.access_kind === "api_mcp").length,
        system_cli_db: actions.filter((item) => item.access_kind === "system_cli_db").length,
        gui_automation: gui.length },
      // The two numbers the plan cares about: how much is on a bridge, and how much of the
      // bridge has already been paid off.
      gui_fallback_count: gui.length,
      gui_awaiting_replacement: gui.filter((item) => item.replacement_required === true).length,
      replaced_count: replacements.length,
      replaced_actions: replacements.map((item) => ({ action_id: item.action_id,
        from: item.from_access_kind, to: item.to_access_kind, at: item.replaced_at }))
        .sort((left, right) => String(left.at).localeCompare(String(right.at))),
      // 13.3's scale: three is a fallback, thirty is a brittle layer. Reported rather than
      // judged, because the threshold is a reading, not a rule.
      scale: gui.length >= 30 ? "brittle_layer" : gui.length > 3 ? "growing" : "fallback" };
  }

  get(args: JsonObject): JsonObject {
    return { action: this.store.get("capability_action", identifier(args.action_id, "action_id")) };
  }

  list(args: JsonObject = {}): JsonObject {
    const accessKind = args.access_kind === undefined ? null : text(args.access_kind, "access_kind");
    if (accessKind !== null && !ACCESS_KINDS.has(accessKind)) throw new Error("access_kind is unsupported");
    return { actions: this.store.list("capability_action", 1_000, (item) => accessKind === null || item.access_kind === accessKind) };
  }

  /**
   * The shape an action presents to the action gate and the receipt engine.
   *
   * Returned as a projection rather than the stored record so the two consumers see exactly
   * the fields they need, and a change to storage does not silently change what the gate
   * checks. `risk_level` feeds the gate (6.1) and `receipt_format` feeds the receipt (11.1);
   * keeping them in one place is what makes the base a base.
   */
  project(args: JsonObject): JsonObject {
    const action = this.store.get("capability_action", identifier(args.action_id, "action_id"));
    return { action_id: String(action.id), risk_level: action.risk_level,
      required_permission: action.required_permission, scope_invariants: action.scope_invariants,
      receipt_format: action.receipt_format, input: action.input, access_kind: action.access_kind };
  }
}
