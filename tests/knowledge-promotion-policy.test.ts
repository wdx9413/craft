import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../src/service.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-promotion-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  service.knowledgeSourceRegister({ source_id: "source", kind: "project_note", label: "Source", trust: "verified", scope_kind: "project", scope_id: "demo", locator: "README.md", content_digest: `sha256:${"b".repeat(64)}` });
  return { root, store, service };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

function candidate(service: CraftService, id = "claim") {
  const first = service.evidenceRecord({ evidence_id: `${id}-e1`, source_type: "observation", confidence: "confirmed", claim: "first observed fact" });
  const claim = service.knowledgeClaimSave({ claim_id: id, kind: "fact", content: "Run the focused test first.", scope: "project:demo", source_id: "source", evidence_ids: [first.id] }).claim as JsonObject;
  return { claim, first };
}

test("automatic promotion requires independent evidence by default and records the exact policy", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service);
    assert.equal((f.service.knowledgePromotionPolicyGet().policy as JsonObject).minimum_independent_support, 2);
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "run:one" });
    const insufficient = f.service.knowledgeAutoReview({ claim_ids: [claim.id], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[];
    assert.equal(insufficient[0]!.verdict, "revalidation_required");
    assert.equal(insufficient[0]!.promoted, false);
    const second = f.service.evidenceRecord({ evidence_id: "claim-e2", source_type: "receipt", confidence: "confirmed", claim: "second observed fact" });
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "run:two" });
    const automatic = f.service.knowledgeAutoReview({ claim_ids: [claim.id], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[];
    assert.equal(automatic[0]!.verdict, "eligible");
    assert.equal(automatic[0]!.promoted, true);
    assert.equal((f.store.get("knowledge_claim", String(claim.id)).review as JsonObject).reviewer, "automated-promotion-policy");
    assert.equal(((f.store.get("knowledge_claim", String(claim.id)).review as JsonObject).policy_revision), 1);
    assert.equal((f.service.knowledgeAutoReview({ claim_ids: [claim.id], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!.verdict, "already_reviewed");
  } finally { await close(f); }
});

test("support is idempotent but cannot be duplicated by observation or evidence", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service);
    const firstSave = f.service.knowledgeClaimSupportRecord({ support_id: "support", claim_id: claim.id, evidence_id: first.id, observation_key: "session:a" });
    assert.equal(firstSave.idempotent, false);
    assert.equal(f.service.knowledgeClaimSupportRecord({ support_id: "support", claim_id: claim.id, evidence_id: first.id, observation_key: "session:a" }).idempotent, true);
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "session:b" }), /evidence is already/u);
    const second = f.service.evidenceRecord({ evidence_id: "e2", source_type: "receipt", confidence: "bounded", claim: "second" });
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "session:a" }), /observation_key is already/u);
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "session:b", scope: "project:other" }), /scope must match/u);
    const weak = f.service.evidenceRecord({ evidence_id: "weak", source_type: "model", confidence: "unverified", claim: "guess" });
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: weak.id, observation_key: "session:weak" }), /requires bounded or confirmed/u);
    f.service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "optional-human", reason: "exception" });
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: second.id, observation_key: "session:c" }), /only be recorded for a candidate/u);
  } finally { await close(f); }
});

