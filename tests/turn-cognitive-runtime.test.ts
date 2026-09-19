import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryLedgerKernel } from "../capability/craft-memory/memory-ledger.ts";
import { KnowledgeSourceRegistry } from "../capability/craft-knowledge/knowledge-source-registry.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { CraftService } from "../src/service.ts";
import { TurnCognitiveRuntime } from "../src/turn-cognitive-runtime.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-turn-cognitive-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const sources = new KnowledgeSourceRegistry(store); const memory = new MemoryLedgerKernel(store); const runtime = new TurnCognitiveRuntime(store, memory);
  const source = sources.sourceRegister({ source_id: "source", kind: "project_note", label: "project notes", scope_kind: "project", scope_id: "project", locator: "notes.md", content_digest: "sha256:notes", trust: "verified", access: "proposal_only" }).source as JsonObject;
  return { root, store, sources, memory, runtime, source };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
function policy(runtime: TurnCognitiveRuntime, policyId = "policy") {
  return runtime.policySave({ policy_id: policyId, scope_kind: "project", scope_id: "project", mode: "governed", context_on: ["needs_context"], capability_on: ["needs_capability"], workflow_on: ["needs_workflow"], memory_capture: "candidate", evaluation_capture: "observe" }).policy as JsonObject;
}
function hostProposal(runtime: TurnCognitiveRuntime, sourceId: string, proposalId = "proposal") {
  return runtime.proposalSubmit({ proposal_id: proposalId, scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "codex", input_digest: "sha256:turn", intents: ["conversation", "knowledge", "capability", "task", "execution"], signals: ["needs_context", "needs_capability", "needs_workflow", "needs_execution", "durable_value"], memory_candidate: { source_id: sourceId, kind: "episodic", content: "The user chose verified receipts for this project.", sensitivity: "internal" } }).proposal as JsonObject;
}

test("v0.12.28 makes a Host proposal policy-aware without turning a candidate into memory", async () => {
  const f = await fixture();
  try {
    const p = policy(f.runtime); const proposal = hostProposal(f.runtime, String(f.source.id));
    const result = f.runtime.assess({ receipt_id: "receipt", proposal_id: proposal.id, policy_id: p.id });
    const receipt = result.receipt as JsonObject; const candidate = result.candidate as JsonObject;
    assert.deepEqual(receipt.actions, { context: "resolve", capability: "discover", workflow: "route", work: "prepare", memory: "candidate", evaluation: "observe" });
    assert.equal(receipt.content_free, true); assert.equal(candidate.status, "candidate"); assert.equal(f.store.count("memory_ledger"), 0);
    assert.equal(f.runtime.assess({ receipt_id: "receipt", proposal_id: proposal.id, policy_id: p.id }).idempotent, true);
    assert.equal((f.runtime.receiptGet({ receipt_id: receipt.id }).receipt as JsonObject).id, receipt.id);
    assert.equal((f.runtime.candidateList({ scope_kind: "project", scope_id: "project" }).candidates as JsonObject[]).length, 1);
    const accepted = f.runtime.candidateDecide({ candidate_id: candidate.id, status: "accepted", reason: "user confirmed", confidence: "bounded" });
    assert.match(String(accepted.memory_id), /^memory_from_/); assert.equal(f.store.count("memory_ledger"), 1);
    assert.throws(() => f.runtime.candidateDecide({ candidate_id: candidate.id, status: "rejected", reason: "late" }), /already decided/);
  } finally { await close(f); }
});

