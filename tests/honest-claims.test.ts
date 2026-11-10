import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HonestClaimsKernel } from "../core/honest-claims.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-honest-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, claims: new HonestClaimsKernel(store) };
}

test("4.4 routes to one of three outcomes, and an enumerable set is never a text box", async () => {
  const f = await fixture();
  try {
    // 能自证 → L1. A provable action must not be turned into a question.
    const l1 = f.claims.route({ subject: "s1", risk_level: "R0", can_self_certify: true });
    assert.equal(l1.outcome, "L1");
    assert.equal(l1.reason, "self_certifying_r0");
    assert.equal(l1.input_form, "none");
    // 不显示不是省略，是结论 — so L1 carries no input form at all.
    assert.equal(l1.failure_auto_discoverable, true);
    assert.equal(l1.l3_is_the_scarce_resource, false);

    // Self-certifying is not enough on its own: 4.2 requires R0.
    const notR0 = f.claims.route({ subject: "s2", risk_level: "R1", can_self_certify: true, options_enumerable: true, option_count: 3 });
    assert.equal(notR0.outcome, "L2_options");

    // 能枚举选项 → L2. 给选择题，不给填空题.
    const l2 = f.claims.route({ subject: "s3", risk_level: "R1", options_enumerable: true, option_count: 3 });
    assert.equal(l2.outcome, "L2_options");
    assert.equal(l2.input_form, "choose_from_set");
    assert.equal(l2.reason, "options_enumerable_offer_choices");
    assert.equal(l2.option_count, 3);

    // 无法枚举且无对应对象 → L3.
    const l3 = f.claims.route({ subject: "s4", risk_level: "R1" });
    assert.equal(l3.outcome, "L3_hatch");
    assert.equal(l3.input_form, "free_expression_one_shot");
    // 4.5: L3 is the scarce resource, so reaching it is flagged rather than normalised.
    assert.equal(l3.l3_is_the_scarce_resource, true);

    // With no enumerable set but an object already present, the honest route is the object's
    // own structured completion (5.3), not free expression.
    const withObject = f.claims.route({ subject: "s5", risk_level: "R1", has_object: true });
    assert.equal(withObject.outcome, "L2_options");
    assert.equal(withObject.reason, "no_enumerable_set_but_object_exists_use_structured_completion");
    assert.equal(withObject.option_count, null);

    // "Enumerable" with fewer than two options is a statement, not a choice.
    assert.throws(() => f.claims.route({ subject: "s6", risk_level: "R0", options_enumerable: true, option_count: 1 }),
      /an enumerable decision needs at least two options/);
    assert.throws(() => f.claims.route({ subject: "s6", risk_level: "R0", options_enumerable: true }),
      /an enumerable decision needs at least two options/);
    assert.throws(() => f.claims.route({ subject: "s6", risk_level: "R0", option_count: 3 }),
      /option_count is meaningless when options are not enumerable/);
    assert.throws(() => f.claims.route({ subject: "bad id!", risk_level: "R0" }), /unsupported characters/);
    assert.throws(() => f.claims.route({ subject: "s7", risk_level: "R9" }), /risk_level must be R0, R1, R2 or R3/);
  } finally { f.store.close(); }
});

test("4.6 will not report the L1 ratio without the checker count", async () => {
  const f = await fixture();
  try {
    // Before anything happens the ratio is null rather than 0: "no L1 yet" and "0% L1" are
    // different statements and only the first is true.
    const empty = f.claims.l1Report({});
    assert.equal(empty.l1_ratio, null);
    assert.equal(empty.note, "no_decisions_yet");
    assert.equal(empty.deterministic_checkers, 0);
    // The constraint travels on the payload so a caller cannot read the ratio and miss it.
    assert.equal(empty.ratio_requires_checker_count, true);

    f.claims.record({ subject: "a", risk_level: "R0", can_self_certify: true, recorded_at: "2030-01-01T00:00:00Z" });
    f.claims.record({ subject: "b", risk_level: "R1", options_enumerable: true, option_count: 2, recorded_at: "2030-01-01T00:00:01Z" });
    f.claims.record({ subject: "c", risk_level: "R2", recorded_at: "2030-01-01T00:00:02Z" });
    f.claims.record({ subject: "d", risk_level: "R0", can_self_certify: true, recorded_at: "2030-01-01T00:00:03Z" });

    // Checkers are read from what is actually attached, not asserted.
    f.store.create("capability_action", "checker_a", { access_kind: "api_mcp" });
    f.store.create("capability_action", "checker_b", { access_kind: "system_cli_db" });
    // A GUI fallback is not a deterministic checker.
    f.store.create("capability_action", "script_c", { access_kind: "gui_automation" });

    const report = f.claims.l1Report({});
    assert.equal(report.total_decisions, 4);
    // Two provable, one enumerable (b), and one that is neither certifiable nor enumerable
    // and has no object (c), so it is the L3 case 4.5 says should stay rare.
    assert.equal(report.l1_count, 2);
    assert.equal(report.l2_count, 1);
    assert.equal(report.l3_count, 1);
    assert.equal(report.l1_ratio, 0.5);
    assert.equal(report.deterministic_checkers, 2);
    assert.equal(report.note, "report_both_or_neither");

    // Recording the same decision twice is idempotent, so the report cannot be inflated by
    // repeating a decision.
    f.claims.record({ subject: "a", risk_level: "R0", can_self_certify: true, recorded_at: "2030-01-01T00:00:00Z",
      decision_id: "fixed" });
    f.claims.record({ subject: "a", risk_level: "R0", can_self_certify: true, recorded_at: "2030-01-01T00:00:09Z",
      decision_id: "fixed" });
    assert.equal(f.claims.l1Report({}).total_decisions, 5);
  } finally { f.store.close(); }
});

test("11.3 refuses a tamper-proof claim and supplies the accurate wording", async () => {
  const f = await fixture();
  try {
    const wording = f.claims.ledgerWording({});
    // The accurate sentence the plan gives, verbatim in substance.
    assert.match(String(wording.accurate_wording), /追加写.*版本可校验链/u);
    // The two facts it rests on, so a reader can check rather than trust.
    assert.equal(wording.append_only_domain_updates, true);
    assert.equal(wording.in_place_rewrite_path_exists, true);
    assert.equal(wording.prohibits_tamper_proof_claim, true);
    assert.equal(wording.claim_allowed, true);

    // A claim that overpromises is refused, in both languages, because the store has an
    // in-place rewrite path and the sentence is therefore false.
    for (const claim of ["本系统账本不可篡改", "tamper-proof ledger", "Immutable Log", "支持防篡改审计",
      "tamper-evident receipts"]) {
      const checked = f.claims.ledgerWording({ claim });
      assert.equal(checked.claim_allowed, false, claim);
      assert.match(String(checked.rejected_reason), /in-place rewrite path/u);
    }
    // The accurate wording is allowed through.
    assert.equal(f.claims.ledgerWording({ claim: "append-only with a verifiable version chain" }).claim_allowed, true);
    assert.equal(f.claims.assertWording({ claim: "追加写 + 版本可校验链" }).claim_allowed, true);
    assert.equal(f.claims.assertWording({ claim: "不可篡改" }).claim_allowed, false);
    assert.throws(() => f.claims.assertWording({}), /claim must not be empty/);
  } finally { f.store.close(); }
});
