import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CodexHookBridge, HookSignalSanitizer, codexProjectScope, explicitMemoryStatement } from "../core/codex-hook-bridge.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-codex-hook-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: await CraftService.open(store) };
}
async function dispose(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

test("session-only Hook events join one generated turn and stop cannot finalize it twice", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "generated-turn" };
    await bridge.handle("context", { ...base, hook_event_name: "UserPromptSubmit", prompt: "verify changes" });
    const session = f.store.list("context_hook_session", 10)[0]!;
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    const journal = f.store.list("codex_hook_turn", 10)[0]!;
    assert.equal(journal.turn_id, session.last_turn_id);
    assert.equal(journal.verification_outcome, "passed");
    await bridge.handle("context", { ...base, hook_event_name: "Stop" });
    assert(f.store.list("activation_proof_receipt", 100).some(proof => proof.event === "Stop" && proof.component === "experience" && proof.turn_id === journal.turn_id && proof.observation_written === true));
    await bridge.handle("context", { ...base, hook_event_name: "Stop" });
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    assert.equal((f.store.list("codex_hook_turn", 10)[0]!.signals as JsonObject[]).length, 2);
    assert.deepEqual(f.store.get("context_hook_session", String(session.id)).pending_turn_ids, []);
  } finally { await dispose(f); }
});

test("overlapping Hook turns refuse missing IDs even after one explicitly closes", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "overlap" };
    for (const turn_id of ["one", "two"]) await bridge.handle("context", { ...base, turn_id, hook_event_name: "UserPromptSubmit", prompt: "verify changes" });
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("context", { ...base, turn_id: "one", hook_event_name: "Stop" });
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    assert(f.store.list("codex_hook_turn", 10).every(turn => turn.closed_at && (turn.signals as JsonObject[]).length === 0));
    await bridge.handle("context", { ...base, turn_id: "two", hook_event_name: "PostToolUse", tool_name: "Edit" });
    assert(f.store.list("codex_hook_turn", 10).some(turn => turn.turn_id === "two" && !turn.closed_at));
    await bridge.handle("context", { ...base, turn_id: "two", hook_event_name: "Stop" });
    await bridge.handle("context", { ...base, hook_event_name: "UserPromptSubmit", prompt: "new independent turn" });
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    assert.equal(f.store.list("codex_hook_turn", 10).filter(turn => !turn.closed_at).length, 1);
  } finally { await dispose(f); }
});

test("Codex hook scope and explicit memory parser never retain arbitrary prompts", () => {
  assert.deepEqual(codexProjectScope("/work/../craft")?.kind, "project");
  assert.match(String(codexProjectScope("/work/../craft")?.id), /^project:/u);
  assert.equal(codexProjectScope(" "), null);
  assert.equal(explicitMemoryStatement("ordinary conversation"), null);
  assert.equal(explicitMemoryStatement("记住：我偏好无糖咖啡"), "我偏好无糖咖啡");
  assert.equal(explicitMemoryStatement("/remember: token=abcdefghijklmnopqrstuvwxyz"), null);
  assert.equal(codexProjectScope(7), null);
  assert.equal(explicitMemoryStatement("记住： "), null);
  assert.equal(explicitMemoryStatement(""), null);
  assert.equal(explicitMemoryStatement(`记住：${"x".repeat(1_001)}`), null);
});

test("Hook signal sanitizer accepts only local edit or verification metadata", () => {
  const sanitizer = new HookSignalSanitizer();
  assert.equal(sanitizer.signal({ toolName: "Write", toolInput: { cmd: "ignored" }, toolResponse: { status: "success" } })?.kind, "edit");
  assert.equal(sanitizer.signal({ tool: { name: "Bash" }, input: { script: "go test ./..." }, output: { status: "passed" } })?.kind, "verification");
  assert.equal(sanitizer.signal({ tool_name: "Bash", tool_input: { command: "git apply patch.diff" }, tool_response: { exit_code: "error" } })?.outcome, "failed");
  assert.equal(sanitizer.signal({ tool_name: "Bash", tool_input: { command: "pnpm test" } })?.outcome, "unknown");
  assert.equal(sanitizer.signal({ tool_name: "unknown" }), null);
  assert.equal(sanitizer.signal({}), null);
  assert.equal(sanitizer.signal({ tool_name: "Bash", tool_input: { command: "echo hello" } }), null);
});