test("v0.12.43 lets the context decision see every accumulated member, not only knowledge", async () => {
  const f = await fixture();
  try {
    const p = policy(f.runtime, "context-members");
    const adapter = f.runtime.hostAdapterSave({ host: "generic", delivery: "manual", proposal_contract: "turn" }).adapter as JsonObject;
    const assessWith = (id: string, extra: JsonObject) => {
      const proposal = f.runtime.proposalSubmit({ proposal_id: id, scope_kind: "project", scope_id: "project", semantic_owner: "host",
        host_adapter_id: adapter.id, input_digest: `sha256:${id}`, intents: ["conversation"], ...extra }).proposal as JsonObject;
      return (f.runtime.assess({ proposal_id: proposal.id, policy_id: p.id }).receipt as JsonObject).actions as JsonObject;
    };

    // Each of the three accumulated members, declared as an intent, must resolve context. The
    // defect this replaces read only `knowledge`, so `memory` and `experience` produced
    // `context: "none"` — the member was in the MCP surface but not in the decision.
    for (const member of ["knowledge", "memory", "experience"]) {
      assert.equal(assessWith(`intent-${member}`, { intents: [member] }).context, "resolve", `${member} intent must resolve context`);
    }
    // And each must be declarable as a signal, which the policy's own `context_on` may rely on.
    for (const signal of ["needs_context", "needs_memory", "needs_experience"]) {
      assert.equal(assessWith(`signal-${signal}`, { signals: [signal] }).context, "resolve", `${signal} must resolve context`);
    }
    // A turn that names none of them still resolves nothing, so the widening is a widening and
    // not a decision to always resolve.
    assert.equal(assessWith("none", { signals: ["sensitive"] }).context, "none");
    // `observe_only` still refuses to act on any of it.
    const observing = f.runtime.policySave({ policy_id: "observe", scope_kind: "project", scope_id: "project", mode: "observe_only" }).policy as JsonObject;
    const proposal = f.runtime.proposalSubmit({ proposal_id: "observed", scope_kind: "project", scope_id: "project", semantic_owner: "host",
      host_adapter_id: adapter.id, input_digest: "sha256:observed", intents: ["memory", "experience", "knowledge"], signals: ["needs_memory"] }).proposal as JsonObject;
    assert.equal(((f.runtime.assess({ proposal_id: proposal.id, policy_id: observing.id }).receipt as JsonObject).actions as JsonObject).context, "none");
  } finally { await close(f); }
});

test("v0.12.28 keeps console hooks declarative and validates Agent-mode semantic ownership", async () => {
  const f = await fixture();
  try {
    const manual = f.runtime.hostAdapterSave({ adapter_id: "manual", host: "codex" }).adapter as JsonObject;
    assert.equal((f.runtime.hookPlan({ adapter_id: manual.id }).plan as JsonObject).status, "manual_submission");
    const hooked = f.runtime.hostAdapterSave({ adapter_id: "hook", host: "claude", delivery: "event_hook", supports_turn_hook: true }).adapter as JsonObject;
    assert.equal((f.runtime.hookPlan({ adapter_id: hooked.id }).plan as JsonObject).status, "requires_host_install");
    assert.throws(() => f.runtime.hostAdapterSave({ host: "codex", delivery: "event_hook" }), /requires/);
    assert.throws(() => f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "host", input_digest: "sha256:x", intents: ["conversation"] }), /host_adapter_id/);
    assert.throws(() => f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "craft_agent", input_digest: "sha256:x", intents: ["conversation"] }), /Agent Work Runtime/);
    f.store.create("work_runtime_mode", "agent", { mode: "agent", default_model: "model", allowed_hosts: [], identity_digest: "x" });
    const agent = f.runtime.proposalSubmit({ proposal_id: "agent-proposal", scope_kind: "project", scope_id: "project", semantic_owner: "craft_agent", work_runtime_mode_id: "agent", input_digest: "sha256:agent", intents: ["conversation"] }).proposal as JsonObject;
    assert.equal(agent.model, "model");
  } finally { await close(f); }
});

test("v0.12.28 evaluates deterministic turn decisions and rejects cross-scope fixtures", async () => {
  const f = await fixture();
  try {
    const p = policy(f.runtime);
    const proposal = { scope_kind: "project", scope_id: "project", intents: ["knowledge"], signals: ["needs_context"] };
    f.runtime.evaluationCaseSave({ case_id: "pass", policy_id: p.id, proposal, expected_actions: { context: "resolve", capability: "none", workflow: "none", work: "none", memory: "none", evaluation: "none" } });
    f.runtime.evaluationCaseSave({ case_id: "scope", policy_id: p.id, proposal: { ...proposal, scope_id: "other" }, expected_actions: { context: "resolve", capability: "none", workflow: "none", work: "none", memory: "none", evaluation: "none" } });
    const result = f.runtime.evaluationRun({ evaluation_id: "evaluation" });
    assert.equal((result.evaluation as JsonObject).verdict, "rejected");
    assert.deepEqual((result.evaluation as JsonObject).metrics, { cases: 2, passed: 1, decision_accuracy: 0.5, false_positive_count: 0, scope_rejection_count: 1 });
    assert.equal(f.runtime.evaluationRun({ evaluation_id: "evaluation" }).idempotent, true);
    assert.throws(() => f.runtime.evaluationCaseSave({ policy_id: p.id, proposal: { ...proposal, memory_candidate: { content: "raw" } }, expected_actions: {} }), /content-free/);
  } finally { await close(f); }
});

