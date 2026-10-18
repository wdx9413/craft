import assert from "node:assert/strict";
import { activeProcedure } from "../capability/craft-experience/procedure-release.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CodexHookBridge, HookSignalSanitizer, automaticMemoryFact, codexProjectScope, explicitMemoryStatement } from "../core/codex-hook-bridge.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { defaultSettings } from "../core/settings.ts";

async function fixture(models?: ReturnType<typeof defaultSettings>["models"]) {
  const root = await mkdtemp(join(tmpdir(), "craft-codex-hook-"));
  const paths = craftPaths(root);
  if (models) {
    const settings = defaultSettings(paths);
    settings.models = models;
    await writeFile(paths.settingsFile, JSON.stringify(settings));
  }
  const store = await new CraftStore(paths).open();
  const service = await CraftService.open(store);
  const projectScope = codexProjectScope(root)!;
  service.scopeAliasBind({ scope_kind: "project", scope_id: projectScope.id, alias_kind: "path", alias: root });
  return { root, store, service };
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
    assert(f.store.list("codex_hook_turn", 10).every(turn => (turn.signals as JsonObject[]).length === 0));
    assert(f.store.list("codex_hook_turn", 10).some(turn => turn.turn_id === "one" && turn.closed_at));
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
  assert.equal(automaticMemoryFact("本项目默认使用 Node.js"), "Node.js");
  assert.equal(automaticMemoryFact("以后请优先运行 focused tests"), "运行 focused tests");
  assert.equal(automaticMemoryFact("我偏好无糖咖啡"), "无糖咖啡");
  assert.equal(automaticMemoryFact("I prefer terminal reviews"), "terminal reviews");
  assert.equal(automaticMemoryFact("普通的任务对话"), null);
  assert.equal(automaticMemoryFact("本项目使用 token=abcdefghijklmnopqrstuvwxyz"), null);
  assert.equal(automaticMemoryFact("不要记录：本项目使用 Node.js"), null);
});

test("Memory Hook automatically captures only classified stable project facts into the session tier", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "automatic-memory-session", prompt: "本项目默认使用 Node.js" });
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "automatic-memory-session", prompt: "请修复这个测试" });
    const records = f.service.memoryLedgerList({ scope_kind: "session", scope_id: "automatic-memory-session", include_history: true }).memories as JsonObject[];
    assert.equal(records.length, 1);
    assert.equal(records[0]!.content, "Node.js");
    assert.equal(records[0]!.status, "active");
    const evidence = f.store.get("evidence", String((records[0]!.evidence_ids as string[])[0]));
    assert.equal((evidence.metadata as JsonObject).capture_mode, "host-observed-stable-fact");
    const sessionMemoryPath = f.service.memoryGovernance.ledger.files.pathFor({ kind: "session", id: "automatic-memory-session" });
    assert.equal(existsSync(sessionMemoryPath!), true);
  } finally { await dispose(f); }
});

test("Hook Memory output projects promotion summaries and legacy journals default missing sessions safely", async () => {
  const f = await fixture();
  const originalCapture = f.service.memoryCaptureObservedFact;
  try {
    f.service.memoryCaptureObservedFact = (() => ({ auto_committed: false, candidate: { id: "candidate" }, next_action: "review",
      topic_suggestions: [], memory_file: null, promotions: [{ tier: "session", auto_committed: false, memory_file: null }] })) as typeof f.service.memoryCaptureObservedFact;
    const bridge = new CodexHookBridge(f.service);
    const output = await bridge.handle("memory", { hook_event_name: "UserPromptSubmit", cwd: f.root,
      session_id: "promotion-session", prompt: "本项目默认使用 Node.js" });
    const emitted = JSON.parse(String(output.additionalContext)) as JsonObject;
    assert.deepEqual((emitted.memory_capture as JsonObject).promotions, [{ tier: "session", auto_committed: false, memory_file: null }]);

    const turn = "legacy-unknown-session", scope = codexProjectScope(f.root)!;
    const legacyId = `codex_hook_turn_${createHash("sha256").update(JSON.stringify({ scope, turn })).digest("hex").slice(-20)}`;
    f.store.create("codex_hook_turn", legacyId, { turn_id: turn });
    assert.equal(bridge.journal.find({ cwd: f.root, turn_id: turn })?.id, legacyId);
  } finally {
    f.service.memoryCaptureObservedFact = originalCapture;
    await dispose(f);
  }
});

test("Memory SessionEnd removes the temporary Memory body and ledger rows", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    f.service.knowledgeMemoryInstallBuiltins();
    const sessionId = "session-end-memory-cleanup";
    f.service.memoryCaptureUserStatement({ content: "Temporary session fact", kind: "episodic", topic: "temporary-fact", session_id: sessionId });
    const sessionFile = f.service.memoryGovernance.ledger.files.pathFor({ kind: "session", id: sessionId });
    assert(sessionFile && existsSync(sessionFile));

    await bridge.handle("memory", { hook_event_name: "SessionEnd", cwd: f.root, session_id: sessionId });

    assert.equal(existsSync(sessionFile), false);
    assert.equal(f.store.listScoped("memory_ledger", [{ kind: "session", id: sessionId }], 100).length, 0);

    const originalArchive = f.service.memorySessionArchive;
    const mutableService = f.service as CraftService & { memorySessionArchive: (args: JsonObject) => JsonObject };
    for (const [session_id, failure] of [["archive-error", new Error("cleanup failed")], ["archive-opaque-error", "cleanup failed"]] as const) {
      mutableService.memorySessionArchive = () => { throw failure; };
      await bridge.handle("memory", { hook_event_name: "SessionEnd", cwd: f.root, session_id });
    }
    mutableService.memorySessionArchive = originalArchive;
    const failures = f.store.events("codex-hook").filter(event => event.event_type === "codex_hook.failed");
    assert.equal(failures.length, 2);
    assert.deepEqual(failures.map(event => (event.payload as JsonObject).error_type), ["Error", "unknown"]);
  } finally { await dispose(f); }
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
    const scope = f.root;
    const canonicalScope = codexProjectScope(scope)!;
    f.service.knowledgeMemoryInstallBuiltins();
    const evidence = f.service.evidenceRecord({ evidence_id: "hook-evidence", source_type: "program", confidence: "confirmed", claim: "fixture" });
    const claim = f.service.knowledgeClaimSave({ claim_id: "hook-claim", source_id: "builtin.evidence-wiki", kind: "rule", scope: `project:${canonicalScope.id}`, content: "Use a focused verification command.", evidence_ids: [evidence.id] }).claim as JsonObject;
    f.service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "fixture", reason: "verified" });
    f.service.memoryLedgerRemember({ memory_id: "hook-memory", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: canonicalScope.id, content: "Prefer short feedback.", confidence: "bounded" });
    const bridge = new CodexHookBridge(f.service);
    const knowledge = await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: scope, prompt: "Which verification command should I use?" });
    assert.match(String(knowledge.additionalContext), /focused verification/u);
    assert.doesNotMatch(String(knowledge.additionalContext), /short feedback/u);
    const memory = await bridge.handle("memory", { hook_event_name: "UserPromptSubmit", cwd: scope, session_id: "memory-session", prompt: "记住：我本周只喝无糖咖啡" });
    assert.match(String(memory.additionalContext), /无糖咖啡/u);
    const stored = f.service.memoryLedgerList({ scope_kind: "session", scope_id: "memory-session", include_history: true }).memories as JsonObject[];
    assert.equal(stored.length, 1);
    assert(stored.some((item) => String(item.content).includes("无糖咖啡")));
    await bridge.handle("memory", { hook_event_name: "UserPromptSubmit", cwd: scope, session_id: "memory-session", prompt: "这句话不能被存成长期记忆" });
    assert.equal((f.service.memoryLedgerList({ scope_kind: "session", scope_id: "memory-session", include_history: true }).memories as JsonObject[]).length, 1);
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
    const sessionMemoryPath = f.service.memoryGovernance.ledger.files.pathFor({ kind: "session", id: "memory-session" })!;
    assert.equal(existsSync(sessionMemoryPath), true);
    await bridge.handle("memory", { hook_event_name: "SessionEnd", cwd: scope, session_id: "memory-session" });
    assert.equal(existsSync(sessionMemoryPath), false);
    assert.equal(f.service.memoryLedgerList({ scope_kind: "session", scope_id: "memory-session", include_history: true }).count, 0);
  } finally { await dispose(f); }
});

