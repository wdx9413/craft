import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { VerificationPlane } from "../src/verification-plane.ts";
import { CraftService } from "../src/service.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-verification-plane-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("evidence", "confirmed", { confidence: "confirmed", summary: "independent deterministic check" });
  store.create("evidence", "bounded", { confidence: "bounded", summary: "bounded integration observation" });
  return { root, store, plane: new VerificationPlane(store) };
}

async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

function recordAll(f: Awaited<ReturnType<typeof fixture>>, verification: JsonObject, status: "passed" | "failed" = "passed") {
  for (const check of verification.checks as JsonObject[]) {
    f.plane.record({ verification_id: verification.id, check_id: check.id, status, summary: `${String(check.kind)} observed`, evidence_ids: ["confirmed"], environment_fingerprint: "env:one" });
  }
}

test("v0.12.23 derives a deterministic risk-matched verification plan without executing a Host", async () => {
  const f = await fixture();
  try {
    const first = f.plane.plan({ verification_id: "read-change", change_ref: "git:abc", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env:one", content_stored: false });
    const plan = first.verification as JsonObject;
    assert.equal(first.idempotent, false);
    assert.equal(plan.risk_level, "moderate");
    assert.deepEqual((plan.checks as JsonObject[]).map((item) => item.kind), ["contract", "deterministic_e2e", "state_machine"]);
    assert.equal(plan.execution_authority, "none");
    assert.equal(f.plane.plan({ verification_id: "read-change", change_ref: "git:abc", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env:one", content_stored: false }).idempotent, true);
    assert.throws(() => f.plane.plan({ verification_id: "read-change", change_ref: "git:changed", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env:one", content_stored: false }), /idempotency/);
    assert.throws(() => f.plane.plan({ change_ref: "raw prompt", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env:one", content_stored: true }), /content-free/);
  } finally { await close(f); }
});

test("v0.12.23 escalates verification strength but never permits a caller to weaken write, Host, or candidate checks", async () => {
  const f = await fixture();
  try {
    const result = f.plane.plan({ verification_id: "high-change", change_ref: "git:def", change_kinds: ["host", "policy"], effects: ["external_write"], candidate_change: true, requires_real_host: true, requested_risk_level: "low", environment_fingerprint: "env:one", content_stored: false });
    const verification = result.verification as JsonObject;
    assert.equal(verification.risk_level, "critical");
    assert.deepEqual((verification.checks as JsonObject[]).map((item) => item.kind), ["contract", "deterministic_e2e", "state_machine", "adversarial", "recovery", "host_conformance", "eval_campaign", "release_qualification"]);
    assert.equal(verification.risk_escalated, true);
  } finally { await close(f); }
});

test("v0.12.23 records only planned, evidence-backed, same-environment verification receipts and distinguishes rejection from missing proof", async () => {
  const f = await fixture();
  try {
    const verification = f.plane.plan({ verification_id: "write-change", change_ref: "git:ghi", change_kinds: ["code"], effects: ["local_write"], environment_fingerprint: "env:one", content_stored: false }).verification as JsonObject;
    const checks = verification.checks as JsonObject[];
    assert.throws(() => f.plane.record({ verification_id: verification.id, check_id: "other", status: "passed", summary: "wrong", evidence_ids: ["confirmed"], environment_fingerprint: "env:one" }), /not planned/);
    assert.throws(() => f.plane.record({ verification_id: verification.id, check_id: checks[0]!.id, status: "passed", summary: "wrong environment", evidence_ids: ["confirmed"], environment_fingerprint: "env:two" }), /environment/);
    assert.throws(() => f.plane.record({ verification_id: verification.id, check_id: checks[0]!.id, status: "passed", summary: "unverified", evidence_ids: ["missing"], environment_fingerprint: "env:one" }), /Unknown evidence/);
    const first = f.plane.record({ verification_id: verification.id, check_id: checks[0]!.id, status: "passed", summary: "contract passed", evidence_ids: ["confirmed"], environment_fingerprint: "env:one" });
    assert.equal(first.idempotent, false);
    assert.equal(f.plane.record({ verification_id: verification.id, check_id: checks[0]!.id, status: "passed", summary: "contract passed", evidence_ids: ["confirmed"], environment_fingerprint: "env:one" }).idempotent, true);
    assert.equal(f.plane.assess({ verification_id: verification.id }).verdict, "inconclusive");
    f.plane.record({ verification_id: verification.id, check_id: checks[1]!.id, status: "failed", summary: "state mismatch", evidence_ids: ["bounded"], environment_fingerprint: "env:one" });
    assert.equal(f.plane.assess({ verification_id: verification.id }).verdict, "rejected");
  } finally { await close(f); }
});

test("v0.12.23 requires an eligible release qualification before a candidate verification can be eligible", async () => {
  const f = await fixture();
  try {
    const verification = f.plane.plan({ verification_id: "candidate-change", change_ref: "candidate:one", change_kinds: ["harness"], effects: ["read_only"], candidate_change: true, environment_fingerprint: "env:one", content_stored: false }).verification as JsonObject;
    recordAll(f, verification);
    assert.equal(f.plane.assess({ verification_id: verification.id }).verdict, "inconclusive");
    f.store.create("release_qualification", "rejected-qualification", { conclusion: "rejected" });
    assert.equal(f.plane.assess({ verification_id: verification.id, release_qualification_id: "rejected-qualification" }).verdict, "rejected");
    f.store.create("release_qualification", "eligible-qualification", { conclusion: "eligible" });
    const assessed = f.plane.assess({ verification_id: verification.id, release_qualification_id: "eligible-qualification" });
    assert.equal(assessed.verdict, "eligible");
    assert.equal((assessed.assessment as JsonObject).release_qualification_id, "eligible-qualification");
  } finally { await close(f); }
});

test("v0.12.23 exposes the VerificationPlane through the public CraftService seam", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const verification = service.verificationPlan({ verification_id: "service-change", change_ref: "git:jkl", change_kinds: ["plugin"], effects: ["read_only"], environment_fingerprint: "env:one", content_stored: false }).verification as JsonObject;
    for (const check of verification.checks as JsonObject[]) service.verificationReceiptRecord({ verification_id: verification.id, check_id: check.id, status: "passed", summary: "checked", evidence_ids: ["confirmed"], environment_fingerprint: "env:one" });
    assert.equal(service.verificationAssess({ verification_id: verification.id }).verdict, "eligible");
    assert.equal((service.verificationGet({ verification_id: verification.id }).verification as JsonObject).id, verification.id);
  } finally { await close(f); }
});

test("v0.12.23 mounts verification planning only on the full and skill-quality MCP surfaces", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store); const core = new McpServer(service, "core"); const quality = new McpServer(service, "component-skill-quality");
    assert(core.tools.some((tool) => tool.name === "craft_verification_get"));
    assert(!core.tools.some((tool) => tool.name === "craft_verification_plan"));
    assert(quality.tools.some((tool) => tool.name === "craft_verification_plan"));
    const response = await quality.handle({ id: "plan", method: "tools/call", params: { name: "craft_verification_plan", arguments: { verification_id: "mcp-change", change_ref: "git:mcp", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env:one", content_stored: false } } });
    assert.equal((response?.result as JsonObject).isError, false);
    const blocked = await core.handle({ id: "blocked", method: "tools/call", params: { name: "craft_verification_plan", arguments: {} } });
    assert.equal((blocked?.error as JsonObject).code, -32602);
  } finally { await close(f); }
});

test("v0.12.23 keeps validation, idempotency conflicts, and defensive branches evidence-backed", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "unverified", { confidence: "unverified" });
    assert.equal((f.plane.plan({ verification_id: "docs", change_ref: "git:docs", change_kinds: ["docs"], effects: ["read_only"], environment_fingerprint: "env:one" }).verification as JsonObject).risk_level, "low");
    assert.equal((f.plane.plan({ verification_id: "version", change_ref: "git:version", change_kinds: ["version"], effects: ["read_only"], environment_fingerprint: "env:one", requested_risk_level: "high" }).verification as JsonObject).risk_level, "high");
    assert.equal((f.plane.plan({ verification_id: "local", change_ref: "git:local", change_kinds: ["data"], effects: ["local_write"], environment_fingerprint: "env:one" }).verification as JsonObject).risk_level, "high");
    assert.equal((f.plane.plan({ verification_id: "host", change_ref: "git:host", change_kinds: ["host"], effects: ["destructive"], environment_fingerprint: "env:one" }).verification as JsonObject).risk_level, "critical");
    assert.match(String((f.plane.plan({ change_ref: "git:generated", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env:one" }).verification as JsonObject).id), /^verification_/);
    assert.throws(() => f.plane.plan({ change_ref: " ", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env" }), /must not be empty/);
    assert.throws(() => f.plane.plan({ change_ref: "x", change_kinds: [], effects: ["read_only"], environment_fingerprint: "env" }), /non-empty/);
    assert.throws(() => f.plane.plan({ change_ref: "x", change_kinds: ["code", "code"], effects: ["read_only"], environment_fingerprint: "env" }), /unique/);
    assert.throws(() => f.plane.plan({ change_ref: "x", change_kinds: ["unknown"], effects: ["read_only"], environment_fingerprint: "env" }), /unsupported kind/);
    assert.throws(() => f.plane.plan({ change_ref: "x", change_kinds: ["code"], effects: ["unknown"], environment_fingerprint: "env" }), /unsupported effect/);
    assert.throws(() => f.plane.plan({ change_ref: "x", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env", candidate_change: "yes" }), /boolean/);
    assert.throws(() => f.plane.plan({ change_ref: "x", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env", requested_risk_level: "other" }), /requested_risk_level/);

    const verification = f.plane.plan({ verification_id: "defensive", change_ref: "git:defensive", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env:one" }).verification as JsonObject;
    const check = (verification.checks as JsonObject[])[0]!;
    assert.throws(() => f.plane.record({ verification_id: verification.id, check_id: check.id, status: "other", summary: "bad", environment_fingerprint: "env:one" }), /unsupported/);
    assert.throws(() => f.plane.record({ verification_id: verification.id, check_id: check.id, status: "passed", summary: "missing proof", environment_fingerprint: "env:one" }), /requires Evidence/);
    assert.throws(() => f.plane.record({ verification_id: verification.id, check_id: check.id, status: "passed", summary: "weak proof", evidence_ids: ["unverified"], environment_fingerprint: "env:one" }), /confirmed or bounded/);
    f.plane.record({ receipt_id: "first", verification_id: verification.id, check_id: check.id, status: "passed", summary: "good", evidence_ids: ["confirmed"], environment_fingerprint: "env:one" });
    assert.throws(() => f.plane.record({ receipt_id: "first", verification_id: verification.id, check_id: check.id, status: "passed", summary: "changed", evidence_ids: ["confirmed"], environment_fingerprint: "env:one" }), /idempotency/);
    assert.throws(() => f.plane.record({ receipt_id: "second", verification_id: verification.id, check_id: check.id, status: "passed", summary: "again", evidence_ids: ["confirmed"], environment_fingerprint: "env:one" }), /already has a Receipt/);

    const direct = f.plane.plan({ verification_id: "direct", change_ref: "git:direct", change_kinds: ["code"], effects: ["read_only"], environment_fingerprint: "env:one" }).verification as JsonObject;
    f.plane.record({ verification_id: direct.id, check_id: "contract", status: "inconclusive", summary: "direct planned id", environment_fingerprint: "env:one" });

    const candidate = f.plane.plan({ verification_id: "assess-idempotency", change_ref: "candidate:two", change_kinds: ["harness"], effects: ["read_only"], candidate_change: true, environment_fingerprint: "env:one" }).verification as JsonObject;
    recordAll(f, candidate); f.store.create("release_qualification", "qualification-a", { conclusion: "eligible" }); f.store.create("release_qualification", "qualification-b", { conclusion: "inconclusive" });
    assert.equal(f.plane.assess({ assessment_id: "fixed", verification_id: candidate.id, release_qualification_id: "qualification-a" }).idempotent, false);
    assert.equal(f.plane.assess({ assessment_id: "fixed", verification_id: candidate.id, release_qualification_id: "qualification-a" }).idempotent, true);
    assert.throws(() => f.plane.assess({ assessment_id: "fixed", verification_id: candidate.id, release_qualification_id: "qualification-b" }), /idempotency/);
  } finally { await close(f); }
});
