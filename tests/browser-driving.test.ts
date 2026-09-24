import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserDrivingKernel } from "../core/browser-driving.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-driving-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, driving: new BrowserDrivingKernel(store) };
}

const site = (driving: BrowserDrivingKernel, over: Record<string, unknown> = {}) => driving.registerSite({
  site_id: "portal", allowed_operations: ["navigate", "fill", "click", "submit", "production_change", "observe"], ...over });

const script = (driving: BrowserDrivingKernel, over: Record<string, unknown> = {}) => driving.registerScript({
  script_id: "s1", site_id: "portal", operation: "click",
  assertions: [{ selector: "#confirm-step", state: "present" }], script_body: "await page.click('#submit')", ...over });

test("the judge is the checker, not the tool: an R0 script with a bypass check reaches L1", async () => {
  const f = await fixture();
  try {
    // 13A's first correction: rejecting by implementation would deny automatic execution to
    // things that can prove themselves, which contradicts 4.3 and 4.6.
    site(f.driving, { bypass_checker: "ssh_node_probe" });
    script(f.driving, { script_id: "nav", operation: "navigate" });
    const l1 = f.driving.adjudicate({ script_id: "nav" });
    assert.equal(l1.outcome, "L1");
    assert.equal(l1.reason, "r0_with_independent_bypass_check");
    // 13A.2.1: the core still never drives.
    assert.equal(l1.adapter_required, true);
    assert.equal(l1.execution_authority, false);
    assert.equal(l1.approval_chain_required, false);

    // Without a bypass check only the page's own word is available, so it prepares and releases.
    site(f.driving, { site_id: "nobypass", bypass_checker: undefined });
    script(f.driving, { script_id: "nav2", site_id: "nobypass", operation: "navigate" });
    const l2 = f.driving.adjudicate({ script_id: "nav2" });
    assert.equal(l2.outcome, "L2_prepare_release");
    assert.equal(l2.reason, "r0_without_bypass_check_prepare_and_release");
    assert.equal(l2.has_bypass_check, false);
  } finally { f.store.close(); }
});

test("R1 never reaches L1, and R3 needs the approval chain even with a bypass check", async () => {
  const f = await fixture();
  try {
    site(f.driving, { bypass_checker: "ssh_node_probe" });
    // R1 is reversible with an external effect, and reversibility does not undo that: a
    // recalled message has still been seen. So R1 goes through prepare-and-release.
    script(f.driving, { script_id: "fill", operation: "fill" });
    const r1 = f.driving.adjudicate({ script_id: "fill" });
    assert.equal(r1.risk_level, "R1");
    assert.equal(r1.outcome, "L2_prepare_release");
    assert.equal(r1.reason, "r1_never_reaches_l1_even_with_bypass_check");

    // 13A's second correction: the bypass check proves the action was done correctly; the
    // approval chain decides whether it should be done. They are not substitutes.
    script(f.driving, { script_id: "prod", operation: "production_change" });
    const r3 = f.driving.adjudicate({ script_id: "prod" });
    assert.equal(r3.risk_level, "R3");
    assert.equal(r3.outcome, "L2_prepare_release_with_approval_chain");
    assert.equal(r3.reason, "r3_requires_approval_chain_even_with_bypass_check");
    assert.equal(r3.approval_chain_required, true);
    assert.equal(r3.has_bypass_check, true);

    // R2 is an external effect without a bypass path to L1.
    script(f.driving, { script_id: "click2", operation: "click" });
    const r2 = f.driving.adjudicate({ script_id: "click2" });
    assert.equal(r2.outcome, "L2_prepare_release");
    assert.equal(r2.reason, "external_effect_requires_prepare_and_release");

    // A caller may state the bypass checker for one call. Availability of confirmation does
    // not depend on who states it, so this can also *withdraw* one for the call's purposes.
    const overridden = f.driving.adjudicate({ script_id: "fill", bypass_checker: "db_probe" });
    assert.equal(overridden.bypass_checker, "db_probe");
    assert.equal(overridden.has_bypass_check, true);
    assert.throws(() => f.driving.adjudicate({ script_id: "fill", bypass_checker: "bad id!" }), /unsupported characters/);
  } finally { f.store.close(); }
});

