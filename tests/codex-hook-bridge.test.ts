import assert from "node:assert/strict";
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

test("Experience hooks persist only redacted verified signals and propose after two independent turns", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const cwd = "/project/craft";
    for (const turn of ["one", "two"]) {
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: "session", turn_id: turn, tool_name: "apply_patch", tool_input: { patch: "secret=abcdefghijklmnop" } });
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: "session", turn_id: turn, tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
      await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: "session", turn_id: turn });
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

test("Hook journal covers missing identity, updates signals, and learning records failed verification", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const cwd = "/project/craft";
    const sanitizer = new HookSignalSanitizer();
    const signal = sanitizer.signal({ tool_name: "Edit", tool_input: {} });
    assert(signal);
    assert.equal(bridge.journal.record({ cwd }, signal), null);
    assert.equal(bridge.journal.find({ cwd }), null);
    const first = bridge.journal.record({ cwd, turn_id: "duplicate" }, signal);
    assert(first);
    assert.equal(bridge.journal.record({ cwd, turn_id: "duplicate" }, signal)?.id, first.id);
    for (const turn of ["failed-one", "failed-two"]) {
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: turn, tool_name: "Edit" });
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: turn, tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { status: "failed" } });
      await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: turn });
    }
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);
    const evidence = f.store.list("evidence", 10);
    assert.equal(evidence.length, 2);
    await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: "failed-two" });
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
    const original = f.service.contextResolutionResolve;
    f.service.contextResolutionResolve = async () => { throw new Error("fixture failure"); };
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: "/project/craft", prompt: "context" }), {});
    f.service.contextResolutionResolve = original;
    f.service.contextResolutionResolve = async () => ({ items: [{ memory_id: "stub", memory_version: 1, content: "stub" }], contributions: [{ items: "not-an-array" }], receipt: null }) as never;
    const projected = await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: "/project/craft", prompt: "context" });
    assert.match(String(projected.additionalContext), /"receipt_id":null/u);
    f.service.contextResolutionResolve = async () => { throw "fixture failure"; };
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: "/project/craft", prompt: "context" }), {});
    f.service.contextResolutionResolve = original;
    assert.equal(f.store.events("codex-hook").filter((event) => event.event_type === "codex_hook.failed").length, 2);
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", prompt: "context" }), {});
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
