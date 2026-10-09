import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { contextAssetRef, contextAssetKey, contextAssetMatches, requiredContextRef } from "../common/craft-common-base/src/context-assets.ts";
import { ContextWorkingSetKernel } from "../core/context-working-set.ts";
import { codeContextCandidates, codeQueryTerms } from "../capability/craft-codebase/context-search.ts";
import { discoverContextTools } from "../core/mcp/context-tools.ts";
import { ProcedurePlanner } from "../capability/craft-experience/procedure-composition.ts";
import { activeProcedure, preserveProcedureRelease, selectedProcedure, updateProcedureRelease } from "../capability/craft-experience/procedure-release.ts";
import { fixture as invocationFixture, scope, spec } from "./helpers/procedure-invocation-fixture.ts";
import { KnowledgeClaimGovernance } from "../capability/craft-knowledge/claim-governance.ts";
import { stableDigest, payload } from "../core/digest.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-context-fixes-")), repo = join(root, "repo"); mkdirSync(repo); execFileSync("git", ["-C", repo, "init", "-q"]);
  writeFileSync(join(repo, "login.ts"), "export function loginUser() { return true; }");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(), service = new CraftService(store); service.knowledgeMemoryInstallBuiltins();
  const scope = (service.scopeIdentityResolveProject({ project_root: repo }).identity as JsonObject).canonical_scope as JsonObject;
  return { root, repo, store, service, scope, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("typed refs retain asset identity, explicit revisions and optional pins", () => {
  const scope = { kind: "project", id: "p" };
  const variants = [{ memory_id: "m", memory_version: 1, content_digest: "d" }, { claim_id: "c", claim_version: 2, scope: "project:p" }, { procedure_id: "p", procedure_version: 3, definition_digest: "g" }, { node_id: "n", record_version: 4, source_digest: "s", content_version: 2 }, { ref_id: "h", version: 5, content: "host" }, { id: "s", version: 6 }];
  for (const [i, member] of ["memory", "knowledge", "experience", "codebase", "history", "state"].entries()) {
    const ref = contextAssetRef(member, variants[i]!, scope); assert(!contextAssetKey(ref).includes("undefined")); assert(contextAssetMatches({ member, id: ref.id }, ref));
    assert(contextAssetMatches({ member, id: ref.id, version: ref.version, digest: ref.digest, index_id: ref.index_id, checkpoint_id: ref.checkpoint_id }, ref));
    for (const key of ["member", "id", "version", "digest", "index_id", "checkpoint_id"]) assert.equal(contextAssetMatches({ member, id: ref.id, [key]: "wrong" }, ref), false);
  }
  assert.throws(() => contextAssetRef("bad", { id: "x", version: 1 }, scope), /Unsupported/);
  assert.throws(() => contextAssetRef("memory", { id: "x" }, scope), /explicit/);
  assert.throws(() => contextAssetRef("memory", { version: 1 }, scope), /id/);
  for (const value of [null, [], 1, { member: "bad", id: "x" }, { member: "memory", id: "" }, { member: "memory", id: "x", version: 0 }, { member: "memory", id: "x", digest: "" }]) assert.throws(() => requiredContextRef(value));
  assert.deepEqual(requiredContextRef({ member: "memory", id: "x", version: 1, digest: "d" }), { member: "memory", id: "x", version: 1, digest: "d" });
  assert(requiredContextRef({ member: "memory", id: "x" }));
});

test("code task reserves code; required refs fail closed; receipts reuse and invalidate on snapshot changes", async () => {
  const f = await fixture();
  try {
    f.store.create("memory_ledger", "one", { scope: f.scope, source_id: "builtin.evidence-wiki", status: "active", kind: "preference", sensitivity: "internal", content: "loginUser", content_digest: stableDigest("loginUser") });
    const args = { project_root: f.repo, query: "修复用户登录代码", max_items: 1, task_id: "task", session_id: "session", turn_id: "turn" };
    const first = await f.service.contextOpen(args); assert.equal((first.codebase as JsonObject).references instanceof Array, true); assert.equal(((first.codebase as JsonObject).references as unknown[]).length, 1); assert.equal((first.items as unknown[]).length, 0);
    const again = await f.service.contextOpen(args); assert.equal((again.pack_receipt as JsonObject).id, (first.pack_receipt as JsonObject).id);
    const required = (first.asset_refs as JsonObject[])[0]!;
    const pinned = await f.service.contextOpen({ ...args, required_refs: [required] }); assert.equal((pinned.asset_refs as JsonObject[])[0]!.id, required.id);
    await assert.rejects(f.service.contextOpen({ ...args, max_chars: 1, required_refs: [required] }), /exceeds/);
    await assert.rejects(f.service.contextOpen({ ...args, include_codebase: false, required_refs: [required] }), /unavailable/);
    await assert.rejects(f.service.contextOpen({ ...args, task_kind: "wrong" }), /task_kind/);
    await assert.rejects(f.service.contextOpen({ ...args, required_refs: "bad" }), /array/);
    await assert.rejects(f.service.contextOpen({ ...args, max_tokens: 1 }), /token budget/);
    const measured = first.injection_measurement as JsonObject; assert.equal(measured.exact, false); assert(Number(measured.estimated_tokens) > 0);
    writeFileSync(join(f.repo, "login.ts"), "export function loginUser() { return false; }");
    const changed = await f.service.contextOpen(args); assert.notEqual((changed.pack_receipt as JsonObject).id, (first.pack_receipt as JsonObject).id);
    await assert.rejects(f.service.contextOpen({ ...args, required_refs: [required] }), /unavailable/);
  } finally { f.close(); }
});

test("host references are bounded, content-free and required independently from retrieval", async () => {
  const f = await fixture();
  try {
    const kernel = new ContextWorkingSetKernel(f.store, f.service.contextResolution);
    const args = { query: "q", members: ["history", "state"], history_refs: [{ id: "history", version: 1, content: "private host body" }], state_refs: [{ id: "state", version: 2 }], scope_kind: "project", scope_id: "p" };
    const first = await kernel.resolve(args); assert.equal((first.asset_refs as unknown[]).length, 2); assert(!JSON.stringify(first.working_set).includes("private host body"));
    assert((await kernel.resolve({ ...args, required_refs: [{ member: "history", id: "history", version: 1 }] })).working_set);
    await assert.rejects(kernel.resolve({ ...args, required_refs: [{ member: "state", id: "missing" }] }), /unavailable/);
    await assert.rejects(kernel.resolve({ ...args, max_items: 1 }), /budget/);
    await assert.rejects(kernel.resolve({ ...args, max_chars: 1 }), /budget/);
    await assert.rejects(kernel.resolve({ ...args, history_refs: "bad" }), /array/);
    await assert.rejects(kernel.resolve({ ...args, required_refs: "bad" }), /array/);
    await assert.rejects(kernel.resolve({ ...args, members: ["memory"], empty_budget: true, memory_ids: ["m"] }), /budget/);
  } finally { f.close(); }
});

test("feedback attributes selected code and schedules correction without altering source", async () => {
  const f = await fixture();
  try {
    const pack = await f.service.contextOpen({ project_root: f.repo, query: "登录代码" }); const id = (pack.pack_receipt as JsonObject).id;
    const feedback = f.service.contextResolutionFeedback({ receipt_id: id, outcome: "stale", usage_stage: "used", asset_refs: pack.asset_refs }); assert.equal((feedback.corrections as unknown[]).length, 2);
    assert.equal(f.service.contextResolutionFeedback({ receipt_id: id, outcome: "stale", usage_stage: "used", asset_refs: pack.asset_refs }).idempotent, true);
    assert.throws(() => f.service.contextResolutionFeedback({ receipt_id: id, outcome: "helpful", asset_refs: [{ member: "codebase", id: "other" }] }), /not selected/);
    assert.throws(() => f.service.contextResolutionFeedback({ receipt_id: id, outcome: "helpful", usage_stage: "verified" }), /Evidence/);
    assert.throws(() => f.service.contextResolutionFeedback({ receipt_id: id, outcome: "helpful", usage_stage: "bad" }), /usage_stage/);
    assert.throws(() => f.service.contextResolutionFeedback({ receipt_id: id, outcome: "helpful", asset_refs: "bad" }), /array/);
    f.store.create("evidence", "verified", { source_type: "program", confidence: "confirmed", metadata: { context_receipt_id: id, verdict: "passed" } });
    assert.equal((f.service.contextResolutionFeedback({ receipt_id: id, outcome: "helpful", usage_stage: "verified", evidence_ids: ["verified"] }).feedback as JsonObject).evidence_verified, true);
  } finally { f.close(); }
});

test("SQL scoped selection handles string/object scopes and predicates before hydration", async () => {
  const f = await fixture();
  try {
    f.store.create("thing", "a", { scope: { kind: "project", id: "a" } }); f.store.create("thing", "b", { scope: "project:b" }); f.store.create("thing", "g", { scope: "global" });
    assert.deepEqual(f.store.listScoped("thing", [{ kind: "project", id: "a" }]).map(item => item.id), ["a"]);
    assert.deepEqual(f.store.listScoped("thing", [{ kind: "project", id: "b" }], 1, item => item.id === "b").map(item => item.id), ["b"]);
    assert.equal(f.store.listScoped("thing", [{ kind: "global", id: "global" }]).length, 1); assert.deepEqual(f.store.listScoped("thing", []), []);
    assert.throws(() => f.store.listScoped("thing", [null] as never), /Invalid/); assert.throws(() => f.store.listScoped("thing", "bad" as never), /Invalid/);
  } finally { f.close(); }
});

test("discovery and Chinese code matching are bounded hints", () => {
  assert(codeQueryTerms("登录").includes("login")); assert.deepEqual(codeQueryTerms(""), []);
  const found = codeContextCandidates({ nodes: [{ id: "b", name: "loginUser", path: "b.ts" }, { id: "a", name: "loginUser", path: "a.ts" }, { id: "z", name: "other", path: "z.ts" }] }, "登录", 1);
  assert.equal((found.symbols as JsonObject[])[0]!.id, "a"); assert.equal(found.omitted_count, 1);
  assert.equal((codeContextCandidates({ nodes: [] }, "x").symbols as unknown[]).length, 0);
  for (const intent of [undefined, "recall", "knowledge", "memory", "experience", "code"]) { const discovery = discoverContextTools({ intent }); assert((discovery.tools as unknown[]).length > 0); assert(Number(discovery.schema_estimated_tokens) > 0); }
  assert.throws(() => discoverContextTools({ intent: "bad" }), /intent/);
});

test("formal release survives candidate edits and failures while test planning remains read-only", async () => {
  const f = await invocationFixture();
  try {
    assert.equal(activeProcedure(f.store, String(f.create().id))?.routeable, true); preserveProcedureRelease(f.store, null);
    const p = f.create(); preserveProcedureRelease(f.store, p); preserveProcedureRelease(f.store, p);
    f.service.procedureInvocationBind(f.args(p));
    const candidate = f.service.procedureConfigurationSave({ procedure_id: p.id, scope, title: "new review", procedure_kind: "workflow", scenario_id: "review", definition: spec(), expected_version: p.version }).procedure as JsonObject;
    assert.equal(activeProcedure(f.store, String(p.id))?.version, p.version); assert(f.dispatch().dispatch);
    const args = { ...f.args(candidate, "test"), release_channel: "test", allowed_effects: ["read_only"] };
    assert(f.service.procedureInvocationBind(args).invocation); assert(f.dispatch("test").dispatch);
    assert.throws(() => new ProcedurePlanner(f.store).plan({ ...args, allowed_effects: ["local_write"] }), /read_only/);
    assert.throws(() => selectedProcedure(f.store, String(p.id), "bad"), /release_channel/);
    const failed = f.store.save("experience_procedure", String(p.id), { ...payload(candidate), lifecycle: "rejected" }); updateProcedureRelease(f.store, failed); assert.equal(activeProcedure(f.store, String(p.id))?.version, p.version);
    const promoted = f.store.save("experience_procedure", String(p.id), { ...payload(candidate), lifecycle: "routeable", routeable: true }); updateProcedureRelease(f.store, promoted); assert.equal(selectedProcedure(f.store, String(p.id), "current")?.version, promoted.version); assert.equal(selectedProcedure(f.store, String(p.id), "test"), null);
    const revoked = f.store.save("experience_procedure", String(p.id), { ...payload(promoted), lifecycle: "rolled_back", routeable: false }); assert.equal(activeProcedure(f.store, String(p.id)), null); updateProcedureRelease(f.store, revoked); updateProcedureRelease(f.store, revoked); assert.equal(activeProcedure(f.store, String(p.id)), null);
    const unqualified = f.store.create("experience_procedure", "none", { lifecycle: "candidate" }); assert.equal(activeProcedure(f.store, String(unqualified.id)), null);
  } finally { await f.close(); }
});

test("standalone memory governance suggests rather than overwrites topics and confirms pinned entries", async () => {
  const f = await fixture();
  try {
    const scope = { scope_kind: "project", scope_id: "p" };
    f.store.create("evidence", "user", { source_type: "human", confidence: "bounded" });
    const memory = f.service.memoryLedgerRemember({ ...scope, memory_id: "preference", source_id: "builtin.evidence-wiki", kind: "preference", content: "Prefer Python tools", topic: "language", evidence_ids: ["user"] }).memory as JsonObject;
    f.service.memoryLedgerRemember({ ...scope, memory_id: "another-topic", source_id: "builtin.evidence-wiki", kind: "preference", content: "Python", topic: "short", evidence_ids: ["user"] });
    f.service.memoryLedgerRemember({ ...scope, memory_id: "tied-topic", source_id: "builtin.evidence-wiki", kind: "preference", content: "Python", topic: "alpha", evidence_ids: ["user"] });
    const governance = f.service.memoryGovernance;
    assert.equal(((governance.topicSuggestions({ ...scope, content: "Python tools" }).suggestions) as JsonObject[])[0]!.topic, "language");
    assert.equal((governance.topicSuggestions({ ...scope, content: "unrelated" }).suggestions as unknown[]).length, 0);
    assert.throws(() => governance.confirm({ memory_id: memory.id }), /consent/);
    assert.throws(() => governance.confirm({ memory_id: memory.id, explicit_consent: true, expected_version: 0 }), /version/);
    assert.throws(() => governance.confirm({ memory_id: memory.id, explicit_consent: true, expected_version: memory.version }), /Evidence/);
    const args = { memory_id: memory.id, explicit_consent: true, expected_version: memory.version, evidence_ids: ["user"] };
    assert.deepEqual(governance.confirm(args), governance.confirm(args));
    f.store.create("memory_candidate", "candidate", { scope: { kind: "project", id: "p" }, status: "candidate" });
    f.store.create("context_correction_task", "correction", { status: "pending_review", asset_ref: { member: "memory", id: memory.id, version: memory.version, scope: { kind: "project", id: "p" } } });
    const tasks = governance.governanceTasks(scope); assert.equal((tasks.candidates as unknown[]).length, 1); assert.equal((tasks.corrections as unknown[]).length, 1);
  } finally { f.close(); }
});

test("Knowledge SDK synchronizes expiration, source drift, documents and evidenced contradictions", async () => {
  const f = await fixture();
  try {
    const sdk = new KnowledgeClaimGovernance(f.store);
    assert.throws(() => sdk.synchronize({ now: "bad" }), /timestamp/);
    const base = { source_id: "builtin.evidence-wiki", scope: "project:p", status: "reviewed", content: "fact" };
    f.store.create("knowledge_claim", "expired", { ...base, valid_until: "2020-01-01" });
    f.store.create("knowledge_claim", "drift", { ...base, review: { source_digest: "old" } });
    f.store.create("knowledge_claim", "missing", { ...base, source_id: "missing" });
    f.store.create("knowledge_claim", "document", { ...base, document_id: "missing" });
    f.store.create("knowledge_claim", "a", base); f.store.create("knowledge_claim", "b", base); f.store.create("knowledge_claim", "healthy", base);
    f.store.create("knowledge_relation", "contradiction", { relation: "contradicts", valid_to: null, confidence: "bounded", source: { kind: "knowledge_claim", id: "a" }, target: { kind: "knowledge_claim", id: "b" } });
    const affected = sdk.synchronize({ now: "2026-10-09T00:00:00Z" }).affected as JsonObject[]; assert.equal(affected.length, 6);
    assert.equal(f.store.get("knowledge_claim", "expired").status, "expired"); assert.equal(f.store.get("knowledge_claim", "a").status, "disputed"); assert.equal(f.store.get("knowledge_claim", "healthy").status, "reviewed");
    assert.equal(sdk.synchronize().count, 0);
    f.store.create("knowledge_document", "changed", { status: "changed", content_digest: "d" });
    f.store.create("knowledge_document", "current", { status: "current", content_digest: "d" });
    f.store.create("knowledge_claim", "changed-document", { ...base, document_id: "changed", document_digest: "d" });
    f.store.create("knowledge_claim", "wrong-digest", { ...base, document_id: "current", document_digest: "old" });
    f.store.create("knowledge_claim", "matching-document", { ...base, document_id: "current", document_digest: "d" });
    assert.equal(sdk.synchronize().count, 2);
  } finally { f.close(); }
});

test("required Knowledge and Memory refs do not depend on lexical relevance", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "proof", { confidence: "confirmed" });
    const sdk = new KnowledgeClaimGovernance(f.store);
    sdk.knowledgeClaimSave({ claim_id: "claim", kind: "fact", content: "Mandatory unrelated detail", scope: `${f.scope.kind}:${f.scope.id}`, evidence_ids: ["proof"] });
    const claim = sdk.knowledgeClaimReview({ claim_id: "claim", status: "reviewed", reviewer: "human", reason: "verified" }).claim as JsonObject;
    const requested = { member: "knowledge", id: claim.id, version: claim.version };
    const result = await f.service.contextOpen({ project_root: f.repo, query: "unmatched", include_codebase: false, required_refs: [requested] });
    assert.equal(((result.contributions as JsonObject[])[0]!.items as JsonObject[])[0]!.claim_id, claim.id);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "unmatched", include_codebase: false, required_refs: [{ ...requested, version: 999 }] }), /unavailable/);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "unmatched", include_codebase: false, max_chars: 1, required_refs: [requested] }), /budget/);
    const id = (result.receipt as JsonObject).id;
    const feedback = f.service.contextResolutionFeedback({ receipt_id: id, outcome: "incorrect", injected_tokens: 12, schema_tokens: 5, history_tokens: 2 });
    assert.equal(((feedback.feedback as JsonObject).asset_refs as JsonObject[])[0]!.member, "knowledge"); assert.equal((feedback.corrections as unknown[]).length, 1);
    assert.throws(() => f.service.contextResolutionFeedback({ receipt_id: id, outcome: "helpful", injected_tokens: -1 }), /non-negative/);
  } finally { f.close(); }
});

