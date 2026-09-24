import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService, VERSION } from "../core/service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { LocalWorkbenchServer, WorkbenchWebApp } from "../core/workbench-server.ts";
import { McpServer } from "../core/mcp.ts";

async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "craft-web-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store); return { store, service }; }

test("Workbench web application exposes a token-gated same-origin API and bounded JSON actions", async () => {
  const f = await fixture(); const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  assert.match(app.handle({ method: "GET", path: "/" }).body, /Craft Workbench/); assert.match(app.handle({ method: "GET", path: "/" }).body, /引导工作/); assert.match(app.handle({ method: "GET", path: "/" }).body, /先固定目标和资料，再回答必要决策/); assert.match(app.handle({ method: "GET", path: "/" }).body, /结果：/); assert.deepEqual(JSON.parse(app.handle({ method: "GET", path: "/health" }).body), { status: "ok", version: VERSION });
  assert.equal(app.handle({ method: "GET", path: "/api/home", token: "secret", origin: "https://evil.example" }).status, 403);
  assert.equal(app.handle({ method: "GET", path: "/api/home" }).status, 401); assert.equal(app.handle({ method: "GET", path: "/api/home", token: "x" }).status, 401); assert.equal(app.handle({ method: "GET", path: "/api/home", token: "xxxxxx" }).status, 401);
  assert.equal(app.handle({ method: "GET", path: "/api/home", token: "secret" }).status, 200);
  assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/domain-kits", token: "secret" }).body).kits.length, 4);
  assert.equal(app.handle({ method: "POST", path: "/api/inbox/refresh", token: "secret" }).status, 200);
  assert.equal(app.handle({ method: "POST", path: "/api/inbox/refresh", token: "secret", body: "{" }).status, 400);
  assert.equal(app.handle({ method: "POST", path: "/api/inbox/refresh", token: "secret", body: "[]" }).status, 422);
  assert.equal(app.handle({ method: "POST", path: "/api/inbox/refresh", token: "secret", body: "null" }).status, 422); assert.equal(app.handle({ method: "POST", path: "/api/inbox/refresh", token: "secret", body: "1" }).status, 422);
  assert.equal(app.handle({ method: "POST", path: "/api/inbox/refresh", token: "secret", body: `{"x":"${"a".repeat(66_000)}"}` }).status, 413);
  f.store.create("attention_item", "card", { status: "open" }); assert.equal(app.handle({ method: "POST", path: "/api/inbox/decide", token: "secret", origin: "http://127.0.0.1:4173", body: JSON.stringify({ item_id: "card", decision: "acknowledge", decided_by: "user" }) }).status, 200);
  const created = app.handle({ method: "POST", path: "/api/tasks", token: "secret", body: JSON.stringify({ title: "Lesson", goal: "Teach fractions" }) }); assert.equal(created.status, 201); const taskId = JSON.parse(created.body).task.id; assert.equal(app.handle({ method: "GET", path: `/api/tasks/${encodeURIComponent(taskId)}`, token: "secret" }).status, 200); assert.equal(app.handle({ method: "GET", path: "/api/tasks/%", token: "secret" }).status, 422);
  const touchpoint = app.handle({ method: "POST", path: "/api/metrics/touchpoints", token: "secret", body: JSON.stringify({ object_id: "start_node", kind: "decision", label: "Choose route", at: "2030-01-01T00:00:00Z" }) }); assert.equal(touchpoint.status, 201); assert.equal(JSON.parse(touchpoint.body).touchpoint.object_id, "start_node");
  const touchpointReport = JSON.parse(app.handle({ method: "GET", path: "/api/metrics/touchpoints", token: "secret" }).body); assert.equal(touchpointReport.objects_measured, 1); assert.equal(touchpointReport.ht_requires_wall_clock, true);
  const objectTouchpointReport = JSON.parse(app.handle({ method: "GET", path: "/api/metrics/touchpoints/start_node", token: "secret" }).body); assert.equal(objectTouchpointReport.object_id, "start_node"); assert.equal(objectTouchpointReport.total, 1); assert.equal(objectTouchpointReport.path, "semi_automatic");
  assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/desktop/surface", token: "secret" }).body).adapter, "windows_uia");
  assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/desktop/vision/surface", token: "secret" }).body).fallback_only, true);
  assert.equal(app.handle({ method: "POST", path: "/api/desktop/vision/sessions", token: "secret", body: JSON.stringify({ session_id: "paint", executable: "mspaint.exe" }) }).status, 201);
  assert.equal(app.handle({ method: "POST", path: "/api/desktop/vision/observations", token: "secret", body: JSON.stringify({ observation_id: "paint-save", session_id: "paint", screenshot_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", image_width: 100, image_height: 100, observed_at: new Date().toISOString(), matches: [{ target_text: "Save", bounds: { x: 1, y: 1, width: 30, height: 20 }, confidence: 0.99 }] }) }).status, 201);
  assert.equal(JSON.parse(app.handle({ method: "POST", path: "/api/desktop/vision/clicks", token: "secret", body: JSON.stringify({ action_id: "paint-save", observation_id: "paint-save", target_text: "Save" }) }).body).human_release_required, true);
  assert.equal(app.handle({ method: "POST", path: "/api/desktop/applications", token: "secret", body: JSON.stringify({ application_id: "notepad", executable: "notepad.exe", allowed_operations: ["read"] }) }).status, 201);
  assert.equal(app.handle({ method: "POST", path: "/api/desktop/controls", token: "secret", body: JSON.stringify({ control_id: "editor", application_id: "notepad", locator: { automation_id: "15", control_type: "Edit" }, allowed_operations: ["read"] }) }).status, 201);
  assert.equal(app.handle({ method: "POST", path: "/api/desktop/actions", token: "secret", body: JSON.stringify({ action_id: "read_editor", control_id: "editor", operation: "read" }) }).status, 201);
  assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/desktop/adjudicate?action_id=read_editor", token: "secret" }).body).adapter_required, true);
  await writeFile(path.join(f.store.paths.root, "fabric.txt"), "baseline"); f.service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "", timedOut: false, cancelled: false, outputLimited: false });
  const loopPrepared = app.handle({ method: "POST", path: "/api/verified-work-loops", token: "secret", body: JSON.stringify({ work_loop_id: "web-loop", title: "Loop", goal: "Deliver file", workspace: f.store.paths.root, include_paths: ["fabric.txt"], host: "codex-cli", prompt: "inspect", sandbox: "read-only" }) }); assert.equal(loopPrepared.status, 201); const webLoop = JSON.parse(loopPrepared.body); await f.service.hostRuns.wait(String(webLoop.launch.run_id));
  assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/verified-work-loops/web-loop", token: "secret" }).body).loop.id, "web-loop"); assert.equal(app.handle({ method: "POST", path: "/api/execution-fabrics", token: "secret", body: "{}" }).status, 404);
  assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/guided-work", token: "secret" }).body).briefs.length, 0); const guided = JSON.parse(app.handle({ method: "POST", path: "/api/guided-work", token: "secret", body: JSON.stringify({ brief_id: "guided-web", title: "Guided lesson", goal: "Prepare a lesson", materials: [{ kind: "note", label: "Outline", reference: "outline.md" }], decisions: [{ id: "audience", question: "Who is it for?" }] }) }).body).brief; assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/guided-work?limit=1", token: "secret" }).body).briefs[0].id, guided.id); assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/guided-work/guided-web", token: "secret" }).body).task.goal, "Prepare a lesson"); assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/guided-work/guided-web?version=1", token: "secret" }).body).task.goal, "Prepare a lesson"); assert.equal(app.handle({ method: "POST", path: "/api/guided-work/guided-web/decide", token: "secret", body: JSON.stringify({ decision_id: "audience", answer: "Beginners", actor: "user" }) }).status, 200); assert.equal(JSON.parse(app.handle({ method: "POST", path: "/api/guided-work/guided-web/launch", token: "secret", body: JSON.stringify({ launch_id: "guided-web-launch", host: "codex-cli", workspace: f.store.paths.root, prompt: "Prepare lesson", sandbox: "workspace-write" }) }).body).brief.status, "launched");
  f.store.create("host_run", "finished", { host: "codex-cli", status: "completed", owner_id: "runner", event_count: 1 }); f.store.appendEvent("host-run:finished", "host.finished", { status: "completed", receipt_id: "receipt" });
  assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/host-runs", token: "secret" }).body).runs.length, 2); assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/host-runs/finished?after=0", token: "secret" }).body).events.length, 1); assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/host-runs/finished", token: "secret" }).body).events.length, 1); assert.equal(JSON.parse(app.handle({ method: "POST", path: "/api/host-runs/finished/cancel", token: "secret", body: JSON.stringify({ reason: "user" }) }).body).idempotent, true);
  const writePrepared = JSON.parse(app.handle({ method: "POST", path: "/api/verified-work-loops", token: "secret", body: JSON.stringify({ work_loop_id: "web-write-loop", title: "Edit", goal: "Update", host: "codex-cli", workspace: f.store.paths.root, prompt: "edit", sandbox: "workspace-write" }) }).body); assert.equal(writePrepared.launch.status, "awaiting_approval"); assert.equal(app.handle({ method: "POST", path: "/api/work-launches", token: "secret", body: "{}" }).status, 404); assert.equal(app.handle({ method: "POST", path: "/api/verified-work-loops/web-write-loop/decide", token: "secret", body: JSON.stringify({ decision: "approve", actor: "user", approved: false }) }).status, 422);
  const acceptedPrepared = JSON.parse(app.handle({ method: "POST", path: "/api/verified-work-loops", token: "secret", body: JSON.stringify({ work_loop_id: "accepted-loop", title: "Review", goal: "Approve", host: "codex-cli", workspace: f.store.paths.root, prompt: "review", sandbox: "workspace-write", acceptance_criteria: [{ id: "owner", name: "Owner accepts", method: "human" }, { id: "file", name: "File exists", method: "program" }] }) }).body); const accepted = acceptedPrepared.launch; const reviewed = app.handle({ method: "POST", path: `/api/acceptance-plans/${accepted.acceptance_plan_id}/human-review`, token: "secret", body: JSON.stringify({ review_id: "web-review", criterion_id: "owner", reviewer: "user", result: "passed", summary: "Approved in Workbench" }) }); assert.equal(JSON.parse(reviewed.body).assessment.status, "pending");
  const fileJob = app.handle({ method: "POST", path: `/api/acceptance-plans/${accepted.acceptance_plan_id}/file-evaluation`, token: "secret", body: JSON.stringify({ job_id: "web-file", criterion_id: "file", workspace: f.store.paths.root, relative_path: "result.txt", allowed_extensions: [".txt"], max_bytes: 100 }) }); assert.equal(fileJob.status, 201); assert.equal(JSON.parse(fileJob.body).job.adapter_id, "builtin:file-artifact");
  const kitLaunch = JSON.parse(app.handle({ method: "POST", path: "/api/verified-work-loops", token: "secret", body: JSON.stringify({ work_loop_id: "kit-loop", title: "Video", goal: "Deliver", host: "codex-cli", workspace: f.store.paths.root, prompt: "video", sandbox: "workspace-write" }) }).body).launch; const kitApplied = app.handle({ method: "POST", path: "/api/domain-kits/builtin.video-delivery/apply", token: "secret", body: JSON.stringify({ launch_id: kitLaunch.id, values: { video_path: "final.mp4" } }) }); assert.equal(JSON.parse(kitApplied.body).jobs.length, 1);
  const knowledgeEvidence = f.service.evidenceRecord({ evidence_id: "knowledge-evidence", source_type: "program", claim: "The launch facts were checked.", confidence: "bounded" });
  const knowledgeClaim = f.service.knowledgeClaimSave({ claim_id: "knowledge-claim", kind: "fact", content: "Use only checked launch facts.", evidence_ids: [knowledgeEvidence.id] }).claim as Record<string, unknown>;
  assert.equal(app.handle({ method: "POST", path: "/api/knowledge/claims/knowledge-claim/review", token: "secret", body: JSON.stringify({ status: "reviewed", reviewer: "reviewer", reason: "checked" }) }).status, 200);
  const page = (await f.service.wikiPageSave({ page_id: "knowledge-page", title: "Launch facts", body: "# Checked facts\n\nUse only checked launch facts.", claim_ids: [knowledgeClaim.id] })).page as Record<string, unknown>;
  assert.match(JSON.parse(app.handle({ method: "GET", path: "/api/knowledge/pages/knowledge-page?version=1", token: "secret" }).body).body, /Checked facts/); assert.match(JSON.parse(app.handle({ method: "GET", path: "/api/knowledge/pages/knowledge-page", token: "secret" }).body).body, /Checked facts/); assert.equal(app.handle({ method: "POST", path: "/api/knowledge/pages/knowledge-page/refresh", token: "secret", body: "{}" }).status, 200); assert.equal(app.handle({ method: "POST", path: "/api/knowledge/pages/knowledge-page", token: "secret", body: "{}" }).status, 404);
  const bundle = f.service.wikiContextCompile({ bundle_id: "knowledge-bundle", query: "checked launch facts", max_items: 2, max_chars: 1000 }).bundle as Record<string, unknown>;
  const knowledgeView = JSON.parse(app.handle({ method: "GET", path: "/api/knowledge?limit=1", token: "secret" }).body); assert.equal(knowledgeView.summary.claims, 1); assert.equal(knowledgeView.pages[0].id, page.id); assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/knowledge", token: "secret" }).body).summary.pages, 1);
  assert.match(JSON.parse(app.handle({ method: "GET", path: `/api/knowledge/bundles/${bundle.id}/preview?version=${bundle.version}`, token: "secret" }).body).prompt, /checked launch facts/); assert.match(JSON.parse(app.handle({ method: "GET", path: `/api/knowledge/bundles/${bundle.id}/preview`, token: "secret" }).body).prompt, /checked launch facts/); assert.match(f.service.knowledgeContextBundlePreview({ bundle_id: bundle.id, bundle_version: bundle.version, now: "2026-09-11T00:00:00.000Z" }).prompt as string, /checked launch facts/); assert.equal(app.handle({ method: "GET", path: `/api/knowledge/bundles/${bundle.id}`, token: "secret" }).status, 404); assert.equal(app.handle({ method: "POST", path: "/api/knowledge/claims/knowledge-claim", token: "secret", body: "{}" }).status, 404);
  const knowledgeLaunch = JSON.parse(app.handle({ method: "POST", path: "/api/knowledge-work-launches", token: "secret", body: JSON.stringify({ launch_id: "knowledge-web", task_id: taskId, host: "codex-cli", workspace: f.store.paths.root, sandbox: "workspace-write", prompt: "Use facts", bundle_id: bundle.id, bundle_version: bundle.version }) }).body).launch;
  assert.equal(knowledgeLaunch.knowledge_binding.bundle_id, bundle.id); assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/knowledge-work-launches/knowledge-web?after=0", token: "secret" }).body).launch.id, "knowledge-web"); assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/knowledge-work-launches/knowledge-web", token: "secret" }).body).launch.id, "knowledge-web"); assert.equal(app.handle({ method: "POST", path: "/api/knowledge-work-launches/knowledge-web", token: "secret", body: "{}" }).status, 404);
  assert.equal(JSON.parse(app.handle({ method: "POST", path: "/api/knowledge-work-launches/knowledge-web/decide", token: "secret", body: JSON.stringify({ actor: "reviewer", approved: false, prompt: "Use facts" }) }).body).launch.status, "denied");
  f.store.save("work_launch", "knowledge-web", { ...knowledgeLaunch, status: "cancelled" }); assert.equal(app.handle({ method: "POST", path: "/api/knowledge-work-launches/knowledge-web/retry", token: "secret", body: JSON.stringify({ new_launch_id: "knowledge-web-retry", prompt: "Retry facts" }) }).status, 201);
  f.store.create("knowledge_relation", "missing-target", { relation: "contradicts", from_claim_id: "knowledge-claim", to_claim_id: "missing-claim" }); f.store.create("knowledge_relation", "missing-source", { relation: "contradicts", from_claim_id: "missing-claim", to_claim_id: "knowledge-claim" });
  f.store.create("wiki_skill_candidate", "knowledge-candidate", { name: "Candidate", status: "candidate", source_page_ids: [page.id], evaluation_run_ids: [] }); f.store.create("knowledge_evaluation_run", "knowledge-evaluation", { suite_id: "suite", split: "held_out", status: "eligible", summary: {} });
  const fullKnowledge = f.service.knowledgeWorkbenchView() as { conflicts: unknown[]; knowledge_bound_launches: unknown[]; candidates: Array<Record<string, unknown>>; evaluations: Array<Record<string, unknown>> }; assert.equal(fullKnowledge.conflicts.length, 2); assert.equal(fullKnowledge.knowledge_bound_launches.length >= 1, true); assert.equal(fullKnowledge.candidates[0].id, "knowledge-candidate"); assert.equal(fullKnowledge.evaluations[0].id, "knowledge-evaluation"); assert.throws(() => f.service.knowledgeWorkbenchView({ limit: 0 }), /limit/); assert.throws(() => f.service.knowledgeWorkbenchView({ limit: 101 }), /limit/);
  const mcp = new McpServer(f.service, "full"); assert.equal(((await mcp.handle({ id: "knowledge-view", method: "tools/call", params: { name: "craft_knowledge_workbench_view", arguments: {} } }))?.result as Record<string, unknown>).isError, false); assert.equal(((await mcp.handle({ id: "knowledge-preview", method: "tools/call", params: { name: "craft_knowledge_context_bundle_preview", arguments: { bundle_id: bundle.id } } }))?.result as Record<string, unknown>).isError, false);
  assert.equal(app.handle({ method: "DELETE", path: "/api/nope", token: "secret" }).status, 404);
  f.service.attentionRefresh = (() => { throw "failure"; }) as typeof f.service.attentionRefresh; assert.equal(JSON.parse(app.handle({ method: "POST", path: "/api/inbox/refresh", token: "secret", body: "{}" }).body).error, "failure"); f.store.close();
});