test("v0.12.28 rejects unsafe, stale, and malformed turn inputs", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.runtime.policySave({ scope_kind: "bad", scope_id: "project" }), /scope_kind/);
    assert.throws(() => f.runtime.policySave({ scope_kind: "project", scope_id: "project", mode: "bad" }), /mode/);
    assert.throws(() => f.runtime.policySave({ scope_kind: "project", scope_id: "project", memory_capture: "write" }), /memory_capture/);
    assert.throws(() => f.runtime.policySave({ scope_kind: "project", scope_id: "project", evaluation_capture: "write" }), /evaluation_capture/);
    const p = policy(f.runtime); assert.equal(f.runtime.policySave({ policy_id: p.id, scope_kind: "project", scope_id: "project", mode: "governed", context_on: ["needs_context"], capability_on: ["needs_capability"], workflow_on: ["needs_workflow"], memory_capture: "candidate", evaluation_capture: "observe" }).idempotent, true);
    assert.throws(() => f.runtime.policySave({ policy_id: p.id, scope_kind: "project", scope_id: "other" }), /conflict/);
    assert.throws(() => f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "other", input_digest: "sha256:x", intents: ["conversation"] }), /semantic_owner/);
    assert.throws(() => f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "x", input_digest: "token=abcdefgh", intents: ["conversation"] }), /credentials/);
    assert.throws(() => f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "x", input_digest: "sha256:x", intents: ["bad"] }), /intents/);
    assert.throws(() => f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "x", input_digest: "sha256:x", intents: ["conversation"], memory_candidate: { source_id: "source", kind: "bad", content: "safe" } }), /kind/);
    const outside = f.runtime.proposalSubmit({ proposal_id: "outside", scope_kind: "task", scope_id: "task", semantic_owner: "host", host_adapter_id: "x", input_digest: "sha256:x", intents: ["conversation"] }).proposal as JsonObject;
    assert.throws(() => f.runtime.assess({ proposal_id: outside.id, policy_id: p.id }), /scope/);
    const rejectable = hostProposal(f.runtime, String(f.source.id), "rejectable"); const candidate = f.runtime.assess({ proposal_id: rejectable.id, policy_id: p.id }).candidate as JsonObject;
    assert.equal((f.runtime.candidateDecide({ candidate_id: candidate.id, status: "rejected", reason: "not stable" }).candidate as JsonObject).status, "rejected");
    assert.throws(() => f.runtime.candidateList({ scope_kind: "project" }), /scope_id/);
    assert.throws(() => f.runtime.candidateList({ status: "bad" }), /status/);
    assert.throws(() => f.runtime.evaluationRun({}), /at least one/);
  } finally { await close(f); }
});