test("Knowledge, Memory and Experience hooks resolve only their named Context member", async () => {
  const f = await fixture();
  try {
    const scope = resolve("/project/craft");
    f.service.knowledgeMemoryInstallBuiltins();
    const evidence = f.service.evidenceRecord({ evidence_id: "hook-evidence", source_type: "program", confidence: "confirmed", claim: "fixture" });
    const claim = f.service.knowledgeClaimSave({ claim_id: "hook-claim", source_id: "builtin.evidence-wiki", kind: "rule", scope: `project:${scope}`, content: "Use a focused verification command.", evidence_ids: [evidence.id] }).claim as JsonObject;
    f.service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "fixture", reason: "verified" });
    f.service.memoryLedgerRemember({ memory_id: "hook-memory", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: scope, content: "Prefer short feedback.", confidence: "bounded" });
    const bridge = new CodexHookBridge(f.service);
    const knowledge = await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: scope, prompt: "Which verification command should I use?" });
    assert.match(String(knowledge.additionalContext), /focused verification/u);
    assert.doesNotMatch(String(knowledge.additionalContext), /short feedback/u);
    const memory = await bridge.handle("memory", { hook_event_name: "UserPromptSubmit", cwd: scope, prompt: "记住：我本周只喝无糖咖啡" });
    assert.match(String(memory.additionalContext), /无糖咖啡/u);
    const canonicalScope = codexProjectScope(scope)!;
    const stored = f.service.memoryLedgerList({ scope_kind: "project", scope_id: canonicalScope.id, include_history: true }).memories as JsonObject[];
    assert.equal(stored.length, 1);
    assert(stored.some((item) => String(item.content).includes("无糖咖啡")));
    await bridge.handle("memory", { hook_event_name: "UserPromptSubmit", cwd: scope, prompt: "这句话不能被存成长期记忆" });
    assert.equal((f.service.memoryLedgerList({ scope_kind: "project", scope_id: canonicalScope.id, include_history: true }).memories as JsonObject[]).length, 1);
    const procedureRef = f.store.contentStore.writeSync({ kind: "experience", folder: "prompts", record_id: "hook-procedure", version: 1, scope: `project:${canonicalScope.id}`, status: "routeable", sensitivity: "internal", source_id: "fixture", title: "终态验证", body: "# 终态验证\n\n先运行验证。" });
    f.store.create("experience_procedure", "hook-procedure", { scope: `project:${canonicalScope.id}`, lifecycle: "routeable", routeable: true, procedure_kind: "prompt", trigger: "verification", title: "终态验证", acceptance_ref: "acceptance:fixture", scenario_signature: { project: canonicalScope.id }, content_ref: procedureRef, content_digest: procedureRef.digest });
    const experience = await bridge.handle("experience", { hook_event_name: "UserPromptSubmit", cwd: scope, prompt: "Which verification command should I use?" });
    assert.match(String(experience.additionalContext), /content_digest/u);
    assert.doesNotMatch(String(experience.additionalContext), /先运行验证/u);
    assert.doesNotMatch(String(experience.additionalContext), /focused verification|short feedback/u);
    const proof = f.service.activationProofDoctor({});
    const components = proof.components as JsonObject[];
    assert.equal(components.find((item) => item.component === "knowledge")!.status, "executed");
    assert.equal(components.find((item) => item.component === "memory")!.explicit_memory_written, true);
    assert.equal(components.find((item) => item.component === "experience")!.context_receipt_id !== null, true);
  } finally { await dispose(f); }
});

