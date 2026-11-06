import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService, VERSION } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { LocalWorkbenchServer, WorkbenchWebApp } from "../core/workbench-server.ts";
import { McpServer } from "../core/mcp.ts";
import { attachVerifiedPromotionFixture } from "./helpers/knowledge-promotion-proof.ts";

test("Workbench exposes the correction queue and its adjudication over HTTP", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  f.store.create("context_correction_task", "corr-http", { status: "pending_review", outcome: "incorrect",
    asset_ref: { member: "experience", id: "proc-1" } });
  const listed = app.handle({ method: "GET", path: "/api/workbench/context-corrections?status=pending_review", token: "secret" });
  assert.equal(listed.status, 200);
  const corrections = JSON.parse(listed.body).corrections as JsonObject[];
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0]!.id, "corr-http");
  // Deciding is an explicit write with a bounded, known decision set.
  assert.equal(app.handle({ method: "POST", path: "/api/workbench/context-corrections/decide", token: "secret",
    body: JSON.stringify({ task_id: "corr-http", decision: "maybe" }) }).status, 422);
  const decided = app.handle({ method: "POST", path: "/api/workbench/context-corrections/decide", token: "secret",
    body: JSON.stringify({ task_id: "corr-http", decision: "dismissed" }) });
  assert.equal(decided.status, 200);
  assert.equal(JSON.parse(decided.body).correction.status, "dismissed");
  // A dismissed correction leaves the pending queue.
  const after = JSON.parse(app.handle({ method: "GET", path: "/api/workbench/context-corrections?status=pending_review", token: "secret" }).body);
  assert.equal((after.corrections as JsonObject[]).length, 0);
  // The audit view still shows the resolved decision over the same route.
  const decidedList = JSON.parse(app.handle({ method: "GET", path: "/api/workbench/context-corrections?status=decided", token: "secret" }).body);
  assert.equal((decidedList.corrections as JsonObject[]).length, 1);
  assert.equal((decidedList.corrections as JsonObject[])[0]!.status, "dismissed");
});

async function fixture(transport?: { complete: (spec: never, request: never) => Promise<{ text: string; model: string; usage: JsonObject }> }) {
  const root = await mkdtemp(path.join(tmpdir(), "craft-web-")); const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, transport as never);
  return { store, service };
}

test("Workbench web application exposes a token-gated same-origin API and bounded JSON actions", async () => {
  const f = await fixture(); const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  assert.deepEqual(app.handle({ method: "GET", path: "/" }), app.handle({ method: "GET", path: "/workbench" })); assert.deepEqual(JSON.parse(app.handle({ method: "GET", path: "/health" }).body), { status: "ok", version: VERSION });
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
  const knowledgeClaim = f.service.knowledgeClaimSave({ claim_id: "knowledge-claim", kind: "fact", content: "Use only checked launch facts.", scope: "global", evidence_ids: [knowledgeEvidence.id] }).claim as Record<string, unknown>;
  attachVerifiedPromotionFixture(f.store, f.store.get("knowledge_claim", "knowledge-claim"));
  assert.equal(app.handle({ method: "POST", path: "/api/knowledge/claims/knowledge-claim/review", token: "secret", body: JSON.stringify({ status: "reviewed", reviewer: "reviewer", reason: "checked" }) }).status, 422);
  const page = (await f.service.wikiPageSave({ page_id: "knowledge-page", title: "Launch facts", body: "# Checked facts\n\nUse only checked launch facts.", claim_ids: [knowledgeClaim.id] })).page as Record<string, unknown>;
  assert.match(JSON.parse(app.handle({ method: "GET", path: "/api/knowledge/pages/knowledge-page?version=1", token: "secret" }).body).body, /Checked facts/); assert.match(JSON.parse(app.handle({ method: "GET", path: "/api/knowledge/pages/knowledge-page", token: "secret" }).body).body, /Checked facts/); assert.equal(app.handle({ method: "POST", path: "/api/knowledge/pages/knowledge-page/refresh", token: "secret", body: "{}" }).status, 200); assert.equal(app.handle({ method: "POST", path: "/api/knowledge/pages/knowledge-page", token: "secret", body: "{}" }).status, 404);
  const bundle = f.service.wikiContextCompile({ bundle_id: "knowledge-bundle", query: "checked launch facts", max_items: 2, max_chars: 1000 }).bundle as Record<string, unknown>;
  const knowledgeView = JSON.parse(app.handle({ method: "GET", path: "/api/knowledge?limit=1", token: "secret" }).body); assert.equal(knowledgeView.summary.claims, 1); assert.equal(knowledgeView.pages[0].id, page.id); assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/knowledge", token: "secret" }).body).summary.pages, 1);
  const previewResponse = app.handle({ method: "GET", path: `/api/knowledge/bundles/${bundle.id}/preview?version=${bundle.version}`, token: "secret" });
  assert.equal(previewResponse.status, 200, previewResponse.body);
  assert.match(JSON.parse(previewResponse.body).prompt, /checked launch facts/); assert.match(JSON.parse(app.handle({ method: "GET", path: `/api/knowledge/bundles/${bundle.id}/preview`, token: "secret" }).body).prompt, /checked launch facts/); assert.match(f.service.knowledgeContextBundlePreview({ bundle_id: bundle.id, bundle_version: bundle.version, now: "2026-09-11T00:00:00.000Z" }).prompt as string, /checked launch facts/); assert.equal(app.handle({ method: "GET", path: `/api/knowledge/bundles/${bundle.id}`, token: "secret" }).status, 404); assert.equal(app.handle({ method: "POST", path: "/api/knowledge/claims/knowledge-claim", token: "secret", body: "{}" }).status, 404);
  const knowledgeLaunch = JSON.parse(app.handle({ method: "POST", path: "/api/knowledge-work-launches", token: "secret", body: JSON.stringify({ launch_id: "knowledge-web", task_id: taskId, host: "codex-cli", workspace: f.store.paths.root, sandbox: "workspace-write", prompt: "Use facts", bundle_id: bundle.id, bundle_version: bundle.version }) }).body).launch;
  assert.equal(knowledgeLaunch.knowledge_binding.bundle_id, bundle.id); assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/knowledge-work-launches/knowledge-web?after=0", token: "secret" }).body).launch.id, "knowledge-web"); assert.equal(JSON.parse(app.handle({ method: "GET", path: "/api/knowledge-work-launches/knowledge-web", token: "secret" }).body).launch.id, "knowledge-web"); assert.equal(app.handle({ method: "POST", path: "/api/knowledge-work-launches/knowledge-web", token: "secret", body: "{}" }).status, 404);
  assert.equal(JSON.parse(app.handle({ method: "POST", path: "/api/knowledge-work-launches/knowledge-web/decide", token: "secret", body: JSON.stringify({ actor: "reviewer", approved: false, prompt: "Use facts" }) }).body).launch.status, "denied");
  f.store.save("work_launch", "knowledge-web", { ...knowledgeLaunch, status: "cancelled" }); assert.equal(app.handle({ method: "POST", path: "/api/knowledge-work-launches/knowledge-web/retry", token: "secret", body: JSON.stringify({ new_launch_id: "knowledge-web-retry", prompt: "Retry facts" }) }).status, 201);
  f.store.create("knowledge_claim", "missing-claim", { scope: "global", status: "candidate", content_digest: "sha256:missing-target" });
  f.store.create("knowledge_relation", "missing-target", { scope: "global", relation: "contradicts", from_claim_id: "knowledge-claim", to_claim_id: "missing-claim" }); f.store.create("knowledge_relation", "missing-source", { scope: "global", relation: "contradicts", from_claim_id: "missing-claim", to_claim_id: "knowledge-claim" });
  f.store.remove("knowledge_claim", "missing-claim");
  f.store.create("wiki_skill_candidate", "knowledge-candidate", { scope: "global", name: "Candidate", status: "candidate", source_page_ids: [page.id], evaluation_run_ids: [] }); f.store.create("knowledge_evaluation_run", "knowledge-evaluation", { scope: "global", suite_id: "suite", split: "held_out", status: "eligible", summary: {} });
  const fullKnowledge = f.service.knowledgeWorkbenchView() as { conflicts: unknown[]; knowledge_bound_launches: unknown[]; candidates: Array<Record<string, unknown>>; evaluations: Array<Record<string, unknown>> }; assert.equal(fullKnowledge.conflicts.length, 2); assert.equal(fullKnowledge.knowledge_bound_launches.length >= 1, true); assert.equal(fullKnowledge.candidates[0].id, "knowledge-candidate"); assert.equal(fullKnowledge.evaluations[0].id, "knowledge-evaluation"); assert.throws(() => f.service.knowledgeWorkbenchView({ limit: 0 }), /limit/); assert.throws(() => f.service.knowledgeWorkbenchView({ limit: 101 }), /limit/);
  const mcp = new McpServer(f.service, "full"); assert.equal(((await mcp.handle({ id: "knowledge-view", method: "tools/call", params: { name: "craft_knowledge_workbench_view", arguments: {} } }))?.result as Record<string, unknown>).isError, false); assert.equal(((await mcp.handle({ id: "knowledge-preview", method: "tools/call", params: { name: "craft_knowledge_context_bundle_preview", arguments: { bundle_id: bundle.id } } }))?.result as Record<string, unknown>).isError, false);
  assert.equal(app.handle({ method: "DELETE", path: "/api/nope", token: "secret" }).status, 404);
  f.service.attentionRefresh = (() => { throw "failure"; }) as typeof f.service.attentionRefresh; assert.equal(JSON.parse(app.handle({ method: "POST", path: "/api/inbox/refresh", token: "secret", body: "{}" }).body).error, "failure"); f.store.close();
});

