import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { defaultSettings, normalizeSettings } from "../core/settings.ts";
import { contextMirrorDocument, contextMirrorStatuses, contextMirrorWrite } from "../core/context-mirror.ts";

const ORIGIN = "http://127.0.0.1:1";
type Row = Record<string, unknown>;

test("context storage mirrors memory, knowledge and experience into a plain folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-ctx-mirror-"));
  const vault = await mkdtemp(join(tmpdir(), "craft-ctx-vault-"));
  const paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  const service = new CraftService(store);

  store.create("memory_item", "m1", { kind: "fact", content: "先配工具再开会话", status: "active", scope: "user", source: "studio_user" });
  store.create("knowledge_claim", "k1", { kind: "fact", content: "Craft 复用本机 CLI", status: "active", scope: "user" });
  service.workbenchWorkflowSave({ workflow_id: "w1", name: "发布流程", description: "先跑门禁", steps: [{ type: "action" }] });

  // Default is local-only: nothing is written anywhere until the user opts in.
  const initial = service.contextStorageView();
  assert.deepEqual((initial.storage as Row).memory, { mode: "off", path: null });
  assert.equal((initial.status as Row[]).every((entry) => entry.ok), true);

  const saved = service.contextStorageSave({ storage: { memory: { mode: "mirror", path: vault }, knowledge: { mode: "mirror", path: vault } } });
  assert.equal((saved.storage as Row).experience && ((saved.storage as Row).experience as Row).mode, "off");
  assert.equal((saved.status as Row[]).find((entry) => entry.kind === "memory")?.path, vault);

  const memory = service.contextStorageExport({ kind: "memory" });
  assert.equal(memory.entries, 1);
  assert.equal((memory.written as string[]).length, 1);
  assert.match(await readFile(join(vault, "memory", "m1.md"), "utf8"), /先配工具再开会话/);
  assert.match(await readFile(join(vault, "memory", "_index.md"), "utf8"), /\[\[m1\|/);

  assert.equal((service.contextStorageExport({ kind: "knowledge" }).written as string[]).length, 1);
  // Experience stays off, so its folder is never created.
  assert.deepEqual((service.contextStorageExport({ kind: "experience" }) as Row).written, []);
  assert.equal(existsSync(join(vault, "experience")), false);
  assert.throws(() => service.contextStorageExport({ kind: "codebase" }), /kind must be memory/u);

  const app = new WorkbenchWebApp(service, "token", ORIGIN);
  assert.equal(app.handle({ method: "GET", path: "/api/workbench/context-storage" }).status, 401);
  const view = app.handle({ method: "GET", path: "/api/workbench/context-storage", token: "token" });
  assert.equal(view.status, 200);
  const routed = app.handle({ method: "POST", path: "/api/workbench/context-storage", token: "token",
    body: JSON.stringify({ storage: { experience: { mode: "mirror", path: vault } } }) });
  assert.equal(routed.status, 200);
  assert.equal(((JSON.parse(routed.body).storage as Row).experience as Row).mode, "mirror");
  const exported = app.handle({ method: "POST", path: "/api/workbench/context-storage/export", token: "token", body: JSON.stringify({ kind: "experience" }) });
  assert.equal(exported.status, 201);
  assert.equal((JSON.parse(exported.body).written as string[]).length, 1);
  assert.match(await readFile(join(vault, "experience", "w1.md"), "utf8"), /先跑门禁/);

  // An unwritable target is reported per kind instead of throwing away the export.
  const blocked = join(vault, "blocked-file");
  await writeFile(blocked, "x", "utf8");
  service.contextStorageSave({ storage: { memory: { mode: "mirror", path: blocked } } });
  const blockedView = service.contextStorageView();
  const blockedStatus = (blockedView.status as Row[]).find((entry) => entry.kind === "memory") as Row;
  assert.equal(blockedStatus.ok, false);
  assert.equal(typeof blockedStatus.detail, "string");
  const blockedExport = service.contextStorageExport({ kind: "memory" }) as Row;
  assert.equal(blockedExport.written && (blockedExport.written as string[]).length, 0);
  assert.equal(typeof blockedExport.error, "string");

  store.close();
});

test("context mirror status and documents stay honest about unusable targets", () => {
  const base = join(tmpdir(), "craft-context-test");
  const settings = defaultSettings(craftPaths(base));
  assert.equal(contextMirrorStatuses(settings).length, 3);
  assert.match(contextMirrorDocument("memory", { id: "a b", title: "", body: "  body  ", meta: { status: "active", scope: "" } }),
    /craft_kind: memory\ncraft_id: a b\nstatus: active\n---\n\n# a b\n\nbody\n$/u);

  const mirror = (path: string | null) => ({ ...settings, workbench: { ...settings.workbench, contextStorage: {
    ...settings.workbench.contextStorage, memory: { mode: "mirror" as const, path } } } });
  const relative = contextMirrorWrite(mirror("relative/vault"), "memory", [{ id: "a", title: "a", body: "b", meta: {} }]);
  assert.equal(relative.written.length, 0);
  assert.equal(relative.error, "远端目录必须是绝对路径");
  const missing = contextMirrorWrite(mirror(null), "memory", []);
  assert.equal(missing.error, "尚未设置远端目录");
  assert.equal(contextMirrorWrite(settings, "knowledge", []).mode, "off");

  assert.equal(normalizeSettings({ workbench: { contextStorage: { memory: { mode: "mirror", path: join(base, "vault") } } } },
    craftPaths(base)).workbench.contextStorage.memory.path, join(base, "vault"));
  assert.throws(() => normalizeSettings({ workbench: { contextStorage: { memory: { mode: "mirror" } } } }),
    /path is required when mode is mirror/u);
  assert.throws(() => normalizeSettings({ workbench: { contextStorage: { memory: { mode: "sync" } } } }), /mode must be off or mirror/u);
  assert.throws(() => normalizeSettings({ workbench: { contextStorage: { memory: 4 } } }), /must be an object/u);
  assert.throws(() => normalizeSettings({ workbench: { contextStorage: { knowledge: { mode: "mirror", path: "relative" } } } }), /absolute path/u);
});

test("memory, knowledge and experience writes are mirrored when a target is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-ctx-write-"));
  const vault = await mkdtemp(join(tmpdir(), "craft-ctx-write-vault-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  service.contextStorageSave({ storage: {
    memory: { mode: "mirror", path: vault }, knowledge: { mode: "mirror", path: vault }, experience: { mode: "mirror", path: vault } } });

  service.workbenchMemorySave({ candidate_id: "write-memory", kind: "working", scope_kind: "user", scope_id: "local", content: "镜像这条记忆" });
  service.workbenchKnowledgeClaimSave({ claim_id: "write-claim", kind: "fact", content: "镜像这条知识", scope: "global" });
  service.workbenchWorkflowSave({ workflow_id: "write-experience", name: "镜像经验", description: "做一遍", steps: [] });

  assert.match(await readFile(join(vault, "memory", "write-memory.md"), "utf8"), /镜像这条记忆/u);
  assert.match(await readFile(join(vault, "knowledge", "write-claim.md"), "utf8"), /镜像这条知识/u);
  assert.match(await readFile(join(vault, "experience", "write-experience.md"), "utf8"), /镜像经验/u);
  // Write-through must not fabricate the export index; only the explicit export does.
  assert.equal(existsSync(join(vault, "memory", "_index.md")), false);
  store.close();
});