test("Context Hook resolves one shared receipt and records each component without duplicate recall", async () => {
  const f = await fixture();
  try {
    const cwd = resolve("/project/craft"); const scope = codexProjectScope(cwd)!;
    f.service.knowledgeMemoryInstallBuiltins();
    const evidence = f.service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "fixture" });
    const claim = f.service.knowledgeClaimSave({ source_id: "builtin.evidence-wiki", kind: "rule", scope: `project:${cwd}`, content: "Run focused verification.", evidence_ids: [evidence.id] }).claim as JsonObject;
    f.service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "fixture", reason: "verified" });
    f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: scope.id, content: "Prefer short feedback.", confidence: "bounded" });
    const bridge = new CodexHookBridge(f.service);
    const response = await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, session_id: "context-session", turn_id: "context-turn", prompt: "verification feedback" });
    const injected = JSON.parse(String(response.additionalContext)) as JsonObject;
    assert.equal(injected.source, "craft-context");
    assert.equal(f.store.count("context_resolution_receipt"), 1);
    const receipt = f.store.get("context_resolution_receipt", String(injected.receipt_id));
    assert.deepEqual(receipt.members, ["experience", "knowledge", "memory"]);
    assert.match(JSON.stringify(injected.selected), /focused verification|short feedback/u);
    const proofs = f.store.list("activation_proof_receipt", 10);
    assert.deepEqual(proofs.map((item) => item.component).sort(), ["experience", "knowledge", "memory"]);
    assert(proofs.every((item) => item.context_receipt_id === receipt.id));
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, prompt: "记住：我偏好无糖咖啡" });
    assert.equal((f.service.memoryLedgerList({ scope_kind: "project", scope_id: scope.id, include_history: true }).memories as JsonObject[]).length, 2);
  } finally { await dispose(f); }
});

test("Context Hook keeps sibling recall available after a rejected memory capture and records Experience once", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const cwd = "/project/craft";
    const original = f.service.memoryCaptureUserStatement;
    f.service.memoryCaptureUserStatement = () => { throw new Error("fixture private content"); };
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, prompt: "记住：我偏好无糖咖啡" });
    f.service.memoryCaptureUserStatement = () => { throw "opaque failure"; };
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, prompt: "记住：我偏好红茶" });
    f.service.memoryCaptureUserStatement = original;
    assert.equal(f.store.count("context_resolution_receipt"), 2);
    const failures = f.store.events("codex-hook").filter((event) => event.event_type === "codex_hook.failed");
    assert.equal(failures.length, 2);
    assert.equal((failures[1]!.payload as JsonObject).error_type, "unknown");
    assert.doesNotMatch(JSON.stringify(failures), /fixture private content|opaque failure|无糖咖啡|红茶/u);
    f.service.memoryCaptureUserStatement = () => ({ candidate: null, next_action: "none" });
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, session_id: "session", turn_id: "capture-empty", prompt: "记住：这个项目使用 Java" });
    f.service.memoryCaptureUserStatement = original;
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, session_id: "session", turn_id: "capture-success", prompt: "记住：以后默认使用 Node.js" });
    await bridge.handle("context", { hook_event_name: "SessionStart", cwd, session_id: "session" });
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, session_id: "session", turn_id: "turn", prompt: "Fix the failing test" });
    await bridge.handle("context", { hook_event_name: "PostToolUse", cwd, session_id: "session", turn_id: "turn", tool_name: "Edit" });
    await bridge.handle("context", { hook_event_name: "PostToolUse", cwd, session_id: "session", turn_id: "turn", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    await bridge.handle("context", { hook_event_name: "Stop", cwd, session_id: "session", turn_id: "turn" });
    await bridge.handle("context", { hook_event_name: "SessionEnd", cwd, session_id: "session" });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
    assert.equal(f.store.events("codex-hook").filter((event) => event.event_type === "codex_hook.lifecycle").length, 9);
    assert.deepEqual(await bridge.handle("context", { hook_event_name: "UnknownEvent", cwd }), {});
  } finally { await dispose(f); }
});

