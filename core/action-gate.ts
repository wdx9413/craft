import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

/**
 * The action gate: which interaction level an action earns, and why.
 *
 * This kernel implements the decision half of the workbench plan (sections 4.2, 4.3,
 * 6.1, 6.2, 6.3.1). It exists because the surrounding kernels each answer a different
 * question and none of them answers this one:
 *
 *  - `uncertainty-policy.ts` decides *how much more proof to collect* when a model is
 *    unsure. Its `UncertaintyResolution` explicitly grants no execution authority.
 *  - `attention.ts` projects *what currently deserves a human's attention*; it is a
 *    derived read model with no opinion on level.
 *  - `verification-plane.ts` plans *which checks a code change needs*, keyed to its own
 *    low/moderate/high/critical scale for verification effort.
 *
 * None of them decides "may this run silently, or does it need a signature". That is
 * this kernel, and the plan is specific about what the answer may depend on:
 *
 *  - **Not the model's confidence.** A system that grades its own work will eventually
 *    grade it wrong, and the failure is silent. `confidence_score` may order or warn;
 *    it may never gate. So L1 requires a checker that is independent of the execution
 *    *and deterministic* (section 4.3) — an external system, a hardcoded assertion, or
 *    a non-LLM compile/parse node. An LLM re-reading its own output is not a checker.
 *  - **Not the risk level alone.** Only R0 may run silently (section 6.1), and R0 is a
 *    claim about reversibility and blast radius, not about how sure anyone feels.
 *  - **Not an approval count alone.** "Learn not to ask" (section 6.2) is bounded by
 *    the conditions the rule was learned under. Two kinds of boundary are kept apart
 *    (section 6.3.1) because conflating them causes one of two accidents:
 *
 *    | kind | meaning | consequence |
 *    | --- | --- | --- |
 *    | Guard | this action is outside the rule's declared range | fall back to L2, keep the rule |
 *    | Invariant | the premise the rule was learned on no longer holds | revoke the rule |
 *
 *    Treating a guard breach as an invariant failure destroys a good rule on one busy
 *    afternoon; treating an invariant failure as a guard breach keeps applying a rule
 *    whose premise is gone. The production-environment case is neither: it is the Core
 *    Safety Floor, which blocks and cannot be adjudicated (`uncertainty-policy.ts`
 *    enforces the same rule for its own resolutions).
 */

export type RiskLevel = "R0" | "R1" | "R2" | "R3";
export type InteractionLevel = "L1" | "L2" | "blocked";

const RISK_RANK: Readonly<Record<RiskLevel, number>> = { R0: 0, R1: 1, R2: 2, R3: 3 };
const RISK_LEVELS = new Set<string>(Object.keys(RISK_RANK));

/**
 * Checker kinds, split by whether the checker is independent of the execution.
 *
 * The right-hand set is not "weaker checkers". They are not checkers at all for this
 * purpose: each one is the executing model's own judgement wearing a different hat, and
 * section 4.3 forbids all of them as an L1 basis. They remain accepted as *input* so a
 * caller that supplies one gets an explicit refusal naming the reason, rather than a
 * generic validation error that hides which rule it broke.
 */
const INDEPENDENT_CHECKERS = new Set(["deterministic_external", "hardcoded_assertion", "non_llm_compile"]);
const SELF_CHECKERS = new Set(["llm_self_reflection", "llm_generated_test", "model_self_score"]);
const CHECKER_KINDS = new Set([...INDEPENDENT_CHECKERS, ...SELF_CHECKERS]);

