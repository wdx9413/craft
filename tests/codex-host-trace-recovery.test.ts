import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { CodexHookBridge } from "../core/codex-hook-bridge.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { withCodexCommandResult } from "../core/interfaces/codex-hook-command-result.ts";
import { codexHostTraceCapabilities, isCodexHostTraceToolEvent } from "../core/interfaces/codex-host-trace-capture.ts";
import { codexProjectScope } from "../core/interfaces/codex-hook-bridge.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-codex-recovery-"));
  const previousHookMode = process.env.CRAFT_HOOK_MODE;
  process.env.CRAFT_HOOK_MODE = "1";
  const projectRoot = join(root, "project");
  const codexHome = join(root, "codex-home");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = await CraftService.open(store);
  const bridge = new CodexHookBridge(service);
  const mcp = new McpServer(service, "component-experience-daily");
  const call = async (name: string, args: JsonObject = {}) => {
    const response = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return response?.result as JsonObject;
  };
  return {
    root, projectRoot, codexHome, store, service, bridge, mcp, call,
    async close() {
      store.close();
      if (previousHookMode === undefined) delete process.env.CRAFT_HOOK_MODE;
      else process.env.CRAFT_HOOK_MODE = previousHookMode;
      await rm(root, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

test("Codex Host event recognition requires a supported native PostToolUse tool", () => {
  assert.equal(isCodexHostTraceToolEvent({
    session_host: "codex", hook_event_name: "PostToolUse", tool_name: "Bash",
  }), true);
  assert.equal(isCodexHostTraceToolEvent({
    session_host: "codex", hook_event_name: "PostToolUse", tool_name: "mcp__browser__navigate",
  }), true);
  assert.equal(isCodexHostTraceToolEvent({
    session_host: "claude", hook_event_name: "PostToolUse", tool_name: "Bash",
  }), false);
  assert.equal(isCodexHostTraceToolEvent({
    session_host: "codex", hook_event_name: "Stop", tool_name: "Bash",
  }), false);
  assert.equal(isCodexHostTraceToolEvent({
    session_host: "codex", hook_event_name: "PostToolUse", tool_name: "Browser",
  }), false);
  assert.equal(isCodexHostTraceToolEvent({
    session_host: "codex", hook_event_name: "PostToolUse", tool_name: "mcp__browser__navigate page",
  }), false);
  assert.equal(isCodexHostTraceToolEvent({
    session_host: "codex", hook_event_name: "PostToolUse", tool_name: undefined,
  }), false);
});

function base(f: Fixture, session_id: string, turn_id: string) {
  return { session_host: "codex", cwd: f.projectRoot, session_id, turn_id };
}

async function commandEvent(f: Fixture, session_id: string, turn_id: string, tool_use_id: string, exitCode: number) {
  const command = "pnpm test";
  const transcriptPath = join(f.codexHome, "sessions", `session-${session_id}.jsonl`);
  const completion = { type: "event_msg", payload: { type: "item_completed", thread_id: session_id, turn_id,
    item: { type: "CommandExecution", id: tool_use_id, cwd: pathToFileURL(await realpath(f.projectRoot)).href,
      command: ["/bin/zsh", "-lc", command], status: exitCode === 0 ? "completed" : "failed", exit_code: exitCode } } };
  await writeFile(transcriptPath, `${JSON.stringify(completion)}\n`);
  return withCodexCommandResult({ ...base(f, session_id, turn_id), hook_event_name: "PostToolUse", tool_name: "Bash",
    tool_use_id, tool_input: { command }, tool_response: "private command output {{SECRET_result1234}}",
    transcript_path: transcriptPath }, f.codexHome);
}

async function startTurn(f: Fixture, session_id: string, turn_id: string) {
  await f.bridge.handle("experience", { ...base(f, session_id, turn_id), hook_event_name: "UserPromptSubmit",
    prompt: "Please update the project and verify it." });
  const output = await f.bridge.handle("context", { ...base(f, session_id, turn_id), hook_event_name: "UserPromptSubmit",
    prompt: "Please update the project and verify it." });
  return JSON.parse(String(output.additionalContext)) as { project_binding: string; scope: JsonObject };
}

async function failedCheck(f: Fixture, session_id: string, turn_id: string, callId = "failed-check") {
  return f.bridge.handle("experience", await commandEvent(f, session_id, turn_id, callId, 1));
}

async function passedCheck(f: Fixture, session_id: string, turn_id: string, callId = "passed-check") {
  return f.bridge.handle("experience", await commandEvent(f, session_id, turn_id, callId, 0));
}

async function finish(f: Fixture, session_id: string, turn_id: string): Promise<JsonObject> {
  return f.bridge.handle("experience", { ...base(f, session_id, turn_id), hook_event_name: "Stop" });
}

async function verifiedRecovery(f: Fixture, session_id: string, turn_id: string) {
  const binding = await startTurn(f, session_id, turn_id);
  await failedCheck(f, session_id, turn_id);
  await f.bridge.handle("experience", { ...base(f, session_id, turn_id), hook_event_name: "PostToolUse",
    tool_name: "Edit", tool_use_id: `recovery-edit-${turn_id}`, tool_input: { file_path: "src/recovery.ts" },
    tool_response: { success: true } });
  await passedCheck(f, session_id, turn_id);
  const stopped = await finish(f, session_id, turn_id);
  return { binding, stopped, ticket_id: String((stopped.automatic_candidate as JsonObject).ticket_id) };
}

test("undeclared recovery_of_event_ref is ignored while a verified same-verifier recovery creates only a ticket", async () => {
  const f = await fixture();
  try {
    const capability = codexHostTraceCapabilities().find(item => item.tool_category === "recovery_linkage");
    assert.deepEqual(capability, {
      host: "codex", tool_category: "recovery_linkage", tools: [],
      status: "unsupported", reason_code: "native_post_tool_use_has_no_recovery_relation",
    });

    await startTurn(f, "forged-recovery-session", "forged-recovery-turn");
    const failed = await failedCheck(f, "forged-recovery-session", "forged-recovery-turn");
    const earlierEventRef = String((failed.trace_capture as JsonObject).event_ref);
    const recovery = await f.bridge.handle("experience", {
      ...base(f, "forged-recovery-session", "forged-recovery-turn"),
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_use_id: "forged-recovery-edit",
      tool_input: { file_path: "src/recovery.ts", new_string: "{{CUSTOMER_private1234}}" },
      tool_response: { success: true },
      // This key is not part of Codex's native PostToolUse schema.
      recovery_of_event_ref: earlierEventRef,
    });
    const recoveryCapture = recovery.trace_capture as JsonObject;
    assert.equal(recoveryCapture.status, "captured");
    assert.equal(recoveryCapture.recovery_relation_status, undefined);

    await passedCheck(f, "forged-recovery-session", "forged-recovery-turn");
    const stopped = await finish(f, "forged-recovery-session", "forged-recovery-turn");
    assert.equal(stopped.decision, "block", JSON.stringify(stopped));
    assert.equal((stopped.automatic_candidate as JsonObject).status, "candidate_request");
    const ticketId = String((stopped.automatic_candidate as JsonObject).ticket_id);
    const ticket = f.store.get("experience_trace_distillation_ticket", ticketId);
    assert.equal(ticket.status, "pending_continuation");
    assert.equal(ticket.host, "codex");
    assert.equal(ticket.session_id, "forged-recovery-session");
    assert.equal(ticket.source_turn_id, "forged-recovery-turn");
    assert.equal(typeof ticket.authorization_digest, "string");
    assert.match(String(ticket.recovery_verifier_digest), /^sha256:[a-f0-9]{64}$/u);
    assert.equal((ticket.event_refs as JsonObject[]).length, 4);
    assert.match(String(stopped.reason), /Do not claim an exact retry relation/u);
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.equal(f.store.count("experience_learning_work_item"), 0);

    const trace = f.service.traceGet({ trace_id: String(recoveryCapture.trace_id) });
    const events = trace.events as JsonObject[];
    const edit = events.find(event => event.id === recoveryCapture.event_ref);
    assert.ok(edit);
    const refs = edit.input_refs as string[];
    assert.deepEqual(refs, [edit.id]);
    assert.ok(!refs.includes(earlierEventRef));
    assert.doesNotMatch(JSON.stringify(trace), /private command output|CUSTOMER_private1234|SECRET_result1234/u);
  } finally { await f.close(); }
});

test("ordinary successful Host work still stays Trace-only without verified recovery linkage", async () => {
  const f = await fixture();
  try {
    await startTurn(f, "ordinary-session", "ordinary-turn");
    await f.bridge.handle("experience", { ...base(f, "ordinary-session", "ordinary-turn"), hook_event_name: "PostToolUse",
      tool_name: "Edit", tool_use_id: "ordinary-edit", tool_input: { file_path: "src/ordinary.ts" },
      tool_response: { success: true } });
    await passedCheck(f, "ordinary-session", "ordinary-turn");
    const stopped = await finish(f, "ordinary-session", "ordinary-turn");
    assert.equal((stopped.automatic_candidate as JsonObject).reason_code, "no_failed_verification_before_pass");
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.equal(f.store.count("experience_learning_work_item"), 0);
  } finally { await f.close(); }
});

test("MCP continuation consumes the exact same-session ticket once and links the Candidate to a Work Item", async () => {
  const f = await fixture();
  try {
    const { binding, stopped, ticket_id: ticketId } = await verifiedRecovery(f, "ticket-session", "ticket-turn");
    assert.equal(stopped.decision, "block", JSON.stringify(stopped));
    const list = await f.mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const distillTool = ((list?.result as JsonObject).tools as JsonObject[]).find(tool => tool.name === "craft_experience_trace_distill");
    const schema = distillTool?.inputSchema as JsonObject;
    const properties = schema.properties as JsonObject;
    assert.equal((properties.ticket_id as JsonObject).type, "string");
    assert.deepEqual((properties.decision as JsonObject).enum, ["skip", "retry"]);

    const read = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding, ticket_id: ticketId });
    assert.equal(read.isError, false, JSON.stringify(read));
    const readResult = read.structuredContent as JsonObject;
    assert.equal(readResult.status, "sources_ready");
    const source = (readResult.sources as JsonObject[])[0]!;
    assert.equal(source.session_id, "ticket-session");
    assert.equal(source.turn_id, "ticket-turn");
    const events = source.event_refs as JsonObject[];
    assert.equal(events.length, 4);
    assert.equal(events.filter(event => typeof event.verification_digest === "string").length, 2);
    const failed = events.find(event => event.status === "failed")!;
    const observedText = `Observed Host Trace fields: event_kind=${failed.event_kind}; operation_id=${failed.operation_id}; status=${failed.status}; sequence=${failed.sequence}.`;
    const candidate = {
      title: { text: "Review a verified project-check recovery", provenance: "inferred", source_refs: [] },
      applies_when: { text: observedText, provenance: "host_observed", source_refs: [failed.id] },
      exclude_when: { text: "The failure is unrelated to this project check", provenance: "inferred", source_refs: [] },
      steps: [{ text: "Investigate the failing check before changing the project", provenance: "inferred", source_refs: [] }],
      pitfalls: [],
      done_criteria: { text: "The bound verifier reports a passed result", provenance: "inferred", source_refs: [] },
      failure_handling: { text: "Keep the candidate unverified if the check does not pass", provenance: "inferred", source_refs: [] },
      focus: [], exclude_topics: [],
    };
    const submitted = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding,
      ticket_id: ticketId, candidate });
    assert.equal(submitted.isError, false, JSON.stringify(submitted));
    const result = submitted.structuredContent as JsonObject;
    assert.equal(result.status, "captured");
    assert.equal(result.learning_work_item_status, "blocked");
    assert.equal(result.blocked_reason, "evaluation_contract_unavailable");
    const ticket = f.store.get("experience_trace_distillation_ticket", ticketId);
    assert.equal(ticket.status, "submitted");
    assert.equal((ticket.candidate_ref as JsonObject).kind, "experience_procedure");
    assert.equal((ticket.work_item_ref as JsonObject).kind, "experience_learning_work_item");
    assert.equal(f.store.count("experience_learning_work_item"), 1);
    const retry = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding, ticket_id: ticketId,
      candidate });
    assert.equal(retry.isError, false);
    assert.equal((retry.structuredContent as JsonObject).idempotent, true);
    assert.equal(f.store.count("experience_learning_work_item"), 1);
  } finally { await f.close(); }
});

