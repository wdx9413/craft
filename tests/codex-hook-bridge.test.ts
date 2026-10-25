import assert from "node:assert/strict";
import { activeProcedure } from "../capability/craft-experience/procedure-release.ts";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CodexHookBridge, HookSignalSanitizer, automaticMemoryFact, codexProjectScope, explicitMemoryStatement } from "../core/codex-hook-bridge.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths, sessionStorageDirectory, sessionStorageScopeId } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { defaultSettings } from "../core/settings.ts";
import { stableDigest } from "../core/digest.ts";
import { projectExperienceDirectory } from "../core/project-experience-directory.ts";
import { sanitizedExperienceTaskGoal } from "../core/codex-hook-bridge.ts";
import { codexTaskGoalDigest } from "../core/codex-task-prose.ts";
import { estimateTokens } from "../core/token-budget.ts";
import { contextAssetRef } from "../common/craft-common-base/src/context-assets.ts";
import { attachVerifiedPromotionFixture } from "./helpers/knowledge-promotion-proof.ts";

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
function localExperienceDir(f: Awaited<ReturnType<typeof fixture>>): string {
  const identity = f.service.scopeIdentityResolveProject({ project_root: f.root }).identity as JsonObject;
  return projectExperienceDirectory(f.store, String((identity.canonical_scope as JsonObject).id), f.root, true);
}

test("session-only Hook events join one generated turn and stop cannot finalize it twice", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "generated-turn" };
    await bridge.handle("context", { ...base, hook_event_name: "UserPromptSubmit", prompt: "verify changes" });
    const session = f.store.list("context_hook_session", 10)[0]!;
    assert.equal(session.trace_id, session.id);
    assert.equal(f.store.traceShards.find("context_hook_session", String(session.id), undefined, String(session.id))?.session_id, "generated-turn");
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

test("Hook-mode PostToolUse persists its journal signal without a per-event SQLite Trace", async () => {
  const f = await fixture();
  const prior = process.env.CRAFT_HOOK_MODE;
  try {
    process.env.CRAFT_HOOK_MODE = "1";
    const bridge = new CodexHookBridge(f.service), input = { cwd: f.root, session_id: "runtime-ledger", turn_id: "runtime-ledger-turn" };
    await bridge.handle("context", { ...input, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "runtime-ledger-edit" });
    assert.equal(f.store.list("trace_event", 100, event => event.operation_id === "handle.context.PostToolUse").length, 0);
    assert.equal(f.store.list("codex_hook_signal", 10, item => item.session_id === input.session_id && item.turn_id === input.turn_id).length, 1);
    const journal = bridge.journal.find({ ...input, hook_event_name: "PostToolUse" })!;
    assert.equal((journal.signals as JsonObject[]).length, 1);
    assert.equal((journal.signals as JsonObject[])[0]!.kind, "edit");
  } finally {
    if (prior === undefined) delete process.env.CRAFT_HOOK_MODE;
    else process.env.CRAFT_HOOK_MODE = prior;
    await dispose(f);
  }
});

test("Hook signal rows merge with a legacy journal, deduplicate retries and retain scenario ordering", async () => {
  const f = await fixture();
  const prior = process.env.CRAFT_HOOK_MODE;
  try {
    const bridge = new CodexHookBridge(f.service), input = { cwd: f.root, session_id: "mixed-hook-journal", turn_id: "mixed-turn" };
    const edit = bridge.signals.signal({ ...input, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "mixed-edit" });
    assert(edit);
    bridge.journal.record(input, edit);
    process.env.CRAFT_HOOK_MODE = "1";
    const rawVerification = bridge.signals.signal({ ...input, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "mixed-verify",
      tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    assert(rawVerification);
    const verification = { ...rawVerification, scenario_key: "coding.test", coarse_scenario_key: "coding" } as never;
    bridge.journal.record(input, verification);
    bridge.journal.record(input, verification);
    const journal = bridge.journal.find(input, true)!;
    assert.equal((journal.signals as JsonObject[]).length, 2);
    assert.equal((journal.verification_receipts as JsonObject[]).length, 1);
    assert.equal(journal.verification_outcome, "passed");
    assert.equal(journal.scenario_key, "coding.test");
    assert.equal(journal.coarse_scenario_key, "coding");
  } finally {
    if (prior === undefined) delete process.env.CRAFT_HOOK_MODE;
    else process.env.CRAFT_HOOK_MODE = prior;
    await dispose(f);
  }
});

test("Hook signal journal safely handles a sessionless verification without a preceding journal", async () => {
  const f = await fixture();
  const prior = process.env.CRAFT_HOOK_MODE;
  try {
    process.env.CRAFT_HOOK_MODE = "1";
    const bridge = new CodexHookBridge(f.service);
    const input = { cwd: f.root, turn_id: "sessionless-verify" };
    const raw = bridge.signals.signal({ ...input, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "sessionless-check",
      tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    assert(raw);
    bridge.journal.record(input, { ...raw, scenario_key: "coding.test" } as never);
    const journal = bridge.journal.find(input, true)!;
    assert.equal(journal.session_id, "unknown");
    assert.equal(journal.has_edit, false);
    assert.equal(journal.verification_outcome, "passed");
    assert.equal(journal.scenario_key, null);
    assert.equal((journal.verification_receipts as JsonObject[])[0]!.edit_revision, null);
    const unknownInput = { cwd: f.root, turn_id: "sessionless-unknown" };
    const unknownSignal = bridge.signals.signal({ ...unknownInput, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "sessionless-unknown-check",
      tool_input: { command: "npm test" }, tool_response: {} });
    assert(unknownSignal);
    const explicitUnknown = { ...unknownSignal, kind: "verification", verifier: "npm test", outcome: "unknown" } as never;
    bridge.journal.record(unknownInput, explicitUnknown);
    const unknownJournal = bridge.journal.find(unknownInput, true)!;
    assert.equal((unknownJournal.signals as JsonObject[])[0]!.kind, "verification");
    assert.equal((unknownJournal.signals as JsonObject[])[0]!.outcome, "unknown");
    assert.equal((unknownJournal.verification_receipts as JsonObject[]).length, 1);
    assert.equal(unknownJournal.verification_outcome, null);
    const failedInput = { cwd: f.root, turn_id: "sessionless-failed" };
    const failedSignal = bridge.signals.signal({ ...failedInput, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "sessionless-failed-check",
      tool_input: { command: "npm test" }, tool_response: { exit_code: 1 } });
    assert(failedSignal);
    bridge.journal.record(failedInput, { ...failedSignal, kind: "verification", verifier: "npm test", outcome: "failed" } as never);
    assert.equal(bridge.journal.find(failedInput, true)?.verification_outcome, "failed");
  } finally {
    if (prior === undefined) delete process.env.CRAFT_HOOK_MODE;
    else process.env.CRAFT_HOOK_MODE = prior;
    await dispose(f);
  }
});

test("Hook signal journal rejects late signals after its canonical turn has closed", async () => {
  const f = await fixture();
  const prior = process.env.CRAFT_HOOK_MODE;
  try {
    process.env.CRAFT_HOOK_MODE = "1";
    const bridge = new CodexHookBridge(f.service), input = { cwd: f.root, session_id: "closed-signal", turn_id: "closed-signal-turn" };
    const raw = bridge.signals.signal({ ...input, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "closed-signal-edit" });
    assert(raw);
    bridge.journal.record(input, raw);
    bridge.journal.close(input);
    const late = { ...raw, id: "closed-signal-late" };
    const result = bridge.journal.record(input, late);
    assert.equal(result?.closed_at !== undefined, true);
    assert.equal(bridge.journal.find(input, true)?.signals && (bridge.journal.find(input, true)!.signals as JsonObject[]).length, 1);
  } finally {
    if (prior === undefined) delete process.env.CRAFT_HOOK_MODE;
    else process.env.CRAFT_HOOK_MODE = prior;
    await dispose(f);
  }
});

test("PostToolUse journals a verified edit without waiting for the global SQLite writer", async () => {
  const f = await fixture();
  const writer = new DatabaseSync(f.store.paths.databaseFile);
  try {
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "read-only-correlation" };
    await bridge.handle("context", { ...base, hook_event_name: "UserPromptSubmit", prompt: "edit and verify" });
    writer.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(f.root, "file.ts") } });
    const events = f.store.list("trace_event", 100).filter(event => event.operation_id === "handle.context.PostToolUse");
    assert(events.some(event => event.status === "completed"));
    assert(!events.some(event => event.error_class === "STORAGE_BUSY"));
    assert.equal(f.store.database.prepare("SELECT count(*) n FROM records WHERE kind='codex_hook_turn'").get()?.n, 0);
    assert.equal((f.store.list("codex_hook_turn", 10)[0]!.signals as JsonObject[])[0]!.kind, "edit");
  } finally {
    try { writer.exec("ROLLBACK;"); } catch { /* rollback only when the writer transaction started */ }
    writer.close();
    await dispose(f);
  }
});