test("Graph matching recommends named routes and explains missing material without execution", async () => {
  const { matchGraphRoutes } = await import("../capability/craft-experience/graph-matching.ts");
  const definition = { graph_control: { entries: [{ id: "review", title: "code review", required_inputs: ["diff"], preconditions: ["approved"] }], subscenarios: [{ id: "review", entry_id: "review", exit_id: "reviewed" }, { id: "alternate", entry_id: "review", exit_id: "reviewed" }] } };
  const missing = matchGraphRoutes(definition, "review"); assert.equal((missing.routes as JsonObject[])[0]!.ready_to_plan, false);
  const ready = matchGraphRoutes(definition, "review", ["diff"]); assert.equal((ready.routes as JsonObject[])[0]!.ready_to_plan, true); assert.equal(ready.execution_authorized, false);
  assert.deepEqual(matchGraphRoutes(definition, "unmatched").routes, []); assert.throws(() => matchGraphRoutes(definition, ""), /query/);
  const bounded = { graph_control: { ...definition.graph_control, subscenarios: Array.from({ length: 25 }, (_, index) => ({ id: `review${index}`, entry_id: "review", exit_id: "reviewed" })) } };
  assert.equal(matchGraphRoutes(bounded, "review").omitted_count, 5);
});

test("standalone Claim SDK preserves validation, legacy replay and current/historical read gates", async () => {
  const f = await fixture();
  try {
    const sdk = new KnowledgeClaimGovernance(f.store), scope = "project:p";
    f.store.create("evidence", "proof", { confidence: "confirmed" }); f.store.create("evidence", "weak", { confidence: "unverified" });
    const args = { claim_id: "claim", kind: "fact", scope, content: "retained fact", evidence_ids: ["proof"], tags: ["fact"], title: "fact", valid_until: "2030-01-01" };
    const original = sdk.knowledgeClaimSave(args).claim as JsonObject; assert.equal(sdk.knowledgeClaimSave(args).idempotent, true);
    assert.throws(() => sdk.knowledgeClaimSave({ ...args, content: "different" }), /idempotency/);
    const variants = [{ kind: "bad" }, { content: "" }, { content: "token=secretvalue" }, { evidence_ids: undefined }, { evidence_ids: [] }, { evidence_ids: ["proof", "proof"] }, { tags: "bad" }, { tags: ["tag", "tag"] }, { valid_until: "bad" }, { title: "token=secretvalue" }];
    for (const variant of variants) assert.throws(() => sdk.knowledgeClaimSave({ ...args, ...variant }));
    assert(sdk.knowledgeClaimSave({ kind: "fact", content: "global fact", evidence_ids: ["proof"] }).claim);
    const { createHash } = await import("node:crypto");
    const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
    for (const older of [false, true]) {
      const id = older ? "older" : "legacy";
      const identity = { kind: "fact", content_digest: digest("legacy"), scope, ...(older ? {} : { source_id: "builtin.evidence-wiki" }), evidence_ids: ["proof"], tags: [], valid_until: null };
      f.store.create("knowledge_claim", id, { ...identity, source_id: "builtin.evidence-wiki", status: "candidate", content: "legacy", identity_digest: digest(identity) });
      assert.equal(sdk.knowledgeClaimSave({ claim_id: id, kind: "fact", content: "legacy", scope, evidence_ids: ["proof"] }).idempotent, true);
    }
    assert.equal((sdk.knowledgeClaimGet({ claim_id: original.id }).claim as JsonObject).version, original.version);
    assert.equal((sdk.knowledgeClaimGet({ claim_id: original.id, version: 1 }).claim as JsonObject).version, 1);
    assert.throws(() => sdk.knowledgeClaimGet({ claim_id: original.id, scope_id: "other" }), /denied/);
    assert.throws(() => sdk.knowledgeClaimGet({ claim_id: original.id, version: 0 }), /integer/);
    assert((sdk.knowledgeClaimList({}).claims as unknown[]).length > 0); assert.equal((sdk.knowledgeClaimList({ query: "retained fact", limit: 1 }).claims as unknown[]).length, 1);
    for (const status of ["candidate", "unknown"]) assert.throws(() => sdk.knowledgeClaimReview({ claim_id: original.id, status, reviewer: "human", reason: "review" }), /unsupported/);
    sdk.knowledgeClaimSave({ claim_id: "weak", kind: "fact", content: "weak", evidence_ids: ["weak"] });
    assert.throws(() => sdk.knowledgeClaimReview({ claim_id: "weak", status: "reviewed", reviewer: "human", reason: "review" }), /Evidence/);
    f.store.create("knowledge_claim", "no-evidence", { status: "candidate" });
    assert.throws(() => sdk.knowledgeClaimReview({ claim_id: "no-evidence", status: "reviewed", reviewer: "human", reason: "review" }), /Evidence/);
    f.store.create("knowledge_claim", "no-source", { evidence_ids: ["proof"], status: "candidate" });
    assert.throws(() => sdk.knowledgeClaimReview({ claim_id: "no-source", status: "reviewed", reviewer: "human", reason: "review" }), /Source/);
    f.store.create("knowledge_claim", "missing-source", { evidence_ids: ["proof"], status: "candidate", source_id: "absent" });
    assert.throws(() => sdk.knowledgeClaimReview({ claim_id: "missing-source", status: "reviewed", reviewer: "human", reason: "review" }), /Source/);
    const reviewed = sdk.knowledgeClaimReview({ claim_id: original.id, status: "reviewed", reviewer: "human", reason: "review" }).claim as JsonObject;
    f.store.save("knowledge_claim", String(original.id), { ...payload(reviewed), scope: "project:other", scope_envelope: undefined });
    assert.throws(() => sdk.knowledgeClaimGet({ claim_id: original.id, version: 1 }), /historical/);
    assert(sdk.knowledgeClaimReview({ claim_id: "weak", status: "disputed", reviewer: "human", reason: "contradicted" }).claim);
    f.store.save("evidence", "weak", { confidence: "bounded" });
    f.store.database.prepare("DELETE FROM records WHERE kind='knowledge_source' AND id='builtin.evidence-wiki'").run();
    assert(sdk.knowledgeClaimReview({ claim_id: "weak", status: "reviewed", reviewer: "human", reason: "now bounded" }));
  } finally { f.close(); }
});

