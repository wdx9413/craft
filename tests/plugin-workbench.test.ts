import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { normalizeWorkbenchContribution, validateDeclarativePage } from "../core/plugin-workbench.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-plugin-workbench-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  return { root, store, service };
}

test("workbench contribution validates pages and rejects invalid kinds or traversal", () => {
  const ok = normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: [{ id: "context", title: "Context", kind: "declarative", schema: "./workbench/context.page.json" }] } });
  assert.deepEqual(ok.pages.map((page) => [page.id, page.kind, page.schema]), [["context", "declarative", "./workbench/context.page.json"]]);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 2 } }), /schemaVersion/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: [{ id: "Bad Id", title: "t", schema: "s" }] } }), /id/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: [{ id: "p", title: "t", kind: "script", schema: "s" }] } }), /kind/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: [{ id: "p", title: "t", schema: "../escape.json" }] } }), /relative path/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: [{ id: "p", title: "t", schema: "s" }, { id: "p", title: "t2", schema: "s" }] } }), /unique/);
});

test("declarative page validation only allows fixed components and whitelisted action APIs", () => {
  assert.equal((validateDeclarativePage({ type: "section", children: [{ type: "rows" }, { type: "status" }] }) as JsonObject).type, "section");
  assert.throws(() => validateDeclarativePage({ type: "script", src: "x" }), /not allowed/);
  assert.throws(() => validateDeclarativePage({ type: "actions", actions: [{ api: "/api/admin/delete" }] }), /not whitelisted/);
  assert.equal((validateDeclarativePage({ type: "actions", actions: [{ api: "/api/workbench/context-usage" }] }) as JsonObject).type, "actions");
});

test("plugin install stores workbench pages and serves a validated schema on demand", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "plugin");
    await mkdir(join(dir, "workbench"), { recursive: true });
    await writeFile(join(dir, "workbench", "context.page.json"), JSON.stringify({ type: "section", children: [{ type: "rows" }] }));
    const manifest = { name: "demo", version: "1.0.0", hosts: ["craft"],
      workbench: { schemaVersion: 1, pages: [{ id: "context", title: "Context", kind: "declarative", schema: "./workbench/context.page.json", requires: ["memory"] }] } };
    const plugin = (f.service.workbenchPluginInstall({ manifest, plugin_root: dir }) as JsonObject).plugin as JsonObject;
    assert.deepEqual((plugin.workbench_pages as JsonObject[]).map((page) => page.id), ["context"]);
    const pages = f.service.workbenchPluginPages({ plugin_id: plugin.id }) as JsonObject;
    assert.equal((pages.pages as JsonObject[]).length, 1);
    const loaded = f.service.workbenchPluginPage({ plugin_id: plugin.id, page_id: "context" }) as JsonObject;
    assert.equal((loaded.schema as JsonObject).type, "section");
    assert.throws(() => f.service.workbenchPluginPage({ plugin_id: plugin.id, page_id: "missing" }), /not found/);
    // A malformed schema is rejected when opened, not when installed.
    await writeFile(join(dir, "workbench", "context.page.json"), JSON.stringify({ type: "script" }));
    assert.throws(() => f.service.workbenchPluginPage({ plugin_id: plugin.id, page_id: "context" }), /not allowed/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workspace plugin enable/disable is per-workspace and idempotent", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "repo"); await mkdir(dir);
    const workspace = (f.service.workspaceResolveOrCreate({ root_path: dir }) as JsonObject).workspace as JsonObject;
    const plugin = (f.service.workbenchPluginInstall({ manifest: { name: "demo", version: "1.0.0", hosts: ["craft"] } }) as JsonObject).plugin as JsonObject;
    const enabled = f.service.workspacePluginSet({ workspace_id: workspace.id, plugin_id: plugin.id, status: "enabled" }) as JsonObject;
    assert.equal((enabled.binding as JsonObject).status, "enabled");
    const disabled = f.service.workspacePluginSet({ workspace_id: workspace.id, plugin_id: plugin.id, status: "disabled" }) as JsonObject;
    assert.equal((disabled.binding as JsonObject).status, "disabled");
    assert.equal(((f.service.workspacePlugins({ workspace_id: workspace.id }) as JsonObject).bindings as JsonObject[]).length, 1);
    assert.throws(() => f.service.workspacePluginSet({ workspace_id: workspace.id, plugin_id: plugin.id, status: "paused" }), /enabled or disabled/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a page's requires are checked against the capability catalog and can be loaded on demand", async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "req"); await mkdir(join(dir, "workbench"), { recursive: true });
    await writeFile(join(dir, "workbench", "p.json"), JSON.stringify({ type: "section" }));
    const manifest = { name: "r", version: "1.0.0", hosts: ["craft"],
      workbench: { schemaVersion: 1, pages: [
        { id: "good", title: "G", kind: "declarative", schema: "./workbench/p.json", requires: ["memory"] },
        { id: "bad", title: "B", kind: "declarative", schema: "./workbench/p.json", requires: ["nonexistent"] },
      ] } };
    const plugin = (f.service.workbenchPluginInstall({ manifest, plugin_root: dir }) as JsonObject).plugin as JsonObject;
    const catalog = (): JsonObject[] => (f.service.capabilityCatalog().capabilities as JsonObject[]);
    assert.deepEqual(catalog().map((item) => item.id), ["memory", "knowledge", "experience", "codebase", "eval", "datasec"]);
    // Known capability opens.
    assert.equal(((f.service.workbenchPluginPage({ plugin_id: plugin.id, page_id: "good" }) as JsonObject).page as JsonObject).id, "good");
    // Unknown capability fails closed with a named reason.
    assert.throws(() => f.service.workbenchPluginPage({ plugin_id: plugin.id, page_id: "bad" }), /unknown capabilities: nonexistent/);
    // ensureLoaded flips the catalog entry and is idempotent.
    const before = catalog().find((item) => item.id === "memory");
    assert.equal(before?.loaded, false);
    assert.deepEqual(await f.service.capabilityEnsure({ capability_id: "memory" }), { capability_id: "memory", loaded: true });
    const after = catalog().find((item) => item.id === "memory");
    assert.equal(after?.loaded, true);
    await assert.rejects(f.service.capabilityEnsure({ capability_id: "nope" }), /unknown capability/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
