import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { codexTaskGoalDigest } from "../core/codex-task-prose.ts";
import { stableDigest } from "../core/digest.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import type { CodexSessionTaskIndex } from "../core/codex-session-archive.ts";
import { codexSessionEvidenceBatch, codexSessionTaskBatch, commitCodexSessionEvidenceBatch, readCodexSessionChunk, readCodexSessionTaskExcerpt, reconcileCodexSessionTaskEvidence, requestCodexSessionSourceRecheck, resolveCodexHostEvidenceArchive, resolveCodexHostEvidenceRecord, runCodexSessionCollectionOnce, verifyCodexSessionEvidenceInput } from "../core/codex-session-archive.ts";

test("evidence reconciliation rejects invalid checked Host session identifiers", async () => {
  for (const checked of [null, 3, [""], ["bad\nidentifier"], ["x".repeat(257)], [3]]) {
    await assert.rejects(reconcileCodexSessionTaskEvidence([], { checked_session_ids: checked as string[] }), /bounded Host session identifiers/u);
  }
});

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

test("collection reports indexed sources absent from the current discovery scope without deleting tasks", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("missing-source", "核实历史会话采集状态", "已记录会话结果");
    turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: "missing-source", item: { type: "CommandExecution", id: "test",
      command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    const first = await runCodexSessionCollectionOnce(options);
    assert.equal(first.indexed_sources_not_discovered, 0);
    const stateBefore = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    assert.equal(Object.keys(stateBefore.tasks).length, 1);
    const task = Object.values(stateBefore.tasks)[0]!;
    assert.equal(((await codexSessionTaskBatch(task.dataset_partition, options)).tasks as unknown[]).length, 1);
    await rm(f.file);
    await writeFile(join(dirname(f.file), "other.jsonl"), "{}\n");
    const second = await runCodexSessionCollectionOnce(options);
    assert.equal(second.status, "partial");
    assert.equal(second.sessions_seen, 1);
    assert.equal(second.indexed_sources_not_discovered, 1);
    assert.equal(second.tasks_from_undiscovered_sources, 1);
    const missingBatch = await codexSessionTaskBatch(task.dataset_partition, options);
    assert.equal((missingBatch.tasks as unknown[]).length, 0);
    assert.equal(missingBatch.excluded_source_not_current, 1);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_source_not_current");
    const stateAfter = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, unknown> };
    assert.deepEqual(Object.keys(stateAfter.tasks), Object.keys(stateBefore.tasks));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a quiet collection does not rewrite the index but a source change does", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("quiet-turn", "检查空闲时的会话采集", "已经完成检查"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce({ ...options, now: "2026-10-01T00:00:00.000Z" });
    const before = await stat(f.state), content = await readFile(f.state, "utf8");
    const quiet = await runCodexSessionCollectionOnce({ ...options, now: "2026-10-02T00:00:00.000Z" });
    const after = await stat(f.state);
    assert.equal(quiet.sessions_processed, 0);
    assert.equal(after.ino, before.ino);
    assert.equal(await readFile(f.state, "utf8"), content);
    await appendFile(f.file, "{}\n");
    const changed = await runCodexSessionCollectionOnce({ ...options, now: "2026-10-03T00:00:00.000Z" });
    assert.equal(changed.sessions_processed, 1);
    assert.equal((JSON.parse(await readFile(f.state, "utf8")) as { updated_at: string }).updated_at, "2026-10-03T00:00:00.000Z");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("session index writers fail fast under contention while reads and other indexes continue", async () => {
  const f = await fixture();
  let lock: DatabaseSync | null = null;
  try {
    await f.writeSession(f.turn("locked-turn", "检查并发采集边界", "验证已经完成"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const before = await readFile(f.state, "utf8");
    lock = new DatabaseSync(join(dirname(f.state), `codex-session-index-${stableDigest(f.state).slice(-24)}.lock.db`));
    lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    await assert.rejects(runCodexSessionCollectionOnce(options), /CODEX_SESSION_INDEX_BUSY/u);
    await assert.rejects(reconcileCodexSessionTaskEvidence([], options), /CODEX_SESSION_INDEX_BUSY/u);
    await assert.rejects(commitCodexSessionEvidenceBatch(["session-a"], options), /CODEX_SESSION_INDEX_BUSY/u);
    const modulePath = new URL("../core/codex-session-archive.ts", import.meta.url).href;
    const script = `import { commitCodexSessionEvidenceBatch } from ${JSON.stringify(modulePath)};
      try { await commitCodexSessionEvidenceBatch(['session-a'], JSON.parse(process.env.CRAFT_TEST_INDEX_OPTIONS)); }
      catch (error) { process.stdout.write(error.name); }`;
    const competing = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
      { encoding: "utf8", env: { ...process.env, CRAFT_TEST_INDEX_OPTIONS: JSON.stringify(options) }, timeout: 10_000 });
    assert.equal(competing.status, 0, competing.stderr);
    assert.equal(competing.stdout, "CodexSessionIndexBusy");
    assert.equal(typeof (await codexSessionTaskBatch("held_out", options)).indexed_partition_tasks, "number");
    assert.equal(await readFile(f.state, "utf8"), before);
    const separate = await runCodexSessionCollectionOnce({ ...options, state_file: join(dirname(f.state), "other-index.json") });
    assert.equal(separate.sessions_seen, 1);
    lock.close(); lock = null;
    await commitCodexSessionEvidenceBatch(["session-a"], options);
    assert.notEqual(await readFile(f.state, "utf8"), before);
  } finally { lock?.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("session index lock is released after its writer process is terminated", { timeout: 15_000 }, async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await f.writeSession(f.turn("crash-turn", "验证进程退出后的索引恢复", "已经验证索引恢复"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const before = await readFile(f.state, "utf8");
    const lockPath = join(dirname(f.state), `codex-session-index-${stableDigest(f.state).slice(-24)}.lock.db`);
    const script = `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.env.CRAFT_TEST_LOCK_PATH); db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
    child = spawn(process.execPath, ["--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CRAFT_TEST_LOCK_PATH: lockPath } });
    await new Promise<void>((resolveReady, reject) => {
      child!.once("error", reject);
      child!.stdout!.once("data", () => resolveReady());
      child!.once("exit", code => reject(new Error(`lock owner exited early: ${code}`)));
    });
    await assert.rejects(commitCodexSessionEvidenceBatch(["session-a"], options), /CODEX_SESSION_INDEX_BUSY/u);
    assert.equal(await readFile(f.state, "utf8"), before);
    const exited = new Promise<void>(resolveExit => child!.once("exit", () => resolveExit()));
    child.kill("SIGTERM"); await exited;
    assert.equal((await commitCodexSessionEvidenceBatch(["session-a"], options)).status, "advanced");
    assert.notEqual(await readFile(f.state, "utf8"), before);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const phase of ["before_rename", "after_rename"] as const) {
  test(`session index remains readable when a writer is terminated ${phase}`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await f.writeSession(f.turn("atomic-turn", "检查中断后的索引一致性", "已经验证索引状态"));
      const options = { sessions_root: f.sessions, state_file: f.state };
      await runCodexSessionCollectionOnce(options);
      const before = await readFile(f.state, "utf8");
      const moduleUrl = new URL("../core/codex-session-archive.ts", import.meta.url).href;
      const script = `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
        const original = fs.rename.bind(fs); const target = process.env.CRAFT_TEST_STATE;
        fs.rename = async (from, to) => { if (to === target) { if (process.env.CRAFT_TEST_PHASE === 'after_rename') await original(from, to);
          process.stdout.write('ready\\n'); await new Promise(() => setInterval(() => {}, 1000)); } return original(from, to); };
        syncBuiltinESMExports(); const { commitCodexSessionEvidenceBatch } = await import(${JSON.stringify(moduleUrl)});
        await commitCodexSessionEvidenceBatch(['session-a'], JSON.parse(process.env.CRAFT_TEST_OPTIONS));`;
      child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CRAFT_TEST_STATE: f.state, CRAFT_TEST_PHASE: phase, CRAFT_TEST_OPTIONS: JSON.stringify(options) } });
      await new Promise<void>((resolveReady, reject) => {
        child!.once("error", reject); child!.stdout!.once("data", () => resolveReady());
        child!.once("exit", code => reject(new Error(`writer exited early: ${code}`)));
      });
      const exited = new Promise<void>(resolveExit => child!.once("exit", () => resolveExit()));
      child.kill("SIGTERM"); await exited;
      const after = await readFile(f.state, "utf8");
      const parsed = JSON.parse(after) as { evidence_cursor_session_id?: string };
      if (phase === "before_rename") {
        assert.equal(after, before);
        assert.equal((await readdir(dirname(f.state))).filter(name => name.startsWith("session-index.json.") && name.endsWith(".tmp")).length, 1);
      }
      else assert.equal(parsed.evidence_cursor_session_id, "session-a");
      assert.equal((await commitCodexSessionEvidenceBatch(["session-a"], options)).status, "advanced");
      assert.equal((JSON.parse(await readFile(f.state, "utf8")) as { evidence_cursor_session_id?: string }).evidence_cursor_session_id, "session-a");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("a changed source waiting behind the scan budget cannot supply indexed tasks", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("changed-source", "核实来源变更后证据", "已经完成测试验证");
    turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: "changed-source", item: { type: "CommandExecution", id: "test",
      command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    const older = join(dirname(f.file), "older.jsonl");
    await writeFile(older, "{}\n");
    await utimes(older, new Date(0), new Date(0));
    await appendFile(f.file, "{}\n");
    const result = await runCodexSessionCollectionOnce({ ...options, max_files: 1 });
    assert.equal(result.sessions_pending, 1);
    const batch = await codexSessionTaskBatch(task.dataset_partition, options);
    assert.equal((batch.tasks as unknown[]).length, 0);
    assert.equal(batch.excluded_source_not_current, 1);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_source_not_current");
    await runCodexSessionCollectionOnce(options);
    assert.equal(((await codexSessionTaskBatch(task.dataset_partition, options)).tasks as unknown[]).length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("events from another turn invalidate the active task rather than mixing verification evidence", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("source-turn", "核对当前任务的测试结果", "已完成任务验证");
    turn.splice(turn.length - 1, 0,
      f.event({ type: "item_completed", turn_id: "other-turn", item: { type: "CommandExecution", id: "other-test",
        command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }),
      f.event({ type: "item_completed", turn_id: "source-turn", item: { type: "CommandExecution", id: "own-test",
        command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    assert.equal(task.verification_transcript_error, "task_turn_identity_conflict");
    const batch = await codexSessionTaskBatch(task.dataset_partition, options);
    assert.equal((batch.tasks as unknown[]).length, 0);
    assert.equal(batch.excluded_verification_transcript_error, 1);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_turn_identity_conflict");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("late completion from a known prior turn is ignored without invalidating the active task", async () => {
  const f = await fixture();
  try {
    const first = f.turn("earlier-turn", "核实此前任务结果", "此前任务已经结束");
    const second = f.turn("current-turn", "核实当前任务结果", "当前任务已经验证");
    second.splice(second.length - 1, 0,
      f.event({ type: "item_completed", turn_id: "earlier-turn", item: { type: "CommandExecution", id: "late-test",
        command: "pnpm test", aggregated_output: "Tests 2 passed (2)", exit_code: 0, status: "completed" } }),
      f.event({ type: "item_completed", turn_id: "current-turn", item: { type: "CommandExecution", id: "own-test",
        command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }));
    await f.writeSession([...first, ...second]);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks).find(item => item.turn_id === "current-turn")!;
    assert.equal(task.verification_transcript_error, undefined);
    assert.equal(task.verification_artifact_count, 1);
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition });
    assert.equal(excerpt.status, "ready");
    assert.equal((excerpt.verification_artifacts as unknown[]).length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("reads a long turn with independently verified terminal outcome", async () => {
  const f = await fixture();
  try {
    const lines = f.turn("long-turn", "检查长任务的来源与摘要", "已经完成长任务来源检查");
    lines.splice(2, 0, f.event({ type: "diagnostic", data: "x".repeat(9 * 1024 * 1024) }));
    lines.splice(2, 0, f.response({ type: "custom_tool_call", name: "exec", call_id: "long-test", input: "node --test" }));
    lines.splice(4, 0, f.response({ type: "custom_tool_call_output", call_id: "long-test", output: "# pass 1\nProcess exited with code 0" }));
    await f.writeSession(lines);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    await reconcileCodexSessionTaskEvidence([{ evidence_id: "long-evidence", session_id: "session-a", turn_id: "long-turn",
      context_receipt_id: "long-receipt", verification_ref_digest: `sha256:${"a".repeat(64)}`,
      terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false }], options);
    const task = Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, CodexSessionTaskIndex>)[0]!;
    const result = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition });
    assert.equal(result.status, "ready", JSON.stringify(result));
    assert.equal(result.verification_outcome, "passed");
    assert.equal(result.raw_content_stored, false);
    assert.equal((result.verification_artifacts as JsonObject[]).length, 1);
    const source = await readFile(f.file);
    let reads = 0;
    const interrupted = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition }, process.env,
      async (_path, target, start) => {
        reads++;
        if (reads === 2) return 0;
        return source.copy(target, 0, start, start + target.length);
      });
    assert.equal(reads, 2);
    assert.equal(interrupted.reason, "task_source_changed_during_read");
    reads = 0;
    const altered = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition }, process.env,
      async (_path, target, start) => {
        const count = source.copy(target, 0, start, start + target.length);
        if (++reads === 2) target[0] = target[0] === 120 ? 121 : 120;
        return count;
      });
    assert.equal(altered.reason, "task_source_digest_mismatch");
    await assert.rejects(readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition }, process.env,
      async () => { throw new Error("unexpected read failure"); }), /unexpected read failure/u);
    await appendFile(f.file, Buffer.alloc(66 * 1024 * 1024));
    const largeState = JSON.parse(await readFile(f.state, "utf8"));
    largeState.tasks[task.task_id].source_end_byte = task.source_start_byte + 65 * 1024 * 1024;
    await writeFile(f.state, JSON.stringify(largeState));
    for (const finalNewline of [false, true]) {
      const oversized = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition }, process.env,
        async (_path, target, start) => {
          target.fill(120);
          if (finalNewline && start - task.source_start_byte >= 64 * 1024 * 1024) target[100] = 10;
          return target.length;
        });
      assert.equal(oversized.reason, "task_source_line_oversized");
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("reads CRLF session records with the same source digest as the collector", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("crlf-turn", "核查会话记录的来源摘要", "已经完成会话来源摘要检查"));
    const contents = await readFile(f.file, "utf8");
    await writeFile(f.file, contents.replace(/\n/gu, "\r\n"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    await reconcileCodexSessionTaskEvidence([{ evidence_id: "crlf-evidence", session_id: "session-a", turn_id: "crlf-turn",
      context_receipt_id: "crlf-receipt", verification_ref_digest: `sha256:${"a".repeat(64)}`,
      terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false }], options);
    const task = Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, CodexSessionTaskIndex>)[0]!;
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).status, "ready");
    const originalOpen = fsPromises.open;
    try {
      fsPromises.open = async (...args: Parameters<typeof originalOpen>) => {
        if (String(args[0]) === f.file) {
          await rename(f.file, `${f.file}.old`);
          await writeFile(f.file, contents.replace(/\n/gu, "\r\n"));
        }
        return originalOpen(...args);
      };
      syncBuiltinESMExports();
      const changed = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition });
      assert.equal(changed.reason, "task_source_changed_during_read");
    } finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});



test("discovers active and archived Host sessions without colliding source paths or copying text", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("active-turn", "active private task"));
    const archive = join(f.root, "codex", "archived_sessions");
    await mkdir(join(archive, "2026", "10"), { recursive: true });
    const archiveFile = join(archive, "2026", "10", "session-a.jsonl");
    await writeFile(archiveFile, [f.record("session_meta", { session_id: "archived-session", cwd: f.project }),
      ...f.turn("archived-turn", "archived private task")].join("\n") + "\n");
    const env = { CODEX_HOME: join(f.root, "codex"), CRAFT_DATA_DIR: join(f.root, "data") };
    const options = { state_file: f.state };
    const result = await runCodexSessionCollectionOnce(options, env);
    assert.equal(result.sessions_seen, 2);
    assert.equal(result.tasks_indexed, 2);
    const saved = await readFile(f.state, "utf8");
    const state = JSON.parse(saved) as { sources: Record<string, unknown>; tasks: Record<string, CodexSessionTaskIndex> };
    assert.equal(Object.keys(state.sources).length, 2);
    assert.equal(Object.values(state.tasks).filter(task => task.source_root === "archived_sessions").length, 1);
    assert.doesNotMatch(saved, /active private task|archived private task|private final output/);
    assert.equal((await runCodexSessionCollectionOnce(options, env)).sessions_processed, 0);
    // Explicit roots scope collection: a caller selecting only sessions must
    // not implicitly grant access to its sibling archive.
    const scoped = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: join(f.root, "scoped.json") }, env);
    assert.equal(scoped.sessions_seen, 1);
    const explicit = await runCodexSessionCollectionOnce({ sessions_root: f.sessions, archived_sessions_root: archive,
      state_file: join(f.root, "explicit.json") }, env);
    assert.equal(explicit.sessions_seen, 2);
    // Rewriting archive content removes only that archive's stale tasks.
    await writeFile(archiveFile, f.record("session_meta", { session_id: "empty-archive" }) + "\n");
    const rewritten = await runCodexSessionCollectionOnce(options, env);
    assert.equal(rewritten.tasks_indexed, 1);
    assert.equal(Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, CodexSessionTaskIndex>).every(task => task.session_id === "session-a"), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("archiving and restoring an identical session preserves verified provenance and dataset isolation", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("verified-turn", "检查归档后的来源可追溯性", "已验证归档前后的证据一致"));
    const archive = join(f.root, "codex", "archived_sessions");
    const env = { CODEX_HOME: join(f.root, "codex"), CRAFT_DATA_DIR: join(f.root, "data") };
    const options = { state_file: f.state };
    const first = await runCodexSessionCollectionOnce(options, env);
    assert.equal(first.sessions_seen, 1, "a missing archive does not block active collection");
    await reconcileCodexSessionTaskEvidence([{ evidence_id: "verified-evidence", session_id: "session-a", turn_id: "verified-turn",
      context_receipt_id: "verified-receipt", verification_ref_digest: `sha256:${"a".repeat(64)}`,
      terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false }], options, env);
    const original = Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, CodexSessionTaskIndex>)[0]!;
    const binding = await resolveCodexHostEvidenceArchive("verified-evidence", options, env);
    assert.equal(binding.status, "matched");
    assert.equal(binding.source_ref_digest, original.source_ref);
    assert.equal(binding.project_scope_id, original.project_scope_id);
    const hostRecord: JsonObject = { id: "verified-evidence", source_type: "host_completion_signal", metadata: {
      provenance: "host_completion_signal", host: "codex", source_session_id: original.session_id, turn_id: original.turn_id,
      project_scope_id: original.project_scope_id, context_receipt_id: original.context_receipt_id,
      verification_ref_digest: original.verification_ref_digest, terminal_identity_digest: original.terminal_identity_digest, verification_outcome: "passed" } };
    assert.equal((await resolveCodexHostEvidenceRecord(hostRecord, options, env)).status, "matched");
    assert.equal((await resolveCodexHostEvidenceRecord({ ...hostRecord, record_origin: "caller_asserted" }, options, env)).reason, "host_evidence_incomplete");
    for (const key of ["source_session_id", "turn_id", "project_scope_id", "context_receipt_id", "verification_ref_digest", "terminal_identity_digest", "verification_outcome"]) {
      const metadata = { ...(hostRecord.metadata as JsonObject) }; delete metadata[key];
      assert.equal((await resolveCodexHostEvidenceRecord({ ...hostRecord, metadata }, options, env)).reason, "host_evidence_incomplete");
    }
    for (const changes of [{ source_session_id: "other" }, { turn_id: "other" }, { project_scope_id: "project:other" },
      { context_receipt_id: "other" }, { verification_ref_digest: "other" }, { terminal_identity_digest: "other" },
      { verification_outcome: "failed" }, { task_goal_digest: `sha256:${"d".repeat(64)}` }]) {
      const record = { ...hostRecord, metadata: { ...(hostRecord.metadata as JsonObject), ...changes } };
      assert.equal((await resolveCodexHostEvidenceRecord(record, options, env)).reason, "host_evidence_archive_mismatch");
    }
    assert.equal((await resolveCodexHostEvidenceArchive("missing", options, env)).reason, "evidence_not_indexed");
    await assert.rejects(resolveCodexHostEvidenceArchive("invalid\n", options, env), /bounded string/u);
    const originalIndex = await readFile(f.state, "utf8");
    const ambiguous = JSON.parse(originalIndex);
    ambiguous.tasks.duplicate = { ...original, task_id: "duplicate" };
    await writeFile(f.state, JSON.stringify(ambiguous));
    assert.equal((await resolveCodexHostEvidenceArchive("verified-evidence", options, env)).reason, "ambiguous_evidence");
    await writeFile(f.state, originalIndex);
    const originalRead = fsPromises.readFile;
    let stateReads = 0;
    try {
      fsPromises.readFile = (async (...args: Parameters<typeof originalRead>) => {
        const data = await originalRead(...args);
        if (args[0] === f.state && ++stateReads === 3) {
          const changed = JSON.parse(String(data));
          changed.tasks[original.task_id].terminal_identity_digest = `sha256:${"c".repeat(64)}`;
          return JSON.stringify(changed);
        }
        return data;
      }) as typeof originalRead;
      syncBuiltinESMExports();
      assert.equal((await resolveCodexHostEvidenceArchive("verified-evidence", options, env)).reason, "archive_task_changed_during_read");
    } finally { fsPromises.readFile = originalRead; syncBuiltinESMExports(); }
    await mkdir(archive);
    const archivedFile = join(archive, "session-a.jsonl");
    await rename(f.file, archivedFile);
    const collected = await runCodexSessionCollectionOnce(options, env);
    assert.equal(collected.tasks_indexed, 1);
    assert.equal(collected.tasks_verified, 1);
    const relocated = Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, CodexSessionTaskIndex>)[0]!;
    assert.equal(relocated.source_root, "archived_sessions");
    for (const key of ["task_id", "session_id", "turn_id", "source_ref", "dataset_partition", "dataset_split_version",
      "verification_status", "context_receipt_id", "verification_ref_digest", "terminal_identity_digest"] as const) assert.equal(relocated[key], original[key], key);
    assert.deepEqual(relocated.verification_evidence_ids, original.verification_evidence_ids);
    const excerptOptions = { ...options, expected_partition: original.dataset_partition };
    const excerpt = await readCodexSessionTaskExcerpt(original.task_id, excerptOptions, env);
    assert.equal(excerpt.status, "ready", JSON.stringify(excerpt));
    assert.equal(excerpt.task_goal, "检查归档后的来源可追溯性");
    assert.equal((await codexSessionTaskBatch(original.dataset_partition, options, env)).tasks instanceof Array, true);
    assert.deepEqual((await codexSessionTaskBatch(original.dataset_partition === "held_out" ? "candidate_generation" : "held_out", options, env)).tasks, []);
    assert.equal((await readCodexSessionTaskExcerpt(original.task_id, { ...excerptOptions, sessions_root: f.sessions }, env)).reason,
      "task_source_root_unavailable");
    assert.equal((await readCodexSessionTaskExcerpt(original.task_id, { ...excerptOptions, sessions_root: f.sessions, archived_sessions_root: archive }, env)).status, "ready");

    // A rename preserves timestamps. The unchanged original path must still
    // be rebound after restoration instead of retaining the missing archive.
    await rename(archivedFile, f.file);
    assert.equal((await runCodexSessionCollectionOnce(options, env)).tasks_verified, 1);
    const restored = Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, CodexSessionTaskIndex>)[0]!;
    assert.equal(restored.source_root, undefined);
    assert.equal((await readCodexSessionTaskExcerpt(original.task_id, excerptOptions, env)).status, "ready");
    assert.equal((await reconcileCodexSessionTaskEvidence([], { ...options, checked_session_ids: [original.session_id] }, env)).tasks_invalidated, 1);
    await rename(f.file, archivedFile);
    await runCodexSessionCollectionOnce(options, env);
    const revoked = Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, CodexSessionTaskIndex>)[0]!;
    assert.equal(revoked.verification_invalidated, true);
    assert.equal((await resolveCodexHostEvidenceArchive("verified-evidence", options, env)).status, "unavailable");
    assert.equal((await readCodexSessionTaskExcerpt(original.task_id, excerptOptions, env)).reason, "task_terminal_evidence_invalidated");
    // A forged root discriminator must not open an arbitrary directory.
    const invalid = JSON.parse(await readFile(f.state, "utf8"));
    invalid.tasks[original.task_id].source_root = "outside";
    await writeFile(f.state, JSON.stringify(invalid));
    await assert.rejects(runCodexSessionCollectionOnce(options, env), /task index is invalid/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("reconciliation invalidates replaced evidence and detects changed receipt bindings", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("turn-binding", "检查任务证据", "任务已完成"));
    const env = { CODEX_HOME: join(f.root, "codex"), CRAFT_DATA_DIR: join(f.root, "data") };
    const options = { state_file: f.state, checked_session_ids: ["session-a"] };
    await runCodexSessionCollectionOnce(options, env);
    const evidence = { evidence_id: "original", session_id: "session-a", turn_id: "turn-binding", context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options, env)).tasks_verified, 1);
    const verifiedState = await readFile(f.state, "utf8");
    const replaced = await reconcileCodexSessionTaskEvidence([{ ...evidence, evidence_id: "replacement" }], options, env);
    assert.equal(replaced.tasks_invalidated, 1);
    assert.equal((await resolveCodexHostEvidenceArchive("original", options, env)).status, "unavailable");
    for (const changes of [{ context_receipt_id: "other" }, { verification_ref_digest: `sha256:${"c".repeat(64)}` }]) {
      await writeFile(f.state, verifiedState);
      const conflict = await reconcileCodexSessionTaskEvidence([{ ...evidence, ...changes }], options, env);
      assert.equal(conflict.tasks_conflicted, 1);
      assert.equal((await resolveCodexHostEvidenceArchive("original", options, env)).status, "unavailable");
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rewritten task content cannot reuse terminal evidence from the old source", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("rewrite-turn", "验证源版本", "旧任务完成".repeat(80)));
    const options = { sessions_root: f.sessions, state_file: f.state, checked_session_ids: ["session-a"] };
    await runCodexSessionCollectionOnce(options);
    const evidence = { evidence_id: "old-evidence", session_id: "session-a", turn_id: "rewrite-turn", context_receipt_id: "old-receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
    await f.writeSession(f.turn("rewrite-turn", "验证源版本", "新任务"));
    await runCodexSessionCollectionOnce(options);
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 0);
    assert.equal((await resolveCodexHostEvidenceArchive("old-evidence", options)).status, "unavailable");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rewritten source that grows cannot provide the old terminal evidence", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("grown-rewrite", "检查增长文件中的旧证据", "原始任务结果已经核实"));
    const options = { sessions_root: f.sessions, state_file: f.state, checked_session_ids: ["session-a"] };
    await runCodexSessionCollectionOnce(options);
    const evidence = { evidence_id: "grown-evidence", session_id: "session-a", turn_id: "grown-rewrite", context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    const before = (await codexSessionTaskBatch(task.dataset_partition, options)).tasks as JsonObject[];
    assert.equal(before[0]?.source_revalidation_required, true);
    await f.writeSession(f.turn("grown-rewrite", "检查增长文件中的旧证据", "修改过的任务结果".repeat(100)));
    await runCodexSessionCollectionOnce(options);
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition });
    assert.notEqual(excerpt.status, "ready");
    assert.equal((await resolveCodexHostEvidenceArchive("grown-evidence", options)).status, "unavailable");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("source recheck rejects stale requests and retries after index contention", async () => {
  const f = await fixture(); let lock: DatabaseSync | null = null;
  try {
    await f.writeSession(f.turn("request-recheck", "检查来源重扫请求", "已核实任务来源和结果"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const task = Object.values(state.tasks as Record<string, CodexSessionTaskIndex>)[0]!;
    const evidence = { evidence_id: "request-evidence", session_id: "session-a", turn_id: "request-recheck", context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    await reconcileCodexSessionTaskEvidence([evidence], options);
    await assert.rejects(requestCodexSessionSourceRecheck("", task.source_ref, options), /task_id/);
    await assert.rejects(requestCodexSessionSourceRecheck(task.task_id, "invalid", options), /source_ref/);
    assert.equal((await requestCodexSessionSourceRecheck(task.task_id, `sha256:${"f".repeat(64)}`, options)).status, "stale_request");
    lock = new DatabaseSync(join(dirname(f.state), `codex-session-index-${stableDigest(f.state).slice(-24)}.lock.db`));
    lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    await assert.rejects(requestCodexSessionSourceRecheck(task.task_id, task.source_ref, options), /CODEX_SESSION_INDEX_BUSY/);
    lock.close(); lock = null;
    const current = JSON.parse(await readFile(f.state, "utf8"));
    Object.values(current.sources as Record<string, { task_ids: string[] }>)[0]!.task_ids = [];
    await writeFile(f.state, JSON.stringify(current));
    assert.equal((await requestCodexSessionSourceRecheck(task.task_id, task.source_ref, options)).status, "scheduled");
    assert.equal((await requestCodexSessionSourceRecheck(task.task_id, task.source_ref, options)).status, "already_pending");
    await f.writeSession(f.turn("request-recheck", "检查来源重扫请求", "重写后的不同任务结果"));
    await runCodexSessionCollectionOnce(options);
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 0);
  } finally { lock?.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("scheduled recheck survives temporary source disappearance", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("missing-recheck", "检查来源暂时缺失", "已核实任务来源和结果"));
    const options = { sessions_root: f.sessions, state_file: f.state, checked_session_ids: ["session-a"] };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    const evidence = { evidence_id: "missing-evidence", session_id: "session-a", turn_id: "missing-recheck", context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    await reconcileCodexSessionTaskEvidence([evidence], options);
    assert.equal((await requestCodexSessionSourceRecheck(task.task_id, task.source_ref, options)).status, "scheduled");
    const hidden = join(f.root, "temporarily-missing.jsonl");
    await rename(f.file, hidden);
    await runCodexSessionCollectionOnce(options);
    assert.equal((await resolveCodexHostEvidenceArchive("missing-evidence", options)).status, "unavailable");
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 0);
    await rename(hidden, f.file);
    await runCodexSessionCollectionOnce(options);
    assert.equal((await resolveCodexHostEvidenceArchive("missing-evidence", options)).status, "matched");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("touching an unchanged verified source preserves its evidence after rechecking", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("touch-turn", "检查来源变化后的证据绑定", "已核实任务来源和验证结果"));
    const options = { sessions_root: f.sessions, state_file: f.state, checked_session_ids: ["session-a"] };
    await runCodexSessionCollectionOnce(options);
    const evidence = { evidence_id: "touch-evidence", session_id: "session-a", turn_id: "touch-turn", context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
    await utimes(f.file, new Date(1000), new Date(1000));
    await runCodexSessionCollectionOnce(options);
    const binding = await resolveCodexHostEvidenceArchive("touch-evidence", options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition });
    assert.equal(binding.status, "matched", JSON.stringify({ binding, excerpt }));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("partial source recheck blocks old evidence until the full task is scanned", async () => {
  const f = await fixture();
  try {
    const lines = f.turn("partial-recheck", "检查部分重扫的证据隔离", "已核实任务来源和结果");
    lines.splice(4, 0, ...Array.from({ length: 80 }, () => f.event({ type: "unrelated_progress", turn_id: "partial-recheck" })));
    await f.writeSession(lines);
    const options = { sessions_root: f.sessions, state_file: f.state, checked_session_ids: ["session-a"] };
    await runCodexSessionCollectionOnce(options);
    const evidence = { evidence_id: "partial-evidence", session_id: "session-a", turn_id: "partial-recheck", context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    await utimes(f.file, new Date(1000), new Date(1000));
    assert.equal((await runCodexSessionCollectionOnce({ ...options, max_bytes: 1024 })).status, "partial");
    const pending = await codexSessionEvidenceBatch({ ...options, recheck_verified: false });
    assert.equal(pending.tasks_pending, 0);
    assert.equal(pending.tasks_source_recheck_pending, 1);
    assert.deepEqual(pending.session_ids, []);
    assert.equal((await codexSessionTaskBatch(task.dataset_partition, options)).excluded_source_recheck_pending, 1);
    assert.equal((await resolveCodexHostEvidenceArchive("partial-evidence", options)).status, "unavailable");
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 0);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_source_recheck_pending");
    for (let i = 0; i < 100; i++) {
      if ((await runCodexSessionCollectionOnce({ ...options, max_bytes: 1024 })).status === "completed") break;
    }
    assert.equal((await resolveCodexHostEvidenceArchive("partial-evidence", options)).status, "matched");
    assert.equal((await codexSessionEvidenceBatch({ ...options, recheck_verified: false })).tasks_source_recheck_pending, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("another rewrite during a partial recheck cannot erase the old evidence quarantine", async () => {
  const f = await fixture();
  try {
    const lines = f.turn("repeat-rewrite", "检查重扫中再次重写", "已核实原始任务结果");
    lines.splice(4, 0, ...Array.from({ length: 80 }, () => f.event({ type: "unrelated_progress", turn_id: "repeat-rewrite" })));
    await f.writeSession(lines);
    const options = { sessions_root: f.sessions, state_file: f.state, checked_session_ids: ["session-a"] };
    await runCodexSessionCollectionOnce(options);
    const evidence = { evidence_id: "repeat-evidence", session_id: "session-a", turn_id: "repeat-rewrite", context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
    await utimes(f.file, new Date(1000), new Date(1000));
    assert.equal((await runCodexSessionCollectionOnce({ ...options, max_bytes: 1024 })).status, "partial");
    await f.writeSession(f.turn("repeat-rewrite", "检查重扫中再次重写", "完全不同的任务结果"));
    await runCodexSessionCollectionOnce(options);
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 0);
    assert.equal((await resolveCodexHostEvidenceArchive("repeat-evidence", options)).status, "unavailable");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const phase of ["before_rename", "after_rename"] as const) {
  test(`rewritten source remains quarantined after interrupted recheck ${phase}`, { timeout: 15_000 }, async () => {
    const f = await fixture(); let child: ReturnType<typeof spawn> | undefined;
    try {
      await f.writeSession(f.turn("crash-recheck", "检查重扫中断的证据隔离", "旧任务内容".repeat(500)));
      const options = { sessions_root: f.sessions, state_file: f.state, checked_session_ids: ["session-a"] };
      await runCodexSessionCollectionOnce(options);
      const evidence = { evidence_id: "crash-evidence", session_id: "session-a", turn_id: "crash-recheck", context_receipt_id: "receipt",
        verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
        verification_outcome: "passed", verified: true, content_stored: false };
      assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
      await f.writeSession(f.turn("crash-recheck", "检查重扫中断的证据隔离", "新任务内容"));
      const moduleUrl = new URL("../core/codex-session-archive.ts", import.meta.url).href;
      const script = `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
        const original = fs.rename.bind(fs); const target = process.env.CRAFT_TEST_STATE;
        fs.rename = async (from, to) => { if (to === target) { if (process.env.CRAFT_TEST_PHASE === 'after_rename') await original(from, to);
          process.stdout.write('ready\\n'); await new Promise(() => setInterval(() => {}, 1000)); } return original(from, to); };
        syncBuiltinESMExports(); const { runCodexSessionCollectionOnce } = await import(${JSON.stringify(moduleUrl)});
        await runCodexSessionCollectionOnce(JSON.parse(process.env.CRAFT_TEST_OPTIONS));`;
      child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CRAFT_TEST_STATE: f.state, CRAFT_TEST_PHASE: phase, CRAFT_TEST_OPTIONS: JSON.stringify({ ...options, max_bytes: 1024 }) } });
      await new Promise<void>((resolveReady, reject) => { child!.once("error", reject); child!.stdout!.once("data", () => resolveReady()); child!.once("exit", code => reject(new Error(`writer exited early: ${code}`))); });
      const exited = new Promise<void>(resolveExit => child!.once("exit", () => resolveExit())); child.kill("SIGTERM"); await exited;
      assert.equal((await resolveCodexHostEvidenceArchive("crash-evidence", options)).status, "unavailable");
      await runCodexSessionCollectionOnce(options);
      assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 0);
      assert.equal((await resolveCodexHostEvidenceArchive("crash-evidence", options)).status, "unavailable");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("freezes historical session partition across source rewrites", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("turn-a", "original task"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const task = Object.values(state.tasks)[0] as { dataset_partition: string; dataset_split_version: string };
    task.dataset_partition = task.dataset_partition === "held_out" ? "candidate_generation" : "held_out";
    task.dataset_split_version = "codex-session-split-v1";
    const originalPartition = task.dataset_partition;
    delete state.session_partitions;
    delete state.session_split_versions;
    await writeFile(f.state, JSON.stringify(state));
    await f.writeSession(f.turn("turn-a", "a rewritten task with different length"));
    await runCodexSessionCollectionOnce(options);
    const after = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal((Object.values(after.tasks)[0] as { dataset_partition: string }).dataset_partition, originalPartition);
    assert.equal(Object.values(after.session_partitions)[0], originalPartition);
    assert.equal(Object.values(after.session_split_versions)[0], "codex-session-split-v1");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("three session partitions exclude repeated task goals from every group", async () => {
  const f = await fixture();
  try {
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const sessions = new Map<string, string>();
    for (let i = 0; sessions.size < 3 && i < 1000; i++) {
      const id = `split-test-${i}`;
      const group = parseInt(digest(id).slice(0, 8), 16) % 5 === 0 ? "held_out"
        : parseInt(digest(`development\0${id}`).slice(0, 8), 16) % 4 === 0 ? "development" : "candidate_generation";
      if (!sessions.has(group)) sessions.set(group, id);
    }
    assert.equal(sessions.size, 3);
    for (const [group, id] of sessions) {
      const turn = f.turn(`turn-${group}`, "验证相同任务目标", "任务完成");
      turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: `turn-${group}`,
        item: { type: "CommandExecution", id: "test", command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }));
      await writeFile(join(dirname(f.file), `${group}.jsonl`), [f.record("session_meta", { session_id: id, cwd: f.project }), ...turn].join("\n") + "\n");
    }
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const indexed = Object.values(state.tasks);
    assert.equal(new Set(indexed.map(task => task.source_ref)).size, 3, "source refs bind session and turn identity");
    assert.equal(new Set(indexed.map(task => task.task_goal_digest)).size, 1, "repeated goals need a separate cross-partition check");
    for (const group of ["candidate_generation", "development", "held_out"] as const) {
      const task = Object.values(state.tasks).find(item => item.dataset_partition === group)!;
      assert.ok(task);
      const batch = await codexSessionTaskBatch(group, options);
      assert.equal(batch.indexed_partition_tasks, 1);
      assert.equal(batch.excluded_cross_partition_task_goal_overlap, 1);
      assert.deepEqual(batch.tasks, []);
      assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: group })).reason, "cross_partition_task_goal_overlap");
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("session partition remains frozen when a rewritten source temporarily has no tasks", async () => {
  const f = await fixture();
  try {
    const options = { sessions_root: f.sessions, state_file: f.state };
    await f.writeSession(f.turn("turn-a", "first task"));
    await runCodexSessionCollectionOnce(options);
    const original = JSON.parse(await readFile(f.state, "utf8"));
    const expected = (Object.values(original.tasks)[0] as { dataset_partition: string }).dataset_partition;
    await f.writeSession([]);
    await runCodexSessionCollectionOnce(options);
    const empty = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(Object.keys(empty.tasks).length, 0);
    assert.equal(Object.values(empty.session_partitions)[0], expected);
    await f.writeSession(f.turn("turn-b", "new task after rewrite"));
    await runCodexSessionCollectionOnce(options);
    const after = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal((Object.values(after.tasks)[0] as { dataset_partition: string }).dataset_partition, expected);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects unknown task split labels and versions instead of reclassifying them", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("turn-a", "task"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const original = JSON.parse(await readFile(f.state, "utf8"));
    for (const mutation of [{ dataset_partition: "unknown" }, { dataset_partition: "development", dataset_split_version: "codex-session-split-v1" }, { dataset_partition: null }, { dataset_partition: undefined, dataset_split_version: "codex-session-split-v2" }, { dataset_split_version: "future-version" }]) {
      const state = structuredClone(original);
      Object.assign(Object.values(state.tasks)[0] as object, mutation);
      await writeFile(f.state, JSON.stringify(state));
      await assert.rejects(codexSessionTaskBatch("held_out", options), /task index is invalid/u);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects a malformed session partition registry", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("turn-a", "task"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    for (const invalid of [null, [], { bad_key: "held_out" }, { ["a".repeat(64)]: "unexpected" }]) {
      state.session_partitions = invalid;
      await writeFile(f.state, JSON.stringify(state));
      await assert.rejects(codexSessionTaskBatch("held_out", options), /partition registry is invalid/u);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects malformed and orphan session split versions", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("turn-a", "task"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const original = JSON.parse(await readFile(f.state, "utf8"));
    for (const invalid of [null, [], { bad_key: "codex-session-split-v2" }, { ["a".repeat(64)]: "unknown" }, { ["a".repeat(64)]: "codex-session-split-v2" }]) {
      const state = structuredClone(original);
      state.session_split_versions = invalid;
      await writeFile(f.state, JSON.stringify(state));
      await assert.rejects(codexSessionTaskBatch("held_out", options), /version registry is invalid/u);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects conflicting dataset partitions within one session", async () => {
  const f = await fixture();
  try {
    await f.writeSession([...f.turn("turn-a", "first task"), ...f.turn("turn-b", "second task")]);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const tasks = Object.values(state.tasks) as Array<{ dataset_partition: string }>;
    assert.equal(tasks.length, 2);
    tasks[1]!.dataset_partition = tasks[0]!.dataset_partition === "held_out" ? "candidate_generation" : "held_out";
    await writeFile(f.state, JSON.stringify(state));
    await assert.rejects(codexSessionTaskBatch("held_out", options), /dataset partition conflict/u);
    await assert.rejects(runCodexSessionCollectionOnce(options), /dataset partition conflict/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

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
    assert.equal(Number(third.tasks_candidate_generation) + Number(third.tasks_development) + Number(third.tasks_held_out), 2);
    const partitioned = Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, { dataset_partition: string; dataset_split_version: string }>);
    assert.equal(new Set(partitioned.map(task => task.dataset_partition)).size, 1);
    assert.equal(partitioned.every(task => task.dataset_split_version === "codex-session-split-v2"), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("indexes digest-only evidence from completed Codex shell test commands for its split batch", async () => {
  const f = await fixture();
  try {
    const command = `cd '${f.project}' && pnpm test`;
    const summary = "Tests 3 passed (3)";
    const turn = f.turn("test-evidence-turn", "整理项目测试验证流程", "依赖调整后通过测试");
    turn.splice(turn.length - 1, 0, ...Array.from({ length: 10 }, (_, index) => f.event({ type: "item_completed", turn_id: "test-evidence-turn",
      item: { type: "CommandExecution", id: `command-${index}`, command: ["/bin/zsh", "-lc", command],
        aggregated_output: [{ type: "text", text: summary }], exit_code: 0, status: "completed" } })));
    await f.writeSession(turn);
    const env = { CRAFT_DATA_DIR: join(f.root, "data") } as NodeJS.ProcessEnv;
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options, env);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    assert.equal(task.verification_status, "unverified", "transcript evidence remains distinct from a Context receipt");
    assert.equal(task.verification_artifact_count, 8, "the archive retains only the first eight successful tests");
    assert.match(String(task.verification_artifact_digest), /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(await readFile(f.state, "utf8"), /pnpm test|Tests 3 passed/u);
    const batch = await codexSessionTaskBatch(task.dataset_partition, options, env);
    const candidate = (batch.tasks as JsonObject[])[0]!;
    assert.equal(candidate.task_id, task.task_id);
    assert.equal(candidate.verification_source, "session_test_log");
    assert.equal(candidate.verification_outcome, null, "a passing command does not establish the terminal task outcome");
    assert.deepEqual(candidate.verification_evidence_ids, []);
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id,
      { ...options, expected_partition: task.dataset_partition }, env);
    assert.equal(excerpt.status, "ready");
    assert.equal(excerpt.verification_source, "session_test_log");
    assert.equal(excerpt.verification_outcome, null);
    assert.equal((excerpt.verification_artifacts as JsonObject[]).length, 8);
    assert.equal(excerpt.raw_content_stored, false);

  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("task excerpt agrees with the index when command completion is repeated", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("duplicate-turn", "整理项目测试验证流程", "依赖调整后通过测试");
    const completed = f.event({ type: "item_completed", turn_id: "duplicate-turn", item: { type: "CommandExecution", id: "test", command: "pnpm test",
      aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } });
    turn.splice(turn.length - 1, 0, completed, completed);
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    assert.equal(task.verification_artifact_count, 1);
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition });
    assert.equal(excerpt.status, "ready");
    assert.equal((excerpt.verification_artifacts as JsonObject[]).length, 1);
    const legacy = JSON.parse(await readFile(f.state, "utf8"));
    const source = Object.values(legacy.sources as Record<string, JsonObject>)[0]!;
    source.verification_artifact_index_version = 1;
    delete source.verification_collector_version;
    delete legacy.tasks[task.task_id].verification_artifact_count;
    delete legacy.tasks[task.task_id].verification_artifact_digest;
    await writeFile(f.state, JSON.stringify(legacy));
    await runCodexSessionCollectionOnce(options);
    const backfilled = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(backfilled.tasks[task.task_id].verification_artifact_count, 1);
    assert.equal(Object.values(backfilled.sources as Record<string, JsonObject>)[0]!.verification_artifact_index_version, 3);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).status, "ready");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("held-out transcript evidence reports an unknown terminal outcome", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("held-out-no-outcome", "核验独立任务");
    turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: "held-out-no-outcome", item: { type: "CommandExecution", id: "test", command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const task = Object.values(state.tasks as Record<string, Record<string, unknown>>)[0]!;
    task.dataset_partition = "held_out";
    delete state.session_partitions; // Exercise a legacy index before its registry is established.
    delete state.session_split_versions;
    await writeFile(f.state, JSON.stringify(state));
    const batch = await codexSessionTaskBatch("held_out", options);
    assert.equal((batch.tasks as JsonObject[]).length, 1);
    assert.equal(batch.pending_terminal_outcome, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("incremental indexing pairs function test calls across session appends without persisting command text", async () => {
  const f = await fixture();
  try {
    await f.writeSession([f.event({ type: "task_started", turn_id: "function-turn" }),
      f.response({ type: "message", role: "user", content: [{ type: "input_text", text: "核验项目自动测试结果" }] }),
      f.response({ type: "function_call", call_id: "private-call-id", name: "exec_command", arguments: JSON.stringify({ cmd: "pnpm test" }) })]);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const intermediate = await readFile(f.state, "utf8");
    assert.equal(intermediate.includes("pnpm test"), false);
    assert.equal(intermediate.includes("private-call-id"), false);
    await appendFile(f.file, [f.response({ type: "function_call_output", call_id: "private-call-id", output: "Process exited with code 0\nTests 2 passed (2)" }),
      f.response({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "项目自动测试已经通过" }] }),
      f.event({ type: "task_complete", turn_id: "function-turn" })].join("\n") + "\n");
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    assert.equal(task.verification_artifact_count, 1);
    assert.equal((await codexSessionTaskBatch(task.dataset_partition, options)).tasks instanceof Array, true);
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition });
    assert.equal(excerpt.status, "ready");
    assert.equal((excerpt.verification_artifacts as JsonObject[]).length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("switching turn context does not transfer verification calls into another task", async () => {
  const f = await fixture();
  try {
    await f.writeSession([f.event({ type: "task_started", turn_id: "first" }),
      f.response({ type: "message", role: "user", content: [{ type: "input_text", text: "核验第一个任务结果" }] }),
      f.response({ type: "function_call", call_id: "call", name: "exec_command", arguments: JSON.stringify({ cmd: "pnpm test" }) }),
      f.record("turn_context", { turn_id: "second", cwd: f.project }), f.event({ type: "task_started", turn_id: "second" }),
      f.response({ type: "message", role: "user", content: [{ type: "input_text", text: "核验第二个任务结果" }] }),
      f.response({ type: "function_call_output", call_id: "call", output: "Process exited with code 0\nTests 2 passed (2)" }),
      f.response({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "第二个任务已经结束" }] }),
      f.event({ type: "task_complete", turn_id: "second" })]);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const second = Object.values(state.tasks).find(task => task.turn_id === "second")!;
    assert.equal(second.verification_artifact_count, undefined);
    assert.equal((await readCodexSessionTaskExcerpt(second.task_id, { ...options, expected_partition: second.dataset_partition })).status, "ineligible");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("task excerpt rejects conflicting structured command records", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("conflict-turn", "整理项目测试验证流程", "依赖调整后通过测试");
    const item = { type: "CommandExecution", id: "test", command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" };
    turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: "conflict-turn", item }),
      f.event({ type: "item_completed", turn_id: "conflict-turn", item: { ...item, exit_code: 1 } }));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition });
    assert.deepEqual(excerpt, { status: "ineligible", reason: "task_structured_call_conflict", raw_content_stored: false });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("task excerpt reports structured call tracking overflow explicitly", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("structured-overflow-turn", "整理项目测试验证流程", "依赖调整后通过测试");
    turn.splice(turn.length - 1, 0, ...Array.from({ length: 4097 }, (_, index) => f.event({ type: "item_completed", turn_id: "structured-overflow-turn",
      item: { type: "CommandExecution", id: `command-${index}`, command: index ? "echo ok" : "pnpm test",
        aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } })));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition });
    assert.deepEqual(excerpt, { status: "ineligible", reason: "task_structured_call_tracking_limit_exceeded", raw_content_stored: false });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("complete evidence recheck invalidates a missing receipt and allows later recovery", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("receipt-recheck", "验证真实任务", "任务完成"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const task = Object.values((JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks)[0]!;
    const evidence = { evidence_id: "receipt-evidence", session_id: task.session_id, turn_id: task.turn_id, context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
    assert.equal((await reconcileCodexSessionTaskEvidence([], options)).tasks_invalidated, 0);
    const invalidated = await reconcileCodexSessionTaskEvidence([], { ...options, checked_session_ids: [task.session_id] });
    assert.equal(invalidated.tasks_invalidated, 1);
    const invalidState = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    assert.deepEqual(invalidState.tasks[task.task_id]!.verification_last_invalidation, { reason: "evidence_missing", evidence_ids: ["receipt-evidence"], context_receipt_id: "receipt", verification_ref_digest: evidence.verification_ref_digest, terminal_identity_digest: evidence.terminal_identity_digest });
    invalidState.tasks[task.task_id] = { ...invalidState.tasks[task.task_id]!, verification_artifact_digest: `sha256:${"c".repeat(64)}`, verification_artifact_count: 1 };
    await writeFile(f.state, JSON.stringify(invalidState));
    const invalidBatch = await codexSessionTaskBatch(task.dataset_partition, options);
    assert.deepEqual(invalidBatch.tasks, []);
    assert.equal(invalidBatch.excluded_invalidated_evidence, 1);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_terminal_evidence_invalidated");
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
    const recovered = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    assert.equal(recovered.tasks[task.task_id]!.verification_invalidated, undefined);
    assert.equal(recovered.tasks[task.task_id]!.verification_last_invalidation?.reason, "evidence_missing");
    const incompatible = await reconcileCodexSessionTaskEvidence([{ ...evidence, host: "another-host" }], { ...options, checked_session_ids: [task.session_id] });
    assert.equal(incompatible.tasks_invalidated, 1);
    const mismatch = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    assert.equal(mismatch.tasks[task.task_id]!.verification_last_invalidation?.reason, "identity_mismatch");
    assert.deepEqual((await codexSessionTaskBatch(task.dataset_partition, options)).tasks, []);
    const invalidAudit = JSON.parse(await readFile(f.state, "utf8"));
    invalidAudit.tasks[task.task_id].verification_last_invalidation.verification_ref_digest = "not-a-digest";
    await writeFile(f.state, JSON.stringify(invalidAudit));
    await assert.rejects(codexSessionTaskBatch(task.dataset_partition, options), /task index is invalid/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("failed terminal outcomes remain ineligible across evidence invalidation and recovery", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("failed-recheck", "验证失败任务", "任务验证失败"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const task = Object.values((JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks)[0]!;
    const evidence = { evidence_id: "failed-evidence", session_id: task.session_id, turn_id: task.turn_id, context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "failed", verified: true, content_stored: false };
    for (const replacement of [[], [{ ...evidence, host: "another-host" }]]) {
      assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
      assert.equal((await reconcileCodexSessionTaskEvidence(replacement, { ...options, checked_session_ids: [task.session_id] })).tasks_invalidated, 1);
      const invalid = (JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks[task.task_id]!;
      assert.equal(invalid.verification_outcome, "failed");
      assert.equal(invalid.verification_invalidated, true);
      assert.deepEqual((await codexSessionTaskBatch(task.dataset_partition, options)).tasks, []);
      assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_terminal_evidence_invalidated");
    }
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_terminal_outcome_failed");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rechecks verified sessions and keeps conflicting terminal evidence quarantined", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("conflicting-terminal", "整理项目测试验证流程", "依赖调整后通过测试"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const task = Object.values((JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks)[0]!;
    const evidence = { evidence_id: "original", session_id: task.session_id, turn_id: task.turn_id, context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
    assert.deepEqual((await codexSessionEvidenceBatch(options)).session_ids, [task.session_id]);
    assert.deepEqual((await codexSessionEvidenceBatch({ ...options, recheck_verified: false })).session_ids, []);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence, evidence_id: "correction", verification_outcome: "failed", conflicting_observation_ids: ["observation-conflict"] }], options)).tasks_conflicted, 1);
    const persisted = (JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks[task.task_id]!;
    assert.deepEqual(persisted.verification_conflict, { previous_evidence_ids: ["original"], conflicting_evidence_ids: ["correction"], conflicting_observation_ids: ["observation-conflict"] });
    assert.equal(persisted.verification_status, "unverified");
    assert.equal((await codexSessionEvidenceBatch({ ...options, recheck_verified: false })).tasks_conflicted, 1);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_terminal_evidence_conflict");
    assert.deepEqual((await codexSessionTaskBatch(task.dataset_partition, options)).tasks, []);
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 0);
    const staleState = JSON.parse(await readFile(f.state, "utf8"));
    for (const source of Object.values(staleState.sources) as Array<Record<string, unknown>>) source.verification_artifact_index_version = 0;
    await writeFile(f.state, JSON.stringify(staleState));
    await runCodexSessionCollectionOnce(options);
    const reindexed = (JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks[task.task_id]!;
    assert.deepEqual(reindexed.verification_conflict, persisted.verification_conflict);
    await f.writeSession(f.turn("conflicting-terminal", "整理项目测试验证流程", "重新执行后已经完成项目测试验证"));
    await runCodexSessionCollectionOnce(options);
    const rewritten = (JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks[task.task_id]!;
    assert.deepEqual(rewritten.verification_conflict, persisted.verification_conflict);
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("quarantines a legacy verified task without stored evidence IDs", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("legacy-conflict", "整理项目测试验证流程", "依赖调整后通过测试"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const task = Object.values(state.tasks)[0] as CodexSessionTaskIndex;
    const evidence = { evidence_id: "new", session_id: task.session_id, turn_id: task.turn_id, context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    await reconcileCodexSessionTaskEvidence([evidence], options);
    const legacy = JSON.parse(await readFile(f.state, "utf8"));
    delete legacy.tasks[task.task_id].verification_evidence_ids;
    await writeFile(f.state, JSON.stringify(legacy));
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence, verification_outcome: "failed" }], options)).tasks_conflicted, 1);
    const result = JSON.parse(await readFile(f.state, "utf8"));
    assert.deepEqual(result.tasks[task.task_id].verification_conflict.previous_evidence_ids, []);
    result.tasks[task.task_id].verification_status = "verified";
    delete result.tasks[task.task_id].verification_conflict;
    delete result.tasks[task.task_id].verification_evidence_ids;
    await writeFile(f.state, JSON.stringify(result));
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence, project_scope_id: "project:other" }], options)).tasks_conflicted, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("quarantines a verified task when the Host receipt belongs to a different project", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("scope-conflict", "整理项目测试验证流程", "依赖调整后通过测试"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const task = Object.values((JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks)[0]!;
    const evidence = { evidence_id: "original", host: "codex", session_id: task.session_id, turn_id: task.turn_id, context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 1);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence, project_scope_id: "project:other" }], options)).tasks_conflicted, 1);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_terminal_evidence_conflict");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("quarantines an unverified task when the Host receipt belongs to a different project", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("scope-conflict-pending", "整理项目测试验证流程"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const task = Object.values((JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks)[0]!;
    const evidence = { evidence_id: "other-project-evidence", host: "codex", session_id: task.session_id, turn_id: task.turn_id,
      context_receipt_id: "receipt", verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false, project_scope_id: "project:other" };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_conflicted, 1);
    const saved = (JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks[task.task_id]!;
    assert.deepEqual(saved.verification_conflict?.conflicting_evidence_ids, ["other-project-evidence"]);
    assert.equal((await codexSessionEvidenceBatch({ ...options, recheck_verified: false })).tasks_pending, 0);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_terminal_evidence_conflict");
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence, project_scope_id: task.project_scope_id }], options)).tasks_verified, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("quarantines conflicting initial terminal outcomes or identities across later polls", async () => {
  for (const change of [{ verification_outcome: "failed" }, { terminal_identity_digest: `sha256:${"c".repeat(64)}` }]) {
    const f = await fixture();
    try {
      await f.writeSession(f.turn("initial-conflict", "整理项目测试验证流程", "依赖调整后通过测试"));
      const options = { sessions_root: f.sessions, state_file: f.state };
      await runCodexSessionCollectionOnce(options);
      const task = Object.values((JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks)[0]!;
      const evidence = { evidence_id: "first", session_id: task.session_id, turn_id: task.turn_id, context_receipt_id: "receipt",
        verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
        verification_outcome: "passed", verified: true, content_stored: false };
      assert.equal((await reconcileCodexSessionTaskEvidence([evidence, { ...evidence, ...change, evidence_id: "second" }], options)).tasks_conflicted, 1);
      assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 0);
      const saved = (JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks[task.task_id]!;
      assert.deepEqual(saved.verification_conflict?.conflicting_evidence_ids, ["first", "second"]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("quarantines an unverified task when the Host reports contradictory evidence", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("upstream-conflict", "整理项目测试验证流程", "依赖调整后通过测试"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const task = Object.values((JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks)[0]!;
    const conflict = { evidence_id: "upstream-conflict-evidence", session_id: task.session_id, turn_id: task.turn_id, context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "conflict", evidence_conflict: true, verified: false, content_stored: false, conflicting_observation_ids: ["observation-a", "observation-b"] };
    assert.equal((await reconcileCodexSessionTaskEvidence([conflict], options)).tasks_conflicted, 1);
    const conflicted = (JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks[task.task_id]!;
    assert.deepEqual(conflicted.verification_conflict?.conflicting_observation_ids, ["observation-a", "observation-b"]);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_terminal_evidence_conflict");
    const retryState = JSON.parse(await readFile(f.state, "utf8"));
    delete retryState.tasks[task.task_id].verification_conflict;
    await writeFile(f.state, JSON.stringify(retryState));
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...conflict, conflicting_observation_ids: [] }], options)).tasks_conflicted, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("legacy project identities are excluded until an incremental reindex binds a real root", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("identity-backfill", "整理项目测试验证流程", "依赖调整后通过测试");
    turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: "identity-backfill", item: { type: "CommandExecution",
      id: "identity-test", command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const task = Object.values(state.tasks)[0] as CodexSessionTaskIndex;
    const canonicalScope = task.project_scope_id;
    state.tasks[task.task_id].project_scope_id = "project:legacy-short-id";
    await writeFile(f.state, JSON.stringify(state));
    assert.equal((await codexSessionTaskBatch(task.dataset_partition, options)).excluded_project_identity, 1);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_project_identity_unverified");
    assert.equal((await reconcileCodexSessionTaskEvidence([{ evidence_id: "short-id-evidence", session_id: task.session_id, turn_id: task.turn_id, context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false }], options)).tasks_verified, 0);
    state.tasks[task.task_id].project_scope_id = canonicalScope;
    delete state.tasks[task.task_id].project_identity_version;
    for (const source of Object.values(state.sources) as Array<Record<string, unknown>>) delete source.project_identity_index_version;
    await writeFile(f.state, JSON.stringify(state));
    assert.deepEqual((await codexSessionTaskBatch(task.dataset_partition, options)).tasks, []);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_project_identity_unverified");
    const evidence = { evidence_id: "legacy-evidence", session_id: task.session_id, turn_id: task.turn_id, context_receipt_id: "receipt",
      verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false };
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence], options)).tasks_verified, 0);
    await runCodexSessionCollectionOnce(options);
    const updated = (JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks[task.task_id]!;
    assert.equal(updated.project_identity_version, 1);
    assert.equal((await codexSessionTaskBatch(task.dataset_partition, options)).tasks instanceof Array, true);
    assert.equal(((await codexSessionTaskBatch(task.dataset_partition, options)).tasks as JsonObject[]).length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("identity backfill reports unprocessed legacy sessions until every page is indexed", async () => {
  const f = await fixture();
  try {
    await f.writeSession(f.turn("identity-backfill", "整理项目测试流程"));
    await writeFile(join(dirname(f.file), "session-b.jsonl"), (await readFile(f.file, "utf8")).replaceAll("session-a", "session-b"));
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    for (const source of Object.values(state.sources) as Array<Record<string, unknown>>) delete source.project_identity_index_version;
    await writeFile(f.state, JSON.stringify(state));
    const first = await runCodexSessionCollectionOnce({ ...options, max_files: 1 });
    assert.equal(first.status, "partial");
    assert.equal(first.sessions_pending, 1);
    const second = await runCodexSessionCollectionOnce({ ...options, max_files: 1 });
    assert.equal(second.status, "completed");
    assert.equal(second.sessions_pending, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("missing project roots stay unscoped and cannot enter a task batch", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("missing-root", "整理项目测试验证流程", "依赖调整后通过测试");
    turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: "missing-root", item: { type: "CommandExecution", id: "test",
      command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }));
    await f.writeSession(turn);
    await rm(f.project, { recursive: true });
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const task = Object.values((JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> }).tasks)[0]!;
    assert.equal(task.project_scope_id, null);
    assert.deepEqual((await codexSessionTaskBatch(task.dataset_partition, options)).tasks, []);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_project_identity_unverified");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("task excerpt reports custom call tracking overflow explicitly", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("overflow-turn", "整理项目测试验证流程", "依赖调整后通过测试");
    turn.splice(turn.length - 1, 0,
      f.event({ type: "item_completed", turn_id: "overflow-turn", item: { type: "CommandExecution", id: "test", command: "pnpm test",
        aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }),
      ...Array.from({ length: 4097 }, (_, index) => f.response({ type: "custom_tool_call", name: "exec", call_id: `call-${index}`, input: "echo ok" })));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex>; sources: Record<string, Record<string, unknown>> };
    const task = Object.values(state.tasks)[0]!;
    assert.equal(task.verification_transcript_error, "task_custom_call_tracking_limit_exceeded");
    assert.equal(((await codexSessionTaskBatch(task.dataset_partition, options)).tasks as unknown[]).length, 0);
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition });
    assert.deepEqual(excerpt, { status: "ineligible", reason: "task_custom_call_tracking_limit_exceeded", raw_content_stored: false });
    // Old v2 indexes did not flag this overflow; reopening must reindex them.
    Object.values(state.sources)[0]!.verification_artifact_index_version = 2;
    delete (state.tasks[task.task_id] as { verification_transcript_error?: string }).verification_transcript_error;
    await writeFile(f.state, JSON.stringify(state));
    const staleBatch = await codexSessionTaskBatch(task.dataset_partition, options);
    assert.equal((staleBatch.tasks as unknown[]).length, 0);
    assert.equal(staleBatch.excluded_verification_index_incomplete, 1);
    assert.equal((await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition })).reason, "task_verification_index_incomplete");
    await runCodexSessionCollectionOnce(options);
    const upgraded = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex>; sources: Record<string, Record<string, unknown>> };
    assert.equal(Object.values(upgraded.sources)[0]!.verification_artifact_index_version, 3);
    assert.equal(upgraded.tasks[task.task_id]?.verification_transcript_error, "task_custom_call_tracking_limit_exceeded");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("sanitizes Chinese and English credential labels before returning task excerpts", async () => {
  const f = await fixture();
  try {
    const goal = "检查接口账号是synthetic-account 密钥是synthetic-secret-value 并确认权限";
    const finalText = "复核通过：密码为synthetic-password-value，令牌是synthetic-token-value。";
    const turn = f.turn("credential-turn", goal, finalText);
    turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: "credential-turn", item: {
      type: "CommandExecution", id: "credential-test", command: ["/bin/zsh", "-lc", `cd '${f.project}' && pnpm test`],
      aggregated_output: [{ type: "text", text: "Tests 3 passed (3)" }], exit_code: 0, status: "completed",
    } }));
    await f.writeSession(turn);
    const env = { CRAFT_DATA_DIR: join(f.root, "data") } as NodeJS.ProcessEnv;
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options, env);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id,
      { ...options, expected_partition: task.dataset_partition }, env);
    assert.equal(excerpt.status, "ready");
    assert.match(String(excerpt.task_goal), /\[已脱敏\]/u);
    assert.match(String(excerpt.task_result), /\[已脱敏\]/u);
    assert.doesNotMatch(JSON.stringify(excerpt), /synthetic-account|synthetic-secret-value|synthetic-password-value|synthetic-token-value/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("backfills transcript evidence from unchanged indexed sessions without losing Context verification", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("migrated-test-turn", "迁移会话索引并验证测试结果", "索引迁移后验证继续可追溯");
    turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: "migrated-test-turn", item: { type: "CommandExecution",
      id: "migration-test", command: ["/bin/zsh", "-lc", `cd '${f.project}' && pnpm test`], aggregated_output: "Tests 2 passed (2)",
      exit_code: 0, status: "completed" } }));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    await reconcileCodexSessionTaskEvidence([{ evidence_id: "context-evidence", session_id: "session-a", turn_id: "migrated-test-turn",
      context_receipt_id: "context-receipt", verification_ref_digest: `sha256:${"a".repeat(64)}`,
      terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false }], options);
    const prior = JSON.parse(await readFile(f.state, "utf8")) as { sources: Record<string, JsonObject>; tasks: Record<string, JsonObject> };
    const source = Object.values(prior.sources)[0]!;
    source.verification_artifact_index_version = 0;
    const task = Object.values(prior.tasks)[0]!;
    delete task.verification_artifact_digest;
    delete task.verification_artifact_count;
    await writeFile(f.state, JSON.stringify(prior));
    const migration = await runCodexSessionCollectionOnce(options);
    assert.equal(migration.sessions_processed, 1);
    const updated = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const result = Object.values(updated.tasks)[0]!;
    assert.equal(result.verification_status, "verified");
    assert.deepEqual(result.verification_evidence_ids, ["context-evidence"]);
    assert.equal(result.verification_artifact_count, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("resumes partial transcript-evidence backfill from its persisted byte cursor", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("partial-backfill-turn", "验证大日志回填游标", "大日志已按预算持续处理");
    turn.splice(4, 0, ...Array.from({ length: 80 }, () => f.event({ type: "unrelated_progress", turn_id: "partial-backfill-turn" })));
    await f.writeSession(turn);
    const env = { CODEX_HOME: join(f.root, "codex"), CRAFT_DATA_DIR: join(f.root, "data") } as NodeJS.ProcessEnv;
    const options = { sessions_root: f.sessions, state_file: f.state, max_files: 1, max_bytes: 1_024 };
    await runCodexSessionCollectionOnce(options, env);
    const prior = JSON.parse(await readFile(f.state, "utf8")) as { sources: Record<string, JsonObject> };
    const source = Object.values(prior.sources)[0]!;
    delete source.verification_artifact_index_version;
    await writeFile(f.state, JSON.stringify(prior));

    const first = await runCodexSessionCollectionOnce(options, env);
    const afterFirst = JSON.parse(await readFile(f.state, "utf8")) as { sources: Record<string, JsonObject> };
    const firstOffset = Number(Object.values(afterFirst.sources)[0]!.processed_bytes);
    assert.equal(Object.values(afterFirst.sources)[0]!.verification_artifact_index_version, 0);
    assert.equal(first.status, "partial");

    const second = await runCodexSessionCollectionOnce(options, env);
    const afterSecond = JSON.parse(await readFile(f.state, "utf8")) as { sources: Record<string, JsonObject> };
    const secondSource = Object.values(afterSecond.sources)[0]!;
    assert.equal(second.status, "partial");
    assert.ok(Number(secondSource.processed_bytes) > firstOffset, "the next pass must continue after the first byte cursor");
    assert.equal(secondSource.verification_artifact_index_version, 0, "the source remains marked as a resumable backfill until complete");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("resumes legacy active turns that predate transcript artifact accumulation", async () => {
  const f = await fixture();
  try {
    await f.writeSession([f.event({ type: "task_started", turn_id: "legacy-active-turn" }),
      f.response({ type: "message", role: "user", content: [{ type: "input_text", text: "继续验证项目测试结果" }] })]);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { sources: Record<string, JsonObject> };
    const source = Object.values(state.sources)[0]!;
    delete ((source.active_turn as JsonObject).verification_artifacts);
    await writeFile(f.state, JSON.stringify(state));
    await appendFile(f.file, [f.event({ type: "item_completed", turn_id: "legacy-active-turn", item: { type: "CommandExecution",
      id: "legacy-test", command: ["/bin/zsh", "-lc", `cd '${f.project}' && pnpm test`], aggregated_output: "Tests 2 passed (2)",
      exit_code: 0, status: "completed" } }), f.response({ type: "message", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "已完成测试验证并确认结果稳定" }] }),
      f.event({ type: "task_complete", turn_id: "legacy-active-turn", completed_at: "2026-10-20T00:02:00Z" })].join("\n") + "\n");
    await runCodexSessionCollectionOnce(options);
    const resumed = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    assert.equal(Object.values(resumed.tasks)[0]?.verification_artifact_count, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects transcript evidence when its indexed digest no longer matches the source task", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("tampered-artifact-turn", "验证任务测试证据摘要", "测试结果已经确认通过");
    turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: "tampered-artifact-turn", item: { type: "CommandExecution",
      id: "digest-test", command: ["/bin/zsh", "-lc", `cd '${f.project}' && pnpm test`], aggregated_output: "Tests 2 passed (2)",
      exit_code: 0, status: "completed" } }));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, JsonObject> };
    const task = Object.values(state.tasks)[0]!;
    task.verification_artifact_digest = `sha256:${"c".repeat(64)}`;
    await writeFile(f.state, JSON.stringify(state));
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: task.dataset_partition as "candidate_generation" | "held_out" });
    assert.equal(excerpt.status, "ineligible");
    assert.equal(excerpt.reason, "transcript_test_evidence_digest_mismatch");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("batches multiple verified tasks in chronological order with stable identity ties", async () => {
  const f = await fixture();
  try {
    const ids = ["late", "undated-a", "early-a", "undated-b", "early-b"];
    const lines = ids.flatMap(id => {
      const turn = f.turn(id, "核验任务排序", "该独立任务结果已核验");
      turn[turn.length - 1] = f.event({ type: "task_complete", turn_id: id,
        ...(id.startsWith("undated") ? {} : { completed_at: id === "late" ? "2026-10-21T00:00:00Z" : "2026-10-20T00:00:00Z" }) });
      return turn;
    });
    await f.writeSession(lines);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    await reconcileCodexSessionTaskEvidence(ids.map(id => ({ evidence_id: `verified-${id}`, session_id: "session-a", turn_id: id,
      context_receipt_id: `receipt-${id}`, verification_ref_digest: `sha256:${"a".repeat(64)}`,
      terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false })), options);
    const tasks = (await codexSessionTaskBatch("candidate_generation", options)).tasks as CodexSessionTaskIndex[];
    assert.equal(tasks.length, 5);
    assert.deepEqual(tasks.map(task => task.completed_at), [null, null, "2026-10-20T00:00:00Z", "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z"]);
    assert(tasks[0]!.task_id < tasks[1]!.task_id);
    assert(tasks[2]!.task_id < tasks[3]!.task_id);
    assert.equal(tasks[4]!.turn_id, "late");
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

test("blocks the same project task goal from crossing candidate and held-out evaluation", async () => {
  const f = await fixture();
  try {
    const goal = "修复跨会话重复任务的评测集泄漏";
    await writeFile(f.file, [f.record("session_meta", { session_id: "session-14", cwd: f.project }),
      ...f.turn("held-out-turn", goal)].join("\n") + "\n");
    const candidateFile = join(f.sessions, "2026", "10", "candidate-session.jsonl");
    await writeFile(candidateFile, [f.record("session_meta", { session_id: "session-1", cwd: f.project }),
      ...f.turn("candidate-turn", goal)].join("\n") + "\n");
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const tasks = Object.values(state.tasks);
    assert.equal(tasks.length, 2);
    assert.notEqual(tasks[0]!.dataset_partition, tasks[1]!.dataset_partition);
    assert.equal(tasks[0]!.task_goal_digest, tasks[1]!.task_goal_digest);
    const evidence = tasks.map((task, index) => ({ evidence_id: `evidence-${index}`, session_id: task.session_id,
      turn_id: task.turn_id, context_receipt_id: `receipt-${index}`, verification_ref_digest: `sha256:${String(index).repeat(64)}`,
      terminal_identity_digest: `sha256:${String(index + 2).repeat(64)}`, verification_outcome: "passed", verified: true, content_stored: false }));
    assert.equal((await reconcileCodexSessionTaskEvidence(evidence, { state_file: f.state })).tasks_verified, 2);

    for (const task of tasks) {
      const batch = await codexSessionTaskBatch(task.dataset_partition, { state_file: f.state });
      assert.deepEqual(batch.tasks, []);
      assert.equal(batch.excluded_cross_partition_task_goal_overlap, 1);
      assert.equal((await readCodexSessionTaskExcerpt(task.task_id,
        { sessions_root: f.sessions, state_file: f.state, expected_partition: task.dataset_partition })).reason,
      "cross_partition_task_goal_overlap");
    }
    const reconciled = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    reconciled.tasks[tasks[0]!.task_id] = { ...reconciled.tasks[tasks[0]!.task_id]!, project_scope_id: `project:${"b".repeat(64)}` };
    await writeFile(f.state, JSON.stringify(reconciled));
    for (const task of tasks) {
      const batch = await codexSessionTaskBatch(task.dataset_partition, { state_file: f.state });
      assert.equal((batch.tasks as unknown[]).length, 1);
      assert.equal(batch.excluded_cross_partition_task_goal_overlap, 0);
    }
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
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: join(rootFile, "sessions"), state_file: f.state }), /sessions root must be a regular directory/u);
    const missingParent = await runCodexSessionCollectionOnce({ sessions_root: join(f.root, "missing-parent", "sessions"), state_file: f.state });
    assert.equal(missingParent.status, "source_unavailable");
    await assert.rejects(runCodexSessionCollectionOnce({ sessions_root: "invalid\0sessions", state_file: f.state }), /path|argument|NUL/iu);

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
    assert.ok((await readFile(defaultState, "utf8")).includes("codex-session-collection.v2"));
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
    delete validState.session_partitions;
    delete validState.session_split_versions;
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
    records.splice(2, 0, f.event({ type: "item_completed", turn_id: "verified-turn", item: { type: "CommandExecution", id: "test-command",
      command: "pnpm test", aggregated_output: "Tests 2 passed (2)", exit_code: 0, status: "completed" } }));
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
    assert.equal(taskBeforeVerification.status, "ready", "an exact successful test event is independently attributable to the source task");
    assert.equal(taskBeforeVerification.verification_source, "session_test_log");
    const batch = await codexSessionEvidenceBatch({ state_file: f.state });
    assert.deepEqual(batch.session_ids, ["session-a"]);
    const evidence = [{ evidence_id: "evidence-terminal", session_id: "session-a", turn_id: "verified-turn", task_id: "hook-task",
      context_receipt_id: "receipt-1", verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`,
      verification_outcome: "passed", verified: true, content_stored: false }];
    assert.equal((await reconcileCodexSessionTaskEvidence(null, { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence[0], verified: false }], { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence[0], turn_id: "different-turn" }], { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence[0], host: "other-host" }], { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence[0], task_goal_digest: `sha256:${"d".repeat(64)}` }], { state_file: f.state })).tasks_verified, 0);
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
    assert.equal((excerpt.verification_artifacts as Array<Record<string, unknown>>).length, 1);
    assert.equal((excerpt.verification_artifacts as Array<Record<string, unknown>>)[0]!.runner, "javascript");
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

test("excludes legacy verified tasks when terminal provenance is incomplete", async () => {
  const f = await fixture();
  try {
    await f.writeSession([...f.turn("verified-turn", "完成本轮已经验证的任务"), ...f.turn("pending-turn", "完成本轮等待验证任务")]);
    await runCodexSessionCollectionOnce({ sessions_root: f.sessions, state_file: f.state });
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const verified = Object.values(state.tasks as Record<string, { task_id: string; turn_id: string; task_goal_digest?: string; dataset_partition: "candidate_generation" | "held_out" }>).find(task => task.turn_id === "verified-turn")!;
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
    assert.equal(typeof batch.indexed_partition_tasks, "number");
    assert.equal(batch.pending_terminal_outcome, 0);
    assert.equal(batch.excluded_project_identity, 0);
    assert.equal(batch.excluded_evidence_conflict, 0);
    assert.equal((batch.tasks as Array<Record<string, unknown>>).some(task => task.turn_id === "verified-turn"), false);
    delete verifiedRecord.verification_outcome;
    await writeFile(f.state, JSON.stringify(persisted));
    const excerpt = await readCodexSessionTaskExcerpt(verified.task_id, { sessions_root: f.sessions,
      state_file: f.state, expected_partition: verified.dataset_partition });
    assert.equal(excerpt.status, "ineligible");
    assert.equal(excerpt.reason, "task_not_verified_or_partition_mismatch");
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

test("failed terminal task is excluded from candidate generation even when an earlier test passed", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("failed-after-test", "请检查项目任务的执行和测试结果", "中途测试通过但最终任务验证失败");
    turn.splice(turn.length - 1, 0, f.event({ type: "item_completed", turn_id: "failed-after-test", item: { type: "CommandExecution",
      id: "earlier-test", command: "pnpm test", aggregated_output: "Tests 2 passed (2)", exit_code: 0, status: "completed" } }));
    await f.writeSession(turn);
    const options = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(options);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!;
    assert.equal(task.dataset_partition, "candidate_generation");
    await reconcileCodexSessionTaskEvidence([{ evidence_id: "failed-terminal-evidence", session_id: task.session_id, turn_id: task.turn_id,
      context_receipt_id: "failed-terminal-receipt", verification_ref_digest: `sha256:${"a".repeat(64)}`,
      terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "failed", verified: true, content_stored: false }], options);
    assert.deepEqual((await codexSessionTaskBatch("candidate_generation", options)).tasks, []);
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: "candidate_generation" });
    assert.equal(excerpt.status, "ineligible");
    assert.equal(excerpt.reason, "task_terminal_outcome_failed");
    const heldOutState = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, JsonObject>; session_partitions?: unknown };
    heldOutState.tasks[task.task_id]!.dataset_partition = "held_out";
    delete heldOutState.session_partitions; // Model a separate pre-registry held-out fixture.
    delete (heldOutState as { session_split_versions?: unknown }).session_split_versions;
    await writeFile(f.state, JSON.stringify(heldOutState));
    const heldOut = (await codexSessionTaskBatch("held_out", options)).tasks as JsonObject[];
    assert.equal(heldOut.length, 1);
    assert.equal(heldOut[0]!.verification_outcome, "failed");
    const heldOutExcerpt = await readCodexSessionTaskExcerpt(task.task_id, { ...options, expected_partition: "held_out" });
    assert.equal(heldOutExcerpt.status, "ready", JSON.stringify(heldOutExcerpt));
    assert.equal(heldOutExcerpt.verification_outcome, "failed");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("server comparison binds session Evidence to the exact indexed transcript without claiming task benefit", async () => {
  const f = await fixture();
  try {
    const turn = f.turn("proof-turn", "请验证项目依赖升级之后的测试流程", "已运行相关测试并确认依赖升级后的验证结果正常。");
    turn.splice(2, 0, f.event({ type: "item_completed", turn_id: "proof-turn", item: { type: "CommandExecution",
      id: "test", command: "pnpm test", aggregated_output: "Tests 2 passed (2)", exit_code: 0, status: "completed" } }));
    await f.writeSession(turn);
    const archive = { sessions_root: f.sessions, state_file: f.state };
    await runCodexSessionCollectionOnce(archive);
    const state = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, CodexSessionTaskIndex> };
    const task = Object.values(state.tasks)[0]!, options = { ...archive, expected_partition: task.dataset_partition };
    const excerpt = await readCodexSessionTaskExcerpt(task.task_id, options);
    assert.equal(excerpt.status, "ready", JSON.stringify(excerpt));
    const input: JsonObject = { task_id: task.task_id, scope: excerpt.project_scope_id, source_session_id: excerpt.session_id,
      turn_id: excerpt.turn_id, source_ref: excerpt.source_ref, task_goal: excerpt.task_goal, task_result: excerpt.task_result,
      verification_artifacts: excerpt.verification_artifacts, sanitized: true };
    assert.deepEqual(await verifyCodexSessionEvidenceInput(input, options), { status: "transcript_matched", verification_outcome: null,
      task_result_verified: false, claim_effect_proven: false, raw_content_stored: false });
    assert.equal((await verifyCodexSessionEvidenceInput({}, options)).reason, "task_id_missing");
    assert.equal((await verifyCodexSessionEvidenceInput({ ...input, task_id: "missing" }, options)).reason, "task_excerpt_unavailable");
    for (const changes of [{ scope: "project:other" }, { source_session_id: "other" }, { turn_id: "other" }, { source_ref: "other" },
      { task_goal: "other" }, { task_result: "other" }, { sanitized: false }, { verification_artifacts: null },
      { verification_artifacts: [] }, { verification_artifacts: [{ runner: "other" }] }])
      assert.equal((await verifyCodexSessionEvidenceInput({ ...input, ...changes }, options)).reason, "task_evidence_mismatch");
    await writeFile(f.file, "changed source\n");
    assert.equal((await verifyCodexSessionEvidenceInput(input, options)).reason, "task_excerpt_unavailable");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
