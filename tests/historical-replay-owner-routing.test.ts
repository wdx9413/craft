import assert from "node:assert/strict";
import test from "node:test";
import { createHistoricalReplayArchive, historicalReplayOwners, replayEvidenceResolver } from "../core/application/coordinators/historical-learning-replay.ts";
import { CraftService } from "../core/application/craft-service.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../core/digest.ts";
import { historicalReplayArchive } from "../core/application/coordinators/historical-learning-replay.ts";

test("historical replay routes safe statements to each owner and keeps Experience and Notes behind their gates", () => {
  const calls: Array<{ owner: string; args: JsonObject }> = [];
  const stub = {
    ownerServices: new Map(["memory", "knowledge", "experience", "notes"].map(name => [name, {
      memoryCaptureHistoricalReplayCandidate: (args: JsonObject) => { calls.push({ owner: "memory", args }); return { candidate: { id: "memory-1", version: 1, content: "secret" }, auto_committed: false }; },
      knowledgeCaptureHistoricalReplayCandidate: (args: JsonObject) => { calls.push({ owner: "knowledge", args }); return { candidate: { id: "knowledge-1", version: 1 }, status: "candidate" }; },
      experienceCaptureHistoricalReplayCandidate: (args: JsonObject) => { calls.push({ owner: "experience", args }); return { status: "awaiting_evidence", candidate: { id: "experience-1", version: 1, status: "awaiting_evidence", routeable: false } }; },
      notesCaptureHistoricalReplayCandidate: (args: JsonObject) => { calls.push({ owner: "notes", args }); return { status: "skipped", reason: "insufficient_live_usage" }; },
      memoryHistoricalReplayCleanupPreview: (args: JsonObject) => ({ owner: "memory", replay_run_id: args.replay_run_id, manifest_digest: "m", items: [] }),
      memoryHistoricalReplayCleanupApply: () => ({ status: "cleaned" }),
      knowledgeHistoricalReplayCleanupPreview: (args: JsonObject) => ({ owner: "knowledge", replay_run_id: args.replay_run_id, manifest_digest: "k", items: [] }),
      knowledgeHistoricalReplayCleanupApply: () => ({ status: "cleaned" }),
      experienceHistoricalReplayCleanupPreview: (args: JsonObject) => ({ owner: "experience", replay_run_id: args.replay_run_id, manifest_digest: "e", items: [] }),
      experienceHistoricalReplayCleanupApply: () => ({ status: "cleaned" }),
      notesHistoricalReplayCleanupPreview: (args: JsonObject) => ({ owner: "notes", replay_run_id: args.replay_run_id, manifest_digest: "n", items: [] }),
      notesHistoricalReplayCleanupApply: () => ({ status: "cleaned" }),
    }])) as unknown as CraftService["ownerServices"],
  } as unknown as CraftService;
  const owners = historicalReplayOwners(stub);
  const lineage = [{ origin: "historical_replay" as const, replay_run_id: "replay-1", session_id: "s", turn_id: "t", task_id: "task",
    project_scope_id: "project:a", source_ref: { kind: "codex_session_task" as const, id: "task", digest: `sha256:${"a".repeat(64)}` },
    evidence_refs: [{ kind: "evidence" as const, id: "evidence-1", version: 1 }] }];
  const task = { project_scope_id: "project:a" };
  const excerpt = { task_goal: "以后在本项目中请使用可复现的小范围验证。" };
  const outcomes = owners.map(owner => owner.capture({ task, excerpt, source_lineage: lineage }));
  assert.deepEqual(calls.map(call => call.owner), ["memory", "knowledge", "experience", "notes"]);
  assert.equal((calls[0]?.args.source_lineage as JsonObject[])[0]?.origin, "historical_replay");
  assert.equal(calls[0]?.args.content, "以后在本项目中请使用可复现的小范围验证。");
  assert.equal(calls[1]?.args.evidence_ids instanceof Array, true);
  assert.equal(calls[2]?.args.blocked_reason, "insufficient_independent_live_evidence");
  assert.equal(calls[3]?.args.note_id, undefined, "historical paths cannot manufacture a Notes object");
  assert.equal(JSON.stringify(outcomes).includes("secret"), false);
  assert.equal(outcomes[2]?.status, "awaiting_evidence");
  assert.equal(outcomes[3]?.status, "skipped");
  const cleanupPreview = owners.map(owner => owner.cleanupPreview("replay-1"));
  const cleanupApply = owners.map(owner => owner.cleanupApply("replay-1", String(cleanupPreview[0]?.manifest_digest)));
  assert.equal(cleanupApply.every(item => item.status === "cleaned"), true);
});