test("Memory capture SDK preserves consent, policy-off, conflict and governed commit contracts", async () => {
  const { MemoryCapture } = await import("../capability/craft-memory/memory-capture.ts");
  const f = await fixture();
  try {
    const capture = new MemoryCapture(f.service.memoryGovernance, () => f.service.knowledgeMemoryInstallBuiltins(), args => f.service.evidenceRecord(args));
    for (const args of [{ content: "x" }, { explicit_consent: true, content: null }, { explicit_consent: true, content: " " }, { explicit_consent: true, content: "token=secretvalue" }, { explicit_consent: true, content: "x", kind: "bad" }, { explicit_consent: true, content: "x", topic: "" }]) assert.throws(() => capture.captureUserStatement(args));
    f.service.memoryGovernance.policySave({ mode: "off" }); const before = f.store.count("evidence");
    assert.equal(capture.captureUserStatement({ explicit_consent: true, content: "x" }).status, "disabled"); assert.equal(f.store.count("evidence"), before);
    f.service.memoryGovernance.policySave({ mode: "propose" });
    const captured = capture.captureUserStatement({ explicit_consent: true, content: "Python preference", auto_accept: true, scope_kind: "user", scope_id: "local", topic: "language", evidence_id: "user1", candidate_id: "candidate1", memory_id: "memory1", sensitivity: "internal", scope_envelope: { applicability: { kind: "user", id: "local" }, audience: { mode: "scoped", principal_ids: [] }, purpose: "preference", tenant_id: null } });
    assert.equal(captured.auto_committed, true);
    const conflict = capture.captureUserStatement({ explicit_consent: true, content: "Java preference", topic: "language", auto_accept: true }); assert.equal(conflict.next_action, "resolve_conflict");
    assert.equal(capture.captureUserStatement({ explicit_consent: true, content: "keep task notes", kind: "working" }).next_action, "review_or_accept");
    f.service.memoryGovernance.policySave({ mode: "governed", min_confidence: "bounded" });
    assert.equal(capture.captureUserStatement({ explicit_consent: true, content: "new user instruction", kind: "procedural", scope_id: "another" }).auto_committed, true);
  } finally { f.close(); }
});