test("an explicit continuation skip closes the ticket without creating a Candidate or Work Item", async () => {
  const f = await fixture();
  try {
    const { binding, ticket_id: ticketId } = await verifiedRecovery(f, "skip-session", "skip-turn");
    const result = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding,
      ticket_id: ticketId, decision: "skip" });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal((result.structuredContent as JsonObject).status, "skipped");
    assert.equal(f.store.get("experience_trace_distillation_ticket", ticketId).status, "skipped");
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.equal(f.store.count("experience_learning_work_item"), 0);
  } finally { await f.close(); }
});

test("a read-only or interrupted continuation becomes retryable and needs a newly bound retry", async () => {
  const f = await fixture();
  try {
    const { binding, ticket_id: ticketId } = await verifiedRecovery(f, "retry-session", "retry-source-turn");
    const read = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding, ticket_id: ticketId });
    assert.equal(read.isError, false);
    assert.equal(f.store.get("experience_trace_distillation_ticket", ticketId).status, "continuation_claimed");

    const wrongTurn = await startTurn(f, "retry-session", "retry-other-turn");
    const crossTurn = await f.call("craft_experience_trace_distill", { project_binding: wrongTurn.project_binding, ticket_id: ticketId });
    assert.equal(crossTurn.isError, true);

    const stopped = await f.bridge.handle("experience", { ...base(f, "retry-session", "retry-other-turn"),
      hook_event_name: "Stop", stop_hook_active: true });
    assert.equal((stopped.automatic_candidate as JsonObject).status, "retryable");
    assert.equal(f.store.get("experience_trace_distillation_ticket", ticketId).status, "retryable");

    const retried = await f.call("craft_experience_trace_distill", { project_binding: wrongTurn.project_binding,
      ticket_id: ticketId, decision: "retry" });
    assert.equal(retried.isError, false, JSON.stringify(retried));
    assert.equal((retried.structuredContent as JsonObject).status, "sources_ready");
    const ticket = f.store.get("experience_trace_distillation_ticket", ticketId);
    assert.equal(ticket.status, "continuation_claimed");
    assert.equal(ticket.continuation_turn_id, "retry-other-turn");
  } finally { await f.close(); }
});
