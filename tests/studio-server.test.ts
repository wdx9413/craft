import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore } from "../src/store.ts";
import { LocalWorkbenchServer, WorkbenchWebApp, locateStudio, studioBridge } from "../src/workbench-server.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-studio-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}

test("Craft Studio serves its Codex-style app from beside the runtime", async () => {
  const f = await fixture();
  const repoRoot = path.resolve(import.meta.dirname, "..");
  assert.equal(locateStudio(), path.join(repoRoot, "studio"));
  assert.equal(locateStudio(repoRoot), path.join(repoRoot, "studio"));
  assert.equal(locateStudio(path.join(tmpdir(), "craft-studio-absent")), null);

  const app = new WorkbenchWebApp(f.service, "studio-token", "http://127.0.0.1:4173");
  const index = app.handle({ method: "GET", path: "/studio" });
  assert.equal(index.status, 200); assert.match(index.contentType, /text\/html/); assert.match(index.body, /Craft Studio/);
  assert.equal(app.handle({ method: "GET", path: "/studio/" }).status, 200);
  assert.match(app.handle({ method: "GET", path: "/studio/app.css" }).body, /--bg-rail/);
  assert.match(app.handle({ method: "GET", path: "/studio/app.js" }).body, /studio\/call/);
  assert.equal(app.handle({ method: "GET", path: "/studio/missing.css" }).status, 404);
  assert.equal(new WorkbenchWebApp(f.service, "studio-token", "http://127.0.0.1:4173", { studioDir: null })
    .handle({ method: "GET", path: "/studio" }).status, 404);
  assert.equal(studioBridge(f.service), studioBridge(f.service));
  f.store.close();
});

test("Craft Studio projects model, project, connector and source reads over the same-origin API", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const get = (requestPath: string) => app.handle({ method: "GET", path: requestPath, token: "secret" });
  const post = (requestPath: string, body: unknown) => app.handle({ method: "POST", path: requestPath, token: "secret", body: JSON.stringify(body) });

  assert.equal(JSON.parse(get("/api/studio/summary").body).version, VERSION);
  f.store.create("memory_item", "studio-memory", { task_id: "studio-task", kind: "decision", content: "Keep observations local", scope: "task", status: "active" });
  f.store.create("workflow", "studio-workflow", { name: "Observe", status: "active" });
  f.store.create("workflow_run", "studio-workflow-run", { task_id: "studio-task", workflow_id: "studio-workflow", status: "completed" });
  assert.equal((JSON.parse(get("/api/studio/resources?kind=memory&task_id=studio-task").body) as { items: unknown[] }).items.length, 1);
  assert.equal((JSON.parse(get("/api/studio/resources?kind=workflows&task_id=studio-task").body) as { workflows: unknown[] }).workflows.length, 1);
  assert.equal(get("/api/studio/resources?kind=nope").status, 422);
  assert.equal(post("/api/studio/plugins", { manifest: { name: "Local helper", version: "1.0.0", description: "A locally installed descriptor" } }).status, 201);
  assert.equal((JSON.parse(get("/api/studio/resources?kind=plugins").body) as { items: unknown[] }).items.length, 1);
  assert.equal(post("/api/studio/skills", { name: "release-note", description: "Write release notes", content: "---\nname: release-note\n---\nWrite release notes." }).status, 201);
  assert.equal((JSON.parse(get("/api/studio/resources?kind=skills").body) as { items: unknown[] }).items.length, 1);
  assert.equal(post("/api/studio/memory", { kind: "fact", scope: "user", content: "Keep the work local" }).status, 201);
  assert.equal((JSON.parse(get("/api/studio/resources?kind=memory").body) as { items: unknown[] }).items.length, 2);
  assert.equal(post("/api/studio/knowledge/claims", { kind: "rule", content: "Review external plugins before use" }).status, 201);
  assert.equal(post("/api/studio/workflows", { name: "Local review", description: "Review a local change", inputs: [], steps: [] }).status, 201);

  const models = JSON.parse(get("/api/models").body) as { count: number; providers: Array<Record<string, unknown>> };
  assert.equal(models.count >= 8, true);
  assert.equal(models.providers.some((item) => item.provider === "deepseek"), true);
  const deepseek = JSON.parse(get("/api/models/deepseek?tier=frontier").body) as Record<string, unknown>;
  assert.equal((deepseek.selection as Record<string, unknown>).model, "deepseek-reasoner");
  assert.equal(JSON.parse(get("/api/models/deepseek").body).selection, undefined);
  assert.equal(get("/api/models/nope").status, 422);
  const saved = JSON.parse(post("/api/model-profiles", { profile_id: "studio-deepseek-standard", provider: "deepseek", tier: "standard" }).body) as Record<string, unknown>;
  assert.equal((saved.profile as Record<string, unknown>).provider, "deepseek");
  assert.equal((saved.readiness as Record<string, unknown>).status, "needs_enablement");
  assert.equal((JSON.parse(get("/api/model-profiles").body) as { profiles: unknown[] }).profiles.length, 1);
  assert.equal((JSON.parse(get("/api/model-profiles?limit=5").body) as { profiles: unknown[] }).profiles.length, 1);
  assert.equal(get("/api/model-profiles?limit=0").status, 422);

  assert.equal((JSON.parse(get("/api/projects").body) as { projects: unknown[] }).projects.length, 0);
  assert.equal(post("/api/projects", { project_id: "studio-pilot", name: "Studio Pilot" }).status, 201);
  const snapshot = JSON.parse(get("/api/projects/studio-pilot").body) as Record<string, unknown>;
  assert.equal((snapshot.brain as Record<string, unknown>).project_id, "studio-pilot");
  assert.equal(snapshot.next_action, "define_goal");
  assert.equal(post("/api/projects/studio-pilot/goals", { title: "Ship the Studio shell" }).status, 201);
  assert.equal(post("/api/projects/studio-pilot/decisions", { title: "Keep it local", rationale: "no remote writes", chosen_ref: "local-first" }).status, 201);
  assert.equal(post("/api/projects/studio-pilot/materials", { name: "Spec", uri: "file:///spec.md", content_digest: "sha256:spec" }).status, 201);
  assert.equal(post("/api/projects/studio-pilot/experiences", { name: "Checkpoint first", pattern: "checkpoint before every write" }).status, 201);
  assert.equal(post("/api/projects/studio-pilot/outcomes", { verdict: "delivered", summary: "shell shipped", evidence_ids: [], artifact_ids: [] }).status, 201);
  const after = JSON.parse(get("/api/projects/studio-pilot?limit=5").body) as Record<string, unknown[]>;
  assert.equal(after.goals.length, 1); assert.equal(after.materials.length, 1); assert.equal(after.outcomes.length, 1);
  assert.equal((JSON.parse(get("/api/projects").body) as { projects: unknown[] }).projects.length, 1);
  assert.equal(get("/api/projects?limit=0").status, 422);

  assert.equal((JSON.parse(get("/api/connectors").body) as { connectors: unknown[] }).connectors.length, 0);
  const registered = JSON.parse(post("/api/connectors", { connector_id: "studio-plugins", kind: "github_skill", name: "Craft plugin market",
    endpoint: "https://github.com/wdx9413/craft", approved: true, approval_ref: "studio-user" }).body) as Record<string, unknown>;
  assert.equal((registered.connector as Record<string, unknown>).kind, "github_skill");
  const discovered = JSON.parse(post("/api/connectors/studio-plugins/discover", { assets: [
    { logical_id: "craft-route", name: "craft-route", asset_type: "skill", effect: "read_only" }] }).body) as { assets: Array<Record<string, unknown>> };
  assert.equal(discovered.assets.length, 1);
  assert.equal((JSON.parse(get("/api/connectors?limit=10").body) as { assets: unknown[] }).assets.length, 1);
  assert.equal(post(`/api/connector-assets/${String(discovered.assets[0].id)}/approve`, { approval_ref: "studio-user" }).status, 200);
  assert.equal(post("/api/connectors/studio-plugins/status", { active: false }).status, 200);
  assert.equal(post("/api/connectors/studio-plugins/status", { active: true }).status, 200);
  assert.equal(post("/api/connectors/studio-plugins/revoke", { reason: "rotated to a new source" }).status, 200);
  assert.equal(get("/api/connectors?limit=0").status, 422);

  assert.equal((JSON.parse(get("/api/sources").body) as { sources: unknown[] }).sources.length, 0);
  const mounted = await app.handleAsync({ method: "POST", path: "/api/sources", token: "secret", origin: "http://127.0.0.1:4173",
    body: JSON.stringify({ path: f.root, label: "studio skills", scan: false }) });
  assert.equal(mounted.status, 201);
  assert.equal((JSON.parse(get("/api/sources").body) as { sources: unknown[] }).sources.length, 1);
  f.store.close();
});