test("owner routing fails when a required independent owner is unavailable", () => {
  const service = { ownerServices: new Map() } as unknown as CraftService;
  const memory = historicalReplayOwners(service)[0]!;
  assert.throws(() => memory.capture({ task: {}, excerpt: { task_goal: "" }, source_lineage: [] }), /owner memory is unavailable/u);
});

test("historical replay evidence lookup requires one consistent persisted version", () => {
  const source = (version: number | null) => ({ store: { find: (_kind: string, id: string) => version === null ? null : { id, version } } });
  const matching = new Map(["memory", "knowledge"].map(name => [name, source(2)]));
  const resolver = replayEvidenceResolver({ store: source(2).store, ownerServices: matching } as unknown as CraftService);
  assert.deepEqual(resolver("evidence-1"), { id: "evidence-1", version: 2 });
  const absent = replayEvidenceResolver({ store: source(null).store, ownerServices: new Map(["memory", "knowledge"].map(name => [name, source(null)])) } as unknown as CraftService);
  assert.equal(absent("evidence-1"), null);
  const conflicting = replayEvidenceResolver({ store: source(2).store, ownerServices: new Map(["memory", "knowledge"].map((name, index) => [name, source(index ? 3 : 2)])) } as unknown as CraftService);
  assert.equal(conflicting("evidence-1"), null);
});

test("historical archive adapter fixes partition and requests only one exact task excerpt", async () => {
  const calls: JsonObject[] = [];
  const archive = createHistoricalReplayArchive(async partition => { calls.push({ operation: "list", partition }); return { tasks: [] }; },
    async (taskId, options) => { calls.push({ operation: "read", task_id: taskId, expected_partition: options.expected_partition }); return { status: "ineligible" }; });
  await archive.listTasks();
  await archive.readExcerpt("exact-task");
  assert.deepEqual(calls, [{ operation: "list", partition: "candidate_generation" },
    { operation: "read", task_id: "exact-task", expected_partition: "candidate_generation" }]);
});

