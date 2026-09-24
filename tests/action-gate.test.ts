import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ActionGateKernel } from "../core/action-gate.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-action-gate-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, gate: new ActionGateKernel(store) };
}

/** The four facts an L1 decision needs, all of them satisfied. */
const selfCertifying = {
  checker: { kind: "deterministic_external", result: "passed", independent: true },
  receipt: { recomputable: true },
  failure_auto_discoverable: true,
};

const decide = (gate: ActionGateKernel, overrides: Record<string, unknown>) =>
  gate.decide({ action: "sync_offset", scope_kind: "project", scope_id: "p1", risk_level: "R0", ...selfCertifying, ...overrides }).decision as Record<string, unknown>;

test("only a deterministic independent checker admits an action to L1", async () => {
  const f = await fixture();
  try {
    const admitted = decide(f.gate, {});
    assert.equal(admitted.level, "L1");
    assert.equal(admitted.reason, "self_certifying");
    assert.equal(admitted.execution_authority, true);

    // Each self-checker is refused by name, not by a generic validation error: the
    // point of section 4.3 is that these are the executing model judging itself.
    for (const kind of ["llm_self_reflection", "llm_generated_test", "model_self_score"]) {
      const refused = decide(f.gate, { checker: { kind, result: "passed", independent: true } });
      assert.equal(refused.level, "L2", `${kind} must not reach L1`);
      assert.equal(refused.reason, "checker_is_not_independent");
      assert.equal(refused.execution_authority, false);
    }

    // A deterministic checker that runs inside the thing it checks is still not
    // independent, and saying so must not be mistaken for a malformed call.
    const notIndependent = decide(f.gate, { checker: { kind: "hardcoded_assertion", result: "passed", independent: false } });
    assert.equal(notIndependent.reason, "checker_not_independent_of_execution");

    assert.equal(decide(f.gate, { checker: { kind: "non_llm_compile", result: "failed", independent: true } }).reason, "checker_did_not_pass");
    assert.equal(decide(f.gate, { receipt: { recomputable: false } }).reason, "receipt_is_not_recomputable");
    assert.equal(decide(f.gate, { failure_auto_discoverable: false }).reason, "failure_is_not_auto_discoverable");
    assert.throws(() => f.gate.decide({ action: "a", scope_kind: "project", scope_id: "p", risk_level: "R0",
      checker: { kind: "unknown_kind", result: "passed" }, receipt: {}, failure_auto_discoverable: true }), /checker.kind is unsupported/);
  } finally { f.store.close(); }
});

test("risk level alone decides adjudication, and the Core Safety Floor is not adjudicable", async () => {
  const f = await fixture();
  try {
    // R1 is reversible but has external impact, so it may not run silently even when
    // every checker clause passes: the plan keeps R0 as the only silent level.
    const r1 = decide(f.gate, { risk_level: "R1" });
    assert.equal(r1.level, "L2");
    assert.equal(r1.reason, "risk_r1_requires_adjudication");
    assert.equal(r1.requires_approval, false);
    assert.equal(r1.notice_required, true);

    const r2 = decide(f.gate, { risk_level: "R2" });
    assert.equal(r2.requires_approval, true);

    const r3 = decide(f.gate, { risk_level: "R3" });
    assert.equal(r3.requires_approval, true);
    assert.equal(r3.requires_second_confirmation, true);
    assert.equal(r3.requires_approval_chain, true);

    // Production is not "an R3 someone may approve here": it blocks outright.
    const floor = decide(f.gate, { risk_level: "R1", core_safety_floor: true });
    assert.equal(floor.level, "blocked");
    assert.equal(floor.reason, "core_safety_floor");
    assert.equal(floor.effective_risk_level, "R3");
    assert.equal(floor.execution_authority, false);
  } finally { f.store.close(); }
});

