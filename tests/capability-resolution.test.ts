import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("capability resolution loads only digest-pinned local documents as bounded context", async () => {
  const root = join(tmpdir(), `craft-logical-resolve-${process.pid}-${Date.now()}`); const sourcePath = join(root, "skills");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  try {
    await mkdir(sourcePath, { recursive: true });
    const skill = "---\nname: brief maker\ndescription: create a brief\ncapability_id: brief-maker\n---\nRead the input and prepare a concise brief.";
    await writeFile(join(sourcePath, "SKILL.md"), skill);
    const source = await service.sourceAdd({ path: sourcePath }); const task = service.taskOpen({ title: "Brief", goal: "Create a brief" }).task as JsonObject;
    const plan = (await service.logicalActivationPlan({ plan_id: "brief_plan", task_id: task.id, query: "brief maker" })).plan as JsonObject;
    const resolved = await service.logicalActivationResolve({ plan_id: plan.id, resolution_id: "direct_resolution", audit_id: "direct_audit", max_chars: 500 });
    assert.equal(((resolved.capabilities as JsonObject[])[0]).content, skill); assert.equal((resolved.resolution as JsonObject).capabilities instanceof Array, true);
    assert.equal(Object.prototype.hasOwnProperty.call(((resolved.resolution as JsonObject).capabilities as JsonObject[])[0], "content"), false);
    const defaulted = await service.logicalActivationResolve({ plan_id: plan.id });
    assert.match(String((defaulted.resolution as JsonObject).id), /^logical_activation_resolution_/);
    await assert.rejects(service.logicalActivationResolve({ plan_id: plan.id, max_chars: 1 }), /context limit/);
    const mcp = new McpServer(service, "full");
    const mcpResolved = await mcp.handle({ id: "resolve", method: "tools/call", params: { name: "craft_logical_activation_resolve", arguments: {
      plan_id: plan.id, resolution_id: "mcp_resolution", audit_id: "mcp_audit", max_chars: 500,
    } } });
    assert.equal((mcpResolved?.result as JsonObject).isError, false);
    for (const [name, arguments_] of Object.entries({
      craft_logical_activation_resolution_get: { resolution_id: "mcp_resolution" }, craft_logical_activation_resolution_list: {},
    })) {
      const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((result?.result as JsonObject).isError, false, name);
    }
    await writeFile(join(sourcePath, "SKILL.md"), `${skill}\nChanged.`);
    await assert.rejects(service.logicalActivationResolve({ plan_id: plan.id }), /digest drifted/);
    await service.sourceScan({ source_id: source.id });
    await assert.rejects(service.logicalActivationResolve({ plan_id: plan.id }), /stale/);
    assert.equal(VERSION, "0.11.39");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
