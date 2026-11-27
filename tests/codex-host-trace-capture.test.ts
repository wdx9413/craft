import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CodexHookBridge } from "../core/codex-hook-bridge.ts";
import { codexProjectScope } from "../core/codex-hook-bridge.ts";
import { withCodexCommandResult } from "../core/interfaces/codex-hook-command-result.ts";
import { CodexHostTraceCapture, codexHostTraceCapabilities } from "../core/interfaces/index.ts";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";
import { stableDigest } from "../core/digest.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-codex-trace-"));
  const previousHookMode = process.env.CRAFT_HOOK_MODE;
  process.env.CRAFT_HOOK_MODE = "1";
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  return { root, projectRoot, service, store, close: async () => {
    store.close();
    if (previousHookMode === undefined) delete process.env.CRAFT_HOOK_MODE;
    else process.env.CRAFT_HOOK_MODE = previousHookMode;
    await rm(root, { recursive: true, force: true });
  } };
}

async function verifiedCodexCommand(f: Awaited<ReturnType<typeof fixture>>, identity: Record<string, string>, toolUseId: string, exitCode = 0) {
  const sessions = join(f.root, "sessions");
  await mkdir(sessions, { recursive: true });
  const transcriptPath = join(sessions, `rollout-${identity.session_id}.jsonl`);
  const command = "pnpm test";
  const completion = { type: "event_msg", payload: { type: "item_completed", thread_id: identity.session_id, turn_id: identity.turn_id,
    item: { type: "CommandExecution", id: toolUseId, cwd: pathToFileURL(await realpath(identity.cwd!)).href,
      command: ["/bin/zsh", "-lc", command], status: exitCode === 0 ? "completed" : "failed", exit_code: exitCode } } };
  await writeFile(transcriptPath, `${JSON.stringify(completion)}\n`);
  return withCodexCommandResult({ ...identity, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: toolUseId,
    tool_input: { command }, tool_response: "sensitive tool output", transcript_path: transcriptPath }, f.root);
}

test("Codex Hook can start an exact turn Trace idempotently and rejects incomplete identity", async () => {
  const f = await fixture();
  try {
    const capture = new CodexHostTraceCapture(f.service);
    const identity = { session_host: "codex", session_id: "presented-session", turn_id: "presented-turn" };
    const scope = codexProjectScope(f.projectRoot)!;
    const first = capture.ensureTurnTrace(identity, scope);
    const duplicate = capture.ensureTurnTrace(identity, scope);
    assert.equal(first.status, "captured");
    assert.equal(first.idempotent, false);
    assert.equal(duplicate.status, "captured");
    assert.equal(duplicate.idempotent, true);

    const trace = f.service.traceGet({ trace_id: first.trace_id as string });
    assert.equal((trace.trace as Record<string, unknown>).host, "codex");
    assert.deepEqual((trace.trace as Record<string, unknown>).project_scope, scope);
    assert.equal((trace.trace as Record<string, unknown>).session_id, "presented-session");
    assert.equal((trace.trace as Record<string, unknown>).turn_id, "presented-turn");
    assert.equal((trace.events as unknown[]).length, 0);

    assert.deepEqual(capture.ensureTurnTrace({ ...identity, turn_id: undefined }, scope), {
      status: "rejected", reason_code: "missing_task_identity",
    });
    assert.deepEqual(capture.ensureTurnTrace({ ...identity, session_host: "claude" }, scope), {
      status: "rejected", reason_code: "unsupported_host",
    });
    assert.deepEqual(capture.ensureTurnTrace(identity, { kind: "project", id: "not a canonical scope" }), {
      status: "rejected", reason_code: "project_scope_unavailable",
    });
    assert.equal(f.store.list("trace", 20).length, 1);
  } finally { await f.close(); }
});

