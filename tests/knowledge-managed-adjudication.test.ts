import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";
import { createActionHandlers } from "../core/application/actions/action-handlers.ts";
import type { ModelTransport } from "../core/model-gateway.ts";
import { knowledgeEvaluationAdjudicationVerified } from "../core/knowledge-evaluation-provenance.ts";
import { runSessionKnowledgeAdjudicationOnce } from "../deploy/experience-learning/session-knowledge-adjudication.ts";
import type { ExperienceLearningClient } from "../deploy/experience-learning/worker.ts";

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
async function fixture(output = JSON.stringify({ decision: "accepted", expected_claim_ids: ["managed-claim"] }), gate?: Promise<void>,
  options: { model?: string; no_usage?: boolean; fail?: unknown; synthetic_legacy_source?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "craft-managed-adjudication-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const calls: JsonObject[] = [];
  const transport: ModelTransport = { acquireCall: () => true, async complete(provider, request) {
    calls.push({ provider: provider.provider, request: request.body });
    if (gate) await gate;
    if (options.fail !== undefined) throw options.fail;
    return { text: output, model: options.model ?? "gpt-6-luna", usage: options.no_usage ? null : { input_tokens: 12, output_tokens: 5 } };
  } };
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, "zh-CN", () => transport);
  service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: root });
  const source = service.knowledgeSessionEvidenceRecord({ scope: "project:demo", task_id: "source-task", source_session_id: "source-session",
    turn_id: "source-turn", source_ref: sha("a"), task_goal: "验证规则", task_result: "规则成立", sanitized: true,
    verification_artifacts: [{ runner: "javascript", command_digest: sha("b"), result_digest: sha("c"), call_digest: sha("d"),
      exit_code: 0, summary_kind: "tests_passed", content_stored: false }] });
  const sourceEvidence = options.synthetic_legacy_source ? service.evidenceRecord({ evidence_id: "legacy-source-fixture", source_type: "program",
    confidence: "confirmed", claim: "legacy fixture", source_id: source.source_id, fragment_id: source.fragment_id,
    metadata: { source_session_id: "source-session", task_id: "source-task" } }) : source.evidence as JsonObject;
  const claim = service.knowledgeClaimSave({ claim_id: "managed-claim", kind: "fact", title: "已验证规则", content: "规则成立",
    scope: "project:demo", source_id: source.source_id, evidence_ids: [sourceEvidence.id] }).claim as JsonObject;
  const held = service.knowledgeSessionEvidenceRecord({ scope: "project:demo", task_id: "held-task", source_session_id: "held-session",
    turn_id: "held-turn", source_ref: sha("e"), task_goal: "独立任务", task_result: "独立结果支持规则", sanitized: true,
    verification_artifacts: [{ runner: "javascript", command_digest: sha("f"), result_digest: sha("1"), call_digest: sha("2"),
      exit_code: 0, summary_kind: "tests_passed", content_stored: false }] });
  // Synthetic positive control for the managed model/Trace workflow. This is
  // not proof that public confidence labels are trustworthy in real operation.
  const heldControl = store.create("evidence", "held-control", { source_type: "program", confidence: "confirmed",
    claim: "独立任务结果", source_id: held.source_id, fragment_id: held.fragment_id,
    metadata: { source_session_id: "held-session", task_id: "held-task" } });
  const case_ = service.knowledgeEvaluationCaseSave({ case_id: "managed-case", query: "规则成立", scope: "project:demo",
    expected_claim_ids: [claim.id], candidate_claim_refs: [{ claim_id: claim.id, claim_version: claim.version,
      identity_digest: claim.identity_digest, content_digest: claim.content_digest }],
    source_session_id: "held-session", source_task_id: "held-task", source_evidence_ids: [heldControl.id],
    evaluation_channel: "real_session", dataset_partition: "held_out", sanitized: true, label_source: "model_candidate" }).case as JsonObject;
  Object.assign(service, {
    evaluationModelProfileEnsureSingle: () => ({ status: "ready_for_adapter", profile: { id: "managed-profile", version: 1,
      provider: "codex-cli", model: "gpt-6-luna", max_output_tokens: 256 } }),
    evaluationModelProfileGet: () => ({ readiness: { status: "ready_for_adapter" } }),
  });
  return { root, store, service, case_, calls, held, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("public adjudication owns the Host call and rejects caller-supplied Trace fields", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.knowledgeEvaluationCaseAdjudicate({ case_id: f.case_.id, trace_id: "forged" }), /server-owned Host execution/u);
    const handler = createActionHandlers(f.service).craft_knowledge_evaluation_case_adjudicate;
    assert.ok(handler);
    const result = await handler({ case_id: f.case_.id, expected_version: f.case_.version, trace_id: "forged",
      decision: "rejected", expected_claim_ids: [] }) as JsonObject;
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.provider, "codex-cli");
    assert.equal(result.model_calls, 1);
    const case_ = result.case as JsonObject;
    const adjudication = result.adjudication as JsonObject;
    assert.equal(case_.label_source, "host_adjudicated");
    assert.equal(adjudication.execution_origin, "managed_codex_cli");
    assert.equal(knowledgeEvaluationAdjudicationVerified(f.store, case_), true);
    const trace = f.service.trace.get({ trace_id: result.trace_id });
    assert.equal((trace.trace as JsonObject).status, "completed");
    assert.deepEqual(((trace.events as JsonObject[]).find(event => event.event_kind === "model.completed")?.usage as JsonObject),
      { input_tokens: 12, output_tokens: 5 });
    await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
      expected_version: f.case_.version }), /current sanitized held-out candidate/u);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("caller-asserted Evidence cannot qualify a managed shadow run or promote a Claim", async () => {
  const f = await fixture();
  try {
    const adjudicated = await f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id, expected_version: f.case_.version });
    const publicEvidence = createActionHandlers(f.service).craft_evidence_record;
    await publicEvidence({ evidence_id: "held-control", source_type: "program", confidence: "confirmed", claim: "caller assertion",
      record_origin: "managed", metadata: { source_session_id: "held-session", task_id: "held-task" } });
    assert.equal(f.store.get("evidence", "held-control").record_origin, "caller_asserted");
    const item = adjudicated.case as JsonObject;
    const run = f.service.knowledgeEvaluationRun({ mode: "candidate_shadow", case_ids: [item.id],
      candidate_claim_ids: ["managed-claim"] }).run as JsonObject;
    assert.equal(item.label_source, "host_adjudicated");
    assert.equal((run.metrics as JsonObject).provenance_eligible, false);
    assert.equal(run.status, "insufficient");
    for (const n of [1, 2]) {
      const evidence = f.service.evidenceRecord({ evidence_id: `claimed-support-${n}`, source_type: "program", confidence: "confirmed",
        claim: "Caller asserted support", metadata: { source_session_id: `claimed-session-${n}`, task_id: `claimed-task-${n}` } });
      f.service.knowledgeClaimSupportRecord({ claim_id: "managed-claim", evidence_id: evidence.id, observation_key: `claimed-observation-${n}` });
    }
    const review = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: ["managed-claim"] });
    assert.equal(((review.assessments as JsonObject[])[0]!).promoted, false);
    const context = f.service.wikiContextCompile({ query: "规则成立", scope: "project:demo" });
    assert.equal((context.included as JsonObject[]).some(item => item.claim_id === "managed-claim"), false);
  } finally { await f.close(); }
});

