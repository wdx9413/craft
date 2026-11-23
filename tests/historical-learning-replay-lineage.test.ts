import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { applyHistoricalReplayCleanup, captureHistoricalReplayBatch, createHistoricalSourceLineage,
  previewHistoricalReplayCleanup, type HistoricalReplayDependencies, type HistoricalReplayOwner } from "../core/historical-learning-replay.ts";

const sessions = [
  "01a20640-e1a2-78f3-8740-e5354135c5b8",
  "01a20646-b18b-7ad1-8a76-6285be98231a",
  "01a20752-2594-7902-b606-7d8427765f63",
] as const;
const task = { task_id: "task-1", session_id: sessions[0], turn_id: "turn-1", project_scope_id: "project-1",
  dataset_partition: "candidate_generation", source_ref: "sha256:" + "a".repeat(64) };
const excerpt = { status: "ready", task_id: task.task_id, session_id: task.session_id, turn_id: task.turn_id,
  project_scope_id: task.project_scope_id, dataset_partition: task.dataset_partition, source_ref: task.source_ref,
  evidence_ids: ["evidence-1", "evidence-2"] };

test("historical replay lineage binds the exact approved task, source digest, scope, and Evidence versions", () => {
  const lineage = createHistoricalSourceLineage("replay-1", task, excerpt, id => ({ id, version: id === "evidence-1" ? 2 : 1 }));
  assert.deepEqual(lineage, [{ origin: "historical_replay", replay_run_id: "replay-1", session_id: task.session_id,
    turn_id: task.turn_id, task_id: task.task_id, project_scope_id: task.project_scope_id,
    source_ref: { kind: "codex_session_task", id: task.task_id, digest: task.source_ref },
    evidence_refs: [{ kind: "evidence", id: "evidence-1", version: 2 }, { kind: "evidence", id: "evidence-2", version: 1 }] }]);
});

test("historical replay lineage rejects unapproved sessions, non-candidate partitions, and changed task identity", () => {
  assert.throws(() => createHistoricalSourceLineage("replay-1", { ...task, session_id: "other-session" }, excerpt, () => ({ id: "evidence-1", version: 1 })), /not approved/u);
  assert.throws(() => createHistoricalSourceLineage("replay-1", { ...task, dataset_partition: "held_out" }, excerpt, () => ({ id: "evidence-1", version: 1 })), /candidate_generation/u);
  assert.throws(() => createHistoricalSourceLineage("replay-1", task, { ...excerpt, task_id: "other-task" }, () => ({ id: "evidence-1", version: 1 })), /identity mismatch/u);
});

test("historical replay lineage refuses missing or malformed Evidence and source references", () => {
  assert.throws(() => createHistoricalSourceLineage("", task, excerpt, () => null), /replay_run_id/u);
  assert.throws(() => createHistoricalSourceLineage("replay-1", task, { ...excerpt, evidence_ids: [] }, () => null), /Evidence/u);
  assert.throws(() => createHistoricalSourceLineage("replay-1", task, { ...excerpt, evidence_ids: ["evidence-1", "evidence-1"] }, id => ({ id, version: 1 })), /unique/u);
  assert.throws(() => createHistoricalSourceLineage("replay-1", task, excerpt, () => null), /Evidence/u);
  assert.throws(() => createHistoricalSourceLineage("replay-1", task, excerpt, id => ({ id, version: 0 })), /version/u);
  assert.throws(() => createHistoricalSourceLineage("replay-1", task, { ...excerpt, source_ref: "invalid" }, id => ({ id, version: 1 })), /source_ref/u);
  assert.throws(() => createHistoricalSourceLineage("replay-1", { ...task, project_scope_id: null }, excerpt, id => ({ id, version: 1 })), /scope/u);
  assert.throws(() => createHistoricalSourceLineage("replay-1", task, { ...excerpt, status: "ineligible" }, id => ({ id, version: 1 })), /ready/u);
});

class MemoryStore {
  readonly rows = new Map<string, Record<string, unknown>>();
  find(kind: string, id: string): Record<string, unknown> | null { return this.rows.get(`${kind}:${id}`) ?? null; }
  create(kind: string, id: string, value: Record<string, unknown>): Record<string, unknown> {
    const record = { ...value, id, version: 1 };
    this.rows.set(`${kind}:${id}`, record);
    return record;
  }
  save(kind: string, id: string, value: Record<string, unknown>): Record<string, unknown> {
    const prior = this.find(kind, id);
    const record = { ...value, id, version: Number(prior?.version ?? 0) + 1 };
    this.rows.set(`${kind}:${id}`, record);
    return record;
  }
}