test("current release revocation preserves its different test candidate and prevents new plans", async () => {
  const { ProcedureStore } = await import("../capability/craft-experience/procedure-projection.ts");
  const f = await invocationFixture();
  try {
    const p = f.create(), procedures = new ProcedureStore(f.store);
    const candidate = f.service.procedureConfigurationSave({ procedure_id: p.id, scope, title: "candidate", procedure_kind: "workflow", scenario_id: "review", definition: spec(), expected_version: p.version }).procedure as JsonObject;
    f.store.create("evidence", "revoked", { confidence: "confirmed" });
    const args = { procedure_id: p.id, release_channel: "current", stage: "canary", passed: false, expected_version: p.version, evidence_ids: ["revoked"] };
    assert.throws(() => procedures.gate({ ...args, passed: true }), /revocation/);
    assert.throws(() => procedures.gate({ ...args, stage: "shadow" }), /revocation/);
    assert.throws(() => procedures.gate({ ...args, expected_version: 999 }), /conflict/);
    assert.equal(procedures.gate(args).candidate_preserved, true); assert.equal(activeProcedure(f.store, String(p.id)), null); assert.equal(selectedProcedure(f.store, String(p.id), "test")?.version, candidate.version);
    assert.throws(() => procedures.gate(args), /unavailable/);
    const another = f.create(); assert.equal(procedures.gate({ ...args, procedure_id: another.id, expected_version: another.version }).candidate_preserved, false);
  } finally { await f.close(); }
});