test("a guard breach falls back to L2 and keeps the rule, while an invariant failure revokes it", async () => {
  const f = await fixture();
  try {
    const scope = { action: "reindex", scope_kind: "project", scope_id: "p1" };
    for (let i = 0; i < 3; i += 1) f.gate.recordApproval({ ...scope, actor: "u1" });
    const accepted = f.gate.acceptProposal({ ...scope, actor: "u1", invariant_digest: "sha256:semantics-v1",
      guard: [{ field: "affected_rows", op: "max", value: 10_000 }] });
    const ruleId = String((accepted.rule as Record<string, unknown>).id);

    // Inside the declared range: the rule lowers the effective risk to R0.
    const inside = f.gate.decide({ ...scope, risk_level: "R2", learned_rule_id: ruleId, invariant_digest: "sha256:semantics-v1",
      guard_values: { affected_rows: 5_000 }, ...selfCertifying }).decision as Record<string, unknown>;
    assert.equal(inside.effective_risk_level, "R0");
    assert.equal(inside.level, "L1");
    assert.equal(inside.reason, "learned_approval");

    // Omitting the premise is not "skip the invariant check": an unverifiable basis may
    // not lower the level, so the rule does not apply and the action is adjudicated.
    const unverifiable = f.gate.decide({ ...scope, risk_level: "R2", learned_rule_id: ruleId,
      guard_values: { affected_rows: 5_000 }, ...selfCertifying }).decision as Record<string, unknown>;
    assert.equal(unverifiable.reason, "invariant_unverifiable");
    assert.equal(unverifiable.level, "L2");
    assert.equal(unverifiable.effective_risk_level, "R2");
    assert.equal(unverifiable.requires_approval, true);
    // Not revoked for this: an unverifiable premise is not a falsified one.
    assert.equal((f.gate.getRule({ rule_id: ruleId }).rule as Record<string, unknown>).status, "active");

    // Outside the range: back to L2 for this action, and the rule survives. A busy
    // afternoon must not destroy a rule that is still true.
    const breach = f.gate.decide({ ...scope, risk_level: "R2", learned_rule_id: ruleId, invariant_digest: "sha256:semantics-v1",
      guard_values: { affected_rows: 1_000_000 }, ...selfCertifying }).decision as Record<string, unknown>;
    assert.equal(breach.level, "L2");
    assert.equal(breach.reason, "guard_violation");
    assert.equal(breach.guard_violation, "affected_rows");
    assert.equal(breach.requires_approval, true);
    assert.equal((f.gate.getRule({ rule_id: ruleId }).rule as Record<string, unknown>).status, "active");

    // A missing field is outside the range too: the rule was learned with it visible.
    const missing = f.gate.decide({ ...scope, risk_level: "R2", learned_rule_id: ruleId, invariant_digest: "sha256:semantics-v1",
      guard_values: {}, ...selfCertifying }).decision as Record<string, unknown>;
    assert.equal(missing.reason, "guard_violation");

    // 6.3.1's own example compares strings: `env == prod`. Equality accepts a string, and the
    // in-range branch is proven by a rule guarded on env staying L1 inside its scope. This rule
    // lives in its own scope: one action and scope can hold only one learned rule.
    const stringScope = { action: "reindex", scope_kind: "project", scope_id: "p2" };
    for (let index = 0; index < 3; index += 1) {
      f.gate.recordApproval({ ...stringScope, actor: "u1" });
    }
    const stringRule = f.gate.acceptProposal({ ...stringScope, actor: "u1", invariant_digest: "sha256:semantics-v1",
      guard: [{ field: "env", op: "eq", value: "eval" }] }).rule as Record<string, unknown>;
    const inScope = f.gate.decide({ ...stringScope, risk_level: "R2", learned_rule_id: String(stringRule.id),
      invariant_digest: "sha256:semantics-v1", guard_values: { env: "eval" }, ...selfCertifying })
      .decision as Record<string, unknown>;
    assert.equal(inScope.level, "L1");
    const outside = f.gate.decide({ ...stringScope, risk_level: "R2", learned_rule_id: String(stringRule.id),
      invariant_digest: "sha256:semantics-v1", guard_values: { env: "staging" }, ...selfCertifying })
      .decision as Record<string, unknown>;
    assert.equal(outside.reason, "guard_violation");
    // Equality is not coerced: "1" does not satisfy a numeric clause measured as 1. This rule
    // lives in its own scope, because one action and scope can hold only one learned rule.
    const numericScope = { action: "reindex", scope_kind: "project", scope_id: "p3" };
    for (let index = 0; index < 3; index += 1) {
      f.gate.recordApproval({ ...numericScope, actor: "u1" });
    }
    const numericRule = f.gate.acceptProposal({ ...numericScope, actor: "u1", invariant_digest: "sha256:semantics-v1",
      guard: [{ field: "affected_rows", op: "eq", value: 10 }] }).rule as Record<string, unknown>;
    const coerced = f.gate.decide({ ...numericScope, risk_level: "R2", learned_rule_id: String(numericRule.id),
      invariant_digest: "sha256:semantics-v1", guard_values: { affected_rows: "10" }, ...selfCertifying })
      .decision as Record<string, unknown>;
    assert.equal(coerced.reason, "guard_violation");
    const exact = f.gate.decide({ ...numericScope, risk_level: "R2", learned_rule_id: String(numericRule.id),
      invariant_digest: "sha256:semantics-v1", guard_values: { affected_rows: 10 }, ...selfCertifying })
      .decision as Record<string, unknown>;
    assert.equal(exact.level, "L1");

    // The premise moved: the rule is revoked, not merely bypassed.
    const falsified = f.gate.decide({ ...scope, risk_level: "R2", learned_rule_id: ruleId, invariant_digest: "sha256:semantics-v2",
      guard_values: { affected_rows: 1 }, ...selfCertifying }).decision as Record<string, unknown>;
    assert.equal(falsified.reason, "invariant_falsified");
    assert.equal(falsified.invariant_falsified, true);
    const revoked = f.gate.getRule({ rule_id: ruleId }).rule as Record<string, unknown>;
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revoked_reason, "invariant_falsified");

    // A revoked rule can no longer be used at all.
    assert.throws(() => f.gate.decide({ ...scope, risk_level: "R2", learned_rule_id: ruleId, ...selfCertifying }), /not active/);
  } finally { f.store.close(); }
});

