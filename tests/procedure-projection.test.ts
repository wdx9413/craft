import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProcedureStore } from "../capability/craft-experience/procedure-projection.ts";
import { stableDigest } from "../core/digest.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-procedure-projection-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const procedures = new ProcedureStore(store);
  store.create("evidence", "e", { confidence: "confirmed" });
  store.create("workflow_evolution_request", "request", { scenario_key: "inspect", scenario_signature: { domain: "test" }, observation_refs: [{ source: { scope: "project:test" }, evidence_ids: ["e"] }], output_contract_ref: "acceptance:test" });
  store.create("workflow_evolution_proposal", "proposal", { request_id: "request", request_version: 1, name: "Inspect", description: "Read only fixture", inputs: [], steps: [] });
  function draft(extra: JsonObject = {}): JsonObject { return procedures.draft({ proposal_id: "proposal", ...extra }).procedure as JsonObject; }
  function promote(procedure: JsonObject): JsonObject {
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) procedures.gate({ procedure_id: procedure.id, stage, passed: true, evidence_ids: ["e"] });
    return store.get("experience_procedure", String(procedure.id));
  }
  return { root, store, procedures, draft, promote, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Skill export treats IDs as opaque keys, remains disabled and binds replay to source/version/content", async () => {
  const f = await fixture();
  try {
    const p = f.draft({ procedure_kind: "prompt" });
    assert.throws(() => f.procedures.skillExport({ procedure_id: p.id }), /Only routeable/);
    const promoted = f.promote(p);
    for (const export_id of ["../../escape", join(f.root, "outside"), "ordinary-id"]) {
      const args = { procedure_id: p.id, export_id };
      const result = f.procedures.skillExport(args);
      const exported = result.export as JsonObject;
      assert.equal(result.idempotent, false);
      assert.equal(dirname(String(exported.path)), join(f.store.paths.experienceDir, "skills", stableDigest(export_id).slice(7)));
      assert.equal(exported.enabled, false);
      assert.equal(exported.status, "draft");
      assert.equal(exported.definition_path, null);
      assert.match(readFileSync(String(exported.path), "utf8"), /enabled: false/);
      assert.equal(f.procedures.skillExport(args).idempotent, true);
      assert.throws(() => f.procedures.skillExport({ ...args, skill_name: "Changed" }), /idempotency conflict/);
    }
    assert.equal(existsSync(join(f.root, "outside")), false);
    const other = f.promote(f.draft({ procedure_id: "other", title: "Other" }));
    assert.throws(() => f.procedures.skillExport({ procedure_id: other.id, export_id: "ordinary-id" }), /idempotency conflict/);
    f.store.save("experience_procedure", String(p.id), promoted);
    assert.throws(() => f.procedures.skillExport({ procedure_id: p.id, export_id: "ordinary-id" }), /idempotency conflict/);
    const structured = f.procedures.skillExport({ procedure_id: other.id, skill_name: "custom" }).export as JsonObject;
    assert.equal(JSON.parse(readFileSync(String(structured.definition_path), "utf8")).procedure_id, other.id);
    f.store.save("experience_procedure", String(other.id), { ...other, routeable: false });
    assert.throws(() => f.procedures.skillExport({ procedure_id: other.id }), /Only routeable/);
  } finally { f.close(); }
});

test("Skill export never overwrites existing directories or symlinks and rejects linked storage roots", async () => {
  const f = await fixture();
  try {
    const p = f.promote(f.draft());
    const root = f.store.paths.experienceDir, skills = join(root, "skills");
    mkdirSync(skills, { recursive: true });
    const occupied = join(skills, stableDigest("occupied").slice(7));
    mkdirSync(occupied);
    writeFileSync(join(occupied, "owner.txt"), "preserve");
    assert.throws(() => f.procedures.skillExport({ procedure_id: p.id, export_id: "occupied" }), /EEXIST/);
    assert.equal(readFileSync(join(occupied, "owner.txt"), "utf8"), "preserve");
    const target = join(f.root, "external-owner"); mkdirSync(target);
    const linked = join(skills, stableDigest("linked").slice(7));
    symlinkSync(target, linked, "junction");
    assert.throws(() => f.procedures.skillExport({ procedure_id: p.id, export_id: "linked" }), /EEXIST/);
    assert.deepEqual(readdirSync(target), []);
    renameSync(skills, `${skills}-original`);
    symlinkSync(target, skills, "junction");
    assert.throws(() => f.procedures.skillExport({ procedure_id: p.id }), /skills directory must not be a symbolic link/);
    unlinkSync(skills); renameSync(`${skills}-original`, skills);
    renameSync(root, `${root}-original`); symlinkSync(`${root}-original`, root, "junction");
    assert.throws(() => f.procedures.skillExport({ procedure_id: p.id }), /export root must not be a symbolic link/);
    unlinkSync(root); renameSync(`${root}-original`, root);
    assert.equal(f.store.count("experience_skill_export"), 0);
  } finally { f.close(); }
});