test("typed required Memory refs retain mandatory material before optional code and budget failure", async () => {
  const f = await fixture();
  try {
    const memory = f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", memory_id: "required", kind: "preference", scope_kind: f.scope.kind, scope_id: f.scope.id, content: "unmatched required instruction" }).memory as JsonObject;
    const ref = { member: "memory", id: memory.id, version: memory.version };
    const args = { project_root: f.repo, query: "fix login code", max_items: 1, required_refs: [ref] };
    const result = await f.service.contextOpen(args); assert.equal((result.items as JsonObject[])[0]!.memory_id, memory.id); assert.equal(((result.codebase as JsonObject).references as unknown[]).length, 0);
    await assert.rejects(f.service.contextOpen({ ...args, required_refs: [{ ...ref, version: 999 }] }), /unavailable/);
    await assert.rejects(f.service.contextOpen({ ...args, max_chars: 1 }), /budget/);
    const receiptId = (result.receipt as JsonObject).id;
    assert.equal(((f.service.contextResolutionFeedback({ receipt_id: receiptId, outcome: "incorrect", asset_refs: [ref] }).feedback as JsonObject).memory_refs as JsonObject[])[0]!.memory_id, memory.id);
  } finally { f.close(); }
});

test("Graph inspect matching uses the selected release and rejects malformed input lists", async () => {
  const f = await invocationFixture();
  try {
    const saved = f.service.experienceGraphEdit({ action: "save", scope, graph_id: "product-development", template_id: "internet-product-engineering" });
    f.service.experienceGraphEdit({ action: "submit", scope, graph_id: "product-development", expected_draft_digest: saved.draft_digest });
    const args = { action: "match", scope, graph_id: "product-development", release_channel: "test", query: "review" };
    assert(f.service.experienceGraphInspect(args).routes);
    assert(f.service.experienceGraphInspect({ ...args, input_keys: [] }).routes);
    assert.throws(() => f.service.experienceGraphInspect({ ...args, input_keys: "bad" }), /input_keys/);
    assert.throws(() => f.service.experienceGraphInspect({ ...args, input_keys: [1] }), /input_keys/);
    assert.throws(() => f.service.experienceGraphInspect({ ...args, release_channel: "current" }), /unavailable/);
  } finally { await f.close(); }
});