test("v0.12.28 covers conservative policy branches, candidate lifecycle, and replay guards", async () => {
  const f = await fixture();
  try {
    const observed = f.runtime.policySave({ policy_id: "observed", scope_kind: "project", scope_id: "project", mode: "observe_only", memory_capture: "none", evaluation_capture: "none" }).policy as JsonObject;
    assert.equal((f.runtime.policyGet({ policy_id: observed.id, version: 1 }).policy as JsonObject).mode, "observe_only");
    assert.throws(() => f.runtime.policySave({ scope_kind: "project", scope_id: "project", context_on: [] }), /non-empty/);
    assert.throws(() => f.runtime.policySave({ scope_kind: "project", scope_id: "project", context_on: ["bad"] }), /unsupported/);
    assert.throws(() => f.runtime.policySave({ scope_kind: "project", scope_id: "project", context_on: ["needs_context", "needs_context"] }), /unique/);
    assert.throws(() => f.runtime.hostAdapterSave({ host: "bad" }), /unsupported/);
    assert.throws(() => f.runtime.hostAdapterSave({ host: "codex", delivery: "bad" }), /unsupported/);
    const adapter = f.runtime.hostAdapterSave({ adapter_id: "repeat", host: "ide", delivery: "manual", supports_turn_hook: false, proposal_contract: "contract" }).adapter as JsonObject;
    assert.equal(f.runtime.hostAdapterSave({ adapter_id: adapter.id, host: "ide", delivery: "manual", supports_turn_hook: false, proposal_contract: "contract" }).idempotent, true);
    assert.throws(() => f.runtime.hostAdapterSave({ adapter_id: adapter.id, host: "ide", delivery: "manual", supports_turn_hook: true, proposal_contract: "contract" }), /conflict/);
    const simple = f.runtime.proposalSubmit({ proposal_id: "simple", scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "repeat", input_digest: "sha256:simple", intents: ["conversation"] }).proposal as JsonObject;
    assert.equal(((f.runtime.assess({ proposal_id: simple.id, policy_id: observed.id }).receipt as JsonObject).actions as JsonObject).context, "none");
    assert.equal(f.runtime.proposalSubmit({ proposal_id: "simple", scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "repeat", input_digest: "sha256:simple", intents: ["conversation"] }).idempotent, true);
    assert.throws(() => f.runtime.proposalSubmit({ proposal_id: "simple", scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "repeat", input_digest: "sha256:changed", intents: ["conversation"] }), /conflict/);
    assert.throws(() => f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "repeat", input_digest: "sha256:x", intents: [] }), /non-empty/);
    assert.throws(() => f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "repeat", input_digest: "sha256:x", intents: ["conversation"], signals: ["bad"] }), /signals/);
    assert.throws(() => f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "repeat", input_digest: "sha256:x", intents: ["conversation"], memory_candidate: [] }), /object/);
    assert.throws(() => f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "repeat", input_digest: "sha256:x", intents: ["conversation"], memory_candidate: { source_id: "source", kind: "working", content: "safe", sensitivity: "bad" } }), /sensitivity/);
    const governed = policy(f.runtime, "governed-2");
    const revocable = hostProposal(f.runtime, String(f.source.id), "revocable"); const created = f.runtime.assess({ proposal_id: revocable.id, policy_id: governed.id }).candidate as JsonObject;
    assert.equal((f.runtime.assess({ receipt_id: "different-receipt", proposal_id: revocable.id, policy_id: governed.id }).candidate as JsonObject).id, created.id);
    assert.equal((f.runtime.candidateDecide({ candidate_id: created.id, status: "revoked", reason: "user removed" }).candidate as JsonObject).status, "revoked");
    const badConfidence = hostProposal(f.runtime, String(f.source.id), "bad-confidence"); const badCandidate = f.runtime.assess({ proposal_id: badConfidence.id, policy_id: governed.id }).candidate as JsonObject;
    assert.throws(() => f.runtime.candidateDecide({ candidate_id: badCandidate.id, status: "accepted", reason: "bad", confidence: "wrong" }), /confidence/);
    assert.throws(() => f.runtime.candidateDecide({ candidate_id: badCandidate.id, status: "other", reason: "bad" }), /status/);
    assert.equal((f.runtime.candidateList({ status: "candidate" }).candidates as JsonObject[]).some((item) => item.id === badCandidate.id), true);
    f.sources.sourceTransition({ source_id: f.source.id, status: "disabled", reason: "disabled" });
    const unavailable = hostProposal(f.runtime, String(f.source.id), "unavailable");
    assert.throws(() => f.runtime.assess({ proposal_id: unavailable.id, policy_id: governed.id }), /unavailable/);
    assert.throws(() => f.runtime.evaluationCaseSave({ policy_id: governed.id, proposal: [] as unknown as JsonObject, expected_actions: {} }), /object/);
    const evalCase = f.runtime.evaluationCaseSave({ case_id: "subset", policy_id: governed.id, proposal: { scope_kind: "project", scope_id: "project", intents: ["capability"], signals: ["needs_capability"] }, expected_actions: { context: "none", capability: "discover", workflow: "none", work: "none", memory: "none", evaluation: "none" } }).case as JsonObject;
    assert.equal(f.runtime.evaluationCaseSave({ case_id: evalCase.id, policy_id: governed.id, proposal: { scope_kind: "project", scope_id: "project", intents: ["capability"], signals: ["needs_capability"] }, expected_actions: { context: "none", capability: "discover", workflow: "none", work: "none", memory: "none", evaluation: "none" } }).idempotent, true);
    assert.throws(() => f.runtime.evaluationCaseSave({ case_id: evalCase.id, policy_id: governed.id, proposal: { scope_kind: "project", scope_id: "project", intents: ["conversation"] }, expected_actions: {} }), /conflict/);
    assert.equal((f.runtime.evaluationRun({ evaluation_id: "subset", case_ids: [evalCase.id] }).evaluation as JsonObject).verdict, "eligible");
    assert.throws(() => f.runtime.evaluationRun({ case_ids: [] }), /non-empty/);
  } finally { await close(f); }
});

