import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-cognitive-write-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  return { store, service, module: service.cognitiveWrites, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("user statement capture keeps consent, identity, Evidence, review and commit together", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.module.captureUserStatement({}), /consent/);
    for (const content of [null, "", " ", 42]) assert.throws(() => f.module.captureUserStatement({ explicit_consent: true, content }), /empty/);
    assert.throws(() => f.module.captureUserStatement({ explicit_consent: true, content: 'password":x' }), /sensitive assignments/);
    assert.throws(() => f.module.captureUserStatement({ explicit_consent: true, content: "valid", kind: "invalid" }), /kind/);
    assert.throws(() => f.module.captureUserStatement({ explicit_consent: true, content: "valid", topic: "" }), /topic/);
    const proposal = f.module.captureUserStatement({ explicit_consent: true, content: "  Prefer focused tests.  " });
    assert.equal(proposal.auto_committed, false); assert.equal(proposal.next_action, "review_or_accept");
    const hash = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
    const identity = { kind: "preference", scope_kind: "user", scope_id: "local", topic: null, content_digest: hash("  Prefer focused tests.  ") };
    const suffix = hash(identity).slice(-20);
    assert.equal((proposal.evidence as JsonObject).id, `evidence_memory_statement_${suffix}`);
    assert.equal((proposal.candidate as JsonObject).id, `memory_candidate_statement_${suffix}`);
    assert.equal(f.store.list("memory_ledger", 100).length, 0);
    const accepted = f.module.captureUserStatement({ explicit_consent: true, content: "Use green theme", kind: "preference", topic: "ui:theme",
      scope_kind: "project", scope_id: "p", scope_envelope: {}, evidence_id: "theme-evidence", candidate_id: "theme-candidate", memory_id: "theme-memory", sensitivity: "internal", auto_accept: true });
    assert.equal(accepted.auto_committed, true); assert.equal(accepted.next_action, "available_for_scoped_context");
    assert.equal(f.store.get("memory_candidate", "theme-candidate").status, "approved");
    assert.deepEqual(f.store.get("memory_ledger", "theme-memory").scope, { kind: "project", id: "p" });
    assert.equal(f.store.get("evidence", "theme-evidence").confidence, "bounded");
    const conflict = f.module.captureUserStatement({ explicit_consent: true, content: "Use blue theme", topic: "ui:theme", scope_kind: "project", scope_id: "p", auto_accept: true });
    assert.equal(conflict.auto_committed, false); assert.equal(conflict.next_action, "resolve_conflict");
    assert.equal(f.store.get("memory_ledger", "theme-memory").status, "active");
  } finally { await f.close(); }
});

test("disabled capture writes nothing, while governed capture reports its actual single commit", async () => {
  const f = await fixture();
  try {
    f.service.memoryPolicySave({ mode: "off", updated_by: "operator" });
    const disabled = f.module.captureUserStatement({ explicit_consent: true, content: "Prefer focused tests", auto_accept: true });
    assert.equal(disabled.status, "disabled"); assert.equal(disabled.next_action, "memory_disabled");
    assert.equal(disabled.candidate, null); assert.equal(disabled.auto_committed, false);
    for (const kind of ["knowledge_source", "evidence", "memory_candidate", "memory_ledger"]) assert.equal(f.store.list(kind, 100).length, 0);
    f.service.memoryPolicySave({ mode: "governed", min_confidence: "bounded", updated_by: "operator" });
    const committed = f.module.captureUserStatement({ explicit_consent: true, content: "Use green theme", topic: "ui:theme", candidate_id: "governed-theme", auto_accept: true });
    assert.equal(committed.auto_committed, true); assert.equal(committed.next_action, "available_for_scoped_context");
    assert.equal((committed.candidate as JsonObject).status, "approved");
    assert.equal((committed.memory as JsonObject).status, "active");
    const memories = f.store.list("memory_ledger", 100);
    assert.equal(memories.length, 1); assert.equal(memories[0]!.version, 1);
    // propose -> policy review -> ledger binding; a second review/commit would add revisions.
    assert.equal(f.store.get("memory_candidate", "governed-theme").version, 3);
    assert.equal((f.store.get("memory_candidate", "governed-theme").review as JsonObject).reviewer, "governed-policy");
    const conflict = f.module.captureUserStatement({ explicit_consent: true, content: "Use blue theme", topic: "ui:theme", auto_accept: true });
    assert.equal(conflict.auto_committed, false); assert.equal(conflict.next_action, "resolve_conflict");
    assert.equal(f.store.list("memory_ledger", 100).length, 1);
    // A stricter governed threshold does not silently commit bounded user Evidence.
    f.service.memoryPolicySave({ mode: "governed", min_confidence: "confirmed", updated_by: "operator" });
    const proposed = f.module.captureUserStatement({ explicit_consent: true, content: "Prefer small changes", candidate_id: "strict", auto_accept: false });
    assert.equal(proposed.auto_committed, false); assert.equal((proposed.candidate as JsonObject).status, "candidate");
    assert.equal(f.store.list("memory_ledger", 100).length, 1);
  } finally { await f.close(); }
});

