import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v1217-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  const environmentDigest = digest({ image: "pinned" });
  store.create("task", "task", { project_id: "project", title: "Pilot", goal: "verify", status: "active" });
  store.create("capability_asset", "asset", { name: "verified-reader", asset_type: "tool", source_uri: "builtin://reader", source_digest: "sha256:asset", trust: "verified", health: "healthy", effect: "read_only", requires_credential: false });
  store.create("activation_profile", "profile", { task_id: "task", asset_ids: ["asset"], asset_versions: { asset: 1 }, allowed_effects: ["read_only"], status: "recommended" });
  store.create("task_run", "run", { launch_identity: { task_id: "task" }, environment_digest: environmentDigest, budget_digest: digest({ usd: 1 }) });
  store.create("runtime_assurance_attestation", "attestation", { task_run_id: "run", task_run_version: 1, environment_digest: environmentDigest, status: "verified" });
  store.create("runtime_readiness_assessment", "readiness", { task_id: "task", environment_digest: environmentDigest, status: "ready", deployment_claimed: false });
  store.create("evidence", "evidence", { confidence: "confirmed", summary: "controlled recovery drill" });
  const evaluation = service.deliveryEvaluationCaseSave({ case_id: "case", name: "sealed", domain: "research", partition: "held_out", acceptance_contract_ref: "acceptance:v1", sanitized: true, approved_by: "independent-reviewer" }).case as JsonObject;
  return { root, store, service, environmentDigest, evaluation };
}