test("Skill export cleans only its owned directory on ledger failure and can retry", async (t) => {
  const f = await fixture();
  try {
    const p = f.promote(f.draft());
    const skills = join(f.store.paths.experienceDir, "skills"); mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, "unrelated.txt"), "preserve");
    const mock = t.mock.method(f.store, "create", () => { throw new Error("ledger unavailable"); });
    assert.throws(() => f.procedures.skillExport({ procedure_id: p.id, export_id: "retry" }), /ledger unavailable/);
    assert.deepEqual(readdirSync(skills), ["unrelated.txt"]);
    mock.mock.restore();
    assert.equal(f.procedures.skillExport({ procedure_id: p.id, export_id: "retry" }).idempotent, false);
    assert.equal(readFileSync(join(skills, "unrelated.txt"), "utf8"), "preserve");
  } finally { f.close(); }
});

test("Procedure public projection lists, validates drafts and preserves identity", async () => {
  const f = await fixture();
  try {
    for (const [args, pattern] of [
      [{ procedure_kind: "other" }, /unsupported/], [{ proposal_id: " " }, /must not be empty/],
      [{ scenario_signature: [] }, /Scenario Signature/], [{ scenario_signature: false }, /Scenario Signature/], [{ scenario_signature: "x" }, /Scenario Signature/],
      [{ preconditions: "bad" }, /must be an array/], [{ allowed_effects: [] }, /at least/], [{ preconditions: [false] }, /must not be empty/],
    ] as [JsonObject, RegExp][]) assert.throws(() => f.procedures.draft({ proposal_id: "proposal", ...args }), pattern);
    const args = { procedure_id: "listed", preconditions: ["safe", "safe"], evidence_ids: ["e"] };
    const p = f.draft(args);
    assert.equal(f.procedures.draft({ proposal_id: "proposal", ...args }).idempotent, true);
    assert.throws(() => f.draft({ ...args, title: "Different" }), /idempotency conflict/);
    assert.deepEqual((f.procedures.get({ procedure_id: p.id }).procedure as JsonObject).preconditions, ["safe"]);
    assert.equal((f.procedures.list().procedures as JsonObject[]).length, 1);
    assert.equal((f.procedures.list({ scope: "project:test", limit: 1 }).procedures as JsonObject[]).length, 1);
    assert.deepEqual(f.procedures.list({ scope: "project:other" }).procedures, []);
    assert.throws(() => f.procedures.list({ scope: " " }), /must not be empty/);
    assert.throws(() => f.procedures.gate({ procedure_id: p.id, stage: "unknown" }), /unsupported/);
    assert.throws(() => f.procedures.gate({ procedure_id: p.id, stage: "canary", evidence_ids: ["e"] }), /order/);
    f.store.create("evidence", "weak", { confidence: "unconfirmed" });
    assert.throws(() => f.procedures.gate({ procedure_id: p.id, stage: "shadow", evidence_ids: ["weak"] }), /bounded or confirmed/);
    const rejected = f.procedures.gate({ procedure_id: p.id, stage: "shadow", evidence_ids: ["e"] }).procedure as JsonObject;
    assert.equal(rejected.lifecycle, "rejected");
    const promoted = f.promote(p);
    const rollback = f.procedures.gate({ procedure_id: promoted.id, stage: "canary", passed: false, evidence_ids: ["e"] }).procedure as JsonObject;
    assert.equal(rollback.lifecycle, "rolled_back"); assert.equal(rollback.routeable, false);
  } finally { f.close(); }
});

test("Procedure projection handles legacy scopes, graph defaults and absent optional review metadata", async () => {
  const f = await fixture();
  try {
    const request = f.store.get("workflow_evolution_request", "request");
    f.store.save("workflow_evolution_request", "request", { ...request, observation_refs: [{ source: { scope: ":" }, evidence_ids: ["e"] }] });
    const proposal = f.store.get("workflow_evolution_proposal", "proposal");
    f.store.save("workflow_evolution_proposal", "proposal", { ...proposal, request_version: 2, procedure_kind: "graph", inputs: null });
    const graph = f.draft();
    assert.deepEqual(f.procedures.definitions.read(graph.definition_ref as never).definition, { inputs: [], nodes: [], edges: [], outputs: {}, checkpoint_policy: { mode: "step" } });
    const legacy = f.draft({ procedure_id: "legacy", procedure_kind: "prompt" });
    const ref = legacy.content_ref as JsonObject;
    const oldBody = f.store.contentStore.readCompatSync(ref as never).body.replace("- read", "").replace("- e", "");
    const legacyRef = f.store.contentStore.rewriteSync({ kind: "experience", record_id: String(legacy.id), version: 1, current_path: String(ref.path), scope: String(legacy.scope), status: "candidate", sensitivity: "internal", source_id: "fixture", body: oldBody, title: String(legacy.title) });
    f.store.save("experience_procedure", String(legacy.id), { ...legacy, content_ref: legacyRef, content_digest: legacyRef.digest, preconditions: null, allowed_effects: null, evidence_ids: null, scope_envelope: null });
    const rejected = f.procedures.gate({ procedure_id: legacy.id, stage: "shadow", evidence_ids: ["e"] }).procedure as JsonObject;
    assert.equal(rejected.lifecycle, "rejected");
    assert.match(f.store.contentStore.readCompatSync(rejected.content_ref as never).body, /Preconditions\n- None/);
    for (const content_ref of [null, {}, { kind: "knowledge" }, { kind: "experience" }, { kind: "experience", record_id: "legacy" }, { kind: "experience", record_id: "legacy", version: 1.5 }, { kind: "experience", record_id: "legacy", version: 1 }]) {
      f.store.save("experience_procedure", String(legacy.id), { ...legacy, content_ref });
      assert.equal((f.procedures.gate({ procedure_id: legacy.id, stage: "shadow", gate_id: `legacy-${JSON.stringify(content_ref)}`, evidence_ids: ["e"] }).procedure as JsonObject).lifecycle, "rejected");
    }
  } finally { f.close(); }
});