test("composed replay projects exact source Evidence into each owner without copying its claim", () => {
  const sourceEvidence: JsonObject = { id: "source-evidence", version: 3, source_type: "host_completion_signal", claim: "private source claim",
    confidence: "bounded", record_origin: null, artifact_id: null, locator: "private locator", metadata: { provenance: "host_completion_signal" } };
  const stores = new Map<string, Map<string, JsonObject>>();
  const captures: Array<{ owner: string; lineage: JsonObject[] }> = [];
  const ownerServices = new Map<string, CraftService>();
  for (const owner of ["memory", "knowledge", "experience", "notes"]) {
    const records = new Map<string, JsonObject>(); stores.set(owner, records);
    const store = {
      find: (kind: string, id: string) => kind === "evidence" ? records.get(id) ?? null : null,
      transaction: <T>(operation: () => T): T => operation(),
    };
    const target = {
      store,
      evidenceRecord: (args: JsonObject) => {
        const record = { ...args, id: String(args.evidence_id), version: 1 };
        records.set(String(record.id), record);
        return record;
      },
      memoryCaptureHistoricalReplayCandidate: (args: JsonObject) => { captures.push({ owner, lineage: args.source_lineage as JsonObject[] }); return { candidate: { id: "memory-candidate" } }; },
      knowledgeCaptureHistoricalReplayCandidate: (args: JsonObject) => { captures.push({ owner, lineage: args.source_lineage as JsonObject[] }); return { candidate: { id: "knowledge-candidate" } }; },
      experienceCaptureHistoricalReplayCandidate: (args: JsonObject) => { captures.push({ owner, lineage: args.source_lineage as JsonObject[] }); return { status: "awaiting_evidence" }; },
      notesCaptureHistoricalReplayCandidate: (args: JsonObject) => { captures.push({ owner, lineage: args.source_lineage as JsonObject[] }); return { status: "skipped" }; },
      memoryHistoricalReplayCleanupPreview: () => ({}), memoryHistoricalReplayCleanupApply: () => ({}),
      knowledgeHistoricalReplayCleanupPreview: () => ({}), knowledgeHistoricalReplayCleanupApply: () => ({}),
      experienceHistoricalReplayCleanupPreview: () => ({}), experienceHistoricalReplayCleanupApply: () => ({}),
      notesHistoricalReplayCleanupPreview: () => ({}), notesHistoricalReplayCleanupApply: () => ({}),
    } as unknown as CraftService;
    ownerServices.set(owner, target);
  }
  stores.get("experience")!.set("source-evidence", sourceEvidence);
  const contextEvidence = new Map<string, JsonObject>();
  const contextStore = { find: (_kind: string, id: string) => contextEvidence.get(id) ?? null };
  const service = { capabilityOwned: true, storageOwner: "context", store: contextStore, ownerServices } as unknown as CraftService;
  const owners = historicalReplayOwners(service);
  const lineage = [{ origin: "historical_replay" as const, replay_run_id: "projection-run", session_id: "s", turn_id: "t", task_id: "task",
    project_scope_id: "project:a", source_ref: { kind: "codex_session_task" as const, id: "task", digest: `sha256:${"a".repeat(64)}` },
    evidence_refs: [{ kind: "evidence" as const, id: "source-evidence", version: 3 }, { kind: "evidence" as const, id: "source-evidence-2", version: 2 }] }];
  contextEvidence.set("source-evidence-2", { id: "source-evidence-2", version: 2, source_type: "host_completion_signal",
    claim: "another private claim", confidence: "bounded", artifact_id: "artifact-2", locator: null, metadata: {} });
  const input = { task: { project_scope_id: "project:a" }, excerpt: { task_goal: "必须遵循可复现验证。" }, source_lineage: lineage };
  owners.forEach(owner => owner.capture(input));
  assert.deepEqual(captures.map(item => item.owner), ["memory", "knowledge", "experience", "notes"]);
  for (const capture of captures) {
    const references = capture.lineage[0]!.evidence_refs as JsonObject[];
    assert.equal(references.length, 2);
    for (const reference of references) {
      const projection = stores.get(capture.owner)!.get(String(reference.id))!;
      assert.equal(reference.version, 1);
      assert.equal(projection.source_type, "historical_replay_projection");
      assert.equal(projection.claim, "Historical replay Evidence reference projection.");
      const metadata = projection.metadata as JsonObject;
      assert.equal(metadata.source_evidence_version, metadata.source_evidence_id === "source-evidence-2" ? 2 : 3);
      assert.equal(metadata.source_owner, metadata.source_evidence_id === "source-evidence-2" ? "context" : "experience");
      assert.equal((projection.metadata as JsonObject).projection_status, "active");
      assert.doesNotMatch(JSON.stringify(projection), /private source claim|private locator|another private claim/u);
    }
  }
  assert.equal(stores.get("memory")!.size, 2);
  owners.forEach(owner => owner.capture(input));
  assert.equal(stores.get("memory")!.size, 2, "projection retry reuses the exact active reference");
  const serviceWithDefaultSourceOwner = { capabilityOwned: true, store: contextStore, ownerServices } as unknown as CraftService;
  historicalReplayOwners(serviceWithDefaultSourceOwner)[0]!.capture(input);
  assert.deepEqual(sourceEvidence, { id: "source-evidence", version: 3, source_type: "host_completion_signal", claim: "private source claim",
    confidence: "bounded", record_origin: null, artifact_id: null, locator: "private locator", metadata: { provenance: "host_completion_signal" } });

  const memory = owners[0]!;
  assert.throws(() => memory.capture({ ...input, source_lineage: [{ ...lineage[0]!, evidence_refs: [{ kind: "evidence", id: "missing", version: 1 }] }] }), /missing, changed/u);
  contextEvidence.set("asserted", { id: "asserted", version: 1, source_type: "host_completion_signal", claim: "asserted", confidence: "bounded", record_origin: "caller_asserted" });
  assert.throws(() => memory.capture({ ...input, source_lineage: [{ ...lineage[0]!, evidence_refs: [{ kind: "evidence", id: "asserted", version: 1 }] }] }), /caller asserted/u);
  stores.get("experience")!.set("conflicting", { id: "conflicting", version: 1, source_type: "host_completion_signal", claim: "one", confidence: "bounded" });
  stores.get("knowledge")!.set("conflicting", { id: "conflicting", version: 2, source_type: "host_completion_signal", claim: "two", confidence: "bounded" });
  assert.throws(() => memory.capture({ ...input, source_lineage: [{ ...lineage[0]!, evidence_refs: [{ kind: "evidence", id: "conflicting", version: 1 }] }] }), /conflicting/u);
  const collisionId = `evidence_historical_replay_projection_${stableDigest({ replay_run_id: "collision-run", source_evidence_id: "source-evidence" }).slice(-32)}`;
  stores.get("memory")!.set(collisionId, { id: collisionId, version: 1, source_type: "evidence", claim: "unrelated" });
  assert.throws(() => memory.capture({ ...input, source_lineage: [{ ...lineage[0]!, replay_run_id: "collision-run", evidence_refs: [{ kind: "evidence", id: "source-evidence", version: 3 }] }] }), /projection identity conflicts/u);
});