test("Codex Hook actions persist ordered content-free Trace events and deduplicate redelivery", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    const base = { session_host: "codex", cwd: f.projectRoot, session_id: "session-7", turn_id: "turn-3" };
    const privateValues = [
      "raw shell argument --token {{SECRET_abcd1234}}",
      "patch body for {{CUSTOMER_42}}",
      "edit text {{SECRET_wxyz9876}}",
      "write body {{CUSTOMER_99}}",
      "tool output {{SECRET_qwer5678}}",
    ];
    const calls = [
      { tool_name: "Bash", tool_use_id: "call-bash", tool_input: { command: privateValues[0] }, tool_response: privateValues[4] },
      { tool_name: "apply_patch", tool_use_id: "call-patch", tool_input: { patch: privateValues[1] }, tool_response: { success: true, body: privateValues[4] } },
      { tool_name: "Edit", tool_use_id: "call-edit", tool_input: { file_path: "src/example.ts", new_string: privateValues[2] }, tool_response: privateValues[4] },
      { tool_name: "Write", tool_use_id: "call-write", tool_input: { file_path: "src/example.ts", content: privateValues[3] }, tool_response: { exit_code: 0 } },
    ];
    const captures = [];
    for (const call of calls) {
      const result = await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", ...call });
      captures.push(result.trace_capture as Record<string, unknown>);
    }
    const duplicate = await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", ...calls[0] });
    assert.equal(captures.every((capture) => capture.status === "captured"), true);
    assert.equal((duplicate.trace_capture as Record<string, unknown>).idempotent, true);
    assert.equal((duplicate.trace_capture as Record<string, unknown>).event_ref, captures[0]!.event_ref);
    const conflictingDelivery = bridge.traceCapture.captureTool(await verifiedCodexCommand(f, base, "call-bash"), codexProjectScope(f.projectRoot));
    assert.deepEqual(conflictingDelivery, { status: "rejected", reason_code: "event_identity_conflict" });

    const traceId = String(captures[0]!.trace_id);
    const taskId = String(captures[0]!.task_id);
    assert.equal(captures.every((capture) => capture.trace_id === traceId && capture.task_id === taskId), true);
    const trace = f.service.traceGet({ trace_id: traceId });
    const events = trace.events as Record<string, unknown>[];
    assert.deepEqual(events.map((event) => event.operation_id), [
      "codex_tool_bash", "codex_tool_apply_patch", "codex_tool_edit", "codex_tool_write",
    ]);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
    assert.deepEqual(events.map((event) => event.status), ["unknown", "unknown", "unknown", "unknown"]);
    assert(events.every((event) => event.error_class === "host_result_not_semantic"));
    assert.deepEqual((events[0]!.action_contract as Record<string, unknown>), {
      kind: "host_tool_operation", tool_category: "script", action: "execute",
    });
    assert.deepEqual((events[1]!.action_contract as Record<string, unknown>), {
      kind: "host_tool_operation", tool_category: "file_edit", action: "patch",
    });
    assert.equal((trace.trace as Record<string, unknown>).host, "codex");
    assert.deepEqual((trace.trace as Record<string, unknown>).project_scope, codexProjectScope(f.projectRoot));
    assert.equal((trace.trace as Record<string, unknown>).session_id, "session-7");
    assert.equal((trace.trace as Record<string, unknown>).turn_id, "turn-3");
    assert.equal((trace.trace as Record<string, unknown>).status, "running");
    assert.deepEqual((f.service.traceQuery({ task_id: taskId }).events as Record<string, unknown>[]).map((event) => event.sequence), [1, 2, 3, 4]);
    const persisted = JSON.stringify({ trace: trace.trace, events });
    for (const value of privateValues) assert.equal(persisted.includes(value), false);
    assert(events.every((event) => typeof event.input_refs === "object" && String(event.summary).includes("Codex")));
    const eventRef = String(captures[0]!.event_ref);
    const stored = f.store.find("trace_event", eventRef)!;
    f.store.save("trace_event", eventRef, { ...stored, input_refs: null });
    assert.deepEqual(bridge.traceCapture.captureTool({ ...base, hook_event_name: "PostToolUse", ...calls[0] },
      codexProjectScope(f.projectRoot)), {
      status: "rejected", reason_code: "event_identity_conflict",
    });
  } finally { await f.close(); }
});