test("a pre-existing current-format Hook journal keeps its legacy central write path", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service), scope = codexProjectScope(f.root)!;
    const session_id = "legacy-current-session", turn_id = "legacy-current-turn";
    const id = `codex_hook_turn_${createHash("sha256").update(JSON.stringify({ scope, session_id, turn: turn_id })).digest("hex").slice(-20)}`;
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("codex_hook_turn", id, 1, JSON.stringify({ scope, session_id, turn_id, signals: [], has_edit: false,
        verification_outcome: null, content_stored: false }), new Date().toISOString(), new Date().toISOString());
    await bridge.handle("experience", { cwd: f.root, session_id, turn_id, hook_event_name: "PostToolUse", tool_name: "Edit" });
    const journal = f.store.get("codex_hook_turn", id);
    assert.equal((journal.signals as JsonObject[])[0]!.kind, "edit");
    assert.equal(f.store.database.prepare("SELECT count(*) n FROM records WHERE kind='codex_hook_turn' AND id=?").get(id)?.n, 2);
    assert.equal(f.store.traceShards.count("codex_hook_turn"), 0);
  } finally { await dispose(f); }
});

test("an explicit scenario is persisted when the verified Hook journal has no scenario yet", async () => {
  const f = await fixture();
  const originalFinalize = f.service.learningCycleFinalize;
  try {
    const bridge = new CodexHookBridge(f.service), input = { cwd: f.root, session_id: "explicit-scenario-session", turn_id: "explicit-scenario-turn" };
    const edit = bridge.signals.signal({ ...input, hook_event_name: "PostToolUse", tool_name: "Edit" });
    const verification = bridge.signals.signal({ ...input, hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
    assert(edit); assert(verification);
    bridge.journal.record(input, edit);
    bridge.journal.record(input, verification);
    bridge.journal.bindContextReceipt(input, { id: "scenario-context-receipt" });
    const legacyJournal = bridge.journal.find(input)!;
    const { trace_id: _traceId, ...legacyPayload } = legacyJournal;
    const timestamp = new Date().toISOString();
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("codex_hook_turn", String(legacyJournal.id), 1, JSON.stringify(legacyPayload), timestamp, timestamp);
    f.service.learningCycleFinalize = (() => ({ status: "observed" })) as typeof f.service.learningCycleFinalize;
    const result = bridge.learning.finalize({ ...input, scenario_key: "coding.explicit-verification" });
    assert.equal(result?.status, "observed");
    assert.equal(bridge.journal.find(input)?.scenario_key, "coding.explicit-verification");
  } finally {
    f.service.learningCycleFinalize = originalFinalize;
    await dispose(f);
  }
});

test("Hook traces identify the bounded lifecycle event without recording prompt text", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", prompt: "private diagnostic phrase" });
    await bridge.handle("context", { hook_event_name: "unrecognized-event", prompt: "another private phrase" });
    const events = f.store.list("trace_event", 1_000);
    assert(events.some(event => event.operation_id === "handle.context.UserPromptSubmit"));
    assert(events.some(event => event.operation_id === "handle.context.unknown"));
    assert(!JSON.stringify(events).includes("private diagnostic phrase"));
    assert(!JSON.stringify(events).includes("another private phrase"));
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
  assert.equal(automaticMemoryFact("本项目默认使用 Node.js"), "本项目默认使用 Node.js");
  assert.equal(automaticMemoryFact("以后请优先运行 focused tests"), "以后请优先运行 focused tests");
  assert.equal(automaticMemoryFact("我偏好无糖咖啡"), "我偏好无糖咖啡");
  assert.equal(automaticMemoryFact("I prefer terminal reviews"), "I prefer terminal reviews");
  assert.equal(automaticMemoryFact("普通的任务对话"), null);
  assert.equal(automaticMemoryFact("本项目使用 token=abcdefghijklmnopqrstuvwxyz"), null);
  assert.equal(automaticMemoryFact("不要记录：本项目使用 Node.js"), null);
});

test("automatic Memory facts preserve negation, avoidance, scope and conditional qualifiers", () => {
  for (const statement of [
    "以后请不要使用 Redis",
    "以后请避免运行全量测试",
    "本项目约定：仅在测试通过后发布，否则不要发布",
    "本项目使用 Redis，但仅限测试环境",
    "以后请不要删除历史数据，除非已经完成备份",
    "本项目约定：如果评测失败，不要晋升候选",
    `本项目约定：${"规".repeat(694)}`,
  ]) assert.equal(automaticMemoryFact(`  ${statement}  `), statement);
  for (const prompt of ["请不要使用 Redis 修复这次故障", "请避免运行全量测试", "如果评测失败就检查日志",
    "", null, 7, "do not remember: I prefer Redis", `本项目约定：${"规".repeat(695)}`, "x".repeat(1_001)]) {
    assert.equal(automaticMemoryFact(prompt), null);
  }
});

test("Memory Hook preserves a conditional prohibition through two independent sessions and project promotion", async () => {
  const f = await fixture();
  const sessions = ["one", "two"].map(id => `negation-${stableDigest(f.root).slice(-12)}-${id}`);
  try {
    const bridge = new CodexHookBridge(f.service);
    const statement = "以后请不要删除历史数据，除非已经完成备份";
    const scope = codexProjectScope(f.root)!;
    for (const [index, sessionId] of sessions.entries()) {
      await bridge.handle("memory", { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: sessionId, prompt: statement });
      const sessionMemories = f.service.memoryLedgerList({ scope_kind: "session", scope_id: sessionId }).memories as JsonObject[];
      assert.equal(sessionMemories.length, 1);
      assert.equal(sessionMemories[0]!.content, statement);
      const projectMemories = f.service.memoryLedgerList({ scope_kind: "project", scope_id: scope.id }).memories as JsonObject[];
      assert.equal(projectMemories.length, index);
      if (index === 1) {
        assert.equal(projectMemories[0]!.content, statement);
        assert.equal(projectMemories[0]!.status, "active");
        const path = f.service.memoryGovernance.ledger.files.pathFor(scope)!;
        assert.match(await readFile(path, "utf8"), /以后请不要删除历史数据，除非已经完成备份/u);
      }
    }
  } finally {
    for (const sessionId of sessions) f.service.memorySessionArchive({ session_id: sessionId });
    await dispose(f);
  }
});

test("Memory Hook automatically captures only classified stable project facts into the session tier", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "automatic-memory-session", prompt: "本项目默认使用 Node.js" });
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd: f.root, session_id: "automatic-memory-session", prompt: "请修复这个测试" });
    const records = f.service.memoryLedgerList({ scope_kind: "session", scope_id: "automatic-memory-session", include_history: true }).memories as JsonObject[];
    assert.equal(records.length, 1);
    assert.equal(records[0]!.content, "本项目默认使用 Node.js");
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
    assert.deepEqual((emitted.memory_capture as JsonObject).promotions, [{ tier: "session", auto_committed: false }]);

    const turn = "legacy-unknown-session", scope = codexProjectScope(f.root)!;
    const legacyId = `codex_hook_turn_${createHash("sha256").update(JSON.stringify({ scope, turn })).digest("hex").slice(-20)}`;
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("codex_hook_turn", legacyId, 1, JSON.stringify({ turn_id: turn }), new Date().toISOString(), new Date().toISOString());
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
    f.service.memoryCaptureUserStatement({ content: "Temporary session fact", kind: "episodic", topic: "temporary-fact", session_id: sessionId, session_host: "codex" });
    const internalSessionScopeId = sessionStorageScopeId("codex", sessionId);
    const sessionFile = f.service.memoryGovernance.ledger.files.pathFor({ kind: "session", id: internalSessionScopeId });
    assert(sessionFile && existsSync(sessionFile));

    await bridge.handle("memory", { hook_event_name: "SessionEnd", cwd: f.root, session_id: sessionId });

    assert.equal(existsSync(sessionFile), false);
    assert.equal(f.store.listScoped("memory_ledger", [{ kind: "session", id: internalSessionScopeId }], 100).length, 0);

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

