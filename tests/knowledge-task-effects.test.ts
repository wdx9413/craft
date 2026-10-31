import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTaskInput, binaryEffect } from "craft-eval";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { payload, stableDigest } from "../core/digest.ts";
import { KnowledgeTaskEffects } from "../core/knowledge-task-effects.ts";
import { knowledgeTaskEffectEvidenceVerified, knowledgeClaimPromotionProofVerified } from "../core/knowledge-evaluation-provenance.ts";
import { knowledgeTaskContract } from "../core/knowledge-task-contract.ts";
import { knowledgeTaskEffectAssessmentDigest } from "../core/knowledge-task-effect-proof.ts";
import { KnowledgeAutoReviewKernel } from "../core/knowledge-auto-review.ts";

test("task contracts require bounded deterministic outcomes and safety assertions", () => {
  const valid = { checks: [{ id: "answer", kind: "json_equals", path: "answer.json", key: "ok", equals: true }], safety_checks: [{ id: "safe", kind: "exit_code", equals: 0 }] };
  assert.deepEqual(knowledgeTaskContract(valid), valid);
  assert.doesNotThrow(() => knowledgeTaskContract({ ...valid, checks: [{ id: "file", kind: "file_exists", path: "outputs/answer.json", weight: 1, judge: "artifact" }, { id: "not", kind: "stdout_not_contains", value: "unsafe" }] }));
  for (const invalid of [null, [], {}, { ...valid, unknown: true }, { ...valid, checks: [] }, { ...valid, safety_checks: [] },
    { ...valid, checks: [null] }, { ...valid, checks: [{ id: "x", kind: "script" }] }, { ...valid, checks: [valid.checks[0], valid.checks[0]] },
    { ...valid, checks: [{ id: "exit", kind: "exit_code", equals: 0 }] }, { ...valid, checks: Array(33).fill(valid.checks[0]) },
    { ...valid, checks: [{ ...valid.checks[0], equals: "x".repeat(65_536) }] }, ...[
      { id: "file", kind: "file_exists", path: "../secret" }, { id: "file", kind: "file_exists", path: "/secret" },
      { id: "file", kind: "file_exists", path: "C:\\secret" }, { id: "file", kind: "file_exists", path: "outputs//file" },
      { id: "file", kind: "file_exists", path: "./file" }, { id: "file", kind: "file_exists", path: null },
      { id: "file", kind: "file_exists", path: "file", unexpected: true },
      { id: "out", kind: "stdout_contains", value: "ok", weight: 0 }, { id: "out", kind: "stdout_contains", value: "ok", weight: "1" },
      { id: "out", kind: "stdout_contains", value: "ok", judge: 1 }, { id: "out", kind: "stdout_contains", value: "" },
      { id: "out", kind: "stdout_contains", value: null }, { id: "exit", kind: "exit_code", equals: 0.5 },
      { id: "json", kind: "json_equals", path: "file.json", key: "", equals: 1 }, { id: "json", kind: "json_equals", path: "file.json", key: "x" },
    ].map(check => ({ ...valid, checks: [check] }))]) assert.throws(() => knowledgeTaskContract(invalid), /task_contract/);
});

