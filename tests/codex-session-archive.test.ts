import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexTaskGoalDigest } from "../core/codex-task-prose.ts";
import { codexSessionEvidenceBatch, codexSessionTaskBatch, commitCodexSessionEvidenceBatch, readCodexSessionChunk, readCodexSessionTaskExcerpt, reconcileCodexSessionTaskEvidence, runCodexSessionCollectionOnce } from "../core/codex-session-archive.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-session-archive-"));
  const sessions = join(root, "codex", "sessions");
  const project = join(root, "project");
  const state = join(root, "data", "runtime", "session-index.json");
  await mkdir(sessions, { recursive: true });
  await mkdir(project, { recursive: true });
  execFileSync("git", ["init", "--quiet", project]);
  const file = join(sessions, "2026", "10", "session-a.jsonl");
  await mkdir(join(sessions, "2026", "10"), { recursive: true });
  const record = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload });
  const event = (payload: Record<string, unknown>) => record("event_msg", payload);
  const response = (payload: Record<string, unknown>) => record("response_item", payload);
  const turn = (id: string, text: string, finalText = "private final output") => [
    event({ type: "task_started", turn_id: id, started_at: "2026-10-20T00:00:00.000Z" }),
    response({ type: "message", role: "user", content: [{ type: "input_text", text }] }),
    response({ type: "custom_tool_call", name: "terminal" }),
    response({ type: "custom_tool_call_output", output: "private raw output" }),
    response({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: finalText }] }),
    event({ type: "task_complete", turn_id: id, completed_at: "2026-10-20T00:01:00.000Z" }),
  ];
  const writeSession = async (lines: string[]) => {
    await writeFile(file, [record("session_meta", { session_id: "session-a", cwd: project }), ...lines].join("\n") + "\n");
  };
  return { root, sessions, project, state, file, record, event, response, turn, writeSession };
}