test("replacing held-out Evidence through the public API invalidates prior formal Knowledge", async () => {
  const f = await fixture(undefined, undefined, { synthetic_legacy_source: true });
  try {
    const adjudicated = await f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id, expected_version: f.case_.version });
    f.service.knowledgeEvaluationRun({ mode: "candidate_shadow", case_ids: [(adjudicated.case as JsonObject).id], candidate_claim_ids: ["managed-claim"] });
    for (const n of [1, 2]) {
      const evidence = f.service.evidenceRecord({ evidence_id: `support-${n}`, source_type: "program", confidence: "confirmed",
        claim: "fixture support", metadata: { source_session_id: `session-${n}`, task_id: `task-${n}` } });
      f.service.knowledgeClaimSupportRecord({ claim_id: "managed-claim", evidence_id: evidence.id, observation_key: `observation-${n}` });
    }
    const review = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: ["managed-claim"] });
    assert.equal(((review.assessments as JsonObject[])[0]!).promoted, true);
    assert.equal((f.service.wikiContextCompile({ query: "规则成立", scope: "project:demo" }).included as JsonObject[]).length, 1);
    await createActionHandlers(f.service).craft_evidence_record({ evidence_id: "held-control", source_type: "program", confidence: "confirmed",
      claim: "caller assertion", metadata: { source_session_id: "held-session", task_id: "held-task" } });
    assert.equal((f.service.wikiContextCompile({ query: "规则成立", scope: "project:demo" }).included as JsonObject[]).length, 0);
  } finally { await f.close(); }
});