test("Knowledge authority requires exact adjudicated tasks and a controlled positive paired effect", async () => {
  // Policy fixture only: these records emulate trusted execution and do not claim live model effectiveness.
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-task-effect-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const source = store.create("knowledge_source", "source", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified", content_digest: stableDigest("source") });
  store.create("evidence", "claim-evidence", { confidence: "confirmed", metadata: { source_session_id: "claim-session", task_id: "claim-task", source_ref_digest: stableDigest("claim") } });
  const claim = store.create("knowledge_claim", "claim", { status: "candidate", scope: "global", source_id: source.id, content: "Exact task knowledge", identity_digest: stableDigest("claim"), content_digest: stableDigest("body"), evidence_ids: ["claim-evidence"] });
  const refs = [{ claim_id: claim.id, claim_version: claim.version, identity_digest: claim.identity_digest, content_digest: claim.content_digest }];
  const contract = { checks: [{ id: "answer", kind: "stdout_contains", value: "correct" }], safety_checks: [{ id: "safe", kind: "exit_code", equals: 0 }] };
  const cases = Array.from({ length: 21 }, (_, index) => {
    const id = `task-${index}`, evidenceId = `task-evidence-${index}`, adjudicationId = `adjudication-${index}`;
    store.create("evidence", evidenceId, { confidence: "confirmed", metadata: { source_session_id: `heldout-${index}`, task_id: id, source_ref_digest: stableDigest(id) } });
    const item = store.create("knowledge_evaluation_case", id, { query: `Independent task ${index}`, identity_digest: stableDigest(id), scope: "global", expected_claim_ids: index === 20 ? [] : [claim.id],
      candidate_claim_refs: refs, source_session_id: `heldout-${index}`, source_task_id: id, source_evidence_ids: [evidenceId], evaluation_channel: "real_session", dataset_partition: "held_out", sanitized: true,
      label_source: "host_adjudicated", adjudication_id: adjudicationId, task_contract: contract });
    store.create("knowledge_evaluation_adjudication", adjudicationId, { scope: "global", execution_origin: "managed_codex_cli", case_id: id, status: "adjudicated", result_case_version: item.version,
      result_case_identity_digest: item.identity_digest, decision: "accepted", expected_claim_ids: item.expected_claim_ids, task_contract_digest: stableDigest(contract) });
    return item;
  });
  const run = store.create("knowledge_evaluation_run", "retrieval", { mode: "candidate_shadow", status: "eligible", metrics: { provenance_eligible: true }, candidate_claim_refs: refs,
    candidate_source_refs: [{ claim_id: claim.id, source_id: source.id, source_version: source.version, source_digest: source.content_digest, source_status: source.status, source_trust: source.trust }],
    case_ids: cases.map(item => item.id), case_refs: cases.map(item => ({ case_id: item.id, case_version: item.version, identity_digest: item.identity_digest })) });
  const executable = await realpath(process.execPath);
  const engine = { executable, kind: "claude", sha256: "b".repeat(64), environment_digest: stableDigest("environment") };
  const records = ["a", "b"].map(id => store.create("workbench_evaluation", id, { state: "completed", execution_engine: engine }));
  let context: unknown;
  const suite = { subject_kind: "agent", partition: "held_out", sanitized: true, approved_by: "fixture", metrics: { primary: { kind: "binary_pass_rate", direction: "higher_is_better" }, guardrails: [{ metric: "duration_ms", required: true, comparator: "lte", threshold: 100 }] }, cases: cases.map(item => ({ id: item.id, prompt: item.query, ...contract })) };
  const subjects: JsonObject[] = [0, 1].map(() => ({ kind: "agent", id: "subject", version: "1", host: { kind: "claude", binary: executable, model: "selected-model" } }));
  const results: JsonObject[][] = [0, 1].map(side => cases.map(item => ({ case_id: item.id, trial: 1, task_run_id: `${side}-${String(item.id)}`, task_verdict: side === 0 ? "failed" : "passed", safety_verdict: "passed", workspace_snapshot: { digest: "same-code", bytes: 1, files: 1 }, trace_complete: true, issue: null,
    duration_ms: 1, host: { adapter: "claude", requested_model: "selected-model", observed_models: ["actual-model"], input_tokens: 10, output_tokens: 2 } })));
  const comparison: JsonObject = { status: "comparable", independent_task_runs: true, unmeasured_pairs: 0, one_sided_p: 0.000001, primary_effect: binaryEffect(Array.from({ length: 21 }, () => ({ baseline: false, candidate: true }))), guardrails: [] };
  const controlled = {
    get: (id: string) => records[id === "a" ? 0 : 1]!,
    inputs: async (id: string) => ({ suite, runtime: { budget_digest: "same" }, subject: subjects[id === "a" ? 0 : 1]! }),
    report: async (id: string) => ({ report: { results: results[id === "a" ? 0 : 1] } }),
    compare: async () => ({ comparison: { metrics: comparison } }),
  };
  const effects = new KnowledgeTaskEffects(store, controlled, async () => executable);
  try {
    assert.equal(knowledgeTaskEffectEvidenceVerified(store, run), false);
    context = effects.context("retrieval").context; subjects[1]!.context = context;
    for (const [side, items] of results.entries()) for (const [index, item] of items.entries()) item.input_receipt = prepareTaskInput(String(cases[index]!.query), side === 0 ? undefined : context as { id: string; text: string }).receipt;
    const host = subjects[1]!.host as JsonObject;
    host.args_prefix = ["wrapper.mjs"];
    await assert.rejects(effects.assess("retrieval", "a", "b"), /subjects differ/);
    (subjects[0]!.host as JsonObject).args_prefix = ["wrapper.mjs"];
    await assert.rejects(effects.assess("retrieval", "a", "b"), /wrapper or environment/);
    delete host.args_prefix; delete (subjects[0]!.host as JsonObject).args_prefix;
    subjects[0]!.env = {}; subjects[1]!.env = {}; host.env = {}; (subjects[0]!.host as JsonObject).env = {};
    const original = results[1]![0]!.input_receipt; results[1]![0]!.input_receipt = {};
    await assert.rejects(effects.assess("retrieval", "a", "b"), /submitted input/); results[1]![0]!.input_receipt = original;
    const snapshot = results[1]![0]!.workspace_snapshot; results[1]![0]!.workspace_snapshot = { digest: "other" };
    await assert.rejects(effects.assess("retrieval", "a", "b"), /code snapshots/); results[1]![0]!.workspace_snapshot = snapshot;
    const observed = (results[1]![0]!.host as JsonObject).observed_models; (results[1]![0]!.host as JsonObject).observed_models = [];
    await assert.rejects(effects.assess("retrieval", "a", "b"), /observed model identity/); (results[1]![0]!.host as JsonObject).observed_models = observed;
    const issued = await effects.assess("retrieval", "a", "b");
    assert.equal((issued.assessment as JsonObject).status, "eligible");
    assert.equal(issued.knowledge_promotion_authorized, false); assert.equal(knowledgeTaskEffectEvidenceVerified(store, run), true);
    assert.equal((await effects.assess("retrieval", "a", "b")).idempotent, true);
    const receipt = issued.assessment as JsonObject, find = store.find.bind(store);
    for (const patch of [{ version: 2 }, { status: "insufficient" }, { dependencies: [] }, { dependencies: null }, { dependencies: [null] },
      { dependencies: [{}] }, { dependencies: Array(10_001).fill({}) }, { dependencies: [(receipt.dependencies as JsonObject[])[0], (receipt.dependencies as JsonObject[])[0]] },
      { dependencies: [{ kind: "evidence", id: "missing", version: 1 }] }, { dependencies: [{ ...(receipt.dependencies as JsonObject[])[0], digest: "changed" }] },
      { metrics: {} }]) {
      const replacement: JsonObject = { ...receipt, ...patch };
      replacement.assessment_digest = knowledgeTaskEffectAssessmentDigest(replacement);
      store.find = (kind, id, version, hydrate) => kind === "knowledge_task_effect" ? replacement : find(kind, id, version, hydrate);
      try { assert.equal(knowledgeTaskEffectEvidenceVerified(store, run), false); } finally { store.find = find; }
    }
    await assert.rejects(new KnowledgeTaskEffects(store, controlled).assess("retrieval", "a", "b"), /engine is not|Claude.*not found/);
    host.kind = "codex"; (subjects[0]!.host as JsonObject).kind = "codex";
    await assert.rejects(new KnowledgeTaskEffects(store, controlled).assess("retrieval", "a", "b"), /engine is not|engine executable was not found/);
    host.kind = "claude"; (subjects[0]!.host as JsonObject).kind = "claude";
    store.find = (kind, id, version, hydrate) => kind === "knowledge_source" && hydrate === false ? null : find(kind, id, version, hydrate);
    try { assert.throws(() => effects.context("retrieval"), /dependency is unavailable/); } finally { store.find = find; }
    const insufficient = store.create("knowledge_evaluation_run", "insufficient", payload(run));
    comparison.status = "inconclusive"; comparison.independent_task_runs = false; comparison.unmeasured_pairs = 1; comparison.one_sided_p = 0.5;
    comparison.primary_effect = { risk_difference_ci95: [-0.1, 0.2] }; comparison.guardrails = [{ status: "failed" }];
    results[1]![20]!.task_verdict = "failed";
    const held = (await effects.assess("insufficient", "a", "b")).assessment as JsonObject;
    assert.equal(held.status, "insufficient"); assert.equal((held.reasons as string[]).length, 4); assert.equal(knowledgeTaskEffectEvidenceVerified(store, insufficient), false);
    comparison.one_sided_p = 0.1;
    await assert.rejects(effects.assess("insufficient", "a", "b"), /different assessment/);
    Object.assign(comparison, { status: "comparable", independent_task_runs: true, unmeasured_pairs: 0, one_sided_p: 0.000001,
      primary_effect: binaryEffect(Array.from({ length: 21 }, () => ({ baseline: false, candidate: true }))), guardrails: [] });
    results[1]![20]!.task_verdict = "passed";
    store.create("knowledge_evaluation_run", "concurrent", payload(run));
    const transact = store.transactionWithRetry.bind(store);
    let first = true, announce!: () => void, proceed!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; }), gate = new Promise<void>(resolve => { proceed = resolve; });
    store.transactionWithRetry = (async (callback, options) => { if (first) { first = false; announce(); await gate; } return transact(callback, options); }) as typeof store.transactionWithRetry;
    try {
      const waiting = effects.assess("concurrent", "a", "b"); await entered;
      assert.equal((await effects.assess("concurrent", "a", "b")).idempotent, false);
      proceed(); assert.equal((await waiting).idempotent, true);
    } finally { proceed(); store.transactionWithRetry = transact; }
    for (const index of [1, 2]) {
      const evidence = store.create("evidence", `support-${index}`, { confidence: "confirmed", metadata: { source_session_id: `support-session-${index}`, task_id: `support-task-${index}` } });
      store.create("knowledge_claim_support", `support-${index}`, { scope: "global", claim_id: claim.id, evidence_id: evidence.id });
    }
    const review = new KnowledgeAutoReviewKernel(store).assess({ scope_kind: "global", scope_id: "global", claim_ids: [claim.id] });
    assert.equal((review.assessments as JsonObject[])[0]!.promoted, true);
    const promoted = store.get("knowledge_claim", String(claim.id));
    assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), true);
    const item = store.get("evidence", "task-evidence-0"); store.save("evidence", "task-evidence-0", { ...item, confidence: "unverified" });
    assert.equal(knowledgeTaskEffectEvidenceVerified(store, run), false);
    assert.equal(knowledgeClaimPromotionProofVerified(store, promoted), false);
    await assert.rejects(effects.assess("retrieval", "a", "b"), /Claim or Source revision/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