test("the Studio bridge forwards a bounded craft_ call behind the same guards as the Workbench", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const call = (body: unknown, token = "secret", origin?: string) => app.handleAsync({ method: "POST", path: "/api/studio/call", token, origin, body: JSON.stringify(body) });

  assert.equal((await call({ tool: "craft_info" }, "secret", "https://evil.example")).status, 403);
  assert.equal((await call({ tool: "craft_info" }, "wrong")).status, 401);
  assert.equal((await call({ tool: "source_list" })).status, 422);
  assert.equal((await call({ tool: "craft_not_a_tool" })).status, 422);
  assert.equal((await call({ tool: "craft_info", args: [] })).status, 422);
  const info = await call({ tool: "craft_info" });
  assert.equal(info.status, 200); assert.equal(JSON.parse(info.body).version, VERSION);
  assert.equal(JSON.parse((await call({ tool: "craft_info", args: {} })).body).version, VERSION);
  assert.equal((await app.handleAsync({ method: "POST", path: "/api/sources", token: "secret", body: "{" })).status, 400);
  assert.equal((await app.handleAsync({ method: "GET", path: "/health" })).status, 200);

  const server = new LocalWorkbenchServer(f.service, "network-token"); const started = await server.start(0); const origin = started.url.split("/#")[0];
  try {
    assert.match((await (await fetch(`${origin}/studio`)).text()), /Craft Studio/);
    assert.equal((await fetch(`${origin}/api/studio/call`, { method: "POST", headers: { authorization: "Bearer network-token", origin }, body: JSON.stringify({ tool: "craft_info" }) })).status, 200);
  } finally { await server.close(); f.store.close(); }
});

test("Studio exposes task conversation behind the same token and origin gates", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const task = f.service.taskOpen({ title: "Conversation", goal: "Keep context", model_id: "missing-model" }).task as Record<string, unknown>;
  const endpoint = `/api/tasks/${String(task.id)}/messages`;
  assert.equal((await app.handleAsync({ method: "POST", path: endpoint, token: "wrong", body: JSON.stringify({ content: "hello" }) })).status, 401);
  assert.equal((await app.handleAsync({ method: "POST", path: endpoint, token: "secret", origin: "https://evil.example", body: JSON.stringify({ content: "hello" }) })).status, 403);
  const rejected = await app.handleAsync({ method: "POST", path: endpoint, token: "secret", body: JSON.stringify({ content: "hello" }) });
  assert.equal(rejected.status, 422); assert.match(rejected.body, /no longer configured/);
  f.store.close();
});
