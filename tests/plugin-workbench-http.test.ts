import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";

test("插件 sandboxed 页面与 resync 可经 HTTP 访问", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-plugin-http-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const app = new WorkbenchWebApp(service, "secret", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: unknown) => app.handleAsync({ method, path, token: "secret",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const pluginDir = join(root, "p"); await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "panel.html"), "<html><body>panel</body></html>", "utf8");
    const installed = await call("POST", "/api/workbench/plugins", { plugin_root: pluginDir,
      manifest: { name: "http-plugin", version: "1.0.0", hosts: ["craft"],
        workbench: { schemaVersion: 1, pages: [{ id: "panel", title: "Panel", kind: "sandboxed", entry: "panel.html" }] } } });
    assert.equal(installed.status, 201);
    const pluginId = String((JSON.parse(installed.body).plugin as JsonObject).id);
    const repo = join(root, "ws"); await mkdir(repo, { recursive: true });
    const workspace = JSON.parse((await call("POST", "/api/workspaces/resolve-or-create", { root_path: repo })).body).workspace as JsonObject;
    await call("POST", `/api/workspaces/${encodeURIComponent(String(workspace.id))}/plugins/${encodeURIComponent(pluginId)}/enable`);
    const page = await call("GET", `/api/workbench/plugins/${encodeURIComponent(pluginId)}/pages/panel?workspace_id=${encodeURIComponent(String(workspace.id))}`);
    assert.equal(page.status, 200);
    const sandbox = JSON.parse(page.body).sandbox as JsonObject;
    assert.match(String(sandbox.html), /panel/u);
    assert.match(String(sandbox.html), /Content-Security-Policy/u);
    const resync = await call("POST", `/api/workbench/plugins/${encodeURIComponent(pluginId)}/resync`, { allow_manifest_change: true });
    assert.equal(resync.status, 200);
    assert.equal(typeof JSON.parse(resync.body).pages, "number");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