test("owner routing handles every durable statement kind and bounds malformed owner results", () => {
  const memoryContents: string[] = [];
  const knowledgeContents: string[] = [];
  const ownerServices = new Map<string, JsonObject>([
    ["memory", {
      memoryCaptureHistoricalReplayCandidate: (args: JsonObject) => {
        memoryContents.push(String(args.content));
        return memoryContents.length === 1
          ? { candidate: [], id: "fallback-id", auto_committed: true }
          : { candidate: null, id: 17, auto_committed: false };
      },
    }],
    ["knowledge", {
      knowledgeCaptureHistoricalReplayCandidate: (args: JsonObject) => {
        knowledgeContents.push(String(args.content));
        return { candidate: { id: "knowledge-rule" } };
      },
    }],
    ["experience", {}],
    ["notes", {}],
  ]);
  const service = { ownerServices } as unknown as CraftService;
  const owners = historicalReplayOwners(service);
  const memory = owners.find(owner => owner.owner === "memory")!;
  const knowledge = owners.find(owner => owner.owner === "knowledge")!;
  const lineage = [{ origin: "historical_replay" as const, replay_run_id: "replay-1", session_id: "s", turn_id: "t", task_id: "task",
    project_scope_id: "project:a", source_ref: { kind: "codex_session_task" as const, id: "task", digest: `sha256:${"a".repeat(64)}` },
    evidence_refs: [{ kind: "evidence" as const, id: "evidence-1", version: 1 }] }];
  const result = memory.capture({ task: { project_scope_id: "project:a" },
    excerpt: { task_goal: "我偏好使用稳定工具。 本项目使用 TypeScript。必须保留可复现验证。" }, source_lineage: lineage });
  assert.deepEqual(memoryContents, ["我偏好使用稳定工具。", "本项目使用 TypeScript。", "必须保留可复现验证。"]);
  assert.deepEqual(result.candidate_ids, ["fallback-id"]);
  assert.equal(result.candidate_count, 1);
  assert.equal(result.auto_committed, true);

  const noGoal = memory.capture({ task: { project_scope_id: "project:a" }, excerpt: {}, source_lineage: lineage });
  assert.deepEqual(noGoal, { status: "skipped", candidate_count: 0, candidate_ids: [], auto_committed: false, reason: "no_durable_statement" });
  const noKnowledgeRule = knowledge.capture({ task: { project_scope_id: "project:a" },
    excerpt: { task_goal: "我偏好使用稳定工具。本项目使用 TypeScript。" }, source_lineage: lineage });
  assert.deepEqual(noKnowledgeRule.candidate_ids, []);
  const noKnowledgeGoal = knowledge.capture({ task: { project_scope_id: "project:a" }, excerpt: {}, source_lineage: lineage });
  assert.deepEqual(noKnowledgeGoal.candidate_ids, []);
  assert.deepEqual(knowledgeContents, []);
  const knowledgeRule = knowledge.capture({ task: { project_scope_id: "project:a" },
    excerpt: { task_goal: "必须保留可复现验证。" }, source_lineage: lineage });
  assert.deepEqual(knowledgeRule.candidate_ids, ["knowledge-rule"]);
  assert.deepEqual(knowledgeContents, ["必须保留可复现验证。"]);
});

