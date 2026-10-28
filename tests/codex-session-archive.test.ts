import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexTaskGoalDigest } from "../core/codex-task-prose.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import type { CodexSessionTaskIndex } from "../core/codex-session-archive.ts";
import { codexSessionEvidenceBatch, codexSessionTaskBatch, commitCodexSessionEvidenceBatch, readCodexSessionChunk, readCodexSessionTaskExcerpt, reconcileCodexSessionTaskEvidence, runCodexSessionCollectionOnce, verifyCodexSessionEvidenceInput } from "../core/codex-session-archive.ts";

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
    // A forged root discriminator must not open an arbitrary directory.
    const invalid = JSON.parse(await readFile(f.state, "utf8"));
    invalid.tasks[original.task_id].source_root = "outside";
    await writeFile(f.state, JSON.stringify(invalid));
    await assert.rejects(runCodexSessionCollectionOnce(options, env), /task index is invalid/);
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
    assert.equal(Number(third.tasks_candidate_generation) + Number(third.tasks_held_out), 2);
    const partitioned = Object.values(JSON.parse(await readFile(f.state, "utf8")).tasks as Record<string, { dataset_partition: string; dataset_split_version: string }>);
    assert.equal(new Set(partitioned.map(task => task.dataset_partition)).size, 1);
    assert.equal(partitioned.every(task => task.dataset_split_version === "codex-session-split-v1"), true);
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
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence[0], { ...evidence[0], evidence_id: "conflicting-evidence", verification_outcome: "failed" }], { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence[0], project_scope_id: "project:wrong-project" }], { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence[0], host: "other-host" }], { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([{ ...evidence[0], task_goal_digest: `sha256:${"d".repeat(64)}` }], { state_file: f.state })).tasks_verified, 0);
    assert.equal((await reconcileCodexSessionTaskEvidence([evidence[0], { ...evidence[0], evidence_id: "different-terminal",
      terminal_identity_digest: `sha256:${"c".repeat(64)}` }], { state_file: f.state })).tasks_verified, 0);
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

test("keeps legacy optional task provenance readable and fails closed when goal evidence is absent", async () => {
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
    const returned = (batch.tasks as Array<Record<string, unknown>>).find(task => task.turn_id === "verified-turn")!;
    assert.equal(returned.context_receipt_id, null);
    assert.equal(returned.verification_ref_digest, null);
    assert.equal(returned.terminal_identity_digest, null);
    delete verifiedRecord.verification_outcome;
    await writeFile(f.state, JSON.stringify(persisted));
    const excerpt = await readCodexSessionTaskExcerpt(verified.task_id, { sessions_root: f.sessions,
      state_file: f.state, expected_partition: verified.dataset_partition });
    assert.equal(excerpt.status, "ready");
    assert.equal(excerpt.verification_outcome, undefined, "legacy verified records without an outcome remain readable");
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
    const heldOutState = JSON.parse(await readFile(f.state, "utf8")) as { tasks: Record<string, JsonObject> };
    heldOutState.tasks[task.task_id]!.dataset_partition = "held_out";
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