test("Context Hook resolves one shared receipt and records each component without duplicate recall", async () => {
  const f = await fixture();
  try {
    const cwd = f.root; const scope = codexProjectScope(cwd)!;
    f.service.knowledgeMemoryInstallBuiltins();
    const evidence = f.service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "fixture" });
    const claim = f.service.knowledgeClaimSave({ source_id: "builtin.evidence-wiki", kind: "rule", scope: `project:${scope.id}`, content: "Run focused verification.", evidence_ids: [evidence.id] }).claim as JsonObject;
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
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, session_id: "context-session", prompt: "记住：我偏好无糖咖啡" });
    assert.equal((f.service.memoryLedgerList({ scope_kind: "session", scope_id: "context-session", include_history: true }).memories as JsonObject[]).length, 1);
  } finally { await dispose(f); }
});

test("Context Hook keeps sibling recall available after a rejected memory capture and records Experience once", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const cwd = "/project/craft";
    const original = f.service.memoryCaptureUserStatement;
    f.service.memoryCaptureUserStatement = () => { throw new Error("fixture private content"); };
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, session_id: "failed-session", prompt: "记住：我偏好无糖咖啡" });
    f.service.memoryCaptureUserStatement = () => { throw "opaque failure"; };
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, session_id: "failed-session", prompt: "记住：我偏好红茶" });
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
    assert(journals.every(journal => (journal.signals as JsonObject[]).filter(item => item.kind === "verification")
      .every(item => item.scenario_key === "coding.feature-implementation")));
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

test("explicit Experience scenario aligns a legacy journal with no signal array", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "legacy-scenario", turn_id: "turn" };
    await bridge.handle("experience", { ...base, hook_event_name: "UserPromptSubmit", prompt: "verify a legacy turn" });
    await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
    const journal = f.store.list("codex_hook_turn", 10).find(item => item.turn_id === base.turn_id)!;
    f.store.save("codex_hook_turn", String(journal.id), { ...journal, signals: null });

    await bridge.handle("experience", { ...base, hook_event_name: "Stop", scenario_key: "coding.explicit-legacy" });

    const finalized = f.store.get("codex_hook_turn", String(journal.id));
    assert.equal(finalized.scenario_key, "coding.explicit-legacy");
    assert.deepEqual(finalized.signals, []);
    assert.equal(typeof finalized.closed_at, "string");
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
  } finally { await dispose(f); }
});

test("project Experience scenario catalog uses exact mappings and leaves unmapped or ambiguous tasks unclassified", async () => {
  const f = await fixture();
  try {
    const projectId = codexProjectScope(f.root)!.id.replace(/^project:/u, "");
    const experienceDir = join(f.store.paths.experienceDir, "projects", projectId); await mkdir(experienceDir, { recursive: true });
    const catalogPath = join(experienceDir, "experience-scenarios.json");
    await writeFile(catalogPath, JSON.stringify({
      schema: "craft.experience-scenario-catalog.v1",
      scenarios: [{ scenario_key: "coding.test-failure-recovery", verification_commands: ["pnpm test:focused"] }],
    }));
    assert.equal(existsSync(join(f.root, ".craft_data", "experience", "experience-scenarios.json")), false);
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "catalog-session" };
    for (const turn_id of ["one", "two"]) {
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "UserPromptSubmit", prompt: "make a verified project change" });
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "PostToolUse", tool_name: "Edit" });
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:focused" }, tool_response: { exit_code: 0 } });
      const journal = f.store.list("codex_hook_turn", 10).find(item => item.turn_id === turn_id)!;
      assert.deepEqual((journal.signals as JsonObject[]).map(item => ({ kind: item.kind, outcome: item.outcome, scenario_key: item.scenario_key })), [
        { kind: "edit", outcome: "unknown", scenario_key: undefined }, { kind: "verification", outcome: "passed", scenario_key: "coding.test-failure-recovery" },
      ]);
      assert.equal(journal.scenario_key, "coding.test-failure-recovery");
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "Stop" });
    }
    const observations = f.store.list("workflow_evolution_observation", 10);
    assert.equal(observations.length, 2);
    assert.equal(observations[0]!.scenario_key, observations[1]!.scenario_key);
    assert.match(String(observations[0]!.scenario_key), /^scenario:/u);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);
    await bridge.handle("experience", { ...base, turn_id: "unmatched", hook_event_name: "UserPromptSubmit", prompt: "make another verified project change" });
    await bridge.handle("experience", { ...base, turn_id: "unmatched", hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("experience", { ...base, turn_id: "unmatched", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
    const unmatched = f.store.list("codex_hook_turn", 10).find(item => item.turn_id === "unmatched")!;
    assert.equal(unmatched.scenario_key, null);
    await bridge.handle("experience", { ...base, turn_id: "unmatched", hook_event_name: "Stop" });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 3);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);
    await writeFile(catalogPath, JSON.stringify({
      schema: "craft.experience-scenario-catalog.v1",
      scenarios: [
        { scenario_key: "coding.test-failure-recovery", verification_commands: ["pnpm test:focused"] },
        { scenario_key: "coding.other", verification_commands: ["pnpm test:focused"] },
      ],
    }));
    await bridge.handle("experience", { ...base, turn_id: "ambiguous", hook_event_name: "UserPromptSubmit", prompt: "make an ambiguous project change" });
    await bridge.handle("experience", { ...base, turn_id: "ambiguous", hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("experience", { ...base, turn_id: "ambiguous", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:focused" }, tool_response: { exit_code: 0 } });
    assert.equal(f.store.list("codex_hook_turn", 10).find(item => item.turn_id === "ambiguous")?.scenario_key, null);
    await bridge.handle("experience", { ...base, turn_id: "ambiguous", hook_event_name: "Stop" });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 4);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);
  } finally { await dispose(f); }
});

test("Experience scenario catalogs keep coarse and fine identities distinct through observations", async () => {
  const f = await fixture();
  try {
    const projectId = codexProjectScope(f.root)!.id.replace(/^project:/u, "");
    const directory = join(f.store.paths.experienceDir, "projects", projectId);
    await mkdir(directory, { recursive: true });
    const catalogPath = join(directory, "experience-scenarios.json");
    const catalog = (fineParent: string) => ({ schema: "craft.experience-scenario-catalog.v1", scenarios: [
      { scenario_key: "engineering.change", tier: "coarse", verification_commands: [] },
      { scenario_key: "engineering.change.typescript-tests", tier: "fine", parent_scenario_key: fineParent, verification_commands: ["pnpm test:focused"] },
    ] });
    await writeFile(catalogPath, JSON.stringify(catalog("engineering.change")));
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "hierarchical-scenarios" };
    for (const turn_id of ["one", "two"]) {
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "UserPromptSubmit", prompt: "repair the type check" });
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "PostToolUse", tool_name: "Edit" });
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:focused" }, tool_response: { exit_code: 0 } });
      const turn = f.store.list("codex_hook_turn", 10).find(item => item.turn_id === turn_id)!;
      assert.equal(turn.scenario_key, "engineering.change.typescript-tests");
      assert.equal(turn.coarse_scenario_key, "engineering.change");
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "Stop" });
    }
    const observations = f.store.list("workflow_evolution_observation", 10);
    assert.equal(observations.length, 2);
    const signature = observations[0]!.scenario_signature as JsonObject;
    assert.equal(signature.scenario_key, "engineering.change.typescript-tests");
    assert.equal(signature.coarse_scenario_key, undefined);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);

    const rejectedCatalogs = [
      catalog("missing.parent"),
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "bad.coarse", tier: "coarse", verification_commands: ["pnpm test:focused"] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "bad.evaluation", tier: "coarse", verification_commands: [], evaluation: {} }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "bad.self", tier: "fine", parent_scenario_key: "bad.self", verification_commands: ["pnpm test:focused"] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [
        { scenario_key: "duplicate", verification_commands: [] }, { scenario_key: "duplicate", verification_commands: ["pnpm test:focused"] },
      ] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "bad.tier", tier: "middle", verification_commands: ["pnpm test:focused"] }] },
    ];
    for (const [index, invalid] of rejectedCatalogs.entries()) {
      const turn_id = `invalid-${index}`;
      await writeFile(catalogPath, JSON.stringify(invalid));
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "UserPromptSubmit", prompt: "another change" });
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "PostToolUse", tool_name: "Edit" });
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:focused" }, tool_response: { exit_code: 0 } });
      assert.equal(f.store.list("codex_hook_turn", 20).find(item => item.turn_id === turn_id)?.scenario_key, null);
    }
  } finally { await dispose(f); }
});