test("Experience hooks persist only redacted verified signals and propose after two independent turns", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const cwd = "/project/craft";
    for (const turn of ["one", "two"]) {
      await bridge.handle("experience", { hook_event_name: "UserPromptSubmit", cwd, session_id: "session", turn_id: turn, prompt: "Implement a verified change" });
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: "session", turn_id: turn, tool_name: "apply_patch", tool_input: { patch: "secret=abcdefghijklmnop" } });
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: "session", turn_id: turn, tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
      await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: "session", turn_id: turn, scenario_key: "coding.feature-implementation" });
    }
    for (const scenario_key of ["coding.feature-implementation", "bad scenario", "coding.other-scenario"]) {
      await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: "session", turn_id: "two", scenario_key });
    }
    const journals = f.store.list("codex_hook_turn", 10);
    assert.equal(journals.length, 2);
    assert.doesNotMatch(JSON.stringify(journals), /abcdefghijklmnop|pnpm test/u);
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 2);
    const requests = f.store.list("workflow_evolution_request", 10);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.procedure_kind, "workflow");
    assert.deepEqual(requests[0]!.design_axes, ["orchestration"]);
    await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: "session", turn_id: "two" });
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);
  } finally { await dispose(f); }
});

test("Experience ignores unverified and unrelated local tool events", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd: "/project/craft", turn_id: "unverified", tool_name: "Bash", tool_input: { command: "echo hello" }, tool_response: { exit_code: 0 } });
    await bridge.handle("experience", { hook_event_name: "Stop", cwd: "/project/craft", turn_id: "unverified" });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 0);
    const sanitizer = new HookSignalSanitizer();
    assert.equal(sanitizer.signal({ tool_name: "web.run", tool_input: { query: "x" } }), null);
    assert.equal(sanitizer.signal({ tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: { exit_code: 7 } })?.outcome, "failed");
  } finally { await dispose(f); }
});

test("MCP Host completion enters the same verified Experience proposal loop idempotently", async () => {
  const f = await fixture();
  try {
    const server = new (await import("../core/mcp.ts")).McpServer(f.service, "full");
    const context = await f.service.contextOpen({ project_root: f.root, query: "task completion", include_codebase: false, task_id: "task-one" });
    const receiptId = String((context.receipt as JsonObject).id);
    const call = async (taskId: string) => server.handle({ jsonrpc: "2.0", id: taskId, method: "tools/call", params: { name: "craft_learning_cycle_finalize", arguments: { host: "mcp_host", task_id: taskId, turn_id: "turn", context_receipt_id: receiptId, verified: true, verification_outcome: taskId === "task-one" ? "passed" : "failed", verification_ref: `test-run:${taskId}`, scenario_key: "coding.feature-implementation" } } }) as Promise<any>;
    const first = await call("task-one"); assert.equal(first.result.structuredContent.status, "observed");
    const replay = await call("task-one"); assert.equal(replay.result.structuredContent.idempotent, true);
    const second = await call("task-two"); assert.equal(second.result.structuredContent.status, "candidate_request");
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 2);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);
    assert.equal(f.store.list("memory_candidate", 100).length, 0);
    const ignored = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "craft_learning_cycle_finalize", arguments: { host: "mcp_host", task_id: "task-three", turn_id: "turn", context_receipt_id: receiptId, verified: false, verification_outcome: "passed", verification_ref: "test-run:three" } } }) as any;
    assert.equal(ignored.result.structuredContent.status, "ignored");
  } finally { await dispose(f); }
});

test("MCP learning completion rejects unbound, malformed, or unverified terminal signals", async () => {
  const f = await fixture();
  try {
    const { McpServer } = await import("../core/mcp.ts");
    const server = new McpServer(f.service, "full");
    const context = await f.service.contextOpen({ project_root: f.root, query: "completion", include_codebase: false });
    const receiptId = String((context.receipt as JsonObject).id);
    const base = { host: "mcp_host", task_id: "task", turn_id: "turn", context_receipt_id: receiptId, verified: true, verification_outcome: "passed", verification_ref: "test:verified", scenario_key: "coding.feature-implementation" };
    const call = (args: JsonObject) => server.handle({ jsonrpc: "2.0", id: "invalid", method: "tools/call", params: { name: "craft_learning_cycle_finalize", arguments: args } }) as Promise<any>;
    assert.equal((await call({ ...base, context_receipt_id: String((context.pack_receipt as JsonObject).id), verified: false })).result.structuredContent.status, "ignored");
    for (const args of [{ ...base, host: "MCP" }, { ...base, verification_outcome: "unknown" }, { ...base, context_receipt_id: "missing" }, { ...base, verified: false }]) {
      const result = await call(args); assert.equal(result.result.isError, args.verified === false ? false : true);
    }
    for (const key of ["host", "task_id", "turn_id", "context_receipt_id", "verification_outcome", "verification_ref"]) {
      const result = await call({ ...base, [key]: " " }); assert.equal(result.result.isError, true, key);
    }
    f.store.create("context_resolution_receipt", "missing-scope", { scope: null });
    assert.equal((await call({ ...base, context_receipt_id: "missing-scope" })).result.isError, true);
    f.store.create("context_resolution_receipt", "invalid-scope", { scope: { kind: "project" } });
    assert.equal((await call({ ...base, context_receipt_id: "invalid-scope" })).result.isError, true);
    f.store.create("context_resolution_receipt", "task-bound", { scope: { kind: "project", id: "project" }, task_id: "owner-task" });
    assert.equal((await call({ ...base, context_receipt_id: "task-bound" })).result.isError, true);
    const failed = await call({ ...base, verification_outcome: "failed" }); assert.equal(failed.result.structuredContent.status, "observed");
  } finally { await dispose(f); }
});

