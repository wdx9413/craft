import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexHookBridge } from "../core/codex-hook-bridge.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { McpServer } from "../core/mcp.ts";
import { CraftService } from "../core/service.ts";
import { parseToolName } from "../core/tool-plane.ts";

test("Context Hook and MCP share project binding for candidate capture, discovery and reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-evolution-project-"));
  const alpha = join(root, "alpha"), beta = join(root, "beta");
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = await CraftService.open(store);
    const hook = new CodexHookBridge(service, undefined, true);
    const compact = new McpServer(service, "component-context-agent");
    const full = new McpServer(service);
    const call = async (server: McpServer, name: string, args: JsonObject = {}) => {
      const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return response?.result as JsonObject;
    };
    const routed = (name: string, args: JsonObject) => call(compact, "craft_run", { ...parseToolName(name), args });
    async function turn(cwd: string, session: string, prompt: string, turnId = "turn-1") {
      const result = await hook.handle("context", { cwd, session_id: session, turn_id: turnId, hook_event_name: "UserPromptSubmit", prompt });
      return JSON.parse(String(result.additionalContext)) as { project_binding: string; scope: JsonObject };
    }
    const a = await turn(alpha, "session-alpha", "步骤：先轻推木块，再检查是否平齐");
    const b = await turn(beta, "session-beta", "开始本项目任务");
    assert.match(a.project_binding, /^[a-f0-9_.]+$/u);
    const discovery = await call(compact, "craft_context_tools_discover", { intent: "evolution" });
    assert.ok(((discovery.structuredContent as JsonObject).tools as JsonObject[])
      .some(tool => tool.name === "craft_evolution_program_memory_list"));
    const list = "craft_evolution_program_memory_list";
    const get = "craft_evolution_program_memory_get";
    const capture = "craft_evolution_domain_capture";
    const aItems = ((await routed(list, { project_binding: a.project_binding })).structuredContent as JsonObject).items as JsonObject[];
    assert.equal(aItems.length, 1);
    assert.equal(aItems[0]!.domain, "general");
    assert.equal((aItems[0]!.source_refs as JsonObject[])[0]!.kind, "host_turn");
    assert.equal((await routed(get, { id: aItems[0]!.id, project_binding: b.project_binding })).isError, true);
    assert.equal((await routed(list, { project_binding: b.project_binding, scope: a.scope })).isError, true);
    const foreignRoot = await routed("craft_evolution_travel_capture", { statement: "旅行偏好", project_root: alpha, project_binding: b.project_binding });
    assert.equal((foreignRoot.structuredContent as JsonObject).error_code, "SCOPE_FORBIDDEN");
    assert.equal((await call(full, list, { scope: a.scope })).isError, true);
    assert.equal((await routed(list, { project_binding: "not-a-binding" })).isError, true);
    assert.equal((await routed(list, { project_binding: "ffffffffffffffffffffffffffffffff.ffffffffffffffffffffffffffffffff" })).isError, true);
    assert.equal((await routed(list, { project_binding: a.project_binding, scope: a.scope })).isError, false);
    assert.deepEqual(((await call(full, list, { project_binding: b.project_binding })).structuredContent as JsonObject).items, []);

    store.create("program_memory_candidate", "legacy-untrusted", {
      statement: "legacy unverified scope body", status: "diagnostic", scope: b.scope, evidence_ids: [],
    });
    assert.equal((await routed(get, { id: "legacy-untrusted", project_binding: b.project_binding })).isError, true);
    assert.deepEqual(((await routed(list, { project_binding: b.project_binding })).structuredContent as JsonObject).items, []);

    store.create("workflow_evolution_request", "governed-request", { observation_refs: [] });
    store.create("program_memory_procedure_binding", "governed-request", { procedure_id: "governed-procedure", scope: a.scope });
    store.create("workflow_evolution_proposal", "governed-proposal", { request_id: "governed-request", description: "private project material" });
    store.create("experience_procedure", "governed-procedure", { request_id: "governed-request", scope: a.scope.id,
      title: "private project material", description: "private project material", trigger: "private project material",
      lifecycle: "routeable", routeable: true, procedure_kind: "workflow", acceptance_ref: "verified" });
    store.create("experience_evaluation_dispatch", "governed-dispatch", { procedure_id: "governed-procedure", procedure_version: 1, status: "awaiting_adapter" });
    store.create("experience_procedure", "ordinary-procedure", { scope: a.scope.id, description: "legacy ordinary Procedure" });
    store.create("experience_evaluation_dispatch", "ordinary-dispatch", { procedure_id: "ordinary-procedure", procedure_version: 1, status: "awaiting_adapter" });
    store.create("procedure_invocation", "protected-child-invocation", { procedure_id: "ordinary-procedure", nodes: [{ procedure_id: "governed-procedure" }] });
    for (const [name, args] of [
      ["craft_experience_procedure_get", { proposal_id: "governed-proposal" }],
      ["craft_experience_learning_request_get", { request_id: "governed-request" }],
      ["craft_procedure_get", { procedure_id: "governed-procedure" }],
      ["craft_procedure_gate", { procedure_id: "governed-procedure", stage: "canary", evidence_ids: ["legacy-verification"] }],
      ["craft_experience_learning_evaluation_run", { dispatch_id: "governed-dispatch" }],
      ["craft_procedure_invocation_get", { invocation_id: "protected-child-invocation", scope: a.scope.id }],
    ] as const) {
      const denied = await call(full, name, { ...args, project_binding: b.project_binding });
      assert.equal((denied.structuredContent as JsonObject).error_code, "SCOPE_FORBIDDEN", name);
      assert.doesNotMatch(JSON.stringify(denied), /private project material/u);
    }
    assert.equal((await routed("craft_experience_procedure_get", { proposal_id: "governed-proposal", project_binding: a.project_binding })).isError, false);
    assert.equal((await call(full, "craft_procedure_get", { procedure_id: "ordinary-procedure" })).isError, false);
    const queue = "craft_experience_learning_evaluation_dispatch_list";
    const available = async (args: JsonObject) => ((await call(full, queue, args)).structuredContent as { dispatches: JsonObject[] }).dispatches.map(item => item.id);
    assert.deepEqual(await available({}), ["ordinary-dispatch"]);
    assert.deepEqual(await available({ project_binding: a.project_binding }), ["ordinary-dispatch", "governed-dispatch"]);
    const procedures = ((await call(full, "craft_procedure_list", { scope: a.scope.id, project_binding: b.project_binding })).structuredContent as JsonObject).procedures as JsonObject[];
    assert.deepEqual(procedures.map(item => item.id), ["ordinary-procedure"]);
    const resolve = "craft_context_resolution_resolve";
    const contextArgs = { query: "private project material", scope_kind: "project", scope_id: a.scope.id, members: ["experience"] };
    assert.doesNotMatch(JSON.stringify(await routed(resolve, { ...contextArgs, project_binding: b.project_binding })), /governed-procedure/u);
    assert.doesNotMatch(JSON.stringify(await routed(resolve, contextArgs)), /governed-procedure/u);
    assert.match(JSON.stringify(await routed(resolve, { ...contextArgs, project_binding: a.project_binding })), /governed-procedure/u);
    store.save("experience_procedure", "governed-procedure", { scope: a.scope.id, description: "current ordinary draft" });
    const historic = await call(full, "craft_procedure_get", { procedure_id: "governed-procedure", version: 1, project_binding: b.project_binding });
    assert.equal((historic.structuredContent as JsonObject).error_code, "SCOPE_FORBIDDEN");

    const written = await routed(capture, { statement: "收工前先检查木块平齐", project_binding: b.project_binding });
    assert.equal((written.structuredContent as JsonObject).domain, "general");
    const rejected = await routed(capture, { statement: "token=abcdefghijk", project_binding: b.project_binding });
    assert.equal(rejected.isError, true);
    assert.doesNotMatch(JSON.stringify(rejected), /abcdefghijk/u);

    const moved = await turn(beta, "session-alpha", "切换工作项目", "turn-2");
    assert.notEqual(moved.project_binding, a.project_binding);
    assert.equal((await routed(list, { project_binding: a.project_binding })).isError, true);
    assert.equal((await routed(get, { id: aItems[0]!.id, project_binding: moved.project_binding })).isError, true);
    await hook.handle("context", { cwd: beta, session_id: "session-alpha", hook_event_name: "SessionEnd" });
    assert.equal((await routed(list, { project_binding: moved.project_binding })).isError, true);
    await hook.handle("context", { cwd: beta, session_id: "session-alpha", hook_event_name: "SessionEnd" });

    const claudeOutput = await hook.handle("context", { cwd: beta, session_host: "claude",
      session_id: "session-beta", turn_id: "claude-turn", hook_event_name: "UserPromptSubmit", prompt: "开始 Claude 任务" });
    const claude = JSON.parse(String(claudeOutput.additionalContext)) as { project_binding: string };
    assert.equal((await routed(list, { project_binding: claude.project_binding })).isError, false);
    assert.equal((await routed(list, { project_binding: b.project_binding })).isError, false);
    const bindingId = claude.project_binding.split(".")[0]!;
    const binding = store.get("context_evolution_project_binding", bindingId);
    for (const invalid of [{ project_root: null }, { session_id: null }, { turn_id: null }, { host: "unknown" }, { scope: null }]) {
      store.save("context_evolution_project_binding", bindingId, { ...binding, ...invalid });
      assert.equal((await routed(list, { project_binding: claude.project_binding })).isError, true);
    }
    const invalidCall = await compact.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "craft_run", arguments: { resource: "evolution_program_memory", operation: "list", args: ["invalid"] },
    } });
    assert.equal((invalidCall?.result as JsonObject).isError, true);

    store.create("evidence", "legacy-verification", {
      source_type: "host_completion_signal", confidence: "confirmed", record_origin: "runtime",
      metadata: { provenance: "host_completion_signal", content_stored: false, verification_outcome: "passed",
        project_scope_id: b.scope.id, source_session_id: "legacy-session", task_id: "legacy-task",
        turn_id: "legacy-turn", context_receipt_id: "legacy-context" },
    });
    store.create("workflow_evolution_observation", "legacy-observation", {
      lifecycle: "accepted", outcome: "passed", sanitized: true, content_stored: false, scenario_key: "general",
      source: { scope: b.scope.id, session_id: "legacy-session", id: "legacy-task", digest: "legacy-digest" }, evidence_ids: ["legacy-verification"],
    });
    store.create("program_memory_verified_observation", "legacy-observation", { scope: b.scope, evidence_id: "legacy-verification",
      task_id: "legacy-task", source_session_id: "legacy-session", source_digest: "legacy-digest",
      turn_id: "legacy-turn", context_receipt_id: "legacy-context" });
    store.create("program_memory_candidate", "legacy-verified", {
      statement: "retained verified workflow", status: "diagnostic", scope: b.scope,
      scenario_key: "general", evidence_ids: ["legacy-observation"],
    });
    const retained = await routed(get, { id: "legacy-verified", project_binding: b.project_binding });
    assert.equal(((retained.structuredContent as JsonObject).candidate as JsonObject).statement, "retained verified workflow");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