test("Codex Host MCP operations retain only the tool name and content-free result class", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    const base = { session_host: "codex", cwd: f.projectRoot, session_id: "mcp-session", turn_id: "mcp-turn" };
    const privateInput = "browser URL https://internal.example/customer/42?token={{SECRET_abcd1234}}";
    const privateOutput = "page text {{CUSTOMER_42}} {{SECRET_wxyz9876}}";
    const first = await bridge.handle("context", { ...base, hook_event_name: "PostToolUse",
      tool_name: "mcp__browser__navigate", tool_use_id: "mcp-call-1",
      tool_input: { url: privateInput }, tool_response: { content: privateOutput, isError: false } });
    const duplicate = await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse",
      tool_name: "mcp__browser__navigate", tool_use_id: "mcp-call-1",
      tool_input: { url: privateInput }, tool_response: { content: privateOutput, isError: false } });
    const conflict = await bridge.handle("context", { ...base, hook_event_name: "PostToolUse",
      tool_name: "mcp__browser__click", tool_use_id: "mcp-call-1",
      tool_input: { selector: privateInput }, tool_response: { content: privateOutput, isError: false } });

    const capture = first.trace_capture as Record<string, unknown>;
    assert.equal(capture.status, "captured");
    assert.equal(capture.call_result, "unknown");
    assert.equal((duplicate.trace_capture as Record<string, unknown>).idempotent, true);
    assert.deepEqual(conflict.trace_capture, { status: "rejected", reason_code: "event_identity_conflict" });
    const trace = f.service.traceGet({ trace_id: capture.trace_id as string });
    const events = trace.events as Record<string, unknown>[];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.operation_id, "codex_tool_mcp");
    assert.deepEqual(events[0]?.action_contract, {
      kind: "host_tool_operation", tool_category: "api_mcp", action: "invoke", tool_name: "mcp__browser__navigate",
    });
    assert.equal(events[0]?.status, "unknown");
    const persisted = JSON.stringify(trace);
    assert.equal(persisted.includes(privateInput), false);
    assert.equal(persisted.includes(privateOutput), false);
    assert.equal(persisted.includes("customer/42"), false);
    assert.equal(persisted.includes("CUSTOMER_42"), false);
    assert.equal(persisted.includes("SECRET_abcd1234"), false);
    assert.equal(persisted.includes("SECRET_wxyz9876"), false);
    assert.equal(persisted.includes("mcp__browser__navigate"), true);
  } finally { await f.close(); }
});