test("replacing a bound support Evidence invalidates formal Knowledge at read time", async () => {
  const f = await fixture(undefined, undefined, { synthetic_legacy_source: true });
  try {
    const adjudicated = await f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id, expected_version: f.case_.version });
    f.service.knowledgeEvaluationRun({ mode: "candidate_shadow", case_ids: [(adjudicated.case as JsonObject).id], candidate_claim_ids: ["managed-claim"] });
    for (const n of [1, 2]) {
      const evidence = f.service.evidenceRecord({ evidence_id: `support-${n}`, source_type: "program", confidence: "confirmed",
        claim: "fixture support", metadata: { source_session_id: `session-${n}`, task_id: `task-${n}` } });
      f.service.knowledgeClaimSupportRecord({ claim_id: "managed-claim", evidence_id: evidence.id, observation_key: `observation-${n}` });
    }
    const review = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: ["managed-claim"] });
    assert.equal(((review.assessments as JsonObject[])[0]!).promoted, true);
    assert.equal((f.service.wikiContextCompile({ query: "规则成立", scope: "project:demo" }).included as JsonObject[]).length, 1);
    await createActionHandlers(f.service).craft_evidence_record({ evidence_id: "support-1", source_type: "program", confidence: "confirmed",
      claim: "caller assertion", metadata: { source_session_id: "session-1", task_id: "task-1" } });
    assert.equal((f.service.wikiContextCompile({ query: "规则成立", scope: "project:demo" }).included as JsonObject[]).length, 0);
  } finally { await f.close(); }
});

test("replacing the Claim source with a public assertion blocks formal Context", async () => {
  const f = await fixture(undefined, undefined, { synthetic_legacy_source: true });
  try {
    const adjudicated = await f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id, expected_version: f.case_.version });
    f.service.knowledgeEvaluationRun({ mode: "candidate_shadow", case_ids: [(adjudicated.case as JsonObject).id], candidate_claim_ids: ["managed-claim"] });
    for (const n of [1, 2]) {
      const support = f.service.evidenceRecord({ evidence_id: `claim-source-support-${n}`, source_type: "program", confidence: "confirmed",
        claim: "fixture support", metadata: { source_session_id: `session-${n}`, task_id: `task-${n}` } });
      f.service.knowledgeClaimSupportRecord({ claim_id: "managed-claim", evidence_id: support.id, observation_key: `observation-${n}` });
    }
    const review = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: ["managed-claim"] });
    assert.equal(((review.assessments as JsonObject[])[0]!).promoted, true);
    assert.equal((f.service.wikiContextCompile({ query: "规则成立", scope: "project:demo" }).included as JsonObject[]).length, 1);
    const source = f.store.get("evidence", "legacy-source-fixture");
    await createActionHandlers(f.service).craft_evidence_record({ evidence_id: source.id, source_type: source.source_type,
      confidence: source.confidence, claim: source.claim, source_id: source.source_id, fragment_id: source.fragment_id, metadata: source.metadata });
    assert.equal((f.service.wikiContextCompile({ query: "规则成立", scope: "project:demo" }).included as JsonObject[]).length, 0);
  } finally { await f.close(); }
});

test("the Worker, MCP handler and Store complete one held-out case then go idle", async () => {
  const f = await fixture();
  try {
    const handlers = createActionHandlers(f.service);
    const client: ExperienceLearningClient = { async call(name, args = {}) {
      const handler = handlers[name];
      if (!handler) throw new Error(`missing handler: ${name}`);
      return await handler(args) as JsonObject;
    } };
    const first = await runSessionKnowledgeAdjudicationOnce({ client });
    assert.equal(first.status, "adjudicated");
    assert.equal(first.model_calls, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(typeof first.evaluation_run_id, "string");
    assert.equal((await runSessionKnowledgeAdjudicationOnce({ client })).status, "idle");
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("invalid managed model response leaves a failed Trace and no adjudication", async () => {
  const f = await fixture("not JSON");
  try {
    await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
      expected_version: f.case_.version }), /one JSON object/u);
    assert.equal(f.calls.length, 1);
    assert.equal((f.store.get("knowledge_evaluation_case", String(f.case_.id))).label_source, "model_candidate");
    assert.equal(f.store.list("knowledge_evaluation_adjudication", 10).length, 0);
  } finally { await f.close(); }
});

test("concurrent adjudication of one case starts one Host call", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(undefined, gate);
  try {
    const first = f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id, expected_version: f.case_.version });
    for (let attempt = 0; attempt < 50 && f.calls.length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
      expected_version: f.case_.version }), /already running/u);
    assert.equal(f.calls.length, 1);
    release();
    assert.equal((await first).model_calls, 1);
  } finally { release(); await f.close(); }
});