test("Hook scenario catalog rejects malformed, linked and oversized metadata before classification", async () => {
  const f = await fixture();
  try {
    const projectId = codexProjectScope(f.root)!.id.replace(/^project:/u, "");
    const directory = join(f.store.paths.experienceDir, "projects", projectId);
    await mkdir(directory, { recursive: true });
    const catalogPath = join(directory, "experience-scenarios.json");
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "invalid-catalogs" };
    const malformed: unknown[] = [
      null, [], { schema: "wrong", scenarios: [] }, { schema: "craft.experience-scenario-catalog.v1", scenarios: "bad" },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: Array.from({ length: 65 }, (_, i) => ({ scenario_key: `scene.${i}`, verification_commands: [] })) },
      ...[null, [], {}, { scenario_key: "bad key", verification_commands: [] },
        { scenario_key: "scene.valid", verification_commands: "bad" },
        { scenario_key: "scene.valid", verification_commands: Array.from({ length: 33 }, () => "pnpm test") },
        { scenario_key: "scene.valid", verification_commands: [1] },
        { scenario_key: "scene.valid", verification_commands: ["x".repeat(501)] },
        { scenario_key: "scene.valid", verification_commands: [], verification_digests: "bad" },
        { scenario_key: "scene.valid", verification_commands: [], verification_digests: Array.from({ length: 33 }, () => "sha256:" + "a".repeat(64)) },
        { scenario_key: "scene.valid", verification_commands: [], verification_digests: ["bad"] },
        { scenario_key: "scene.valid", verification_commands: [], lifecycle: "retired" },
      ].map(scenario => ({ schema: "craft.experience-scenario-catalog.v1", scenarios: [scenario] })),
    ];
    for (const [index, value] of malformed.entries()) {
      await writeFile(catalogPath, JSON.stringify(value));
      await bridge.handle("experience", { ...base, turn_id: `invalid-${index}`, hook_event_name: "PostToolUse", tool_name: "Bash",
        tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
      const turn = f.store.list("codex_hook_turn", 100).find(item => item.turn_id === `invalid-${index}`)!;
      assert.equal(turn.scenario_key, null);
    }
    await writeFile(catalogPath, "{");
    await bridge.handle("experience", { ...base, turn_id: "invalid-json", hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
    await bridge.handle("experience", { session_id: "no-cwd", turn_id: "no-cwd", hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
    await bridge.handle("experience", { ...base, turn_id: "missing-command", hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { exit_code: 0 } });
    await bridge.handle("context", { ...base, hook_event_name: "UserPromptSubmit" });
    await unlink(catalogPath);
    await writeFile(join(directory, "outside.json"), "{}");
    await symlink(join(directory, "outside.json"), catalogPath);
    await bridge.handle("experience", { ...base, turn_id: "linked-catalog", hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
    await unlink(catalogPath);
    await writeFile(catalogPath, " ".repeat(16_385));
    await bridge.handle("experience", { ...base, turn_id: "oversized-catalog", hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });

    const turn = { cwd: f.root, session_id: "bound", turn_id: "bound-turn" };
    bridge.journal.bindContextReceipt(turn, { id: "context-receipt" });
    bridge.journal.bindContextReceipt(turn, { id: "context-receipt" });
    assert.equal(bridge.journal.find(turn)?.context_receipt_id, "context-receipt");
    for (const [turn_id, session_id] of [["legacy-match", "legacy-session"], ["legacy-mismatch", "different-session"]] as const) {
      const legacyId = `codex_hook_turn_${createHash("sha256").update(JSON.stringify({ scope: codexProjectScope(f.root), turn: turn_id })).digest("hex").slice(-20)}`;
      f.store.create("codex_hook_turn", legacyId, { session_id, turn_id });
    }
    assert.equal(bridge.journal.find({ cwd: f.root, session_id: "legacy-session", turn_id: "legacy-match" })?.turn_id, "legacy-match");
    assert.equal(bridge.journal.find({ cwd: f.root, session_id: "other-session", turn_id: "legacy-mismatch" }), null);

    const dispatch = bridge as unknown as { dispatch: () => Promise<undefined> };
    const originalDispatch = dispatch.dispatch;
    dispatch.dispatch = async () => undefined;
    try { assert.deepEqual(await bridge.handle("context", { hook_event_name: "UnknownEvent" }), {}); }
    finally { dispatch.dispatch = originalDispatch; }

    await writeFile(catalogPath, JSON.stringify({ schema: "craft.experience-scenario-catalog.v1", scenarios: [
      { scenario_key: "scene.verified", verification_commands: ["pnpm test"], lifecycle: "active" },
    ] }));
    for (const [turn_id, input] of [["tool-input-alias", { toolInput: { cmd: "pnpm test" } }], ["input-alias", { input: { script: "pnpm test" } }]] as const) {
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "PostToolUse", tool_name: "Bash", ...input, tool_response: { exit_code: 0 } });
      const aliasTurn = f.store.list("codex_hook_turn", 100).find(item => item.turn_id === turn_id)!;
      assert.equal(((aliasTurn.signals as JsonObject[])[0]!.scenario_key), "scene.verified");
    }
    for (const turn_id of ["invalid-supplied-scene", "conflicting-supplied-scene"]) {
      const input = { cwd: f.root, session_id: "finalize-scenes", turn_id };
      await bridge.handle("experience", { ...input, hook_event_name: "PostToolUse", tool_name: "Edit" });
      await bridge.handle("experience", { ...input, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
      bridge.journal.bindContextReceipt(input, { id: `receipt-${turn_id}` });
    }
    const errorsBefore = f.store.events("codex-hook").filter(event => event.event_type === "codex_hook.failed").length;
    await bridge.handle("experience", { cwd: f.root, session_id: "finalize-scenes", turn_id: "invalid-supplied-scene", hook_event_name: "Stop", scenario_key: "bad scene" });
    await bridge.handle("experience", { cwd: f.root, session_id: "finalize-scenes", turn_id: "conflicting-supplied-scene", hook_event_name: "Stop", scenario_key: "scene.other" });
    const errorsAfter = f.store.events("codex-hook").filter(event => event.event_type === "codex_hook.failed").length;
    assert.equal(errorsAfter, errorsBefore + 2);
  } finally { await dispose(f); }
});

test("Experience cold start does not treat matching verifier commands as semantic scenarios", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    const observe = async (session_id: string, turn_id: string, command: string) => {
      const base = { cwd: f.root, session_id, turn_id };
      await bridge.handle("experience", { ...base, hook_event_name: "UserPromptSubmit", prompt: "complete a verified project change" });
      await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
      await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { exit_code: 0 } });
      const journal = f.store.list("codex_hook_turn", 10).find(item => item.turn_id === turn_id)!;
      await bridge.handle("experience", { ...base, hook_event_name: "Stop" });
      return journal.scenario_key;
    };
    const first = await observe("session-one", "turn-one", "pnpm test:feature-a");
    const repeated = await observe("session-two", "turn-two", "pnpm test:feature-a");
    const distinct = await observe("session-three", "turn-three", "pnpm test:feature-b");
    assert.equal(first, null);
    assert.equal(repeated, null);
    assert.equal(distinct, null);
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 3);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 0);
    const persisted = JSON.stringify([...f.store.list("codex_hook_turn", 10), ...f.store.list("workflow_evolution_observation", 10), ...f.store.list("workflow_evolution_request", 10)]);
    assert.doesNotMatch(persisted, /pnpm test:feature-[ab]/u);
  } finally { await dispose(f); }
});