test("Codex Hook CLI persists Host tool events through the public process entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-codex-hook-cli-trace-"));
  const projectRoot = join(root, "project"), dataRoot = join(root, "data"), hostHome = join(root, "codex-home");
  let runtime: Awaited<ReturnType<typeof openCapabilityService>> | undefined;
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(hostHome, { recursive: true });
    const privateCommand = "echo {{SECRET_cli12345}}";
    const privateOutput = "output {{CUSTOMER_cli67890}}";
    const input = { hook_event_name: "PostToolUse", session_id: "cli-session", turn_id: "cli-turn", tool_use_id: "cli-call",
      cwd: projectRoot, tool_name: "Bash", tool_input: { command: privateCommand }, tool_response: privateOutput };
    const run = () => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types",
      join(process.cwd(), "bin/craft-codex-hook.ts"), "--member", "context"], {
      cwd: process.cwd(), env: { ...process.env, CODEX_HOME: hostHome, CRAFT_DATA_DIR: dataRoot, CRAFT_STORAGE_OWNER: "context" },
      input: JSON.stringify(input), encoding: "utf8",
    })) as { trace_capture: Record<string, unknown> };
    const first = run();
    const duplicate = run();
    assert.ok(first.trace_capture, JSON.stringify(first));
    assert.equal(first.trace_capture.status, "captured");
    assert.equal(duplicate.trace_capture.idempotent, true);
    assert.equal(first.trace_capture.event_ref, duplicate.trace_capture.event_ref);
    runtime = await openCapabilityService("context", { ...process.env, CRAFT_DATA_DIR: dataRoot, CRAFT_STORAGE_OWNER: "context" });
    const trace = runtime.service.traceGet({ trace_id: first.trace_capture.trace_id as string });
    const events = trace.events as Record<string, unknown>[];
    assert.equal(events.length, 1);
    assert.equal(events[0]!.status, "unknown");
    assert.equal(events[0]!.error_class, "host_result_not_semantic");
    assert.equal(events[0]!.tool_response, undefined);
    assert.equal(events[0]!.action_contract && typeof events[0]!.action_contract, "object");
    const persisted = JSON.stringify(trace);
    assert.equal(persisted.includes(privateCommand), false);
    assert.equal(persisted.includes(privateOutput), false);
    const diagnosticDirectory = join(dataRoot, "trace", "hook-runtime", "v1");
    const diagnostics = (await Promise.all((await readdir(diagnosticDirectory)).map(file =>
      readFile(join(diagnosticDirectory, file), "utf8")))).join("\n");
    assert.equal(diagnostics.includes(privateCommand), false);
    assert.equal(diagnostics.includes(privateOutput), false);
  } finally { runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex Host Trace fails closed for missing identity and unknown event formats", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    const tool = { hook_event_name: "PostToolUse", session_host: "codex", cwd: f.projectRoot,
      tool_name: "Bash", tool_input: { command: "safe" }, tool_response: { exit_code: 0 } };
    assert.deepEqual(await bridge.handle("context", { ...tool, tool_use_id: "call-1", session_id: "session-without-turn" }), {
      trace_capture: { status: "rejected", reason_code: "missing_task_identity" },
    });
    assert.deepEqual(await bridge.handle("context", { ...tool, tool_use_id: "call-invalid-session", session_id: "session with spaces", turn_id: "turn-1" }), {
      trace_capture: { status: "rejected", reason_code: "missing_task_identity" },
    });
    assert.deepEqual(await bridge.handle("context", { ...tool, session_id: "session-no-project", turn_id: "turn-1", tool_use_id: "call-no-project", cwd: undefined }), {
      trace_capture: { status: "rejected", reason_code: "project_scope_unavailable" },
    });
    assert.deepEqual(await bridge.handle("context", { ...tool, session_id: "session-1", turn_id: "turn-1" }), {
      trace_capture: { status: "rejected", reason_code: "missing_tool_call_reference" },
    });
    assert.deepEqual(await bridge.handle("context", { ...tool, session_id: "session-1", turn_id: "turn-1", tool_use_id: "call-2", tool_name: "Browser" }), {
      trace_capture: { status: "rejected", reason_code: "unsupported_tool_category" },
    });
    assert.deepEqual(await bridge.handle("context", { ...tool, session_id: "session-1", turn_id: "turn-1", tool_use_id: "call-3",
      tool_name: undefined, toolName: "Bash" }), {
      trace_capture: { status: "rejected", reason_code: "unsupported_tool_category" },
    });
    assert.deepEqual(await bridge.handle("context", { ...tool, session_host: "claude", session_id: "session-1",
      turn_id: "turn-1", tool_use_id: "call-claude", tool_name: "UnregisteredTool" }), {});
    const capture = new CodexHostTraceCapture(f.service);
    assert.deepEqual(capture.captureTool({ ...tool, session_host: "claude", session_id: "session-1",
      turn_id: "turn-1", tool_use_id: "call-claude" }, codexProjectScope(f.projectRoot)), {
      status: "rejected", reason_code: "unsupported_host",
    });
    assert.deepEqual(capture.captureTool({ ...tool, session_id: "session-1", turn_id: "turn-1",
      tool_use_id: "call-event", hook_event_name: "PreToolUse" }, codexProjectScope(f.projectRoot)), {
      status: "rejected", reason_code: "unsupported_host_event",
    });
    assert.deepEqual(capture.captureTool({ ...tool, session_id: "session-1", turn_id: "bad turn",
      tool_use_id: "call-invalid-turn" }, codexProjectScope(f.projectRoot)), {
      status: "rejected", reason_code: "missing_task_identity",
    });
    assert.deepEqual(capture.captureTool({ ...tool, session_id: "session-1", turn_id: "turn-1",
      tool_use_id: "call invalid", tool_name: "Bash" }, codexProjectScope(f.projectRoot)), {
      status: "rejected", reason_code: "missing_tool_call_reference",
    });
    assert.deepEqual(capture.captureTool({ ...tool, session_id: "session-1", turn_id: "turn-1",
      tool_use_id: "call-invalid-scope" }, { kind: "project", id: "not a canonical scope" }), {
      status: "rejected", reason_code: "project_scope_unavailable",
    });
    assert.throws(() => f.service.traceStart({ trace_id: "trace_invalid_project_scope", task_id: "task-invalid-scope",
      project_scope: { kind: "global", id: "global" } }), /project_scope kind must be project/u);
    assert.equal(f.store.list("trace", 20).length, 0);
  } finally { await f.close(); }
});