test("expiry changes only elapsed reviewed claims and retains content references", async () => {
  const f = await fixture();
  try {
    assert.equal(f.module.sweepExpiredClaims().count, 0);
    assert.throws(() => f.module.sweepExpiredClaims({ now: "invalid" }), /ISO/);
    f.store.create("knowledge_claim", "candidate", { status: "candidate", valid_until: "2000-01-01" });
    f.store.create("knowledge_claim", "no-expiry", { status: "reviewed" });
    f.store.create("knowledge_claim", "future", { status: "reviewed", valid_until: "2099-01-01" });
    f.store.create("knowledge_claim", "elapsed-legacy", { status: "reviewed", valid_until: "2000-01-01", content: "legacy" });
    f.store.create("knowledge_claim", "elapsed-ref", { status: "reviewed", valid_until: "2000-01-01", content_ref: { digest: "pinned" }, content: "must not duplicate" });
    assert.equal(f.module.sweepExpiredClaims({ now: "2030-01-01" }).count, 2);
    assert.equal(f.store.get("knowledge_claim", "candidate").status, "candidate");
    assert.equal(f.store.get("knowledge_claim", "future").status, "reviewed");
    assert.equal(f.store.get("knowledge_claim", "elapsed-legacy").content, "legacy");
    assert.equal(f.store.get("knowledge_claim", "elapsed-ref").content, undefined);
    assert.deepEqual(f.store.get("knowledge_claim", "elapsed-ref").content_ref, { digest: "pinned" });
  } finally { await f.close(); }
});

test("conflict resolution cannot elevate unsupported Evidence or bypass Claim review", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    for (const [id, confidence] of [["unverified", "unverified"], ["bounded", "bounded"], ["confirmed", "confirmed"]]) f.store.create("evidence", id, { confidence });
    for (const [id, evidence] of [["none", null], ["weak", ["unverified"]], ["bounded-claim", ["bounded"]], ["confirmed-claim", ["confirmed"]]]) f.store.create("knowledge_claim", id as string, { status: "candidate", source_id: "builtin.evidence-wiki", evidence_ids: evidence });
    const request = { claim_id: "none", decision: "reviewed", reviewer: "human", reason: "checked" };
    assert.throws(() => f.module.resolveClaimConflict({ ...request, decision: "invalid" }), /unsupported/);
    assert.throws(() => f.module.resolveClaimConflict(request), /Evidence/);
    assert.throws(() => f.module.resolveClaimConflict({ ...request, claim_id: "weak" }), /Evidence/);
    for (const claim_id of ["bounded-claim", "confirmed-claim"]) assert.equal((f.module.resolveClaimConflict({ ...request, claim_id }).claim as JsonObject).status, "reviewed");
    assert.equal((f.module.resolveClaimConflict({ ...request, decision: "disputed" }).claim as JsonObject).status, "disputed");
    assert.throws(() => f.module.resolveClaimConflict({ ...request, decision: "superseded", reviewer: "" }), /reviewer/);
  } finally { await f.close(); }
});