function owner(ownerName: HistoricalReplayOwner["owner"], options: { capture?: () => JsonObject; preview?: (runId: string) => JsonObject;
  apply?: (runId: string, digest: string) => JsonObject } = {}): HistoricalReplayOwner {
  return { owner: ownerName, capture: options.capture ?? (() => ({ status: "skipped", content: "must not persist" })),
    cleanupPreview: options.preview ?? (runId => ({ owner: ownerName, replay_run_id: runId, manifest_digest: `digest-${ownerName}`, items: [] })),
    cleanupApply: options.apply ?? (() => ({ status: "cleaned" })) };
}

function deps(overrides: Partial<HistoricalReplayDependencies> = {}): HistoricalReplayDependencies {
  return { store: new MemoryStore() as unknown as HistoricalReplayDependencies["store"],
    listTasks: async () => ({ tasks: [task, { ...task, task_id: "task-2", session_id: sessions[1] },
      { ...task, task_id: "held", dataset_partition: "held_out" }, { ...task, task_id: "foreign", session_id: "foreign" }] }),
    readExcerpt: async id => ({ ...excerpt, task_id: id, session_id: id === "task-2" ? sessions[1] : sessions[0] }),
    resolveEvidence: id => ({ id, version: 1 }), owners: [owner("memory"), owner("knowledge"), owner("experience"), owner("notes")], ...overrides };
}

test("batch replay reads only allowlisted candidate tasks, stores content-free receipts, and retries idempotently", async () => {
  const store = new MemoryStore(); let reads = 0; let captures = 0;
  const input = deps({ store: store as unknown as HistoricalReplayDependencies["store"],
    readExcerpt: async id => { reads += 1; return { ...excerpt, task_id: id, session_id: id === "task-2" ? sessions[1] : sessions[0] }; },
    owners: [owner("memory", { capture: () => { captures += 1; return { candidate: { id: "candidate", version: 2, content: "private" }, content: "private" }; } })] });
  const first = await captureHistoricalReplayBatch("replay-run-0001", input);
  assert.equal(reads, 2);
  assert.equal(captures, 2);
  assert.equal((first.task_receipts as JsonObject[]).length, 2);
  assert.equal(JSON.stringify(first).includes("private"), false);
  assert.equal((await captureHistoricalReplayBatch("replay-run-0001", input)).idempotent, true);
  await assert.rejects(captureHistoricalReplayBatch("bad", input), /bounded identifier/u);
});

test("batch replay safely records unavailable lineage and owner failures without transcript text", async () => {
  const store = new MemoryStore();
  const input = deps({ store: store as unknown as HistoricalReplayDependencies["store"],
    readExcerpt: async id => id === "task-1" ? ({ ...excerpt, evidence_ids: [] }) : ({ ...excerpt, task_id: id, session_id: sessions[1] }),
    owners: [owner("memory", { capture: () => { throw new Error("private transcript"); } })] });
  const result = await captureHistoricalReplayBatch("replay-run-0002", input);
  const receipts = result.task_receipts as JsonObject[];
  assert.equal(receipts[0]?.status, "skipped");
  assert.equal(receipts[0]?.reason, "source_lineage_unavailable");
  assert.equal((receipts[1]?.owner_results as JsonObject[])[0]?.status, "failed");
  assert.equal(JSON.stringify(result).includes("private transcript"), false);
});

test("batch replay rejects conflicting run identity and duplicate owner registration", async () => {
  const store = new MemoryStore();
  const input = deps({ store: store as unknown as HistoricalReplayDependencies["store"], owners: [owner("memory"), owner("memory")] });
  await assert.rejects(captureHistoricalReplayBatch("replay-run-0003", input), /owners must be unique/u);
  const clean = deps({ store: store as unknown as HistoricalReplayDependencies["store"], listTasks: async () => ({ tasks: [] }), owners: [] });
  await captureHistoricalReplayBatch("replay-run-0003", clean);
  const conflict = deps({ store: store as unknown as HistoricalReplayDependencies["store"], listTasks: async () => ({ tasks: [task] }), owners: [] });
  await assert.rejects(captureHistoricalReplayBatch("replay-run-0003", conflict), /identity conflicts/u);
  const noTaskList = deps({ store: store as unknown as HistoricalReplayDependencies["store"], listTasks: async () => ({ tasks: "not-an-array" }), owners: [] });
  const empty = await captureHistoricalReplayBatch("replay-run-0021", noTaskList);
  assert.deepEqual(empty.task_receipts, []);
  const emptyRunKey = "historical_replay_replay-run-0021", emptyRecord = store.find("historical_learning_replay_run", emptyRunKey)!;
  const legacyCompleted: JsonObject = { ...emptyRecord };
  delete legacyCompleted.task_receipts;
  store.rows.set(`historical_learning_replay_run:${emptyRunKey}`, legacyCompleted);
  assert.deepEqual((await captureHistoricalReplayBatch("replay-run-0021", noTaskList)).task_receipts, []);
});