test("local Workbench server binds loopback, serves headers, handles bodies, and owns its lifecycle", async () => {
  const f = await fixture(); const server = new LocalWorkbenchServer(f.service, "network-token"); const started = await server.start(0); const origin = started.url.split("/#")[0];
  assert.equal(started.token, "network-token"); assert.equal((await fetch(`${origin}/`)).status, 200); const health = await fetch(`${origin}/health`); assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${origin}/api/home`, { headers: { authorization: "Basic x" } })).status, 401);
  assert.equal((await fetch(`${origin}/api/home`, { headers: { authorization: "Bearer network-token" } })).status, 200);
  for (const route of ["/api/project-brain?project_id=local&limit=1", "/api/workbench-experience?project_id=local&task_id=t&limit=1", "/api/traces?task_id=t&event_kind=x&limit=1", "/api/long-task-checkpoints?session_id=s&limit=1", "/api/workbench/resources?kind=memory&task_id=t&limit=1"]) {
    assert.equal((await fetch(`${origin}${route}`, { headers: { authorization: "Bearer network-token" } })).status < 500, true);
  }
  assert.equal((await fetch(`${origin}/api/inbox/refresh`, { method: "POST", headers: { authorization: "Bearer network-token", origin }, body: "{}" })).status, 200);
  assert.equal((await fetch(`${origin}/api/inbox/refresh`, { method: "POST", headers: { authorization: "Bearer network-token" }, body: "x".repeat(66_000) })).status, 413);
  await assert.rejects(() => server.start(0), /already running/); await server.close(); await server.close(); f.store.close();
});

test("local Workbench evaluates registered file acceptance after its Host Run completes", async () => {
  const f = await fixture(); await writeFile(path.join(f.store.paths.root, "result.txt"), "done");
  f.store.create("host_run", "completed-run", { host: "codex-cli", status: "completed", owner_id: "runner", event_count: 0 });
  f.store.create("work_launch", "file-launch", { task_id: "file-task", run_id: "completed-run" });
  f.store.create("task", "file-task", { title: "File", goal: "Verify", status: "open" });
  const plan = f.service.acceptancePlanSave({ plan_id: "file-plan", task_id: "file-task", launch_id: "file-launch", criteria: [{ id: "file", name: "File exists", method: "program" }] }).plan as Record<string, unknown>;
  f.service.acceptanceFileEvaluationPrepare({ plan_id: plan.id, criterion_id: "file", workspace: f.store.paths.root, relative_path: "result.txt" });
  const server = new LocalWorkbenchServer(f.service, "file-token"); await server.start(0);
  try { const deadline = Date.now() + 2_500; let status = "pending"; while (Date.now() < deadline && status === "pending") { await new Promise((resolve) => setTimeout(resolve, 100)); const assessment = f.service.acceptancePlanGet({ plan_id: plan.id }).assessment as Record<string, unknown> | null; status = assessment ? String(assessment.status) : "pending"; } assert.equal(status, "passed"); }
  finally { await server.close(); f.store.close(); }
});

test("Workbench server validates ports, generates tokens, and reports occupied loopback ports", async () => {
  const f = await fixture(); const generated = new LocalWorkbenchServer(f.service); assert.equal(generated.token.length > 20, true);
  await assert.rejects(() => generated.start(-1), /port/); await assert.rejects(() => generated.start(65536), /port/); await assert.rejects(() => generated.start(1.5), /port/);
  const busy = createServer(); await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve)); const port = (busy.address() as AddressInfo).port;
  const collision = new LocalWorkbenchServer(f.service, "token"); await assert.rejects(() => collision.start(port)); await new Promise<void>((resolve) => busy.close(() => resolve())); f.store.close();
});

test("Workbench acceptance polling skips overlap and isolates adapter failures", async () => {
  const f = await fixture(); let ticks = 0; const server = new LocalWorkbenchServer(f.service, "timer-token", { acceptanceTick: async () => { ticks += 1; await new Promise((resolve) => setTimeout(resolve, 650)); throw new Error("isolated"); } });
  await server.start(0); await new Promise((resolve) => setTimeout(resolve, 1_250)); await server.close(); assert.equal(ticks, 1); f.store.close();
});

test("Workbench exposes governed resume, fabric, studio, and model routes", async () => {
  const f = await fixture(); const app = new WorkbenchWebApp(f.service, "route-token", "http://127.0.0.1:4173");
  try {
    const request = (method: "GET" | "POST", path: string, body?: string) => app.handle({ method, path, token: "route-token", origin: "http://127.0.0.1:4173", body });
    assert.equal(request("POST", "/api/verified-work-loops/missing/resume", "{}").status, 422);
    assert.equal(request("GET", "/api/execution-fabrics/missing").status, 422);
    assert.equal(request("GET", "/api/work-launches/missing").status, 422);
    assert.equal(request("GET", "/api/workbench/summary").status, 200);
    assert.equal(request("GET", "/api/workbench/resources?kind=skills&limit=1").status, 200);
    assert.equal(request("POST", "/api/workbench/plugins", JSON.stringify({ manifest: { name: "demo", version: "1" } })).status, 201);
    assert.equal(request("POST", "/api/workbench/skills", JSON.stringify({ name: "skill", content: "Use evidence." })).status, 201);
    assert.equal(request("POST", "/api/workbench/memory", JSON.stringify({ content: "temporary" })).status, 201);
    assert.equal(request("POST", "/api/workbench/knowledge/claims", JSON.stringify({ kind: "fact", content: "fact" })).status, 201);
    assert.equal(request("POST", "/api/workbench/workflows", JSON.stringify({ name: "workflow" })).status, 201);
    assert.equal(request("GET", "/api/models").status, 200);
    assert.equal(request("GET", "/api/model-profiles").status, 200);
    assert.equal(request("GET", "/api/home?limit=bad").status, 200);
    assert.equal(request("GET", "/api/home?limit=1").status, 200);
    assert.ok([404, 422].includes(request("GET", "/api/project-brain").status));
    assert.equal(request("GET", "/api/project-brain?project_id=p&limit=1").status, 422);
    assert.equal(request("GET", "/api/workbench-experience?project_id=p&task_id=t&limit=1").status, 200);
    assert.equal(request("GET", "/api/traces?task_id=t&event_kind=x&limit=1").status, 200);
    assert.equal(request("GET", "/api/long-task-checkpoints?session_id=s&limit=1").status, 200);
    assert.equal(request("GET", "/api/workbench/resources?kind=memory&task_id=t&limit=1").status, 200);
    assert.equal(request("POST", "/api/workbench/memory/review", JSON.stringify({ candidate_id: "missing", decision: "reject", reviewer: "r", reason: "x" })).status, 422);
    assert.equal(request("POST", "/api/workbench/knowledge/claims", JSON.stringify({ kind: "fact", content: "fact", evidence_ids: [] })).status, 422);
    assert.equal(request("POST", "/api/workbench/workflows", JSON.stringify({ name: "workflow", steps: [{ id: "s" }] })).status, 201);
    assert.equal(request("POST", "/api/workbench/call", JSON.stringify({})).status, 404);
  } finally { f.store.close(); }
});

test("the object rail serves the plan's screen, and L3 hatches exactly one object", async () => {
  const f = await fixture();
  try {
    const app = new WorkbenchWebApp(f.service, "s", "http://127.0.0.1");
    const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "s",
      origin: "http://127.0.0.1", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, any>;

    // An empty store still renders a rail and a null focus rather than an error.
    assert.deepEqual(json(call("GET", "/api/objects")).focus, null);
    assert.equal(call("POST", "/api/objects/authorize", { effect_id: "e", effect_kind: "k", actor: "u",
      authorized_at: "2030-01-01T00:00:00Z", risk_level: "R2" }).status, 422);

    // 5.3: one expressed intention hatches exactly one human-originated object.
    const hatched = call("POST", "/api/objects/hatch", { session_id: "h1", intention: "评估迁移序列化库",
      object_kind: "migration", hatched_at: "2030-01-01T00:00:00Z" });
    assert.equal(hatched.status, 201);
    const hatchedBody = json(hatched);
    assert.equal(hatchedBody.object.origin, "human");
    assert.equal(hatchedBody.session_closed, true);
    // Zero conversation turns is what keeps the entrance narrow rather than a chat box.
    assert.equal(hatchedBody.conversation_turns_allowed, 0);
    const objectId = String(hatchedBody.object.id);

    // The session is closed by hatching, so it cannot produce a second object.
    const again = call("POST", "/api/objects/hatch", { session_id: "h1", intention: "再来一个",
      object_kind: "migration", hatched_at: "2030-01-01T00:01:00Z" });
    assert.equal(again.status, 422);

    // The object is now on the rail, in progress and unmarked.
    const rail = json(call("GET", "/api/objects"));
    assert.equal(rail.rail.length, 1);
    assert.equal(rail.focus.id, objectId);
    assert.equal(rail.counts.needs_you, 0);

    // An open adjudication moves it into "needs you" and onto the centre as one card.
    f.service.adjudicationEnqueue({ item_id: objectId, item_kind: "contract", decision_kind: "interface_change",
      priority: 70, summary: "confirm" });
    const needing = json(call("GET", "/api/objects"));
    assert.equal(needing.counts.needs_you, 1);
    assert.equal(needing.focus.adjudication.summary, "confirm");

    // 5.3's structured exit: named fields only, and only the ones that were asked for.
    assert.deepEqual(json(call("POST", "/api/objects/request-fields", { object_id: objectId, fields: ["target"] })).requested_fields, ["target"]);
    assert.equal(call("POST", "/api/objects/complete-fields", { object_id: objectId, values: { unasked: "prose" } }).status, 422);
    assert.equal(json(call("POST", "/api/objects/complete-fields", { object_id: objectId, values: { target: "jackson" } })).object.state, "ready");

    // Receipts answer for the right column, and 11.4 keeps the two acts separate.
    assert.equal(call("GET", `/api/objects/receipts?object_id=${encodeURIComponent(objectId)}`).status, 200);
    // An authorization must bind a digest, so omitting the effect descriptor is refused
    // rather than recorded against an unknown payload.
    assert.equal(call("POST", "/api/objects/authorize", { effect_id: objectId, effect_kind: "adjudication_effect",
      actor: "u", authorized_at: "2030-01-01T00:10:00Z", risk_level: "R2", decision_reason: "reviewed" }).status, 422);
    assert.equal(json(call("POST", "/api/objects/authorize", { effect_id: objectId, effect_kind: "adjudication_effect",
      actor: "u", authorized_at: "2030-01-01T00:10:00Z", risk_level: "R2", decision_reason: "reviewed",
      effect: { effect_id: objectId, summary: "confirm" } })).authorization.approved_by, "u");
    assert.equal(json(call("POST", "/api/objects/acknowledge", { card_id: "c1", actor: "u",
      acknowledged_at: "2030-01-01T00:11:00Z" })).acknowledgement.authorizes_effect, false);

    // The new routes are behind the same token and origin gate as every other one.
    assert.equal(app.handle({ method: "GET", path: "/api/objects" }).status, 401);
    assert.equal(app.handle({ method: "GET", path: "/api/objects", token: "s", origin: "https://evil.example" }).status, 403);
  } finally { f.store.close(); }
});

test("the subscription page exposes a time-boxed, scoped, revocable authorization", async () => {
  const f = await fixture();
  try {
    const app = new WorkbenchWebApp(f.service, "s", "http://127.0.0.1");
    const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "s",
      origin: "http://127.0.0.1", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, any>;

    assert.deepEqual(json(call("GET", "/api/subscriptions")).subscriptions, []);
    assert.equal(call("GET", "/api/subscriptions/audit?subscription_id=missing").status, 422);

    // 7.1 rule 2: all four boundaries are required, so an incomplete grant is refused.
    assert.equal(call("POST", "/api/subscriptions/authorize", { subscription_id: "s1", trigger: { topic: "t" },
      allowed_actions: ["a"], max_risk_level: "R1", granted_at: "2030-01-01T00:00:00Z", granted_by: "u" }).status, 422);

    const created = call("POST", "/api/subscriptions/authorize", { subscription_id: "s1", trigger: { topic: "t" },
      allowed_actions: ["reconcile_offset"], max_risk_level: "R1", granted_at: "2030-01-01T00:00:00Z",
      expires_at: "2030-02-01T00:00:00Z", granted_by: "u" });
    assert.equal(created.status, 201);
    assert.equal(json(created).authorization.state, "active");

    // 7.1 rule 5: the subscription caps scope and risk, and does not exempt the gate.
    const within = json(call("GET", "/api/subscriptions/check?subscription_id=s1&action=reconcile_offset&risk_level=R1&now=2030-01-10T00:00:00Z"));
    assert.equal(within.allowed, true);
    assert.equal(within.action_gate_still_applies, true);
    assert.equal(json(call("GET", "/api/subscriptions/check?subscription_id=s1&action=drop_table&risk_level=R0&now=2030-01-10T00:00:00Z")).reason,
      "action_outside_subscription_scope");
    assert.equal(json(call("GET", "/api/subscriptions/check?subscription_id=s1&action=reconcile_offset&risk_level=R3&now=2030-01-10T00:00:00Z")).reason,
      "risk_above_subscription_ceiling");

    // 7.1 rule 4: expiry is honoured against the clock, and the listing shows it lapsed
    // before any sweep runs.
    assert.equal(json(call("GET", "/api/subscriptions/check?subscription_id=s1&action=reconcile_offset&risk_level=R0&now=2030-02-01T00:00:00Z")).reason,
      "subscription_expired");
    assert.equal(json(call("GET", "/api/subscriptions?now=2030-02-01T00:00:00Z")).subscriptions[0].expired, true);

    // Re-confirmation is the only way back and it keeps the previous deadline for review.
    const again = json(call("POST", "/api/subscriptions/reconfirm", { subscription_id: "s1",
      reconfirmed_at: "2030-02-05T00:00:00Z", expires_at: "2030-03-05T00:00:00Z", reconfirmed_by: "u" }));
    assert.equal(again.authorization.state, "active");
    assert.equal(again.authorization.previous_expires_at, "2030-02-01T00:00:00Z");

    // 7.1 rule 3: the audit reports the history.
    assert.equal(json(call("GET", "/api/subscriptions/audit?subscription_id=s1")).summary.confirmations, 1);

    // 7.1 rule 1: revocation is explicit and terminal.
    assert.equal(json(call("POST", "/api/subscriptions/revoke", { subscription_id: "s1", revoked_by: "u",
      revoked_at: "2030-02-06T00:00:00Z", revocation_reason: "no longer needed" })).revoked, true);
    assert.equal(json(call("GET", "/api/subscriptions/check?subscription_id=s1&action=reconcile_offset&risk_level=R0&now=2030-02-06T00:00:00Z")).reason,
      "subscription_revoked");

    assert.equal(app.handle({ method: "GET", path: "/api/subscriptions" }).status, 401);
  } finally { f.store.close(); }
});

test("the decision surface renders per decision type and refuses an unknown one", async () => {
  const f = await fixture();
  try {
    const app = new WorkbenchWebApp(f.service, "s", "http://127.0.0.1");
    const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "s",
      origin: "http://127.0.0.1", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, any>;

    // 9.1: six decision types, six shapes. The shape comes from the decision, so the same
    // object gets a different interface for a different question.
    const expected: Record<string, string> = { either_or: "comparison", threshold: "threshold_slider",
      multi_field_check: "diff_view", release: "release_summary", parameter_tuning: "inline_tuning",
      completion: "field_form" };
    assert.equal(json(call("GET", "/api/decisions/shapes")).shapes.length, 6);
    for (const [kind, renderer] of Object.entries(expected)) {
      const composed = json(call("GET", `/api/decisions?object_id=o1&decision_kind=${kind}&summary=decide`));
      assert.equal(composed.rendered, true, kind);
      assert.equal(composed.control.renderer, renderer, kind);
    }

    // Falling back to a generic form is the schema mapping returning through the back door.
    const unknown = call("GET", "/api/decisions?object_id=o1&decision_kind=whatever&summary=s");
    assert.equal(unknown.status, 422);
    assert.match(json(unknown).error, /not registered/);

    // 9.2 as an executable rule: a card needing vertical scrolling is a deliverable file.
    const bloated = json(call("POST", "/api/decisions/compose", { object_id: "o1", decision_kind: "multi_field_check",
      summary: "review", fields: Array.from({ length: 14 }, (_, index) => ({ name: `f${index}`, label: `f${index}`, value_kind: "text" })) }));
    assert.equal(bloated.rendered, false);
    assert.equal(bloated.reason, "exceeds_scan_budget");
    assert.equal(bloated.is_deliverable_not_control, true);

    // 9.3: anchors are fixed with the surface and the generated part is discardable.
    const composed = json(call("POST", "/api/decisions/compose", { object_id: "o1", decision_kind: "either_or",
      summary: "pick", options: [{ id: "a", label: "keep" }, { id: "b", label: "drop" }] }));
    assert.deepEqual(composed.anchors.anchor_kinds, ["object", "history", "evidence", "ledger"]);
    assert.equal(json(call("GET", `/api/decisions/surface?surface_id=${encodeURIComponent(composed.surface_id)}`)).surface.generated, true);
    assert.equal(json(call("POST", "/api/decisions/discard", { surface_id: composed.surface_id })).surface.generated, false);
    assert.equal(call("GET", "/api/decisions/surface?surface_id=missing").status, 422);

    assert.equal(app.handle({ method: "GET", path: "/api/decisions/shapes" }).status, 401);
  } finally { f.store.close(); }
});

test("the capability base covers every access kind and makes the fallback debt countable", async () => {
  const f = await fixture();
  try {
    const app = new WorkbenchWebApp(f.service, "s", "http://127.0.0.1");
    const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "s",
      origin: "http://127.0.0.1", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, any>;
    const shape = { input: { node_id: "string" }, required_permission: ["ops.write"],
      receipt_format: { fields: ["pre_state", "post_state"], recomputable: true },
      risk_level: "R2", scope_invariants: ["cluster_id"] };

    // 13.1: the same shape covers an API-native action and a fallback script.
    assert.equal(call("POST", "/api/capabilities/register", { action_id: "restart_node", access_kind: "api_mcp",
      registered_at: "2030-01-01T00:00:00Z", ...shape }).status, 201);
    assert.equal(call("POST", "/api/capabilities/register", { action_id: "click_export", access_kind: "gui_automation",
      registered_at: "2030-01-01T00:00:00Z", ...shape }).status, 201);
    // 6.3: no stated invariant means the authorization can never be re-checked.
    assert.equal(call("POST", "/api/capabilities/register", { action_id: "bad", access_kind: "api_mcp",
      registered_at: "2030-01-01T00:00:00Z", ...shape, scope_invariants: [] }).status, 422);

    // The projection carries what the gate (6.1), the receipt (11.1) and 6.3 each read.
    const projected = json(call("GET", "/api/capabilities/base/restart_node"));
    assert.equal(projected.risk_level, "R2");
    assert.equal(projected.receipt_format.recomputable, true);
    assert.deepEqual(projected.scope_invariants, ["cluster_id"]);

    // 13A.7: the GUI fallback starts carrying the obligation and the replacement is recorded.
    assert.equal(json(call("GET", "/api/capabilities/debt")).gui_awaiting_replacement, 1);
    const replaced = json(call("POST", "/api/capabilities/replace-adapter", { action_id: "click_export",
      access_kind: "api_mcp", replaced_at: "2030-02-01T00:00:00Z", replaced_by: "u", reason: "api shipped" }));
    assert.equal(replaced.action.access_kind, "api_mcp");
    assert.equal(replaced.action.previous_access_kind, "gui_automation");

    // The debt is a queryable number, not a feeling (13A.7 / 13.3).
    const debt = json(call("GET", "/api/capabilities/debt"));
    assert.equal(debt.total_actions, 2);
    assert.equal(debt.gui_fallback_count, 0);
    assert.equal(debt.replaced_count, 1);
    assert.equal(debt.scale, "fallback");
    assert.equal(json(call("GET", "/api/capabilities/base?access_kind=api_mcp")).actions.length, 2);
    assert.equal(app.handle({ method: "GET", path: "/api/capabilities/debt" }).status, 401);
  } finally { f.store.close(); }
});

test("browser driving follows the corrected formula and refuses self-certifying scripts", async () => {
  const f = await fixture();
  try {
    const app = new WorkbenchWebApp(f.service, "s", "http://127.0.0.1");
    const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "s",
      origin: "http://127.0.0.1", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, any>;
    const assertions = [{ selector: "#confirm-step", state: "present" }];
    const mk = (id: string, operation: string) => call("POST", "/api/driving/scripts", { script_id: id, site_id: "portal",
      operation, assertions, script_body: "await page.waitForSelector('#success-badge')" });

    assert.equal(call("POST", "/api/driving/sites", { site_id: "portal",
      allowed_operations: ["navigate", "fill", "click", "production_change"], bypass_checker: "ssh_node_probe" }).status, 201);
    for (const [id, operation] of [["nav", "navigate"], ["fill", "fill"], ["click", "click"], ["prod", "production_change"]] as const) {
      assert.equal(mk(id, operation).status, 201);
    }

    // 13A.3's two corrections: R1 never reaches L1 even with a bypass check, and R3 needs the
    // approval chain even with one. Only R0 plus an independent check is unattended.
    assert.equal(json(call("GET", "/api/driving/adjudicate?script_id=nav")).outcome, "L1");
    const r1 = json(call("GET", "/api/driving/adjudicate?script_id=fill"));
    assert.equal(r1.risk_level, "R1");
    assert.equal(r1.outcome, "L2_prepare_release");
    const r3 = json(call("GET", "/api/driving/adjudicate?script_id=prod"));
    assert.equal(r3.outcome, "L2_prepare_release_with_approval_chain");
    assert.equal(r3.approval_chain_required, true);
    assert.equal(r3.has_bypass_check, true);
    // 13A.2.1: the core still does not drive.
    assert.equal(r3.adapter_required, true);
    assert.equal(r3.execution_authority, false);

    // 13A.4 and 13A.6 rule 2, refused by name.
    assert.equal(call("POST", "/api/driving/scripts", { script_id: "v", site_id: "portal", operation: "click",
      assertions, script_body: "await find_by_vision(img)" }).status, 422);
    assert.equal(call("POST", "/api/driving/scripts", { script_id: "w", site_id: "portal", operation: "click",
      assertions, script_body: "await page.waitForTimeout(3000)" }).status, 422);
    assert.equal(call("POST", "/api/driving/scripts", { script_id: "na", site_id: "portal", operation: "click",
      assertions: [], script_body: "await page.click('#x')" }).status, 422);

    // 13A.6 rule 4: the receipt carries an independent confirmation, and a page's own word
    // cannot stand in for one.
    const receipt = json(call("POST", "/api/driving/receipts", { script_id: "nav", target_url: "https://portal/eval3",
      dom_digest: "sha256:abc", bypass_result: { source: "ssh_node_probe", result: "offset_delay=0" } }));
    assert.equal(receipt.receipt.recomputable, true);
    assert.equal(receipt.receipt.page_claim_only, false);
    assert.equal(call("POST", "/api/driving/receipts", { script_id: "nav", target_url: "u", dom_digest: "d",
      bypass_result: { source: "page", result: "ok" } }).status, 422);

    assert.equal(json(call("GET", "/api/driving/surface")).l1_eligible, 1);
    assert.equal(app.handle({ method: "GET", path: "/api/driving/surface" }).status, 401);
  } finally { f.store.close(); }
});

test("routing has three outcomes, the L1 ratio is paired, and ledger wording stays honest", async () => {
  const f = await fixture();
  try {
    const app = new WorkbenchWebApp(f.service, "s", "http://127.0.0.1");
    const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "s",
      origin: "http://127.0.0.1", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, any>;

    // 4.4: a provable action is not turned into a question; a finite set becomes a choice; only
    // the case with neither free expression reaches L3.
    assert.equal(json(call("GET", "/api/claims/route?subject=s&can_self_certify=true&risk_level=R0")).outcome, "L1");
    const options = json(call("GET", "/api/claims/route?subject=s&risk_level=R1&options_enumerable=true&option_count=3"));
    assert.equal(options.outcome, "L2_options");
    assert.equal(options.input_form, "choose_from_set");
    const l3 = json(call("GET", "/api/claims/route?subject=s&risk_level=R1"));
    assert.equal(l3.outcome, "L3_hatch");
    assert.equal(l3.l3_is_the_scarce_resource, true);
    // An object already present means its structured completion, not free expression.
    assert.equal(json(call("GET", "/api/claims/route?subject=s&risk_level=R1&has_object=true")).outcome, "L2_options");
    // One option is a statement, not a choice.
    assert.equal(call("GET", "/api/claims/route?subject=s&risk_level=R1&options_enumerable=true&option_count=1").status, 422);

    // 4.6: the ratio is never available without the checker count, and an empty set reports
    // null rather than a misleading zero.
    const empty = json(call("GET", "/api/claims/l1-report"));
    assert.equal(empty.l1_ratio, null);
    assert.equal(empty.ratio_requires_checker_count, true);
    assert.equal(call("POST", "/api/claims/record", { subject: "a", risk_level: "R0", can_self_certify: true,
      recorded_at: "2030-01-01T00:00:00Z" }).status, 201);
    const report = json(call("GET", "/api/claims/l1-report"));
    assert.equal(report.l1_count, 1);
    assert.equal(report.l1_ratio, 1);
    assert.equal(report.deterministic_checkers, 0);

    // 11.3: the accurate sentence is served, and an overpromise is refused rather than stored.
    assert.match(String(json(call("GET", "/api/claims/ledger-wording")).accurate_wording), /追加写/u);
    const bad = json(call("GET", `/api/claims/ledger-wording?claim=${encodeURIComponent("本系统账本不可篡改")}`));
    assert.equal(bad.claim_allowed, false);
    assert.match(String(bad.rejected_reason), /in-place rewrite path/u);
    assert.equal(app.handle({ method: "GET", path: "/api/claims/l1-report" }).status, 401);
  } finally { f.store.close(); }
});

test("an object carries nine fields, a checkable state, and the card's conclusion", async () => {
  const f = await fixture();
  try {
    const app = new WorkbenchWebApp(f.service, "s", "http://127.0.0.1");
    const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "s",
      origin: "http://127.0.0.1", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, any>;

    assert.equal(call("POST", "/api/objects/model/kinds", { kind: "migration", initial_state: "hatched",
      states: { hatched: { target_framework: ["fastjson", "jackson"] },
        ready: { target_framework: ["fastjson", "jackson"], rollback_plan: ["flag"] } },
      allowed_actions: ["request_field", "release"] }).status, 201);
    // Redefining a kind would reinterpret existing objects, so it is refused.
    assert.equal(call("POST", "/api/objects/model/kinds", { kind: "migration", initial_state: "hatched",
      states: { hatched: { a: ["x"] } } }).status, 422);

    const created = json(call("POST", "/api/objects/model", { id: "migration_abc", kind: "migration",
      origin: "human", pending: ["card-1"], created_at: "2030-01-01T00:00:00Z" }));
    // 5.1's nine fields, all present at birth.
    for (const field of ["id", "kind", "state", "history", "evidence", "pending", "actions", "subscriptions", "origin"]) {
      assert.ok(field in created.object, `missing ${field}`);
    }
    assert.deepEqual(created.object.actions, ["request_field", "release"]);

    // 5.1's state test, applied: a declared domain with no value is unmeasurable, and the domain
    // is reported so the reader can see what was expected.
    const checked = json(call("GET", "/api/objects/model/migration_abc/state"));
    assert.equal(checked.measurable, false);
    assert.deepEqual(checked.missing_fields, ["target_framework"]);
    assert.deepEqual(checked.declared_domains.target_framework, ["fastjson", "jackson"]);
    assert.equal(checked.rejects_unmeasurable_descriptions, true);

    // 5.1's history: who acted, when, and on what basis.
    const moved = json(call("POST", "/api/objects/model/transition", { object_id: "migration_abc", state: "ready",
      actor: "u1", basis: "target confirmed", at: "2030-01-02T00:00:00Z" }));
    assert.equal(moved.object.state_revision, 1);
    assert.equal(moved.object.history[0].actor, "u1");
    assert.equal(typeof moved.object.history[0].basis_digest, "string");
    // The revision guard stops a stale writer.
    assert.equal(call("POST", "/api/objects/model/transition", { object_id: "migration_abc", state: "hatched",
      actor: "u2", basis: "stale", at: "2030-01-03T00:00:00Z", expected_revision: 0 }).status, 422);

    // 5.2.1: the card is short-lived, the conclusion is not.
    const decided = json(call("POST", "/api/objects/model/decision", { object_id: "migration_abc", card_id: "card-1",
      conclusion: "approved", actor: "u1", at: "2030-01-04T00:00:00Z", basis: "reviewed prepared state" }));
    assert.equal(decided.object.history.at(-1).conclusion, "approved");
    assert.equal(decided.object.history.at(-1).card_id, "card-1");
    assert.deepEqual(decided.object.pending, []);
    assert.equal(json(call("GET", "/api/objects/model/migration_abc/history")).events.length, 3);
    assert.equal(json(call("GET", "/api/objects/model/completeness")).complete, 1);
    assert.equal(app.handle({ method: "GET", path: "/api/objects/model" }).status, 401);
  } finally { f.store.close(); }
});