test("v0.12.28 exhausts default, generated-id, and negative decision paths", async () => {
  const f = await fixture();
  try {
    const defaults = f.runtime.policySave({ scope_kind: "project", scope_id: "project", mode: "candidate_only" }).policy as JsonObject;
    const autoAdapter = f.runtime.hostAdapterSave({ host: "generic", delivery: "manual", proposal_contract: "turn" }).adapter as JsonObject;
    const proposal = f.runtime.proposalSubmit({ scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: autoAdapter.id, input_digest: "sha256:defaults", intents: ["knowledge", "capability", "task", "execution"], signals: ["needs_context", "needs_capability", "needs_workflow", "needs_execution"] }).proposal as JsonObject;
    const assessed = f.runtime.assess({ receipt_id: "no-candidate", proposal_id: proposal.id, policy_id: defaults.id });
    assert.deepEqual((assessed.receipt as JsonObject).actions, { context: "resolve", capability: "discover", workflow: "none", work: "none", memory: "none", evaluation: "none" });
    assert.equal(f.runtime.assess({ receipt_id: "no-candidate", proposal_id: proposal.id, policy_id: defaults.id }).candidate, null);
    assert.equal((f.runtime.candidateList().candidates as JsonObject[]).length, 0);
    assert.equal((f.runtime.policyGet({ policy_id: defaults.id }).policy as JsonObject).id, defaults.id);
    const source = f.sources.sourceRegister({ source_id: "untrusted", kind: "custom", label: "untrusted", scope_kind: "project", scope_id: "project", locator: "u", content_digest: "sha256:u", trust: "untrusted", access: "read_only" }).source as JsonObject;
    const governed = policy(f.runtime, "candidate-source");
    const unsafe = hostProposal(f.runtime, String(source.id), "unsafe-source");
    assert.throws(() => f.runtime.assess({ proposal_id: unsafe.id, policy_id: governed.id }), /unavailable/);
    const validUntil = f.runtime.proposalSubmit({ proposal_id: "candidate-options", scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "x", input_digest: "sha256:options", intents: ["conversation"], signals: ["durable_value"], memory_candidate: { source_id: f.source.id, kind: "working", content: "Temporary scoped fact", sensitivity: "public", evidence_ids: ["evidence"], valid_until: "2030-01-01T00:00:00.000Z" } }).proposal as JsonObject;
    f.store.create("evidence", "evidence", { confidence: "confirmed" });
    const candidate = f.runtime.assess({ proposal_id: validUntil.id, policy_id: governed.id }).candidate as JsonObject;
    const accepted = f.runtime.candidateDecide({ candidate_id: candidate.id, status: "accepted", reason: "accept default" });
    assert.equal(accepted.memory_id, `memory_from_${candidate.id}`);
    const falsePositive = f.runtime.evaluationCaseSave({ case_id: "false-positive", policy_id: defaults.id, proposal: { scope_kind: "project", scope_id: "project", intents: ["knowledge"] }, expected_actions: { context: "none", capability: "none", workflow: "none", work: "none", memory: "none", evaluation: "none" } }).case as JsonObject;
    const result = f.runtime.evaluationRun({ evaluation_id: "conflict", case_ids: [falsePositive.id] });
    assert.equal(((result.evaluation as JsonObject).metrics as JsonObject).false_positive_count, 1);
    f.runtime.evaluationCaseSave({ case_id: "second", policy_id: defaults.id, proposal: { scope_kind: "project", scope_id: "project", intents: ["conversation"] }, expected_actions: { context: "none", capability: "none", workflow: "none", work: "none", memory: "none", evaluation: "none" } });
    assert.throws(() => f.runtime.evaluationRun({ evaluation_id: "conflict" }), /conflict/);
  } finally { await close(f); }
});

