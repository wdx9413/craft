import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { A2ATransportKernel } from "../core/a2a-transport.ts";
import { OrgSyncKernel } from "../core/org-sync.ts";
import { ProjectKnowledgeKernel } from "../capability/craft-knowledge/project-knowledge.ts";
import { StateWorkspaceKernel, kind } from "../core/state-workspace.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

test("small compatibility kernels cover explicit fallback, conflict, and boundary outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-low-gap-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    assert.equal(kind({ isFile: () => true, isDirectory: () => false }, "f"), "file");
    assert.equal(kind({ isFile: () => false, isDirectory: () => true }, "d"), "directory");
    assert.throws(() => kind({ isFile: () => false, isDirectory: () => false }, "special"), /regular files/);
    const org = new OrgSyncKernel(store);
    assert.throws(() => org.prepare({ workspace_id: "w", member_ids: "bad" }), /array/);
    const prepared = org.prepare({ sync_id: "sync", workspace_id: "w" });
    assert.equal(org.prepare({ sync_id: "sync", workspace_id: "w" }).idempotent, true);
    assert.throws(() => org.prepare({ sync_id: "sync", workspace_id: "other" }), /conflict/);
    assert.equal(org.apply({ sync_id: "sync", base_digest: "wrong" }).status, "conflict");
    assert.equal(org.apply({ sync_id: "sync", base_digest: String((prepared.manifest as JsonObject).manifest_digest) }).status, "applied");
    const project = new ProjectKnowledgeKernel(store);
    assert.throws(() => project.discover({ project_root: root }), /trusted=true/);
    assert.deepEqual((project.discover({ project_root: root, trusted: true }).discovery as JsonObject).descriptors, []);
    const a2a = new A2ATransportKernel();
    const ok = async () => ({ status: 200, json: async () => ({ remote_id: "r", status: "accepted" }) });
    assert.equal((await a2a.dispatch({ endpoint: "https://agent", request_id: "r", agent: "a", operation: "get", input_digest: "sha256:i" }, ok)).status, "accepted");
    await assert.rejects(() => a2a.taskCancel({ endpoint: "https://agent", task_id: "t" }, async () => ({ status: 503, json: async () => ({}) })), /HTTP/);
    const service = new CraftService(store);
    assert.throws(() => service.memoryRemember({ kind: "fact", scope: "user", content: "token=longsecretvalue", source: "test" }), /credentials/);
    const workspace = service.workspaceOpen({ workspace_id: "w", name: "W", root_path: root, include_paths: ["."] }).workspace as JsonObject;
    const state = new StateWorkspaceKernel(store);
    assert.throws(() => state.observe({ workspace_id: workspace.id, adapter: "file_artifact", paths: [] }), /at least one/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