test("VLM guessing and fuzzy waiting are refused by name", async () => {
  const f = await fixture();
  try {
    site(f.driving);
    // 13A.4: forbidden not for being inaccurate but because its failures cannot be discovered
    // automatically — the same self-certification 4.2 rejects for confidence_score.
    // The detector matches the concept, not a list of library names, so every spelling of
    // "decide where to act from pixels" is caught.
    for (const body of ["await page.screenshot()", "const el = await find_by_vision(img)",
      "await computer_use.click(x, y)", "await image_match(template)", "await templateMatch(t)",
      "const box = await element.getBoundingClientRect()", "await ocrRead(shot)",
      "await clickAtCoordinate(10, 20)", "const vlm = await askModel(shot)"]) {
      assert.throws(() => script(f.driving, { script_id: "v", script_body: body }),
        /VLM or visual location is forbidden/, body);
    }
    // A selector-based script is the permitted form.
    assert.equal(script(f.driving, { script_id: "ok", script_body: "await page.waitForSelector('#success-badge')" }).idempotent, false);
    // 13A.6 rule 2: waitForTimeout is unassertable, so it hides the failure probability.
    assert.throws(() => script(f.driving, { script_id: "w", script_body: "await page.waitForTimeout(3000)" }),
      /fuzzy wait is forbidden; assert a selector or a condition instead of waiting N seconds/);
    assert.throws(() => script(f.driving, { script_id: "w2", script_body: "await sleep(2)" }), /fuzzy wait is forbidden/);
    // An explicit assertion is what makes the script deterministic.
    assert.throws(() => script(f.driving, { script_id: "na", assertions: [] }),
      /assertions must be a non-empty array; a script with no assertion cannot fail detectably/);
    assert.throws(() => script(f.driving, { script_id: "na2", assertions: [{ selector: "!!", state: "present" }] }),
      /is not a valid selector/);
    assert.throws(() => script(f.driving, { script_id: "na3", assertions: [{ selector: "#a", state: "bogus" }] }),
      /state is unsupported/);
  } finally { f.store.close(); }
});

test("driving is scoped per site, extending the existing allowlist convention", async () => {
  const f = await fixture();
  try {
    // A driving capability scoped to everything is the same blank cheque the subscription
    // rules prevent, one layer down.
    assert.throws(() => f.driving.registerSite({ site_id: "open", allowed_operations: [] }),
      /a site with no declared operations permits everything/);
    assert.throws(() => f.driving.registerSite({ site_id: "bad", allowed_operations: ["teleport"] }),
      /is not a known operation/);
    site(f.driving, { site_id: "readonly", allowed_operations: ["navigate"] });
    // An operation the site did not declare is refused.
    assert.throws(() => script(f.driving, { script_id: "x", site_id: "readonly", operation: "submit" }),
      /operation is not permitted for this site: submit/);
    // An unknown operation is refused before the site is even consulted.
    assert.throws(() => script(f.driving, { script_id: "y", site_id: "readonly", operation: "teleport" }),
      /operation is not a known driving operation/);

    // Registration is idempotent for the same content and a conflict otherwise.
    site(f.driving);
    assert.equal(site(f.driving).idempotent, true);
    assert.throws(() => site(f.driving, { allowed_operations: ["navigate"] }), /already registered with different operations/);
    script(f.driving);
    assert.equal(script(f.driving).idempotent, true);
    assert.throws(() => script(f.driving, { script_body: "await page.click('#other')" }), /already registered with different content/);
    assert.throws(() => f.driving.registerSite({ site_id: "bad id!", allowed_operations: ["navigate"] }), /unsupported characters/);
    assert.throws(() => f.driving.getSite({ site_id: "missing" }), /Unknown driving_site/);
    assert.throws(() => f.driving.getScript({ script_id: "missing" }), /Unknown driving_script/);
    assert.throws(() => f.driving.adjudicate({ script_id: "missing" }), /Unknown driving_script/);
  } finally { f.store.close(); }
});