test("the same Host session ID resolves, stores and archives Memory in separate Host partitions", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    const sessionId = "same-id-across-hosts";
    await bridge.handle("memory", { hook_event_name: "UserPromptSubmit", source: "codex", cwd: f.root,
      session_id: sessionId, prompt: "本项目默认使用 Node.js" });
    await bridge.handle("memory", { hook_event_name: "UserPromptSubmit", source: "claude", cwd: f.root,
      session_id: sessionId, prompt: "本项目默认使用 Python" });
    const codex = f.service.memoryLedgerList({ scope_kind: "session", scope_id: sessionId, session_host: "codex" }).memories as JsonObject[];
    const claude = f.service.memoryLedgerList({ scope_kind: "session", scope_id: sessionId, session_host: "claude" }).memories as JsonObject[];
    assert.equal(codex.length, 1);
    assert.equal(claude.length, 1);
    assert.match(String(codex[0]!.content), /Node\.js/u);
    assert.match(String(claude[0]!.content), /Python/u);
    f.service.memorySessionArchive({ session_id: sessionId, session_host: "codex" });
    assert.equal(f.service.memoryLedgerList({ scope_kind: "session", scope_id: sessionId, session_host: "codex" }).count, 0);
    assert.equal(f.service.memoryLedgerList({ scope_kind: "session", scope_id: sessionId, session_host: "claude" }).count, 1);
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
    attachVerifiedPromotionFixture(f.store, claim);
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
    assert.equal(sessionMemoryPath, join(sessionStorageDirectory(f.store.paths, "codex", "memory-session"), "memory", "memory.md"));
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
    attachVerifiedPromotionFixture(f.store, claim);
    f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: scope.id, content: "Prefer short feedback.", confidence: "bounded" });
    f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "global", scope_id: "global", content: "Global verification feedback rule.", confidence: "bounded" });
    const bridge = new CodexHookBridge(f.service);
    const response = await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, session_id: "context-session", turn_id: "context-turn", prompt: "verification feedback" });
    const injected = JSON.parse(String(response.additionalContext)) as JsonObject;
    assert.equal(injected.source, "craft-context");
    assert.equal(f.store.count("context_resolution_receipt"), 1);
    const receipt = f.store.get("context_resolution_receipt", String(injected.receipt_id));
    assert.equal(receipt.max_items, 3);
    assert.equal(receipt.max_chars, 1_200);
    assert.deepEqual(receipt.members, ["experience", "knowledge", "memory"]);
    assert.match(JSON.stringify(injected.selected), /Global verification feedback rule/u);
    assert((receipt.attempted_scopes as JsonObject[]).some(item => item.kind === "global" && item.id === "global"));
    const proofs = f.store.list("activation_proof_receipt", 10);
    assert.deepEqual(proofs.map((item) => item.component).sort(), ["experience", "knowledge", "memory"]);
    assert(proofs.every((item) => item.context_receipt_id === receipt.id));
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd, session_id: "context-session", turn_id: "context-turn", prompt: "verification feedback" }), {});
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, session_id: "context-session", prompt: "记住：我偏好无糖咖啡" });
    assert.equal((f.service.memoryLedgerList({ scope_kind: "session", scope_id: "context-session", include_history: true }).memories as JsonObject[]).length, 1);
  } finally { await dispose(f); }
});

test("Hook responses fit their declared token caps before recording emitted references", async () => {
  const f = await fixture();
  try {
    const cwd = f.root, scope = codexProjectScope(cwd)!;
    f.service.knowledgeMemoryInstallBuiltins();
    const content = `verification ${"verified detail. ".repeat(100)}`;
    f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: scope.id,
      content, confidence: "bounded" });
    const bridge = new CodexHookBridge(f.service);
    for (const [member, limit, turn] of [["context", 400, "context-budget"], ["memory", 150, "memory-budget"]] as const) {
      const response = await bridge.handle(member, { hook_event_name: "UserPromptSubmit", cwd, session_id: "budget-session", turn_id: turn, prompt: "verification" });
      assert.equal(typeof response.additionalContext, "string");
      assert(estimateTokens(String(response.additionalContext)) <= limit);
      const injected = JSON.parse(String(response.additionalContext)) as JsonObject;
      const selected = injected.selected as JsonObject[];
      assert.equal(selected.length, 1);
      const projected = selected[0]!;
      assert(String(projected.content).length < content.length);
      const excerpt = projected.content_excerpt as JsonObject;
      assert.equal(content.slice(Number(excerpt.source_start), Number(excerpt.source_end)), projected.content);
      const receipt = f.store.list("context_emission", 10).find(item => item.session_id === "budget-session" && item.turn_id === turn);
      assert.equal((receipt?.asset_refs as JsonObject[]).length, 1);
    }
  } finally { await dispose(f); }
});

test("Hook excerpt compaction preserves offsets and refuses oversized capture metadata", async () => {
  const f = await fixture();
  try {
    const cwd = f.root, scope = codexProjectScope(cwd)!;
    const short = { memory_id: "short-memory", memory_version: 1, content: `needle ${"detail ".repeat(400)}` };
    const priorExcerpt = { memory_id: "prior-memory", memory_version: 1, content: `needle ${"detail ".repeat(400)}`,
      content_excerpt: { source_start: 20, source_chars: 4_000, reason: "query_match" } };
    const unrelated = { memory_id: "unrelated-memory", memory_version: 1, content: `unrelated ${"background ".repeat(500)}` };
    const experience = { procedure_id: "procedure", procedure_version: 1, procedure_kind: "workflow", routeable: true };
    f.service.contextWorkingSets.resolve = (async () => ({ items: [short, priorExcerpt, unrelated], contributions: [{ member: "experience", items: [experience] }],
      asset_refs: [contextAssetRef("memory", short, scope), contextAssetRef("memory", priorExcerpt, scope), contextAssetRef("memory", unrelated, scope), contextAssetRef("experience", experience, scope)], receipt: null })) as typeof f.service.contextWorkingSets.resolve;
    const bridge = new CodexHookBridge(f.service);
    const response = await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, prompt: "needle" });
    const selected = JSON.parse(String(response.additionalContext)).selected as JsonObject[];
    assert(selected.every(item => String(item.content).length < 2_800));
    const excerpt = selected.find(item => item.id === "prior-memory")!.content_excerpt as JsonObject;
    assert(Number(excerpt.source_start) >= 20);

    f.service.contextWorkingSets.resolve = (async () => ({ items: [], contributions: [{ member: "unknown", items: [{ content: "must not be injected" }] }], receipt: null })) as typeof f.service.contextWorkingSets.resolve;
    assert.deepEqual(await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, prompt: "needle" }), {});

    f.service.memoryCaptureUserStatement = (() => ({ auto_committed: false, candidate: { id: "candidate" }, next_action: "review",
      topic_suggestions: ["a".repeat(800), "b".repeat(800)], promotions: [] })) as typeof f.service.memoryCaptureUserStatement;
    const oversized = await bridge.handle("memory", { hook_event_name: "UserPromptSubmit", cwd, session_id: "oversized-capture",
      prompt: `记住：${"我偏好简洁表达".repeat(5)}` });
    assert.deepEqual(oversized, {});
  } finally { await dispose(f); }
});

test("Hook never assigns a source range to a body whose prior excerpt offsets are unknown", async () => {
  const f = await fixture();
  try {
    const scope = codexProjectScope(f.root)!;
    const item = { memory_id: "unknown-offset-memory", memory_version: 1,
      content: `needle ${"background ".repeat(500)}`,
      content_excerpt: { source_start: null, source_end: null, source_chars: 6_000, reason: "no_lexical_match" } };
    const missingSourceSize = { ...item, memory_id: "unknown-size-memory",
      content_excerpt: { source_start: null, source_end: null, reason: "no_lexical_match" } };
    f.service.contextWorkingSets.resolve = (async () => ({ items: [item, missingSourceSize], contributions: [],
      asset_refs: [contextAssetRef("memory", item, scope), contextAssetRef("memory", missingSourceSize, scope)], receipt: null })) as typeof f.service.contextWorkingSets.resolve;

    const response = await new CodexHookBridge(f.service).handle("memory", {
      hook_event_name: "UserPromptSubmit", cwd: f.root, prompt: "needle",
    });
    assert.equal(typeof response.additionalContext, "string");
    assert(estimateTokens(String(response.additionalContext)) <= 150);
    const selected = (JSON.parse(String(response.additionalContext)) as JsonObject).selected as JsonObject[];
    assert.equal(selected.length, 2);
    for (const projected of selected) {
      assert.equal(projected.content, "");
      const excerpt = projected.content_excerpt as JsonObject;
      assert.equal(excerpt.source_start, null);
      assert.equal(excerpt.source_end, null);
      assert.equal(excerpt.reason, "requires_expansion");
    }
    assert.equal((selected[0]!.content_excerpt as JsonObject).source_chars, 6_000);
    assert.equal((selected[1]!.content_excerpt as JsonObject).source_chars, item.content.length);
  } finally { await dispose(f); }
});

test("parallel Context and component Hooks atomically divide shared material without duplicate injection", async () => {
  const f = await fixture();
  try {
    const cwd = f.root, scope = codexProjectScope(cwd)!;
    f.service.knowledgeMemoryInstallBuiltins();
    const evidence = f.service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "fixture" });
    const claim = f.service.knowledgeClaimSave({ source_id: "builtin.evidence-wiki", kind: "rule", scope: `project:${scope.id}`, content: "Run focused verification.", evidence_ids: [evidence.id] }).claim as JsonObject;
    attachVerifiedPromotionFixture(f.store, claim);
    f.service.memoryLedgerRemember({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: scope.id, content: "Prefer short feedback.", confidence: "bounded" });
    const bridge = new CodexHookBridge(f.service);
    const input = { hook_event_name: "UserPromptSubmit", cwd, session_id: "parallel-hooks", turn_id: "same-turn", prompt: "verification feedback" };
    const outputs = await Promise.all([bridge.handle("context", input), bridge.handle("knowledge", input)]);
    const selected = outputs.flatMap(output => {
      if (typeof output.additionalContext !== "string") return [];
      return (JSON.parse(output.additionalContext) as JsonObject).selected as JsonObject[];
    });
    const identities = selected.map(item => String(item.id ?? item.claim_id ?? item.procedure_id));
    assert.equal(identities.length, 2);
    assert.equal(new Set(identities).size, identities.length);
    const emission = f.store.list("context_emission", 10).find(item => item.session_id === "parallel-hooks" && item.turn_id === "same-turn");
    assert(emission);
    assert.equal((emission.asset_refs as JsonObject[]).length, 2);
    assert.equal(emission.model_use_verified, false);
  } finally { await dispose(f); }
});