test("indexes completed turns incrementally without copying conversation text", async () => {
  const f = await fixture();
  try {
    const taskGoal = "# 整理依赖升级验证流程";
    await f.writeSession(f.turn("turn-a", taskGoal, "api_key=very-secret-value private final output"));
    const first = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state, now: "2026-10-20T01:00:00.000Z" });
    assert.equal(first.status, "completed");
    assert.equal(first.sessions_seen, 1);
    assert.equal(first.tasks_indexed, 1);
    assert.equal(first.tasks_completed, 1);
    assert.equal(first.tasks_verified, 0);
    assert.equal(first.raw_content_stored, false);

    const saved = await readFile(f.state, "utf8");
    assert.match(saved, /session-a/u);
    assert.match(saved, /turn-a/u);
    assert.doesNotMatch(saved, /very-secret-value|private raw output|private final output|api_key=/u);
    const task = Object.values(JSON.parse(saved).tasks as Record<string, { task_goal_digest?: string }>)[0]!;
    assert.equal(task.task_goal_digest, codexTaskGoalDigest(taskGoal));
    assert.equal(saved.includes("整理依赖升级验证流程"), false, "the task goal is stored only as a one-way digest");
    const second = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(second.sessions_processed, 0);
    assert.equal(second.bytes_processed, 0);
    assert.equal(second.tasks_indexed, 1);

    await appendFile(f.file, f.turn("turn-b", "second task").join("\n") + "\n");
    const third = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(third.tasks_indexed, 2);
    assert.equal(third.tasks_completed, 2);
    assert.equal(third.sessions_processed, 1);
    assert.equal(Number(third.tasks_candidate_generation) + Number(third.tasks_held_out), 2);
    const partitioned = Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, { dataset_partition: string; dataset_split_version: string }>);
    assert.equal(new Set(partitioned.map(task => task.dataset_partition)).size, 1);
    assert.equal(partitioned.every(task => task.dataset_split_version === "codex-session-split-v1"), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("backfills goal digests into an existing session index without restarting every poll", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("turn-a", "整理依赖升级验证流程"));
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    const legacy = JSON.parse(await readFile(f.state, "utf8"));
    const source = Object.values(legacy.sources as Record<string, Record<string, unknown>>)[0]!;
    delete source.task_goal_digest_version;
    for (const task of Object.values(legacy.tasks as Record<string, Record<string, unknown>>)) delete task.task_goal_digest;
    await writeFile(f.state, JSON.stringify(legacy));
    const backfill = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    const updated = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(backfill.sessions_processed, 1);
    assert.equal(Object.values(updated.tasks as Record<string, { task_goal_digest?: string }>)[0]?.task_goal_digest, codexTaskGoalDigest("整理依赖升级验证流程"));
    assert.equal(Object.values(updated.sources as Record<string, { task_goal_digest_version?: number }>)[0]?.task_goal_digest_version, 1);
    assert.equal((await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state })).sessions_processed, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("keeps a partial trailing record for the next incremental pass", async () => {
  const f = await fixture();
  try {
    const lines = f.turn("turn-a", "task text");
    await f.writeSession(lines.slice(0, 2));
    await appendFile(f.file, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"");
    const first = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(first.tasks_indexed, 0);
    const before = JSON.parse(await readFile(f.state, "utf8"));
    const source = Object.values(before.sources)[0] as { processed_bytes: number };
    assert.ok(source.processed_bytes < (await stat(f.file)).size);

    await appendFile(f.file, "turn-a\"}}\n");
    const second = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(second.tasks_indexed, 1);
    assert.equal(second.tasks_completed, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rebuilds a rewritten source and removes stale task records", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("turn-old", "old task"));
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    await f.writeSession(f.turn("turn-new", "new task"));
    await utimes(f.file, new Date(), new Date(Date.now() + 2_000));
    const result = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    const state = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(result.tasks_indexed, 1);
    const tasks = Object.values(state.tasks as Record<string, { turn_id: string }>);
    assert.equal(tasks.some(task => task.turn_id === "turn-old"), false);
    assert.equal(tasks.some(task => task.turn_id === "turn-new"), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("reports missing sources and skips symbolic links", async () => {
  const f = await fixture();
  try {
    const missing = await runCodexSessionCollectionOnce({ sessions_root: join(f.root, "missing"), state_file: f.state });
    assert.equal(missing.status, "source_unavailable");
    assert.equal(missing.sessions_seen, 0);
    await f.writeSession(f.turn("turn-a", "task"));
    const linked = join(f.sessions, "linked.jsonl");
    await symlink(f.file, linked);
    const result = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: join(f.root, "data", "runtime", "other.json") });
    assert.equal(result.sessions_seen, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects invalid bounds, state files, and session roots", async () => {
  const f = await fixture();
  try {
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state, max_files: 0 }), /max_files/u);
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state, max_bytes: 1 }), /max_bytes/u);
    await mkdir(join(f.root, "bad-state"), { recursive: true });
    const invalidState = join(f.root, "bad-state", "state.json");
    await writeFile(invalidState, "{}\n");
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: invalidState }), /state is invalid/u);
    await f.writeSession(f.turn("state-link", "task"));
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    const stateLink = join(f.root, "bad-state", "state-link.json");
    await symlink(f.state, stateLink);
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: stateLink }), /state file is invalid/u);
    const badRoot = join(f.root, "sessions-link");
    await symlink(f.sessions, badRoot);
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: badRoot, state_file: join(f.root, "data", "runtime", "link.json") }), /regular directory/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("counts malformed JSONL records without retaining their contents", async () => {
  const f = await fixture();
  try {
    await f.writeSession(["not-json", ...f.turn("turn-a", "ordinary task")]);
    const result = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(result.malformed_lines, 1);
    assert.equal(result.tasks_completed, 1);
    const saved = await readFile(f.state, "utf8");
    assert.doesNotMatch(saved, /not-json|ordinary task/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("uses CODEX_HOME when the session source is not explicitly supplied", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("turn-a", "task"));
    const result = await runCodexSessionCollectionOnce({ state_file: f.state }, { CODEX_HOME: join(f.root, "codex") } as NodeJS.ProcessEnv);
    assert.equal(result.sessions_seen, 1);
    assert.equal(result.tasks_completed, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("assigns every turn from a held-out session to the same versioned split", async () => {
  const f = await fixture();
  try {
    const content = [
      JSON.stringify({ type: "session_meta", payload: { session_id: "session-14", cwd: f.project } }),
      ...f.turn("held-out-turn", "held out task"),
    ].join("\n") + "\n";
    await writeFile(f.file, content);
    const first = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(first.tasks_held_out, 1);
    const second = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(second.tasks_held_out, 1);
    const task = Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, { dataset_partition: string }>)[0];
    assert.equal(task?.dataset_partition, "held_out");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("indexes aborted tasks, tolerates sparse records and resolves repeated project scopes", async () => {
  const f = await fixture();
  try {
    const records = [
      JSON.stringify({ type: "session_meta", payload: { id: "fallback-session", cwd: "" } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-context", cwd: f.project } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-context", cwd: f.project } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-aborted" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-aborted" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "without-input" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "without-input" } }),
      JSON.stringify({ type: "unknown", payload: null }),
      JSON.stringify({ type: "unknown", payload: [] }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer" } }),
      "",
    ];
    await writeFile(f.file, `${records.join("\r\n")}\r\n`);
    const result = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(result.tasks_aborted, 1);
    assert.equal(result.tasks_indexed, 1);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const task = Object.values(state.tasks as Record<string, { status: string; session_id: string }>)[0];
    assert.equal(task?.status, "aborted");
    assert.equal(task?.session_id, "fallback-session");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("reports bounded scans as partial and resumes remaining sessions", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("turn-a", "first task"));
    const secondFile = join(f.sessions, "2026", "10", "session-b.jsonl");
    await writeFile(secondFile, JSON.stringify({ type: "session_meta", payload: { session_id: "session-b" } }) + "\n");
    const sameTime = new Date("2026-10-20T00:00:00.000Z");
    await utimes(f.file, sameTime, sameTime);
    await utimes(secondFile, sameTime, sameTime);
    const first = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state, max_files: 1 });
    assert.equal(first.status, "partial");
    assert.equal(first.sessions_pending, 1);
    const second = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(second.status, "completed");
    assert.equal(second.sessions_pending, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("handles stale roots, unterminated records and records larger than one scan chunk", async () => {
  const f = await fixture();
  try {
    const rootFile = join(f.root, "not-a-directory");
    await writeFile(rootFile, "file");
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: join(rootFile, "sessions"), state_file: f.state }), /ENOTDIR/u);

    await writeFile(f.file, JSON.stringify({ type: "unknown", payload: {} }));
    const unterminated = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(unterminated.status, "partial");
    assert.equal(unterminated.sessions_pending, 1);

    await writeFile(f.file, `${JSON.stringify({ type: "unknown", payload: { padding: "x".repeat(2_000) } })}\n`);
    const chunked = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state, max_bytes: 1_024 });
    assert.equal(chunked.status, "completed");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects a JSONL record that exceeds the hard parser bound", async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, Buffer.alloc(64 * 1024 * 1024 + 1, 0x78));
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state, max_bytes: 128 * 1024 * 1024 }), /size limit/u);
    await appendFile(f.file, "\n");
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state, max_bytes: 128 * 1024 * 1024 }), /size limit/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("covers empty reads and default state placement from the supplied Craft data root", async () => {
  const f = await fixture();
  try {
    const emptyFile = join(f.root, "empty.jsonl");
    await writeFile(emptyFile, "");
    assert.deepEqual(await readCodexSessionChunk(emptyFile, 0, 10, 10), { bytes: Buffer.alloc(0), nextOffset: 0 });
    assert.deepEqual(await readCodexSessionChunk(emptyFile, 10, 10, 10), { bytes: Buffer.alloc(0), nextOffset: 10 });
    const dataRoot = join(f.root, "default-data");
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions }, { CRAFT_DATA_DIR: dataRoot } as NodeJS.ProcessEnv);
    const defaultState = join(dataRoot, "runtime", "codex-session-collection.json");
    assert.ok((await readFile(defaultState, "utf8")).includes("codex-session-collection.v1"));
    const emptyBatch = await codexSessionEvidenceBatch({ state_file: defaultState });
    assert.deepEqual(emptyBatch.session_ids, []);
    assert.equal(emptyBatch.next_evidence_cursor_session_id, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("stops at the byte budget when another source remains", async () => {
  const f = await fixture();
  try {
    const sessionsRoot = join(f.root, "limited-sessions");
    await mkdir(sessionsRoot);
    const first = join(sessionsRoot, "00.jsonl");
    const second = join(sessionsRoot, "99.jsonl");
    await writeFile(first, `${JSON.stringify({ type: "unknown", payload: { padding: "x".repeat(2_000) } })}\n`);
    await writeFile(second, `${JSON.stringify({ type: "unknown", payload: {} })}\n`);
    const firstTime = new Date("2026-10-20T00:00:00.000Z");
    await utimes(first, firstTime, firstTime);
    await utimes(second, new Date("2026-10-20T00:00:01.000Z"), new Date("2026-10-20T00:00:01.000Z"));
    const result = await runCodexSessionCollectionOnce({ sessions_root: sessionsRoot, state_file: f.state, max_bytes: 1_024 });
    assert.equal(result.status, "partial");
    assert.equal(result.sessions_processed, 1);
    assert.equal(result.sessions_pending, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("uses a new task context to restore missing session metadata and validates persisted state", async () => {
  const f = await fixture();
  try {
    const records = [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "before-meta" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }),
      JSON.stringify({ type: "turn_context", payload: {} }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "before-meta" } }),
      JSON.stringify({ type: "session_meta", payload: { session_id: "restored-session", cwd: f.project } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "before-meta" } }),
    ];
    await writeFile(f.file, `${records.join("\n")}\n`);
    const first = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(first.tasks_completed, 1);

    const noTimestampState = join(f.root, "state-no-timestamp.json");
    const validState = JSON.parse(await readFile(f.state, "utf8"));
    delete validState.updated_at;
    for (const task of Object.values(validState.tasks) as Record<string, unknown>[]) {
      delete task.dataset_partition;
      delete task.dataset_split_version;
    }
    await writeFile(noTimestampState, JSON.stringify(validState));
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: noTimestampState, now: "2026-10-20T01:00:00.000Z" });

    const invalidTaskState = join(f.root, "state-invalid-task.json");
    validState.tasks.bad = { task_id: "wrong-id", session_id: "s", turn_id: "t", status: "completed", source_path: "s", source_ref: "sha256:x", raw_content_stored: false };
    await writeFile(invalidTaskState, JSON.stringify(validState));
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: invalidTaskState }), /task index is invalid/u);
    delete validState.tasks.bad;
    const invalidSourceState = join(f.root, "state-invalid-source.json");
    const sourceKey = Object.keys(validState.sources)[0];
    validState.sources[sourceKey].task_ids = [1];
    await writeFile(invalidSourceState, JSON.stringify(validState));
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: invalidSourceState }), /source state is invalid/u);

    const invalidCursorState = join(f.root, "state-invalid-cursor.json");
    const cursorState = JSON.parse(await readFile(f.state, "utf8"));
    cursorState.evidence_cursor_session_id = "invalid\ncursor";
    await writeFile(invalidCursorState, JSON.stringify(cursorState));
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: invalidCursorState }), /evidence cursor is invalid/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("binds only exact content-free terminal evidence to an archived task", async () => {
  const f = await fixture();
  try {
    const records = f.turn("verified-turn", "请检查 api_key=not-a-real-key 并联系 user at company dot example", "结果已验证，文件为 /Users/didi/private/project。```private code```");
    records.splice(3, 0, "", "not-json", JSON.stringify({ payload: { type: "missing_record_type" } }), JSON.stringify({ type: "unknown", payload: {} }));
    records.splice(records.length - 1, 0,
      f.response({ type: "message", role: "assistant", phase: "analysis", content: null }),
      f.response({ type: "message", role: "user", content: [{ type: "image", text: "ignored" }, "ignored"] }),
      f.response({ type: "message", role: "assistant", phase: "final_answer", content: "结果已验证，文件为 /Users/didi/private/project。```private code```" }));
    await f.writeSession(records);
    const indexed = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(indexed.tasks_verified, 0);
    const taskId = Object.keys(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, unknown>)[0]!;
    const taskBeforeVerification = await readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: f.state, expected_partition: "candidate_generation" });
    assert.equal(taskBeforeVerification.status, "ineligible");
    const batch = await codexSessionEvidenceBatch({ state_file: f.state });
    assert.deepEqual(batch.session_ids, ["session-a"]);
    const evidence = [{ evidence_id: "evidence-terminal", session_id: "session-a", turn_id: "verified-turn", task_id: "hook-task",
      context_receipt_id: "receipt-1", verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false }];
    assert.equal((await reconcileCodexSessionTaskEvidence(null, { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence[0], verified: false }], { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence[0], turn_id: "different-turn" }], { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence[0], { ...evidence[0], evidence_id: "conflicting-evidence", verification_outcome: "failed" }], { state_file: f.state })).tasks_verified, 0);
    const reconciled = await reconcileCodexSessionTaskEvidence(evidence, { state_file: f.state });
    assert.equal(reconciled.tasks_verified, 1);
    const repeated = await reconcileCodexSessionTaskEvidence(evidence, { state_file: f.state });
    assert.equal(repeated.tasks_verified, 0);
    const next = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    assert.equal(next.tasks_verified, 1);
    const savedState = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, { dataset_partition: "candidate_generation" | "held_out" }> };
    const selectedPartition = savedState.tasks[taskId]!.dataset_partition;
    const candidateTasks = await codexSessionTaskBatch(selectedPartition, { state_file: f.state });
    assert.equal((candidateTasks.tasks as Array<Record<string, unknown>>).length, 1);
    assert.equal((candidateTasks.tasks as Array<Record<string, unknown>>)[0]!.content_stored, false);
    assert.equal((await codexSessionTaskBatch(selectedPartition === "held_out" ? "candidate_generation" : "held_out", { state_file: f.state })).tasks instanceof Array, true);
    await assert.rejects(codexSessionTaskBatch("untrusted" as never, { state_file: f.state }), /partition is unsupported/u);
    const excerpt = await readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: f.state,
      expected_partition: selectedPartition });
    assert.equal(excerpt.status, "ready");
    assert.equal(excerpt.sanitized, true);
    assert.equal(excerpt.content_stored, false);
    assert.match(String(excerpt.task_goal), /\[已脱敏\]/u);
    assert.doesNotMatch(JSON.stringify(excerpt), /not-a-real-key|\/Users\/didi|private code/u);
    const excerptOptions = { sessions_root: f.sessions, state_file: f.state, expected_partition: savedState.tasks[taskId]!.dataset_partition } as const;
    await assert.rejects(readCodexSessionTaskExcerpt(null, excerptOptions), /task_id/u);
    await assert.rejects(readCodexSessionTaskExcerpt("", excerptOptions), /task_id/u);
    await assert.rejects(readCodexSessionTaskExcerpt("x".repeat(161), excerptOptions), /task_id/u);
    assert.equal((await readCodexSessionTaskExcerpt(taskId, excerptOptions, process.env,
      async () => 0)).reason, "task_source_changed_during_read");
    const legacyIndex = JSON.parse(await readFile(f.state, "utf8"));
    delete legacyIndex.tasks[taskId].verification_evidence_ids;
    const legacyIndexFile = join(f.root, "state-without-evidence-ids.json");
    await writeFile(legacyIndexFile, JSON.stringify(legacyIndex));
    const legacyExcerpt = await readCodexSessionTaskExcerpt(taskId, { ...excerptOptions, state_file: legacyIndexFile });
    assert.deepEqual(legacyExcerpt.evidence_ids, []);
    const wrongPartition = savedState.tasks[taskId]!.dataset_partition === "held_out" ? "candidate_generation" : "held_out";
    assert.equal((await readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: f.state,
      expected_partition: wrongPartition })).status, "ineligible");
    await f.writeSession([...f.turn("verified-turn", "rewritten task goal", "rewritten task result"), " ".repeat(1_000)]);
    assert.equal((await readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: f.state,
      expected_partition: savedState.tasks[taskId]!.dataset_partition })).reason, "task_source_digest_mismatch");
    await assert.rejects(readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: f.state,
      expected_partition: "other" } as never), /expected_partition/u);
    const invalidPathState = JSON.parse(await readFile(f.state, "utf8"));
    invalidPathState.tasks[taskId].source_path = "../outside.jsonl";
    const invalidPathFile = join(f.root, "state-invalid-task-path.json");
    await writeFile(invalidPathFile, JSON.stringify(invalidPathState));
    await assert.rejects(readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: invalidPathFile,
      expected_partition: savedState.tasks[taskId]!.dataset_partition }), /source reference is invalid/u);
    invalidPathState.tasks[taskId].source_path = "/outside.jsonl";
    const absolutePathFile = join(f.root, "state-absolute-task-path.json");
    await writeFile(absolutePathFile, JSON.stringify(invalidPathState));
    await assert.rejects(readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: absolutePathFile,
      expected_partition: savedState.tasks[taskId]!.dataset_partition }), /source reference is invalid/u);
    const oversizedState = JSON.parse(await readFile(f.state, "utf8"));
    oversizedState.tasks[taskId].source_end_byte += 1_000;
    const oversizedStateFile = join(f.root, "state-oversized-task-span.json");
    await writeFile(oversizedStateFile, JSON.stringify(oversizedState));
    assert.equal((await readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: oversizedStateFile,
      expected_partition: savedState.tasks[taskId]!.dataset_partition })).status, "ineligible");
    const sourceState = JSON.parse(await readFile(f.state, "utf8"));
    sourceState.tasks[taskId].source_path = "2026/10";
    const directoryPathFile = join(f.root, "state-directory-task-path.json");
    await writeFile(directoryPathFile, JSON.stringify(sourceState));
    assert.equal((await readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: directoryPathFile,
      expected_partition: savedState.tasks[taskId]!.dataset_partition })).status, "ineligible");
    const inRootLink = join(f.sessions, "linked-task.jsonl");
    await symlink(f.file, inRootLink);
    sourceState.tasks[taskId].source_path = "linked-task.jsonl";
    const symlinkPathFile = join(f.root, "state-symlink-task-path.json");
    await writeFile(symlinkPathFile, JSON.stringify(sourceState));
    assert.equal((await readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: symlinkPathFile,
      expected_partition: savedState.tasks[taskId]!.dataset_partition })).status, "ineligible");
    const escapedFile = join(f.root, "outside-session.jsonl");
    await writeFile(escapedFile, "outside\n");
    await symlink(escapedFile, join(f.sessions, "escaped-task.jsonl"));
    sourceState.tasks[taskId].source_path = "escaped-task.jsonl";
    const escapedPathFile = join(f.root, "state-escaped-task-path.json");
    await writeFile(escapedPathFile, JSON.stringify(sourceState));
    await assert.rejects(readCodexSessionTaskExcerpt(taskId, { sessions_root: f.sessions, state_file: escapedPathFile,
      expected_partition: savedState.tasks[taskId]!.dataset_partition }), /escaped the sessions root/u);
    const saved = await readFile(f.state, "utf8");
    assert.match(saved, /evidence-terminal/u);
    assert.doesNotMatch(saved, /not-a-real-key|private code|"verification_ref":/u);
    const shortFile = join(f.sessions, "2026", "10", "session-short.jsonl");
    await writeFile(shortFile, [
      f.record("session_meta", { session_id: "session-short", cwd: f.project }),
      f.event({ type: "task_started", turn_id: "short-turn" }),
      f.response({ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }),
      f.response({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "This task is complete." }] }),
      f.event({ type: "task_complete", turn_id: "short-turn" }),
    ].join("\n") + "\n");
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state, max_files: 25, max_bytes: 1_000_000 });
    const shortState = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, { turn_id: string; dataset_partition: "candidate_generation" | "held_out" }> };
    const shortTaskId = Object.keys(shortState.tasks).find(id => shortState.tasks[id]!.turn_id === "short-turn")!;
    await reconcileCodexSessionTaskEvidence([{ evidence_id: "evidence-short-task", session_id: "session-short", turn_id: "short-turn",
      context_receipt_id: "receipt-short", verification_ref_digest: `sha256:${"e".repeat(64)}`,
      terminal_identity_digest: `sha256:${"f".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false }], { state_file: f.state });
    assert.equal((await readCodexSessionTaskExcerpt(shortTaskId, { sessions_root: f.sessions, state_file: f.state,
      expected_partition: shortState.tasks[shortTaskId]!.dataset_partition })).reason, "sanitized_task_summary_unavailable");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("joins Host and Codex turns by one unique sanitized goal digest and fails closed on duplicates", async () => {
  const f = await fixture();
  const taskGoal = "整理项目依赖升级的验证流程";
  try {
    await f.writeSession(f.turn("jsonl-turn-id", taskGoal));
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const task = Object.values(state.tasks as Record<string, { task_goal_digest?: string; project_scope_id: string }>)[0]!;
    const evidence = { evidence_id: "evidence-hook-turn", host: "codex", session_id: "session-a", turn_id: "hook-turn-id-not-in-jsonl",
      task_id: "hook-task-id", context_receipt_id: "receipt-1", verification_ref_digest: `sha256:${"a".repeat(64)}`,
      terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false,
      project_scope_id: task.project_scope_id, task_goal_digest: task.task_goal_digest };
    const result = await reconcileCodexSessionTaskEvidence([evidence], { state_file: f.state });
    assert.equal(result.tasks_verified, 1);
    assert.equal(JSON.stringify(await readFile(f.state, "utf8")).includes(taskGoal), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }

  const ambiguous = await fixture();
  try {
    await ambiguous.writeSession([...ambiguous.turn("turn-a", taskGoal), ...ambiguous.turn("turn-b", taskGoal)]);
    await runCodexSessionCollectionOnce({ sessions_root: ambiguous.sessions, state_file: ambiguous.state });
    const state = JSON.parse(await readFile(ambiguous.state, "utf8"));
    const task = Object.values(state.tasks as Record<string, { task_goal_digest?: string; project_scope_id: string }>)[0]!;
    const evidence = { evidence_id: "evidence-ambiguous-hook-turn", host: "codex", session_id: "session-a", turn_id: "hook-turn-not-in-jsonl",
      task_id: "hook-task-id", context_receipt_id: "receipt-2", verification_ref_digest: `sha256:${"c".repeat(64)}`,
      terminal_identity_digest: `sha256:${"d".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false,
      project_scope_id: task.project_scope_id, task_goal_digest: task.task_goal_digest };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], { state_file: ambiguous.state })).tasks_verified, 0);
  } finally { await rm(ambiguous.root, { recursive: true, force: true }); }
});