test("Codex tool success stays separate from accepted task terminal verification", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    const identity = { session_host: "codex", cwd: f.projectRoot, session_id: "session-8", turn_id: "turn-4" };
    const tool = await bridge.handle("context", { ...identity, hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_use_id: "call-bash", tool_input: { command: "run verification" }, tool_response: { exit_code: 0 } });
    const traceId = String((tool.trace_capture as Record<string, unknown>).trace_id);
    const stop = await bridge.handle("context", { ...identity, hook_event_name: "Stop" });
    assert.equal(stop.trace_capture !== undefined, true, JSON.stringify(stop));
    const trace = f.service.traceGet({ trace_id: traceId });
    const events = trace.events as Record<string, unknown>[];
    assert.deepEqual(events.map((event) => event.event_kind), ["host.tool.completed", "task.terminal_verification.unavailable"]);
    assert.equal(events[0]!.status, "unknown");
    assert.equal(events[0]!.error_class, "host_result_not_semantic");
    assert.equal(events[1]!.status, "unknown");
    assert.equal(events[1]!.error_class, "accepted_terminal_verification_unavailable");
    assert.equal((trace.trace as Record<string, unknown>).status, "running");
    const duplicateStop = await bridge.handle("context", { ...identity, hook_event_name: "Stop" });
    assert.equal((duplicateStop.trace_capture as Record<string, unknown>).idempotent, true);
    assert.equal((f.service.traceGet({ trace_id: traceId }).events as Record<string, unknown>[]).length, 2);
  } finally { await f.close(); }
});

test("Codex Stop records an accepted terminal observation separately from tool events", async () => {
  const f = await fixture();
  try {
    const sourceRoot = join(f.projectRoot, "src");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "feature.ts"), "export const feature = false;\n");
    const bridge = new CodexHookBridge(f.service);
    const identity = { session_host: "codex", cwd: f.projectRoot, session_id: "session-9", turn_id: "turn-5" };
    const scope = codexProjectScope(f.projectRoot)!;
    f.service.scopeAliasBind({ scope_kind: "project", scope_id: scope.id, alias_kind: "path", alias: f.projectRoot });
    await bridge.handle("experience", { ...identity, hook_event_name: "UserPromptSubmit", prompt: "Update the feature and verify it." });
    await bridge.handle("experience", { ...identity, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "call-edit",
      tool_input: { file_path: "src/feature.ts" }, tool_response: "Updated." });
    const verification = await verifiedCodexCommand(f, identity, "call-verify");
    assert.deepEqual(verification.tool_response, { exit_code: 0 });
    await bridge.handle("experience", verification);
    assert.equal(bridge.journal.find(identity, undefined, scope)?.verification_outcome, "passed");
    const toolTraceId = String((f.store.list("trace_event", 20, event => event.operation_id === "codex_tool_edit")[0] as Record<string, unknown>).trace_id);
    const stop = await bridge.handle("experience", { ...identity, hook_event_name: "Stop" });
    assert.equal((stop.trace_capture as Record<string, unknown>).status, "verified", JSON.stringify(stop));
    const trace = f.service.traceGet({ trace_id: toolTraceId });
    const events = trace.events as Record<string, unknown>[];
    assert.deepEqual(events.map(event => event.event_kind), ["host.tool.completed", "host.tool.completed", "task.terminal_verification", "trace.finalized"]);
    assert.deepEqual(events.slice(0, 2).map(event => event.status), ["unknown", "succeeded"]);
    assert.equal(events[2]!.status, "passed");
    assert.equal(events[2]!.trust, "verified");
    assert.equal((trace.trace as Record<string, unknown>).status, "completed");
    const lateTool = await bridge.handle("experience", { ...identity, hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_use_id: "call-after-terminal", tool_input: { command: "safe" }, tool_response: "output" });
    assert.deepEqual(lateTool.trace_capture, { status: "rejected", reason_code: "trace_terminal" });
    const repeatedStop = await bridge.handle("experience", { ...identity, hook_event_name: "Stop" });
    assert.equal((repeatedStop.trace_capture as Record<string, unknown>).idempotent, true);
    assert.equal((f.service.traceGet({ trace_id: toolTraceId }).events as Record<string, unknown>[]).length, 4);
  } finally { await f.close(); }
});