test("MCP completion keeps unclassified task observations out of cross-task Experience candidates", async () => {
  const f = await fixture();
  try {
    const context = await f.service.contextOpen({ project_root: f.root, query: "completion", include_codebase: false });
    const base = { host: "mcp_host", turn_id: "turn", context_receipt_id: String((context.receipt as JsonObject).id), verified: true, verification_outcome: "passed", verification_ref: "test:verified" };
    const first = f.service.learningCycleFinalize({ ...base, task_id: "one" });
    const second = f.service.learningCycleFinalize({ ...base, task_id: "two" });
    assert.equal(first.status, "observed"); assert.equal(first.next_action, "stable_scenario_key_required_for_cross_task_learning");
    assert.equal(second.status, "observed"); assert.equal(second.request, null);
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 2);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 0);
    assert.throws(() => f.service.learningCycleFinalize({ ...base, task_id: "bad", scenario_key: "feature implementation" }), /bounded stable identifier/u);
  } finally { await dispose(f); }
});

test("verified repeated tasks create a pinned distillation ticket readable through the Experience request tool", async () => {
  const f = await fixture();
  try {
    f.store.create("evaluation_model_profile", "experience-distiller", { provider: "qwen", model: "qwen-plus", lifecycle: "active",
      purposes: ["workflow_evolution"], network_execution_enabled: false, identity_digest: "profile-digest" });
    const context = await f.service.contextOpen({ project_root: f.root, query: "verified work", include_codebase: false });
    const base = { host: "mcp_host", turn_id: "turn", context_receipt_id: String((context.receipt as JsonObject).id), verified: true,
      verification_outcome: "passed", verification_ref: "test:verification", scenario_key: "coding.distillation" };
    f.service.learningCycleFinalize({ ...base, task_id: "first" });
    const finalized = f.service.learningCycleFinalize({ ...base, task_id: "second" });
    assert.equal(finalized.status, "candidate_request");
    assert.equal((finalized.model_ticket as JsonObject).status, "needs_enablement");
    const replay = f.service.learningCycleFinalize({ ...base, task_id: "second" });
    assert.equal(replay.status, "candidate_request"); assert.equal(replay.idempotent, true);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);
    const materials = f.service.learningCycleRequestGet({ request_id: String((finalized.request as JsonObject).id) });
    assert.equal((materials.observations as JsonObject[]).length, 2);
    assert.equal(materials.content_stored, false);
    assert.equal(materials.execution_authority, false);
    assert.equal((materials.observations as JsonObject[]).some(item => "verification_ref" in item), false);
    assert.throws(() => f.service.learningCycleRequestGet({ request_id: " " }), /request_id must not be empty/u);
    f.store.create("workflow_evolution_request", "empty-learning-request", { observation_refs: null });
    assert.deepEqual(f.service.learningCycleRequestGet({ request_id: "empty-learning-request" }).observations, []);
    const submitted = f.service.workflowEvolutionProposalSubmit({ request_id: String((finalized.request as JsonObject).id), workflow_id: "distilled-workflow",
      name: "Verified completion", description: "Check the terminal verifier.", inputs: [], steps: [{ id: "verify", type: "assertion" }] });
    assert.equal((submitted.procedure as JsonObject).lifecycle, "candidate");
    const afterSubmission = f.service.learningCycleFinalize({ ...base, task_id: "second" });
    assert.equal(afterSubmission.status, "candidate_submitted"); assert.equal(afterSubmission.idempotent, true);
  } finally { await dispose(f); }
});