test("v0.12.17 binds sealed evaluation access, recovery evidence, trusted capability versions and one Pilot", async () => {
  const f = await fixture();
  try {
    const sealed = f.service.assuredPilotSealCase({ sealed_case_id: "sealed", case_id: "case", custodian: "eval-team", opaque_locator_digest: "sha256:opaque", approval_ref: "independent-reviewer" }).sealed_case as JsonObject;
    const access = f.service.assuredPilotIssueSealedAccess({ access_id: "access", sealed_case_id: sealed.id, task_run_id: "run", recipient: "eval-adapter", expires_at: "2030-01-01T00:00:00.000Z" }).access as JsonObject;
    assert.equal((f.service.assuredPilotConsumeSealedAccess({ access_id: access.id, task_run_id: "run", now: "2029-01-01T00:00:00.000Z" }).access as JsonObject).status, "consumed");
    const drill = f.service.assuredPilotRecordRecovery({ drill_id: "drill", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: true, receipt_revalidated: true, state_reobserved: true }, evidence_ids: ["evidence"] }).drill as JsonObject;
    const pilot = f.service.assuredPilotPrepare({ pilot_id: "pilot", task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: drill.id, activation_profile_id: "profile", sealed_access_id: access.id }).pilot as JsonObject;
    assert.equal(pilot.status, "evidence_bound");
    assert.equal((f.service.assuredPilotPrepare({ pilot_id: "pilot", task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: drill.id, activation_profile_id: "profile", sealed_access_id: access.id }).idempotent), true);
    assert.equal((f.service.assuredPilotReassess({ pilot_id: pilot.id, environment_digest: f.environmentDigest }).pilot as JsonObject).status, "evidence_bound");
    assert.equal((f.service.assuredPilotGet({ pilot_id: pilot.id }).sealed_access as JsonObject).id, "access");
    const mcp = new McpServer(f.service, "full");
    const calls: [string, JsonObject][] = [
      ["craft_assured_pilot_seal_case", { sealed_case_id: "sealed", case_id: "case", custodian: "eval-team", opaque_locator_digest: "sha256:opaque", approval_ref: "independent-reviewer" }],
      ["craft_assured_pilot_access_issue", { access_id: "mcp-access", sealed_case_id: "sealed", task_run_id: "run", recipient: "mcp-evaluator", expires_at: "2030-01-01T00:00:00.000Z" }],
      ["craft_assured_pilot_access_consume", { access_id: "mcp-access", task_run_id: "run", now: "2029-01-01T00:00:00.000Z" }],
      ["craft_assured_pilot_recovery_record", { drill_id: "drill", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: true, receipt_revalidated: true, state_reobserved: true }, evidence_ids: ["evidence"] }],
      ["craft_assured_pilot_prepare", { pilot_id: "pilot", task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: "drill", activation_profile_id: "profile", sealed_access_id: "access" }],
      ["craft_assured_pilot_reassess", { pilot_id: "pilot", environment_digest: f.environmentDigest }],
      ["craft_assured_pilot_get", { pilot_id: "pilot" }],
    ];
    for (const [name, args] of calls) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } });
      assert.equal((response?.result as JsonObject).isError, false, name);
    }
    assert.equal(VERSION, "0.12.17");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.17 fails closed on unsealed, expired, stale or untrusted Pilot facts and projects attention", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.assuredPilotSealCase({ case_id: "missing", custodian: "x", opaque_locator_digest: "sha256:x", approval_ref: "x" }), /Unknown/);
    const sealed = f.service.assuredPilotSealCase({ sealed_case_id: "sealed", case_id: "case", custodian: "eval-team", opaque_locator_digest: "sha256:opaque", approval_ref: "independent-reviewer" }).sealed_case as JsonObject;
    const expired = f.service.assuredPilotIssueSealedAccess({ access_id: "expired", sealed_case_id: sealed.id, task_run_id: "run", recipient: "eval-adapter", expires_at: "2020-01-01T00:00:00.000Z" }).access as JsonObject;
    assert.throws(() => f.service.assuredPilotConsumeSealedAccess({ access_id: expired.id, task_run_id: "run", now: "2021-01-01T00:00:00.000Z" }), /expired/);
    const access = f.service.assuredPilotIssueSealedAccess({ access_id: "access", sealed_case_id: sealed.id, task_run_id: "run", recipient: "eval-adapter", expires_at: "2030-01-01T00:00:00.000Z" }).access as JsonObject;
    assert.throws(() => f.service.assuredPilotRecordRecovery({ task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: "sha256:wrong", checks: {}, evidence_ids: [] }), /ready runtime/);
    const drill = f.service.assuredPilotRecordRecovery({ drill_id: "drill", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: true, receipt_revalidated: true, state_reobserved: true }, evidence_ids: ["evidence"] }).drill as JsonObject;
    assert.throws(() => f.service.assuredPilotPrepare({ task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: drill.id, activation_profile_id: "profile", sealed_access_id: access.id }), /verified Task Run/);
    f.service.assuredPilotConsumeSealedAccess({ access_id: access.id, task_run_id: "run", now: "2029-01-01T00:00:00.000Z" });
    const pilot = f.service.assuredPilotPrepare({ pilot_id: "pilot", task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: drill.id, activation_profile_id: "profile", sealed_access_id: access.id }).pilot as JsonObject;
    f.store.save("capability_asset", "asset", { ...f.store.get("capability_asset", "asset"), health: "stale" });
    assert.equal((f.service.assuredPilotReassess({ pilot_id: pilot.id, environment_digest: f.environmentDigest }).pilot as JsonObject).status, "needs_replan");
    assert.ok((f.service.assuredPilotGet({ pilot_id: pilot.id }).attention as string[]).includes("capability_profile_drift"));
    assert.equal(((f.service.workbenchExperienceQuery({ task_id: "task" }).pilots as JsonObject[])[0]).id, pilot.id);

    const mcp = new McpServer(f.service, "full");
    for (const [name, args] of [["craft_assured_pilot_get", { pilot_id: pilot.id }], ["craft_assured_pilot_reassess", { pilot_id: pilot.id, environment_digest: f.environmentDigest }]] as [string, JsonObject][]) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } }); assert.equal((response?.result as JsonObject).isError, false, name);
    }
    assert.equal(new McpServer(f.service, "core").tools.some((tool) => tool.name === "craft_assured_pilot_get"), true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.17 covers idempotent receipts and independently visible drift reasons", async () => {
  const f = await fixture();
  try {
    f.store.create("delivery_evaluation_case", "development", { partition: "development", sanitized: true, approved_by: null, definition_digest: "sha256:development" });
    assert.throws(() => f.service.assuredPilotSealCase({ case_id: "development", custodian: "team", opaque_locator_digest: "sha256:x", approval_ref: "review" }), /held-out/);
    const sealed = f.service.assuredPilotSealCase({ case_id: "case", custodian: "team", opaque_locator_digest: "sha256:opaque", approval_ref: "review" }).sealed_case as JsonObject;
    assert.equal(f.service.assuredPilotSealCase({ case_id: "case", custodian: "team", opaque_locator_digest: "sha256:opaque", approval_ref: "review" }).idempotent, true);
    const access = f.service.assuredPilotIssueSealedAccess({ sealed_case_id: sealed.id, task_run_id: "run", recipient: "adapter", expires_at: "2030-01-01T00:00:00.000Z" }).access as JsonObject;
    assert.equal(f.service.assuredPilotIssueSealedAccess({ sealed_case_id: sealed.id, task_run_id: "run", recipient: "adapter", expires_at: "2030-01-01T00:00:00.000Z" }).idempotent, true);
    assert.throws(() => f.service.assuredPilotConsumeSealedAccess({ access_id: access.id, task_run_id: "other", now: "2029-01-01T00:00:00.000Z" }), /does not match/);
    f.service.assuredPilotConsumeSealedAccess({ access_id: access.id, task_run_id: "run", now: "2029-01-01T00:00:00.000Z" });
    assert.throws(() => f.service.assuredPilotConsumeSealedAccess({ access_id: access.id, task_run_id: "run", now: "2029-01-01T00:00:01.000Z" }), /already consumed/);
    assert.throws(() => f.service.assuredPilotRecordRecovery({ task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: false }, evidence_ids: ["evidence"] }), /every recovery/);
    f.store.create("evidence", "bounded", { confidence: "bounded" });
    assert.throws(() => f.service.assuredPilotRecordRecovery({ task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: true, receipt_revalidated: true, state_reobserved: true }, evidence_ids: ["bounded"] }), /confirmed/);
    const drill = f.service.assuredPilotRecordRecovery({ task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: true, receipt_revalidated: true, state_reobserved: true }, evidence_ids: ["evidence"] }).drill as JsonObject;
    assert.equal(f.service.assuredPilotRecordRecovery({ task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: true, receipt_revalidated: true, state_reobserved: true }, evidence_ids: ["evidence"] }).idempotent, true);
    const pilot = f.service.assuredPilotPrepare({ task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: drill.id, activation_profile_id: "profile", sealed_access_id: access.id }).pilot as JsonObject;
    f.store.create("work_loop_invalidation", "invalidation", { task_run_id: "run", status: "needs_replan" });
    assert.ok((f.service.assuredPilotReassess({ pilot_id: pilot.id, environment_digest: f.environmentDigest }).attention as string[]).includes("human_or_workspace_drift"));
    f.store.save("delivery_evaluation_case", "case", { ...f.store.get("delivery_evaluation_case", "case"), definition_digest: "sha256:changed" });
    assert.ok((f.service.assuredPilotReassess({ pilot_id: pilot.id, environment_digest: f.environmentDigest }).attention as string[]).includes("sealed_case_drift"));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.17 rejects malformed grants and invalid pilot contracts without weakening the normal path", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.assuredPilotSealCase({ case_id: "case", custodian: "", opaque_locator_digest: "sha256:opaque", approval_ref: "review" }), /must not be empty/);
    const sealed = f.service.assuredPilotSealCase({ sealed_case_id: "sealed", case_id: "case", custodian: "team", opaque_locator_digest: "sha256:opaque", approval_ref: "review" }).sealed_case as JsonObject;
    assert.throws(() => f.service.assuredPilotSealCase({ sealed_case_id: "sealed", case_id: "case", custodian: "changed", opaque_locator_digest: "sha256:opaque", approval_ref: "review" }), /idempotency/);
    assert.throws(() => f.service.assuredPilotIssueSealedAccess({ sealed_case_id: sealed.id, task_run_id: "run", recipient: "adapter", expires_at: "not-a-date" }), /ISO/);
    const access = f.service.assuredPilotIssueSealedAccess({ access_id: "access", sealed_case_id: sealed.id, task_run_id: "run", recipient: "adapter", expires_at: "2030-01-01T00:00:00.000Z" }).access as JsonObject;
    f.service.assuredPilotConsumeSealedAccess({ access_id: access.id, task_run_id: "run" });
    assert.throws(() => f.service.assuredPilotRecordRecovery({ task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: true, receipt_revalidated: true, state_reobserved: true }, evidence_ids: ["evidence", "evidence"] }), /unique/);
    assert.throws(() => f.service.assuredPilotRecordRecovery({ task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: true, receipt_revalidated: true, state_reobserved: true }, evidence_ids: [] }), /at least one/);
    const drill = f.service.assuredPilotRecordRecovery({ drill_id: "drill", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: true, receipt_revalidated: true, state_reobserved: true }, evidence_ids: ["evidence"] }).drill as JsonObject;
    f.store.create("activation_profile", "wrong-profile", { task_id: "other", asset_ids: ["asset"], asset_versions: { asset: 1 }, allowed_effects: ["read_only"] });
    assert.throws(() => f.service.assuredPilotPrepare({ task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: drill.id, activation_profile_id: "wrong-profile", sealed_access_id: access.id }), /Activation Profile/);
    const pilot = f.service.assuredPilotPrepare({ pilot_id: "pilot", task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: drill.id, activation_profile_id: "profile", sealed_access_id: access.id }).pilot as JsonObject;
    assert.deepEqual(f.service.assuredPilotGet({ pilot_id: pilot.id }).attention, []);
    assert.throws(() => f.service.assuredPilotIssueSealedAccess({ access_id: access.id, sealed_case_id: sealed.id, task_run_id: "run", recipient: "changed", expires_at: "2030-01-01T00:00:00.000Z" }), /idempotency/);
    f.store.create("evidence", "evidence-two", { confidence: "confirmed" });
    assert.throws(() => f.service.assuredPilotRecordRecovery({ drill_id: drill.id, task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", environment_digest: f.environmentDigest, checks: { rehydration_verified: true, receipt_revalidated: true, state_reobserved: true }, evidence_ids: ["evidence", "evidence-two"] }), /idempotency/);
    assert.throws(() => f.service.assuredPilotPrepare({ pilot_id: pilot.id, task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: drill.id, activation_profile_id: "wrong-profile", sealed_access_id: access.id }), /verified Task Run|Activation Profile/);
    const secondAccess = f.service.assuredPilotIssueSealedAccess({ access_id: "second-access", sealed_case_id: sealed.id, task_run_id: "run", recipient: "adapter-two", expires_at: "2030-01-01T00:00:00.000Z" }).access as JsonObject;
    f.service.assuredPilotConsumeSealedAccess({ access_id: secondAccess.id, task_run_id: "run", now: "2029-01-01T00:00:00.000Z" });
    assert.throws(() => f.service.assuredPilotPrepare({ pilot_id: pilot.id, task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: drill.id, activation_profile_id: "profile", sealed_access_id: secondAccess.id }), /idempotency/);
    assert.equal(f.service.assuredPilotReassess({ pilot_id: pilot.id, environment_digest: f.environmentDigest }).idempotent, false);
    assert.equal(f.service.assuredPilotReassess({ pilot_id: pilot.id, environment_digest: f.environmentDigest }).idempotent, true);
    assert.ok((f.service.assuredPilotReassess({ pilot_id: pilot.id, environment_digest: "sha256:wrong" }).attention as string[]).includes("task_run_or_environment_drift"));
    f.store.save("capability_asset", "asset", { ...f.store.get("capability_asset", "asset"), health: "failed" });
    f.store.save("activation_profile", "profile", { ...f.store.get("activation_profile", "profile"), asset_versions: { asset: 2 } });
    assert.throws(() => f.service.assuredPilotPrepare({ pilot_id: "unhealthy", task_id: "task", task_run_id: "run", attestation_id: "attestation", readiness_id: "readiness", recovery_drill_id: drill.id, activation_profile_id: "profile", sealed_access_id: access.id }), /eligible/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