test("Codex terminal verification rejects unsupported identity and does not invent outcomes", async () => {
  const f = await fixture();
  try {
    const capture = new CodexHostTraceCapture(f.service);
    const scope = codexProjectScope(f.projectRoot)!;
    const stop = (session_id: string, turn_id: string) => ({
      session_host: "codex", hook_event_name: "Stop", session_id, turn_id,
    });
    assert.deepEqual(capture.recordTerminalVerification({ ...stop("s", "t"), session_host: "claude" }, scope, null), {
      status: "rejected", reason_code: "unsupported_host",
    });
    assert.deepEqual(capture.recordTerminalVerification({ ...stop("s", "t"), hook_event_name: "SessionEnd" }, scope, null), {
      status: "rejected", reason_code: "unsupported_host_event",
    });
    assert.deepEqual(capture.recordTerminalVerification(stop("s", "t"), null, null), {
      status: "rejected", reason_code: "project_scope_unavailable",
    });
    assert.deepEqual(capture.recordTerminalVerification({ ...stop("s", ""), turn_id: undefined }, scope, null), {
      status: "rejected", reason_code: "missing_task_identity",
    });
    assert.deepEqual(capture.recordTerminalVerification(stop("no-trace", "no-trace-turn"), scope, null), {
      status: "skipped", reason_code: "trace_not_found",
    });

    const identity = { session_host: "codex", hook_event_name: "PostToolUse", tool_name: "Bash",
      cwd: f.projectRoot, session_id: "terminal-unavailable", turn_id: "terminal-unavailable-turn", tool_use_id: "terminal-call" };
    const started = capture.captureTool(identity, scope);
    const traceId = String(started.trace_id);
    const otherProject = capture.captureTool({ ...identity, tool_use_id: "other-project-call" },
      { kind: "project", id: "project:other" });
    assert.notEqual(otherProject.trace_id, traceId);
    assert.notEqual(otherProject.task_id, started.task_id);
    const sameToolOtherProject = capture.captureTool(identity, { kind: "project", id: "project:other" });
    assert.notEqual(sameToolOtherProject.event_ref, started.event_ref);
    const savedTrace = f.store.find("trace", traceId)!;
    f.store.save("trace", traceId, { ...savedTrace, project_scope: { kind: "project", id: "project:other" } });
    assert.deepEqual(capture.recordTerminalVerification(stop("terminal-unavailable", "terminal-unavailable-turn"), scope, null), {
      status: "rejected", reason_code: "trace_identity_conflict",
    });
    f.store.save("trace", traceId, savedTrace);
    const unavailable = capture.recordTerminalVerification(stop("terminal-unavailable", "terminal-unavailable-turn"), scope, null);
    assert.equal(unavailable.status, "unverified");
    assert.equal(unavailable.reason_code, "accepted_terminal_verification_unavailable");
    f.service.traceFinalize({ trace_id: traceId, status: "completed", summary: "Fixture finalization" });
    const repeated = capture.recordTerminalVerification(stop("terminal-unavailable", "terminal-unavailable-turn"), scope, null);
    assert.equal(repeated.status, "unverified");
    assert.equal(repeated.idempotent, true);
    assert.equal((f.service.traceGet({ trace_id: traceId }).events as Record<string, unknown>[]).filter(event =>
      event.event_kind === "task.terminal_verification.unavailable").length, 1);
  } finally { await f.close(); }
});