test("writable candidate tests require disjoint checkpointed workspaces bound to their Work Loop", async () => {
  const { assertProcedureTestIsolation } = await import("../capability/craft-experience/procedure-release.ts");
  const f = await invocationFixture();
  try {
    const p = f.create(); const candidate = f.service.procedureConfigurationSave({ procedure_id: p.id, scope, title: "test", procedure_kind: "workflow", scenario_id: "review", definition: spec(), expected_version: p.version }).procedure as JsonObject;
    const testRoot = join(f.root, "test"), baselineRoot = join(f.root, "baseline"); mkdirSync(testRoot); mkdirSync(baselineRoot); writeFileSync(join(testRoot, "a.ts"), "export const a = 1"); writeFileSync(join(baselineRoot, "a.ts"), "export const a = 1");
    f.service.workspaceOpen({ workspace_id: "workspace", root_path: testRoot, name: "test", include_paths: ["a.ts"] });
    f.service.workspaceOpen({ workspace_id: "baseline", root_path: baselineRoot, name: "baseline", include_paths: ["a.ts"] });
    f.service.workspaceCheckpoint({ workspace_id: "workspace", label: "test" }); f.service.workspaceCheckpoint({ workspace_id: "baseline", label: "baseline" });
    const args = { ...f.args(candidate), release_channel: "test", test_workspace_id: "workspace", baseline_workspace_id: "baseline" };
    assertProcedureTestIsolation(f.store, args); assertProcedureTestIsolation(f.store, args, "workspace");
    assert.throws(() => assertProcedureTestIsolation(f.store, { ...args, baseline_workspace_id: "workspace" }), /mismatch/);
    assert.throws(() => assertProcedureTestIsolation(f.store, args, "other"), /mismatch/);
    assert(f.service.procedureInvocationBind(args).invocation); assert(f.dispatch().dispatch);
    const baseline = f.store.get("workspace", "baseline");
    f.store.save("workspace", "baseline", { ...payload(baseline), root_path: testRoot }); assert.throws(() => assertProcedureTestIsolation(f.store, args), /disjoint/);
    f.store.save("workspace", "baseline", { ...payload(baseline), root_path: f.root }); assert.throws(() => assertProcedureTestIsolation(f.store, args), /disjoint/);
    f.store.save("workspace", "baseline", { ...payload(baseline), latest_checkpoint_id: null }); assert.throws(() => assertProcedureTestIsolation(f.store, args), /checkpointed/);
    f.store.save("workspace", "baseline", payload(baseline)); const testWorkspace = f.store.get("workspace", "workspace"); f.store.save("workspace", "workspace", { ...payload(testWorkspace), latest_checkpoint_id: null }); assert.throws(() => assertProcedureTestIsolation(f.store, args), /checkpointed/);
  } finally { await f.close(); }
});

test("legacy receipts, direct required validation and code query truncation remain explicit", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.contextResolution.resolve({ query: "q", scope_kind: "project", scope_id: "p", required_refs: "bad" }), /array/);
    f.store.create("context_resolution_receipt", "legacy", { memory_refs: [], scope: { kind: "project", id: "p" }, identity_digest: "legacy" });
    assert(f.service.contextResolutionFeedback({ receipt_id: "legacy", outcome: "irrelevant" }).feedback);
    const ensured = f.service.codebaseRepositoryEnsure({ project_root: f.repo });
    const node = (f.store.get("codebase_index", String(ensured.index_id)).nodes as JsonObject[])[0]!;
    const ref = contextAssetRef("codebase", { ...node, version: 1, index_id: ensured.index_id, checkpoint_id: ensured.checkpoint_id }, f.scope);
    const requested = await f.service.contextOpen({ project_root: f.repo, query: "unmatched", required_refs: [ref] }); assert((requested.asset_refs as JsonObject[]).some(item => item.id === ref.id));
    f.store.create("memory_ledger", "required", { scope: f.scope, source_id: "builtin.evidence-wiki", status: "active", kind: "preference", sensitivity: "internal", content: "fixed", content_digest: stableDigest("fixed") });
    assert.equal((await f.service.contextOpen({ project_root: f.repo, query: "fix login code", memory_ids: ["required"], max_items: 1 })).items instanceof Array, true);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "login", max_tokens: 0 }), /max_tokens/);
    for (let i = 0; i < 20; i++) writeFileSync(join(f.repo, `login${i}.ts`), Array.from({ length: 16 }, (_, j) => `export function login${i}_${j}() {}`).join("\n"));
    const truncated = await f.service.contextOpen({ project_root: f.repo, query: "login", max_items: 3 }); assert(((truncated.pack_receipt as JsonObject).partial_reasons as string[]).includes("codebase_query_truncated"));
    for (let i = 0; i < 20; i++) rmSync(join(f.repo, `login${i}.ts`)); writeFileSync(join(f.repo, "login.ts"), "// file only");
    const single = await f.service.contextOpen({ project_root: f.repo, query: "login", task_kind: "code", max_items: 1 }); assert.equal(single.receipt, null);
  } finally { f.close(); }
});

test("Hook emissions reuse matching turn material, upgrade code and invalidate after correction", async () => {
  const { CodexHookBridge } = await import("../core/interfaces/codex-hook-bridge.ts");
  const f = await fixture();
  try {
    const memory = f.service.memoryLedgerRemember({ memory_id: "memory", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: f.scope.kind, scope_id: f.scope.id, content: "loginUser review preference" }).memory as JsonObject;
    const bridge = new CodexHookBridge(f.service), args = { session_id: "session", turn_id: "turn", project_root: f.repo, query: "loginUser review" };
    const emitted = await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd: f.repo, session_id: args.session_id, turn_id: args.turn_id, prompt: args.query }); assert(emitted.additionalContext);
    const pack = await f.service.contextOpen(args); assert.equal(pack.hook_reused, true); assert.equal((pack.items as unknown[]).length, 0); assert.equal((pack.already_emitted_refs as JsonObject[])[0]!.id, memory.id); assert(((pack.codebase as JsonObject).references as unknown[]).length > 0);
    assert.equal((await f.service.contextOpen({ ...args, turn_id: "other" })).hook_reused, false);
    f.store.save("memory_ledger", String(memory.id), { ...payload(memory), content: "loginUser changed preference", content_digest: stableDigest("loginUser changed preference") });
    assert.equal((await f.service.contextOpen(args)).hook_reused, false);
    const set = await f.service.contextWorkingSets.resolve({ query: args.query, scope_kind: f.scope.kind, scope_id: f.scope.id });
    const identity = { query: args.query, scope_kind: f.scope.kind, scope_id: f.scope.id, session_id: args.session_id, turn_id: args.turn_id };
    f.service.contextWorkingSets.recordEmission(identity, set); f.service.contextWorkingSets.recordEmission(identity, set);
    f.service.contextWorkingSets.recordEmission({ ...identity, turn_id: undefined }, set);
    f.service.contextWorkingSets.recordEmission({ ...identity, turn_id: "empty" }, { asset_refs: [], receipt: null });
    assert.equal(f.service.contextWorkingSets.emittedRefs({ ...identity, session_id: undefined }, set.asset_refs as JsonObject[]).length, 0);
  } finally { f.close(); }
});