test("project Experience command mapping fails closed on linked and oversized catalogs", async () => {
  const f = await fixture();
  try {
    const projectId = codexProjectScope(f.root)!.id.replace(/^project:/u, "");
    const directory = join(f.store.paths.experienceDir, "projects", projectId);
    await mkdir(directory, { recursive: true });
    const catalogPath = join(directory, "experience-scenarios.json"), target = join(f.root, "outside-scenario-catalog.json");
    const valid = JSON.stringify({ schema: "craft.experience-scenario-catalog.v1", scenarios: [
      { scenario_key: "coding.test", verification_commands: ["pnpm test:focused"] },
    ] });
    await writeFile(target, valid);
    await symlink(target, catalogPath);
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "scenario-catalog-safety" };
    for (const turn_id of ["linked", "oversized", "non-file", "malformed"]) {
      if (turn_id === "oversized") { await rm(catalogPath); await writeFile(catalogPath, "x".repeat(16_385)); }
      if (turn_id === "non-file") { await rm(catalogPath); await mkdir(catalogPath); }
      if (turn_id === "malformed") { await rm(catalogPath, { recursive: true }); await writeFile(catalogPath, "not-json"); }
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "UserPromptSubmit", prompt: "make a verified change" });
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "PostToolUse", tool_name: "Edit" });
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:focused" }, tool_response: { exit_code: 0 } });
      const journal = f.store.list("codex_hook_turn", 10).find(item => item.turn_id === turn_id)!;
      assert.equal(journal.scenario_key, null);
      assert.equal((journal.signals as JsonObject[])[1]?.scenario_key, undefined);
      await bridge.handle("experience", { ...base, turn_id, hook_event_name: "Stop" });
    }
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 0);
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
    const verifierCommand = "pnpm test:feature";
    const verifierDigest = `sha256:${createHash("sha256").update(JSON.stringify(verifierCommand)).digest("hex")}`;
    const call = async (taskId: string) => server.handle({ jsonrpc: "2.0", id: taskId, method: "tools/call", params: { name: "craft_learning_cycle_finalize", arguments: { host: "mcp_host", task_id: taskId, turn_id: "turn", context_receipt_id: receiptId, verified: true, verification_outcome: taskId === "task-one" ? "passed" : "failed", verification_ref: `test-run:${taskId}`, scenario_key: "coding.feature-implementation", scenario_definition: { summary: "实现功能并验证改动", applies_when: "项目代码发生变化且需要运行验收", excludes: "只读咨询或纯文档任务" }, coarse_scenario_key: "engineering.code-change", scenario_verifier_digest: verifierDigest } } }) as Promise<any>;
    const first = await call("task-one"); assert.equal(first.result.structuredContent.status, "observed");
    const replay = await call("task-one"); assert.equal(replay.result.structuredContent.idempotent, true);
    const second = await call("task-two"); assert.equal(second.result.structuredContent.status, "candidate_request");
    assert.equal(((second.result.structuredContent.observation as JsonObject).scenario_signature as JsonObject).coarse_scenario_key, undefined);
    assert.equal((second.result.structuredContent.scenario_catalog as JsonObject).coarse_scenario_key, "engineering.code-change");
    assert.equal((second.result.structuredContent.scenario_catalog as JsonObject).status, "active");
    assert.match(String((second.result.structuredContent.request as JsonObject).hypothesis), /实现功能并验证改动/u);
    assert.match(String((second.result.structuredContent.request as JsonObject).hypothesis), /纯文档任务/u);
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 2);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 1);
    const requestId = String((second.result.structuredContent.request as JsonObject).id);
    const trace = f.service.traceGet({ trace_id: second.result.structuredContent.trace_correlation.trace_id });
    assert((trace.events as JsonObject[]).some(event => event.event_kind === "component.call.completed" && (event.output_refs as string[]).includes(requestId)));
    assert.equal(f.store.list("memory_candidate", 100).length, 0);
    const bridge = new CodexHookBridge(f.service), hookBase = { cwd: f.root, session_id: "catalog-hook", turn_id: "catalog-hook-turn" };
    await bridge.handle("experience", { ...hookBase, hook_event_name: "UserPromptSubmit", prompt: "Implement a verified feature" });
    await bridge.handle("experience", { ...hookBase, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("experience", { ...hookBase, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: verifierCommand }, tool_response: { exit_code: 0 } });
    const hookTurn = f.store.list("codex_hook_turn", 10).find(turn => turn.turn_id === hookBase.turn_id)!;
    assert.equal(hookTurn.scenario_key, "coding.feature-implementation");
    assert.equal(hookTurn.coarse_scenario_key, "engineering.code-change");
    const ignored = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "craft_learning_cycle_finalize", arguments: { host: "mcp_host", task_id: "task-three", turn_id: "turn", context_receipt_id: receiptId, verified: false, verification_outcome: "passed", verification_ref: "test-run:three" } } }) as any;
    assert.equal(ignored.result.structuredContent.status, "ignored");
  } finally { await dispose(f); }
});