test("Codex terminal verification recovers exact accepted references and fails closed on malformed results", async () => {
  const f = await fixture();
  try {
    const capture = new CodexHostTraceCapture(f.service);
    const scope = codexProjectScope(f.projectRoot)!;
    const makeTrace = (session_id: string, turn_id: string) => {
      const started = capture.captureTool({ session_host: "codex", hook_event_name: "PostToolUse", tool_name: "Bash",
        session_id, turn_id, tool_use_id: `${session_id}-call`, tool_response: "result" }, scope);
      return String(started.trace_id);
    };
    const stop = (session_id: string, turn_id: string) => ({
      session_host: "codex", hook_event_name: "Stop", session_id, turn_id,
    });
    const failedCommand = await verifiedCodexCommand(f, { session_host: "codex", cwd: f.projectRoot,
      session_id: "tool-failed", turn_id: "tool-failed-turn" }, "tool-failed-call", 1);
    const failedCall = capture.captureTool(failedCommand, scope);
    assert.equal(failedCall.call_result, "failed");
    assert.equal(failedCall.reason_code, undefined);
    const malformedCommand = await verifiedCodexCommand(f, { session_host: "codex", cwd: f.projectRoot,
      session_id: "tool-malformed", turn_id: "tool-malformed-turn" }, "tool-malformed-call");
    malformedCommand.tool_response = { exit_code: Number.NaN };
    assert.equal(capture.captureTool(malformedCommand, scope).call_result, "unknown");

    const failedTraceId = makeTrace("terminal-failed", "terminal-failed-turn");
    const failed = capture.recordTerminalVerification(stop("terminal-failed", "terminal-failed-turn"), scope,
      { observation: { id: "observation-failed", outcome: "failed" } });
    assert.equal(failed.status, "verified");
    assert.equal(failed.outcome, "failed");
    assert.equal((f.service.traceGet({ trace_id: failedTraceId }).trace as Record<string, unknown>).status, "failed");
    assert.equal(capture.recordTerminalVerification(stop("terminal-failed", "terminal-failed-turn"), scope,
      { observation: { id: "observation-failed", outcome: "failed" } }).idempotent, true);

    const invalidTraceId = makeTrace("terminal-invalid-result", "terminal-invalid-result-turn");
    const invalid = capture.recordTerminalVerification(stop("terminal-invalid-result", "terminal-invalid-result-turn"), scope,
      { observation: { id: "raw observation reference", outcome: "passed" } });
    assert.equal(invalid.status, "unverified");
    assert.equal(JSON.stringify(f.service.traceGet({ trace_id: invalidTraceId })).includes("raw observation reference"), false);

    const recoveredTraceId = makeTrace("terminal-recover-event", "terminal-recover-event-turn");
    const recoveredObservationId = "observation-recovered";
    const recoveredEventRef = `codex_host_terminal_${stableDigest({ trace_id: recoveredTraceId,
      event_kind: "task.terminal_verification", observation_id: recoveredObservationId }).slice(-32)}`;
    f.service.traceAppend({ trace_id: recoveredTraceId, event_id: recoveredEventRef, event_kind: "task.terminal_verification",
      actor: "experience", source: "experience", trust: "verified", operation_id: "codex_task_terminal_verification",
      status: "failed", input_refs: [recoveredEventRef], output_refs: [recoveredObservationId], data: {},
      summary: "Accepted task terminal verification" });
    const recovered = capture.recordTerminalVerification(stop("terminal-recover-event", "terminal-recover-event-turn"), scope,
      { observation: { id: recoveredObservationId, outcome: "failed" } });
    assert.equal(recovered.status, "verified");
    assert.equal(recovered.idempotent, true);
    assert.equal((f.service.traceGet({ trace_id: recoveredTraceId }).trace as Record<string, unknown>).status, "failed");

    const recoveredPassTraceId = makeTrace("terminal-recover-pass", "terminal-recover-pass-turn");
    const recoveredPassId = "observation-recovered-pass";
    const recoveredPassRef = `codex_host_terminal_${stableDigest({ trace_id: recoveredPassTraceId,
      event_kind: "task.terminal_verification", observation_id: recoveredPassId }).slice(-32)}`;
    f.service.traceAppend({ trace_id: recoveredPassTraceId, event_id: recoveredPassRef, event_kind: "task.terminal_verification",
      actor: "experience", source: "experience", trust: "verified", operation_id: "codex_task_terminal_verification",
      status: "passed", input_refs: [recoveredPassRef], output_refs: [recoveredPassId], data: {},
      summary: "Accepted task terminal verification" });
    const recoveredPass = capture.recordTerminalVerification(stop("terminal-recover-pass", "terminal-recover-pass-turn"), scope,
      { observation: { id: recoveredPassId, outcome: "passed" } });
    assert.equal(recoveredPass.status, "verified");
    assert.equal(recoveredPass.idempotent, true);
    assert.equal((f.service.traceGet({ trace_id: recoveredPassTraceId }).trace as Record<string, unknown>).status, "completed");

    const conflictTraceId = makeTrace("terminal-conflict-event", "terminal-conflict-event-turn");
    const conflictObservationId = "observation-conflict";
    const conflictRef = `codex_host_terminal_${stableDigest({ trace_id: conflictTraceId,
      event_kind: "task.terminal_verification", observation_id: conflictObservationId }).slice(-32)}`;
    f.service.traceAppend({ trace_id: conflictTraceId, event_id: conflictRef, event_kind: "task.terminal_verification",
      actor: "experience", source: "experience", trust: "verified", operation_id: "codex_task_terminal_verification",
      status: "failed", input_refs: [conflictRef], output_refs: [conflictObservationId], data: {},
      summary: "Accepted task terminal verification" });
    assert.deepEqual(capture.recordTerminalVerification(stop("terminal-conflict-event", "terminal-conflict-event-turn"), scope,
      { observation: { id: conflictObservationId, outcome: "passed" } }), {
      status: "rejected", reason_code: "event_identity_conflict",
    });

    const finalizedTraceId = makeTrace("terminal-no-event", "terminal-no-event-turn");
    f.service.traceFinalize({ trace_id: finalizedTraceId, status: "failed", summary: "Fixture finalization" });
    assert.deepEqual(capture.recordTerminalVerification(stop("terminal-no-event", "terminal-no-event-turn"), scope, null), {
      status: "rejected", reason_code: "trace_terminal",
    });

    const terminalConflictTraceId = makeTrace("terminal-invalid-event", "terminal-invalid-event-turn");
    f.service.traceAppend({ trace_id: terminalConflictTraceId, event_id: "fixture-terminal-event",
      event_kind: "task.terminal_verification.unavailable", actor: "experience", source: "experience",
      trust: "verified", operation_id: "codex_task_terminal_verification", status: "unknown", data: {},
      summary: "Fixture terminal event" });
    f.service.traceFinalize({ trace_id: terminalConflictTraceId, status: "completed", summary: "Fixture finalization" });
    assert.deepEqual(capture.recordTerminalVerification(stop("terminal-invalid-event", "terminal-invalid-event-turn"), scope, null), {
      status: "rejected", reason_code: "terminal_event_identity_conflict",
    });
  } finally { await f.close(); }
});

