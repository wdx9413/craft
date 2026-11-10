import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

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
    store.create("change_set", "legacy-applied", { workspace_id: "ws", status: "applied", patches: [
      { object_id: "brief", base_version: brief.version, op: "set", path: "/title", value: "B" },
    ] });
    assert.equal(service.changeSetApply({ change_set_id: "legacy-applied" }).idempotent, true);
    assert.equal(((service.changeSetPreview({ change_set_id: "legacy-applied" }).patches as JsonObject[])[0]).classification, "applied");
    const generated = service.changeSetCreate({ workspace_id: "ws", summary: "Generated id", author: "agent",
      patches: [{ object_id: "brief", base_version: nextBrief.version, op: "remove", path: "/missing" }] }).change_set as JsonObject;
    assert.match(String(generated.id), /^change_set_/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("detects same-field conflicts and rejects malformed or unsafe patches", async () => {
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
    for (const path of ["/__proto__/crafted", "/constructor/prototype/crafted", "/bad~2escape"]) {
      assert.throws(() => bad([{ object_id: "object", base_version: 1, op: "set", path, value: true }]), /unsafe|escape/i);
    }
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

test("concurrent human edits are not overwritten between preview and apply", async () => {
  const root = join(tmpdir(), `craft-patch-race-${process.pid}-${Date.now()}`), worktree = join(root, "worktree");
  const paths = craftPaths(join(root, "craft"));
  const store = await new CraftStore(paths).open(), second = await new CraftStore(paths).open();
  second.database.exec("PRAGMA busy_timeout=50");
  const service = new CraftService(store), human = new CraftService(second);
  try {
    await mkdir(worktree, { recursive: true });
    service.workspaceOpen({ workspace_id: "ws", name: "Workspace", root_path: worktree, include_paths: ["."] });
    const object = service.workObjectPut({ workspace_id: "ws", object_id: "object", object_type: "doc", name: "Doc", data: { title: "before" } }).object as JsonObject;
    service.changeSetCreate({ change_set_id: "cs", workspace_id: "ws", summary: "Edit", author: "agent", patches: [
      { object_id: "object", base_version: object.version, op: "set", path: "/title", value: "agent" },
    ] });
    const saveBatch = store.saveBatch.bind(store); let interleaved = false, humanBlocked = false;
    store.saveBatch = ((entries) => {
      if (!interleaved) {
        interleaved = true;
        try { human.workObjectPut({ workspace_id: "ws", object_id: "object", object_type: "doc", name: "Doc", data: { title: "human" }, expected_state_revision: 2 }); }
        catch (error) { if (!/locked|busy/i.test(String(error))) throw error; humanBlocked = true; }
      }
      return saveBatch(entries);
    }) as typeof store.saveBatch;
    try { service.changeSetApply({ change_set_id: "cs", expected_state_revision: 2 }); }
    catch (error) { if (!/Concurrent|refresh|locked|busy/i.test(String(error))) throw error; }
    if (humanBlocked) human.workObjectPut({ workspace_id: "ws", object_id: "object", object_type: "doc", name: "Doc", data: { title: "human" }, expected_state_revision: 3 });
    assert.deepEqual(second.get("work_object", "object").data, { title: "human" });
    assert.equal(second.get("change_set", "cs").status, humanBlocked ? "applied" : "draft");
  } finally { store.close(); second.close(); await rm(root, { recursive: true, force: true }); }
});

test("a deleted parent conflicts with a nested patch and removing a missing path creates nothing", async () => {
  const root = join(tmpdir(), `craft-patch-parent-${process.pid}-${Date.now()}`), worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open(), service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    service.workspaceOpen({ workspace_id: "ws", name: "Workspace", root_path: worktree, include_paths: ["."] });
    const base = service.workObjectPut({ workspace_id: "ws", object_id: "doc", object_type: "doc", name: "Doc", data: { a: { x: 1 }, unrelated: 1 } }).object as JsonObject;
    service.changeSetCreate({ change_set_id: "nested", workspace_id: "ws", summary: "Edit", author: "agent", patches: [
      { object_id: "doc", base_version: base.version, op: "set", path: "/a/new", value: 2 },
    ] });
    service.workObjectPut({ workspace_id: "ws", object_id: "doc", data: { a: { x: 2 }, unrelated: 1 }, expected_state_revision: 2 });
    assert.equal((service.changeSetPreview({ change_set_id: "nested" }).conflicts as JsonObject[]).length, 0);
    service.workObjectPut({ workspace_id: "ws", object_id: "doc", data: { a: 2, unrelated: 1 }, expected_state_revision: 3 });
    assert.equal((service.changeSetPreview({ change_set_id: "nested" }).conflicts as JsonObject[]).length, 1);
    assert.throws(() => service.changeSetApply({ change_set_id: "nested" }), /conflicts/u);
    service.workObjectPut({ workspace_id: "ws", object_id: "doc", data: { unrelated: 2 }, expected_state_revision: 4 });
    assert.equal((service.changeSetPreview({ change_set_id: "nested" }).conflicts as JsonObject[]).length, 1);
    assert.throws(() => service.changeSetApply({ change_set_id: "nested" }), /conflicts/u);
    const current = store.get("work_object", "doc");
    service.changeSetCreate({ change_set_id: "remove", workspace_id: "ws", summary: "Remove", author: "agent", patches: [
      { object_id: "doc", base_version: current.version, op: "remove", path: "/absent/child" },
    ] });
    service.changeSetApply({ change_set_id: "remove" });
    assert.deepEqual(store.get("work_object", "doc").data, { unrelated: 2 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("selected patches can be accepted independently and retried without overwriting human edits", async () => {
  const root = join(tmpdir(), `craft-patch-partial-${process.pid}-${Date.now()}`), worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open(), service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    service.workspaceOpen({ workspace_id: "ws", name: "Workspace", root_path: worktree, include_paths: ["."] });
    const base = service.workObjectPut({ workspace_id: "ws", object_id: "doc", object_type: "doc", name: "Doc", data: { title: "before", style: "plain" } }).object as JsonObject;
    service.changeSetCreate({ change_set_id: "cs", workspace_id: "ws", summary: "Edit", author: "agent", patches: [
      { object_id: "doc", base_version: base.version, op: "set", path: "/title", value: "agent" },
      { object_id: "doc", base_version: base.version, op: "set", path: "/style", value: "bold" },
    ] });
    const partial = service.changeSetApply({ change_set_id: "cs", patch_indices: [0], expected_state_revision: 2 });
    assert.equal((partial.change_set as JsonObject).status, "draft");
    assert.deepEqual((store.get("work_object", "doc").data), { title: "agent", style: "plain" });
    assert.equal(service.changeSetApply({ change_set_id: "cs", patch_indices: [0] }).idempotent, true);
    service.workObjectPut({ workspace_id: "ws", object_id: "doc", data: { title: "human", style: "plain" }, expected_state_revision: 3 });
    const final = service.changeSetApply({ change_set_id: "cs", patch_indices: [1], expected_state_revision: 4 });
    assert.equal((final.change_set as JsonObject).status, "applied");
    assert.deepEqual(store.get("work_object", "doc").data, { title: "human", style: "bold" });
    assert.equal(service.changeSetApply({ change_set_id: "cs", patch_indices: [1] }).idempotent, true);
    const changes = service.workspaceGet({ workspace_id: "ws" }).changes as JsonObject[];
    assert.equal(changes.length, 2);
    assert.deepEqual(changes.map(change => change.patch_indices).sort((a, b) => Number((a as number[])[0]) - Number((b as number[])[0])), [[0], [1]]);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("unselected conflicts do not prevent accepting another patch through MCP", async () => {
  const root = join(tmpdir(), `craft-patch-select-${process.pid}-${Date.now()}`), worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open(), service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    service.workspaceOpen({ workspace_id: "ws", name: "Workspace", root_path: worktree, include_paths: ["."] });
    const base = service.workObjectPut({ workspace_id: "ws", object_id: "doc", object_type: "doc", name: "Doc", data: { title: "before", style: "plain" } }).object as JsonObject;
    service.changeSetCreate({ change_set_id: "cs", workspace_id: "ws", summary: "Edit", author: "agent", patches: [
      { object_id: "doc", base_version: base.version, op: "set", path: "/title", value: "agent" },
      { object_id: "doc", base_version: base.version, op: "set", path: "/style", value: "bold" },
    ] });
    service.workObjectPut({ workspace_id: "ws", object_id: "doc", data: { title: "before", style: "human" }, expected_state_revision: 2 });
    for (const invalid of [[], [-1], [2], [0, 0], ["0"], "0"]) {
      assert.throws(() => service.changeSetApply({ change_set_id: "cs", patch_indices: invalid }), /patch_indices/u);
    }
    const mcp = new McpServer(service, "full");
    const result = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_change_set_apply", arguments: { change_set_id: "cs", patch_indices: [0] } } });
    assert.equal((result?.result as JsonObject).isError, false);
    assert.deepEqual(store.get("work_object", "doc").data, { title: "agent", style: "human" });
    const preview = service.changeSetPreview({ change_set_id: "cs" });
    assert.deepEqual((preview.patches as JsonObject[]).map(patch => patch.classification), ["applied", "conflict"]);
    assert.throws(() => service.changeSetApply({ change_set_id: "cs", patch_indices: [1] }), /conflicts/u);
    assert.equal(service.changeSetApply({ change_set_id: "cs", patch_indices: [0] }).idempotent, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("selected patches keep the original ChangeSet order", async () => {
  const root = join(tmpdir(), `craft-patch-order-${process.pid}-${Date.now()}`), worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open(), service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    service.workspaceOpen({ workspace_id: "ws", name: "Workspace", root_path: worktree, include_paths: ["."] });
    const base = service.workObjectPut({ workspace_id: "ws", object_id: "doc", object_type: "doc", name: "Doc", data: { a: { x: 1 } } }).object as JsonObject;
    service.changeSetCreate({ change_set_id: "cs", workspace_id: "ws", summary: "Edit", author: "agent", patches: [
      { object_id: "doc", base_version: base.version, op: "set", path: "/a", value: { x: 2 } },
      { object_id: "doc", base_version: base.version, op: "set", path: "/a/x", value: 3 },
    ] });
    service.changeSetApply({ change_set_id: "cs", patch_indices: [1, 0] });
    assert.deepEqual(store.get("work_object", "doc").data, { a: { x: 3 } });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("workspace change receipt collisions never overwrite existing records", async () => {
  const root = join(tmpdir(), `craft-patch-collision-${process.pid}-${Date.now()}`), worktree = join(root, "worktree");
  const store = await new CraftStore(craftPaths(join(root, "craft"))).open(), service = new CraftService(store);
  try {
    await mkdir(worktree, { recursive: true });
    service.workspaceOpen({ workspace_id: "ws", name: "Workspace", root_path: worktree, include_paths: ["."] });
    const base = service.workObjectPut({ workspace_id: "ws", object_id: "doc", object_type: "doc", name: "Doc", data: { title: "before", style: "plain" } }).object as JsonObject;
    const patches = [
      { object_id: "doc", base_version: base.version, op: "set", path: "/title", value: "agent" },
      { object_id: "doc", base_version: base.version, op: "set", path: "/style", value: "bold" },
    ];
    service.changeSetCreate({ change_set_id: "first", workspace_id: "ws", summary: "Edit", author: "agent", patches });
    const protectedFirst = store.create("workspace_change", "first_change", { workspace_id: "ws", summary: "keep first" });
    assert.throws(() => service.changeSetApply({ change_set_id: "first", patch_indices: [0] }), /already exists|collision/i);
    assert.deepEqual(store.get("workspace_change", "first_change"), protectedFirst);
    assert.deepEqual(store.get("work_object", "doc").data, { title: "before", style: "plain" });
    service.changeSetCreate({ change_set_id: "later", workspace_id: "ws", summary: "Edit", author: "agent", patches });
    service.changeSetApply({ change_set_id: "later", patch_indices: [0] });
    const protectedLater = store.create("workspace_change", "later_change_4", { workspace_id: "ws", summary: "keep later" });
    assert.throws(() => service.changeSetApply({ change_set_id: "later", patch_indices: [1] }), /already exists|collision/i);
    assert.deepEqual(store.get("workspace_change", "later_change_4"), protectedLater);
    assert.deepEqual(store.get("work_object", "doc").data, { title: "agent", style: "plain" });
    assert.equal(store.get("change_set", "later").status, "draft");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
