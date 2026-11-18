import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

test("trusted Mod UI contributions render only in supported workspaces and actions re-enter Craft authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-workbench-"));
  const workspaceRoot = join(root, "workspace"); await mkdir(workspaceRoot);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const workspace = (service.workspaceResolveOrCreate({ root_path: workspaceRoot }) as JsonObject).workspace as JsonObject;
    const packageRoot = join(root, "mod"); await mkdir(packageRoot);
    await writeFile(join(packageRoot, "register.mjs"), `export function register(on) {
      on("craft.ui.interaction@1", () => ({ kind: "continue" }));
    }\n`);
    assert.throws(() => service.modRuntimeStage({ package_root: packageRoot, manifest: {
      id: "unsafe-ui", name: "unsafe", version: "1", entry: "register.mjs", hooks: [{ event: "craft.ui.interaction@1", capability: "event.observe" }], capabilities: ["event.observe"],
      ui_contributions: [{ id: "unsafe", insertion_point: "approval_review", hosts: ["workbench"], platforms: ["darwin"], layout: [] }],
    } }), /protected or unsupported/u);
    assert.throws(() => service.modRuntimeStage({ package_root: packageRoot, manifest: {
      id: "platformless-ui", name: "platformless", version: "1", entry: "register.mjs", hooks: [{ event: "craft.ui.interaction@1", capability: "event.observe" }], capabilities: ["event.observe"],
      ui_contributions: [{ id: "platformless", insertion_point: "task_context", hosts: ["workbench"], layout: [] }],
    } }), /platforms must explicitly list/u);
    service.modRuntimeStage({ package_root: packageRoot, manifest: {
      id: "context-shortcut", name: "Context shortcut", version: "1.0.0", entry: "register.mjs",
      scope_kind: "project", scope_id: String(workspace.id), hooks: [{ event: "craft.ui.interaction@1", capability: "event.observe" }], capabilities: ["event.observe"],
      ui_contributions: [{ id: "quick-actions", version: 1, insertion_point: "task_context", update_budget_ms: 25, hosts: ["workbench"], platforms: ["darwin", "linux", "win32"],
        layout: [{ type: "text", id: "hint", label: "读取 Craft 状态" }, { type: "button", id: "read", label: "查看状态", action_id: "info" }] }],
    } });
    let response = service.workbenchPluginContributions({ workspace_id: workspace.id, context: "project" }) as JsonObject;
    assert.equal((response.mod_contributions as JsonObject[]).length, 0, "staged Mods never render");
    const review = service.modRuntimeReview({ mod_id: "context-shortcut" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "context-shortcut", code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:test" });
    response = service.workbenchPluginContributions({ workspace_id: workspace.id, context: "project" }) as JsonObject;
    assert.equal((response.mod_contributions as JsonObject[]).length, 0, "task-context contributions do not leak into the project view");
    response = service.workbenchPluginContributions({ workspace_id: workspace.id, context: "task" }) as JsonObject;
    assert.equal((response.mod_contributions as JsonObject[]).length, 1);
    const windowsResponse = service.workbenchPluginContributions({ workspace_id: workspace.id, context: "task", platform: "win32" }) as JsonObject;
    assert.equal((windowsResponse.mod_contributions as JsonObject[]).length, 1, "declared Windows contribution is available");
    const unsupportedResponse = service.workbenchPluginContributions({ workspace_id: workspace.id, context: "task", platform: "freebsd" }) as JsonObject;
    assert.equal((unsupportedResponse.mod_contributions as JsonObject[]).length, 0);
    assert.equal((unsupportedResponse.unavailable_mod_contributions as JsonObject[]).some((item) => item.reason === "workbench_ui_platform_unsupported"), true);
    await assert.rejects(service.modRuntimeUiInteract({ mod_id: "context-shortcut", workspace_id: workspace.id, platform: "freebsd",
      contribution_id: "quick-actions", action_id: "info", request_id: "unsupported-platform-action" }), /not supported on this platform/u);
    const interaction = await service.modRuntimeUiInteract({ mod_id: "context-shortcut", workspace_id: workspace.id,
      contribution_id: "quick-actions", action_id: "info", request_id: "ui-interaction-1" });
    assert.equal((interaction.action as JsonObject).id, "info");
    assert((interaction.event as JsonObject).receipt);

    const codexRoot = join(root, "codex-ui"); await mkdir(codexRoot);
    await writeFile(join(codexRoot, "register.mjs"), `export function register(on) { on("craft.ui.interaction@1", () => ({ kind: "continue" })); }\n`);
    service.modRuntimeStage({ package_root: codexRoot, manifest: { id: "codex-ui", name: "Codex UI", version: "1.0.0", entry: "register.mjs",
      scope_kind: "project", scope_id: String(workspace.id), capabilities: ["event.observe"],
      hooks: [{ event: "craft.ui.interaction@1", capability: "event.observe" }],
      ui_contributions: [{ id: "codex-only", insertion_point: "task_context", hosts: ["codex"], platforms: ["darwin", "linux", "win32"],
        layout: [{ type: "button", id: "codex-action", label: "Unavailable here", action_id: "info" }] }] } });
    const codexReview = service.modRuntimeReview({ mod_id: "codex-ui" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "codex-ui", code_digest: codexReview.code_digest,
      permission_digest: codexReview.permission_digest, actor: "user:test" });
    response = service.workbenchPluginContributions({ workspace_id: workspace.id, context: "task" }) as JsonObject;
    assert.equal((response.mod_contributions as JsonObject[]).some((item) => (item.contribution as JsonObject).id === "codex-only"), false);
    const unavailable = (response.unavailable_mod_contributions as JsonObject[]).find((item) => (item.contribution as JsonObject).id === "codex-only");
    assert.equal(unavailable?.reason, "workbench_ui_host_unsupported");
    await assert.rejects(service.modRuntimeUiInteract({ mod_id: "codex-ui", workspace_id: workspace.id,
      contribution_id: "codex-only", action_id: "info", request_id: "unsupported-host-action" }), /not declared for Workbench/u);

    await assert.rejects(service.modRuntimeUiInteract({ mod_id: "context-shortcut", workspace_id: workspace.id,
      contribution_id: "quick-actions", action_id: "craft_mod_runtime_trust", request_id: "protected-action" }), /not declared|protected approval/u);
    service.modRuntimeWithdraw({ mod_id: "context-shortcut", actor: "user:test", reason: "disabled by test" });
    response = service.workbenchPluginContributions({ workspace_id: workspace.id, context: "task" }) as JsonObject;
    assert.equal((response.mod_contributions as JsonObject[]).length, 0);
    await assert.rejects(service.modRuntimeUiInteract({ mod_id: "context-shortcut", workspace_id: workspace.id,
      contribution_id: "quick-actions", action_id: "info", request_id: "ui-after-disable" }), /disabled or untrusted/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