test("batch replay resumes incomplete receipts, skips already captured tasks, and filters malformed archive rows", async () => {
  const store = new MemoryStore(); let reads = 0;
  const input = deps({ store: store as unknown as HistoricalReplayDependencies["store"],
    listTasks: async () => ({ tasks: [null, "bad", [], task, { ...task, task_id: "task-2", session_id: sessions[1] }] }),
    readExcerpt: async id => { reads += 1; return { ...excerpt, task_id: id, session_id: id === "task-2" ? sessions[1] : sessions[0] }; } });
  await captureHistoricalReplayBatch("replay-run-0005", input);
  const runKey = "historical_replay_replay-run-0005";
  const record = store.find("historical_learning_replay_run", runKey)!;
  const resumable: JsonObject = { ...record, status: "running" };
  delete resumable.task_receipts;
  store.rows.set(`historical_learning_replay_run:${runKey}`, resumable);
  await captureHistoricalReplayBatch("replay-run-0005", input);
  assert.equal(reads, 4, "the missing progress array causes only selected tasks to be safely replayed");
  const current = store.find("historical_learning_replay_run", runKey)!;
  store.rows.set(`historical_learning_replay_run:${runKey}`, { ...current, status: "running", task_receipts: [{ task_id: "task-1" }] });
  reads = 0;
  await captureHistoricalReplayBatch("replay-run-0005", input);
  assert.equal(reads, 1, "a durable per-task receipt suppresses duplicate capture on recovery");
});

test("batch replay records safe skip reasons and owner errors without retaining exception messages", async () => {
  const store = new MemoryStore();
  const oneTask = (taskValue: JsonObject) => deps({ store: store as unknown as HistoricalReplayDependencies["store"], listTasks: async () => ({ tasks: [taskValue] }), owners: [] });
  let result = await captureHistoricalReplayBatch("replay-run-0006", { ...oneTask(task), readExcerpt: async () => ({ ...excerpt, status: "ineligible" }) });
  assert.equal((result.task_receipts as JsonObject[])[0]?.reason, "task_excerpt_unavailable");
  result = await captureHistoricalReplayBatch("replay-run-0007", { ...oneTask(task), readExcerpt: async () => ({ ...excerpt, dataset_partition: "held_out" }) });
  assert.equal((result.task_receipts as JsonObject[])[0]?.reason, "source_not_authorized");
  result = await captureHistoricalReplayBatch("replay-run-0008", { ...oneTask({ ...task, source_ref: 12 }), resolveEvidence: () => { throw "private error"; } });
  assert.equal((result.task_receipts as JsonObject[])[0]?.source_digest, null);
  assert.equal((result.task_receipts as JsonObject[])[0]?.reason, "source_lineage_unavailable");
  const unknownOwner = owner("memory", { capture: () => { throw "private owner error"; } });
  result = await captureHistoricalReplayBatch("replay-run-0009", { ...oneTask(task), owners: [unknownOwner] });
  assert.equal((((result.task_receipts as JsonObject[])[0]?.owner_results as JsonObject[])[0]?.error_type), "unknown");
  assert.equal(JSON.stringify(result).includes("private owner error"), false);
});