test("v0.12.28 records replay-safe receipts and generated evaluation records", async () => {
  const f = await fixture();
  try {
    const p = policy(f.runtime, "replay"); const first = hostProposal(f.runtime, String(f.source.id), "receipt-first");
    const defaultCandidate = f.runtime.proposalSubmit({ proposal_id: "default-candidate", scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "codex", input_digest: "sha256:default-candidate", intents: ["conversation"], signals: ["durable_value"], memory_candidate: { source_id: f.source.id, kind: "working", content: "A safe default sensitivity candidate." } }).proposal as JsonObject;
    assert.equal(((f.runtime.assess({ proposal_id: defaultCandidate.id, policy_id: p.id }).candidate as JsonObject).sensitivity), "internal");
    const firstReceipt = f.runtime.assess({ receipt_id: "shared", proposal_id: first.id, policy_id: p.id }).receipt as JsonObject;
    assert.equal((f.runtime.receiptGet({ receipt_id: firstReceipt.id, version: 1 }).receipt as JsonObject).version, 1);
    const second = f.runtime.proposalSubmit({ proposal_id: "receipt-second", scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: "codex", input_digest: "sha256:second", intents: ["conversation"] }).proposal as JsonObject;
    assert.throws(() => f.runtime.assess({ receipt_id: "shared", proposal_id: second.id, policy_id: p.id }), /conflict/);
    f.store.save("turn_policy", String(p.id), { ...(p as JsonObject), status: "disabled" });
    assert.throws(() => f.runtime.assess({ proposal_id: second.id, policy_id: p.id }), /active/);
    const active = policy(f.runtime, "eval-active");
    const generated = f.runtime.evaluationCaseSave({ policy_id: active.id, proposal: { scope_kind: "project", scope_id: "project", intents: ["conversation"] }, expected_actions: { context: "none", capability: "none", workflow: "none", work: "none", memory: "none", evaluation: "none" } }).case as JsonObject;
    assert.match(String(generated.id), /^turn_evaluation_case_/);
    assert.match(String((f.runtime.evaluationRun({ case_ids: [generated.id] }).evaluation as JsonObject).id), /^turn_evaluation_/);
  } finally { await close(f); }
});

test("v0.12.28 exposes every Turn Cognitive operation through the CraftService facade", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const p = service.turnPolicySave({ policy_id: "service", scope_kind: "project", scope_id: "project" }).policy as JsonObject;
    assert.equal((service.turnPolicyGet({ policy_id: p.id }).policy as JsonObject).id, p.id);
    const adapter = service.turnHostAdapterSave({ adapter_id: "service-host", host: "codex" }).adapter as JsonObject;
    assert.equal((service.turnHookPlan({ adapter_id: adapter.id }).plan as JsonObject).automatic, false);
    const proposal = service.turnProposalSubmit({ proposal_id: "service-proposal", scope_kind: "project", scope_id: "project", semantic_owner: "host", host_adapter_id: adapter.id, input_digest: "sha256:service", intents: ["conversation"], signals: ["durable_value"], memory_candidate: { source_id: f.source.id, kind: "working", content: "service candidate" } }).proposal as JsonObject;
    const assessed = service.turnIntakeAssess({ proposal_id: proposal.id, policy_id: p.id }); const candidate = assessed.candidate as JsonObject;
    assert.equal((service.turnReceiptGet({ receipt_id: (assessed.receipt as JsonObject).id }).receipt as JsonObject).id, (assessed.receipt as JsonObject).id);
    assert.equal((service.turnMemoryCandidateList().candidates as JsonObject[]).length, 1);
    assert.equal((service.turnMemoryCandidateDecide({ candidate_id: candidate.id, status: "rejected", reason: "not retained" }).candidate as JsonObject).status, "rejected");
    const evaluationCase = service.turnEvaluationCaseSave({ policy_id: p.id, proposal: { scope_kind: "project", scope_id: "project", intents: ["conversation"] }, expected_actions: { context: "none", capability: "none", workflow: "none", work: "none", memory: "none", evaluation: "none" } }).case as JsonObject;
    assert.equal((service.turnEvaluationRun({ case_ids: [evaluationCase.id] }).evaluation as JsonObject).verdict, "eligible");
  } finally { await close(f); }
});