test("stale candidates, dependent Evidence and missing profile fail before a Host call", async () => {
  for (const change of ["case_version", "claim_version", "evidence_confidence", "same_source_session", "profile"]) {
    const f = await fixture();
    try {
      if (change === "claim_version") {
        const claim = f.store.get("knowledge_claim", "managed-claim");
        f.store.save("knowledge_claim", "managed-claim", { ...claim, content_digest: "changed" });
      }
      if (change === "evidence_confidence") {
        const evidenceId = (f.case_.source_evidence_ids as string[])[0]!;
        const evidence = f.store.get("evidence", evidenceId);
        f.store.save("evidence", evidenceId, { ...evidence, confidence: "unverified" });
      }
      if (change === "same_source_session") {
        const claim = f.store.get("knowledge_claim", "managed-claim");
        const evidenceId = (claim.evidence_ids as string[])[0]!;
        const evidence = f.store.get("evidence", evidenceId);
        f.store.save("evidence", evidenceId, { ...evidence,
          metadata: { ...(evidence.metadata as JsonObject), source_session_id: "held-session" } });
      }
      if (change === "profile") Object.assign(f.service, { evaluationModelProfileEnsureSingle: () => ({ status: "unavailable" }) });
      await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
        expected_version: Number(f.case_.version) + (change === "case_version" ? 1 : 0) }));
      assert.equal(f.calls.length, 0, change);
    } finally { await f.close(); }
  }
});

test("missing source packets, Evidence and Codex profile do not dispatch a model", async () => {
  for (const condition of ["packet", "empty_evidence", "malformed_metadata", "profile_detail", "profile_provider", "model_budget"]) {
    const f = await fixture();
    try {
      let caseVersion = Number(f.case_.version);
      if (condition === "packet") Object.assign(f.service, { knowledgeSemanticReviewPacket: () => ({ status: "unavailable" }) });
      if (condition === "empty_evidence") {
        const saved = f.store.save("knowledge_evaluation_case", String(f.case_.id), { ...f.case_, source_evidence_ids: [] });
        caseVersion = Number(saved.version);
      }
      if (condition === "malformed_metadata") {
        const get = f.store.get.bind(f.store);
        Object.assign(f.store, { get: (type: string, id: string, version?: number) => {
          const record = get(type, id, version);
          return type === "evidence" ? { ...record, metadata: [] } : record;
        } });
      }
      if (condition === "profile_detail") Object.assign(f.service, { evaluationModelProfileGet: () => ({ readiness: { status: "unavailable" } }) });
      if (condition === "profile_provider") Object.assign(f.service, { evaluationModelProfileEnsureSingle: () => ({ status: "ready_for_adapter",
        profile: { id: "other", version: 1, provider: "other", model: "gpt-6-luna" } }) });
      if (condition === "model_budget") Object.assign(f.service, { knowledgeAdjudicationTransportFactory: () => ({ acquireCall: () => false,
        complete: async () => { throw new Error("must not run"); } }) });
      await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
        expected_version: caseVersion }));
      assert.equal(f.calls.length, 0, condition);
    } finally { await f.close(); }
  }
});