test("keeps legacy optional task provenance readable and fails closed when goal evidence is absent", async () => {
  const f = await fixture();
  try {
    await f.writeSession([...f.turn("verified-turn", "完成本轮已经验证的任务"), ...f.turn("pending-turn", "完成本轮等待验证任务")]);
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const verified = Object.values(state.tasks as Record<string, { turn_id: string; task_goal_digest?: string; dataset_partition: "candidate_generation" | "held_out" }>).find(task => task.turn_id === "verified-turn")!;
    const pending = Object.values(state.tasks as Record<string, { turn_id: string; task_goal_digest?: string }>).find(task => task.turn_id === "pending-turn")!;
    const evidence = { evidence_id: "evidence-exact-only", session_id: "session-a", turn_id: "verified-turn",
      context_receipt_id: "receipt-legacy", verification_ref_digest: `sha256:${"a".repeat(64)}`,
      terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], { state_file: f.state })).tasks_verified, 1);
    const persisted = JSON.parse(await readFile(f.state, "utf8"));
    const verifiedRecord = Object.values(persisted.tasks as Record<string, Record<string, unknown>>).find(task => task.turn_id === "verified-turn")!;
    delete verifiedRecord.context_receipt_id;
    delete verifiedRecord.verification_ref_digest;
    delete verifiedRecord.terminal_identity_digest;
    await writeFile(f.state, JSON.stringify(persisted));

    const batch = await codexSessionTaskBatch(verified.dataset_partition, { state_file: f.state });
    const returned = (batch.tasks as Array<Record<string, unknown>>).find(task => task.turn_id === "verified-turn")!;
    assert.equal(returned.context_receipt_id, null);
    assert.equal(returned.verification_ref_digest, null);
    assert.equal(returned.terminal_identity_digest, null);
    assert.equal(pending.task_goal_digest !== undefined, true);
    assert.equal((await reconcileCodexSessionTaskEvidence([], { state_file: f.state })).tasks_verified, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rotates bounded Evidence lookups across every pending session and persists only the acknowledged cursor", async () => {
  const f = await fixture();
  try {
    const month = join(f.sessions, "2026", "10");
    const sessionCount = 205;
    for (let index = 0; index < sessionCount; index++) {
      const sessionId = `session-${String(index).padStart(3, "0")}`;
      const file = join(month, `${sessionId}.jsonl`);
      await writeFile(file, [
        f.record("session_meta", { session_id: sessionId }),
        f.event({ type: "task_started", turn_id: `turn-${index}` }),
        f.response({ type: "message", role: "user", content: [{ type: "input_text", text: "bounded task" }] }),
        f.event({ type: "task_complete", turn_id: `turn-${index}` }),
      ].join("\n") + "\n");
    }
    const collected = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state, max_files: 500, max_bytes: 2_000_000 });
    assert.equal(collected.tasks_indexed, sessionCount);

    const queried: string[] = [];
    let passes = 0;
    while (new Set(queried).size < sessionCount) {
      const batch = await codexSessionEvidenceBatch({ state_file: f.state });
      const sessionIds = batch.session_ids as string[];
      assert.ok(sessionIds.length > 0 && sessionIds.length <= 100);
      if (passes === 0) assert.deepEqual((await codexSessionEvidenceBatch({ state_file: f.state })).session_ids, sessionIds,
        "reading a batch does not advance the cursor before its lookup succeeds");
      queried.push(...sessionIds);
      assert.equal((await commitCodexSessionEvidenceBatch(sessionIds, { state_file: f.state })).status, "advanced");
      passes++;
      assert.ok(passes <= 3, "each unverified source session should be reached within three batches");
    }
    assert.equal(new Set(queried).size, sessionCount);
    assert.equal(passes, 3);
    const wrapped = await codexSessionEvidenceBatch({ state_file: f.state });
    assert.equal((wrapped.session_ids as string[]).length, 100);
    assert.equal(wrapped.sessions_pending, sessionCount);
    assert.equal(wrapped.tasks_pending, sessionCount);
    await assert.rejects(commitCodexSessionEvidenceBatch([], { state_file: f.state }), /1 to 100/u);
    await assert.rejects(commitCodexSessionEvidenceBatch(Array.from({ length: 101 }, (_, index) => `session-${index}`), { state_file: f.state }), /1 to 100/u);
    await assert.rejects(commitCodexSessionEvidenceBatch(["session-000", "session-000"], { state_file: f.state }), /unique/u);
    await assert.rejects(commitCodexSessionEvidenceBatch(["not-indexed"], { state_file: f.state }), /indexed Host sessions/u);
    await assert.rejects(commitCodexSessionEvidenceBatch(["bad\nsession"], { state_file: f.state }), /1 to 100/u);
    await assert.rejects(commitCodexSessionEvidenceBatch([" "], { state_file: f.state }), /1 to 100/u);
    await assert.rejects(commitCodexSessionEvidenceBatch(["x".repeat(257)], { state_file: f.state }), /1 to 100/u);
    await assert.rejects(commitCodexSessionEvidenceBatch([123], { state_file: f.state }), /1 to 100/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