test("a receipt records the bypass result, so a page's own claim is never the whole evidence", async () => {
  const f = await fixture();
  try {
    site(f.driving, { bypass_checker: "ssh_node_probe" });
    script(f.driving, { script_id: "nav", operation: "navigate" });
    // 13A.5: reading the page's own rendered "Success" as proof is wrong, because a page can
    // render it while being wrong. The bypass result is recorded alongside.
    const withBypass = f.driving.recordReceipt({ script_id: "nav", target_url: "https://portal/eval3",
      dom_digest: "sha256:abc", assertion_results: { "#confirm-step": "present" },
      bypass_result: { source: "ssh_node_probe", result: "offset_delay=0" } });
    const receipt = withBypass.receipt as Record<string, unknown>;
    assert.equal(receipt.recomputable, true);
    assert.equal(receipt.page_claim_only, false);
    assert.equal((receipt.bypass_result as Record<string, unknown>).source, "ssh_node_probe");
    // The receipt still cannot drive anything by itself.
    assert.equal(receipt.adapter_required, true);
    assert.equal(receipt.execution_authority, false);
    assert.equal(receipt.page_content_stored, false);

    // A bypass result cannot come from the browser: that is not a bypass.
    assert.throws(() => f.driving.recordReceipt({ script_id: "nav", target_url: "u", dom_digest: "d",
      bypass_result: { source: "page", result: "ok" } }), /must be independent of the browser/);
    assert.throws(() => f.driving.recordReceipt({ script_id: "nav", target_url: "u", dom_digest: "d",
      bypass_result: { source: "dom", result: "ok" } }), /must be independent of the browser/);
    // A bypass result must carry its outcome, not just a source.
    assert.throws(() => f.driving.recordReceipt({ script_id: "nav", target_url: "u", dom_digest: "d",
      bypass_result: { source: "ssh_node_probe" } }), /bypass_result\.result must not be empty/);

    // Without a bypass the receipt says so rather than implying independent confirmation.
    site(f.driving, { site_id: "nobypass", bypass_checker: undefined });
    script(f.driving, { script_id: "nav2", site_id: "nobypass", operation: "navigate" });
    const pageOnly = f.driving.recordReceipt({ script_id: "nav2", target_url: "u", dom_digest: "d" }).receipt as Record<string, unknown>;
    assert.equal(pageOnly.recomputable, false);
    assert.equal(pageOnly.page_claim_only, true);
    assert.equal(pageOnly.bypass_result, null);

    // Receipts are idempotent per subject, honour an explicit id, and list newest first.
    const again = f.driving.recordReceipt({ script_id: "nav2", target_url: "u", dom_digest: "d" });
    assert.equal(again.idempotent, true);
    const named = f.driving.recordReceipt({ script_id: "nav2", target_url: "u2", dom_digest: "d2",
      receipt_id: "driving_receipt_named" });
    assert.equal((named.receipt as Record<string, unknown>).id, "driving_receipt_named");
    f.driving.recordReceipt({ script_id: "nav2", target_url: "u3", dom_digest: "d3" });
    const listed = f.driving.receipts({ script_id: "nav2" }).receipts as Record<string, unknown>[];
    assert.equal(listed.length, 3);
    // Newest first, so a reviewer reads the most recent attempt before older ones.
    assert.equal(listed[0]!.target_url, "u3");
    assert.deepEqual(f.driving.receipts({ script_id: "none" }).receipts, []);

    // The surface answers "how much can be driven, and how much only prepares".
    const surface = f.driving.surface({});
    assert.equal(surface.sites, 2);
    assert.equal(surface.scripts, 2);
    assert.equal(surface.l1_eligible, 1);
    assert.equal(surface.without_bypass, 1);
  } finally { f.store.close(); }
});