test("learned approval requires a consecutive streak, and a guard breach resets it", async () => {
  const f = await fixture();
  try {
    const scope = { action: "reindex", scope_kind: "project", scope_id: "p1" };
    assert.equal(f.gate.recordApproval({ ...scope, actor: "u1" }).proposal, null);
    assert.equal(f.gate.recordApproval({ ...scope, actor: "u1" }).proposal, null);
    // Below threshold: accepting is refused rather than silently creating a rule.
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u1", invariant_digest: "sha256:v1", guard: [] }), /consecutive approval streak/);

    const third = f.gate.recordApproval({ ...scope, actor: "u1" });
    assert.deepEqual((third.proposal as Record<string, unknown>).observed_approvals, 3);

    // A guard breach resets the streak, so out-of-range approvals cannot be counted
    // toward re-earning the rule.
    const accepted = f.gate.acceptProposal({ ...scope, actor: "u1", invariant_digest: "sha256:v1",
      guard: [{ field: "affected_rows", op: "max", value: 10 }] });
    const ruleId = String((accepted.rule as Record<string, unknown>).id);
    f.gate.decide({ ...scope, risk_level: "R2", learned_rule_id: ruleId, invariant_digest: "sha256:v1",
      guard_values: { affected_rows: 99 }, ...selfCertifying });
    // The breach reset the streak, so the next approval starts a new run at 1 rather
    // than continuing the three that earned the rule.
    const afterBreach = f.gate.recordApproval({ ...scope, actor: "u1" });
    assert.equal(Number((afterBreach.streak as Record<string, unknown>).consecutive), 1);

    // An independent scope keeps its own streak.
    const other = f.gate.recordApproval({ action: "reindex", scope_kind: "project", scope_id: "p2", actor: "u1" });
    assert.equal(Number((other.streak as Record<string, unknown>).consecutive), 1);
    assert.equal(other.proposal, null);
  } finally { f.store.close(); }
});