test("retrieval labels use the server's current case and an absent usage report is valid", async () => {
  const f = await fixture(undefined, undefined, { no_usage: true });
  try {
    const saved = f.service.knowledgeEvaluationCaseSave({ case_id: "retrieval-case", query: "规则成立", scope: "project:demo",
      expected_claim_ids: ["managed-claim"], source_session_id: "held-session", source_task_id: "held-task",
      source_evidence_ids: f.case_.source_evidence_ids, evaluation_channel: "real_session", dataset_partition: "held_out",
      sanitized: true, label_source: "model_candidate" }).case as JsonObject;
    const result = await f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: saved.id, expected_version: saved.version });
    assert.equal((result.case as JsonObject).label_source, "host_adjudicated");
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("corrupt case shapes and missing provider fail before calling Codex", async () => {
  for (const condition of ["missing_evidence_ids", "missing_provider"]) {
    const f = await fixture();
    try {
      let version = Number(f.case_.version);
      if (condition === "missing_evidence_ids") {
        const { source_evidence_ids: _omitted, ...payload } = f.case_;
        version = Number(f.store.save("knowledge_evaluation_case", String(f.case_.id), payload).version);
      } else Object.assign(f.service, { modelProviders: [] });
      await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
        expected_version: version }));
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  }
});

test("nontext Evidence and a profile without an output cap remain bounded", async () => {
  const f = await fixture();
  try {
    const get = f.store.get.bind(f.store);
    Object.assign(f.store, { get: (type: string, id: string, version?: number) => {
      const record = get(type, id, version);
      return type === "evidence" ? { ...record, claim: 42 } : record;
    } });
    Object.assign(f.service, { evaluationModelProfileEnsureSingle: () => ({ status: "ready_for_adapter",
      profile: { id: "managed-profile", version: 1, provider: "codex-cli", model: "gpt-6-luna" } }) });
    const result = await f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
      expected_version: f.case_.version });
    assert.equal(result.model_calls, 1);
    assert.equal((f.calls[0]!.request as JsonObject).max_tokens, 1_024);
    const messages = (f.calls[0]!.request as JsonObject).messages as JsonObject[];
    const packet = JSON.parse(String(messages[1]!.content)) as JsonObject;
    assert.equal(((packet.verified_held_out_evidence as JsonObject[])[0]!).claim, "");
  } finally { await f.close(); }
});

test("negative and malformed managed decisions cannot become eligible evaluation labels", async () => {
  for (const output of [JSON.stringify({ decision: "rejected", expected_claim_ids: [] }),
    JSON.stringify({ decision: "uncertain", expected_claim_ids: [] }),
    JSON.stringify({ decision: "accepted", expected_claim_ids: ["unbound-claim"] }),
    JSON.stringify({ decision: "accepted", expected_claim_ids: [] }),
    JSON.stringify({ decision: "corrected", expected_claim_ids: ["managed-claim"] }),
    JSON.stringify({ decision: "accepted", expected_claim_ids: "managed-claim" })]) {
    const f = await fixture(output);
    try {
      if (output.includes("rejected") || output.includes("uncertain")) {
        const result = await f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id, expected_version: f.case_.version });
        assert.equal((result.case as JsonObject).label_source, "model_candidate");
        assert.equal(knowledgeEvaluationAdjudicationVerified(f.store, result.case as JsonObject), false);
      } else {
        await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
          expected_version: f.case_.version }), /bound candidate labels/u);
        assert.equal(f.store.list("knowledge_evaluation_adjudication", 10).length, 0);
      }
      assert.equal(f.calls.length, 1);
    } finally { await f.close(); }
  }
});

test("managed Host failures preserve a failed Trace without accepting a label", async () => {
  for (const options of [{ model: "wrong-model" }, { fail: "transport failed" }]) {
    const f = await fixture(undefined, undefined, options);
    try {
      await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
        expected_version: f.case_.version }));
      assert.equal(f.store.list("knowledge_evaluation_adjudication", 10).length, 0);
      assert.equal(f.store.list("trace", 10).some(trace => trace.status === "failed"), true);
    } finally { await f.close(); }
  }
});