test("Codex Host capability matrix marks only configured tools as unverified", () => {
  assert.deepEqual(codexHostTraceCapabilities(), [
    { host: "codex", tool_category: "script", tools: ["Bash"], status: "configured_unverified", reason_code: "host_runtime_receipt_pending" },
    { host: "codex", tool_category: "file_edit", tools: ["apply_patch"], matcher_aliases: ["Edit", "Write"], status: "configured_unverified", reason_code: "host_runtime_receipt_pending" },
    { host: "codex", tool_category: "browser", tools: [], status: "unsupported", reason_code: "hosted_tools_not_in_local_hook_path" },
    { host: "codex", tool_category: "api_mcp", tools: [],
      tool_patterns: ["^mcp__[A-Za-z0-9_.-]{1,64}__[A-Za-z0-9_.-]{1,96}$"],
      status: "configured_unverified", reason_code: "host_runtime_receipt_pending" },
    { host: "codex", tool_category: "recovery_linkage", tools: [], status: "unsupported", reason_code: "native_post_tool_use_has_no_recovery_relation" },
  ]);
});

test("Trace task queries sort each Trace by its sequence and keep Traces grouped", async () => {
  const f = await fixture();
  try {
    for (const trace_id of ["trace-z", "trace-a"]) {
      f.service.traceStart({ trace_id, task_id: "shared-task" });
      f.service.traceAppend({ trace_id, event_kind: "host.tool.completed", actor: "host", source: "codex",
        trust: "observed", operation_id: `${trace_id}-first`, data: {} });
      f.service.traceAppend({ trace_id, event_kind: "host.tool.completed", actor: "host", source: "codex",
        trust: "observed", operation_id: `${trace_id}-second`, data: {} });
    }
    const events = f.service.traceQuery({ task_id: "shared-task" }).events as Record<string, unknown>[];
    assert.deepEqual(events.map(event => [event.trace_id, event.sequence]), [
      ["trace-a", 1], ["trace-a", 2], ["trace-z", 1], ["trace-z", 2],
    ]);
  } finally { await f.close(); }
});