const GUARD_OPS = new Set(["max", "min", "eq", "in"]);
const DEFAULT_LEARN_THRESHOLD = 3;

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}
function optionalBoolean(value: unknown, name: string): boolean {
  return value === undefined ? false : boolean(value, name);
}
function number(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${name} must be a number`);
  return result;
}
function positiveInteger(value: unknown, name: string, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 100) throw new Error(`${name} must be an integer between 1 and 100`);
  return result;
}
function riskLevel(value: unknown, name: string): RiskLevel {
  const result = text(value, name);
  if (!RISK_LEVELS.has(result)) throw new Error(`${name} must be one of R0, R1, R2, R3`);
  return result as RiskLevel;
}
function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[a-zA-Z0-9_.:-]{1,200}$/u.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}

/**
 * A guard clause: one declared bound on the conditions the rule was learned under.
 *
 * `value` is not optional here — the caller checks for an absent `guard` key first, so
 * this only ever sees a declared array.
 */
type GuardClause = { field: string; op: string; value: unknown };

function guardClauses(value: unknown): GuardClause[] {
  if (!Array.isArray(value)) throw new Error("guard must be an array of clauses");
  return value.map((raw, index) => {
    const clause = object(raw, `guard[${index}]`);
    const op = text(clause.op, `guard[${index}].op`);
    if (!GUARD_OPS.has(op)) throw new Error(`guard[${index}].op is unsupported`);
    const field = identifier(clause.field, `guard[${index}].field`);
    if (op === "in") {
      if (!Array.isArray(clause.value) || !clause.value.length) throw new Error(`guard[${index}].value must be a non-empty array for "in"`);
    } else if (op === "eq") {
      // `eq` compares identity, and identity is not always numeric: 6.3.1's own example is
      // `env == prod`. Refusing strings here would make the section's canonical case
      // inexpressible, so both a number and a string are accepted for this operator.
      if (typeof clause.value !== "number" && typeof clause.value !== "string") {
        throw new Error(`guard[${index}].value must be a number or string for "eq"`);
      }
    } else {
      number(clause.value, `guard[${index}].value`);
    }
    return { field, op, value: clause.value };
  });
}

/**
 * Evaluate guard clauses against the current action context.
 *
 * Returns the first violated field name, or `null` when every clause holds. A field the
 * context does not carry counts as violated: the rule was learned with that field
 * observable, so an action that cannot show it is outside the range, not inside it.
 */
function firstGuardViolation(clauses: readonly GuardClause[], values: JsonObject): string | null {
  for (const clause of clauses) {
    const actual = values[clause.field];
    if (actual === undefined) return clause.field;
    if (clause.op === "in") {
      if (!(clause.value as unknown[]).includes(actual)) return clause.field;
      continue;
    }
    // Equality is the one operator that compares non-numeric identity. Both sides are compared
    // as their own types rather than coerced, because `"1" == 1` being true would let a
    // stringly-typed context satisfy a numeric clause it was never measured against.
    if (clause.op === "eq") { if (actual !== clause.value) return clause.field; continue; }
    if (typeof actual !== "number") return clause.field;
    const expected = Number(clause.value);
    if (clause.op === "max" && actual > expected) return clause.field;
    if (clause.op === "min" && actual < expected) return clause.field;
  }
  return null;
}

export class ActionGateKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Decide the interaction level for one action.
   *
   * The decision is persisted, because "why did this run without asking" is a question
   * that gets asked after the fact and cannot be answered from a log line that only
   * records the outcome.
   */
  decide(args: JsonObject): JsonObject {
    const action = identifier(args.action, "action");
    const scopeKind = identifier(args.scope_kind, "scope_kind");
    const scopeId = identifier(args.scope_id, "scope_id");
    const declared = riskLevel(args.risk_level, "risk_level");
    const coreSafetyFloor = optionalBoolean(args.core_safety_floor, "core_safety_floor");

    const checker = object(args.checker, "checker");
    const checkerKind = text(checker.kind, "checker.kind");
    if (!CHECKER_KINDS.has(checkerKind)) throw new Error("checker.kind is unsupported");
    const checkerResult = text(checker.result, "checker.result");
    if (!new Set(["passed", "failed"]).has(checkerResult)) throw new Error("checker.result is unsupported");
    const checkerIndependent = optionalBoolean(checker.independent, "checker.independent");

    const receipt = object(args.receipt, "receipt");
    const recomputable = optionalBoolean(receipt.recomputable, "receipt.recomputable");
    const failureAutoDiscoverable = optionalBoolean(args.failure_auto_discoverable, "failure_auto_discoverable");

    // The Core Safety Floor blocks before anything else is considered: an action that
    // touches production is not "an R3 that a human may approve here".
    if (coreSafetyFloor) {
      return this.#persist({ action, scopeKind, scopeId, declared, effective: "R3", level: "blocked",
        reason: "core_safety_floor", requiresApproval: true, requiresSecondConfirmation: true, requiresApprovalChain: true,
        noticeRequired: true, checkerKind, learnedRuleId: null, guardViolation: null, invariantFalsified: false });
    }
    // 6.3.1 names `env == prod` as the floor itself rather than a Guard: a production write is
    // hard-blocked, and human adjudication cannot override it (uncertainty-policy.ts:54). The
    // floor is therefore detected from the action's own context instead of only from the flag
    // above, because a caller who forgets the flag would otherwise see a production write
    // degrade into a guard violation and an L2 confirmation — the exact outcome the section
    // forbids. A learned rule is consulted after this point, so it can never fire in prod.
    const guardValues = object(args.guard_values ?? {}, "guard_values");
    if (guardValues.env !== undefined && String(guardValues.env) === "prod") {
      return this.#persist({ action, scopeKind, scopeId, declared, effective: "R3", level: "blocked",
        reason: "core_safety_floor", requiresApproval: true, requiresSecondConfirmation: true, requiresApprovalChain: true,
        noticeRequired: true, checkerKind, learnedRuleId: null, guardViolation: "env", invariantFalsified: false });
    }

    // A learned rule is consulted next, because it is the only input that can *lower*
    // the effective risk. It is also the only input that can be wrong in two distinct
    // ways, so each way is reported separately and only one of them revokes the rule.
    let effective: RiskLevel = declared;
    let learnedRuleId: string | null = null;
    let guardViolation: string | null = null;
    let invariantFalsified = false;
    let invariantUnverifiable = false;
    let learnedReason: string | null = null;

    if (args.learned_rule_id !== undefined) {
      const ruleId = identifier(args.learned_rule_id, "learned_rule_id");
      const rule = this.store.get("learned_approval", ruleId);
      if (rule.status !== "active") throw new Error("Learned approval rule is not active");
      if (String(rule.action) !== action || String(rule.scope_kind) !== scopeKind || String(rule.scope_id) !== scopeId) {
        throw new Error("Learned approval rule belongs to another action or scope");
      }
      learnedRuleId = ruleId;
      // The current premise must be supplied. Omitting it is not "skip the check": a
      // rule whose premise cannot be compared is a rule that cannot be verified, and
      // section 4.3's fail-closed rule says an unverifiable basis may not lower the
      // level. So an absent digest falls back to L2 instead of applying the rule.
      const supplied = args.invariant_digest === undefined ? null : text(args.invariant_digest, "invariant_digest");
      if (supplied === null) {
        invariantUnverifiable = true;
        this.#resetStreak(action, scopeKind, scopeId);
      } else if (supplied !== String(rule.invariant_digest)) {
        // The premise moved. The rule cannot be trusted for this action or any later one.
        invariantFalsified = true;
        this.#revokeRule(rule, "invariant_falsified");
        this.#resetStreak(action, scopeKind, scopeId);
      } else {
        guardViolation = firstGuardViolation(rule.guard as GuardClause[], guardValues);
        if (guardViolation !== null) {
          // Outside the declared range, but the premise is intact: fall back to L2 for
          // this action and keep the rule. Resetting the streak is what stops a burst
          // of out-of-range actions from re-earning the rule on the strength of the
          // approvals that created it.
          this.#resetStreak(action, scopeKind, scopeId);
        } else {
          effective = "R0";
          learnedReason = "learned_approval";
        }
      }
    }

    const level = this.#levelFor(effective, { checkerKind, checkerResult, checkerIndependent, recomputable, failureAutoDiscoverable });
    const reason = invariantFalsified ? "invariant_falsified"
      : invariantUnverifiable ? "invariant_unverifiable"
        : guardViolation !== null ? "guard_violation"
          : learnedReason ?? level.reason;

    return this.#persist({ action, scopeKind, scopeId, declared, effective, level: level.level, reason,
      requiresApproval: level.requiresApproval || guardViolation !== null || invariantFalsified || invariantUnverifiable,
      requiresSecondConfirmation: level.requiresSecondConfirmation, requiresApprovalChain: level.requiresApprovalChain,
      noticeRequired: level.noticeRequired || guardViolation !== null || invariantFalsified || invariantUnverifiable,
      checkerKind, learnedRuleId, guardViolation, invariantFalsified });
  }

  /**
   * The L1 gate itself (sections 4.2 and 4.3).
   *
   * Every clause is required. The one worth naming is `independent`: a caller may pass
   * `checker.independent: false` with a deterministic kind, which is the honest way to
   * say "this assertion runs inside the thing it checks". It fails the gate, and the
   * reason string says which clause failed rather than only that something did.
   */
  #levelFor(risk: RiskLevel, facts: {
    checkerKind: string; checkerResult: string; checkerIndependent: boolean;
    recomputable: boolean; failureAutoDiscoverable: boolean;
  }): { level: InteractionLevel; reason: string; requiresApproval: boolean; requiresSecondConfirmation: boolean; requiresApprovalChain: boolean; noticeRequired: boolean } {
    const base = {
      requiresSecondConfirmation: risk === "R3",
      requiresApprovalChain: risk === "R3",
      noticeRequired: risk === "R1",
    };
    if (RISK_RANK[risk] > 0) {
      return { ...base, level: "L2", reason: `risk_${risk.toLowerCase()}_requires_adjudication`, requiresApproval: RISK_RANK[risk] >= 2 };
    }
    if (!INDEPENDENT_CHECKERS.has(facts.checkerKind)) {
      return { ...base, level: "L2", reason: "checker_is_not_independent", requiresApproval: false };
    }
    if (!facts.checkerIndependent) {
      return { ...base, level: "L2", reason: "checker_not_independent_of_execution", requiresApproval: false };
    }
    if (facts.checkerResult !== "passed") {
      return { ...base, level: "L2", reason: "checker_did_not_pass", requiresApproval: false };
    }
    if (!facts.recomputable) {
      return { ...base, level: "L2", reason: "receipt_is_not_recomputable", requiresApproval: false };
    }
    if (!facts.failureAutoDiscoverable) {
      return { ...base, level: "L2", reason: "failure_is_not_auto_discoverable", requiresApproval: false };
    }
    return { ...base, level: "L1", reason: "self_certifying", requiresApproval: false };
  }

  #persist(facts: {
    action: string; scopeKind: string; scopeId: string; declared: RiskLevel; effective: RiskLevel;
    level: InteractionLevel; reason: string; requiresApproval: boolean; requiresSecondConfirmation: boolean;
    requiresApprovalChain: boolean; noticeRequired: boolean; checkerKind: string;
    learnedRuleId: string | null; guardViolation: string | null; invariantFalsified: boolean;
  }): JsonObject {
    const identity = { action: facts.action, scope_kind: facts.scopeKind, scope_id: facts.scopeId,
      declared_risk_level: facts.declared, effective_risk_level: facts.effective, level: facts.level, reason: facts.reason,
      checker_kind: facts.checkerKind, learned_rule_id: facts.learnedRuleId, guard_violation: facts.guardViolation,
      invariant_falsified: facts.invariantFalsified };
    const decisionId = `action_gate_${digestJson(identity).slice(-24)}`;
    const existing = this.store.find("action_gate_decision", decisionId);
    if (existing) return { decision: existing, idempotent: true };
    const decision = this.store.create("action_gate_decision", decisionId, { ...identity, identity_digest: digestJson(identity),
      requires_approval: facts.requiresApproval, requires_second_confirmation: facts.requiresSecondConfirmation,
      requires_approval_chain: facts.requiresApprovalChain, notice_required: facts.noticeRequired,
      execution_authority: facts.level === "L1", content_stored: false });
    return { decision, idempotent: false };
  }

  /**
   * Record one human approval of an action in a scope.
   *
   * Consecutive is the point: the count is reset by any guard breach, so a rule is
   * earned by a run of approvals that were all inside the range the rule will claim.
   */
  recordApproval(args: JsonObject): JsonObject {
    const action = identifier(args.action, "action");
    const scopeKind = identifier(args.scope_kind, "scope_kind");
    const scopeId = identifier(args.scope_id, "scope_id");
    const actor = text(args.actor, "actor");
    const threshold = positiveInteger(args.learn_threshold, "learn_threshold", DEFAULT_LEARN_THRESHOLD);
    const streakId = `approval_streak_${digestJson({ action, scopeKind, scopeId }).slice(-24)}`;
    const existing = this.store.find("approval_streak", streakId);
    const consecutive = (existing === null ? 0 : Number(existing.consecutive)) + 1;
    const streak = existing === null
      ? this.store.create("approval_streak", streakId, { action, scope_kind: scopeKind, scope_id: scopeId, consecutive, last_actor: actor })
      : this.store.save("approval_streak", streakId, { ...payload(existing), consecutive, last_actor: actor });
    const activeRule = this.#activeRule(action, scopeKind, scopeId);
    const proposal = consecutive >= threshold && activeRule === null
      ? { action, scope_kind: scopeKind, scope_id: scopeId, observed_approvals: consecutive, threshold }
      : null;
    return { streak, proposal, active_rule_id: activeRule === null ? null : String(activeRule.id) };
  }

  /**
   * Accept a proposal: bind a learned rule to the conditions it was learned under.
   *
   * `guard` is required and may be empty, but it is never inferred. An empty guard is a
   * deliberate statement that the rule holds for every input; inferring bounds from the
   * approvals that happened to occur would make the rule silently broader than its
   * evidence. `invariant_digest` names the premise — the action's semantics — so a later
   * change to that premise can falsify the rule instead of being read as a guard breach.
   */
  acceptProposal(args: JsonObject): JsonObject {
    const action = identifier(args.action, "action");
    const scopeKind = identifier(args.scope_kind, "scope_kind");
    const scopeId = identifier(args.scope_id, "scope_id");
    const actor = text(args.actor, "actor");
    const threshold = positiveInteger(args.learn_threshold, "learn_threshold", DEFAULT_LEARN_THRESHOLD);
    const invariantDigest = text(args.invariant_digest, "invariant_digest");
    // The guard key is required even when it is empty. Forgetting to declare bounds is
    // exactly the mistake that turns "reindex 10k rows" into "reindex 100M rows", so an
    // absent key is an error while `[]` is a deliberate claim that no bound applies.
    if (args.guard === undefined) {
      throw new Error("Learned approval requires an explicit guard declaration; pass [] to state that no bound applies");
    }
    const guard = guardClauses(args.guard);
    const streakId = `approval_streak_${digestJson({ action, scopeKind, scopeId }).slice(-24)}`;
    const streak = this.store.find("approval_streak", streakId);
    if (streak === null) throw new Error("Learned approval requires a consecutive approval streak at or above the threshold");
    if (Number(streak.consecutive) < threshold) {
      throw new Error("Learned approval requires a consecutive approval streak at or above the threshold");
    }
    const ruleId = `learned_approval_${digestJson({ action, scopeKind, scopeId }).slice(-24)}`;
    const identity = { action, scope_kind: scopeKind, scope_id: scopeId, guard, invariant_digest: invariantDigest, actor, threshold };
    const identityDigest = digestJson(identity);
    const existing = this.store.find("learned_approval", ruleId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Learned approval rule idempotency conflict");
      return { rule: existing, idempotent: true };
    }
    return { rule: this.store.create("learned_approval", ruleId, { ...identity, identity_digest: identityDigest,
      status: "active", revoked_reason: null, execution_authority: false }), idempotent: false };
  }

  /** Read one learned rule, or `null`. */
  getRule(args: JsonObject): JsonObject {
    const ruleId = identifier(args.rule_id, "rule_id");
    return { rule: this.store.find("learned_approval", ruleId) };
  }

  /** Every learned rule for one action and scope, newest first. */
  listRules(args: JsonObject): JsonObject {
    const action = identifier(args.action, "action");
    const scopeKind = identifier(args.scope_kind, "scope_kind");
    const scopeId = identifier(args.scope_id, "scope_id");
    return { rules: this.store.list("learned_approval", 1_000, (item) =>
      item.action === action && item.scope_kind === scopeKind && item.scope_id === scopeId) };
  }

  #activeRule(action: string, scopeKind: string, scopeId: string): JsonObject | null {
    return this.store.list("learned_approval", 1_000, (item) =>
      item.action === action && item.scope_kind === scopeKind && item.scope_id === scopeId && item.status === "active")[0] ?? null;
  }

  /**
   * Zero a streak after the rule it produced stopped applying.
   *
   * Uses `get` rather than `find`: `acceptProposal` refuses to create a rule without a
   * streak, so reaching here with no streak record means the store lost a row it must
   * have. Reading it as absent and silently writing a fresh zero would hide that.
   */
  #resetStreak(action: string, scopeKind: string, scopeId: string): void {
    const streakId = `approval_streak_${digestJson({ action, scopeKind, scopeId }).slice(-24)}`;
    const existing = this.store.get("approval_streak", streakId);
    this.store.save("approval_streak", streakId, { ...payload(existing), consecutive: 0 });
  }

  /**
   * Revoke a rule whose premise moved.
   *
   * No status check: `decide` already refused an inactive rule before reaching the
   * falsification branch, so the only rule that can arrive here is active.
   */
  #revokeRule(rule: JsonObject, reason: string): void {
    this.store.save("learned_approval", String(rule.id), { ...payload(rule), status: "revoked", revoked_reason: reason });
  }
}
