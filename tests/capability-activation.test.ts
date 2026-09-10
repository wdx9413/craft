import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("logical capability content is pinned and audit detects reselection or drift", async () => {
  const root = join(tmpdir(), `craft-logical-activation-${process.pid}-${Date.now()}`); const primary = join(root, "primary"); const mirror = join(root, "mirror");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  try {
    await mkdir(primary, { recursive: true }); await mkdir(mirror, { recursive: true });
    const skill = "---\nname: research brief\ndescription: research a brief\ncapability_id: research-brief\n---\nRead only.";
    await writeFile(join(primary, "SKILL.md"), skill); await writeFile(join(mirror, "SKILL.md"), skill);
    const first = await service.sourceAdd({ path: primary, label: "Primary", priority: 1 }); const second = await service.sourceAdd({ path: mirror, label: "Mirror", priority: 2 });
    const task = service.taskOpen({ title: "Research", goal: "Research a brief" }).task as JsonObject;
    const profile = service.contextProfileSave({ profile_id: "research_context", name: "Research context", task_id: task.id }).profile as JsonObject;
    const activation = await service.logicalActivationPlan({ plan_id: "research_plan", task_id: task.id, query: "research brief", limit: 3 });
    const plan = activation.plan as JsonObject; assert.equal(((plan.selected as JsonObject[])[0]).selected_source_id, second.id);
    const generatedPlan = await service.logicalActivationPlan({ task_id: task.id, query: "research brief" });
    assert.match(String((generatedPlan.plan as JsonObject).id), /^logical_activation_plan_/);
    assert.equal((service.logicalActivationAudit({ plan_id: (generatedPlan.plan as JsonObject).id }).audit as JsonObject).status, "active");
    const mcp = new McpServer(service, "full");
    const created = await mcp.handle({ id: "plan", method: "tools/call", params: { name: "craft_logical_activation_plan", arguments: {
      plan_id: "mcp_plan", task_id: task.id, query: "research brief", context_profile_id: profile.id, context_profile_version: profile.version,
    } } });
    assert.equal((created?.result as JsonObject).isError, false);
    const otherTask = service.taskOpen({ title: "Other", goal: "Other brief" }).task as JsonObject;
    await assert.rejects(service.logicalActivationPlan({ task_id: otherTask.id, query: "research", context_profile_id: profile.id, context_profile_version: profile.version }), /belong/);
    const stable = service.logicalActivationAudit({ plan_id: plan.id, audit_id: "stable" });
    assert.equal((stable.audit as JsonObject).status, "active"); assert.equal(((stable.audit as JsonObject).findings as JsonObject[])[0].status, "unchanged");
    service.sourceUpdate({ source_id: second.id, enabled: false });
    const reselected = service.logicalActivationAudit({ plan_id: plan.id, audit_id: "reselected" });
    assert.equal((reselected.plan as JsonObject).status, "active"); assert.equal(((reselected.audit as JsonObject).findings as JsonObject[])[0].status, "reselected");
    await writeFile(join(primary, "SKILL.md"), `${skill}\nUpdated guidance.`); await service.sourceScan({ source_id: first.id });
    const changed = service.logicalActivationAudit({ plan_id: plan.id, audit_id: "changed" });
    assert.equal((changed.plan as JsonObject).status, "stale"); assert.equal(((changed.audit as JsonObject).findings as JsonObject[])[0].status, "content_changed");
    service.sourceUpdate({ source_id: first.id, enabled: false });
    const stale = service.logicalActivationAudit({ plan_id: plan.id, audit_id: "stale" });
    assert.equal((stale.plan as JsonObject).status, "stale"); assert.equal(((stale.audit as JsonObject).findings as JsonObject[])[0].status, "missing");
    await assert.rejects(service.logicalActivationPlan({ task_id: task.id, query: "research", allowed_effects: ["local_write"] }), /read_only/);
    await assert.rejects(service.logicalActivationPlan({ task_id: task.id, query: "research", context_profile_id: "missing" }), /together/);
    await assert.rejects(service.logicalActivationPlan({ task_id: task.id, query: "research" }), /No logical/);
    for (const [name, arguments_] of Object.entries({
      craft_logical_activation_plan_get: { plan_id: plan.id }, craft_logical_activation_plan_list: {}, craft_logical_activation_audit: { plan_id: plan.id, audit_id: "mcp_audit" },
    })) {
      const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((result?.result as JsonObject).isError, false, name);
    }
    assert.equal(VERSION, "0.11.34");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