test("Hook journal covers missing identity, updates signals, and learning records failed verification", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const cwd = "/project/craft";
    const sanitizer = new HookSignalSanitizer();
    const signal = sanitizer.signal({ tool_name: "Edit", tool_input: {} });
    assert(signal);
    assert.equal(bridge.journal.record({ cwd }, signal), null);
    assert.equal(bridge.journal.find({ cwd }), null);
    bridge.journal.bindContextReceipt({ cwd }, { id: "orphan" });
    assert.equal(bridge.journal.find({ cwd, session_id: "missing-session" }), null);
    const first = bridge.journal.record({ cwd, turn_id: "duplicate" }, signal);
    assert(first);
    assert.equal(bridge.journal.record({ cwd, turn_id: "duplicate" }, signal)?.id, first.id);
    bridge.journal.record({ cwd, turn_id: "no-receipt" }, signal);
    const passed = sanitizer.signal({ tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    assert(passed); bridge.journal.record({ cwd, turn_id: "no-receipt" }, passed);
    assert.equal(bridge.learning.finalize({ cwd, turn_id: "no-receipt" }), null);
    bridge.journal.bindContextReceipt({ cwd, turn_id: "orphan-without-session" }, { id: "orphan-receipt" });
    for (const turn of ["failed-one", "failed-two"]) {
      await bridge.handle("experience", { hook_event_name: "UserPromptSubmit", cwd, session_id: turn, turn_id: turn, prompt: "Fix and verify" });
      assert.equal(typeof bridge.journal.find({ cwd, turn_id: turn })?.context_receipt_id, "string");
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: turn, turn_id: turn, tool_name: "Edit" });
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: turn, turn_id: turn, tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { status: "failed" } });
      await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: turn, turn_id: turn, scenario_key: "coding.feature-implementation" });
    }
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);
    const evidence = f.store.list("evidence", 10);
    assert.equal(evidence.length, 2);
    await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: "failed-two", turn_id: "failed-two" });
    assert.equal(f.store.list("evidence", 10).length, 2);
  } finally { await dispose(f); }
});

test("Hook bridge is fail-open for unsupported events and component failures", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UnknownEvent", cwd: "/project/craft" }), {});
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "Stop", cwd: "/project/craft" }), {});
    assert.deepEqual(await bridge.handle("experience", { hook_event_name: "UserPromptSubmit", cwd: "/project/craft", user_prompt: "no stored context" }), {});
    const original = f.service.contextWorkingSets.resolve;
    f.service.contextWorkingSets.resolve = async () => { throw new Error("fixture failure"); };
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: "/project/craft", prompt: "context" }), {});
    f.service.contextWorkingSets.resolve = original;
    f.service.contextWorkingSets.resolve = async () => ({ items: [{ memory_id: "stub", memory_version: 1, content: "stub" }], contributions: [{ items: "not-an-array" }], receipt: null }) as never;
    const projected = await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: "/project/craft", prompt: "context" });
    assert.match(String(projected.additionalContext), /"receipt_id":null/u);
    f.service.contextWorkingSets.resolve = async () => { throw "fixture failure"; };
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: "/project/craft", prompt: "context" }), {});
    f.service.contextWorkingSets.resolve = original;
    assert.equal(f.store.events("codex-hook").filter((event) => event.event_type === "codex_hook.failed").length, 2);
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", prompt: "context" }), {});
  } finally { await dispose(f); }
});