test("Procedure gate replay must bind the unchanged source identity", async () => {
  const f = await fixture();
  try {
    const p = f.draft();
    // Imported append-only gate fixture: no execution or real evaluation is claimed.
    const identity = { procedure_id: p.id, procedure_version: p.version, stage: "shadow", evidence_ids: ["e"], passed: false, verdict: "failed" };
    f.store.create("experience_procedure_gate", "existing", { ...identity, identity_digest: stableDigest(identity) });
    const args = { procedure_id: p.id, gate_id: "existing", stage: "shadow", evidence_ids: ["e"] };
    assert.equal(f.procedures.gate(args).idempotent, true);
    assert.throws(() => f.procedures.gate({ ...args, verdict: "changed" }), /gate idempotency conflict/);
  } finally { f.close(); }
});

test("Gate retries preserve versions and cannot revive a failed qualification", async () => {
  const f = await fixture();
  try {
    const p = f.draft();
    const shadow = { procedure_id: p.id, stage: "shadow", passed: true, evidence_ids: ["e"] };
    const first = f.procedures.gate(shadow);
    assert.equal(f.procedures.gate(shadow).idempotent, true);
    assert.equal((f.procedures.get({ procedure_id: p.id }).procedure as JsonObject).version, (first.procedure as JsonObject).version);
    for (const stage of ["held_out", "signoff", "canary"]) f.procedures.gate({ ...shadow, stage, gate_id: stage });
    const failed = f.procedures.gate({ ...shadow, stage: "canary", passed: false, gate_id: "rollback" }).procedure as JsonObject;
    assert.deepEqual(failed.completed_gates, []);
    assert.equal(f.procedures.gate({ ...shadow, stage: "canary", gate_id: "canary" }).idempotent, true);
    assert.equal((f.procedures.get({ procedure_id: p.id }).procedure as JsonObject).lifecycle, "rolled_back");
    assert.throws(() => f.procedures.gate({ ...shadow, stage: "canary", gate_id: "bypass" }), /order/);
    // Old stores may still carry passed stages on a revoked record.
    f.store.save("experience_procedure", String(p.id), { ...failed, completed_gates: ["shadow", "held_out", "signoff", "canary"] });
    assert.throws(() => f.procedures.gate({ ...shadow, stage: "canary", gate_id: "legacy-bypass" }), /order/);
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) f.procedures.gate({ ...shadow, stage, gate_id: `requalification-${stage}` });
    assert.equal((f.procedures.get({ procedure_id: p.id }).procedure as JsonObject).routeable, true);
    const restarted = f.procedures.gate({ ...shadow, gate_id: "new-shadow" }).procedure as JsonObject;
    assert.deepEqual(restarted.completed_gates, ["shadow"]);
    assert.throws(() => f.procedures.gate({ ...shadow, stage: "canary", gate_id: "skip-stages" }), /order/);
    assert.throws(() => f.procedures.gate({ ...shadow, stage: "held_out", expected_version: 1 }), /version/);
    assert.throws(() => f.procedures.gate({ ...shadow, stage: "held_out", expected_version: "bad" }), /version/);
  } finally { f.close(); }
});

test("Gate recording and Procedure transition are one atomic database operation", async () => {
  const f = await fixture();
  try {
    const p = f.draft(), args = { procedure_id: p.id, stage: "shadow", passed: true, evidence_ids: ["e"], gate_id: "atomic", expected_version: p.version };
    const save = f.store.save.bind(f.store);
    f.store.save = () => { throw new Error("injected state write failure"); };
    assert.throws(() => f.procedures.gate(args), /injected/);
    assert.equal(f.store.find("experience_procedure_gate", "atomic"), null);
    f.store.save = save;
    const result = f.procedures.gate(args);
    assert.equal(result.idempotent, false);
    assert.equal(f.procedures.gate(args).idempotent, true);
    assert.throws(() => f.procedures.gate({ ...args, passed: false }), /idempotency conflict/);
  } finally { f.close(); }
});