test("a persisted Host result resumes after a new Store opens without another model call", async () => {
  for (const failureAt of ["model.completed", "adjudication.event", "trace.finalize", "case.save"]) {
    const f = await fixture();
    let reopened: CraftStore | undefined;
    try {
      if (failureAt === "model.completed" || failureAt === "adjudication.event") {
        const append = f.service.traceAppend.bind(f.service);
        Object.assign(f.service, { traceAppend: (args: JsonObject) => {
          if (args.event_kind === (failureAt === "model.completed" ? "model.completed" : "knowledge.evaluation_adjudication_candidate")) {
            throw new Error("trace persistence failed");
          }
          return append(args);
        } });
      } else if (failureAt === "trace.finalize") {
        Object.assign(f.service, { traceFinalize: () => { throw new Error("trace persistence failed"); } });
      } else Object.assign(f.service, { knowledgeEvaluationCaseAdjudicate: () => { throw new Error("case persistence failed"); } });
      await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
        expected_version: f.case_.version }), /persistence failed/u);
      assert.equal(f.calls.length, 1);
      assert.equal(f.store.list("knowledge_evaluation_adjudication_result", 10).length, 1);
      assert.equal(f.store.list("knowledge_evaluation_adjudication", 10).length, 0);
      const projectDb = new DatabaseSync(join(projectStorageDirectory(f.store.paths, f.root), "knowledge", "knowledge.db"), { readOnly: true });
      const globalDb = new DatabaseSync(f.store.paths.knowledgeDatabaseFile, { readOnly: true });
      try {
        const count = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get()
          ? Number((db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind='knowledge_evaluation_adjudication_result'").get() as { count: number }).count)
          : 0;
        assert.equal(count(projectDb), 1);
        assert.equal(count(globalDb), 0);
      } finally { projectDb.close(); globalDb.close(); }
      f.store.close();
      reopened = await new CraftStore(craftPaths(f.root)).open();
      const service = new CraftService(reopened, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, "zh-CN", () => ({ complete: async () => { throw new Error("model called twice"); } }));
      const result = await service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
        expected_version: f.case_.version });
      assert.equal(result.model_calls, 0);
      assert.equal(f.calls.length, 1);
      assert.equal((result.case as JsonObject).label_source, "host_adjudicated");
      assert.equal(knowledgeEvaluationAdjudicationVerified(reopened, result.case as JsonObject), true);
      assert.equal((service.trace.get({ trace_id: result.trace_id }).trace as JsonObject).status, "completed");
    } finally { reopened?.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});

test("a damaged recovery result or Trace fails closed without repeating the model call", async () => {
  for (const damage of ["result_binding", "trace_task", "trace_status", "missing_request", "malformed_events"]) {
    const f = await fixture();
    try {
      Object.assign(f.service, { traceFinalize: () => { throw new Error("trace persistence failed"); } });
      await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
        expected_version: f.case_.version }), /trace persistence failed/u);
      const persisted = f.store.list("knowledge_evaluation_adjudication_result", 10)[0]!;
      if (damage === "result_binding") f.store.save("knowledge_evaluation_adjudication_result", String(persisted.id),
        { ...persisted, case_binding_digest: "changed" });
      if (damage === "trace_task" || damage === "trace_status") {
        const trace = f.store.get("trace", String(persisted.trace_id));
        f.store.save("trace", String(trace.id), { ...trace,
          ...(damage === "trace_task" ? { task_id: "other-task" } : { status: "failed" }) });
      }
      const service = new CraftService(f.store, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, "zh-CN", () => ({ complete: async () => { throw new Error("model called twice"); } }));
      if (damage === "missing_request" || damage === "malformed_events") {
        const get = service.trace.get.bind(service.trace);
        Object.assign(service.trace, { get: (args: JsonObject) => {
          const bundle = get(args);
          return { ...bundle, events: damage === "missing_request"
            ? (bundle.events as JsonObject[]).filter(event => event.event_kind !== "model.request") : null };
        } });
      }
      await assert.rejects(service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: f.case_.id,
        expected_version: f.case_.version }), /recovery/u);
      assert.equal(f.calls.length, 1, damage);
      assert.equal(f.store.list("knowledge_evaluation_adjudication", 10).length, 0);
    } finally { await f.close(); }
  }
});

test("managed adjudication rejects transcript-only and mixed evidence before invoking Host", async () => {
  const f = await fixture();
  try {
    for (const sourceEvidenceIds of [[(f.held.evidence as JsonObject).id], [(f.held.evidence as JsonObject).id, "held-control"]]) {
      const current = f.store.get("knowledge_evaluation_case", String(f.case_.id));
      const next = f.store.save("knowledge_evaluation_case", String(f.case_.id), { ...current, source_evidence_ids: sourceEvidenceIds });
      await assert.rejects(f.service.knowledgeEvaluationCaseAdjudicateManaged({ case_id: next.id, expected_version: next.version }),
        /requires independent verified task Evidence/u);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
