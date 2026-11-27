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
import { LocalSupervisor } from "../core/supervisor.ts";

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
  const supervisor = new LocalSupervisor(service, store.paths);
  await supervisor.start();
  const bridge = new CodexHookBridge(service);
  const mcp = new McpServer(service, "component-experience-daily");
  const call = async (name: string, args: JsonObject = {}) => {
    const response = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return response?.result as JsonObject;
  };
  return {
    root, projectRoot, codexHome, store, service, bridge, mcp, call,
    async close() {
      await supervisor.close();
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

test("completed or expired recovery tickets are never reoffered", async () => {
  const f = await fixture();
  try {
    const session = "expired-ticket", turn = "original-turn";
    const completed = await verifiedRecovery(f, session, turn);
    const ticket = f.store.get("experience_trace_distillation_ticket", completed.ticket_id);
    const terminal = completed.stopped.trace_capture as JsonObject;
    const input = { ...base(f, session, turn), hook_event_name: "Stop" };
    const scope = codexProjectScope(f.projectRoot)!;
    const duplicate = f.bridge.traceCapture.captureAutomaticRecoveryCandidate(input, scope, terminal);
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.ticket_id, completed.ticket_id);
    f.store.save("experience_trace_distillation_ticket", completed.ticket_id, { ...ticket, authorization_digest: "sha256:changed" });
    assert.equal(f.bridge.traceCapture.captureAutomaticRecoveryCandidate(input, scope, terminal).reason_code, "ticket_authorization_conflict");
    f.store.save("experience_trace_distillation_ticket", completed.ticket_id, { ...ticket, expires_at_ms: Date.now() - 1 });
    assert.equal(f.bridge.traceCapture.captureAutomaticRecoveryCandidate(input, scope, terminal).reason_code, "ticket_no_longer_pending");
    const expired = f.store.get("experience_trace_distillation_ticket", completed.ticket_id);
    f.store.save("experience_trace_distillation_ticket", completed.ticket_id, { ...expired, status: "submitted", expires_at_ms: Date.now() + 60_000 });
    assert.equal(f.bridge.traceCapture.captureAutomaticRecoveryCandidate(input, scope, terminal).reason_code, "ticket_no_longer_pending");
  } finally { await f.close(); }
});

test("automatic recovery ignores unsupported or unverified terminal identity", async () => {
  const f = await fixture();
  try {
    const scope = codexProjectScope(f.projectRoot)!;
    const input = { ...base(f, "session", "turn"), hook_event_name: "Stop" };
    assert.equal(f.bridge.traceCapture.captureAutomaticRecoveryCandidate({ ...input, session_host: "claude" }, scope, null).reason_code, "unsupported_host_event");
    assert.equal(f.bridge.traceCapture.captureAutomaticRecoveryCandidate(input, null, null).reason_code, "terminal_verification_not_passed");
    assert.equal(f.bridge.traceCapture.captureAutomaticRecoveryCandidate({ ...input, stop_hook_active: true }, scope, null).reason_code, "continuation_already_active");
    assert.equal(f.bridge.traceCapture.captureAutomaticRecoveryCandidate(input, scope, null).reason_code, "terminal_verification_not_passed");
    assert.equal(f.bridge.traceCapture.captureAutomaticRecoveryCandidate(input, scope, { status: "verified", outcome: "passed", trace_id: "wrong-trace" }).reason_code, "trace_identity_unavailable");
    assert.equal(f.store.list("experience_trace_distillation_ticket", 10).length, 0);
  } finally { await f.close(); }
});

test("Experience-owned recovery uses its own store when no continuation exists", async () => {
  const f = await fixture();
  try {
    Object.defineProperty(f.service, "capabilityOwned", { value: true, configurable: true });
    Object.defineProperty(f.service, "storageOwner", { value: "experience", configurable: true });
    const input = { ...base(f, "local-owner", "turn"), hook_event_name: "Stop" };
    assert.equal(f.bridge.traceCapture.captureAutomaticRecoveryCandidate(input, codexProjectScope(f.projectRoot)!, null).reason_code, "terminal_verification_not_passed");
  } finally { await f.close(); }
});

test("retryable recovery remains actionable when diagnostic recording fails", async t => {
  const f = await fixture();
  try {
    const session = "retryable-diagnostic", turn = "source-turn";
    await startTurn(f, session, turn);
    t.mock.method(f.bridge.traceCapture, "captureAutomaticRecoveryCandidate", () => ({ status: "retryable", ticket_id: "ticket-1" }));
    const append = f.store.appendEvent.bind(f.store);
    t.mock.method(f.store, "appendEvent", (stream, kind, payload) => {
      if (kind === "codex_hook.trace_distillation_ticket") throw new Error("diagnostic unavailable");
      return append(stream, kind, payload);
    });
    const stopped = await finish(f, session, turn);
    assert.equal(stopped.decision, "block");
    assert.match(String(stopped.reason), /ticket-1/u);
    assert.equal((stopped.automatic_candidate as JsonObject).status, "retryable");
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("owned Host Trace fails closed when Runtime or Experience owner is absent", async () => {
  const f = await fixture();
  try {
    const capture = f.bridge.traceCapture, scope = codexProjectScope(f.projectRoot)!;
    const input = { ...base(f, "missing-owner", "turn"), hook_event_name: "Stop" };
    Object.defineProperty(f.service, "capabilityOwned", { value: true, configurable: true });
    Object.defineProperty(f.service, "storageOwner", { value: "context", configurable: true });
    assert.throws(() => capture.recordTerminalVerification(input, scope, null), /Trace owner is unavailable/u);
    assert.throws(() => capture.captureAutomaticRecoveryCandidate(input, scope, null), /Experience ticket owner is unavailable/u);
    assert.equal(f.store.list("experience_trace_distillation_ticket", 10).length, 0);
  } finally { await f.close(); }
});

test("automatic recovery rejects drifted Trace, terminal Observation and missing Evidence", async () => {
  for (const mode of ["trace", "terminal", "observation", "evidence", "empty-evidence", "missing-evidence-list", "no-output", "missing-output", "wrong-order"] as const) {
    const f = await fixture();
    try {
      const session = `drift-${mode}`, turn = "source-turn";
      const completed = await verifiedRecovery(f, session, turn);
      f.store.remove("experience_trace_distillation_ticket", completed.ticket_id);
      const terminalCapture = completed.stopped.trace_capture as JsonObject;
      const traceId = String(terminalCapture.trace_id);
      const trace = f.store.get("trace", traceId);
      const events = f.store.list("trace_event", 100, event => event.trace_id === traceId);
      const terminal = events.find(event => event.event_kind === "task.terminal_verification")!;
      const observationId = String((terminal.output_refs as string[])[0]);
      const observation = f.store.get("workflow_evolution_observation", observationId);
      if (mode === "trace") f.store.save("trace", traceId, { ...trace, status: "failed" });
      if (mode === "terminal") f.store.save("trace_event", String(terminal.id), { ...terminal, status: "failed" });
      if (mode === "observation") f.store.save("workflow_evolution_observation", observationId, { ...observation, lifecycle: "rejected" });
      if (mode === "evidence") f.store.save("workflow_evolution_observation", observationId, { ...observation, evidence_ids: ["missing-evidence"] });
      if (mode === "empty-evidence") f.store.save("workflow_evolution_observation", observationId, { ...observation, evidence_ids: [] });
      if (mode === "missing-evidence-list") f.store.save("workflow_evolution_observation", observationId, { ...observation, evidence_ids: null });
      if (mode === "no-output") f.store.save("trace_event", String(terminal.id), { ...terminal, output_refs: [] });
      if (mode === "missing-output") f.store.save("trace_event", String(terminal.id), { ...terminal, output_refs: null });
      if (mode === "wrong-order") {
        const failed = events.find(event => event.event_kind === "host.tool.completed" && event.status === "failed")!;
        f.store.save("trace_event", String(failed.id), { ...failed, sequence: Number(terminal.sequence) + 1 });
      }
      const result = f.bridge.traceCapture.captureAutomaticRecoveryCandidate({ ...base(f, session, turn), hook_event_name: "Stop" }, codexProjectScope(f.projectRoot)!, terminalCapture);
      assert.equal(result.reason_code, mode === "trace" ? "trace_not_verified" : mode === "terminal" || mode === "wrong-order" ? "no_failed_verification_before_pass"
        : mode === "observation" || mode === "no-output" || mode === "missing-output" ? "verified_observation_unavailable" : "verified_evidence_unavailable");
      assert.equal(f.store.list("experience_trace_distillation_ticket", 10).length, 0);
    } finally { await f.close(); }
  }
});

test("verified recovery ticket preserves bounded MCP tool identity without raw payload", async () => {
  const f = await fixture();
  try {
    const session = "recovery-mcp", turn = "source-turn";
    await startTurn(f, session, turn);
    const failed = await failedCheck(f, session, turn);
    f.service.traceAppend({ trace_id: (failed.trace_capture as JsonObject).trace_id, event_id: "unavailable-terminal",
      event_kind: "task.terminal_verification.unavailable", actor: "host", source: "codex", trust: "observed",
      operation_id: "codex_task_terminal_verification", status: "unknown", data: {}, summary: "Terminal verification unavailable" });
    await f.bridge.handle("experience", { ...base(f, session, turn), hook_event_name: "PostToolUse", tool_name: "mcp__browser__navigate",
      tool_use_id: "mcp-recovery", tool_input: { url: "https://private.example/secret" }, tool_response: "private response" });
    await f.bridge.handle("experience", { ...base(f, session, turn), hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "recovery-edit",
      tool_input: { file_path: "src/recovery.ts" }, tool_response: { success: true } });
    await passedCheck(f, session, turn);
    const stopped = await finish(f, session, turn);
    const ticketId = String((stopped.automatic_candidate as JsonObject).ticket_id);
    const ticket = f.store.get("experience_trace_distillation_ticket", ticketId);
    const api = (ticket.event_refs as JsonObject[]).find(event => event.tool_category === "api_mcp");
    assert.equal(api?.tool_name, "mcp__browser__navigate");
    assert((ticket.event_refs as JsonObject[]).some(event => event.event_kind === "task.terminal_verification.unavailable"));
    assert.equal(JSON.stringify(ticket).includes("private.example"), false);
    assert.equal(JSON.stringify(ticket).includes("private response"), false);
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

test("MCP capture rolls back when the claimed ticket changes during owner capture", async t => {
  const f = await fixture();
  try {
    const { binding, ticket_id: ticketId } = await verifiedRecovery(f, "capture-race-session", "capture-race-turn");
    const read = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding, ticket_id: ticketId });
    const source = ((read.structuredContent as JsonObject).sources as JsonObject[])[0]!;
    const failed = (source.event_refs as JsonObject[]).find(event => event.status === "failed")!;
    const observed = `Observed Host Trace fields: event_kind=${failed.event_kind}; operation_id=${failed.operation_id}; status=${failed.status}; sequence=${failed.sequence}.`;
    const candidate = {
      title: { text: "Review a verified project-check recovery", provenance: "inferred", source_refs: [] },
      applies_when: { text: observed, provenance: "host_observed", source_refs: [failed.id] },
      exclude_when: { text: "The failure is unrelated to this project check", provenance: "inferred", source_refs: [] },
      steps: [{ text: "Investigate the failing check before changing the project", provenance: "inferred", source_refs: [] }],
      pitfalls: [], done_criteria: { text: "The bound verifier reports a passed result", provenance: "inferred", source_refs: [] },
      failure_handling: { text: "Keep the candidate unverified if the check does not pass", provenance: "inferred", source_refs: [] },
      focus: [], exclude_topics: [],
    };
    const originalGet = f.store.get.bind(f.store);
    t.mock.method(f.store, "get", (kind, id) => {
      const row = originalGet(kind, id);
      return kind === "experience_trace_distillation_ticket" && id === ticketId ? { ...row, status: "retryable" } : row;
    });
    const result = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding, ticket_id: ticketId, candidate });
    assert.equal((result.structuredContent as JsonObject).reason_code, "learning_work_item_unavailable", JSON.stringify(result));
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.equal(f.store.count("experience_learning_work_item"), 0);
    assert.equal(originalGet("experience_trace_distillation_ticket", ticketId).status, "continuation_claimed");
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
    const replay = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding,
      ticket_id: ticketId, decision: "skip" });
    assert.equal(replay.isError, false);
    assert.equal((replay.structuredContent as JsonObject).status, "skipped");
    assert.equal((replay.structuredContent as JsonObject).idempotent, true);
  } finally { await f.close(); }
});

test("MCP continuation rejects missing, expired, prematurely retried and drifted tickets", async () => {
  const f = await fixture();
  try {
    const { binding, ticket_id: ticketId } = await verifiedRecovery(f, "ticket-boundary-session", "ticket-boundary-turn");
    const call = (extra: JsonObject) => f.call("craft_experience_trace_distill", { project_binding: binding.project_binding, ...extra });
    assert.match(JSON.stringify(await call({ ticket_id: "missing-ticket" })), /ticket is unavailable/u);
    assert.match(JSON.stringify(await call({ ticket_id: ticketId, decision: "retry" })), /ticket is unavailable/u);
    assert.match(JSON.stringify(await call({ ticket_id: ticketId, decision: "skip", candidate: {} })), /decision requires an eligible ticket_id/u);
    const initial = f.store.get("experience_trace_distillation_ticket", ticketId);
    f.store.save("experience_trace_distillation_ticket", ticketId, { ...initial, expires_at_ms: Date.now() - 1 });
    assert.match(JSON.stringify(await call({ ticket_id: ticketId })), /ticket is unavailable/u);
    let current = f.store.get("experience_trace_distillation_ticket", ticketId);
    f.store.save("experience_trace_distillation_ticket", ticketId, { ...current, expires_at_ms: initial.expires_at_ms, trace_record_digest: "sha256:changed" });
    assert.match(JSON.stringify(await call({ ticket_id: ticketId })), /Authorized Trace source is unavailable or changed/u);
    current = f.store.get("experience_trace_distillation_ticket", ticketId);
    f.store.save("experience_trace_distillation_ticket", ticketId, { ...current, trace_record_digest: initial.trace_record_digest,
      recovery_verifier_digest: `sha256:${"1".repeat(64)}` });
    assert.match(JSON.stringify(await call({ ticket_id: ticketId })), /ticket no longer proves a failed and then passed identical verifier/u);
    current = f.store.get("experience_trace_distillation_ticket", ticketId);
    f.store.save("experience_trace_distillation_ticket", ticketId, { ...current, recovery_verifier_digest: initial.recovery_verifier_digest,
      authorization_digest: "sha256:changed" });
    assert.match(JSON.stringify(await call({ ticket_id: ticketId })), /Authorized Trace source no longer matches its ticket/u);
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.equal(f.store.count("experience_learning_work_item"), 0);
  } finally { await f.close(); }
});

test("MCP continuation rejects a ticket if its pinned Trace events or terminal event disappear", async t => {
  for (const mode of ["all", "terminal"] as const) {
    const f = await fixture();
    try {
      const { binding, ticket_id: ticketId } = await verifiedRecovery(f, `missing-${mode}-session`, `missing-${mode}-turn`);
      const originalList = f.store.list.bind(f.store);
      t.mock.method(f.store, "list", (kind: string, ...args: Parameters<typeof f.store.list> extends [string, ...infer Rest] ? Rest : never) => {
        const rows = originalList(kind, ...args);
        return kind === "trace_event" ? mode === "all" ? [] : rows.filter(row => row.event_kind !== "task.terminal_verification") : rows;
      });
      const response = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding, ticket_id: ticketId });
      assert.match(JSON.stringify(response), /ticket no longer proves a failed and then passed identical verifier/u);
      assert.equal(f.store.count("experience_procedure"), 0);
      assert.equal(f.store.count("experience_learning_work_item"), 0);
    } finally { t.mock.restoreAll(); await f.close(); }
  }
});

test("MCP skip rejects a ticket whose claimed state changes before closing", async t => {
  const f = await fixture();
  try {
    const { binding, ticket_id: ticketId } = await verifiedRecovery(f, "skip-race-session", "skip-race-turn");
    const originalFind = f.store.find.bind(f.store);
    let ticketReads = 0;
    t.mock.method(f.store, "find", (kind: string, id: string, version?: number, hydrate?: boolean) => {
      const found = originalFind(kind, id, version, hydrate);
      if (kind === "experience_trace_distillation_ticket" && id === ticketId && ++ticketReads === 3 && found) return { ...found, status: "retryable" };
      return found;
    });
    const result = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding, ticket_id: ticketId, decision: "skip" });
    assert.match(JSON.stringify(result), /ticket cannot be skipped from this Host turn/u);
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.equal(f.store.count("experience_learning_work_item"), 0);
  } finally { t.mock.restoreAll(); await f.close(); }
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
