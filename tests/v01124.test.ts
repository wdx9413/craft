import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("v0.11.24 binds validated capability context to Codex and Claude dispatches", async () => {
  const root = join(tmpdir(), `craft-context-dispatch-${process.pid}-${Date.now()}`); const sourcePath = join(root, "skills");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  try {
    await mkdir(sourcePath, { recursive: true }); const skill = "---\nname: brief helper\ndescription: help prepare briefs\ncapability_id: brief-helper\n---\nUse concise factual language.";
    await writeFile(join(sourcePath, "SKILL.md"), skill); const source = await service.sourceAdd({ path: sourcePath });
    const task = service.taskOpen({ title: "Brief", goal: "Prepare brief" }).task as JsonObject;
    const plan = (await service.logicalActivationPlan({ plan_id: "brief-plan", task_id: task.id, query: "brief helper" })).plan as JsonObject;
    const success = async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false, outputLimited: false });
    service.codexHost.executor = success; service.claudeHost.executor = success;
    const common = { task_id: task.id, workspace: root, prompt: "Prepare the brief", plan_id: plan.id, max_chars: 500 };
    const codex = await service.capabilityContextDispatchPrepare({ ...common, host: "codex-cli", dispatch_id: "codex-context" }); const codexDispatch = codex.dispatch as JsonObject;
    assert.equal(codexDispatch.activation_plan_id, plan.id); assert.equal(typeof codexDispatch.activation_context_digest, "string");
    assert.equal(((await service.capabilityContextDispatchExecute({ host: "codex-cli", dispatch_id: codexDispatch.id, prompt: common.prompt })).receipt as JsonObject).status, "completed");
    const claude = await service.capabilityContextDispatchPrepare({ ...common, host: "claude-code", dispatch_id: "claude-context", max_turns: 2 });
    assert.equal(((await service.capabilityContextDispatchExecute({ host: "claude-code", dispatch_id: (claude.dispatch as JsonObject).id, prompt: common.prompt })).receipt as JsonObject).status, "completed");
    const mcp = new McpServer(service, "full");
    const prepared = await mcp.handle({ id: "prepare", method: "tools/call", params: { name: "craft_capability_context_dispatch_prepare", arguments: { ...common, host: "codex-cli", dispatch_id: "mcp-context" } } });
    assert.equal((prepared?.result as JsonObject).isError, false);
    const executed = await mcp.handle({ id: "execute", method: "tools/call", params: { name: "craft_capability_context_dispatch_execute", arguments: { host: "codex-cli", dispatch_id: "mcp-context", prompt: common.prompt } } });
    assert.equal((executed?.result as JsonObject).isError, false);
    const other = service.taskOpen({ title: "Other", goal: "Other" }).task as JsonObject;
    await assert.rejects(service.capabilityContextDispatchPrepare({ ...common, host: "codex-cli", task_id: other.id }), /belong/);
    await assert.rejects(service.capabilityContextDispatchPrepare({ ...common, host: "unknown" }), /unsupported/);
    const plain = service.codexDispatchPrepare({ task_id: task.id, workspace: root, prompt: "plain", dispatch_id: "plain" }).dispatch as JsonObject;
    await assert.rejects(service.capabilityContextDispatchExecute({ host: "codex-cli", dispatch_id: plain.id, prompt: "plain" }), /no capability/);
    await assert.rejects(service.capabilityContextDispatchExecute({ host: "unknown", dispatch_id: plain.id, prompt: "plain" }), /unsupported/);
    const partial = store.save("codex_dispatch", "partial", { ...plain, activation_plan_id: plan.id });
    await assert.rejects(service.capabilityContextDispatchExecute({ host: "codex-cli", dispatch_id: partial.id, prompt: "plain" }), /no capability/);
    const tampered = store.save("codex_dispatch", String(codexDispatch.id), { ...codexDispatch, activation_context_digest: "wrong" });
    await assert.rejects(service.capabilityContextDispatchExecute({ host: "codex-cli", dispatch_id: tampered.id, prompt: common.prompt }), /changed since/);
    await writeFile(join(sourcePath, "SKILL.md"), `${skill}\nChanged.`);
    await assert.rejects(service.capabilityContextDispatchExecute({ host: "codex-cli", dispatch_id: codexDispatch.id, prompt: common.prompt }), /digest drifted/);
    await service.sourceScan({ source_id: source.id });
    assert.equal(VERSION, "0.11.25");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