test("CraftService replay facade delegates capture, cleanup, and each owner-specific API", async () => {
  const calls: string[] = [];
  const rows = new Map<string, JsonObject>();
  const store = {
    find: (_kind: string, id: string) => rows.get(id) ?? null,
    create: (kind: string, id: string, record: JsonObject) => { rows.set(id, { ...record, id, kind, version: 1 }); return rows.get(id)!; },
    save: (kind: string, id: string, record: JsonObject) => { rows.set(id, { ...record, id, kind, version: Number(record.version ?? 1) + 1 }); return rows.get(id)!; },
  };
  const ownerServices = new Map<string, CraftService>();
  for (const owner of ["memory", "knowledge", "experience", "notes"]) {
    ownerServices.set(owner, {
      store: { find: () => null },
      memoryCaptureHistoricalReplayCandidate: (args: JsonObject) => { calls.push(`capture:${owner}`); return { candidate: { id: owner } }; },
      knowledgeCaptureHistoricalReplayCandidate: (args: JsonObject) => { calls.push(`capture:${owner}`); return { candidate: { id: owner } }; },
      experienceCaptureHistoricalReplayCandidate: (args: JsonObject) => { calls.push(`capture:${owner}`); return { candidate: { id: owner } }; },
      notesCaptureHistoricalReplayCandidate: (args: JsonObject) => { calls.push(`capture:${owner}`); return { candidate: { id: owner } }; },
      memoryHistoricalReplayCleanupPreview: (args: JsonObject) => ({ owner, replay_run_id: args.replay_run_id, manifest_digest: `digest-${owner}`, items: [] }),
      knowledgeHistoricalReplayCleanupPreview: (args: JsonObject) => ({ owner, replay_run_id: args.replay_run_id, manifest_digest: `digest-${owner}`, items: [] }),
      experienceHistoricalReplayCleanupPreview: (args: JsonObject) => ({ owner, replay_run_id: args.replay_run_id, manifest_digest: `digest-${owner}`, items: [] }),
      notesHistoricalReplayCleanupPreview: (args: JsonObject) => ({ owner, replay_run_id: args.replay_run_id, manifest_digest: `digest-${owner}`, items: [] }),
      memoryHistoricalReplayCleanupApply: () => { calls.push(`cleanup:${owner}`); return { status: "cleaned" }; },
      knowledgeHistoricalReplayCleanupApply: () => { calls.push(`cleanup:${owner}`); return { status: "cleaned" }; },
      experienceHistoricalReplayCleanupApply: () => { calls.push(`cleanup:${owner}`); return { status: "cleaned" }; },
      notesHistoricalReplayCleanupApply: () => { calls.push(`cleanup:${owner}`); return { status: "cleaned" }; },
    } as unknown as CraftService);
  }
  const fake: CraftService = {
    store, ownerServices,
    cognitiveWrites: { captureHistoricalReplayCandidate: (args: JsonObject) => { calls.push("memory-wrapper"); return args; } },
    craftNotes: { captureHistoricalReplayCandidate: (args: JsonObject) => { calls.push("notes-wrapper"); return args; },
      historicalReplayCleanupPreview: () => ({}), historicalReplayCleanupApply: () => ({}) },
    workflowEvolution: { captureHistoricalReplayCandidate: (args: JsonObject) => { calls.push("experience-wrapper"); return args; },
      historicalReplayCleanupPreview: () => ({}), historicalReplayCleanupApply: () => ({}) },
    knowledgeClaims: { captureLiveHookCandidate: (args: JsonObject) => { calls.push("knowledge-live-wrapper"); return args; },
      captureHistoricalReplayCandidate: (args: JsonObject) => { calls.push("knowledge-wrapper"); return args; },
      historicalReplayCleanupPreview: () => ({}), historicalReplayCleanupApply: () => ({}) },
  } as unknown as CraftService;
  const originalList = historicalReplayArchive.listTasks;
  const originalRead = historicalReplayArchive.readExcerpt;
  historicalReplayArchive.listTasks = async () => ({ tasks: [] });
  historicalReplayArchive.readExcerpt = async () => ({ status: "ineligible" });
  try {
    assert.equal(CraftService.prototype.memoryCaptureHistoricalReplayCandidate.call(fake, { id: "m" }).id, "m");
    assert.equal(CraftService.prototype.notesCaptureHistoricalReplayCandidate.call(fake, { id: "n" }).id, "n");
    assert.equal(CraftService.prototype.experienceCaptureHistoricalReplayCandidate.call(fake, { id: "x" }).id, "x");
    assert.equal(CraftService.prototype.knowledgeCaptureLiveHookCandidate.call(fake, { id: "kl" }).id, "kl");
    assert.equal(CraftService.prototype.knowledgeCaptureHistoricalReplayCandidate.call(fake, { id: "kh" }).id, "kh");
    const capture = await CraftService.prototype.historicalReplayCapture.call(fake, { replay_run_id: "service-run-0001" });
    assert.equal(capture.status, "completed");
    const generatedRun = await CraftService.prototype.historicalReplayCapture.call(fake);
    assert.match(String(generatedRun.replay_run_id), /^[0-9a-f-]{36}$/u);
    assert.equal(generatedRun.status, "completed");
    const preview = CraftService.prototype.historicalReplayCleanupPreview.call(fake, { replay_run_id: "service-run-0001" });
    const result = CraftService.prototype.historicalReplayCleanupApply.call(fake, { replay_run_id: "service-run-0001", expected_manifest_digest: preview.manifest_digest });
    assert.equal(result.status, "cleaned");
    assert.deepEqual(calls, ["memory-wrapper", "notes-wrapper", "experience-wrapper", "knowledge-live-wrapper", "knowledge-wrapper",
      "cleanup:experience", "cleanup:knowledge", "cleanup:memory", "cleanup:notes"]);
  } finally {
    historicalReplayArchive.listTasks = originalList;
    historicalReplayArchive.readExcerpt = originalRead;
  }
});
