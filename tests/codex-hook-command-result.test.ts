import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeAsyncVerificationResults, withClaudeCommandResult, withCodexCommandResult } from "../core/interfaces/codex-hook-command-result.ts";
import { hookVerificationGap, HookSignalSanitizer } from "../core/interfaces/codex-hook-signal-sanitizer.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

const session = "01900000-0000-7000-8000-000000000001";
const turn = "01900000-0000-7000-8000-000000000002";
const tool = "exec-01900000-0000-7000-8000-000000000003";
const command = "node --test format.test.mjs";

test("Codex Bash verification uses the matched native completion status, even when stdout is misleading", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-command-result-"));
  try {
    const sessions = join(root, "sessions");
    mkdirSync(sessions);
    const transcript = join(sessions, `rollout-${session}.jsonl`);
    const cwd = pathToFileURL(realpathSync(root)).href;
    const hook = { session_host: "codex", hook_event_name: "PostToolUse", session_id: session,
      turn_id: turn, tool_use_id: tool, cwd: root, transcript_path: transcript,
      tool_name: "Bash", tool_input: { command }, tool_response: "tests passed; exit code 0" };
    const item = { type: "CommandExecution", id: tool, cwd, command: ["/bin/zsh", "-lc", command],
      status: "completed", exit_code: 0, aggregated_output: "unused output" };
    const event = { type: "event_msg", payload: { type: "item_completed", thread_id: session, turn_id: turn, item } };
    const sanitizer = new HookSignalSanitizer();
    const signal = (input = hook) => sanitizer.signal(withCodexCommandResult(input, root));
    const write = (...lines: unknown[]) => writeFileSync(transcript, lines.map(line => JSON.stringify(line)).join("\n") + "\n");

    assert.equal(signal(), null);
    write(event);
    assert.equal(signal()?.outcome, "passed");
    const failed = { ...event, payload: { ...event.payload, item: { ...item, status: "failed", exit_code: 1 } } };
    write(failed);
    assert.equal(signal()?.outcome, "failed");
    write(failed, event);
    assert.equal(signal()?.outcome, "passed");

    for (const changes of [
      { type: "Message" }, { id: "other" }, { cwd: "file:///unrelated" },
      { command: ["/bin/zsh", "-lc", "node --test other.mjs"] }, { command: null },
      { status: "in_progress" }, { status: "failed" }, { exit_code: null },
      { exit_code: -1 }, { exit_code: 0.5 }, { exit_code: 1 },
    ]) {
      write({ ...event, payload: { ...event.payload, item: { ...item, ...changes } } });
      assert.equal(signal(), null);
    }
    for (const changes of [{ thread_id: "other" }, { turn_id: "other" }, { type: "item_started" }, { item: null }]) {
      write({ ...event, payload: { ...event.payload, ...changes } });
      assert.equal(signal(), null);
    }
    write({ ...event, type: "response_item" }, { type: "event_msg" });
    assert.equal(signal(), null);
    writeFileSync(transcript, `{"truncated":"${tool}"\n${JSON.stringify(event)}\n{"truncated":"${tool}"`);
    assert.equal(signal()?.outcome, "passed");
    writeFileSync(transcript, `${JSON.stringify(event)}\n${"x".repeat(600_000)}\n`);
    assert.equal(signal(), null);
    writeFileSync(transcript, `${"x".repeat(600_000)}\n${JSON.stringify(event)}\n`);
    assert.equal(signal()?.outcome, "passed");

    const outside = join(root, `other-${session}.jsonl`);
    writeFileSync(outside, JSON.stringify(event));
    const link = join(sessions, `link-${session}.jsonl`);
    symlinkSync(outside, link);
    const directory = join(sessions, `directory-${session}.jsonl`);
    mkdirSync(directory);
    for (const changes of [
      { session_host: "claude" }, { hook_event_name: "Stop" }, { tool_name: "Edit" },
      { tool_input: { command: "echo skipped" } }, { tool_input: { command: "node --test && echo no" } },
      { tool_input: { command: "" } }, { session_id: "" }, { turn_id: "" }, { tool_use_id: "" },
      { cwd: "" }, { transcript_path: "" }, { transcript_path: join(sessions, "another-rollout.jsonl") },
      { transcript_path: outside }, { transcript_path: link }, { transcript_path: directory },
    ]) {
      const input = { ...hook, ...changes };
      assert.equal(withCodexCommandResult(input, root), input);
    }
    const structured = { ...hook, tool_response: { exit_code: 1 } };
    assert.equal(withCodexCommandResult(structured, root), structured);
    assert.equal(sanitizer.signal(structured)?.outcome, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the native hook skips text-only verification without a trusted completion", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-command-hook-"));
  try {
    const output = execFileSync(process.execPath, ["--experimental-strip-types",
      fileURLToPath(new URL("../bin/craft-codex-hook.ts", import.meta.url)), "--member", "context"], {
      env: { ...process.env, CODEX_HOME: root, CRAFT_DATA_DIR: join(root, "craft-data") },
      input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash",
        tool_input: { command }, tool_response: "test output without a trusted completion" }),
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hook CLI reconciles a Claude background completion from an isolated Host transcript", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-stop-entry-"));
  try {
    const home = join(root, ".claude"), projects = join(home, "projects"), cwd = join(root, "repo");
    mkdirSync(projects, { recursive: true }); mkdirSync(cwd);
    const transcript = join(projects, `${session}.jsonl`);
    const identity = { sessionId: session, cwd: realpathSync(cwd) };
    const boundary = { ...identity, type: "user", promptId: turn };
    const assistant = { ...identity, type: "assistant", uuid: "assistant", message: { content: [{ type: "tool_use", id: tool, name: "Bash", input: { command } }] } };
    const background = { ...identity, type: "user", promptId: turn, sourceToolAssistantUUID: "assistant",
      toolUseResult: { interrupted: false, backgroundTaskId: "task-42" }, message: { content: [{ type: "tool_result", tool_use_id: tool }] } };
    const attachment = { type: "queued_command", commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" },
      prompt: `<task-notification><task-id>task-42</task-id><tool-use-id>${tool}</tool-use-id><status>completed</status></task-notification>` };
    writeFileSync(transcript, [boundary, assistant, background, { ...identity, type: "attachment", attachment }].map(value => JSON.stringify(value)).join("\n"));
    const result = execFileSync(process.execPath, ["--experimental-strip-types",
      fileURLToPath(new URL("../bin/craft-codex-hook.ts", import.meta.url)), "--member", "context", "--host", "claude"], {
      env: { ...process.env, HOME: root, CRAFT_STORAGE_OWNER: "context", CRAFT_DATA_DIR: join(root, "data") },
      input: JSON.stringify({ hook_event_name: "Stop", session_id: session, prompt_id: turn, cwd, transcript_path: transcript }),
      encoding: "utf8",
    });
    assert.doesNotThrow(() => JSON.parse(result));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Hook CLI keeps the legacy store and non-learning member Stop path", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-legacy-entry-"));
  try {
    const data = join(root, "data"), store = await new CraftStore(craftPaths(data)).open(); store.close();
    const env = { ...process.env, CRAFT_DATA_DIR: data, CRAFT_CONTINUOUS_LEARNING: "0" };
    delete env.CRAFT_STORAGE_OWNER;
    const output = execFileSync(process.execPath, ["--experimental-strip-types",
      fileURLToPath(new URL("../bin/craft-codex-hook.ts", import.meta.url)), "--member", "knowledge"], {
      env, input: JSON.stringify({ hook_event_name: "Stop", session_host: "codex", session_id: session, turn_id: turn, cwd: root }), encoding: "utf8",
    });
    assert.doesNotThrow(() => JSON.parse(output));
    const fresh = join(root, "fresh");
    const freshOutput = execFileSync(process.execPath, ["--experimental-strip-types",
      fileURLToPath(new URL("../bin/craft-codex-hook.ts", import.meta.url)), "--member", "context"], {
      env: { ...env, CRAFT_DATA_DIR: fresh },
      input: JSON.stringify({ hook_event_name: "Stop", session_host: "codex", session_id: session, turn_id: turn, cwd: root }), encoding: "utf8",
    });
    assert.doesNotThrow(() => JSON.parse(freshOutput));
    const legacyMarker = join(root, "legacy-marker"); mkdirSync(legacyMarker);
    writeFileSync(join(legacyMarker, "craft.db"), "");
    const markerOutput = execFileSync(process.execPath, ["--experimental-strip-types",
      fileURLToPath(new URL("../bin/craft-codex-hook.ts", import.meta.url)), "--member", "context"], {
      env: { ...env, CRAFT_DATA_DIR: legacyMarker },
      input: JSON.stringify({ hook_event_name: "Stop", session_host: "codex", session_id: session, turn_id: turn, cwd: root }), encoding: "utf8",
    });
    assert.doesNotThrow(() => JSON.parse(markerOutput));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Hook CLI selects owned context and non-context runtimes on Stop", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-hook-owned-entry-"));
  try {
    for (const member of ["context", "knowledge"]) {
      const data = join(root, member), env = { ...process.env, CRAFT_DATA_DIR: data, CRAFT_STORAGE_OWNER: member, CRAFT_CONTINUOUS_LEARNING: "0" };
      const output = execFileSync(process.execPath, ["--experimental-strip-types",
        fileURLToPath(new URL("../bin/craft-codex-hook.ts", import.meta.url)), "--member", member], {
        env, input: JSON.stringify({ hook_event_name: "Stop", session_host: "codex", session_id: session, turn_id: turn, cwd: root }), encoding: "utf8",
      });
      assert.doesNotThrow(() => JSON.parse(output));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verification receipts reject incomplete and contradictory structured results from either Host", () => {
  const sanitizer = new HookSignalSanitizer();
  for (const session_host of ["codex", "claude"]) {
    const input = { session_host, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } };
    for (const tool_response of [
      { exit_code: 0, interrupted: true }, { exit_code: 0, timed_out: true },
      { exit_code: 0, status: "in_progress" }, { exit_code: 0, status: "running" },
      { exit_code: 0, status: "pending" }, { exit_code: 0, status: "cancelled" },
      { exit_code: 0, status: "failed" }, { exit_code: 1, status: "completed" },
      { exit_code: 0, exitCode: 1 }, { exit_code: 0, status: "error" },
      { exit_code: 0, backgroundTaskId: "pending-task" },
      { status: "completed" }, { status: "completed", exit_code: null },
    ]) assert.equal(sanitizer.signal({ ...input, tool_response }), null);
    assert.equal(sanitizer.signal({ ...input, tool_response: { exit_code: 0, interrupted: false, status: "completed" } })?.outcome, "passed");
    assert.equal(sanitizer.signal({ ...input, tool_response: { exitCode: 2, status: "failed" } })?.outcome, "failed");
    assert.equal(sanitizer.signal({ ...input, tool_response: { status: "passed" } })?.outcome, "passed");
  }
});