test("Context Hook keeps sibling recall available after a rejected memory capture and records Experience once", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const cwd = f.root;
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
    const resumedSession = f.store.list("context_hook_session", 10).find(item => item.session_id === "session");
    assert.deepEqual(resumedSession?.pending_turn_ids, []);
    await bridge.handle("context", { hook_event_name: "UserPromptSubmit", cwd, session_id: "session", turn_id: "turn", prompt: "Fix the failing test" });
    await bridge.handle("context", { hook_event_name: "PostToolUse", cwd, session_id: "session", turn_id: "turn", tool_name: "Edit" });
    await bridge.handle("context", { hook_event_name: "PostToolUse", cwd, session_id: "session", turn_id: "turn", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    await bridge.handle("context", { hook_event_name: "Stop", cwd, session_id: "session", turn_id: "turn" });
    await bridge.handle("context", { hook_event_name: "SessionEnd", cwd, session_id: "session" });
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 1);
    const lifecycle = f.store.events("codex-hook").filter((event) => event.event_type === "codex_hook.lifecycle");
    assert.deepEqual(lifecycle.map(event => ({ member: (event.payload as JsonObject).member, event: (event.payload as JsonObject).event })), [
      { member: "experience", event: "Stop" },
      { member: "memory", event: "SessionEnd" },
    ]);
    assert.deepEqual(await bridge.handle("context", { hook_event_name: "UnknownEvent", cwd }), {});
  } finally { await dispose(f); }
});

test("Experience hooks persist only redacted verified signals and propose after two independent turns", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const cwd = f.root;
    for (const turn of ["one", "two"]) {
      const session_id = `session-${turn}`;
      await bridge.handle("experience", { hook_event_name: "UserPromptSubmit", cwd, session_id, turn_id: turn, prompt: "Implement a verified change" });
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id, turn_id: turn, tool_name: "apply_patch", tool_input: { patch: "secret=abcdefghijklmnop" } });
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id, turn_id: turn, tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
      await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id, turn_id: turn, scenario_key: "coding.feature-implementation" });
    }
    for (const scenario_key of ["coding.feature-implementation", "bad scenario", "coding.other-scenario"]) {
      await bridge.handle("experience", { hook_event_name: "Stop", cwd, session_id: "session-two", turn_id: "two", scenario_key });
    }
    const journals = f.store.list("codex_hook_turn", 10);
    assert.equal(journals.length, 2);
    assert(journals.every(journal => (journal.signals as JsonObject[]).filter(item => item.kind === "verification")
      .every(item => item.scenario_key === "coding.feature-implementation")));
    assert.doesNotMatch(JSON.stringify(journals), /abcdefghijklmnop|pnpm test/u);
    assert.equal(f.store.list("workflow_evolution_observation", 10).length, 2);
    assert.deepEqual(f.store.list("workflow_evolution_observation", 10).map(item => (item.source as JsonObject).session_id).sort(), ["session-one", "session-two"]);
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
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, turn_id: "turn" };
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
    assert.equal(((f.store.list("workflow_evolution_observation", 10)[0]!.source as JsonObject).session_id), undefined);
  } finally { await dispose(f); }
});