test("Stop Hook does not count an MCP-classified completion twice for the same Host turn", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), session = "shared-finalization-session", turn = "shared-finalization-turn";
    const base = { cwd: f.root, session_id: session, turn_id: turn };
    await bridge.handle("experience", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Implement and verify a feature" });
    await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:feature" }, tool_response: { exit_code: 0 } });
    const journal = f.store.list("codex_hook_turn", 10, row => row.turn_id === turn)[0]!;
    const receipt = f.store.find("context_resolution_receipt", String(journal.context_receipt_id))!;
    const classified = f.service.learningCycleFinalize({ host: "codex", task_id: String(receipt.task_id ?? "model-task"), turn_id: turn,
      context_receipt_id: String(journal.context_receipt_id), verified: true, verification_outcome: "passed", verification_ref: "model-verifier-receipt",
      scenario_key: "engineering.feature-verification", scenario_definition: { summary: "实现并验证功能", applies_when: "项目功能代码发生变化并通过目标验证", excludes: "只读咨询或纯文档变更" } });
    assert.equal(classified.status, "observed");
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
    await bridge.handle("experience", { ...base, hook_event_name: "Stop" });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 0);
    const observation = f.store.list("workflow_evolution_observation", 10)[0]!;
    assert.equal(observation.source && (observation.source as JsonObject).id, String(receipt.task_id ?? "model-task"));
    assert.match(String((observation.scenario_signature as JsonObject).scenario_key), /engineering\.feature-verification/u);
    assert(f.store.list("activation_proof_receipt", 100).some(proof => proof.event === "Stop" && proof.component === "experience" && proof.turn_id === turn && proof.observation_written === true));
  } finally { await dispose(f); }
});

test("Stop Hook rejects a second terminal outcome for a turn already finalized by MCP", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), session = "conflicting-finalization-session", turn = "conflicting-finalization-turn";
    const base = { cwd: f.root, session_id: session, turn_id: turn };
    await bridge.handle("experience", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Implement and verify a feature" });
    await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:feature" }, tool_response: { exit_code: 0 } });
    const journal = f.store.list("codex_hook_turn", 10, row => row.turn_id === turn)[0]!;
    const receipt = f.store.find("context_resolution_receipt", String(journal.context_receipt_id))!;
    f.service.learningCycleFinalize({ host: "codex", task_id: String(receipt.task_id ?? "model-task"), turn_id: turn,
      context_receipt_id: String(journal.context_receipt_id), verified: true, verification_outcome: "failed", verification_ref: "mismatched-model-outcome" });
    await bridge.handle("experience", { ...base, hook_event_name: "Stop" });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
    assert(f.store.events("codex-hook").some(event => event.event_type === "codex_hook.failed"),
      "the conflicting terminal outcome must leave a failure event instead of a second Observation");
  } finally { await dispose(f); }
});