test("Hook mints a fresh turn when the Host omits its native turn identifier", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const cwd = "/project/craft";
    await bridge.handle("experience", { hook_event_name: "UserPromptSubmit", cwd, session_id: "native-less", prompt: "Review this change" });
    const firstTurn = String(f.store.list("context_hook_session", 10)[0]!.last_turn_id);
    await bridge.handle("experience", { hook_event_name: "UserPromptSubmit", cwd, session_id: "native-less", prompt: "Review the next change" });
    const secondTurn = String(f.store.list("context_hook_session", 10)[0]!.last_turn_id);
    assert.match(firstTurn, /^hook_turn_/u); assert.match(secondTurn, /^hook_turn_/u); assert.notEqual(firstTurn, secondTurn);
    assert.equal(f.store.list("context_hook_session", 10)[0]!.sequence, 2);
    await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: "native-less", tool_name: "Edit" });
    await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: "native-less", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: "native-less" });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
  } finally { await dispose(f); }
});

test("Lifecycle hooks record boundaries without counting readiness as component usage", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    await bridge.handle("knowledge", { hook_event_name: "SessionStart", cwd: "/project/craft", session_id: "session", source: "claude" });
    await bridge.handle("knowledge", { hook_event_name: "Stop", cwd: "/project/craft", session_id: "session", turn_id: "turn" });
    await bridge.handle("knowledge", { hook_event_name: "SessionEnd", cwd: "/project/craft", session_id: "session", reason: "other" });
    await bridge.handle("knowledge", { hook_event_name: "SessionEnd", cwd: "/project/craft", reason: "missing-session" });
    const events = f.store.events("codex-hook").filter((event) => event.event_type === "codex_hook.lifecycle");
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((event) => (event.payload as JsonObject).event), ["SessionStart", "Stop", "SessionEnd", "SessionEnd"]);
    assert(events.every((event) => ((event.payload as JsonObject).usage as JsonObject).component_used === false));
    assert.match(String(((events[0]!.payload as JsonObject).scope as JsonObject).id), /^project:/u);
    assert.equal((events[3]!.payload as JsonObject).session_id, "unknown");
  } finally { await dispose(f); }
});


test("explicit stopped turns reject late signals and repeated learning, including turns without edits", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "closed", turn_id: "explicit" };
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    await bridge.handle("context", { ...base, hook_event_name: "Stop" });
    const closed = bridge.journal.find(base)!;
    assert(closed.closed_at);
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("context", { ...base, hook_event_name: "Stop" });
    assert.deepEqual(bridge.journal.find(base), closed);
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
    const empty = { ...base, turn_id: "empty" };
    await bridge.handle("context", { ...empty, hook_event_name: "Stop" });
    await bridge.handle("context", { ...empty, hook_event_name: "PostToolUse", tool_name: "Edit" });
    assert.deepEqual(bridge.journal.find(empty)!.signals, []);
  } finally { await dispose(f); }
});


test("reused native turn IDs remain distinct across sessions and legacy journals stay readable", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, turn_id: "turn-1" };
    for (const session_id of ["session-a", "session-b"]) {
      const input = { ...base, session_id };
      await bridge.handle("experience", { ...input, hook_event_name: "PostToolUse", tool_use_id: "same-edit-id", tool_name: "Edit" });
      await bridge.handle("experience", { ...input, hook_event_name: "PostToolUse", tool_use_id: "same-check-id", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
      await bridge.handle("experience", { ...input, hook_event_name: "Stop" });
    }
    const journals = f.store.list("codex_hook_turn", 10);
    assert.equal(journals.length, 2);
    assert(journals.every(journal => journal.closed_at && (journal.signals as JsonObject[]).length === 2));
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 2);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);
    const scope = codexProjectScope(f.root)!;
    const turn = "legacy-turn";
    const legacyId = `codex_hook_turn_${createHash("sha256").update(JSON.stringify({ scope, turn })).digest("hex").slice(-20)}`;
    f.store.create("codex_hook_turn", legacyId, { scope, turn_id: turn, session_id: "legacy-session", signals: [], content_stored: false });
    assert.equal(bridge.journal.find({ ...base, turn_id: turn, session_id: "legacy-session" })?.id, legacyId);
    assert.equal(bridge.journal.find({ ...base, turn_id: turn, session_id: "foreign-session" }), null);
    await bridge.handle("experience", { ...base, turn_id: turn, session_id: "legacy-session", hook_event_name: "Stop" });
    assert(f.store.get("codex_hook_turn", legacyId).closed_at);
  } finally { await dispose(f); }
});