test("project Experience scenario catalog uses exact mappings and leaves unmapped or ambiguous tasks unclassified", async () => {
  const f = await fixture();
  try {
    const projectId = codexProjectScope(f.root)!.id.replace(/^project:/u, "");
    const experienceDir = localExperienceDir(f);
    const catalogPath = join(experienceDir, "experience-scenarios.json");
    await writeFile(catalogPath, JSON.stringify({
      schema: "craft.experience-scenario-catalog.v1",
      scenarios: [{ scenario_key: "coding.test-failure-recovery", verification_commands: ["pnpm test:focused"] }],
    }));
    assert.equal(existsSync(join(f.store.paths.experienceDir, "projects", projectId, "experience-scenarios.json")), false);
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "catalog-session" };
    for (const turn_id of ["one", "two"]) {
      const session_id = `catalog-${turn_id}`;
      await bridge.handle("experience", { ...base, session_id, turn_id, hook_event_name: "UserPromptSubmit", prompt: "make a verified project change" });
      await bridge.handle("experience", { ...base, session_id, turn_id, hook_event_name: "PostToolUse", tool_name: "Edit" });
      await bridge.handle("experience", { ...base, session_id, turn_id, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:focused" }, tool_response: { exit_code: 0 } });
      const journal = f.store.list("codex_hook_turn", 10).find(item => item.turn_id === turn_id)!;
      assert.deepEqual((journal.signals as JsonObject[]).map(item => ({ kind: item.kind, outcome: item.outcome, scenario_key: item.scenario_key })), [
        { kind: "edit", outcome: "unknown", scenario_key: undefined }, { kind: "verification", outcome: "passed", scenario_key: "coding.test-failure-recovery" },
      ]);
      assert.equal(journal.scenario_key, "coding.test-failure-recovery");
      await bridge.handle("experience", { ...base, session_id, turn_id, hook_event_name: "Stop" });
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
    const directory = localExperienceDir(f);
    const catalogPath = join(directory, "experience-scenarios.json");
    const catalog = (fineParent: string) => ({ schema: "craft.experience-scenario-catalog.v1", scenarios: [
      { scenario_key: "engineering.change", tier: "coarse", verification_commands: [] },
      { scenario_key: "engineering.change.typescript-tests", tier: "fine", parent_scenario_key: fineParent, verification_commands: ["pnpm test:focused"] },
    ] });
    await writeFile(catalogPath, JSON.stringify(catalog("engineering.change")));
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "hierarchical-scenarios" };
    for (const turn_id of ["one", "two"]) {
      const session_id = `hierarchical-${turn_id}`;
      await bridge.handle("experience", { ...base, session_id, turn_id, hook_event_name: "UserPromptSubmit", prompt: "repair the type check" });
      await bridge.handle("experience", { ...base, session_id, turn_id, hook_event_name: "PostToolUse", tool_name: "Edit" });
      await bridge.handle("experience", { ...base, session_id, turn_id, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:focused" }, tool_response: { exit_code: 0 } });
      const turn = f.store.list("codex_hook_turn", 10).find(item => item.turn_id === turn_id)!;
      assert.equal(turn.scenario_key, "engineering.change.typescript-tests");
      assert.equal(turn.coarse_scenario_key, "engineering.change");
      await bridge.handle("experience", { ...base, session_id, turn_id, hook_event_name: "Stop" });
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
    const directory = localExperienceDir(f);
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
      f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run("codex_hook_turn", legacyId, 1, JSON.stringify({ session_id, turn_id }), new Date().toISOString(), new Date().toISOString());
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
    const directory = localExperienceDir(f);
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
    await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd: f.root, turn_id: "unverified", tool_name: "Bash", tool_input: { command: "echo hello" }, tool_response: { exit_code: 0 } });
    await bridge.handle("experience", { hook_event_name: "Stop", cwd: f.root, turn_id: "unverified" });
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
    const call = async (taskId: string) => server.handle({ jsonrpc: "2.0", id: taskId, method: "tools/call", params: { name: "craft_learning_cycle_finalize", arguments: { host: "mcp_host", task_id: taskId, turn_id: "turn", session_id: `session-${taskId}`, context_receipt_id: receiptId, verified: true, verification_outcome: taskId === "task-one" ? "passed" : "failed", verification_ref: `test-run:${taskId}`, scenario_key: "coding.feature-implementation", scenario_definition: { summary: "实现功能并验证改动", applies_when: "项目代码发生变化且需要运行验收", excludes: "只读咨询或纯文档任务" }, coarse_scenario_key: "engineering.code-change", scenario_verifier_digest: verifierDigest } } }) as Promise<any>;
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
    const taskEvidence = f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one", "session-task-two"] });
    const verifiedEvidence = taskEvidence.evidence as JsonObject[];
    assert.equal(verifiedEvidence.length, 2);
    assert.deepEqual(verifiedEvidence.map(item => item.verification_outcome).sort(), ["failed", "passed"]);
    assert.equal(verifiedEvidence.every(item => item.verified === true && item.content_stored === false && !Object.hasOwn(item, "verification_ref")), true);
    const legacyEvidence = f.store.get("evidence", String(verifiedEvidence.find(item => item.session_id === "session-task-one")!.evidence_id));
    const legacyMetadata = { ...(legacyEvidence.metadata as JsonObject) };
    delete legacyMetadata.verification_outcome;
    f.store.save("evidence", String(legacyEvidence.id), { ...legacyEvidence, metadata: legacyMetadata });
    assert.deepEqual((f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one"] }).evidence as JsonObject[])
      .map(item => item.verification_outcome), ["passed"], "legacy result is recovered only from its exact sanitized linked observation");
    f.service.evidenceRecord({ evidence_id: "evidence-bad-outcome", source_type: "host_completion_signal", confidence: "bounded",
      claim: "Host reported terminal verification passed.", metadata: { provenance: "host_completion_signal", content_stored: false,
        source_session_id: "session-task-one", host: "codex", turn_id: "bad-outcome-turn", task_id: "bad-outcome-task",
        context_receipt_id: "receipt", verification_ref_digest: "digest", terminal_identity_digest: "terminal", verification_outcome: "failed" } });
    assert.equal((f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one"] }).evidence as JsonObject[]).length, 1);
    f.service.evidenceRecord({ evidence_id: "evidence-orphan-valid-outcome", source_type: "host_completion_signal", confidence: "bounded",
      claim: "Host reported terminal verification passed.", metadata: { provenance: "host_completion_signal", content_stored: false,
        source_session_id: "session-task-one", host: "codex", turn_id: "orphan-turn", task_id: "task-one",
        context_receipt_id: "receipt", verification_ref_digest: `sha256:${"c".repeat(64)}`, terminal_identity_digest: `sha256:${"d".repeat(64)}`, verification_outcome: "passed" } });
    assert.equal((f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one"] }).evidence as JsonObject[]).length, 1,
      "a standalone Evidence record cannot verify a task without a linked Experience observation");
    const originalEvidenceId = String(verifiedEvidence.find(item => item.session_id === "session-task-one")!.evidence_id);
    f.store.create("workflow_evolution_observation", "empty-linked-observation", { source: { kind: "host:mcp_host", id: "empty-task", session_id: "session-task-one" },
      outcome: "passed", evidence_ids: [], sanitized: true, content_stored: false });
    f.store.create("workflow_evolution_observation", "malformed-linked-observation", { source: { kind: 1, id: 1, session_id: "session-task-one" },
      outcome: "unknown", evidence_ids: [], sanitized: true, content_stored: false });
    f.store.create("workflow_evolution_observation", "non-host-linked-observation", { source: { kind: "experience", id: "orphan-task", session_id: "session-task-one" },
      outcome: "passed", evidence_ids: ["evidence-non-host"], sanitized: true, content_stored: false });
    f.service.evidenceRecord({ evidence_id: "evidence-conflicting-metadata-outcome", source_type: "host_completion_signal", confidence: "bounded",
      claim: "Host reported terminal verification failed.", metadata: { provenance: "host_completion_signal", content_stored: false,
        source_session_id: "session-task-one", host: "codex", turn_id: "conflicting-metadata-turn", task_id: "conflicting-metadata-task",
        context_receipt_id: "receipt", verification_ref_digest: "digest", terminal_identity_digest: "terminal", verification_outcome: "failed" } });
    f.store.create("workflow_evolution_observation", "conflicting-metadata-observation", { source: { kind: "host:codex", id: "conflicting-metadata-task", session_id: "session-task-one" },
      outcome: "passed", evidence_ids: ["evidence-conflicting-metadata-outcome"], sanitized: true, content_stored: false });
    assert.equal((f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one"] }).evidence as JsonObject[]).length, 1,
      "Evidence metadata cannot override the linked Host observation outcome");
    f.store.create("workflow_evolution_observation", "conflicting-linked-observation", { source: { kind: "host:mcp_host", id: "task-one", session_id: "session-task-one" },
      outcome: "failed", evidence_ids: [originalEvidenceId], sanitized: true, content_stored: false });
    assert.equal((f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one"] }).evidence as JsonObject[]).length, 0,
      "conflicting linked outcomes cannot verify the affected task");
    const evidenceTool = await server.handle({ jsonrpc: "2.0", id: "task-evidence", method: "tools/call", params: { name: "craft_learning_cycle_task_evidence_list", arguments: { session_ids: ["session-task-one"] } } }) as any;
    assert.equal(evidenceTool.result.structuredContent.evidence.length, 0);
    assert.throws(() => f.service.learningCycleTaskEvidenceList({ session_ids: [] }), /bounded Host session identifiers/u);
    assert.throws(() => f.service.learningCycleTaskEvidenceList({ session_ids: null }), /bounded Host session identifiers/u);
    assert.throws(() => f.service.learningCycleTaskEvidenceList({ session_ids: "invalid" }), /bounded Host session identifiers/u);
    assert.throws(() => f.service.learningCycleTaskEvidenceList({ session_ids: [""] }), /bounded Host session identifiers/u);
    assert.throws(() => f.service.learningCycleTaskEvidenceList({ session_ids: Array.from({ length: 101 }, (_, index) => `session-${index}`) }), /bounded Host session identifiers/u);
    assert.throws(() => f.service.learningCycleTaskEvidenceList({ session_ids: ["x".repeat(257)] }), /bounded Host session identifiers/u);
    assert.throws(() => f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one"], limit: 10_001 }), /limit/u);
    assert.throws(() => f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one"], limit: 0 }), /limit/u);
    assert.throws(() => f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one"], limit: 1.5 }), /limit/u);
    assert.throws(() => f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one"], limit: "10" }), /limit/u);
    assert.equal(f.service.learningCycleTaskEvidenceList({ session_ids: ["session-task-one"], limit: 10 }).evidence_count, 0);
    f.service.evidenceRecord({ evidence_id: "evidence-unknown-outcome", source_type: "host_completion_signal", confidence: "bounded",
      claim: "Host reported a terminal outcome.", metadata: { provenance: "host_completion_signal", content_stored: false,
        source_session_id: "session-unknown-outcome", host: "codex", turn_id: "unknown-outcome-turn", task_id: "unknown-outcome-task",
        context_receipt_id: "receipt", verification_ref_digest: "digest", terminal_identity_digest: "terminal", verification_outcome: "unknown" } });
    assert.equal(f.service.learningCycleTaskEvidenceList({ session_ids: ["session-unknown-outcome"] }).evidence_count, 0);
    const unscopedEvidence = f.service.evidenceRecord({ evidence_id: "evidence-unscoped-host-task", source_type: "host_completion_signal", confidence: "bounded",
      claim: "Host reported terminal verification passed.", metadata: { provenance: "host_completion_signal", content_stored: false,
        source_session_id: "unscoped-session", host: "codex", turn_id: "unscoped-turn", task_id: "unscoped-task",
        context_receipt_id: "receipt", verification_ref_digest: `sha256:${"a".repeat(64)}`, terminal_identity_digest: `sha256:${"b".repeat(64)}`, verification_outcome: "passed" } });
    f.store.create("workflow_evolution_observation", "unscoped-host-observation", { source: { session_id: "unscoped-session", kind: "host:codex", id: "unscoped-task" },
      outcome: "passed", evidence_ids: [unscopedEvidence.id], sanitized: true, content_stored: false });
    const unscoped = (f.service.learningCycleTaskEvidenceList({ session_ids: ["unscoped-session"] }).evidence as JsonObject[])[0]!;
    assert.equal(Object.hasOwn(unscoped, "project_scope_id"), false);
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
    await bridge.handle("experience", { ...base, hook_event_name: "Stop", scenario_key: "engineering.feature-verification" });
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
    assert.throws(() => f.service.learningCycleFinalize({ ...base, session_id: `session-${"x".repeat(257)}` }), /bounded Host session identifier/u);
    assert.throws(() => f.service.learningCycleFinalize({ ...base, session_id: "bad\nsession" }), /bounded Host session identifier/u);
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
    assert.deepEqual(f.service.experienceScenarioList({ scope: completionProjectScope, project_root: f.root }), { scope: completionProjectScope, catalog_version: 0, scenarios: [] });
    assert.equal(f.service.experienceScenarioList({ scope_kind: "project", scope_id: String(completionScope.id).replace(/^project:/u, ""), project_root: f.root }).catalog_version, 0);
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
    assert.throws(() => f.service.experienceScenarioMigrationPropose({ scope: completionProjectScope, project_root: f.root,
      mode: "merge", source_keys: ["missing.one", "missing.two"], targets: [{ scenario_key: "merged" }],
      expected_catalog_version: migrationBefore.catalog_version, request_id: "merge-missing-v1", reason: "exercise registered root" }), /source|scenario|migration/iu);
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
    const retirementReplay = f.service.experienceScenarioRetire({ scope: completionProjectScope, project_root: f.root, scenario_key: "engineering.tests",
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
    const fineOnly = f.service.learningCycleFinalize({ ...base, session_id: "parent-late-session-one", task_id: "parent-late-one", scenario_key: "engineering.parent-late" });
    const sameTaskParentAdded = f.service.learningCycleFinalize({ ...base, session_id: "parent-late-session-one", task_id: "parent-late-one", scenario_key: "engineering.parent-late", coarse_scenario_key: "engineering" });
    assert.equal(sameTaskParentAdded.idempotent, true);
    assert.equal((sameTaskParentAdded.observation as JsonObject).id, (fineOnly.observation as JsonObject).id);
    assert.equal((sameTaskParentAdded.scenario_catalog as JsonObject).coarse_scenario_key, "engineering");
    const parentAdded = f.service.learningCycleFinalize({ ...base, session_id: "parent-late-session-two", task_id: "parent-late-two", scenario_key: "engineering.parent-late", coarse_scenario_key: "engineering" });
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
    const base = { host: "mcp_host", session_id: "refine-session-one", turn_id: "refine-turn-1", context_receipt_id: String((context.receipt as JsonObject).id), verified: true,
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
    const legacyEvidence = f.service.evidenceRecord({ evidence_id: "legacy-refinement-evidence", source_type: "program", confidence: "confirmed", claim: "legacy observation evidence" });
    f.store.create("workflow_evolution_observation", "legacy-refinement", { scenario_key: "unclassified:legacy-refinement",
      scenario_signature: { schema: "craft.scenario-signature.v1", source: "unclassified" },
      source: { kind: "host:mcp_host", id: "legacy-refinement-task", digest: "legacy-refinement-digest", session_id: "legacy-refinement-session", scope: originalSource.scope },
      outcome: "passed", evidence_ids: [legacyEvidence.id], sanitized: true, content_stored: false, lifecycle: "accepted", identity_digest: "legacy" });
    const legacyRefinement = f.service.workflowEvolutionObserve({ observation_id: "legacy-refinement", scenario_key: "scenario:legacy-refinement",
      source_kind: "host:mcp_host", source_id: "legacy-refinement-task", source_session_id: "legacy-refinement-session", source_digest: "legacy-refinement-digest", outcome: "passed", scope: originalSource.scope,
      scenario_signature: { schema: "craft.scenario-signature.v1", scenario_key: "engineering.tests" }, evidence_ids: [legacyEvidence.id],
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
      source_kind: "host:mcp_host", source_id: "verification-refinement-task", source_session_id: "verification-refinement-session", source_digest: "verification-refinement-digest", outcome: "passed",
      scope: `project:${String(((context.receipt as JsonObject).scope as JsonObject).id)}`, scenario_signature: { schema: "craft.scenario-signature.v1", source: "unclassified" },
      evidence_ids: [String(f.service.evidenceRecord({ evidence_id: "verification-refinement-evidence", source_type: "program", confidence: "confirmed", claim: "verification refinement evidence" }).id)],
      failure_type: "verified-run", verification: { contract_ref: "acceptance:test", workspace_revision: "revision:test",
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
    const independent = f.service.learningCycleFinalize({ ...base, session_id: "refine-session-two", turn_id: "refine-turn-2", task_id: "refine-task-2", scenario_key: "engineering.tests" });
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
    const base = { host: "mcp_host", session_id: "distill-session-one", turn_id: "turn", context_receipt_id: String((context.receipt as JsonObject).id), verified: true,
      verification_outcome: "passed", verification_ref: "test:verification", scenario_key: "coding.distillation" };
    f.service.learningCycleFinalize({ ...base, task_id: "first" });
    const finalized = f.service.learningCycleFinalize({ ...base, session_id: "distill-session-two", task_id: "second" });
    assert.equal(finalized.status, "candidate_request");
    const ticket = finalized.model_ticket as JsonObject;
    assert.equal(ticket.status, "needs_enablement");
    f.store.save("evaluation_model_ticket", String(ticket.id), { ...ticket, next_action: null });
    const replay = f.service.learningCycleFinalize({ ...base, session_id: "distill-session-two", task_id: "second" });
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
    const afterSubmission = f.service.learningCycleFinalize({ ...base, session_id: "distill-session-two", task_id: "second" });
    assert.equal(afterSubmission.status, "candidate_submitted"); assert.equal(afterSubmission.idempotent, true);
  } finally { await dispose(f); }
});

test("the current Host model can distill and submit a verified request without a configured Provider Profile", async () => {
  const f = await fixture();
  try {
    const context = await f.service.contextOpen({ project_root: f.root, query: "verified repeated work", include_codebase: false });
    const base = { host: "mcp_host", session_id: "host-distill-session-one", turn_id: "turn", context_receipt_id: String((context.receipt as JsonObject).id), verified: true,
      verification_outcome: "passed", verification_ref: "test:host-distillation", scenario_key: "coding.host-distillation",
      scenario_definition: { summary: "Deliver and verify a code change", applies_when: "The project changed and its verifier completed", excludes: "Read-only advice without a verified change" } };
    assert.equal(f.service.learningCycleFinalize({ ...base, task_id: "host-first" }).status, "observed");
    const finalized = f.service.learningCycleFinalize({ ...base, session_id: "host-distill-session-two", task_id: "host-second" });
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
    const base = { host: "mcp_host", session_id: "codex-learning-session-one", turn_id: "codex-learning-turn", context_receipt_id: String((context.receipt as JsonObject).id),
      verified: true, verification_outcome: "passed", verification_ref: "test:codex-learning", scenario_key: "coding.codex-learning" };
    assert.equal(f.service.learningCycleFinalize({ ...base, task_id: "codex-first" }).status, "observed");
    const finalized = f.service.learningCycleFinalize({ ...base, session_id: "codex-learning-session-two", task_id: "codex-second" });
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
    const base = { host: "mcp_host", session_id: "auto-profile-session-one", turn_id: "turn", context_receipt_id: String((context.receipt as JsonObject).id), verified: true,
      verification_outcome: "passed", verification_ref: "test:verification", scenario_key: "coding.auto-profile" };
    assert.equal(f.service.learningCycleFinalize({ ...base, task_id: "first" }).status, "observed");
    const finalized = f.service.learningCycleFinalize({ ...base, session_id: "auto-profile-session-two", task_id: "second" });
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
    const bridge = new CodexHookBridge(f.service); const cwd = f.root;
    await mkdir(join(cwd, "src"), { recursive: true }); await writeFile(join(cwd, "src/feature.ts"), "export const feature = true;\n");
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
      await bridge.handle("experience", { hook_event_name: "PostToolUse", cwd, session_id: turn, turn_id: turn, tool_name: "Edit",
        tool_input: { file_path: "src/feature.ts" } });
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
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UnknownEvent", cwd: f.root }), {});
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "Stop", cwd: f.root }), {});
    assert.deepEqual(await bridge.handle("experience", { hook_event_name: "UserPromptSubmit", cwd: f.root, user_prompt: "no stored context" }), {});
    const original = f.service.contextWorkingSets.resolve;
    f.service.contextWorkingSets.resolve = async () => { throw new Error("fixture failure"); };
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: f.root, prompt: "context" }), {});
    f.service.contextWorkingSets.resolve = original;
    f.service.contextWorkingSets.resolve = async () => ({ items: [{ memory_id: "stub", memory_version: 1, content: "stub" }], contributions: [{ items: "not-an-array" }], receipt: null }) as never;
    const projected = await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: f.root, prompt: "context" });
    assert.match(String(projected.additionalContext), /"receipt_id":null/u);
    f.service.contextWorkingSets.resolve = async () => { throw "fixture failure"; };
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", cwd: f.root, prompt: "context" }), {});
    f.service.contextWorkingSets.resolve = original;
    assert.equal(f.store.events("codex-hook").filter((event) => event.event_type === "codex_hook.failed").length, 2);
    assert.deepEqual(await bridge.handle("knowledge", { hook_event_name: "UserPromptSubmit", prompt: "context" }), {});
  } finally { await dispose(f); }
});

test("Hook mints a fresh turn when the Host omits its native turn identifier", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service); const cwd = f.root;
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
    await bridge.handle("knowledge", { hook_event_name: "SessionStart", cwd: f.root, session_id: "session", source: "claude" });
    await bridge.handle("knowledge", { hook_event_name: "Stop", cwd: f.root, session_id: "session", turn_id: "turn" });
    await bridge.handle("knowledge", { hook_event_name: "SessionEnd", cwd: f.root, session_id: "session", reason: "other" });
    await bridge.handle("knowledge", { hook_event_name: "SessionEnd", cwd: f.root, reason: "missing-session" });
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
    const observed = f.store.list("context_feedback", 10).find(item => item.receipt_id === closed.context_receipt_id);
    assert(observed, "Stop should record an automatic observation for the exact Context receipt");
    assert.equal(observed.outcome, "unrated"); assert.equal(observed.usage_stage, "shown"); assert.equal(observed.turn_outcome, "passed");
    assert.equal(observed.evidence_verified, false, "a successful Host turn must not be presented as causal Memory evidence");
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

test("Context feedback failures remain fail-open and record only a safe diagnostic", async () => {
  const f = await fixture();
  try {
    const bridge = new CodexHookBridge(f.service);
    for (const [session_id, thrown, expectedType] of [["feedback-error", new TypeError("private feedback detail"), "TypeError"], ["feedback-value", "private feedback detail", "Error"]] as const) {
      const base = { cwd: f.root, session_id, turn_id: "turn" };
      await bridge.handle("context", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Review this project change" });
      f.service.contextResolutionFeedback = (() => { throw thrown; }) as typeof f.service.contextResolutionFeedback;
      assert.deepEqual(await bridge.handle("context", { ...base, hook_event_name: "Stop" }), {});
      const failure = f.store.events("codex-hook").filter(event => event.event_type === "codex_hook.failed" && (event.payload as JsonObject).event === "Stop").at(-1);
      assert(failure);
      assert.deepEqual(failure.payload, { member: "context", event: "Stop", error_type: expectedType });
    }
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
    f.store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run("codex_hook_turn", legacyId, 1, JSON.stringify({ scope, turn_id: turn, session_id: "legacy-session", signals: [], content_stored: false }),
        new Date().toISOString(), new Date().toISOString());
    assert.equal(bridge.journal.find({ ...base, turn_id: turn, session_id: "legacy-session" })?.id, legacyId);
    assert.equal(bridge.journal.find({ ...base, turn_id: turn, session_id: "foreign-session" }), null);
    await bridge.handle("experience", { ...base, turn_id: turn, session_id: "legacy-session", hook_event_name: "Stop" });
    assert(f.store.get("codex_hook_turn", legacyId).closed_at);
  } finally { await dispose(f); }
});

test("verified Hook tasks create a scoped classification ticket from a redacted goal and remove staging data", async () => {
  const previousHost = process.env.CRAFT_LEARNING_MODEL_HOST;
  process.env.CRAFT_LEARNING_MODEL_HOST = "codex-cli";
  const f = await fixture();
  try {
    await mkdir(join(f.root, "src"), { recursive: true });
    await writeFile(join(f.root, "src", "index.ts"), "export const ready = true;\n");
    const sanitizer = new HookSignalSanitizer();
    assert.equal(sanitizer.signal({ cwd: f.root, tool_name: "Edit", tool_input: { file_path: "src/index.ts" } })?.observed_path, "src/index.ts");
    assert.equal(sanitizer.signal({ cwd: f.root, tool_name: "Edit", tool_input: { file_path: "../outside.ts" } })?.observed_path, undefined);
    assert.equal(sanitizer.signal({ cwd: f.root, tool_name: "Edit", tool_input: { file_path: ".craft_data/private.md" } })?.observed_path, undefined);
    await symlink(join(f.root, "src", "index.ts"), join(f.root, "src", "linked.ts"));
    assert.equal(sanitizer.signal({ cwd: f.root, tool_name: "Edit", tool_input: { file_path: "src/linked.ts" } })?.observed_path, undefined);
    assert.equal(sanitizer.signal({ cwd: join(f.root, "missing"), tool_name: "Edit", tool_input: { file_path: "src/index.ts" } })?.observed_path, undefined);

    const directContext = await f.service.contextOpen({ project_root: f.root, query: "verified change", include_codebase: false });
    const directBase = { host: "codex", task_id: "unsafe-context", turn_id: "unsafe-context-turn",
      context_receipt_id: String((directContext.receipt as JsonObject).id), verified: true, verification_outcome: "passed",
      verification_ref: "test:verification" };
    const directReceipt = f.store.get("context_resolution_receipt", String(directContext.receipt && (directContext.receipt as JsonObject).id));
    const originalScope = directReceipt.scope as JsonObject;
    f.store.save("context_resolution_receipt", String(directReceipt.id), { ...directReceipt,
      scope: { ...originalScope, id: String(originalScope.id).replace(/^project:/u, "") } });
    f.service.learningCycleFinalize({ ...directBase, task_id: "unprefixed-project-scope" });
    f.store.save("context_resolution_receipt", String(directReceipt.id), { ...directReceipt, scope: originalScope });
    const safeScenarioContext = { sanitized: true, content_stored: false, task_goal: "完善项目验证流程", effect_summary: "定点验证通过" };
    for (const scenario_context of [null, { sanitized: true, content_stored: false, task_goal: "token=abcdefghijk", effect_summary: "verified" }]) {
      assert.throws(() => f.service.learningCycleFinalize({ ...directBase, scenario_context }), /scenario_context/u);
    }
    assert.throws(() => f.service.learningCycleFinalize({ ...directBase, task_id: "unsanitized-context",
      scenario_context: { ...safeScenarioContext, sanitized: false } }), /scenario_context/u);
    assert.throws(() => f.service.learningCycleFinalize({ ...directBase, task_id: "stored-content-context",
      scenario_context: { ...safeScenarioContext, content_stored: true } }), /scenario_context/u);
    assert.throws(() => f.service.learningCycleFinalize({ ...directBase, task_id: "unsafe-verifier-ref",
      verification_ref: "token=abcdefghijk", scenario_context: safeScenarioContext }), /verification_ref is not safe/u);
    const directScope = (directContext.receipt as JsonObject).scope as JsonObject;
    const directProjectId = String(directScope.id).replace(/^project:/u, "");
    const directExperienceDir = localExperienceDir(f);
    const { recordExperienceScenario, retireExperienceScenario } = await import("../capability/craft-experience/scenario-catalog.ts");
    recordExperienceScenario({ experience_dir: directExperienceDir, project_id: directProjectId, scenario_key: "unknown.fine",
      observation_id: "seed-unknown-fine", verified_task_id: "seed-unknown-fine" });
    retireExperienceScenario({ experience_dir: directExperienceDir, project_id: directProjectId, scenario_key: "unknown.fine",
      expected_catalog_version: 1, request_id: "retire-unknown-fine", reason: "no longer classified" });
    assert.throws(() => f.service.learningCycleFinalize({ ...directBase, task_id: "coarse-without-known-fine",
      scenario_key: "unknown.fine", coarse_scenario_key: "engineering", scenario_context: safeScenarioContext }), /requires scenario_key/u);
    assert.equal(f.service.learningCycleFinalize({ ...directBase, task_id: "registered-root-inferred",
      scenario_context: safeScenarioContext }).scenario_classification_request !== null, true);
    assert.throws(() => f.service.learningCycleFinalize({ ...directBase, scenario_key: "coding.safe", expected_scenario_catalog_version: -1 }), /expected_scenario_catalog_version/u);
    assert.equal(f.service.learningCycleFinalize({ ...directBase, task_id: "catalog-version-ok", scenario_key: "coding.safe",
      expected_scenario_catalog_version: 2 }).status, "observed");
    assert.throws(() => f.service.learningCycleFinalize({ ...directBase, task_id: "catalog-version-stale", scenario_key: "coding.safe",
      expected_scenario_catalog_version: 2 }), /catalog changed/u);

    const rawPrompt = "修复 Experience 场景分类触发链路\n```ts\nconst rawCodeMarker = 'must-not-persist';\n```";
    assert.equal(sanitizedExperienceTaskGoal(rawPrompt), "修复 Experience 场景分类触发链路");
    assert.equal(sanitizedExperienceTaskGoal("token=abcdefghijk"), null);
    const bridge = new CodexHookBridge(f.service), base = { cwd: f.root, session_id: "auto-classification-session", turn_id: "auto-classification-turn" };
    await bridge.handle("experience", { ...base, hook_event_name: "UserPromptSubmit", prompt: rawPrompt });
    const experienceDir = localExperienceDir(f), pendingDir = join(experienceDir, "scenario-classification", "pending");
    assert.equal((await readdir(pendingDir)).length, 1);
    await bridge.handle("experience", { ...base, hook_event_name: "UserPromptSubmit", prompt: rawPrompt });
    await bridge.handle("experience", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Use a different goal for this same turn" });
    await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
    await bridge.handle("experience", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test:focused" }, tool_response: { exit_code: 0 } });
    await bridge.handle("experience", { ...base, hook_event_name: "Stop" });

    const completionEvidence = f.store.list("evidence", 10, item => {
      const metadata = item.metadata as JsonObject | undefined;
      return metadata?.provenance === "host_completion_signal" && metadata.source_session_id === base.session_id && metadata.turn_id === base.turn_id;
    })[0]!;
    assert.equal((completionEvidence.metadata as JsonObject).task_goal_digest, codexTaskGoalDigest("修复 Experience 场景分类触发链路"));
    assert.equal(JSON.stringify(completionEvidence.metadata).includes("修复 Experience"), false);
    const evidenceBatch = f.service.learningCycleTaskEvidenceList({ session_ids: [String(base.session_id)] }).evidence as JsonObject[];
    assert.equal(evidenceBatch[0]?.task_goal_digest, codexTaskGoalDigest("修复 Experience 场景分类触发链路"));
    assert.equal(evidenceBatch[0]?.project_scope_id, codexProjectScope(f.root)?.id);

    const references = f.store.list("experience_scenario_classification_request_ref", 10);
    assert.equal(references.length, 2);
    const hookReference = references.find(reference => {
      const candidate = f.service.experienceScenarioClassificationRequestGet({ request_id: reference.id, scope: reference.scope, project_root: f.root }).request as JsonObject;
      return (candidate.context as JsonObject).turn_id === base.turn_id;
    })!;
    const requestId = String(hookReference.id);
    const scope = String(hookReference.scope);
    assert.throws(() => f.service.experienceScenarioClassificationRequestGet({ request_id: requestId, project_root: f.root }), /explicit project scope/u);
    assert.throws(() => f.service.experienceScenarioClassificationRequestGet({ request_id: requestId, scope: "global", project_root: f.root }), /explicit project scope/u);
    assert.throws(() => f.service.experienceScenarioClassificationRequestGet({ request_id: " ", scope, project_root: f.root }), /explicit project scope/u);
    assert.throws(() => f.service.experienceScenarioClassificationRequestGet({ request_id: requestId, scope: "project:other", project_root: f.root }), /reference scope/u);
    const originalHookReference = f.store.find("experience_scenario_classification_request_ref", requestId)!;
    const saveReference = (changes: JsonObject = {}) => f.store.save("experience_scenario_classification_request_ref", requestId, {
      ...originalHookReference, ...changes, version: f.store.get("experience_scenario_classification_request_ref", requestId).version,
    });
    saveReference({ project_path_alias_digest: "invalid" });
    assert.throws(() => f.service.experienceScenarioClassificationRequestGet({ request_id: requestId, scope, project_root: f.root }), /alias digest is invalid/u);
    saveReference();
    const request = f.service.experienceScenarioClassificationRequestGet({ request_id: requestId, scope, project_root: f.root }).request as JsonObject;
    assert.equal((f.service.experienceScenarioClassificationRequestGet({ request_id: requestId, scope }).request as JsonObject).scope, scope);
    const unaliasedReference = references.find(reference => reference.id !== requestId)!;
    const unaliasedRequest = f.service.experienceScenarioClassificationRequestGet({ request_id: unaliasedReference.id, scope: unaliasedReference.scope }).request as JsonObject;
    assert.equal(f.service.experienceScenarioClassificationRequestComplete({ request_id: unaliasedReference.id, scope: unaliasedReference.scope,
      expected_version: unaliasedRequest.version, status: "unclassified", result_digest: `sha256:${"2".repeat(64)}` }).idempotent, false);
    const requestPath = join(localExperienceDir(f), "scenario-classification", `${requestId}.json`);
    const requestSource = await readFile(requestPath, "utf8"), alteredRequest = JSON.parse(requestSource) as JsonObject;
    alteredRequest.scope = "project:other";
    await writeFile(requestPath, JSON.stringify(alteredRequest));
    assert.throws(() => f.service.experienceScenarioClassificationRequestGet({ request_id: requestId, scope }), /request scope does not match/u);
    assert.throws(() => f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope,
      expected_version: request.version, status: "unclassified", result_digest: `sha256:${"1".repeat(64)}` }), /request scope does not match/u);
    await writeFile(requestPath, requestSource);
    for (const status of ["classified", "unclassified"] as const) {
      saveReference({ status: "unclassified", result_digest: `sha256:${"2".repeat(64)}` });
      assert.throws(() => f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope,
        project_root: f.root, expected_version: request.version, status, result_digest: `sha256:${"3".repeat(64)}` }), /reference conflicts/u);
      await writeFile(requestPath, requestSource);
    }
    saveReference();
    const context = request.context as JsonObject;
    assert.throws(() => f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope,
      project_root: f.root, expected_version: request.version, status: "pending", result_digest: `sha256:${"d".repeat(64)}` }), /status is invalid/u);
    assert.throws(() => f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope: "global",
      project_root: f.root, expected_version: request.version, status: "unclassified", result_digest: `sha256:${"e".repeat(64)}` }), /explicit project scope/u);
    assert.throws(() => f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId,
      expected_version: request.version, status: "unclassified", result_digest: `sha256:${"e".repeat(64)}` }), /explicit project scope/u);
    assert.throws(() => f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope,
      expected_version: request.version, status: "unclassified", result_digest: null }), /completion is invalid/u);
    saveReference({ project_path_alias_digest: "invalid" });
    assert.throws(() => f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope,
      project_root: f.root, expected_version: request.version, status: "unclassified", result_digest: `sha256:${"f".repeat(64)}` }), /alias digest is invalid/u);
    saveReference();
    assert.throws(() => saveReference({ scope: "project:other" }), /cannot change storage scope/u);
    assert.throws(() => f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope: "project:other",
      project_root: f.root, expected_version: request.version, status: "unclassified", result_digest: `sha256:${"f".repeat(64)}` }), /reference scope/u);
    saveReference();
    assert.equal(context.task_goal, "修复 Experience 场景分类触发链路");
    assert.equal(context.sanitized, true);
    assert.equal(context.content_stored, false);
    const replay = f.service.learningCycleFinalize({ host: context.host, task_id: context.task_id, session_id: context.source_session_id, turn_id: context.turn_id,
      context_receipt_id: context.context_receipt_id, verified: true, verification_outcome: context.outcome,
      verification_ref: context.verification_ref, project_root: f.root, scenario_context: { task_goal: context.task_goal,
        effect_summary: context.effect_summary, sanitized: true, content_stored: false }, observed_paths: context.observed_paths,
      ...(typeof context.scenario_verifier_digest === "string" ? { scenario_verifier_digest: context.scenario_verifier_digest } : {}) });
    assert.equal(replay.idempotent, true);
    const tamperedReference = f.store.find("experience_scenario_classification_request_ref", requestId)!;
    f.store.save("experience_scenario_classification_request_ref", requestId, { ...tamperedReference, identity_digest: "sha256:tampered" });
    assert.throws(() => f.service.learningCycleFinalize({ host: context.host, task_id: context.task_id, session_id: context.source_session_id, turn_id: context.turn_id,
      context_receipt_id: context.context_receipt_id, verified: true, verification_outcome: context.outcome,
      verification_ref: context.verification_ref, project_root: f.root, scenario_context: { task_goal: context.task_goal,
        effect_summary: context.effect_summary, sanitized: true, content_stored: false }, observed_paths: context.observed_paths,
      ...(typeof context.scenario_verifier_digest === "string" ? { scenario_verifier_digest: context.scenario_verifier_digest } : {}) }),
    /Experience classification request reference idempotency conflict/u);
    const tickets = f.service.evaluationModelTicketList({ purpose: "workflow_evolution", limit: 10 }).tickets as JsonObject[];
    const ticket = tickets.find(item => (item.target as JsonObject).id === requestId)!;
    assert.equal((ticket.target as JsonObject).kind, "experience_scenario_classification_request");
    const resultDigest = `sha256:${"a".repeat(64)}`;
    assert.throws(() => f.service.evaluationModelTicketComplete({ ticket_id: ticket.id, result_digest: resultDigest }), /exact resolved request/u);
    const requestContext = request.context as JsonObject;
    saveReference({ identity_digest: "sha256:tampered" });
    assert.throws(() => f.service.learningCycleFinalize({ host: requestContext.host, task_id: requestContext.task_id, session_id: requestContext.source_session_id, turn_id: requestContext.turn_id,
      context_receipt_id: requestContext.context_receipt_id, verified: true, verification_outcome: requestContext.outcome,
      verification_ref: requestContext.verification_ref, project_root: f.root, scenario_context: {
        task_goal: requestContext.task_goal, effect_summary: requestContext.effect_summary, sanitized: true, content_stored: false },
      observed_paths: requestContext.observed_paths }), /idempotency conflict/u);
    const completed = f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope, project_root: f.root,
      expected_version: request.version, status: "unclassified", result_digest: resultDigest });
    assert.equal((completed.request as JsonObject).status, "unclassified");
    assert.equal(f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope, project_root: f.root,
      expected_version: request.version, status: "unclassified", result_digest: resultDigest }).idempotent, true);
    assert.throws(() => f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope, project_root: f.root,
      expected_version: request.version, status: "classified", result_digest: `sha256:${"b".repeat(64)}` }), /conflicts/u);
    assert.throws(() => f.service.experienceScenarioClassificationRequestComplete({ request_id: requestId, scope, project_root: f.root,
      expected_version: request.version, status: "unclassified", result_digest: `sha256:${"c".repeat(64)}` }), /conflicts/u);
    assert.equal((f.service.evaluationModelTicketComplete({ ticket_id: ticket.id, result_digest: resultDigest }).ticket as JsonObject).status, "completed");
    assert.equal((await readdir(pendingDir)).length, 0);
    const requestFile = await readFile(join(experienceDir, "scenario-classification", `${requestId}.json`), "utf8");
    assert.doesNotMatch(requestFile, /must-not-persist/u);
    const journal = f.store.list("codex_hook_turn", 10)[0]!;
    assert.doesNotMatch(JSON.stringify(journal), /must-not-persist/u);
  } finally {
    if (previousHost === undefined) delete process.env.CRAFT_LEARNING_MODEL_HOST;
    else process.env.CRAFT_LEARNING_MODEL_HOST = previousHost;
    await dispose(f);
  }
});