test("Stop Hook recovers a terminal signal when its matching completion Evidence has no Observation", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), session = "orphan-completion-session", turn = "orphan-completion-turn";
    const base = { cwd: f.root, session_id: session, turn_id: turn };
    await bridge.handle("experience", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Implement and verify a feature" });
    await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:feature" }, tool_response: { exit_code: 0 } });
    const journal = f.store.list("codex_hook_turn", 10, row => row.turn_id === turn)[0]!;
    f.service.evidenceRecord({ evidence_id: "orphan-host-completion", source_type: "host_completion_signal", confidence: "bounded",
      claim: "Host reported terminal verification passed.", locator: `context-receipt:${journal.context_receipt_id}`,
      metadata: { provenance: "host_completion_signal", host: "codex", turn_id: turn, context_receipt_id: journal.context_receipt_id, content_stored: false } });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 0);
    await bridge.handle("experience", { ...base, hook_event_name: "Stop" });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
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
    const completionScope = (context.receipt as JsonObject).scope as JsonObject;
    const completionProjectScope = `project:${String(completionScope.id).replace(/^project:/u, "")}`;
    assert.deepEqual(f.service.experienceScenarioList({ scope: "project:project" }), { scope: "project:project", catalog_version: 0, scenarios: [] });
    assert.equal(f.service.experienceScenarioList({ scope_kind: "project", scope_id: "project" }).catalog_version, 0);
    assert.throws(() => f.service.experienceScenarioList({ scope: "global" }), /explicit project scope/u);
    assert.throws(() => f.service.experienceScenarioList({ scope_kind: "project" }), /explicit project scope/u);
    const first = f.service.learningCycleFinalize({ ...base, task_id: "one" });
    const second = f.service.learningCycleFinalize({ ...base, task_id: "two" });
    assert.equal(first.status, "observed"); assert.equal(first.next_action, "stable_scenario_key_required_for_cross_task_learning");
    assert.equal(second.status, "observed"); assert.equal(second.request, null);
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 2);
    assert.equal(f.store.list("workflow_evolution_request", 10).length, 0);
    assert.throws(() => f.service.learningCycleFinalize({ ...base, task_id: "bad", scenario_key: "feature implementation" }), /bounded stable identifier/u);
    assert.throws(() => f.service.learningCycleFinalize({ ...base, task_id: "orphan-coarse", coarse_scenario_key: "engineering" }), /requires scenario_key/u);
    assert.throws(() => f.service.learningCycleFinalize({ ...base, task_id: "bad-coarse", scenario_key: "engineering.tests", coarse_scenario_key: "bad scene" }), /bounded stable identifier/u);
    assert.throws(() => f.service.learningCycleFinalize({ ...base, task_id: "bad-verifier-digest", scenario_verifier_digest: "bad" }), /SHA-256 digest/u);
    assert.throws(() => f.service.learningCycleFinalize({ ...base, task_id: "bad-definition", scenario_key: "engineering.tests", scenario_definition: null }), /definition is invalid/u);
    assert.throws(() => f.service.learningCycleFinalize({ ...base, task_id: "orphan-definition", scenario_key: "engineering.tests",
      coarse_scenario_definition: { summary: "x", applies_when: "x", excludes: "x" } }), /requires coarse_scenario_key/u);
    const classified = f.service.learningCycleFinalize({ ...base, task_id: "classified", scenario_key: "engineering.tests", coarse_scenario_key: "engineering",
      scenario_definition: { summary: "项目测试", applies_when: "项目变更通过测试验证", excludes: "仅写文档" },
      coarse_scenario_definition: { summary: "项目工程交付", applies_when: "项目工程变更经过验收", excludes: "只读咨询" } });
    assert.equal((classified.observation as JsonObject).scenario_signature && ((classified.observation as JsonObject).scenario_signature as JsonObject).coarse_scenario_key, undefined);
    const experienceMcp = new (await import("../core/mcp.ts")).McpServer(f.service, "component-experience");
    const experienceTools = await experienceMcp.handle({ jsonrpc: "2.0", id: "experience-tools", method: "tools/list" });
    assert(((experienceTools?.result as JsonObject).tools as JsonObject[]).some(tool => tool.name === "craft_experience_scenario_retire"),
      "Experience advanced surface must expose scenario retirement");
    assert(((experienceTools?.result as JsonObject).tools as JsonObject[]).some(tool => tool.name === "craft_experience_scenario_migration_propose"),
      "Experience advanced surface must expose taxonomy migrations");
    const experienceDaily = new (await import("../core/mcp.ts")).McpServer(f.service, "component-experience-daily");
    const experienceDailyTools = await experienceDaily.handle({ jsonrpc: "2.0", id: "experience-daily-tools", method: "tools/list" });
    const dailyNames = ((experienceDailyTools?.result as JsonObject).tools as JsonObject[]).map(tool => tool.name);
    assert(dailyNames.includes("craft_experience_scenario_migration_propose"));
    assert(!dailyNames.includes("craft_experience_scenario_retire"));
    const migrationBefore = f.service.experienceScenarioList({ scope: completionProjectScope });
    const migration = await experienceMcp.handle({ jsonrpc: "2.0", id: "experience-split-propose", method: "tools/call", params: {
      name: "craft_experience_scenario_migration_propose", arguments: { scope: completionProjectScope, mode: "split",
        source_keys: ["engineering.tests"], targets: [
          { scenario_key: "engineering.tests.unit", definition: { summary: "单元测试", applies_when: "改动由目标单元测试验证", excludes: "集成验收" } },
          { scenario_key: "engineering.tests.integration", definition: { summary: "集成测试", applies_when: "改动由跨模块集成验证", excludes: "单元级验证" } },
        ], expected_catalog_version: migrationBefore.catalog_version, request_id: "split-tests-v1", reason: "distinct acceptance paths" } } });
    assert.equal((migration?.result as JsonObject).isError, false, JSON.stringify(migration?.result));
    const migrationResult = (migration?.result as JsonObject).structuredContent as JsonObject;
    assert.equal(migrationResult.status, "candidate");
    assert.equal(f.service.experienceScenarioList({ scope: completionProjectScope }).catalog_version, Number(migrationBefore.catalog_version) + 1);
    assert(f.store.list("trace_event", 10_000, event => event.operation_id === "craft_experience_scenario_migration_propose"
      && event.event_kind === "component.call.completed").length > 0, "taxonomy proposal must have a component Trace");
    const experienceCatalog = f.service.experienceScenarioList({ scope: completionProjectScope });
    assert.throws(() => f.service.experienceScenarioRetire({ scope: "global", scenario_key: "x", expected_catalog_version: 0, request_id: "bad-scope", reason: "x" }), /explicit project scope/u);
    assert.throws(() => f.service.experienceScenarioRetire({ scope_kind: "project", expected_catalog_version: 0, request_id: "incomplete-scope", reason: "x" }), /explicit project scope/u);
    assert.throws(() => f.service.experienceScenarioRetire({ scope_kind: "project", scope_id: "project", expected_catalog_version: 0, request_id: "missing-key", reason: "x" }), /request is invalid/u);
    assert.throws(() => f.service.experienceScenarioRetire({ scope: completionProjectScope, scenario_key: "x", expected_catalog_version: -1, request_id: "bad-version", reason: "x" }), /non-negative integer/u);
    assert.throws(() => f.service.experienceScenarioRetire({ scope: completionProjectScope, scenario_key: "x", expected_catalog_version: 0, request_id: " ", reason: "x" }), /must not be empty/u);
    assert.throws(() => f.service.experienceScenarioMigrationPropose({ scope: "global", source_keys: [], targets: [] }), /explicit project scope/u);
    assert.throws(() => f.service.experienceScenarioMigrationPropose({ scope_kind: "project", source_keys: [], targets: [] }), /explicit project scope/u);
    assert.throws(() => f.service.experienceScenarioMigrationPropose({ scope: completionProjectScope, source_keys: "x", targets: [] }), /must be arrays/u);
    assert.throws(() => f.service.experienceScenarioMigrationPropose({ scope_kind: "project", scope_id: "project", mode: "split", source_keys: [], targets: [] }), /proposal is invalid/u);
    const retiredSignature = { schema: "craft.scenario-signature.v1", project: completionScope, scenario_key: "engineering.tests" };
    const routeableProcedure = f.store.create("experience_procedure", "routeable-retired-scene", { scope: completionProjectScope,
      lifecycle: "routeable", routeable: true, scenario_signature: retiredSignature, definition_digest: "sha256:procedure" });
    f.store.create("experience_release", String(routeableProcedure.id), { record_version: routeableProcedure.version,
      status: "active", definition_digest: "sha256:procedure" });
    const pendingProcedure = f.store.create("experience_procedure", "candidate-retired-scene", { scope: completionProjectScope,
      lifecycle: "candidate", routeable: false, scenario_signature: retiredSignature, definition_digest: "sha256:candidate" });
    const pendingDispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: pendingProcedure.id }).dispatch as JsonObject;
    assert.equal(activeProcedure(f.store, String(routeableProcedure.id))?.id, routeableProcedure.id);
    const retired = await experienceMcp.handle({ jsonrpc: "2.0", id: "experience-retire", method: "tools/call", params: { name: "craft_experience_scenario_retire",
      arguments: { scope: completionProjectScope, scenario_key: "engineering.tests", expected_catalog_version: experienceCatalog.catalog_version,
        request_id: "retire-tests-v1", reason: "scenario definition is obsolete" } } });
    assert.equal((retired?.result as JsonObject).isError, false, JSON.stringify(retired?.result));
    const retirementResult = (retired?.result as JsonObject).structuredContent as JsonObject;
    assert.equal(retirementResult.status, "retired");
    assert.equal(retirementResult.revoked_procedure_count, 2);
    assert.equal(retirementResult.cancelled_dispatch_count, 1);
    const retirementEvents = f.store.list("trace_event", 10_000, event => event.operation_id === "craft_experience_scenario_retire");
    assert(retirementEvents.some(event => event.event_kind === "component.call.completed"),
      "scenario retirement must remain visible in the component Trace");
    assert.equal(activeProcedure(f.store, String(routeableProcedure.id)), null, "retired scenarios must leave the current Experience release path");
    assert.equal(f.store.find("experience_release", String(routeableProcedure.id))?.status, "revoked");
    assert.equal(f.store.get("experience_procedure", String(pendingProcedure.id)).lifecycle, "rolled_back");
    assert.equal(f.store.get("experience_evaluation_dispatch", String(pendingDispatch.id)).status, "cancelled");
    const retirementReplay = f.service.experienceScenarioRetire({ scope: completionProjectScope, scenario_key: "engineering.tests",
      expected_catalog_version: experienceCatalog.catalog_version, request_id: "retire-tests-v1", reason: "scenario definition is obsolete" });
    assert.equal(retirementReplay.idempotent, true);
    assert.equal(retirementReplay.revoked_procedure_count, 0);
    assert.equal(retirementReplay.cancelled_dispatch_count, 0);
    assert.throws(() => f.service.experienceLearningEvaluationDispatch({ procedure_id: pendingProcedure.id }), /scenario is retired/u);
    assert.throws(() => f.service.experienceLearningEvaluationResult({ dispatch_id: pendingDispatch.id, evidence_ids: ["unused"] }), /already resolved/u);
    f.store.create("workflow_evolution_request", "retired-scene-request", { scenario_key: "scenario:retired",
      scenario_signature: retiredSignature, procedure_kind: "workflow", observation_refs: [], output_contract_ref: "acceptance:retired" });
    assert.throws(() => f.service.workflowEvolutionProposalSubmit({ request_id: "retired-scene-request" }), /scenario is retired/u);
    const afterRetirement = f.service.learningCycleFinalize({ ...base, task_id: "retired-scene-task", scenario_key: "engineering.tests" });
    assert.equal(afterRetirement.status, "observed");
    assert.equal(afterRetirement.next_action, "stable_scenario_key_required_for_cross_task_learning");
    assert.equal(((afterRetirement.observation as JsonObject).scenario_signature as JsonObject).source, "legacy_scenario_key",
      "retired Experience scenes must retain only the unclassified legacy digest");
    const fineOnly = f.service.learningCycleFinalize({ ...base, task_id: "parent-late-one", scenario_key: "engineering.parent-late" });
    const sameTaskParentAdded = f.service.learningCycleFinalize({ ...base, task_id: "parent-late-one", scenario_key: "engineering.parent-late", coarse_scenario_key: "engineering" });
    assert.equal(sameTaskParentAdded.idempotent, true);
    assert.equal((sameTaskParentAdded.observation as JsonObject).id, (fineOnly.observation as JsonObject).id);
    assert.equal((sameTaskParentAdded.scenario_catalog as JsonObject).coarse_scenario_key, "engineering");
    const parentAdded = f.service.learningCycleFinalize({ ...base, task_id: "parent-late-two", scenario_key: "engineering.parent-late", coarse_scenario_key: "engineering" });
    assert.equal(parentAdded.status, "candidate_request");
    assert.equal((fineOnly.observation as JsonObject).scenario_key, (parentAdded.observation as JsonObject).scenario_key);
    assert.equal((fineOnly.observation as JsonObject).scenario_signature && ((fineOnly.observation as JsonObject).scenario_signature as JsonObject).coarse_scenario_key, undefined);
    assert.equal((parentAdded.scenario_catalog as JsonObject).coarse_scenario_key, "engineering");
    f.store.create("context_resolution_receipt", "user-bound", { scope: { kind: "user", id: "user-a" }, task_id: "user-task" });
    const userScope = f.service.learningCycleFinalize({ ...base, context_receipt_id: "user-bound", task_id: "user-task", scenario_key: "personal.workflow" });
    assert.equal(userScope.scenario_catalog, null);
  } finally { await dispose(f); }
});

