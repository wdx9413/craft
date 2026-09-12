import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
test("Work Launch binds and rechecks local capability context across approval", async () => {
  const root = join(tmpdir(), `craft-context-launch-${Date.now()}`); const skills = join(root, "skills"); const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  try {
    await mkdir(skills, { recursive: true }); const content = "---\nname: safe helper\ndescription: helps work\ncapability_id: safe-helper\n---\nUse evidence."; await writeFile(join(skills, "SKILL.md"), content);
    const source = await service.sourceAdd({ path: skills }); const task = service.taskOpen({ title: "Work", goal: "Do work" }).task as JsonObject; const plan = (await service.logicalActivationPlan({ task_id: task.id, query: "safe helper" })).plan as JsonObject;
    service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false, outputLimited: false });
    const args = { task_id: task.id, host: "codex-cli", workspace: root, prompt: "Do work", plan_id: plan.id, sandbox: "workspace-write" };
    const prepared = await service.capabilityContextWorkLaunchPrepare(args); const launch = prepared.launch as JsonObject; assert.equal(launch.status, "awaiting_approval"); assert.equal(typeof launch.activation_context_digest, "string");
    const decided = await service.capabilityContextWorkLaunchDecide({ launch_id: launch.id, actor: "human", approved: true, prompt: args.prompt }); assert.equal(decided.started, true);
    const mcp = new McpServer(service, "full"); const mcpPrepared = await mcp.handle({ id: "prepare", method: "tools/call", params: { name: "craft_capability_context_work_launch_prepare", arguments: { ...args, launch_id: "mcp-launch" } } }); assert.equal((mcpPrepared?.result as JsonObject).isError, false);
    const mcpDecision = await mcp.handle({ id: "decide", method: "tools/call", params: { name: "craft_capability_context_work_launch_decide", arguments: { launch_id: "mcp-launch", actor: "human", approved: false, prompt: args.prompt } } }); assert.equal((mcpDecision?.result as JsonObject).isError, false);
    const plain = service.workLaunchPrepare({ task_id: task.id, host: "codex-cli", workspace: root, prompt: "plain", sandbox: "workspace-write" }).launch as JsonObject;
    await assert.rejects(service.capabilityContextWorkLaunchDecide({ launch_id: plain.id, actor: "human", approved: true, prompt: "plain" }), /no capability/);
    store.save("work_launch", String(plain.id), { ...plain, activation_plan_id: plan.id }); await assert.rejects(service.capabilityContextWorkLaunchDecide({ launch_id: plain.id, actor: "human", approved: true, prompt: "plain" }), /no capability/);
    const tampered = await service.capabilityContextWorkLaunchPrepare({ ...args, launch_id: "tampered" }); store.save("work_launch", String((tampered.launch as JsonObject).id), { ...(tampered.launch as JsonObject), activation_context_digest: "wrong" }); await assert.rejects(service.capabilityContextWorkLaunchDecide({ launch_id: (tampered.launch as JsonObject).id, actor: "human", approved: true, prompt: args.prompt }), /changed since/);
    const claude = await service.capabilityContextWorkLaunchPrepare({ ...args, host: "claude-code", launch_id: "claude" }); assert.equal((claude.dispatch as JsonObject).kind, undefined);
    const stale = await service.capabilityContextWorkLaunchPrepare({ ...args, launch_id: "stale" }); await writeFile(join(skills, "SKILL.md"), `${content}\nChanged.`); await assert.rejects(service.capabilityContextWorkLaunchDecide({ launch_id: (stale.launch as JsonObject).id, actor: "human", approved: true, prompt: args.prompt }), /digest drifted/);
    await service.sourceScan({ source_id: source.id }); assert.equal(VERSION, "0.11.62");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
