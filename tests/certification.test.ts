import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

type Overrides = { materialization?: JsonObject; asset?: JsonObject; source?: JsonObject; entry?: JsonObject; profile?: JsonObject; evaluation?: JsonObject; outcome?: JsonObject; receipt?: JsonObject; signoff?: JsonObject; grade?: JsonObject };
async function fixture(overrides: Overrides = {}) { const root = await mkdtemp(path.join(tmpdir(), "craft-cert-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  store.create("hub_source", "hub", { status: "active", ...overrides.source }); store.create("hub_catalog_entry", "hub:entry", { source_id: "hub", entry_id: "entry", status: "active", content_digest: "sha256:content", ...overrides.entry });
  store.create("capability_materialization", "m", { status: "candidate_registered", source_id: "hub", entry_record_id: "hub:entry", entry_id: "entry", content_digest: "sha256:content", reviewer: "reviewer", asset_id: "asset", asset_version: 1, ...overrides.materialization });
  store.create("capability_asset", "asset", { name: "A", trust: "candidate", health: "healthy", effect: "read_only", materialization_id: "m", materialization_version: 1, execution_authority: false, ...overrides.asset });
  store.create("task", "task", { title: "T" }); store.create("evidence", "e", { claim: "passed" }); store.create("sandbox_profile", "sandbox", { lifecycle: "verified", capability_digest: "d", ...overrides.profile });
  for (const suffix of ["1", "2"]) { store.create("trial", `trial${suffix}`, { task_id: "task", subject_type: "capability_asset", subject_id: "asset", subject_version: 1, case_id: `case${suffix}` });
    store.create("outcome", `outcome_trial${suffix}`, { verdict: "passed", evidence_ids: ["e"], ...overrides.outcome }); store.create("sandbox_receipt", `receipt${suffix}`, { status: "passed", task_id: "task", profile_id: "sandbox", profile_version: 1, evidence_ids: ["e"], ...overrides.receipt });
    store.create("grade", `grade${suffix}`, { trial_id: `trial${suffix}`, grader_type: "program", verdict: "passed", evidence_ids: ["e"], ...overrides.grade }); }
  store.create("evaluation_run", "eval", { verdict: "passed", split: "held_out", subject_type: "capability_asset", subject_id: "asset", subject_version: 1, trial_ids: ["trial1", "trial2"], ...overrides.evaluation });
  store.create("signoff", "signoff", { decision: "passed", evaluation_run_id: "eval", subject_type: "capability_asset", subject_id: "asset", subject_version: 1, grade_ids: ["grade1", "grade2"], ...overrides.signoff });
  const args: JsonObject = { certification_id: "cert", materialization_id: "m", materialization_version: 1, sandbox_profile_id: "sandbox", sandbox_profile_version: 1,
    evaluation_run_id: "eval", sandbox_receipts: [{ trial_id: "trial1", receipt_id: "receipt1" }, { trial_id: "trial2", receipt_id: "receipt2" }], signoff_id: "signoff", certifier: "certifier", certification_ref: "cert-ref" };
  return { store, service, args };
}
function record(result: JsonObject, key: string): JsonObject { return result[key] as JsonObject; }

test("Capability Certification proves exact evaluation and Sandbox execution before atomic verified promotion", async () => {
  const f = await fixture(); const assessed = f.service.capabilityCertificationAssess(f.args); assert.equal(record(assessed, "certification").status, "eligible");
  assert.equal(f.service.capabilityCertificationAssess(f.args).idempotent, true);
  const promoted = f.service.capabilityCertificationPromote({ certification_id: "cert", certification_version: 1, promoter: "release-manager", approval_ref: "approval" });
  assert.equal(record(promoted, "asset").trust, "verified"); assert.equal(record(promoted, "materialization").status, "certified"); assert.equal(promoted.executable, false);
  assert.throws(() => f.service.capabilityCertificationPromote({ certification_id: "cert", certification_version: 2, promoter: "other", approval_ref: "x" }), /not eligible/);
  f.store.close();
});

test("Capability Certification rejects incomplete, foreign, stale, self-approved, or conflicting evidence", async () => {
  const cases: [Overrides, Partial<JsonObject>, RegExp][] = [
    [{}, { materialization_version: 0 }, /positive integer/],
    [{ materialization: { status: "approved" } }, {}, /registered/], [{ asset: { trust: "verified" } }, {}, /identity/],
    [{ source: { status: "disabled" } }, {}, /no longer current/], [{ entry: { status: "withdrawn" } }, {}, /no longer current/], [{ entry: { content_digest: "other" } }, {}, /no longer current/],
    [{ profile: { lifecycle: "declared" } }, {}, /verified Sandbox/], [{ evaluation: { verdict: "failed" } }, {}, /passed held-out/],
    [{ evaluation: { split: "development" } }, {}, /passed held-out/], [{ evaluation: { subject_type: "workflow" } }, {}, /passed held-out/],
    [{ evaluation: { trial_ids: [] } }, { sandbox_receipts: [] }, /no Trials/], [{}, { sandbox_receipts: [] }, /one Sandbox receipt/],
    [{}, { sandbox_receipts: ["bad", { trial_id: "trial2", receipt_id: "receipt2" }] }, /binding must be an object/],
    [{}, { sandbox_receipts: [{ trial_id: "foreign", receipt_id: "receipt1" }, { trial_id: "trial2", receipt_id: "receipt2" }] }, /foreign Trial/],
    [{}, { sandbox_receipts: [{ trial_id: "trial1", receipt_id: "receipt1" }, { trial_id: "trial2", receipt_id: "receipt1" }] }, /unique/],
    [{ receipt: { status: "failed" } }, {}, /does not prove/], [{ outcome: { verdict: "failed" } }, {}, /passed evidence-backed/],
    [{ signoff: { decision: "failed" } }, {}, /passed Signoff/], [{ signoff: { evaluation_run_id: "other" } }, {}, /passed Signoff/],
    [{ grade: { grader_type: "human" } }, {}, /program Grade/], [{}, { certifier: "reviewer" }, /independent certifier/],
  ];
  for (const [overrides, args, expected] of cases) { const f = await fixture(overrides); if (String((args.sandbox_receipts as JsonObject[] | undefined)?.[0]?.trial_id) === "foreign") f.store.create("trial", "foreign", { task_id: "task" }); assert.throws(() => f.service.capabilityCertificationAssess({ ...f.args, ...args }), expected); f.store.close(); }
  const conflict = await fixture(); conflict.service.capabilityCertificationAssess(conflict.args); assert.throws(() => conflict.service.capabilityCertificationAssess({ ...conflict.args, certifier: "other" }), /idempotency conflict/); conflict.store.close();
  const generated = await fixture(); delete generated.args.certification_id; assert.match(String(record(generated.service.capabilityCertificationAssess(generated.args), "certification").id), /^capability_certification_/); generated.store.close();
});

test("Capability promotion revalidates independent approval, candidate ownership, source, and catalog state", async () => {
  for (const scenario of ["same", "material", "asset", "source", "entry", "digest", "approval"] as const) { const f = await fixture(); const certification = record(f.service.capabilityCertificationAssess(f.args), "certification");
    if (scenario === "material") f.store.save("capability_materialization", "m", { ...f.store.get("capability_materialization", "m"), status: "changed" });
    if (scenario === "asset") f.store.save("capability_asset", "asset", { ...f.store.get("capability_asset", "asset"), trust: "candidate" });
    if (scenario === "source") f.store.save("hub_source", "hub", { ...f.store.get("hub_source", "hub"), status: "disabled" });
    if (scenario === "entry") f.store.save("hub_catalog_entry", "hub:entry", { ...f.store.get("hub_catalog_entry", "hub:entry"), status: "withdrawn" });
    if (scenario === "digest") f.store.save("hub_catalog_entry", "hub:entry", { ...f.store.get("hub_catalog_entry", "hub:entry"), content_digest: "other" });
    const expected = scenario === "same" ? /independent promoter/ : scenario === "material" || scenario === "asset" ? /changed after certification/ : scenario === "approval" ? /approval_ref/ : /source changed/;
    assert.throws(() => f.service.capabilityCertificationPromote({ certification_id: certification.id, certification_version: certification.version, promoter: scenario === "same" ? "certifier" : "promoter", approval_ref: scenario === "approval" ? " " : "ok" }), expected); f.store.close(); }
});