test("Procedure get and disabled Skill export can materialize the qualified release beside a test candidate", async () => {
  const { ProcedureStore } = await import("../capability/craft-experience/procedure-projection.ts");
  const f = await invocationFixture();
  try {
    const p = f.create(), procedures = new ProcedureStore(f.store);
    const candidate = f.service.procedureConfigurationSave({ procedure_id: p.id, scope, title: "candidate", procedure_kind: "workflow", scenario_id: "review", definition: spec(), expected_version: p.version }).procedure as JsonObject;
    assert.equal((procedures.get({ procedure_id: p.id }).procedure as JsonObject).version, candidate.version);
    assert.equal((procedures.get({ procedure_id: p.id, version: p.version }).procedure as JsonObject).version, p.version);
    assert.equal((procedures.get({ procedure_id: p.id, release_channel: "current" }).procedure as JsonObject).version, p.version);
    const exported = procedures.skillExport({ procedure_id: p.id }); assert.equal((exported.export as JsonObject).procedure_version, p.version); assert.equal((exported.export as JsonObject).enabled, false);
    f.store.save("experience_release", String(p.id), { ...payload(f.store.get("experience_release", String(p.id))), status: "revoked" });
    assert.throws(() => procedures.get({ procedure_id: p.id, release_channel: "current" }), /unavailable/);
    assert.throws(() => procedures.skillExport({ procedure_id: p.id }), /routeable/);
  } finally { await f.close(); }
});

test("each asset explanation exposes its own pending correction tasks", async () => {
  const f = await fixture();
  try {
    const pack = await f.service.contextOpen({ project_root: f.repo, query: "login code" });
    f.service.contextResolutionFeedback({ receipt_id: (pack.pack_receipt as JsonObject).id, outcome: "incorrect", asset_refs: pack.asset_refs });
    const code = pack.codebase as JsonObject;
    const explained = f.service.componentAssetInspect("codebase", { action: "explain", asset_id: code.index_id, scope_kind: "workspace", scope_id: code.workspace_id });
    assert.equal((explained.corrections as unknown[]).length, (pack.asset_refs as unknown[]).length);
  } finally { f.close(); }
});

test("unclassified conflicting preferences are held for topic/replacement confirmation before automatic capture", async () => {
  const f = await fixture();
  try {
    const first = f.service.memoryCaptureUserStatement({ explicit_consent: true, content: "Python", auto_accept: true }).memory as JsonObject; assert(first);
    assert.equal(f.service.memoryCaptureUserStatement({ explicit_consent: true, content: "Python", auto_accept: true }).already_retained, true);
    const incoming = f.service.memoryCaptureUserStatement({ explicit_consent: true, content: "Java", auto_accept: true });
    assert.equal(incoming.next_action, "confirm_topic_or_explicit_replacement"); assert.equal(incoming.auto_committed, false); assert.equal(f.store.get("memory_ledger", String(first.id)).status, "active");
    f.service.memoryGovernance.policySave({ mode: "governed", min_confidence: "bounded" });
    const held = f.service.memoryCaptureUserStatement({ explicit_consent: true, content: "Rust", auto_accept: true }); assert.equal(held.auto_committed, false);
    f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", memory_id: "restricted", kind: "preference", scope_kind: "user", scope_id: "restricted", content: "Python", sensitivity: "restricted" });
    assert.deepEqual(f.service.memoryGovernance.topicSuggestions({ scope_kind: "user", scope_id: "restricted", content: "Python" }).suggestions, []);
    assert.equal((f.service.memoryGovernance.topicSuggestions({ scope_kind: "user", scope_id: "restricted", content: "Python", allow_restricted: true }).suggestions as unknown[]).length, 1);
    const unrelated = f.service.memoryGovernance.topicSuggestions({ scope_kind: "user", scope_id: "local", content: "unrelated" }); assert.deepEqual(unrelated.suggestions, []);
  } finally { f.close(); }
});

test("governed Memory policy cannot auto-commit a conflict with a directly written Ledger entry", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "proof", { source_type: "human", confidence: "confirmed" });
    f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", kind: "preference", memory_id: "direct", scope_kind: "user", scope_id: "local", topic: "language", content: "Python", evidence_ids: ["proof"] });
    f.service.memoryGovernance.policySave({ mode: "governed" });
    const result = f.service.memoryGovernance.propose({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "user", scope_id: "local", topic: "language", content: "Java", confidence: "confirmed", evidence_ids: ["proof"] });
    assert.equal(result.auto_committed, false); assert.equal((result.candidate as JsonObject).status, "conflict_pending"); assert.equal(f.store.count("memory_ledger"), 1);
    const captured = f.service.memoryCaptureUserStatement({ explicit_consent: true, content: "Rust", auto_accept: true, scope_id: "separate" }); const memory = captured.memory as JsonObject;
    f.service.memoryLedgerTransition({ memory_id: memory.id, status: "revoked", reason: "user request" });
    assert.equal(f.service.memoryCaptureUserStatement({ explicit_consent: true, content: "Rust", auto_accept: true, scope_id: "separate" }).already_retained, undefined);
  } finally { f.close(); }
});

test("deactivated repositories skip source/config reads before the index publication transaction", async () => {
  const f = await fixture();
  try {
    const index = f.service.codebaseRepositoryEnsure({ project_root: f.repo }); f.service.codebaseDeactivate({ workspace_id: index.workspace_id });
    writeFileSync(join(f.repo, ".craft-codebase.json"), "invalid private config");
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo }).status, "disabled");
  } finally { f.close(); }
});