test("guard clauses are validated and an empty guard is a deliberate statement", async () => {
  const f = await fixture();
  try {
    const scope = { action: "a", scope_kind: "project", scope_id: "p" };
    for (let i = 0; i < 2; i += 1) f.gate.recordApproval({ ...scope, actor: "u", learn_threshold: 2 });

    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d", learn_threshold: 2,
      guard: [{ field: "x", op: "nope", value: 1 }] }), /guard\[0\]\.op is unsupported/);
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d", learn_threshold: 2,
      guard: [{ field: "x", op: "in", value: [] }] }), /non-empty array/);
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d", learn_threshold: 2,
      guard: "nope" }), /guard must be an array/);
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d", learn_threshold: 2,
      guard: [{ field: "bad field!", op: "max", value: 1 }] }), /unsupported characters/);
    // Non-numeric bound for a comparison op is rejected at declaration time rather than
    // silently comparing against NaN at decision time.
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d", learn_threshold: 2,
      guard: [{ field: "x", op: "max", value: "many" }] }), /must be a number/);

    // Empty guard = holds for every input; the rule then lowers risk unconditionally.
    const accepted = f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d", learn_threshold: 2, guard: [] });
    const ruleId = String((accepted.rule as Record<string, unknown>).id);
    assert.equal((accepted.rule as Record<string, unknown>).execution_authority, false);
    const decision = f.gate.decide({ ...scope, risk_level: "R3", learned_rule_id: ruleId, invariant_digest: "d", guard_values: {}, ...selfCertifying })
      .decision as Record<string, unknown>;
    assert.equal(decision.effective_risk_level, "R0");
    // R3 still keeps its second confirmation even when a learned rule lowers the level:
    // the rule was learned about a bounded action, and R3 is not that.
    assert.equal(decision.level, "L1");

    // Re-accepting the identical proposal is an idempotent replay, not a second rule.
    const replay = f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d", learn_threshold: 2, guard: [] });
    assert.equal(replay.idempotent, true);
    assert.equal((replay.rule as Record<string, unknown>).id, ruleId);
    // The same scope with a different premise is a different rule and is refused while
    // one is already active, rather than silently minting a second.
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d2", learn_threshold: 2, guard: [] }),
      /idempotency conflict/);
  } finally { f.store.close(); }
});

test("every guard operator is enforced, and a non-numeric actual is outside the range", async () => {
  const f = await fixture();
  try {
    const scope = { action: "bounded", scope_kind: "project", scope_id: "p" };
    for (let i = 0; i < 2; i += 1) f.gate.recordApproval({ ...scope, actor: "u", learn_threshold: 2 });
    const accepted = f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d", learn_threshold: 2, guard: [
      { field: "rows", op: "max", value: 100 },
      { field: "workers", op: "min", value: 2 },
      { field: "retries", op: "eq", value: 0 },
      { field: "env", op: "in", value: ["eval", "test"] },
    ] });
    const ruleId = String((accepted.rule as Record<string, unknown>).id);
    const run = (guardValues: Record<string, unknown>) => f.gate.decide({ ...scope, risk_level: "R2", learned_rule_id: ruleId,
      invariant_digest: "d", guard_values: guardValues, ...selfCertifying }).decision as Record<string, unknown>;

    const ok = run({ rows: 100, workers: 2, retries: 0, env: "eval" });
    assert.equal(ok.reason, "learned_approval");

    assert.equal(run({ rows: 101, workers: 2, retries: 0, env: "eval" }).guard_violation, "rows");
    assert.equal(run({ rows: 1, workers: 1, retries: 0, env: "eval" }).guard_violation, "workers");
    assert.equal(run({ rows: 1, workers: 2, retries: 1, env: "eval" }).guard_violation, "retries");
    assert.equal(run({ rows: 1, workers: 2, retries: 0, env: "prod" }).guard_violation, "env");
    // A field present but not a number cannot satisfy a comparison, so it is outside.
    assert.equal(run({ rows: "100", workers: 2, retries: 0, env: "eval" }).guard_violation, "rows");
    // Omitting the context entirely is not "no bounds apply": every declared field is
    // unobservable, so the first clause reports as violated.
    const noContext = f.gate.decide({ ...scope, risk_level: "R2", learned_rule_id: ruleId, invariant_digest: "d", ...selfCertifying })
      .decision as Record<string, unknown>;
    assert.equal(noContext.reason, "guard_violation");
    assert.equal(noContext.guard_violation, "rows");
  } finally { f.store.close(); }
});

