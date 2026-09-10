import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("ChangeSets merge non-conflicting fields and invalidate only transitive dependents", async () => {
  const root = join(tmpdir(), `craft-patch-${process.pid}-${Date.now()}`); const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open(); const service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    service.workspaceOpen({ workspace_id: "ws", name: "Video", root_path: worktree, include_paths: ["assets"] });
    const brief = service.workObjectPut({ workspace_id: "ws", object_id: "brief", object_type: "brief", name: "Brief",
      data: { title: "A", style: "light", nested: { keep: true } }, expected_state_revision: 1 }).object as JsonObject;
    service.workObjectPut({ workspace_id: "ws", object_id: "shot", object_type: "shot", name: "Shot", data: {},
      depends_on: ["brief"], expected_state_revision: 2 });
    const created = service.changeSetCreate({ change_set_id: "cs", workspace_id: "ws", summary: "Change title", author: "user",
      intent: "revise", patches: [{ object_id: "brief", base_version: brief.version, op: "set", path: "/title", value: "B" },
        { object_id: "brief", base_version: brief.version, op: "remove", path: "/nested/keep" },
        { object_id: "brief", base_version: brief.version, op: "set", path: "/new/value", value: 1 }] });
    assert.equal(((created.preview as JsonObject).conflicts as JsonObject[]).length, 0);
    service.workObjectPut({ workspace_id: "ws", object_id: "brief", object_type: "brief", name: "Brief", data: {
      title: "A", style: "dark", nested: { keep: true } }, expected_state_revision: 3 });
    const preview = service.changeSetPreview({ change_set_id: "cs" });
    assert.equal((preview.patches as JsonObject[]).every((item) => item.classification === "auto_apply"), true);
    const applied = service.changeSetApply({ change_set_id: "cs", expected_state_revision: 4 });
    assert.equal(applied.idempotent, false);
    const objects = service.workObjectList({ workspace_id: "ws" }).objects as JsonObject[];
    const nextBrief = objects.find((item) => item.id === "brief")!; const nextShot = objects.find((item) => item.id === "shot")!;
    assert.deepEqual(nextBrief.data, { title: "B", style: "dark", nested: {}, new: { value: 1 } });
    assert.equal(nextBrief.status, "draft"); assert.equal(nextShot.status, "needs_review");
    assert.equal(service.changeSetApply({ change_set_id: "cs" }).idempotent, true);
    const generated = service.changeSetCreate({ workspace_id: "ws", summary: "Generated id", author: "agent",
      patches: [{ object_id: "brief", base_version: nextBrief.version, op: "remove", path: "/missing" }] }).change_set as JsonObject;
    assert.match(String(generated.id), /^change_set_/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v0.10.1 detects same-field conflicts and rejects malformed or unsafe patches", async () => {
  const root = join(tmpdir(), `craft-patch-errors-${process.pid}-${Date.now()}`); const worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open(); const service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    service.workspaceOpen({ workspace_id: "one", name: "One", root_path: worktree, include_paths: ["one"] });
    service.workspaceOpen({ workspace_id: "two", name: "Two", root_path: worktree, include_paths: ["two"] });
    const object = service.workObjectPut({ workspace_id: "one", object_id: "object", object_type: "doc", name: "Object",
      data: { title: "A", scalar: 1 }, expected_state_revision: 1 }).object as JsonObject;
    service.workObjectPut({ workspace_id: "one", object_id: "object", object_type: "doc", name: "Object",
      data: { title: "C", scalar: 1 }, expected_state_revision: 2 });
    service.changeSetCreate({ change_set_id: "conflict", workspace_id: "one", summary: "conflict", author: "agent",
      patches: [{ object_id: "object", base_version: object.version, op: "set", path: "/title", value: "B" }] });
    assert.equal((service.changeSetPreview({ change_set_id: "conflict" }).conflicts as JsonObject[]).length, 1);
    assert.throws(() => service.changeSetApply({ change_set_id: "conflict" }), /field conflicts/);
    assert.throws(() => service.changeSetApply({ change_set_id: "conflict", expected_state_revision: 1 }), /refresh/);

    const current = store.get("work_object", "object");
    service.changeSetCreate({ change_set_id: "cross", workspace_id: "one", summary: "cross scalar", author: "agent",
      patches: [{ object_id: "object", base_version: current.version, op: "set", path: "/scalar/value", value: 2 }] });
    assert.throws(() => service.changeSetApply({ change_set_id: "cross" }), /non-object/);
    store.save("change_set", "cross", { ...store.get("change_set", "cross"), status: "rejected" });
    assert.throws(() => service.changeSetApply({ change_set_id: "cross" }), /draft/);

    const bad = (patches: unknown) => service.changeSetCreate({ workspace_id: "one", summary: "bad", author: "agent", patches });
    assert.throws(() => bad([]), /non-empty/); assert.throws(() => bad([null]), /must be an object/);
    assert.throws(() => service.changeSetCreate({ workspace_id: "one", summary: " ", author: "agent", patches: [{ object_id: "object", base_version: 1, op: "remove", path: "/x" }] }), /empty/);
    assert.throws(() => bad([{ object_id: "object", base_version: 1, op: "move", path: "/x" }]), /unsupported/);
    assert.throws(() => bad([{ object_id: "object", base_version: 0, op: "set", path: "/x", value: 1 }]), /positive/);
    assert.throws(() => bad([{ object_id: "object", base_version: 1, op: "set", path: "x", value: 1 }]), /JSON Pointer/);
    assert.throws(() => bad([{ object_id: "object", base_version: 1, op: "set", path: "/x" }]), /value is required/);
    assert.throws(() => bad([{ object_id: "bad id", base_version: 1, op: "remove", path: "/x" }]), /letters/);
    assert.throws(() => bad([{ object_id: "object", base_version: 999, op: "remove", path: "/x" }]), /does not exist/);
    const other = service.workObjectPut({ workspace_id: "two", object_id: "other", object_type: "doc", name: "Other", data: {} }).object as JsonObject;
    assert.throws(() => bad([{ object_id: "other", base_version: other.version, op: "remove", path: "/x" }]), /belong/);

    const mcp = new McpServer(service, "full");
    const mcpObject = service.workObjectPut({ workspace_id: "one", object_id: "mcp_object", object_type: "doc", name: "MCP", data: { value: 1 } }).object as JsonObject;
    for (const [name, arguments_] of Object.entries({
      craft_change_set_create: { change_set_id: "mcp_change", workspace_id: "one", summary: "MCP patch", author: "agent",
        patches: [{ object_id: "mcp_object", base_version: mcpObject.version, op: "set", path: "/value", value: 2 }] },
      craft_change_set_preview: { change_set_id: "mcp_change" },
      craft_change_set_apply: { change_set_id: "mcp_change" },
    })) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as JsonObject).isError, false, name);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