test("local policy can lower a threshold without turning off deterministic safety blocks", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service);
    f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "fresh-run" });
    const changed = f.service.knowledgePromotionPolicySave({ minimum_independent_support: 1, minimum_confidence: "confirmed", actor: "operator" });
    assert.equal((changed.policy as JsonObject).revision, 2);
    assert.equal(f.service.knowledgePromotionPolicySave({ minimum_independent_support: 1, minimum_confidence: "confirmed", actor: "another" }).idempotent, true);
    assert.throws(() => f.service.knowledgePromotionPolicySave({ minimum_independent_support: 0 }), /between 1 and 10/u);
    assert.throws(() => f.service.knowledgePromotionPolicySave({ minimum_confidence: "maybe" }), /bounded or confirmed/u);
    assert.equal((f.service.knowledgeAutoReview({ claim_ids: [claim.id], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!.promoted, true);

    const conflicted = candidate(f.service, "conflicted");
    f.service.knowledgeClaimSupportRecord({ claim_id: conflicted.claim.id, evidence_id: conflicted.first.id, observation_key: "conflict-one" });
    const other = candidate(f.service, "other");
    f.service.knowledgeRelationSave({ relation_id: "contradiction", from_claim_id: conflicted.claim.id, to_claim_id: other.claim.id, relation: "contradicts" });
    const blocked = (f.service.knowledgeAutoReview({ claim_ids: [conflicted.claim.id], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!;
    assert.equal(blocked.promoted, false);
    assert((blocked.reasons as string[]).includes("contradiction_requires_adjudication"));
    assert.equal((f.service.knowledgeAutoReview({ claim_ids: [other.claim.id], auto_promote: false, now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!.promoted, false);
  } finally { await close(f); }
});

test("a Codex Host review promotes one exact current Claim without an independent provider key", async () => {
  const f = await fixture();
  try {
    const { claim } = candidate(f.service, "codex-reviewed");
    const args = {
      claim_id: claim.id, host_kind: "codex", host_run_key: "codex:thread-7:turn-3",
      source_digest: `sha256:${"b".repeat(64)}`, decision: "supported", model_ref: "host-managed",
      rubric_id: "knowledge-host-review-v1", reason_code: "rubric_pass", now: "2026-09-20T00:00:00.000Z",
    };
    const result = f.service.knowledgeHostReview(args);
    assert.equal(result.promoted, true);
    assert.equal(result.status, "reviewed");
    assert.equal(((result.claim as JsonObject).review as JsonObject).reviewer, "host:codex");
    assert.equal(((result.evidence as JsonObject).metadata as JsonObject).model_ref, "host-managed");
    assert.equal(f.service.knowledgeHostReview(args).idempotent, true);
  } finally { await close(f); }
});

test("Host review keeps insufficient, stale, conflicted, and rejected Claims outside Context", async () => {
  const f = await fixture();
  try {
    const { claim } = candidate(f.service, "host-blocked");
    const base = { claim_id: claim.id, host_run_key: "codex:one", source_digest: `sha256:${"b".repeat(64)}`, decision: "supported", now: "2026-09-20T00:00:00.000Z" };
    assert.throws(() => f.service.knowledgeHostReview({ ...base, host_kind: "other" }), /host_kind/u);
    assert.throws(() => f.service.knowledgeHostReview({ ...base, source_digest: "sha256:wrong" }), /source_digest/u);
    assert.throws(() => f.service.knowledgeHostReview({ ...base, decision: "maybe" }), /decision/u);
    assert.throws(() => f.service.knowledgeHostReview({ ...base, reason_code: "not a stable code" }), /reason_code/u);
    assert.throws(() => f.service.knowledgeHostReview({ ...base, now: "bad-date" }), /ISO timestamp/u);

    const deferred = f.service.knowledgeHostReview({ ...base, decision: "needs_evidence", host_kind: "claude", model_ref: "host-managed" });
    assert.equal(deferred.promoted, false);
    assert.equal(deferred.status, "needs_evidence");
    const rejected = f.service.knowledgeHostReview({ ...base, decision: "rejected", host_kind: "independent", host_run_key: "runner:two" });
    assert.equal(rejected.status, "rejected");
    const defaulted = candidate(f.service, "host-defaulted");
    assert.equal(f.service.knowledgeHostReview({ claim_id: defaulted.claim.id, host_run_key: "codex:defaulted", source_digest: `sha256:${"b".repeat(64)}`, decision: "rejected" }).status, "rejected");

    const conflicted = candidate(f.service, "host-conflicted");
    const other = candidate(f.service, "host-other");
    f.service.knowledgeRelationSave({ relation_id: "host-contradiction", from_claim_id: conflicted.claim.id, to_claim_id: other.claim.id, relation: "contradicts" });
    const conflict = f.service.knowledgeHostReview({ ...base, claim_id: conflicted.claim.id, host_run_key: "codex:conflict" });
    assert.equal(conflict.promoted, false);
    assert((conflict.blocking_reasons as string[]).includes("contradiction_requires_adjudication"));

    const raw = f.store.create("knowledge_claim", "host-weak", { status: "candidate", source_id: "source", scope: "project:demo", content: "body", evidence_ids: [] });
    const weak = f.service.knowledgeHostReview({ ...base, claim_id: raw.id, host_run_key: "codex:weak" });
    assert.equal(weak.status, "needs_evidence");
    assert((weak.blocking_reasons as string[]).includes("credible_evidence_missing"));

    const noSource = f.store.create("knowledge_claim", "host-no-source", { status: "candidate", scope: "project:demo", content: "body", evidence_ids: [] });
    assert.throws(() => f.service.knowledgeHostReview({ ...base, claim_id: noSource.id, host_run_key: "codex:no-source" }), /source_digest/u);
    f.service.knowledgeSourceRegister({ source_id: "untrusted", kind: "project_note", label: "Untrusted", trust: "untrusted", scope_kind: "project", scope_id: "demo", locator: "untrusted.md", content_digest: `sha256:${"d".repeat(64)}` });
    const evidence = f.service.evidenceRecord({ evidence_id: "untrusted-evidence", source_type: "observation", confidence: "confirmed", claim: "observed" });
    const untrusted = f.service.knowledgeClaimSave({ claim_id: "host-untrusted", kind: "fact", content: "body", scope: "project:demo", source_id: "untrusted", evidence_ids: [evidence.id] }).claim as JsonObject;
    const untrustedResult = f.service.knowledgeHostReview({ ...base, claim_id: untrusted.id, host_run_key: "codex:untrusted", source_digest: `sha256:${"d".repeat(64)}` });
    assert((untrustedResult.blocking_reasons as string[]).includes("source_not_trusted_active"));

    const expired = f.store.create("knowledge_claim", "host-expired", { status: "candidate", source_id: "source", scope: "project:demo", content: "body", evidence_ids: [evidence.id], valid_until: "2020-01-01T00:00:00.000Z" });
    const expiredResult = f.service.knowledgeHostReview({ ...base, claim_id: expired.id, host_run_key: "codex:expired" });
    assert((expiredResult.blocking_reasons as string[]).includes("claim_expired"));
    const missingBody = f.store.create("knowledge_claim", "host-missing-body", { status: "candidate", source_id: "source", scope: "project:demo", evidence_ids: [evidence.id] });
    const bodyResult = f.service.knowledgeHostReview({ ...base, claim_id: missingBody.id, host_run_key: "codex:body" });
    assert((bodyResult.blocking_reasons as string[]).includes("content_reference_invalid"));

    const manual = f.store.create("knowledge_claim", "host-manual-reviewed", { status: "reviewed", source_id: "source", scope: "project:demo", content: "body", evidence_ids: [evidence.id], review: { reviewer: "manual" } });
    const manualResult = f.service.knowledgeHostReview({ ...base, claim_id: manual.id, host_run_key: "codex:manual" });
    assert.equal(manualResult.status, "already_reviewed");
    const retired = f.store.create("knowledge_claim", "host-retired", { status: "expired", source_id: "source", scope: "project:demo", content: "body", evidence_ids: [evidence.id] });
    const retiredResult = f.service.knowledgeHostReview({ ...base, claim_id: retired.id, host_run_key: "codex:retired" });
    assert((retiredResult.blocking_reasons as string[]).includes("claim_status_expired"));
  } finally { await close(f); }
});

test("portable bundles carry append-only support but never the local promotion policy", async () => {
  const source = await fixture(); const target = await fixture();
  try {
    const { claim, first } = candidate(source.service);
    source.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: first.id, observation_key: "machine-a:one" });
    const bundle = source.service.knowledgeMemoryBundleExport({ scope_kind: "project", scope_id: "demo", exported_at: "2026-09-20T00:00:00.000Z" }).bundle as JsonObject;
    const kinds = (bundle.records as JsonObject[]).map((record) => record.kind);
    assert(kinds.includes("knowledge_claim_support"));
    assert(!kinds.includes("knowledge_promotion_policy"));
    // Both fixtures already carry the same local Source descriptor; only the
    // Evidence, Claim and append-only support are additions on the other machine.
    assert.equal(target.service.knowledgeMemoryBundleImportPlan({ bundle }).additions, 3);
    target.service.knowledgeMemoryBundleImportApply({ bundle, approved: true, import_id: "portable" });
    assert.equal(target.store.list("knowledge_claim_support", 10_000).length, 1);
  } finally { await close(source); await close(target); }
});

test("promotion policy rejects malformed inputs and reports every non-promotable Claim state", async () => {
  const f = await fixture();
  try {
    const { claim, first } = candidate(f.service);
    // Default values and the automatic circuit breaker are both explicit policy branches.
    assert.equal(f.service.knowledgePromotionPolicySave({}).idempotent, true);
    assert.equal((f.service.knowledgePromotionPolicySave({ automatic: false }).policy as JsonObject).automatic, false);
    f.service.knowledgePromotionPolicySave({ automatic: true });
    assert.throws(() => f.service.knowledgeAutoReview({ claim_ids: [] }), /non-empty array/u);
    assert.throws(() => f.service.knowledgeAutoReview({ claim_ids: "claim" as never }), /non-empty array/u);
    assert.throws(() => f.service.knowledgeAutoReview({ claim_ids: [claim.id], now: "not-a-date" }), /ISO timestamp/u);
    assert.equal((f.service.knowledgeAutoReview({}).assessments as JsonObject[]).length, 1);

    f.service.knowledgeClaimSupportRecord({ support_id: "conflict-id", claim_id: claim.id, evidence_id: first.id, observation_key: "run:one" });
    const second = f.service.evidenceRecord({ evidence_id: "conflict-e2", source_type: "receipt", confidence: "confirmed", claim: "second" });
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ support_id: "conflict-id", claim_id: claim.id, evidence_id: second.id, observation_key: "run:two" }), /idempotency conflict/u);

    const raw = (id: string, extra: JsonObject = {}) => f.store.create("knowledge_claim", id, {
      status: "candidate", scope: "project:demo", source_id: "source", evidence_ids: [first.id], content: "body", ...extra,
    });
    raw("missing-source", { source_id: "missing-source" });
    f.service.knowledgeSourceRegister({ source_id: "paused", kind: "project_note", label: "Paused", trust: "verified", scope_kind: "project", scope_id: "demo", locator: "paused.md", content_digest: `sha256:${"c".repeat(64)}` });
    f.service.knowledgeSourceTransition({ source_id: "paused", status: "revoked", reason: "fixture" });
    raw("untrusted-source", { source_id: "paused" });
    raw("no-evidence-array", { evidence_ids: null });
    raw("no-scope", { scope: null });
    raw("missing-body", { content: null, content_ref: null });
    raw("drifted-body", { content: null, content_ref: { kind: "knowledge", record_id: "absent", version: 1, path: "/absent.md", digest: "sha256:absent", format: "markdown" } });
    raw("expired", { valid_until: "2020-01-01T00:00:00.000Z" });
    raw("future", { valid_until: "2030-01-01T00:00:00.000Z" });
    raw("noncandidate", { status: "revoked", identity_digest: null });
    const assessed = f.service.knowledgeAutoReview({ claim_ids: ["missing-source", "untrusted-source", "no-evidence-array", "no-scope", "missing-body", "drifted-body", "expired", "future", "noncandidate"], auto_promote: false, now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[];
    const byId = new Map(assessed.map((item) => [String(item.claim_id), item]));
    assert((byId.get("missing-source")!.reasons as string[]).includes("source_not_registered"));
    assert((byId.get("untrusted-source")!.reasons as string[]).includes("source_not_trusted_active"));
    assert((byId.get("no-evidence-array")!.reasons as string[]).includes("credible_evidence_missing"));
    assert((byId.get("no-scope")!.reasons as string[]).includes("source_not_trusted_active") === false);
    assert((byId.get("missing-body")!.reasons as string[]).includes("content_reference_invalid"));
    assert((byId.get("drifted-body")!.reasons as string[]).includes("content_reference_invalid"));
    assert((byId.get("expired")!.reasons as string[]).includes("claim_expired"));
    assert.equal(byId.get("future")!.verdict, "revalidation_required");
    assert.equal(byId.get("noncandidate")!.verdict, "rejected");
  } finally { await close(f); }
});
