import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { craftPaths } from "../src/paths.ts";

async function fixture() { const root = await mkdtemp(join(tmpdir(), "craft-v01231-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store); return { root, store, service }; }

test("v0.12.31 memory governance is candidate-first, conflict-aware and expiring", async () => {
  const { root, store, service } = await fixture();
  try {
    service.knowledgeMemoryInstallBuiltins();
    const source = service.knowledgeSourceRegister({ source_id: "src", kind: "custom", label: "test", scope_kind: "project", scope_id: "p", locator: "local", content_digest: "sha256:test", trust: "bounded", access: "proposal_only" }).source as JsonObject;
    const evidence = service.evidenceRecord({ evidence_id: "ev", source_type: "test", claim: "verified", confidence: "confirmed" });
    const first = service.memoryCandidatePropose({ candidate_id: "c1", source_id: source.id, kind: "preference", scope_kind: "project", scope_id: "p", topic: "editor", content: "use markdown", evidence_ids: [evidence.id] }).candidate as JsonObject;
    assert.equal(first.status, "candidate");
    const conflict = service.memoryCandidatePropose({ candidate_id: "c2", source_id: source.id, kind: "preference", scope_kind: "project", scope_id: "p", topic: "editor", content: "use json", evidence_ids: [evidence.id] }).candidate as JsonObject;
    assert.equal(conflict.status, "conflict_pending");
    assert.throws(() => service.memoryCandidateReview({ candidate_id: "c2", decision: "approve", reviewer: "human", reason: "ok" }), /conflict/);
    service.memoryConflictResolve({ candidate_id: "c2", resolution: "keep", actor: "human", reason: "newer preference" });
    const approved = service.memoryCandidateReview({ candidate_id: "c2", decision: "approve", reviewer: "human", reason: "checked" }).candidate as JsonObject;
    const memory = service.memoryLedgerRememberApproved({ candidate_id: approved.id }).memory as JsonObject;
    assert.equal(memory.status, "active");
    const studioCandidate = service.studioMemorySave({ candidate_id: "studio-c", source_id: source.id, kind: "working", scope_kind: "project", scope_id: "p", content: "temporary context", evidence_ids: [evidence.id] }).candidate as JsonObject;
    assert.equal(studioCandidate.status, "candidate");
    assert.equal(store.find("memory_item", "studio-c"), null);
    const expired = service.memoryExpirySweep({ now: "2035-01-01T00:00:00.000Z" });
    assert.equal(Number(expired.count) >= 0, true);
    const claimEvidence = service.evidenceRecord({ evidence_id: "claim-expiry-evidence", source_type: "test", claim: "claim", confidence: "bounded" });
    const expiringClaim = service.knowledgeClaimSave({ claim_id: "expiring-claim", kind: "fact", content: "temporary claim", evidence_ids: [claimEvidence.id], valid_until: "2020-01-01T00:00:00.000Z" }).claim as JsonObject;
    service.knowledgeClaimReview({ claim_id: expiringClaim.id, status: "reviewed", reviewer: "human", reason: "checked" });
    assert.equal((service.knowledgeExpirySweep({ now: "2035-01-01T00:00:00.000Z" }).expired as JsonObject[]).some((item) => item.id === expiringClaim.id), true);
    assert.equal((service.knowledgeConflictResolve({ claim_id: expiringClaim.id, decision: "reviewed", reviewer: "human", reason: "rechecked" }).claim as JsonObject).status, "reviewed");
    assert.throws(() => service.knowledgeConflictResolve({ claim_id: expiringClaim.id, decision: "bad", reviewer: "human", reason: "x" }), /unsupported/);
    assert.throws(() => service.memoryCandidatePropose({ source_id: source.id, kind: "working", scope_kind: "project", scope_id: "p", content: "token=secret-value" }), /credentials/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.12.31 workflow DAG validates, checkpoints and detects drift", async () => {
  const { root, store, service } = await fixture();
  try {
    const workflow = service.workflowDagSave({ workflow_id: "wf", name: "DAG", nodes: [{ id: "a", type: "action" }, { id: "b", type: "human_gate", depends_on: ["a"], side_effect: "local_write" }] }).workflow as JsonObject;
    assert.equal(workflow.lifecycle, "draft");
    assert.throws(() => service.workflowDagValidate({ nodes: [{ id: "a", type: "action", depends_on: ["b"] }, { id: "b", type: "action", depends_on: ["a"] }] }), /cycle/);
    const checkpoint = service.workflowDagCheckpoint({ checkpoint_id: "cp", run_id: "run", workflow_id: "wf", completed: ["a"], pending: ["b"], state_digest: "sha256:state" }).checkpoint as JsonObject;
    assert.equal(service.workflowDagResume({ checkpoint_id: checkpoint.id, graph_digest: workflow.graph_digest, state_digest: "sha256:state" }).status, "ready");
    assert.equal(service.workflowDagResume({ checkpoint_id: checkpoint.id, graph_digest: "sha256:drift" }).status, "needs_replan");
    assert.equal((service.workflowDagExport({ workflow_id: "wf" }).document as JsonObject).nodes instanceof Array, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.12.31 task state is append-only and optimistic-concurrency protected", async () => {
  const { root, store, service } = await fixture();
  try {
    const first = service.taskStateTransition({ task_id: "task", state: "running", actor: "agent", reason: "start" });
    assert.equal((first.projection as JsonObject).state_revision, 1);
    assert.throws(() => service.taskStateTransition({ task_id: "task", state: "completed", actor: "agent", expected_revision: 0 }), /Concurrent/);
    service.taskStateTransition({ task_id: "task", state: "completed", actor: "human", expected_revision: 1, reason: "verified" });
    const replay = service.taskStateReplay({ task_id: "task" });
    assert.deepEqual({ state: replay.state, state_revision: replay.state_revision }, { state: "completed", state_revision: 2 });
    assert.equal((service.taskStateGet({ task_id: "task" }).events as unknown[]).length, 2);
    assert.equal((service.taskStateTransition({ task_id: "defaults", state: "prepared" }).projection as JsonObject).actor, "system");
    assert.throws(() => service.taskStateTransition({ task_id: "bad", state: "unknown" }), /unsupported/);
    assert.throws(() => service.taskStateTransition({ task_id: "bad", state: "running", expected_revision: -1 }), /non-negative/);
    assert.throws(() => service.taskStateTransition({ task_id: "bad", state: "running", expected_revision: 1.5 }), /non-negative/);
    assert.throws(() => service.taskStateTransition({ task_id: "bad", state: "running", evidence_ids: ["missing"] }), /Unknown evidence/);
    assert.equal((service.taskStateGet({ task_id: "missing" }).projection), null);
    assert.deepEqual(service.taskStateReplay({ task_id: "missing" }), { task_id: "missing", state: "prepared", state_revision: 0, event_count: 0 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.12.31 governance kernels fail closed on invalid, drifted and idempotent inputs", async () => {
  const { root, store, service } = await fixture();
  try {
    const source = service.knowledgeSourceRegister({ source_id: "edge-source", kind: "custom", label: "edge", scope_kind: "project", scope_id: "p", locator: "offline://edge", content_digest: "sha256:edge", trust: "bounded", access: "proposal_only" }).source as JsonObject;
    const evidence = service.evidenceRecord({ evidence_id: "edge-evidence", source_type: "test", claim: "bounded", confidence: "bounded" });
    const generated = service.memoryCandidatePropose({ source_id: source.id, kind: "working", scope_kind: "project", scope_id: "p", content: "temporary", topic: "edge", valid_until: "2999-01-01T00:00:00.000Z" }).candidate as JsonObject;
    assert.match(String(generated.id), /^memory_candidate_/);
    const episodic = service.memoryCandidatePropose({ candidate_id: "episodic", source_id: source.id, kind: "episodic", scope_kind: "project", scope_id: "p", content: "episode", topic: "episode", evidence_ids: [evidence.id] }).candidate as JsonObject;
    assert.ok(episodic.valid_until);
    const explicitNull = service.memoryCandidatePropose({ candidate_id: "null-validity", source_id: source.id, kind: "preference", scope_kind: "project", scope_id: "p", content: "stable", topic: "stable", valid_until: null }).candidate as JsonObject;
    assert.equal(explicitNull.valid_until, null);
    store.create("memory_candidate", "expired-seed", { scope: { kind: "project", id: "p" }, topic: "edge", content_digest: "other", status: "expired" });
    store.create("memory_candidate", "rejected-seed", { scope: { kind: "project", id: "p" }, topic: "edge", content_digest: "other", status: "rejected" });
    store.create("memory_candidate", "scope-less-seed", { scope: null, topic: "edge", content_digest: "other", status: "candidate" });
    assert.deepEqual((service.memoryCandidatePropose({ candidate_id: String(generated.id), source_id: source.id, kind: "working", scope_kind: "project", scope_id: "p", content: "temporary", topic: "edge", valid_until: "2999-01-01T00:00:00.000Z" }).candidate as JsonObject).id, generated.id);
    assert.throws(() => service.memoryCandidatePropose({ candidate_id: String(generated.id), source_id: source.id, kind: "working", scope_kind: "project", scope_id: "p", content: "changed", topic: "edge" }), /idempotency/);
    assert.throws(() => service.memoryCandidatePropose({ source_id: source.id, kind: "bad", scope_kind: "project", scope_id: "p", content: "x" }), /unsupported/);
    assert.throws(() => service.memoryCandidatePropose({ source_id: source.id, kind: "working", scope_kind: "bad", scope_id: "p", content: "x" }), /unsupported/);
    assert.throws(() => service.memoryCandidatePropose({ source_id: source.id, kind: "working", scope_kind: "project", scope_id: "p", content: "x", valid_until: "bad" }), /ISO/);
    assert.throws(() => service.memoryCandidatePropose({ source_id: source.id, kind: "working", scope_kind: "project", scope_id: "p", content: "x", evidence_ids: ["e", "e"] }), /unique/);
    assert.throws(() => service.memoryCandidateReview({ candidate_id: String(generated.id), decision: "approve", reviewer: "r", reason: "ok" }), /bounded/);
    const rejected = service.memoryCandidateReview({ candidate_id: String(generated.id), decision: "reject", reviewer: "r", reason: "no" }).candidate as JsonObject;
    assert.equal(rejected.status, "rejected");
    assert.throws(() => service.memoryLedgerRememberApproved({ candidate_id: String(rejected.id) }), /approved/);
    const approved = service.memoryCandidateReview({ candidate_id: String(episodic.id), decision: "approve", reviewer: "r", reason: "ok" }).candidate as JsonObject;
    const ledger = service.memoryLedgerRememberApproved({ candidate_id: approved.id, memory_id: "edge-memory" }).memory as JsonObject;
    assert.equal(ledger.id, "edge-memory");
    assert.throws(() => service.memoryConflictResolve({ candidate_id: String(approved.id), resolution: "bad", actor: "r", reason: "x" }), /unsupported/);
    const noConflict = service.memoryConflictResolve({ candidate_id: String(approved.id), resolution: "dismiss", actor: "r", reason: "x" }).candidate as JsonObject;
    assert.equal(noConflict.status, "candidate");
    assert.throws(() => service.memoryExpirySweep({ now: "bad" }), /ISO/);
    const expired = service.memoryExpirySweep({ now: "2999-01-01T00:00:00.000Z" });
    assert.ok(Number(expired.count) >= 1);
    assert.throws(() => service.memorySessionFinalize({ session_id: "s", summary: "token=secret-value" }), /credentials/);
    const finalized = service.memorySessionFinalize({ session_id: "s", summary: "redacted", candidate_ids: [String(noConflict.id)] });
    assert.equal(finalized.content_free, true);
    assert.deepEqual(service.memorySessionFinalize({ session_id: "empty-session", summary: "redacted" }).candidates, []);
    assert.throws(() => service.memoryConsolidateGoverned({ candidate_ids: [String(noConflict.id)], summary: "x" }), /at least two/);
    assert.throws(() => service.memoryConsolidateGoverned({ candidate_ids: [String(approved.id), String(rejected.id)], summary: "x" }), /approved/);
    const c1 = service.memoryCandidatePropose({ candidate_id: "c1-edge", source_id: source.id, kind: "preference", scope_kind: "project", scope_id: "p", topic: "theme", content: "dark", evidence_ids: [evidence.id] }).candidate as JsonObject;
    const c2 = service.memoryCandidatePropose({ candidate_id: "c2-edge", source_id: source.id, kind: "preference", scope_kind: "project", scope_id: "p", topic: "theme", content: "light", evidence_ids: [evidence.id] }).candidate as JsonObject;
    assert.equal(c2.status, "conflict_pending");
    assert.throws(() => service.memoryCandidateReview({ candidate_id: c2.id, decision: "approve", reviewer: "r", reason: "x" }), /conflict/);
    service.memoryConflictResolve({ candidate_id: c2.id, resolution: "supersede", actor: "r", reason: "new" });
    service.memoryCandidateReview({ candidate_id: c1.id, decision: "approve", reviewer: "r", reason: "checked" });
    service.memoryCandidateReview({ candidate_id: c2.id, decision: "approve", reviewer: "r", reason: "checked" });
    assert.equal((service.memoryConflictList({ limit: 10 }).conflicts as JsonObject[]).length, 0);
    const consolidation = service.memoryConsolidateGoverned({ candidate_ids: [c1.id, c2.id], consolidation_id: "consolidation", summary: "summary" });
    assert.equal((consolidation.consolidation as JsonObject).status, "candidate");
    assert.equal((service.memoryConsolidateGoverned({ candidate_ids: [c1.id, c2.id], consolidation_id: "consolidation", summary: "summary" }) as JsonObject).idempotent, true);
    assert.throws(() => service.memoryConsolidateGoverned({ candidate_ids: [c1.id, c2.id], consolidation_id: "consolidation", summary: "changed" }), /idempotency/);
    const kept = service.memoryCandidatePropose({ candidate_id: "keep-edge", source_id: source.id, kind: "preference", scope_kind: "project", scope_id: "p", topic: "keep", content: "one", evidence_ids: [evidence.id] }).candidate as JsonObject;
    store.save("memory_candidate", String(kept.id), { ...store.get("memory_candidate", String(kept.id)), conflict_ids: ["missing-conflict"] });
    assert.equal((service.memoryConflictResolve({ candidate_id: kept.id, resolution: "keep", actor: "r", reason: "keep" }).candidate as JsonObject).status, "candidate");
    await writeFile(join(root, "workflows", "noop"), "", { flag: "w" }).catch(() => undefined);
    assert.ok(store.find("memory_ledger", "edge-memory"));
    assert.throws(() => service.memoryCandidatePropose({ source_id: source.id, kind: "procedural", scope_kind: "project", scope_id: "p", content: "procedure", topic: "proc" }), /requires Evidence/);
    assert.throws(() => service.memoryCandidatePropose({ source_id: source.id, kind: "working", scope_kind: "project", scope_id: "p", content: "x", evidence_ids: "bad" as never }), /array/);
    assert.throws(() => service.memoryCandidatePropose({ source_id: source.id, kind: "working", scope_kind: "project", scope_id: "p", content: "x", confidence: "bad" }), /unsupported/);
    assert.throws(() => service.memoryCandidateReview({ candidate_id: String(noConflict.id), decision: "bad", reviewer: "r", reason: "x" }), /decision/);
    assert.equal((service.memoryConflictList({}).conflicts as JsonObject[]).length, 0);
    store.save("memory_candidate", String(noConflict.id), { ...store.get("memory_candidate", String(noConflict.id)), conflict_ids: "bad" });
    assert.equal((service.memoryConflictResolve({ candidate_id: noConflict.id, resolution: "dismiss", actor: "r", reason: "x" }).candidate as JsonObject).status, "candidate");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.12.31 workflow DAG lifecycle and import/export error paths", async () => {
  const { root, store, service } = await fixture();
  try {
    assert.throws(() => service.workflowDagValidate({}), /at least one/);
    assert.throws(() => service.workflowDagValidate({ nodes: [null] }), /object/);
    assert.throws(() => service.workflowDagValidate({ nodes: [{ id: "a", type: "bad" }] }), /unsupported node/);
    assert.throws(() => service.workflowDagValidate({ nodes: [{ id: "a", type: "action" }, { id: "a", type: "action" }] }), /duplicate/);
    assert.throws(() => service.workflowDagValidate({ nodes: [{ id: "a", type: "action", depends_on: "x" }] }), /depends_on/);
    assert.throws(() => service.workflowDagValidate({ nodes: [{ id: "a", type: "action", depends_on: ["a"] }] }), /itself/);
    assert.throws(() => service.workflowDagValidate({ nodes: [{ id: "a", type: "retry" }] }), /max_attempts/);
    assert.throws(() => service.workflowDagValidate({ nodes: [{ id: "a", type: "subworkflow" }] }), /workflow_id/);
    assert.throws(() => service.workflowDagValidate({ nodes: [{ id: "a", type: "action", depends_on: ["missing"] }] }), /unknown/);
    const shared = service.workflowDagValidate({ inputs: { x: "string" }, outputs: { y: "string" }, checkpoint_policy: { mode: "manual" }, nodes: [{ id: "a", type: "action" }, { id: "b", type: "action", depends_on: ["a"] }, { id: "c", type: "condition", depends_on: ["a"] }] });
    assert.equal((shared.nodes as JsonObject[]).length, 3);
    const workflow = service.workflowDagSave({ name: "Edge", nodes: [{ id: "a", type: "action", side_effect: "read_only" }, { id: "b", type: "retry", depends_on: ["a", "a"], max_attempts: 2 }, { id: "c", type: "subworkflow", depends_on: ["b"], workflow_id: "child" }] }).workflow as JsonObject;
    assert.match(String(workflow.id), /^workflow_dag_/);
    assert.equal((service.workflowDagSave({ workflow_id: workflow.id, name: "Edge", nodes: (workflow.graph as JsonObject).nodes as JsonObject[] }) as JsonObject).idempotent, true);
    assert.throws(() => service.workflowDagSave({ workflow_id: workflow.id, name: "Changed", nodes: [{ id: "a", type: "action" }] }), /idempotency/);
    assert.throws(() => service.workflowDagSave({ name: "secret=abcdefghi", nodes: [{ id: "a", type: "action" }] }), /credentials/);
    assert.throws(() => service.workflowDagTransition({ workflow_id: workflow.id, target: "routable", reason: "x" }), /Invalid/);
    service.workflowDagTransition({ workflow_id: workflow.id, target: "candidate", reason: "review" });
    assert.throws(() => service.workflowDagTransition({ workflow_id: workflow.id, target: "verified", reason: "x", evaluation_run_id: "missing" }), /Unknown/);
    store.create("evaluation_run", "eval-edge", { verdict: "failed", split: "held_out" });
    assert.throws(() => service.workflowDagTransition({ workflow_id: workflow.id, target: "verified", reason: "x", evaluation_run_id: "eval-edge" }), /passed/);
    store.save("evaluation_run", "eval-edge", { verdict: "passed", split: "held_out" });
    service.workflowDagTransition({ workflow_id: workflow.id, target: "verified", reason: "verified", evaluation_run_id: "eval-edge" });
    service.workflowDagTransition({ workflow_id: workflow.id, target: "canary", reason: "canary" });
    assert.throws(() => service.workflowDagTransition({ workflow_id: workflow.id, target: "routable", reason: "route", evaluation_run_id: "eval-edge" }), /canary_receipt/);
    service.workflowDagTransition({ workflow_id: workflow.id, target: "routable", reason: "route", evaluation_run_id: "eval-edge", canary_receipt: "receipt" });
    assert.throws(() => service.workflowDagTransition({ workflow_id: workflow.id, target: "draft", reason: "bad" }), /Invalid/);
    const checkpoint = service.workflowDagCheckpoint({ run_id: "run-edge", workflow_id: workflow.id, completed: ["a"], pending: ["b"], active: ["c"] }).checkpoint as JsonObject;
    assert.equal(service.workflowDagResume({ checkpoint_id: checkpoint.id }).status, "ready");
    assert.equal(service.workflowDagResume({ checkpoint_id: checkpoint.id, state_digest: "drift" }).status, "needs_replan");
    assert.equal((service.workflowDagCancel({ run_id: "run-edge", reason: "stop" }).run as JsonObject).status, "cancelled");
    assert.equal(service.workflowDagReplan({ checkpoint_id: checkpoint.id, reason: "drift" }).replan_required, true);
    assert.throws(() => service.workflowDagImport({ document: [] }), /object/);
    const exported = service.workflowDagExport({ workflow_id: workflow.id });
    assert.equal((exported.document as JsonObject).graph_digest, workflow.graph_digest);
    await writeFile(String(workflow.file_path), "{}\n");
    assert.equal((service.workflowDagExport({ workflow_id: workflow.id, version: workflow.version }) as JsonObject).file_drift, true);
    store.create("workflow_dag", "no-file", { name: "No file", description: "", graph: { nodes: [{ id: "a", type: "action", depends_on: [], side_effect: "read_only" }], inputs: {}, outputs: {}, checkpoint_policy: { mode: "step" } }, graph_digest: "sha256:none", identity_digest: "sha256:none", lifecycle: "draft", automation_authority: false });
    assert.equal((service.workflowDagExport({ workflow_id: "no-file" }) as JsonObject).file_drift, false);
    const imported = service.workflowDagImport({ workflow_id: "imported", document: exported.document });
    assert.equal((imported.workflow as JsonObject).id, "imported");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