test("Host scene classification refines the same terminal observation before independent tasks accumulate", async () => {
  const f = await fixture();
  try {
    const context = await f.service.contextOpen({ project_root: f.root, query: "verified feature work", include_codebase: false });
    const base = { host: "mcp_host", turn_id: "refine-turn-1", context_receipt_id: String((context.receipt as JsonObject).id), verified: true,
      verification_outcome: "passed", verification_ref: "test:verified" };
    const unclassified = f.service.learningCycleFinalize({ ...base, task_id: "refine-task-1" });
    const original = unclassified.observation as JsonObject;
    assert.equal((original.scenario_signature as JsonObject).source, "unclassified");
    const originalSource = original.source as JsonObject;
    const completionEvidenceId = String((original.evidence_ids as string[])[0]);
    const completionEvidence = f.store.get("evidence", completionEvidenceId);
    const legacyEvidenceMetadata = { ...(completionEvidence.metadata as JsonObject) };
    delete legacyEvidenceMetadata.terminal_identity_digest;
    f.store.save("evidence", completionEvidenceId, { ...completionEvidence, metadata: legacyEvidenceMetadata });
    f.store.create("workflow_evolution_observation", "legacy-refinement", { scenario_key: "unclassified:legacy-refinement",
      scenario_signature: { schema: "craft.scenario-signature.v1", source: "unclassified" },
      source: { kind: "host:mcp_host", id: "legacy-refinement-task", digest: "legacy-refinement-digest", scope: originalSource.scope },
      outcome: "passed", evidence_ids: original.evidence_ids, sanitized: true, content_stored: false, lifecycle: "accepted", identity_digest: "legacy" });
    const legacyRefinement = f.service.workflowEvolutionObserve({ observation_id: "legacy-refinement", scenario_key: "scenario:legacy-refinement",
      source_kind: "host:mcp_host", source_id: "legacy-refinement-task", source_digest: "legacy-refinement-digest", outcome: "passed", scope: originalSource.scope,
      scenario_signature: { schema: "craft.scenario-signature.v1", scenario_key: "engineering.tests" }, evidence_ids: original.evidence_ids,
      sanitized: true, content_stored: false });
    assert.equal(legacyRefinement.refined, true);
    assert.throws(() => f.service.workflowEvolutionObserve({ observation_id: original.id, scenario_key: "scenario:missing-classification",
      source_kind: originalSource.kind, source_id: originalSource.id, source_digest: originalSource.digest, outcome: "passed", scope: originalSource.scope,
      evidence_ids: original.evidence_ids, sanitized: true, content_stored: false }), /idempotency conflict/u);
    assert.throws(() => f.service.workflowEvolutionObserve({ observation_id: original.id, scenario_key: "scenario:still-unclassified",
      source_kind: originalSource.kind, source_id: originalSource.id, source_digest: originalSource.digest, outcome: "passed", scope: originalSource.scope,
      scenario_signature: { schema: "craft.scenario-signature.v1", source: "unclassified" }, evidence_ids: original.evidence_ids,
      sanitized: true, content_stored: false }), /idempotency conflict/u);
    assert.throws(() => f.service.workflowEvolutionObserve({ observation_id: original.id, scenario_key: "scenario:rejected-refinement",
      source_kind: originalSource.kind, source_id: originalSource.id, source_digest: originalSource.digest, outcome: "failed", scope: originalSource.scope,
      scenario_signature: { schema: "craft.scenario-signature.v1", scenario_key: "engineering.tests" }, evidence_ids: original.evidence_ids,
      sanitized: true, content_stored: false }), /idempotency conflict/u);
    const verifiedInput = { observation_id: "verification-refinement", scenario_key: "unclassified:verification-refinement",
      source_kind: "host:mcp_host", source_id: "verification-refinement-task", source_digest: "verification-refinement-digest", outcome: "passed",
      scope: `project:${String(((context.receipt as JsonObject).scope as JsonObject).id)}`, scenario_signature: { schema: "craft.scenario-signature.v1", source: "unclassified" },
      evidence_ids: original.evidence_ids, failure_type: "verified-run", verification: { contract_ref: "acceptance:test", workspace_revision: "revision:test",
        evidence_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", producer: "test", started_at: "2026-10-17T00:00:00.000Z",
        completed_at: "2026-10-17T00:00:01.000Z", exit_code: 0 }, sanitized: true, content_stored: false };
    f.service.workflowEvolutionObserve(verifiedInput);
    const verifiedRefinement = f.service.workflowEvolutionObserve({ ...verifiedInput, scenario_key: "scenario:verification-refinement",
      scenario_signature: { schema: "craft.scenario-signature.v1", scenario_key: "engineering.tests" } });
    assert.equal(verifiedRefinement.refined, true);
    const classified = f.service.learningCycleFinalize({ ...base, task_id: "host-skill-generated-task-id", scenario_key: "engineering.tests",
      scenario_definition: { summary: "工程测试", applies_when: "工程改动通过自动化测试验证", excludes: "仅写文档" } });
    const upgraded = classified.observation as JsonObject;
    assert.equal(upgraded.id, original.id);
    assert.equal(upgraded.version, Number(original.version) + 1);
    assert.equal((upgraded.scenario_signature as JsonObject).scenario_key, "engineering.tests");
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 3);
    assert.equal(f.store.list("evidence", 10, item => (item.metadata as JsonObject | undefined)?.provenance === "host_completion_signal").length, 1);
    const replay = f.service.learningCycleFinalize({ ...base, task_id: "refine-task-1", scenario_key: "engineering.tests" });
    assert.equal((replay.observation as JsonObject).id, original.id);
    assert.equal(replay.idempotent, true);
    assert.throws(() => f.service.learningCycleFinalize({ ...base, task_id: "refine-task-1", scenario_key: "engineering.build" }), /idempotency conflict/u);
    const independent = f.service.learningCycleFinalize({ ...base, turn_id: "refine-turn-2", task_id: "refine-task-2", scenario_key: "engineering.tests" });
    assert.equal(independent.status, "candidate_request");
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 4);
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
    const ticket = finalized.model_ticket as JsonObject;
    assert.equal(ticket.status, "needs_enablement");
    f.store.save("evaluation_model_ticket", String(ticket.id), { ...ticket, next_action: null });
    const replay = f.service.learningCycleFinalize({ ...base, task_id: "second" });
    assert.equal(replay.status, "candidate_request"); assert.equal(replay.idempotent, true);
    assert.equal(replay.distillation_mode, "current_host_model");
    assert.equal(replay.next_action, "current_host_model_reads_pinned_request_submits_candidate_then_runs_ordered_evaluation_gates");
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

test("the current Host model can distill and submit a verified request without a configured Provider Profile", async () => {
  const f = await fixture();
  try {
    const context = await f.service.contextOpen({ project_root: f.root, query: "verified repeated work", include_codebase: false });
    const base = { host: "mcp_host", turn_id: "turn", context_receipt_id: String((context.receipt as JsonObject).id), verified: true,
      verification_outcome: "passed", verification_ref: "test:host-distillation", scenario_key: "coding.host-distillation",
      scenario_definition: { summary: "Deliver and verify a code change", applies_when: "The project changed and its verifier completed", excludes: "Read-only advice without a verified change" } };
    assert.equal(f.service.learningCycleFinalize({ ...base, task_id: "host-first" }).status, "observed");
    const finalized = f.service.learningCycleFinalize({ ...base, task_id: "host-second" });
    assert.equal(finalized.status, "candidate_request");
    assert.equal(finalized.model_ticket, null);
    assert.equal(finalized.distillation_mode, "current_host_model");
    assert.equal(finalized.next_action, "current_host_model_reads_pinned_request_submits_candidate_then_runs_ordered_evaluation_gates");
    const requestId = String((finalized.request as JsonObject).id);
    const pinned = f.service.learningCycleRequestGet({ request_id: requestId });
    assert.equal((pinned.observations as JsonObject[]).length, 2);
    assert.equal(pinned.content_stored, false);
    const submitted = f.service.workflowEvolutionProposalSubmit({ request_id: requestId, workflow_id: "host-distilled-workflow",
      name: "Verified completion", description: "Run the selected terminal verifier.", inputs: [],
      steps: [{ id: "verify", type: "assertion", evaluator: "file_exists", path: "result.txt", side_effect: "read_only" }] });
    const procedure = submitted.procedure as JsonObject;
    assert.equal(procedure.lifecycle, "candidate");
    assert.equal((submitted.proposal as JsonObject).model_ticket_id, null);
    const dispatch = f.service.experienceLearningEvaluationDispatch({ procedure_id: String(procedure.id) }).dispatch as JsonObject;
    assert.equal(dispatch.stage, "shadow");
    assert.equal(f.store.count("evaluation_model_ticket"), 0);
  } finally { await dispose(f); }
});

test("Codex learning Host gets a queued gpt-6-luna Experience ticket without Craft API model configuration", async () => {
  const previousHost = process.env.CRAFT_LEARNING_MODEL_HOST;
  process.env.CRAFT_LEARNING_MODEL_HOST = "codex-cli";
  const f = await fixture();
  try {
    const context = await f.service.contextOpen({ project_root: f.root, query: "verified repeated work", include_codebase: false });
    const base = { host: "mcp_host", turn_id: "codex-learning-turn", context_receipt_id: String((context.receipt as JsonObject).id),
      verified: true, verification_outcome: "passed", verification_ref: "test:codex-learning", scenario_key: "coding.codex-learning" };
    assert.equal(f.service.learningCycleFinalize({ ...base, task_id: "codex-first" }).status, "observed");
    const finalized = f.service.learningCycleFinalize({ ...base, task_id: "codex-second" });
    assert.equal(finalized.status, "candidate_request");
    const ticket = finalized.model_ticket as JsonObject;
    assert.equal(ticket.status, "ready_for_adapter");
    assert.equal(ticket.purpose, "workflow_evolution");
    const profile = f.service.evaluationModelProfileGet({ profile_id: String(ticket.profile_id) }).profile as JsonObject;
    assert.equal(profile.provider, "codex-cli");
    assert.equal(profile.model, "gpt-6-luna");
    assert.equal(profile.api_key_env, "host-managed-auth-store");
    assert.equal((f.service.evaluationModelTicketList({ purpose: "workflow_evolution" }).tickets as JsonObject[]).some(item => item.id === ticket.id), true);
  } finally {
    if (previousHost === undefined) delete process.env.CRAFT_LEARNING_MODEL_HOST;
    else process.env.CRAFT_LEARNING_MODEL_HOST = previousHost;
    await dispose(f);
  }
});

test("a single configured Craft model bootstraps a bounded workflow evolution profile", async () => {
  const envName = "CRAFT_HOOK_AUTO_PROFILE_TEST_KEY";
  const previousKey = process.env[envName];
  process.env[envName] = "test-credential";
  const f = await fixture([{ id: "local-test", name: "Local test", protocol: "openai-compatible", baseUrl: "http://localhost/v1",
    model: "small-test", apiKeyEnv: envName, supportsTools: false }]);
  try {
    const context = await f.service.contextOpen({ project_root: f.root, query: "verified work", include_codebase: false });
    const base = { host: "mcp_host", turn_id: "turn", context_receipt_id: String((context.receipt as JsonObject).id), verified: true,
      verification_outcome: "passed", verification_ref: "test:verification", scenario_key: "coding.auto-profile" };
    assert.equal(f.service.learningCycleFinalize({ ...base, task_id: "first" }).status, "observed");
    const finalized = f.service.learningCycleFinalize({ ...base, task_id: "second" });
    assert.equal(finalized.status, "candidate_request");
    const ticket = finalized.model_ticket as JsonObject;
    assert.match(String(ticket.profile_id), /^evaluation_model_profile_auto_/u);
    assert.equal(ticket.status, "ready_for_adapter");
    const saved = f.service.evaluationModelProfileGet({ profile_id: String(ticket.profile_id) });
    const profile = saved.profile as JsonObject;
    assert.equal(profile.provider, "local-test");
    assert.equal(profile.model, "small-test");
    assert.equal(profile.network_execution_enabled, true);
    assert.equal(profile.max_attempts, 1);
    assert.equal(profile.max_output_tokens, 2_048);
  } finally {
    if (previousKey === undefined) delete process.env[envName];
    else process.env[envName] = previousKey;
    await dispose(f);
  }
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
      assert.equal(typeof bridge.journal.find({ cwd, session_id: turn, turn_id: turn })?.context_receipt_id, "string");
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
    await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: "native-less", tool_name: "Edit" });
    await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: "native-less", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: "native-less" });
    await bridge.handle("experience", { hook_event_name: "UserPromptSubmit", cwd, session_id: "native-less", prompt: "Review the next change" });
    const secondTurn = String(f.store.list("context_hook_session", 10)[0]!.last_turn_id);
    assert.match(firstTurn, /^hook_turn_/u); assert.match(secondTurn, /^hook_turn_/u); assert.notEqual(firstTurn, secondTurn);
    assert.equal(f.store.list("context_hook_session", 10)[0]!.sequence, 2);
    await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: "native-less", tool_name: "Edit" });
    await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: "native-less", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: "native-less" });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 2);
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
    await bridge.handle("context", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Fix and verify this change" });
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
      await bridge.handle("experience", { ...input, hook_event_name: "UserPromptSubmit", prompt: "Fix and verify this change" });
      await bridge.handle("experience", { ...input, hook_event_name: "PostToolUse", tool_use_id: "same-edit-id", tool_name: "Edit" });
      await bridge.handle("experience", { ...input, hook_event_name: "PostToolUse", tool_use_id: "same-check-id", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
      await bridge.handle("experience", { ...input, hook_event_name: "Stop", scenario_key: "coding.feature-implementation" });
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