test("Claude native successful and failed events carry terminal outcomes without inventing exit codes", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-claude-result-"));
  try {
    const projects = join(root, "projects"); mkdirSync(projects);
    const transcript = join(projects, session + ".jsonl"); writeFileSync(transcript, "");
    const hook = { session_host: "claude", hook_event_name: "PostToolUse", session_id: session,
      prompt_id: turn, tool_use_id: tool, cwd: root, transcript_path: transcript, tool_name: "Bash",
      tool_input: { command }, tool_response: { stdout: "failed, exit 1 (untrusted text)", stderr: "", interrupted: false } };
    const sanitizer = new HookSignalSanitizer();
    const normalized = withClaudeCommandResult(hook, root);
    assert.equal(sanitizer.signal(normalized)?.outcome, "passed");
    assert.deepEqual(normalized.tool_response, { status: "passed" });
    const failure = { ...hook, hook_event_name: "PostToolUseFailure", tool_response: undefined,
      error: "Exit code 1", is_interrupt: false };
    assert.equal(sanitizer.signal(withClaudeCommandResult(failure, root))?.outcome, "failed");
    for (const changes of [{ error: "" }, { error: undefined }, { is_interrupt: true }, { is_interrupt: undefined },
      { tool_response: hook.tool_response }]) {
      const input = { ...failure, ...changes }; assert.equal(withClaudeCommandResult(input, root), input);
    }
    for (const changes of [{ session_host: "codex" }, { hook_event_name: "Stop" }, { tool_name: "Write" },
      { tool_input: { command: "echo no" } }, { session_id: "" }, { prompt_id: "" }, { tool_use_id: "" },
      { cwd: "" }, { cwd: join(root, "missing") }, { transcript_path: "" }, { transcript_path: join(root, "wrong.jsonl") },
      { tool_response: undefined }, { error: "contradictory" }]) {
      const input = { ...hook, ...changes }; assert.equal(withClaudeCommandResult(input, root), input);
    }
    for (const changes of [{ interrupted: true }, { stdout: undefined }, { stderr: undefined }, { backgroundTaskId: "pending" },
      { exit_code: 1 }, { exitCode: 0 }, { status: "running" }, { is_error: true }, { success: false }, { error: "failed" }, { timed_out: true }]) {
      const input = { ...hook, tool_response: { ...hook.tool_response, ...changes } };
      assert.equal(withClaudeCommandResult(input, root), input);
    }
    const outside = join(root, session + ".jsonl"); writeFileSync(outside, "");
    const input = { ...hook, transcript_path: outside }; assert.equal(withClaudeCommandResult(input, root), input);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("Stop reconciles native background completion only inside the current task and after its last edit", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-native-async-"));
  try {
    mkdirSync(join(root, "sessions")); mkdirSync(join(root, "projects"));
    const hook = { session_host: "claude", hook_event_name: "Stop", session_id: session, cwd: root };
    const results = (input: Record<string, unknown>) => nativeAsyncVerificationResults(input, root);
    const claudePath = join(root, "projects", session + ".jsonl");
    const claude = { ...hook, session_host: "claude", prompt_id: turn, transcript_path: claudePath };
    const identity = { sessionId: session, cwd: realpathSync(root) };
    const boundary = { ...identity, type: "user", promptId: turn };
    const assistant = { ...identity, type: "assistant", uuid: "assistant", message: { content: [{ type: "tool_use", id: tool, name: "Bash", input: { command } }] } };
    const background = { ...identity, type: "user", promptId: turn, sourceToolAssistantUUID: "assistant", toolUseResult: { interrupted: false, backgroundTaskId: "task-42" },
      message: { content: [{ type: "tool_result", tool_use_id: tool }] } };
    const attachment = { type: "queued_command", commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" },
      prompt: `<task-notification><task-id>task-42</task-id><tool-use-id>${tool}</tool-use-id><status>completed</status></task-notification>` };
    const notice = { ...identity, type: "attachment", attachment };
    const save = (...records: unknown[]) => writeFileSync(claudePath, records.map(value => JSON.stringify(value)).join("\n"));
    const normalized = () => results(claude);
    save(boundary, assistant, background, notice); assert.deepEqual(normalized().map(value => value.tool_response), [{ status: "passed" }]);
    const systemNotice = { ...identity, type: "user", origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system", turnOrigin: "task_notification", message: { content: attachment.prompt } };
    save(boundary, assistant, background, systemNotice); assert.deepEqual(normalized().map(value => value.tool_response), [{ status: "passed" }]);
    for (const changes of [{ origin: { kind: "user", producer: "session-task" } }, { origin: { kind: "task-notification", producer: "user" } }, { promptSource: "user" }, { turnOrigin: "user" }, { message: { content: [] } }]) {
      save(boundary, assistant, background, { ...systemNotice, ...changes }); assert.deepEqual(normalized(), []);
    }

    save(boundary, assistant, background, { ...notice, attachment: { ...attachment, prompt: attachment.prompt.replace("completed", "failed") } });
    assert.deepEqual(normalized().map(value => value.tool_response), [{ status: "failed" }]);
    for (const changes of [{ type: "user" }, { sessionId: "other" }, { cwd: "other" }, { attachment: undefined },
      { attachment: { ...attachment, type: "text" } }, { attachment: { ...attachment, commandMode: "user" } },
      { attachment: { ...attachment, origin: undefined } }, { attachment: { ...attachment, origin: { kind: "user", producer: "session-task" } } },
      { attachment: { ...attachment, origin: { kind: "task-notification", producer: "user" } } },
      { attachment: { ...attachment, prompt: undefined } }, { attachment: { ...attachment, prompt: "tests passed" } },
      { attachment: { ...attachment, prompt: attachment.prompt.replace(tool, "other") } },
      { attachment: { ...attachment, prompt: attachment.prompt.replace("completed", "running") } }]) {
      save(boundary, assistant, background, { ...notice, ...changes }); assert.deepEqual(normalized(), []);
    }
    for (const changes of [{ promptId: "other" }, { sourceToolAssistantUUID: "missing" }, { toolUseResult: undefined },
      { toolUseResult: { interrupted: true, backgroundTaskId: "task-42" } }, { toolUseResult: { interrupted: false } },
      { toolUseResult: { interrupted: false, backgroundTaskId: "../task" } }, { message: undefined }, { message: { content: [] } }]) {
      save(boundary, assistant, { ...background, ...changes }, notice); assert.deepEqual(normalized(), []);
    }
    save(assistant, background, notice); assert.deepEqual(normalized(), []);
    save(boundary, { ...assistant, message: { content: [{ type: "tool_use", id: tool, name: "Bash", input: { command: "echo no" } }] } }, background, notice);
    assert.deepEqual(normalized(), []);
    for (const edit of [{ type: "tool_use", name: "Write" }, { type: "tool_use", name: "Bash", input: { command: "sed -i file" } }]) {
      save(boundary, assistant, { ...identity, type: "assistant", message: { content: [edit] } }, background, notice); assert.deepEqual(normalized(), []);
    }
    for (const changes of [{ session_host: "codex" }, { hook_event_name: "PostToolUse" }, { session_id: "" }, { cwd: "" },
      { transcript_path: "" }, { cwd: join(root, "missing") }, { transcript_path: join(root, "missing", session + ".jsonl") }]) assert.deepEqual(results({ ...claude, ...changes }), []);
    const foreign = join(root, session + ".jsonl"); writeFileSync(foreign, ""); assert.deepEqual(results({ ...claude, transcript_path: foreign }), []);
    save(boundary, { ...assistant, message: { content: [{ type: "tool_use", name: "Bash" }] } }, background, notice); assert.deepEqual(normalized(), []);
    save(boundary, assistant, background, notice);
    writeFileSync(claudePath, "invalid\n" + [boundary, assistant, background, notice].map(value => JSON.stringify(value)).join("\n")); assert.equal(normalized().length, 1);
    save(boundary, assistant, background, notice); assert.deepEqual(results({ ...claude, prompt_id: "" }), []);
    assert.deepEqual(results({ ...claude, transcript_path: join(root, "wrong.jsonl") }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("verification gap diagnostics retain objective local reasons without inventing Host readiness", () => {
  const sanitizer = new HookSignalSanitizer();
  const input = { tool_name: "Bash", tool_use_id: tool, session_id: session, cwd: "/project", tool_input: { command }, tool_response: { backgroundTaskId: "task" } };
  const camel = { toolName: "Bash", toolUseId: tool, session_id: session, cwd: "/project", toolInput: { command } };
  assert.equal(sanitizer.gap({ ...camel, toolResponse: { status: "running" } })?.gap_reason, "pending_background");
  assert.equal(sanitizer.gap({ ...camel, output: "unknown" })?.gap_reason, "unsupported_native_envelope");
  const pending = sanitizer.gap(input)!;
  assert.equal(pending.gap_reason, "pending_background");
  assert.equal(JSON.stringify(pending).includes(command), false);
  assert.equal(hookVerificationGap({ signals: [pending], verification_outcome: null }).reason, "pending_background");
  const unsupported = sanitizer.gap({ ...input, tool_response: "no terminal status" })!;
  assert.equal(hookVerificationGap({ signals: [unsupported] }).reason, "unsupported_native_envelope");
  assert.equal(hookVerificationGap(null).reason, "verification_unobserved");
  assert.equal(hookVerificationGap(null).host_authentication, "unknown");
  assert.equal(hookVerificationGap(null).hook_trust, "unknown");
  assert.equal(hookVerificationGap(null, { authentication: "unavailable" }).reason, "host_auth_unavailable");
  assert.equal(hookVerificationGap(null, { authentication: "available", hook_trust: "untrusted" }).reason, "hook_untrusted");
  for (const outcome of ["passed", "failed"]) assert.equal(hookVerificationGap({ verification_outcome: outcome }).reason, null);
  assert.equal(hookVerificationGap({ signals: [pending, { kind: "verification", verifier: pending.verifier }], verification_outcome: "passed" }, { authentication: "available", hook_trust: "trusted" }).reason, null);
  assert.equal(hookVerificationGap({ signals: [pending, { kind: "edit" }] }).reason, "verification_unobserved");
  for (const changes of [{ tool_name: "Write" }, { tool_input: { command: "echo skipped" } }, { session_id: "" }, { cwd: "" }, { tool_use_id: "" }, { tool_response: { exit_code: 0 } }]) assert.equal(sanitizer.gap({ ...input, ...changes }), null);
  assert.equal(sanitizer.gap({ ...input, tool_response: { status: "running" } })?.gap_reason, "pending_background");
});