test("owner results retain only bounded candidate identifiers and scalar diagnostics", async () => {
  const store = new MemoryStore();
  const input = deps({ store: store as unknown as HistoricalReplayDependencies["store"],
    listTasks: async () => ({ tasks: [task] }), readExcerpt: async () => excerpt,
    owners: [owner("memory", { capture: () => ({ status: { unsafe: true }, candidate: [], candidate_ids: ["candidate-1", 9], body: "private" }) })] });
  const result = await captureHistoricalReplayBatch("replay-run-0010", input);
  const summary = ((result.task_receipts as JsonObject[])[0]?.owner_results as JsonObject[])[0]!;
  assert.deepEqual(summary.candidate_ids, ["candidate-1"]);
  assert.equal(summary.candidate_id, undefined);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("cleanup previews are content-free and apply resumes per owner then returns idempotently", () => {
  const store = new MemoryStore(); let knowledgeCalls = 0, memoryCleaned = false;
  const owners = [owner("memory", { preview: runId => ({ owner: "memory", replay_run_id: runId, manifest_digest: "m-digest", items: memoryCleaned ? [] : [
    { kind: "memory_candidate", id: "m1", version: 1, lineage_digest: "ld", action: "revoke" }] }),
    apply: () => { memoryCleaned = true; return { status: "cleaned" }; } }),
  owner("knowledge", { apply: () => { knowledgeCalls += 1; return { status: "cleaned" }; } })];
  const preview = previewHistoricalReplayCleanup("replay-run-0004", owners);
  assert.equal(preview.item_count, 1);
  assert.equal(JSON.stringify(preview).includes("must not persist"), false);
  assert.throws(() => previewHistoricalReplayCleanup("replay-run-0004", [owner("memory", { preview: id => ({ owner: "memory", replay_run_id: id,
    manifest_digest: "bad", items: [{ kind: "memory_candidate", id: "m1", version: 1, lineage_digest: "x", action: "revoke", content: "leak" }] }) })]), /malformed or contains content/u);
  assert.throws(() => applyHistoricalReplayCleanup("replay-run-0004", "wrong", { store: store as unknown as HistoricalReplayDependencies["store"], owners }), /manifest changed/u);
  const applied = applyHistoricalReplayCleanup("replay-run-0004", String(preview.manifest_digest), { store: store as unknown as HistoricalReplayDependencies["store"], owners });
  assert.equal(applied.status, "cleaned");
  assert.equal(knowledgeCalls, 1);
  assert.equal(applyHistoricalReplayCleanup("replay-run-0004", String(preview.manifest_digest), { store: store as unknown as HistoricalReplayDependencies["store"], owners }).idempotent, true);
});

test("cleanup preview rejects owner, shape, and item identity errors", () => {
  assert.throws(() => previewHistoricalReplayCleanup("replay-run-0011", [owner("memory", { preview: runId => ({ owner: "notes", replay_run_id: runId, manifest_digest: "x", items: [] }) })]), /invalid historical cleanup manifest/u);
  assert.throws(() => previewHistoricalReplayCleanup("replay-run-0012", [owner("memory", { preview: runId => ({ owner: "memory", replay_run_id: runId, manifest_digest: "x", items: null }) })]), /invalid historical cleanup manifest/u);
  assert.throws(() => previewHistoricalReplayCleanup("replay-run-0013", [owner("memory", { preview: runId => ({ owner: "memory", replay_run_id: runId, manifest_digest: "x", items: [null] }) })]), /cleanup item is invalid/u);
  assert.throws(() => previewHistoricalReplayCleanup("replay-run-0014", [owner("memory", { preview: runId => ({ owner: "memory", replay_run_id: runId, manifest_digest: "x", items: [{ kind: "memory_candidate", id: 4, version: 1, lineage_digest: "x", action: "revoke" }] }) })]), /malformed or contains content/u);
  assert.throws(() => previewHistoricalReplayCleanup("replay-run-0015", [owner("memory", { preview: runId => ({ owner: "memory", replay_run_id: runId, manifest_digest: "x", items: [{ kind: "memory_candidate", id: "m", version: 1, lineage_digest: "x", action: "delete" }] }) })]), /malformed or contains content/u);
  assert.throws(() => previewHistoricalReplayCleanup("replay-run-0016", [owner("memory"), owner("memory")]), /owners must be unique/u);
  assert.equal(previewHistoricalReplayCleanup("replay-run-0017", []).item_count, 0);
});

test("cleanup apply stops on missing owner or failed readback and can resume a partial saga", () => {
  const store = new MemoryStore();
  const manifestOwner = (name: HistoricalReplayOwner["owner"], digest: string, itemId: string) => owner(name, {
    preview: runId => ({ owner: name, replay_run_id: runId, manifest_digest: digest, items: [{ kind: `${name}_candidate`, id: itemId, version: 1, lineage_digest: "lineage", action: "revoke" }] }),
  });
  const all = [manifestOwner("memory", "memory-digest", "m"), manifestOwner("knowledge", "knowledge-digest", "k")];
  const preview = previewHistoricalReplayCleanup("replay-run-0018", all);
  store.create("historical_learning_cleanup_run", "historical_cleanup_replay-run-0018", { replay_run_id: "replay-run-0018",
    manifest_digest: preview.manifest_digest, owners: preview.owners, completed_owners: [], status: "applying" });
  assert.throws(() => applyHistoricalReplayCleanup("replay-run-0018", String(preview.manifest_digest), { store: store as unknown as HistoricalReplayDependencies["store"], owners: [] }), /unavailable/u);
  const readbackStore = new MemoryStore();
  const badReadback = owner("memory", { preview: runId => ({ owner: "memory", replay_run_id: runId, manifest_digest: "readback-digest", items: [{ kind: "memory_candidate", id: "m", version: 1, lineage_digest: "lineage", action: "revoke" }] }) });
  const badPreview = previewHistoricalReplayCleanup("replay-run-0020", [badReadback]);
  assert.throws(() => applyHistoricalReplayCleanup("replay-run-0020", String(badPreview.manifest_digest), { store: readbackStore as unknown as HistoricalReplayDependencies["store"], owners: [badReadback] }), /cleanup readback/u);
  const partialStore = new MemoryStore(); let firstApplied = false, secondApplied = false, failSecond = true;
  const owners = [
    owner("knowledge", { preview: runId => ({ owner: "knowledge", replay_run_id: runId, manifest_digest: "knowledge-digest", items: firstApplied ? [] : [{ kind: "knowledge_claim", id: "k", version: 1, lineage_digest: "lineage", action: "revoke" }] }),
      apply: () => { firstApplied = true; return { status: "cleaned" }; } }),
    owner("memory", { preview: runId => ({ owner: "memory", replay_run_id: runId, manifest_digest: "memory-digest", items: secondApplied ? [] : [{ kind: "memory_candidate", id: "m", version: 1, lineage_digest: "lineage", action: "revoke" }] }),
      apply: () => { if (!firstApplied) throw new Error("must not apply out of order"); if (failSecond) { failSecond = false; return { status: "failed" }; } secondApplied = true; return { status: "cleaned" }; } }),
  ];
  const partialPreview = previewHistoricalReplayCleanup("replay-run-0019", owners);
  const context = { store: partialStore as unknown as HistoricalReplayDependencies["store"], owners };
  assert.throws(() => applyHistoricalReplayCleanup("replay-run-0019", partialPreview.manifest_digest, context), /did not confirm/u);
  const resumed = applyHistoricalReplayCleanup("replay-run-0019", partialPreview.manifest_digest, context);
  assert.equal(resumed.status, "cleaned");
  assert.equal(secondApplied, true);
  assert.equal((partialStore.find("historical_learning_cleanup_run", "historical_cleanup_replay-run-0019")?.completed_owners as string[]).length, 2);
});

test("cleanup recovery handles stored malformed progress safely and rejects stale manifests", () => {
  const store = new MemoryStore();
  const ownerManifests = [owner("memory")];
  const preview = previewHistoricalReplayCleanup("replay-run-0022", ownerManifests);
  store.create("historical_learning_cleanup_run", "historical_cleanup_replay-run-0022", { replay_run_id: "replay-run-0022",
    manifest_digest: preview.manifest_digest, status: "completed" });
  const result = applyHistoricalReplayCleanup("replay-run-0022", preview.manifest_digest,
    { store: store as unknown as HistoricalReplayDependencies["store"], owners: ownerManifests });
  assert.equal(result.idempotent, true);
  assert.deepEqual(result.owners, []);
  assert.throws(() => applyHistoricalReplayCleanup("replay-run-0022", "different-digest",
    { store: store as unknown as HistoricalReplayDependencies["store"], owners: ownerManifests }), /different manifest digest/u);

  store.create("historical_learning_cleanup_run", "historical_cleanup_replay-run-0023", { replay_run_id: "replay-run-0023",
    manifest_digest: "saved-digest", status: "applying" });
  const resumed = applyHistoricalReplayCleanup("replay-run-0023", "saved-digest",
    { store: store as unknown as HistoricalReplayDependencies["store"], owners: [] });
  assert.equal(resumed.status, "cleaned");
  assert.deepEqual(resumed.owners, []);
});