test("a rule cannot be applied to a different action or scope", async () => {
  const f = await fixture();
  try {
    const scope = { action: "reindex", scope_kind: "project", scope_id: "p1" };
    for (let i = 0; i < 2; i += 1) f.gate.recordApproval({ ...scope, actor: "u", learn_threshold: 2 });
    const accepted = f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d", learn_threshold: 2, guard: [] });
    const ruleId = String((accepted.rule as Record<string, unknown>).id);

    // Borrowing another action's rule is refused rather than quietly widening its scope.
    assert.throws(() => f.gate.decide({ action: "other", scope_kind: "project", scope_id: "p1", risk_level: "R2",
      learned_rule_id: ruleId, ...selfCertifying }), /belongs to another action or scope/);
    assert.throws(() => f.gate.decide({ ...scope, scope_id: "p2", risk_level: "R2",
      learned_rule_id: ruleId, ...selfCertifying }), /belongs to another action or scope/);
    assert.throws(() => f.gate.decide({ ...scope, risk_level: "R2", learned_rule_id: "missing", ...selfCertifying }), /Unknown learned_approval/);

    // A rule already active for the scope suppresses a fresh proposal.
    const again = f.gate.recordApproval({ ...scope, actor: "u", learn_threshold: 2 });
    assert.equal(again.proposal, null);
    assert.equal(again.active_rule_id, ruleId);
    assert.equal((f.gate.listRules(scope).rules as unknown[]).length, 1);
  } finally { f.store.close(); }
});

test("env == prod is the Core Safety Floor even when the caller omits the flag", async () => {
  const f = await fixture();
  try {
    const scope = { action: "reindex", scope_kind: "project", scope_id: "p1" };
    const selfCertifying = { checker: { kind: "deterministic_external", checker: "tsc", result: "passed", independent: true },
      receipt: { recomputable: true }, failure_auto_discoverable: true };
    f.gate.decide({ ...scope, risk_level: "R0", ...selfCertifying });
    for (let index = 0; index < 3; index += 1) {
      f.gate.recordApproval({ ...scope, actor: "u1" });
    }
    f.gate.acceptProposal({ ...scope, actor: "u1", invariant_digest: "sha256:semantics-v1",
      guard: [{ field: "env", op: "eq", value: "eval" }] });
    const ruleId = String((f.gate.listRules(scope).rules as Record<string, unknown>[])[0]!.id);
    // 6.3.1: a production write is hard-blocked, not "out of range, confirm once". The floor is
    // detected from the action's own context, so omitting the flag cannot let it degrade into
    // an L2 confirmation — and a learned rule is never consulted on the way there.
    const blocked = f.gate.decide({ ...scope, risk_level: "R0", learned_rule_id: ruleId,
      invariant_digest: "sha256:semantics-v1", guard_values: { env: "prod" }, ...selfCertifying })
      .decision as Record<string, unknown>;
    assert.equal(blocked.level, "blocked");
    assert.equal(blocked.reason, "core_safety_floor");
    assert.equal(blocked.guard_violation, "env");
    assert.equal(blocked.requires_approval_chain, true);
    // The rule that was scoped to eval is untouched: prod is not a guard breach against it.
    assert.equal((f.gate.getRule({ rule_id: ruleId }).rule as Record<string, unknown>).status, "active");

    // The explicit flag still blocks on its own, with no context to detect.
    const flagged = f.gate.decide({ ...scope, risk_level: "R0", core_safety_floor: true, ...selfCertifying });
    assert.equal((flagged.decision as Record<string, unknown>).level, "blocked");
  } finally { f.store.close(); }
});

test("guard clauses refuse malformed values by name", async () => {
  const f = await fixture();
  try {
    const scope = { action: "reindex", scope_kind: "project", scope_id: "p1" };
    // `eq` accepts numbers and strings; everything else is refused, including objects and
    // arrays, which would otherwise be silently compared by reference.
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u1", invariant_digest: "sha256:v1",
      guard: [{ field: "env", op: "eq", value: { a: 1 } }] }), /must be a number or string for "eq"/);
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u1", invariant_digest: "sha256:v1",
      guard: [{ field: "env", op: "eq", value: ["eval"] }] }), /must be a number or string for "eq"/);
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u1", invariant_digest: "sha256:v1",
      guard: [{ field: "env", op: "eq", value: true }] }), /must be a number or string for "eq"/);
    // `max` and `min` remain numeric-only: ordering a string is not a defined comparison.
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u1", invariant_digest: "sha256:v1",
      guard: [{ field: "affected_rows", op: "max", value: "many" }] }), /must be a number/);
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u1", invariant_digest: "sha256:v1",
      guard: [{ field: "affected_rows", op: "min", value: "few" }] }), /must be a number/);
  } finally { f.store.close(); }
});