test("Experience Hook finalization validates project receipt identity and finds non-project observations", async () => {
  const f = await fixture();
  const otherRoot = await mkdtemp(join(tmpdir(), "craft-codex-hook-other-project-"));
  try {
    const bridge = new CodexHookBridge(f.service), signalEdit = new HookSignalSanitizer().signal({ tool_name: "Edit" })!;
    const signalVerify = new HookSignalSanitizer().signal({ tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } })!;
    const foreign = await f.service.contextOpen({ project_root: otherRoot, query: "foreign receipt", include_codebase: false });
    const base = { cwd: f.root, session_id: "foreign-context-session", turn_id: "foreign-context-turn" };
    bridge.journal.record(base, signalEdit);
    bridge.journal.record(base, signalVerify);
    bridge.journal.bindContextReceipt(base, foreign.receipt as JsonObject);
    assert.throws(() => bridge.learning.finalize(base), /does not match the Context receipt/u);

    const evidence = f.service.evidenceRecord({ source_type: "host_completion_signal", confidence: "bounded", claim: "user scope outcome",
      metadata: { provenance: "host_completion_signal", host: "codex", turn_id: "user-turn", context_receipt_id: "user-receipt", content_stored: false } });
    f.service.workflowEvolutionObserve({ scenario_key: "user-flow", source_kind: "host:codex", source_id: "user-task",
      source_digest: "sha256:user-observation", outcome: "passed", scope: "user:user-1", evidence_ids: [evidence.id], sanitized: true, content_stored: false });
    const journal = { scope: { kind: "user", id: "user-1" }, turn_id: "user-turn", context_receipt_id: "user-receipt" } as JsonObject;
    const internal = bridge.learning as unknown as { finalizedTurn(input: JsonObject, value: JsonObject): JsonObject | null };
    assert.equal((internal.finalizedTurn({}, journal)!.source as JsonObject).scope, "user:user-1");
  } finally { await f.store.close(); await Promise.all([rm(f.root, { recursive: true, force: true }), rm(otherRoot, { recursive: true, force: true })]); }
});