test("local Workbench server binds loopback, serves headers, handles bodies, and owns its lifecycle", async (t) => {
  const f = await fixture(); const server = new LocalWorkbenchServer(f.service, "network-token");
  t.after(async () => { try { await server.close(); } finally { f.store.close(); } });
  const started = await server.start(0); const origin = started.url.split("/#")[0];
  assert.equal(started.token, "network-token"); assert.equal((await fetch(`${origin}/`)).status, 404); const health = await fetch(`${origin}/health`); assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${origin}/api/home`, { headers: { authorization: "Basic x" } })).status, 401);
  assert.equal((await fetch(`${origin}/api/home`, { headers: { authorization: "Bearer network-token" } })).status, 200);
  for (const route of ["/api/project-brain?project_id=local&limit=1", "/api/workbench-experience?project_id=local&task_id=t&limit=1", "/api/traces?task_id=t&event_kind=x&limit=1", "/api/long-task-checkpoints?session_id=s&limit=1", "/api/workbench/resources?kind=memory&task_id=t&limit=1"]) {
    assert.equal((await fetch(`${origin}${route}`, { headers: { authorization: "Bearer network-token" } })).status < 500, true);
  }
  assert.equal((await fetch(`${origin}/api/inbox/refresh`, { method: "POST", headers: { authorization: "Bearer network-token", origin }, body: "{}" })).status, 200);
  assert.equal((await fetch(`${origin}/api/inbox/refresh`, { method: "POST", headers: { authorization: "Bearer network-token" }, body: "x".repeat(66_000) })).status, 413);
  await assert.rejects(() => server.start(0), /already running/); await server.close(); await server.close();
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

test("Workbench reconciles active Pilot sessions in the server heartbeat", async () => {
  const f = await fixture(); let ticks = 0;
  const server = new LocalWorkbenchServer(f.service, "pilot-timer-token", {
    acceptanceTick: async () => ({}),
    pilotTick: () => { ticks += 1; return f.service.pilotReconcileAll(); },
  });
  await server.start(0);
  await new Promise((resolve) => setTimeout(resolve, 2_250));
  await server.close();
  assert.ok(ticks >= 1);
  assert.equal(ticks, 1, "a settled synchronous tick must not overlap itself");
  f.store.close();
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
    assert.equal(request("POST", "/api/workbench/knowledge/claims", JSON.stringify({ kind: "fact", content: "fact", scope: "global" })).status, 201);
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
    assert.equal(request("POST", "/api/workbench/knowledge/claims", JSON.stringify({ kind: "fact", content: "fact", scope: "global" })).status, 201);
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

test("Workbench exposes the native tool catalog and a token-gated trial call", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const catalog = JSON.parse(app.handle({ method: "GET", path: "/api/workbench/native-tools", token: "secret" }).body);
  assert.ok(catalog.tools.some((tool: { name: string }) => tool.name === "desktop_action"));
  assert.deepEqual(JSON.parse(app.handle({ method: "GET", path: "/api/action-gate/rules/all", token: "secret" }).body).rules, []);
  assert.deepEqual(JSON.parse(app.handle({ method: "GET", path: "/api/subscription-drift", token: "secret" }).body).subscriptions, []);
  const costs = JSON.parse(app.handle({ method: "GET", path: "/api/workbench/costs", token: "secret" }).body);
  assert.equal(Array.isArray(costs.capabilities), true);
  assert.ok(costs.token_totals === null || typeof costs.token_totals === "number");
  assert.deepEqual(JSON.parse(app.handle({ method: "GET", path: "/api/workbench/experience/procedures", token: "secret" }).body).procedures, []);
  const exportRejected = await app.handleAsync({ method: "POST", path: "/api/workbench/experience/procedures/export", token: "secret",
    origin: "http://127.0.0.1:4173", body: JSON.stringify({ procedure_id: "missing" }) });
  assert.equal(exportRejected.status, 422);
  f.store.create("task", "task", { title: "Trial", status: "active" });
  const listed = await app.handleAsync({ method: "POST", path: "/api/workbench/native-tools/call", token: "secret",
    origin: "http://127.0.0.1:4173", body: JSON.stringify({ tool: "workspace_list",
      args: { task_id: "task", workspace: f.store.paths.root, depth: 1, max_entries: 10 } }) });
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(JSON.parse(listed.body).result.entries));
  const unknown = await app.handleAsync({ method: "POST", path: "/api/workbench/native-tools/call", token: "secret",
    origin: "http://127.0.0.1:4173", body: JSON.stringify({ tool: "nope", args: {} }) });
  assert.equal(unknown.status, 422);
  const crossOrigin = await app.handleAsync({ method: "POST", path: "/api/workbench/native-tools/call", token: "secret",
    origin: "https://evil.example", body: "{}" });
  assert.equal(crossOrigin.status, 403);
});

test("Workbench uninstalls a plugin with what it created, and leaves anything else alone", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "remove-token", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: string) =>
    app.handle({ method, path, token: "remove-token", origin: "http://127.0.0.1:4173", body });
  const installed = JSON.parse(call("POST", "/api/workbench/plugins", JSON.stringify({ manifest: {
    name: "demo", version: "1", hosts: ["craft"],
    mcpServers: { probe: { command: "node", args: ["server.js"] } },
    skills: [{ name: "demo-skill", content: "Use evidence." }],
  } })).body).plugin as Record<string, unknown>;
  const adapterId = (installed.mapped_adapter_ids as string[])[0]!;
  const skillId = (installed.mapped_skill_ids as string[])[0]!;
  assert.ok(adapterId && skillId);
  assert.ok(f.store.find("adapter_manifest", adapterId));
  assert.ok(f.store.find("studio_skill", skillId));
  // The list a page renders must carry the version that page will send back.
  const listedPlugin = (JSON.parse(call("GET", "/api/workbench/plugins").body).items as Record<string, unknown>[])
    .find((item) => item.id === installed.id)!;
  assert.equal(listedPlugin.version, installed.version);
  // A caller holding a version it did not just read cannot delete a newer install.
  assert.equal(call("DELETE", `/api/workbench/plugins/${String(installed.id)}?version=${Number(installed.version) + 1}`).status, 422);
  assert.ok(f.store.find("studio_plugin", String(installed.id)));
  const removed = JSON.parse(call("DELETE", `/api/workbench/plugins/${String(installed.id)}`).body);
  assert.deepEqual(removed, { plugin_id: installed.id, removed: true, removed_adapters: [adapterId], kept_adapters: [],
    removed_skills: [skillId], kept_skills: [] });
  assert.equal(f.store.find("studio_plugin", String(installed.id)), null);
  assert.equal(f.store.find("adapter_manifest", adapterId), null);
  assert.equal(f.store.find("studio_skill", skillId), null);

  // An adapter or skill Craft did not learn from a plugin manifest is not ours to delete.
  f.service.adapterManifestSave({ adapter_id: "hand.made", version: "1", kind: "command", entry: "node" });
  f.store.create("studio_skill", "hand.skill", { name: "hand", content: "kept", source: "user_upload" });
  f.store.create("studio_plugin", "plugin-manual", { name: "manual", package_version: "1", hosts: ["craft"],
    target_hosts: ["craft"], mapped_adapter_ids: ["hand.made"], mapped_skill_ids: ["hand.skill"], status: "installed" });
  const manual = JSON.parse(call("DELETE", "/api/workbench/plugins/plugin-manual").body);
  assert.deepEqual(manual.kept_adapters, ["hand.made"]); assert.deepEqual(manual.kept_skills, ["hand.skill"]);
  assert.equal(manual.removed_adapters.length, 0); assert.equal(manual.removed_skills.length, 0);
  assert.ok(f.store.find("adapter_manifest", "hand.made")); assert.ok(f.store.find("studio_skill", "hand.skill"));
  assert.equal(f.store.find("studio_plugin", "plugin-manual"), null);
  // Unknown plugins and nested paths are rejected instead of resolving oddly.
  assert.equal(call("DELETE", "/api/workbench/plugins/missing").status, 422);
  assert.equal(call("DELETE", "/api/workbench/plugins/a%2Fb").status, 404);
  f.store.close();
});

test("Workbench exposes workspace listing and non-destructive task workspace binding", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const { mkdir } = await import("node:fs/promises");
    const projectDir = path.join(f.store.paths.root, "workspace-one");
    await mkdir(projectDir, { recursive: true });
    const created = call("POST", "/api/tasks", { title: "Bound", goal: "group me", workspace: projectDir });
    assert.equal(created.status, 201);
    assert.equal(typeof JSON.parse(created.body).task.workspace_id, "string");
    const listed = call("GET", "/api/workspaces");
    assert.equal(listed.status, 200);
    const workspaces = JSON.parse(listed.body).workspaces as Array<{ id: string; root_path: string }>;
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]!.root_path, projectDir);
    const resolved = call("POST", "/api/workspaces/resolve-or-create", { root_path: projectDir });
    assert.equal(resolved.status, 200);
    assert.equal(JSON.parse(resolved.body).workspace.id, workspaces[0]!.id);
    const workspaceId = workspaces[0]!.id;
    const scoped = call("GET", `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks`);
    assert.equal(scoped.status, 200);
    assert.deepEqual((JSON.parse(scoped.body).tasks as Array<{ title: string }>).map((task) => task.title), ["Bound"]);
    // The backfill route defaults to dry-run and never mutates on its own.
    f.store.create("task", "legacy", { title: "Legacy", goal: "old", status: "active" });
    f.store.create("workbench_agent_session_link", "legacy-link", { task_id: "legacy", provider: "codex", native_session_id: "n", workspace: projectDir, permission: "ask", turn_state: "idle" });
    const dry = call("POST", "/api/workspaces/backfill", { dry_run: true });
    assert.equal(dry.status, 200);
    assert.equal(JSON.parse(dry.body).bound, 1);
    assert.equal(f.store.get("task", "legacy").workspace_id ?? null, null);
  } finally { f.store.close(); }
});

test("Workbench approval grants are exact, workspace-bound and revocable over HTTP", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const { mkdir } = await import("node:fs/promises");
    const dir = path.join(f.store.paths.root, "grant-repo"); await mkdir(dir, { recursive: true });
    const workspace = JSON.parse(call("POST", "/api/workspaces/resolve-or-create", { root_path: dir }).body).workspace as { id: string };
    const now = Date.now();
    const grant = call("POST", "/api/approval-grants", { workspace_id: workspace.id, action: "workspace_write", action_fingerprint: "sha256:abc",
      effect: "local_write", risk_level: "R2", policy_version: "policy-v1", granted_by: "human", expires_at: new Date(now + 3_600_000).toISOString() });
    assert.equal(grant.status, 201);
    const grantId = JSON.parse(grant.body).grant.id as string;
    assert.equal(call("GET", "/api/approval-grants?status=active").status, 200);
    assert.equal(JSON.parse(call("POST", "/api/approval-grants/check", { workspace_id: workspace.id, action: "workspace_write",
      action_fingerprint: "sha256:abc", effect: "local_write", risk_level: "R2", policy_version: "policy-v1" }).body).allowed, true);
    assert.equal(call("DELETE", `/api/approval-grants/${encodeURIComponent(grantId)}?revoked_by=${encodeURIComponent("user:bian")}&reason=${encodeURIComponent("范围扩大")}`).status, 200);
    // The HTTP surface must carry the human who ended the authorization, and the
    // listing is where a reader sees it.
    const listed = JSON.parse(call("GET", "/api/approval-grants?status=revoked").body).grants as JsonObject[];
    assert.equal(listed[0]?.revoked_by, "user:bian");
    assert.equal(listed[0]?.revoked_reason, "范围扩大");
    assert.equal(listed[0]?.granted_by, "human");
    assert.equal(JSON.parse(call("POST", "/api/approval-grants/check", { workspace_id: workspace.id, action: "workspace_write",
      action_fingerprint: "sha256:abc", effect: "local_write", risk_level: "R2", policy_version: "policy-v1" }).body).allowed, false);
  } finally { f.store.close(); }
});

test("Workbench exposes pilot session and route reassignment over HTTP", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const createdTask = call("POST", "/api/tasks", { title: "P", goal: "pilot" });
    const taskId = JSON.parse(createdTask.body).task.id as string;
    const opened = call("POST", "/api/pilot/sessions", { input: "split this", concurrency: 4 });
    assert.equal(opened.status, 201);
    const sessionId = JSON.parse(opened.body).session.id as string;
    assert.equal(call("GET", `/api/pilot/sessions/${encodeURIComponent(sessionId)}`).status, 200);
    const autoSession = JSON.parse(call("POST", "/api/pilot/sessions", { input: "deterministic split" }).body).session.id as string;
    const auto = call("POST", `/api/pilot/sessions/${encodeURIComponent(autoSession)}/turns/auto`, {
      input: "1. 整理需求\n2. 补齐设计", executor: "craft", executors: ["craft"],
    });
    assert.equal(auto.status, 201);
    assert.equal(JSON.parse(auto.body).tasks_created, 2);
    assert.equal(JSON.parse(auto.body).review.verdict, "pass");
    const status = call("GET", `/api/pilot/sessions/${encodeURIComponent(autoSession)}/status`);
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).progress.stage, "reviewed");
    assert.equal(call("POST", `/api/pilot/sessions/${encodeURIComponent(autoSession)}/review`).status, 201);
    const routed = call("POST", `/api/pilot/tasks/${encodeURIComponent(taskId)}/route`, { session_id: sessionId, executor_template: "craft-internal", reason: "local", confidence: 0.8 });
    assert.equal(routed.status, 201);
    const routeId = JSON.parse(routed.body).route.id as string;
    const reassigned = call("POST", `/api/pilot/routes/${encodeURIComponent(routeId)}/reassign`, { executor_template: "codex-cli", reason: "tool", confidence: 0.9 });
    assert.equal(reassigned.status, 200);
    assert.equal(JSON.parse(reassigned.body).route.executor_template, "codex-cli");
    assert.equal(call("GET", `/api/pilot/sessions/${encodeURIComponent(sessionId)}/queue`).status, 200);
    const scheduled = call("POST", `/api/pilot/sessions/${encodeURIComponent(sessionId)}/schedule`);
    assert.equal(scheduled.status, 200);
    assert.equal(JSON.parse(scheduled.body).running, 1);
    assert.equal(call("POST", `/api/pilot/routes/${encodeURIComponent(routeId)}/finish`).status, 200);
    // Supervise on a fresh route: create a second routed task and run the gate over it.
    call("POST", "/api/supervisor-profiles", { supervisor_profile_id: "sp", name: "S", deterministic_rules: [{ id: "r", condition: "ci_failed", action: "pause" }] });
    const t2 = JSON.parse(call("POST", "/api/tasks", { title: "Q", goal: "q" }).body).task.id as string;
    const r2 = JSON.parse(call("POST", `/api/pilot/tasks/${encodeURIComponent(t2)}/route`, { session_id: sessionId, executor_template: "e", reason: "r", confidence: 0.5 }).body).route.id as string;
    const superv = call("POST", `/api/pilot/routes/${encodeURIComponent(r2)}/supervise`, { supervisor_profile_id: "sp", signals: { ci_failed: true } });
    assert.equal(superv.status, 200);
    assert.equal(JSON.parse(superv.body).verdict, "pause");
    assert.equal(call("GET", "/api/capabilities/catalog").status, 200);
    assert.equal(call("GET", "/api/workbench/task-board").status, 200);
    assert.notEqual(JSON.parse(call("GET", "/api/workbench/task-board?limit=5").body).buckets.running, undefined);
    const ensured = await app.handleAsync({ method: "POST", path: "/api/capabilities/ensure", token: "secret", body: JSON.stringify({ capability_id: "memory" }) });
    assert.equal(ensured.status, 200);
    assert.equal(JSON.parse(ensured.body).loaded, true);
    const rejected = await app.handleAsync({ method: "POST", path: "/api/capabilities/ensure", token: "secret", body: JSON.stringify({ capability_id: "nope" }) });
    assert.equal(rejected.status, 422);
  } finally { f.store.close(); }
});

test("Workbench captures a completed delivery as an experience-seeded design draft over HTTP", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const task = JSON.parse(call("POST", "/api/tasks", { title: "HTTP 设计", goal: "设计一次接口" }).body).task;
    const trial = f.store.create("trial", "trial-http", { task_id: task.id, status: "completed" });
    const evidence = f.store.create("evidence", "ev-http", { confidence: "confirmed", claim: "接口设计完成", locator: "fixture://http" });
    f.store.create("outcome", "outcome-http", { trial_id: trial.id, verdict: "succeeded", summary: "交付了接口文档", evidence_ids: [evidence.id] });
    const captured = call("POST", "/api/workbench/workflow-designs/capture", { task_id: task.id, name: "接口设计复用", scenario_key: "api design" });
    assert.equal(captured.status, 201);
    const body = JSON.parse(captured.body);
    assert.equal(body.kind, "success");
    assert.equal(body.observation.content_free, true);
    assert.equal(body.design.lifecycle, "draft");
    assert.equal(body.design.routeable, false);
  } finally { f.store.close(); }
});

test("Workbench dispatches deterministic Pilot routes through an installed agent provider", async () => {
  const craftTransport = { complete: async () => ({ text: "done", model: "m1", usage: { input_tokens: 1, output_tokens: 1 } }) };
  const f = await fixture(craftTransport as never);
  const calls: string[] = [];
  let fail = false;
  const sessions = {
    create: async (options: { task_id: string }) => {
      calls.push("create:" + options.task_id);
      if (fail) throw new Error("CLI missing");
      return { link: { id: "link-1" } };
    },
    send: async (task: string, id: string) => { calls.push("send:" + task + ":" + id); return { accepted: true }; },
  } as never;
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173", { agentSessions: sessions });
  const call = (method: string, path: string, body?: unknown) => app.handleAsync({ method, path, token: "secret", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const { mkdir } = await import("node:fs/promises");
    const dir = path.join(f.store.paths.root, "pilot-worker"); await mkdir(dir, { recursive: true });
    const workspace = (f.service.workspaceResolveOrCreate({ root_path: dir }) as { workspace: { id: string } }).workspace;
    const opened = await call("POST", "/api/pilot/sessions", { input: "worker", workspace_id: workspace.id });
    const sessionId = JSON.parse(opened.body).session.id as string;
    assert.equal((await app.handleAsync({ method: "POST", path: `/api/workbench/pilot-sessions/${encodeURIComponent(sessionId)}/dispatch` })).status, 401);
    const auto = await call("POST", `/api/pilot/sessions/${encodeURIComponent(sessionId)}/turns/auto`, {
      input: "完成一项实现", executor: "codex", executors: ["codex"], workspace_id: workspace.id,
    });
    assert.equal(auto.status, 201);
    const dispatched = await call("POST", `/api/workbench/pilot-sessions/${encodeURIComponent(sessionId)}/dispatch`, { permission: "ask" });
    assert.equal(dispatched.status, 202);
    const body = JSON.parse(dispatched.body);
    assert.equal(body.workers.length, 1);
    assert.equal(body.workers[0].state, "started", JSON.stringify(body.workers[0]));
    assert.equal(body.workers[0].link_id, "link-1");
    assert.equal(body.status.progress.stage, "working");
    assert.deepEqual(calls.map((value) => value.split(":")[0]), ["create", "send"]);
    assert.equal((await call("POST", `/api/pilot/sessions/${encodeURIComponent(sessionId)}/reconcile`)).status, 200);

    await call("POST", `/api/pilot/sessions/${encodeURIComponent(sessionId)}/turns/auto`, {
      input: "第二项实现", executor: "codex", executors: ["codex"], workspace_id: workspace.id,
    });
    fail = true;
    const failed = await call("POST", `/api/workbench/pilot-sessions/${encodeURIComponent(sessionId)}/dispatch`, { permission: "ask" });
    assert.equal(failed.status, 202);
    const failedBody = JSON.parse(failed.body);
    assert.equal(failedBody.workers[0].state, "failed");
    assert.equal(failedBody.status.progress.stage, "needs_attention");
    // The failure leaves a trace a person can attribute; it does not invent a cause.
    const observations = JSON.parse((await call("GET", "/api/workbench/pilot/failure-observations")).body).items as JsonObject[];
    assert.ok(observations.length >= 1, "terminal failure is captured for attribution");
    assert.equal(observations[0].attributed, false);
    assert.equal(observations[0].failure_class, null);

    const craftSession = JSON.parse((await call("POST", "/api/pilot/sessions",
      { input: "craft worker", workspace_id: workspace.id })).body).session.id as string;
    const { saveSettingsSync } = await import("../core/settings.ts");
    saveSettingsSync({ models: [{ id: "m1", name: "M", protocol: "openai-compatible",
      baseUrl: "https://x.test/v1", model: "x", apiKeyEnv: "X_KEY", supportsTools: false }] }, f.store.paths);
    const craftAuto = await call("POST", `/api/pilot/sessions/${encodeURIComponent(craftSession)}/turns/auto`, {
      input: "交给 Craft", executor: "craft", executors: ["craft"], workspace_id: workspace.id,
    });
    assert.equal(craftAuto.status, 201);
    const craftDispatch = await call("POST",
      `/api/workbench/pilot-sessions/${encodeURIComponent(craftSession)}/dispatch`,
      { permission: "auto", craft_model: "m1" });
    assert.equal(craftDispatch.status, 202);
    assert.equal(JSON.parse(craftDispatch.body).workers[0].state, "completed", JSON.stringify(JSON.parse(craftDispatch.body).workers[0]));
  } finally { f.store.close(); }
});

test("Workbench routes a pilot model turn through intake validation over HTTP", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "craft-web-pilot-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const { saveSettingsSync } = await import("../core/settings.ts");
  saveSettingsSync({ models: [{ id: "m1", name: "M", protocol: "openai-compatible", baseUrl: "https://x.test/v1",
    model: "x", apiKeyEnv: "X_KEY", supportsTools: false }] }, store.paths);
  const transport = { complete: async () => ({ text: '{"tasks":[{"title":"A","goal":"a"},{"title":"B","goal":"b"}]}', model: "fake", usage: { input_tokens: 1, output_tokens: 1 } }) };
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, transport as never);
  const app = new WorkbenchWebApp(service, "secret", "http://127.0.0.1:4173");
  try {
    const session = JSON.parse(app.handle({ method: "POST", path: "/api/pilot/sessions", token: "secret", body: JSON.stringify({ input: "split" }) }).body).session;
    const result = await app.handleAsync({ method: "POST", path: `/api/pilot/sessions/${encodeURIComponent(session.id)}/turns/model`,
      token: "secret", body: JSON.stringify({ input: "do a and b", model_id: "m1" }) });
    assert.equal(result.status, 201);
    assert.equal(JSON.parse(result.body).tasks_created, 2);
  } finally { store.close(); }
});

test("Workbench exposes executor and supervisor templates over HTTP", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const exec = call("POST", "/api/executor-templates", { executor_template_id: "e1", name: "Local", provider: "craft", model: "m", permission: "auto" });
    assert.equal(exec.status, 201);
    assert.equal(call("GET", "/api/executor-templates").status, 200);
    assert.equal(call("GET", "/api/executor-templates/e1").status, 200);
    const sup = call("POST", "/api/supervisor-profiles", { supervisor_profile_id: "s1", name: "Default", deterministic_rules: [{ id: "r", condition: "x", action: "block" }] });
    assert.equal(sup.status, 201);
    assert.equal(call("GET", "/api/supervisor-profiles").status, 200);
    assert.equal(call("GET", "/api/supervisor-profiles/s1").status, 200);
  } finally { f.store.close(); }
});

test("Workbench serves plugin workbench pages and per-workspace plugin toggles over HTTP", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const pluginDir = path.join(f.store.paths.root, "plugin-dir");
    await mkdir(path.join(pluginDir, "workbench"), { recursive: true });
    await writeFile(path.join(pluginDir, "workbench", "p.page.json"), JSON.stringify({ type: "section", children: [{ type: "rows" }] }));
    const plugin = JSON.parse(call("POST", "/api/workbench/plugins", { plugin_root: pluginDir, manifest: { name: "demo", version: "1.0.0", hosts: ["craft"],
      workbench: { schemaVersion: 1, pages: [{ id: "p", title: "P", kind: "declarative", schema: "./workbench/p.page.json" }] } } }).body).plugin;
    assert.equal(call("GET", `/api/workbench/plugins/${encodeURIComponent(plugin.id)}/pages`).status, 200);
    const page = call("GET", `/api/workbench/plugins/${encodeURIComponent(plugin.id)}/pages/p`);
    assert.equal(page.status, 200);
    assert.equal(JSON.parse(page.body).schema.type, "section");
    const repo = path.join(f.store.paths.root, "ws"); await mkdir(repo, { recursive: true });
    const workspace = JSON.parse(call("POST", "/api/workspaces/resolve-or-create", { root_path: repo }).body).workspace;
    assert.equal(call("POST", `/api/workspaces/${encodeURIComponent(workspace.id)}/plugins/${encodeURIComponent(plugin.id)}/enable`).status, 200);
    const listed = call("GET", `/api/workspaces/${encodeURIComponent(workspace.id)}/plugins`);
    assert.equal(listed.status, 200);
    assert.equal(JSON.parse(listed.body).bindings[0].status, "enabled");
  } finally { f.store.close(); }
});

test("Workbench removes an uploaded skill and refuses one that belongs to a plugin", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "skill-token", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: string) =>
    app.handle({ method, path, token: "skill-token", origin: "http://127.0.0.1:4173", body });
  const uploaded = JSON.parse(call("POST", "/api/workbench/skills", JSON.stringify({ name: "local", content: "Use evidence." })).body).skill;
  const skillId = String(uploaded.id);
  assert.ok(f.store.find("studio_skill", skillId));
  // An upload is a person's edit; with nobody named it says unattributed.
  assert.equal(uploaded.edited_by, "unattributed");
  const signed = JSON.parse(call("POST", "/api/workbench/skills", JSON.stringify({ name: "signed", content: "Use evidence.", edited_by: "user:alex" })).body).skill;
  assert.equal(signed.edited_by, "user:alex");
  const skillItems = JSON.parse(call("GET", "/api/workbench/resources?kind=skills&limit=10").body).items as Array<Record<string, unknown>>;
  assert.ok(skillItems.some((item) => item.id === skillId));
  assert.deepEqual(JSON.parse(call("DELETE", `/api/workbench/skills/${skillId}`).body), { skill_id: skillId, removed: true });
  assert.equal(f.store.find("studio_skill", skillId), null);
  // A skill a plugin declared leaves with the plugin, not from this page.
  f.store.create("studio_skill", "plugin.skill", { name: "from plugin", content: "x", source: "plugin_manifest", status: "active" });
  assert.equal(call("DELETE", "/api/workbench/skills/plugin.skill").status, 422);
  assert.ok(f.store.find("studio_skill", "plugin.skill"));
  assert.equal(call("DELETE", "/api/workbench/skills/missing").status, 422);
  assert.equal(call("DELETE", "/api/workbench/skills/a%2Fb").status, 404);
  f.store.close();
});

test("Workbench lists and settles memory conflicts over HTTP, recording the actor", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  // Governed memory writes land in a project partition, so the project root has
  // to be registered before candidates can exist at all.
  f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:p", alias_kind: "path", alias: f.store.paths.root });
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const evidence = f.service.evidenceRecord({ evidence_id: "conflict-ev", source_type: "test", claim: "verified", confidence: "confirmed" }) as JsonObject;
  f.service.knowledgeSourceRegister({ source_id: "conflict-src", kind: "custom", label: "s", scope_kind: "project", scope_id: "p", locator: "local", content_digest: "d", trust: "bounded", access: "proposal_only" });
  f.service.memoryCandidatePropose({ candidate_id: "conf-a", source_id: "conflict-src", kind: "preference", scope_kind: "project", scope_id: "p", topic: "editor", content: "use spaces", evidence_ids: [evidence.id] });
  const second = f.service.memoryCandidatePropose({ candidate_id: "conf-b", source_id: "conflict-src", kind: "preference", scope_kind: "project", scope_id: "p", topic: "editor", content: "use tabs", evidence_ids: [evidence.id] }).candidate as JsonObject;
  assert.equal(second.status, "conflict_pending");
  const listed = JSON.parse(call("GET", "/api/workbench/memory/conflicts").body).conflicts as JsonObject[];
  assert.deepEqual(listed.map((item) => item.id).sort(), ["conf-a", "conf-b"]);
  // An unsigned settlement is refused rather than filed under a made-up name.
  assert.equal(call("POST", "/api/workbench/memory/conflicts/resolve", { candidate_id: "conf-b", resolution: "keep", reason: "newer" }).status, 422);
  assert.equal(call("POST", "/api/workbench/memory/conflicts/resolve", { candidate_id: "conf-b", resolution: "adopt", actor: "user:alex", reason: "x" }).status, 422);
  assert.equal(call("POST", "/api/workbench/memory/conflicts/resolve", { candidate_id: "conf-b", resolution: "keep", actor: "user:alex" }).status, 422);
  assert.equal(call("POST", "/api/workbench/memory/conflicts/resolve", { candidate_id: "conf-b", resolution: "keep", actor: "user:alex", reason: "这一条更新" }).status, 200);
  const stored = f.store.get("memory_candidate", "conf-b");
  assert.equal((stored.conflict_resolution as JsonObject).actor, "user:alex");
  assert.equal(typeof (stored.conflict_resolution as JsonObject).reason_digest, "string");
  // A settled conflict leaves the open queue.
  assert.equal((JSON.parse(call("GET", "/api/workbench/memory/conflicts").body).conflicts as JsonObject[]).length, 0);
});

test("Workbench retires a scoped claim under the named actor, never a stand-in identity", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  // Governed writes land in a project partition, so the project root is bound first.
  f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:retire", alias_kind: "path", alias: f.store.paths.root });
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const source = f.service.knowledgeSourceRegister({ source_id: "retire-src", kind: "custom", label: "s", scope_kind: "project", scope_id: "retire",
    locator: "local", content_digest: "d", trust: "bounded", access: "proposal_only" }) as JsonObject;
  const evidence = f.service.evidenceRecord({ evidence_id: "retire-ev", source_type: "test", claim: "checked", confidence: "confirmed" }) as JsonObject;
  const sourceId = (source.source as JsonObject).id;
  f.service.knowledgeClaimSave({ claim_id: "retire-claim", kind: "fact", content: "the repo uses pnpm", scope: "project:retire",
    source_id: sourceId, evidence_ids: [evidence.id] });
  assert.equal(call("POST", "/api/workbench/context-retire", { member: "knowledge", id: "retire-claim", expected_version: 1,
    scope_kind: "project", scope_id: "retire", actor: "user:alex" }).status, 200);
  const stored = f.store.get("knowledge_claim", "retire-claim");
  assert.equal(stored.status, "expired");
  assert.equal((stored.review as JsonObject).reviewer, "user:alex", "the reviewer is the named actor");
  // With no actor the record says unattributed rather than inventing a person.
  f.service.knowledgeClaimSave({ claim_id: "retire-claim-2", kind: "fact", content: "CI runs on merge", scope: "project:retire",
    source_id: sourceId, evidence_ids: [evidence.id] });
  assert.equal(call("POST", "/api/workbench/context-retire", { member: "knowledge", id: "retire-claim-2", expected_version: 1,
    scope_kind: "project", scope_id: "retire" }).status, 200);
  assert.equal((f.store.get("knowledge_claim", "retire-claim-2").review as JsonObject).reviewer, "unattributed");
  // A blank actor is refused instead of being silently replaced.
  assert.equal(call("POST", "/api/workbench/context-retire", { member: "knowledge", id: "retire-claim-2", expected_version: 2,
    scope_kind: "project", scope_id: "retire", actor: " " }).status, 422);
});

test("Workbench retires a live ledger memory only with a version and a named actor", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:ledger", alias_kind: "path", alias: f.store.paths.root });
  f.service.knowledgeSourceRegister({ source_id: "ledger-src", kind: "custom", label: "s", scope_kind: "project", scope_id: "ledger",
    locator: "local", content_digest: "d", trust: "bounded", access: "proposal_only" });
  f.service.memoryLedgerRemember({ memory_id: "live-1", kind: "preference", scope_kind: "project", scope_id: "ledger",
    project_root: f.store.paths.root, source_id: "ledger-src", content: "the repo uses pnpm" });
  const version = Number(f.store.get("memory_ledger", "live-1").version);
  // The page reads this row and echoes the version it saw.
  const row = (JSON.parse(call("GET", "/api/workbench/resources?kind=memory&limit=50").body).items as JsonObject[])
    .find((item) => item.id === "live-1")!;
  assert.equal(row.governed, true);
  assert.equal(row.version, version);
  // Unsigned, stale or malformed transitions are refused.
  assert.equal(call("POST", "/api/workbench/memory/ledger/transition", { memory_id: "live-1", status: "revoked", expected_version: version, reason: "r" }).status, 422);
  assert.equal(call("POST", "/api/workbench/memory/ledger/transition", { memory_id: "live-1", status: "revoked", expected_version: 999, actor: "user:alex", reason: "r" }).status, 422);
  assert.equal(call("POST", "/api/workbench/memory/ledger/transition", { memory_id: "live-1", status: "active", expected_version: version, actor: "user:alex", reason: "r" }).status, 422);
  assert.equal(call("POST", "/api/workbench/memory/ledger/transition", { memory_id: "live-1", status: "revoked", expected_version: version, actor: "user:alex", reason: " " }).status, 422);
  const retired = call("POST", "/api/workbench/memory/ledger/transition", { memory_id: "live-1", status: "revoked",
    expected_version: version, actor: "user:alex", reason: "no longer true" });
  assert.equal(retired.status, 200);
  const stored = f.store.get("memory_ledger", "live-1");
  assert.equal(stored.status, "revoked");
  assert.equal(stored.transitioned_by, "user:alex");
  // The default page stops listing it; history still does.
  const after = JSON.parse(call("GET", "/api/workbench/resources?kind=memory&limit=50").body).items as JsonObject[];
  assert.equal(after.find((item) => item.id === "live-1"), undefined);
  const history = JSON.parse(call("GET", "/api/workbench/resources?kind=memory&limit=50&history=1").body).items as JsonObject[];
  assert.equal(history.find((item) => item.id === "live-1")?.transitioned_by, "user:alex");
});

test("Workbench serves craft-file-dir-desc over HTTP: record, promote, resolve and list", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  // First touch only observes.
  const rec = JSON.parse(call("POST", "/api/workbench/file-dir-desc/record", { path: "C:\\projects\\billing", description: "billing service root" }).body);
  assert.equal(rec.status, "observed");
  // Resolve by description returns nothing while observed.
  assert.equal(JSON.parse(call("GET", "/api/workbench/file-dir-desc/resolve?description=billing%20service").body).results.length, 0);
  // Promote, then resolve returns the path.
  call("POST", "/api/workbench/file-dir-desc/promote", { id: rec.id });
  const resolved = JSON.parse(call("GET", "/api/workbench/file-dir-desc/resolve?description=billing%20service").body);
  assert.equal(resolved.results.length, 1);
  assert.equal(resolved.results[0].path, "C:\\projects\\billing");
  // List honours status filter.
  const promoted = JSON.parse(call("GET", "/api/workbench/file-dir-desc/list?status=promoted").body);
  assert.equal(promoted.items.length, 1);
  const observed = JSON.parse(call("GET", "/api/workbench/file-dir-desc/list?status=observed").body);
  assert.equal(observed.items.length, 0);
  // Malformed path is refused with 422.
  assert.equal(call("POST", "/api/workbench/file-dir-desc/record", { path: "relative/path", description: "x" }).status, 422);
});

test("one-click rollback goes to the immediately previous stable version", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const created = JSON.parse(call("POST", "/api/workbench/mods", { name: "rule", body: "v1 body", scope_kind: "global" }).body);
  // Editing a draft produces v2, so v1 is a genuine earlier snapshot.
  const edited = JSON.parse(call("POST", `/api/workbench/mods/${created.id}/update`, { name: "rule v2", body: "v2 body" }).body);
  assert.equal(Number(edited.version), 2);
  call("POST", `/api/workbench/mods/${created.id}/approve`, { approved_by: "op" });
  // Approval itself is a new version, so explicit and one-click rollbacks each
  // append a new version rather than rewriting history.
  const first = JSON.parse(call("POST", "/api/workbench/mods/rollback", { id: created.id, to_version: 1 }).body);
  assert.equal(Number(first.rolledBackTo), 1);
  assert.ok(Number(first.version) > Number(edited.version) + 1);
  const previous = JSON.parse(call("POST", "/api/workbench/mods/rollback/previous", { id: created.id }).body);
  assert.equal(Number(previous.rolledBackFrom), Number(first.version));
  assert.equal(Number(previous.version), Number(first.version) + 1);
  // A Mod with no history refuses honestly rather than pretending to succeed.
  const fresh = JSON.parse(call("POST", "/api/workbench/mods", { name: "fresh", body: "x", scope_kind: "global" }).body);
  assert.equal(call("POST", "/api/workbench/mods/rollback/previous", { id: fresh.id }).status, 422);
});

test("Workbench serves the Mod kernel over HTTP: draft, approve, overlay and list", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const created = JSON.parse(call("POST", "/api/workbench/mods", { name: "no-hardcode", body: "严禁硬编码", scope_kind: "global" }).body);
  assert.equal(created.status, "draft");
  assert.equal(JSON.parse(call("GET", "/api/workbench/mods/overlay").body).overlay, "");
  // Approval needs a named operator.
  assert.equal(call("POST", `/api/workbench/mods/${created.id}/approve`, {}).status, 422);
  const approved = JSON.parse(call("POST", `/api/workbench/mods/${created.id}/approve`, { approved_by: "user:alex" }).body);
  assert.equal(approved.status, "active");
  const overlay = JSON.parse(call("GET", "/api/workbench/mods/overlay").body).overlay;
  assert.ok(overlay.includes("严禁硬编码"));
  // Pending list is empty now; active list has one.
  assert.equal(JSON.parse(call("GET", "/api/workbench/mods/list?status=pending").body).items.length, 0);
  assert.equal(JSON.parse(call("GET", "/api/workbench/mods/list?status=active").body).items.length, 1);
  // Revoke removes it from injection.
  call("POST", `/api/workbench/mods/${created.id}/revoke`, {});
  assert.equal(JSON.parse(call("GET", "/api/workbench/mods/overlay").body).overlay, "");
});

test("Workbench serves self-evolved Mod proposal and shadow-test gate over HTTP", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const proposed = JSON.parse(call("POST", "/api/workbench/mods/propose-from-attribution", {
    failure_class: "scope_gap", remedy: "always verify scope", evidence_id: "ev-1" }).body);
  assert.equal(proposed.status, "pending");
  // Approval before a passing shadow test is refused.
  assert.equal(call("POST", `/api/workbench/mods/${proposed.id}/approve`, { approved_by: "op" }).status, 422);
  // A hand-written pass must be refused, so the only way through is a real run.
  assert.equal(call("POST", "/api/workbench/mods/shadow-test", { id: proposed.id, verdict: "passed", regression_set: "set-1" }).status, 422);
  call("POST", "/api/workbench/mods/shadow-test/run", { id: proposed.id });
  const approved = JSON.parse(call("POST", `/api/workbench/mods/${proposed.id}/approve`, { approved_by: "op" }).body);
  assert.equal(approved.status, "active");
  assert.ok(JSON.parse(call("GET", "/api/workbench/mods/overlay").body).overlay.includes("always verify scope"));
});

test("Workbench runs a deterministic shadow regression instead of claiming a pass", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const proposed = JSON.parse(call("POST", "/api/workbench/mods/propose-from-attribution", {
    failure_class: "retrieval_gap", remedy: "widen recall", evidence_id: "ev-run" }).body);
  const run = JSON.parse(call("POST", "/api/workbench/mods/shadow-test/run", { id: proposed.id }).body);
  assert.equal(run.regression.verdict, "passed");
  assert.equal(run.regression.model_calls, 0);
  assert.equal(run.regression.cases.length, 8);
  assert.equal(run.shadowTest, "passed");
  const approved = JSON.parse(call("POST", `/api/workbench/mods/${proposed.id}/approve`, { approved_by: "op" }).body);
  assert.equal(approved.status, "active");
});

test("Workbench serves one-time onboarding completion over HTTP", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const wb = (response: unknown): { onboarding: { completedAt: unknown } } => (response as { workbench: { onboarding: { completedAt: unknown } } }).workbench;
  assert.equal(wb(JSON.parse(call("GET", "/api/settings").body)).onboarding.completedAt, null);
  const done = wb(JSON.parse(call("POST", "/api/settings/onboarding/complete").body));
  assert.notEqual(done.onboarding.completedAt, null);
  // Idempotent: a later call keeps the earlier stamp.
  const again = wb(JSON.parse(call("POST", "/api/settings/onboarding/complete").body));
  assert.equal(again.onboarding.completedAt, done.onboarding.completedAt);
  const rearmed = wb(JSON.parse(call("POST", "/api/settings/onboarding/reset").body));
  assert.equal(rearmed.onboarding.completedAt, null);
});

test("Workbench binds the first workspace and completes onboarding over HTTP", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const bound = JSON.parse(call("POST", "/api/settings/onboarding/bind-workspace", { root_path: f.store.paths.root }).body);
  assert.notEqual(bound.workbench.onboarding.completedAt, null);
  assert.match(String(bound.workbench.onboarding.workspaceId), /^workspace_/u);
  // A missing/invalid path is refused, so the wizard cannot silently skip the step.
  assert.equal(call("POST", "/api/settings/onboarding/bind-workspace", { root_path: "/this/path/does/not/exist" }).status, 422);
});

test("Workbench exposes active task count for mode-switch confirmation", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(JSON.parse(call("GET", "/api/workbench/task-active-count").body).active, 0);
  const board = JSON.parse(call("GET", "/api/workbench/task-board").body) as { buckets: { running: unknown[]; queued: unknown[] } };
  assert.equal(board.buckets.running.length >= 0, true);
  assert.equal(board.buckets.queued.length >= 0, true);
});

test("Workbench serves newly added presentation modules over both asset paths", async () => {
  const f = await fixture();
  const dir = await mkdtemp(path.join(tmpdir(), "craft-wb-assets-"));
  await writeFile(path.join(dir, "mod-pages.js"), "export const marker = 1;\n", "utf8");
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost", { workbenchDir: dir });
  const root = app.handle({ method: "GET", path: "/mod-pages.js", token: "secret" });
  const nested = app.handle({ method: "GET", path: "/workbench/mod-pages.js", token: "secret" });
  assert.equal(root.status, 200);
  assert.match(root.contentType, /javascript/);
  assert.deepEqual(nested, root);
  assert.deepEqual(root.body, "export const marker = 1;\n");
});

test("Workbench serves the message inbox over HTTP: record, read, process and list", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const created = JSON.parse(call("POST", "/api/workbench/messages", { source: "email", from: "boss@x.com", subject: "决策", priority: "high" }).body);
  assert.equal(created.readAt, null);
  const list = JSON.parse(call("GET", "/api/workbench/messages/list").body);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].priority, "high");
  const unread = JSON.parse(call("GET", "/api/workbench/messages/list?unread_only=true").body);
  assert.equal(unread.items.length, 1);
  call("POST", `/api/workbench/messages/${created.id}/read`, {});
  const unreadAfter = JSON.parse(call("GET", "/api/workbench/messages/list?unread_only=true").body);
  assert.equal(unreadAfter.items.length, 0);
  const processed = JSON.parse(call("POST", `/api/workbench/messages/${created.id}/process`, {}).body);
  assert.notEqual(processed.processed_at, null);
  // Malformed source is refused with 422.
  assert.equal(call("POST", "/api/workbench/messages", { source: "fax", from: "a", subject: "s" }).status, 422);
});

test("Workbench serves plugin discovery proposals over HTTP without host writes", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  // An unattributed failure is refused (no guessing a plugin).
  assert.equal(call("POST", "/api/workbench/plugin-discovery/propose", { failure_class: "unattributed" }).status, 422);
  const proposed = JSON.parse(call("POST", "/api/workbench/plugin-discovery/propose", { failure_class: "coverage_gap", evidence_id: "ev-1" }).body);
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.writes_host_config, false);
  const approved = JSON.parse(call("POST", "/api/workbench/plugin-discovery/approve", { id: proposed.id, approved_by: "user:alex" }).body);
  assert.equal(approved.status, "approved");
  assert.equal(JSON.parse(call("GET", "/api/workbench/plugin-discovery/list?status=approved").body).items.length, 1);
});

test("failure attribution distils a pending Mod only from supported observations", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const observationId = "pilot_failure_observation_task-attr";
  f.store.save("pilot_failure_observation", observationId, { id: observationId, task_id: "task-attr",
    verdict: "needs_attention", summary: "验收未通过", failure_class: null, attributed: false });

  // No observations: an honest "we do not know" must not invent a rule.
  const unknown = JSON.parse(call("POST", "/api/workbench/pilot/failure-observations/attribute",
    { observation_id: observationId, signals: {}, attributed_by: "op" }).body);
  assert.equal(unknown.attribution.attributed, false);
  assert.equal(unknown.mod, null);
  assert.equal(JSON.parse(call("GET", "/api/workbench/mods/list").body).items.length, 0);

  f.store.save("pilot_failure_observation", observationId, { ...f.store.get("pilot_failure_observation", observationId),
    attributed: false, failure_class: null });
  const attributed = JSON.parse(call("POST", "/api/workbench/pilot/failure-observations/attribute",
    { observation_id: observationId, signals: { relevant_retrieved: false }, attributed_by: "op" }).body);
  assert.equal(attributed.attribution.failure_class, "retrieval_gap");
  assert.equal(attributed.mod.status, "pending");
  assert.equal(attributed.mod.shadowTest, "pending");
  // 路径 C：归因自动产出插件发现提案，但绝不自动安装或写宿主配置。
  assert.equal(attributed.discovery.status, "proposed");
  assert.equal(attributed.discovery.writes_host_config, false);
  assert.equal(attributed.discovery.auto_installed, false);
  // The gate holds: a pending self-evolved Mod cannot be approved yet.
  assert.equal(call("POST", `/api/workbench/mods/${attributed.mod.id}/approve`, { approved_by: "op" }).status, 422);
});

test("delivery adoption is recorded once and never silently overwritten", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const task = (f.service.taskOpen({ title: "交付", goal: "交付" }) as JsonObject).task as JsonObject;
  const taskId = String(task.id);
  assert.equal(JSON.parse(call("GET", "/api/workbench/pilot/adoption?task_id=" + encodeURIComponent(taskId)).body).adoption, null);
  const first = JSON.parse(call("POST", "/api/workbench/pilot/adoption",
    { task_id: taskId, verdict: "accepted_with_edits", note: "改了文档", decided_by: "op" }).body);
  assert.equal(first.adoption.verdict, "accepted_with_edits");
  assert.equal(first.idempotent, false);
  const again = JSON.parse(call("POST", "/api/workbench/pilot/adoption",
    { task_id: taskId, verdict: "rejected", decided_by: "op" }).body);
  assert.equal(again.idempotent, true);
  assert.equal(again.adoption.verdict, "accepted_with_edits", "an earlier decision is not rewritten");
  assert.equal(call("POST", "/api/workbench/pilot/adoption", { task_id: taskId, verdict: "maybe" }).status, 422);
  const outcomes = JSON.parse(call("GET", "/api/workbench/pilot/outcomes").body);
  assert.equal(outcomes.total, 1);
  assert.equal(outcomes.counts.accepted_with_edits, 1);
});

test("Workbench exposes the blocked queue and human resume over HTTP", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://localhost");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret", body: body === undefined ? undefined : JSON.stringify(body) });
  const sessionId = "session-http-blocked";
  f.store.save("pilot_session", sessionId, { id: sessionId, title: "s", status: "active", created_at: new Date().toISOString() });
  f.store.save("pilot_route", "route-http", { id: "route-http", session_id: sessionId, task_id: "task-http",
    queue_state: "running", status: "running", executor_template: "craft", created_at: new Date().toISOString() });
  call("POST", "/api/workbench/pilot/suspend-session?session_id=" + sessionId);
  const queue = JSON.parse(call("GET", "/api/workbench/pilot/blocked-queue").body);
  assert.equal(queue.items.length, 1);
  // 硬中断必须同时报警，而不是只在后台静默挂起。
  const alerts = JSON.parse(call("GET", "/api/workbench/messages/list?unread_only=true").body).items as JsonObject[];
  assert.ok(alerts.some((item) => item.priority === "high" && String(item.subject).includes("熔断")));
  const resumed = JSON.parse(call("POST", "/api/workbench/pilot/resume-session?session_id=" + sessionId).body);
  assert.equal(resumed.resumed, 1);
  assert.equal(JSON.parse(call("GET", "/api/workbench/pilot/blocked-queue").body).items.length, 0);
});

test("Workbench polls a local drop source into the inbox over HTTP (0 Token, async route)", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const dir = await mkdtemp(path.join(tmpdir(), "craft-poll-"));
  try {
    await writeFile(path.join(dir, "m1.json"), JSON.stringify({ source: "email", from: "boss", subject: "weekly", summary: "status please", priority: "high" }), "utf8");
    const polled = await app.handleAsync({ method: "POST", path: "/api/workbench/messages/poll", token: "secret", body: JSON.stringify({ drop_dirs: [dir] }) });
    assert.equal(polled.status, 200);
    const reports = JSON.parse(polled.body).reports as Array<{ ingested: number }>;
    assert.equal(reports[0].ingested, 1);
    const listed = JSON.parse(app.handle({ method: "GET", path: "/api/workbench/messages/list", token: "secret" }).body).items as Array<Record<string, unknown>>;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].from, "boss");
    // A second poll of the same source adds nothing (content-hash dedup).
    const again = await app.handleAsync({ method: "POST", path: "/api/workbench/messages/poll", token: "secret", body: JSON.stringify({ drop_dirs: [dir] }) });
    assert.equal((JSON.parse(again.body).reports as Array<{ ingested: number }>)[0].ingested, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Workbench exposes codebase relation health over HTTP and validates the workspace", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  // Token gate applies exactly like every other /api route.
  assert.equal(app.handle({ method: "GET", path: "/api/workbench/codebase/status" }).status, 401);
  // A missing workspace id is a client error, not an empty success.
  assert.equal(app.handle({ method: "GET", path: "/api/workbench/codebase/status", token: "secret" }).status, 422);
  // An unknown workspace is reported rather than silently returning zero counts.
  assert.equal(app.handle({ method: "GET", path: "/api/workbench/codebase/status?workspace_id=missing", token: "secret" }).status, 422);
});

test("Workbench serves directory-semantics withdrawal and relocation as attributed actions", async () => {
  const f = await fixture();
  const app = new WorkbenchWebApp(f.service, "secret", "http://127.0.0.1:4173");
  const call = (method: string, path: string, body?: unknown) => app.handle({ method, path, token: "secret",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const directory = await mkdtemp(path.join(tmpdir(), "craft-fdd-route-"));
  let next = "";
  try {
    const recorded = JSON.parse(call("POST", "/api/workbench/file-dir-desc/record",
      { path: directory, description: "billing service root" }).body);
    call("POST", "/api/workbench/file-dir-desc/promote", { id: recorded.id });
    assert.equal(JSON.parse(call("GET", "/api/workbench/file-dir-desc/resolve?description=billing%20service").body).results.length, 1);
    // Withdrawal is attributed and reversible only by an explicit promote.
    assert.equal(call("POST", "/api/workbench/file-dir-desc/revoke", { id: recorded.id, reason: "moved" }).status, 422);
    const revoked = JSON.parse(call("POST", "/api/workbench/file-dir-desc/revoke",
      { id: recorded.id, revoked_by: "user:alex", reason: "project moved" }).body);
    assert.equal(revoked.status, "revoked");
    assert.equal(JSON.parse(call("GET", "/api/workbench/file-dir-desc/resolve?description=billing%20service").body).results.length, 0);
    // Relocation keeps identity but changes the path it answers to.
    next = await mkdtemp(path.join(tmpdir(), "craft-fdd-route-2-"));
    const moved = JSON.parse(call("POST", "/api/workbench/file-dir-desc/relocate",
      { id: recorded.id, path: next }).body);
    assert.equal(moved.id, recorded.id);
    assert.equal(moved.path, next);
    assert.equal(call("POST", "/api/workbench/file-dir-desc/relocate", { id: "nope", path: next }).status, 422);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (next) await rm(next, { recursive: true, force: true });
  }
});