test("decisions are persisted, idempotent, and carry no execution authority below L1", async () => {
  const f = await fixture();
  try {
    const first = f.gate.decide({ action: "sync_offset", scope_kind: "project", scope_id: "p1", risk_level: "R0", ...selfCertifying });
    const again = f.gate.decide({ action: "sync_offset", scope_kind: "project", scope_id: "p1", risk_level: "R0", ...selfCertifying });
    assert.equal(again.idempotent, true);
    assert.equal((first.decision as Record<string, unknown>).id, (again.decision as Record<string, unknown>).id);
    assert.equal((first.decision as Record<string, unknown>).content_stored, false);

    // The record answers "why did this not ask" after the fact.
    const stored = f.store.get("action_gate_decision", String((first.decision as Record<string, unknown>).id));
    assert.equal(stored.reason, "self_certifying");
    assert.equal(stored.checker_kind, "deterministic_external");

    // A different reason is a different decision, not an idempotent replay.
    const l2 = f.gate.decide({ action: "sync_offset", scope_kind: "project", scope_id: "p1", risk_level: "R2", ...selfCertifying });
    assert.notEqual((l2.decision as Record<string, unknown>).id, (first.decision as Record<string, unknown>).id);
    assert.equal((l2.decision as Record<string, unknown>).execution_authority, false);

    assert.throws(() => f.gate.decide({ action: "bad action!", scope_kind: "project", scope_id: "p", risk_level: "R0", ...selfCertifying }), /unsupported characters/);
    assert.throws(() => f.gate.decide({ action: "a", scope_kind: "project", scope_id: "p", risk_level: "R9", ...selfCertifying }), /must be one of R0, R1, R2, R3/);
    assert.equal(f.gate.getRule({ rule_id: "missing" }).rule, null);
    assert.deepEqual(f.gate.listRules({ action: "reindex", scope_kind: "project", scope_id: "none" }).rules, []);
  } finally { f.store.close(); }
});

test("malformed inputs are refused by name rather than coerced", async () => {
  const f = await fixture();
  try {
    const base = { action: "a", scope_kind: "project", scope_id: "p", risk_level: "R0", ...selfCertifying };
    // A boolean flag that is present but not a boolean is an error, not a truthy value:
    // silently reading "yes" as true would let a string widen the safety floor.
    assert.throws(() => f.gate.decide({ ...base, core_safety_floor: "yes" }), /core_safety_floor must be a boolean/);
    assert.throws(() => f.gate.decide({ ...base, checker: { kind: "non_llm_compile", result: "maybe" } }), /checker.result is unsupported/);
    assert.throws(() => f.gate.decide({ ...base, checker: { kind: "non_llm_compile", result: "passed", independent: "no" } }),
      /checker.independent must be a boolean/);
    assert.throws(() => f.gate.decide({ ...base, receipt: { recomputable: 1 } }), /receipt.recomputable must be a boolean/);

    const scope = { action: "a", scope_kind: "project", scope_id: "p" };
    assert.throws(() => f.gate.recordApproval({ ...scope, actor: "u", learn_threshold: 0 }), /between 1 and 100/);
    assert.throws(() => f.gate.recordApproval({ ...scope, actor: "u", learn_threshold: 1.5 }), /between 1 and 100/);

    // The guard key must be present: omitting it is the mistake that lets a bounded rule
    // become unbounded, so it is refused instead of defaulting to [].
    for (let i = 0; i < 2; i += 1) f.gate.recordApproval({ ...scope, actor: "u", learn_threshold: 2 });
    assert.throws(() => f.gate.acceptProposal({ ...scope, actor: "u", invariant_digest: "d", learn_threshold: 2 }),
      /requires an explicit guard declaration/);

    // No streak at all is the same refusal as a streak below threshold.
    assert.throws(() => f.gate.acceptProposal({ action: "never_approved", scope_kind: "project", scope_id: "p",
      actor: "u", invariant_digest: "d", learn_threshold: 2, guard: [] }), /consecutive approval streak/);
  } finally { f.store.close(); }
});