test("scoped Knowledge/Memory corrections and active Experience releases appear in asset explanations", async () => {
  const f = await fixture();
  try {
    f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", memory_id: "m", kind: "preference", scope_kind: f.scope.kind, scope_id: f.scope.id, content: "login preference" });
    f.store.create("evidence", "proof", { source_type: "human", confidence: "confirmed" });
    f.service.knowledgeClaimSave({ claim_id: "k", kind: "fact", scope: `${f.scope.kind}:${f.scope.id}`, content: "login fact", evidence_ids: ["proof"] });
    f.service.knowledgeClaimReview({ claim_id: "k", status: "reviewed", reviewer: "human", reason: "supported" });
    const pack = await f.service.contextOpen({ project_root: f.repo, query: "login", include_codebase: false }); f.service.contextResolutionFeedback({ receipt_id: (pack.pack_receipt as JsonObject).id, outcome: "incorrect", asset_refs: pack.asset_refs });
    for (const [member, id] of [["memory", "m"], ["knowledge", "k"]]) assert.equal((f.service.componentAssetInspect(member!, { action: "explain", asset_id: id, scope_kind: f.scope.kind, scope_id: f.scope.id }).corrections as unknown[]).length, 1);
  } finally { f.close(); }
  const invocation = await invocationFixture();
  try {
    const p = invocation.create(); assert.equal((invocation.service.componentAssetInspect("experience", { action: "explain", asset_id: p.id, scope_kind: "project", scope_id: "invocation" }).release as JsonObject).current_record_version, p.version);
  } finally { await invocation.close(); }
});

test("Hook capture reports held preferences instead of falsely claiming a durable write", async () => {
  const { CodexHookBridge } = await import("../core/interfaces/codex-hook-bridge.ts");
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), base = { hook_event_name: "UserPromptSubmit", cwd: f.repo, session_id: "session" };
    await bridge.handle("context", { ...base, turn_id: "one", prompt: "记住：以后默认用 Python" });
    const response = await bridge.handle("context", { ...base, turn_id: "two", prompt: "记住：以后默认用 Java" }); const payload = JSON.parse(String(response.additionalContext));
    assert.equal(payload.memory_capture.memory_written, false); assert.equal(payload.memory_capture.next_action, "confirm_topic_or_explicit_replacement"); assert.equal(payload.session_id, base.session_id); assert.equal(f.store.count("memory_ledger"), 1);
    f.service.memoryGovernance.policySave({ mode: "off" }); const disabled = await bridge.handle("memory", { ...base, turn_id: "off", prompt: "记住：no match" }); assert.equal(JSON.parse(String(disabled.additionalContext)).memory_capture.memory_written, false);
  } finally { f.close(); }
});

test("optional code yields character budget to mandatory Context and Host refs count against the total", async () => {
  const f = await fixture();
  try {
    f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", memory_id: "required", kind: "preference", scope_kind: f.scope.kind, scope_id: f.scope.id, content: "x".repeat(400) });
    const pack = await f.service.contextOpen({ project_root: f.repo, query: "login code", memory_ids: ["required"], max_chars: 500, max_items: 3 });
    assert.equal((pack.items as JsonObject[])[0]!.memory_id, "required"); assert.equal((pack.codebase as JsonObject).budget_rebalanced, true);
    const args = { project_root: f.repo, query: "login code", history_refs: [{ id: "history", version: 1 }], max_items: 1 };
    const host = await f.service.contextOpen(args); assert.equal((host.pack_receipt as JsonObject).total_items, 1); assert.equal(((host.codebase as JsonObject).references as unknown[]).length, 0);
    const base = await f.service.contextOpen({ project_root: f.repo, query: "login code" }); const code = (base.asset_refs as JsonObject[]).find(ref => ref.member === "codebase")!;
    await assert.rejects(f.service.contextOpen({ ...args, required_refs: [code] }), { name: "ContextBudgetError" });
    const codeSize = ((base.codebase as JsonObject).references as JsonObject[]).reduce((sum, ref) => sum + JSON.stringify(ref).length, 0);
    const mixed = await f.service.contextOpen({ project_root: f.repo, query: "login code", required_refs: [code], memory_ids: ["required"], max_items: 6, max_chars: codeSize + 399 });
    assert.equal((mixed.codebase as JsonObject).budget_rebalanced, true); assert.equal(((mixed.codebase as JsonObject).references as unknown[]).length, 1);
  } finally { f.close(); }
});

test("deactivation after discovery is rechecked before publishing the repository index", async t => {
  const f = await fixture();
  try {
    const prior = f.service.codebaseRepositoryEnsure({ project_root: f.repo }); const transaction = f.store.transaction.bind(f.store); let switchPolicy = true;
    t.mock.method(f.store, "transaction", (...args: Parameters<CraftStore["transaction"]>) => {
      if (switchPolicy) { switchPolicy = false; transaction(() => f.service.codebaseDeactivate({ workspace_id: prior.workspace_id })); }
      return transaction(...args);
    });
    writeFileSync(join(f.repo, "login.ts"), "export function changed() {}");
    const result = f.service.codebaseRepositoryEnsure({ project_root: f.repo }); assert.equal(result.status, "disabled"); assert.equal(f.store.count("codebase_index"), 1);
  } finally { f.close(); }
});

test("Hosts without native turn IDs receive fresh local turns and can reuse their emitted Context", async () => {
  const { CodexHookBridge } = await import("../core/interfaces/codex-hook-bridge.ts");
  const f = await fixture();
  try {
    f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", kind: "preference", memory_id: "m", scope_kind: f.scope.kind, scope_id: f.scope.id, content: "login review" });
    const bridge = new CodexHookBridge(f.service), input = { hook_event_name: "UserPromptSubmit", cwd: f.repo, session_id: "session", prompt: "login review" };
    const first = JSON.parse(String((await bridge.handle("context", input)).additionalContext));
    assert(first.turn_id.startsWith("hook_turn_")); assert.equal((await f.service.contextOpen({ project_root: f.repo, query: input.prompt, session_id: first.session_id, turn_id: first.turn_id })).hook_reused, true);
    const next = JSON.parse(String((await bridge.handle("context", input)).additionalContext)); assert.notEqual(next.turn_id, first.turn_id);
  } finally { f.close(); }
});
