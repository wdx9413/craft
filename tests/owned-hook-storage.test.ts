import type { JsonObject } from "../core/infrastructure/store.ts";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";
import { CodexHookBridge } from "../core/codex-hook-bridge.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

test("owned Context Hook routes capture and terminal observations to their independent owners", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owned-hook-"));
  const project = mkdtempSync(join(tmpdir(), "craft-owned-project-"));
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "sample.ts"), "export const sample = true;\n");
  const env = { CRAFT_DATA_DIR: root };
  for (const owner of ["runtime", "knowledge", "memory", "experience", "notes"]) { const r = await openCapabilityService(owner, env); r.close(); }
  const runtime = await openCapabilityService("context", env);
  const bridge = new CodexHookBridge(runtime.service);
  const base = { cwd: project, session_id: "owned-hook-session", turn_id: "owned-hook-turn", source: "codex" };
  try {
    const notes = runtime.service.ownerServices.get("notes")!;
    notes.craftNotesCreateDevice({ id: "local", note: "Test-only local device for the owned Hook accumulation simulation" });
    await bridge.handle("context", { ...base, hook_event_name: "UserPromptSubmit", prompt: "本项目约定：提交前必须运行 pnpm test。我偏好简短的测试结果。" });
    const knowledge = runtime.service.ownerServices.get("knowledge")!;
    const memory = runtime.service.ownerServices.get("memory")!;
    const experience = runtime.service.ownerServices.get("experience")!;
    assert.equal(knowledge.store.list("knowledge_claim").length, 1);
    assert(memory.store.list("memory_ledger").length > 0);
    assert.equal(runtime.store.list("knowledge_claim").length, 0);
    assert.equal(runtime.store.list("memory_ledger").length, 0);
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(project, "src", "sample.ts") } });
    await bridge.handle("context", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } });
    await bridge.handle("context", { ...base, hook_event_name: "Stop" });
    assert.equal(experience.store.list("workflow_evolution_observation").length, 1);
    assert.equal(runtime.store.list("workflow_evolution_observation").length, 0);
    assert.equal(notes.store.list("craft_note_usage", 100, row => row.session_id === base.session_id).length, 1,
      "verified edited-directory usage is written to the independent Notes owner");
    assert.equal(runtime.store.list("craft_note_usage").length, 0);
    assert.equal(runtime.store.count("codex_hook_turn"), 0);
    assert.equal(runtime.service.ownerServices.get("runtime")!.store.count("codex_hook_turn"), 1);
    assert.equal(runtime.store.list("program_memory_verified_observation").length, 1);
    await bridge.handle("context", { ...base, hook_event_name: "Stop" });
    assert.equal(experience.store.list("workflow_evolution_observation").length, 1);
    assert.equal(runtime.store.list("program_memory_verified_observation").length, 1);
    assert(!lstatSync(craftPaths(root).databaseFile).isFile());
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});

test("owned Hook rejects a missing Knowledge owner and a foreign project binding without local fallback", async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-owned-hook-denied-")), project = mkdtempSync(join(tmpdir(), "craft-owned-hook-project-"));
  const env = { CRAFT_DATA_DIR: root };
  const infrastructure = await openCapabilityService("runtime", env); infrastructure.close();
  const knowledgeInit = await openCapabilityService("knowledge", env); knowledgeInit.close();
  const runtime = await openCapabilityService("context", env), knowledge = runtime.service.ownerServices.get("knowledge")!;
  const bridge = new CodexHookBridge(runtime.service);
  try {
    const foreign = t.mock.method(knowledge, "scopeIdentityResolveProject", () => ({ identity: { canonical_scope: { kind: "project", id: "project:foreign" } } }));
    await bridge.handle("context", { cwd: project, session_id: "foreign-k", turn_id: "foreign-k", hook_event_name: "UserPromptSubmit", prompt: "本项目约定：提交前必须运行 pnpm test。" });
    foreign.mock.restore();
    assert.equal(knowledge.store.count("knowledge_claim"), 0);
    const services = new Map(runtime.service.ownerServices); services.delete("knowledge");
    Object.defineProperty(runtime.service, "ownerServices", { configurable: true, value: services });
    await bridge.handle("context", { cwd: project, session_id: "missing-k", turn_id: "missing-k", hook_event_name: "UserPromptSubmit", prompt: "本项目约定：提交前必须运行 pnpm test。" });
    assert.equal(knowledge.store.count("knowledge_claim"), 0); assert.equal(runtime.store.count("knowledge_claim"), 0);
    assert(runtime.store.events("codex-hook").filter(event => event.event_type === "codex_hook.failed" && (event.payload as JsonObject).member === "knowledge").length >= 2);
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});
