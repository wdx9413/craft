import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { V01226Runtime, defineAdapterManifest, importOpenApiDocument, type CommandSpawner } from "../core/generic-adapter-runtime.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";

async function fixture() { const root = await mkdtemp(join(tmpdir(), "craft-v01226-")); const store = await new CraftStore(craftPaths(root)).open(); return { root, store, runtime: new V01226Runtime(store) }; }
async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

function fakeSpawner(code = 0): CommandSpawner {
  return ((command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
    queueMicrotask(() => { child.stdout.emit("data", Buffer.from(`${command} ${args.join(" ")}\n`)); child.stderr.emit("data", Buffer.from("")); child.emit("close", code, null); }); return child as never;
  }) as unknown as CommandSpawner;
}
function slowSpawner(): CommandSpawner {
  return ((command: string) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; }; return child as never;
  }) as unknown as CommandSpawner;
}
function errorSpawner(): CommandSpawner {
  return ((command: string) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true; queueMicrotask(() => { child.emit("error", new Error(`cannot start ${command}`)); child.emit("close", null, null); }); return child as never;
  }) as unknown as CommandSpawner;
}

test("v0.12.26 generic adapter manifest lifecycle is governed and reversible", async () => {
  const f = await fixture(); try {
    assert.throws(() => defineAdapterManifest({ adapter_id: "", version: "1", kind: "command" }), /adapter_id/);
    assert.throws(() => defineAdapterManifest({ adapter_id: "bad", version: "1", kind: "bad" as never }), /unsupported/);
    assert.throws(() => defineAdapterManifest({ adapter_id: "bad", version: "1", kind: "command", platforms: ["amiga"] }), /platform/);
    assert.throws(() => defineAdapterManifest({ adapter_id: "bad", version: "1", kind: "command", effects: ["write"] }), /effect/);
    const input = { adapter_id: "local.command", version: "1.0.0", kind: "command" as const, platforms: ["any"], capabilities: ["command.run"], permissions: ["workspace"], effects: ["read_only"] as string[], signature: "ed25519:test" };
    const saved = f.runtime.adapterRegister(input); assert.equal((saved.manifest as { status: string }).status, "active");
    assert.equal((f.runtime.adapterRegister(input) as { idempotent: boolean }).idempotent, true);
    assert.equal((f.runtime.adapterRegister({ ...input, version: "2.0.0", capabilities: ["command.run", "command.observe"] }) as { idempotent: boolean }).idempotent, false);
    assert.equal(f.runtime.adapterList().adapters instanceof Array, true);
    assert.equal((f.runtime.adapterHealth("local.command") as { status: string }).status, "healthy");
    assert.equal((f.runtime.adapterConformance("local.command") as { passed: boolean }).passed, true);
    f.runtime.adapterQuarantine("local.command", "probe failure"); assert.equal(f.runtime.adapterHealth("local.command").status, "unavailable");
    f.runtime.adapterRollback("local.command"); assert.equal(f.runtime.adapterGet("local.command").status, "active");
    assert.throws(() => f.runtime.adapterGet("missing"), /Unknown/);
    const manifestPath = join(f.root, "adapter.json"); await writeFile(manifestPath, JSON.stringify({ ...input, adapter_id: "file.adapter", dependencies: { bundled: true } }));
    const installed = await f.runtime.adapterInstall(manifestPath); assert.equal((installed.manifest as { adapter_id: string }).adapter_id, "file.adapter");
    await writeFile(manifestPath, JSON.stringify({ ...input, adapter_id: "bad.adapter", dependencies: { install: "npm" } })); await assert.rejects(f.runtime.adapterInstall(manifestPath), /installation/);
    await writeFile(manifestPath, JSON.stringify({ ...input, adapter_id: "bad.digest" })); await assert.rejects(f.runtime.adapterInstall(manifestPath, "sha256:wrong"), /integrity/);
    const defaults = defineAdapterManifest({ adapter_id: "defaults", version: "1", kind: "mcp" });
    assert.deepEqual(defaults.platforms, ["any"]); assert.deepEqual(defaults.effects, ["read_only"]); assert.deepEqual(defaults.capabilities, []);
    const decorated = defineAdapterManifest({ adapter_id: "decorated", version: "1", kind: "host", dependencies: {}, integrity: "sha256:i", signature: "sig", sandbox_profile: "strict", metadata: {} });
    assert.equal(decorated.sandbox_profile, "strict");
  } finally { await close(f); }
});

test("v0.12.26 command adapter plans and returns receipts on all platforms", async () => {
  const f = await fixture(); try {
    f.runtime = new V01226Runtime(f.store, fakeSpawner());
    assert.throws(() => f.runtime.commandPlan({ argv: [] }), /argv/);
    assert.throws(() => f.runtime.commandPlan({ argv: ["echo"], effect: "destructive", shell: "/bin/sh" }), /approval/);
    const plan = f.runtime.commandPlan({ argv: [process.execPath, "-e", "console.log('ok')"] }); assert.equal((plan.plan as { status: string }).status, "planned");
    const completed = await f.runtime.commandRun({ argv: [process.execPath, "-e", "console.log('ok')"], plan_id: (plan.plan as { id: string }).id });
    assert.equal((completed.receipt as { status: string }).status, "completed"); assert.match(String((completed.receipt as { stdout: string }).stdout), /ok/);
    assert.equal(f.runtime.commandObserve(String((completed.run as { id: string }).id)).status, "completed");
    f.runtime.spawnProcess = fakeSpawner(1); const failed = await f.runtime.commandRun({ argv: ["failing-command"] }); assert.equal((failed.receipt as { status: string }).status, "failed"); f.runtime.spawnProcess = fakeSpawner();
    const retried = await f.runtime.commandRetry(String((completed.run as { id: string }).id)); assert.equal((retried.receipt as { status: string }).status, "completed");
    assert.equal(f.runtime.commandCancel(String((completed.run as { id: string }).id)).idempotent, true);
    assert.throws(() => f.runtime.commandObserve("missing"), /Unknown/);
    const shell = await f.runtime.commandRun({ argv: ["echo shell-ok"], shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh", effect: "read_only" }); assert.equal((shell.receipt as { status: string }).status, "completed");
    const slow = new V01226Runtime(f.store, slowSpawner()); const pending = slow.commandRun({ run_id: "cancel-run", argv: ["wait"] }); await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(slow.commandCancel("cancel-run").requested, true); assert.equal((await pending).receipt && ((await pending).receipt as { status: string }).status, "cancelled");
    const timed = new V01226Runtime(f.store, slowSpawner()); assert.equal(((await timed.commandRun({ run_id: "timeout-run", argv: ["wait"], timeout_ms: 100 })).receipt as { status: string }).status, "cancelled");
    const errored = new V01226Runtime(f.store, errorSpawner()); assert.equal(((await errored.commandRun({ run_id: "error-run", argv: ["bad"] })).receipt as { status: string }).status, "failed");
  } finally { await close(f); }
});

test("v0.12.26 context projection, durable runtime, trust, routing, delivery and portability", async () => {
  const f = await fixture(); try {
    const context = f.runtime.contextManifestSave({ manifest_id: "ctx", project_id: "p", knowledge_refs: ["k"], capability_refs: ["c"], workflow_refs: [], excluded_refs: [] }); assert.equal((context.manifest as { manifest_id: string }).manifest_id, "ctx"); assert.equal((f.runtime.contextManifestSave({ manifest_id: "ctx" }) as { idempotent: boolean }).idempotent, true);
    const projection = f.runtime.capabilityProject({ candidates: [{ id: "a", capability: "a", token_cost: 3 }, { id: "b", capability: "b", token_cost: 10 }], required: ["a"], token_budget: 5 }); assert.deepEqual((projection.selected as Array<{ id: string }>).map((item) => item.id), ["a"]); assert.equal((projection.excluded as Array<{ reason: string }>)[0].reason, "not_required");
    const durable = f.runtime.durableStart({ run_id: "d", task_id: "t" }); assert.equal((durable.run as { status: string }).status, "queued"); assert.equal((f.runtime.durableStart({ run_id: "d" }) as { idempotent: boolean }).idempotent, true); const tick = f.runtime.durableTick("worker", 1); assert.equal(tick.claimed, true); f.runtime.durableComplete("d", "completed", { ok: true }); assert.equal((f.runtime.durableRecover().recovered as number), 0);
    f.runtime.durableStart({ run_id: "stale" }); f.store.save("durable_run", "stale", { ...f.store.get("durable_run", "stale"), status: "running", lease_until: "2000-01-01T00:00:00.000Z" }); assert.equal((f.runtime.durableRecover().recovered as number), 1);
    assert.throws(() => f.runtime.trustRecord({ scope: "x", passed: 0, failed: 0 }), /required/); assert.equal((f.runtime.trustRecord({ scope: "x", passed: 20, failed: 0 }).profile as { autonomy: string }).autonomy, "automatic"); assert.equal((f.runtime.trustRecord({ scope: "y", passed: 1, failed: 1 }).profile as { autonomy: string }).autonomy, "manual");
    assert.throws(() => f.runtime.modelRoute({ candidates: [] }), /empty/); assert.equal((f.runtime.modelRoute({ objective: "cost", budget: 5, candidates: [{ id: "expensive", cost: 10 }, { id: "cheap", cost: 2 }] }).selected as { id: string }).id, "cheap");
    assert.equal(f.runtime.deliveryGate({ artifacts: ["a"], evidence: ["e"], required_artifacts: ["a"], required_evidence: ["e"] }).status, "passed"); assert.equal(f.runtime.deliveryGate({ artifacts: [], evidence: [], required_artifacts: ["a"], required_evidence: ["e"] }).status, "blocked");
    const bundle = f.runtime.projectBundle({ project: { id: "p" } }); assert.match(String(bundle.digest), /^sha256:/); const handoff = f.runtime.handoff({ context_manifest: context.manifest as Record<string, unknown>, host: { id: "h" }, task: { id: "t" } }); assert.equal(handoff.manifest_type, "craft.task.handoff");
    f.runtime.evaluatorDefine({ evaluator_id: "video", domain: "video", criteria: ["duration", "format"] }); assert.equal(f.runtime.evaluatorRun({ evaluator_id: "video", observations: { duration: 10, format: "mp4" } }).verdict, "passed"); assert.equal(f.runtime.evaluatorRun({ evaluator_id: "video", observations: {} }).verdict, "inconclusive");
    const autoContext = f.runtime.contextManifestSave({ project_id: "p", task_id: "t" }); assert.ok((autoContext.manifest as { manifest_id: string }).manifest_id);
    const projected = f.runtime.capabilityProject({ candidates: [{ id: "fallback" }] }); assert.equal((projected.selected as JsonObject[])[0]?.id, "fallback");
    assert.equal((f.runtime.durableComplete("d", "completed").run as JsonObject).result, null);
    assert.equal(f.runtime.durableRecover("other").recovered, 0);
    assert.equal((f.runtime.trustRecord({ scope: "assisted", passed: 9, failed: 1 }).profile as JsonObject).autonomy, "assisted");
    assert.equal((f.runtime.modelRoute({ objective: "latency", candidates: [{ id: "slow", latency_ms: 20 }, { id: "fast", latency_ms: 5 }], budget: 1 }).selected as JsonObject).id, "fast");
    assert.equal(f.runtime.deliveryGate({ artifacts: ["a"], evidence: ["e"] }).status, "passed");
    assert.deepEqual((f.runtime.projectBundle({ project: { id: "p" } }).bundle as JsonObject).sessions, []);
    assert.deepEqual((f.runtime.handoff({ context_manifest: {}, host: {}, task: {} }).budget as JsonObject), {});
  } finally { await close(f); }
});

test("v0.12.26 OpenAPI importer creates read/write adapter contracts", async () => {
  const f = await fixture(); try {
    const imported = await importOpenApiDocument(f.runtime, "openapi: 3.0.0\ninfo:\n  title: Demo API\npaths:\n  /items:\n    get:\n      operationId: listItems\n    post:\n      operationId: createItem\n"); const manifest = imported.manifest as { kind: string; metadata: { operations: Array<{ effect: string }> } }; assert.equal(manifest.kind, "openapi"); assert.deepEqual(manifest.metadata.operations.map((item) => item.effect), ["read", "external_write"]);
    await assert.rejects(importOpenApiDocument(f.runtime, { openapi: "3.0.0", paths: {} }), /no operations/);
    const fallback = await importOpenApiDocument(f.runtime, { paths: { "/health": { options: {}, head: {} } } });
    assert.equal((fallback.manifest as JsonObject).kind, "openapi");
  } finally { await close(f); }
});

test("v0.12.26 Service and MCP expose the shared runtime without a second execution model", async () => {
  const f = await fixture(); try {
    const service = new CraftService(f.store); const manifest = { adapter_id: "svc.command", version: "1", kind: "command", platforms: ["any"], capabilities: ["command.run"], permissions: [], effects: ["read_only"], signature: "ed25519:test" };
    service.adapterManifestSave(manifest); service.adapterManifestGet({ adapter_id: "svc.command" }); service.adapterManifestList({}); service.adapterHealth({ adapter_id: "svc.command" }); service.adapterConformance({ adapter_id: "svc.command" }); service.adapterQuarantine({ adapter_id: "svc.command", reason: "test" }); service.adapterRollback({ adapter_id: "svc.command" });
    const manifestPath = join(f.root, "service-adapter.json"); await writeFile(manifestPath, JSON.stringify({ ...manifest, adapter_id: "svc.file" })); await service.adapterInstall({ manifest_path: manifestPath });
    const plan = service.commandPlan({ argv: ["echo", "service"] }); const run = await service.commandRun({ argv: [process.execPath, "-e", "console.log('service')"] }); service.commandObserve({ run_id: String((run.run as { id: string }).id) }); service.commandCancel({ run_id: String((run.run as { id: string }).id) }); await service.commandRetry({ run_id: String((run.run as { id: string }).id) });
    service.contextManifestV01226Save({ manifest_id: "svc-context", project_id: "p", task_id: "t" }); service.capabilityProjection({ candidates: [{ id: "c", token_cost: 1 }] }); service.durableRunStart({ run_id: "svc-durable" }); service.durableRunTick({ owner: "svc" }); service.durableRunComplete({ run_id: "svc-durable", status: "completed" }); service.durableRunRecover({}); service.trustCurveRecord({ scope: "svc", passed: 1, failed: 0 }); service.modelRouteV01226({ candidates: [{ id: "m", quality: 1 }] }); service.deliveryGateV01226({ artifacts: ["a"], evidence: ["e"] }); service.taskHandoffManifest({ context_manifest: { id: "c" }, host: { id: "h" }, task: { id: "t" } }); new V01226Runtime(f.store).evaluatorDefine({ evaluator_id: "svc-eval", domain: "general", criteria: ["ok"] }); service.domainEvaluatorRun({ evaluator_id: "svc-eval", observations: { ok: true } }); await service.openApiImport({ document: "openapi: 3.0.0\npaths:\n  /x:\n    get: {}\n" });
    const mcp = new McpServer(service, "full"); const call = async (name: string, arguments_: Record<string, unknown>) => mcp.handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: arguments_ } });
    await call("craft_adapter_manifest_save", { adapter_id: "mcp.command", version: "1", kind: "command" }); await call("craft_adapter_manifest_get", { adapter_id: "mcp.command" }); await call("craft_adapter_manifest_list", {}); await call("craft_adapter_health", { adapter_id: "mcp.command" }); await call("craft_adapter_conformance", { adapter_id: "mcp.command" }); await call("craft_adapter_quarantine", { adapter_id: "mcp.command", reason: "test" }); await call("craft_adapter_rollback", { adapter_id: "mcp.command" });
    await call("craft_command_plan", { argv: ["echo", "mcp"] }); const mcpRun = await call("craft_command_run", { argv: [process.execPath, "-e", "console.log('mcp')"] }); const mcpPayload = mcpRun?.result as { structuredContent?: { run?: { id: string } } } | undefined; const mcpRunId = String(mcpPayload?.structuredContent?.run?.id ?? ""); if (mcpRunId) { await call("craft_command_observe", { run_id: mcpRunId }); await call("craft_command_cancel", { run_id: mcpRunId }); }
    await call("craft_capability_projection", { candidates: [{ id: "c", token_cost: 1 }] }); await call("craft_durable_run_start", { run_id: "mcp-durable" }); await call("craft_durable_run_tick", {}); await call("craft_durable_run_complete", { run_id: "mcp-durable", status: "completed" }); await call("craft_durable_run_recover", {}); await call("craft_trust_curve_record", { scope: "mcp", passed: 1, failed: 0 }); await call("craft_model_route", { candidates: [{ id: "m", quality: 1 }] }); await call("craft_delivery_gate", { artifacts: ["a"], evidence: ["e"] }); await call("craft_task_handoff_manifest", { context_manifest: { id: "c" }, host: { id: "h" }, task: { id: "t" } }); await call("craft_domain_evaluator_run", { evaluator_id: "svc-eval", observations: { ok: true } }); await call("craft_openapi_import", { document: "openapi: 3.0.0\npaths:\n  /mcp:\n    get: {}\n" });
    assert.equal((plan.plan as { status: string }).status, "planned");
  } finally { await close(f); }
});

test("v0.12.26 rejects null, empty and malformed adapter inputs", async () => {
  const f = await fixture();
  try {
    assert.throws(() => defineAdapterManifest({ adapter_id: null as never, version: "1", kind: "command" }), /adapter_id/);
    assert.throws(() => defineAdapterManifest({ adapter_id: "x", version: "", kind: "command" }), /version/);
    assert.throws(() => defineAdapterManifest({ adapter_id: "x", version: "1", kind: "command", platforms: [] }), /unique/);
    assert.throws(() => defineAdapterManifest({ adapter_id: "x", version: "1", kind: "command", capabilities: [null] as never }), /capabilities/);
    assert.throws(() => defineAdapterManifest({ adapter_id: "x", version: "1", kind: "command", dependencies: [] as never }), /dependencies/);
    assert.throws(() => f.runtime.commandPlan({ argv: ["echo"], timeout_ms: 99 }), /between/);
    assert.throws(() => f.runtime.commandPlan({ argv: ["echo"], shell: 1 as never }), /shell/);
    assert.throws(() => f.runtime.contextManifestSave({ manifest_id: "bad", knowledge_refs: ["x", "x"] }), /unique/);
    assert.throws(() => f.runtime.adapterList(0), /between/);
  } finally { await close(f); }
});

test("v0.12.26 covers adapter, command and durable defensive branches", async () => {
  const f = await fixture();
  try {
    const unsupportedPlatform = process.platform === "darwin" ? "linux" : "darwin";
    const base = { adapter_id: "branch.adapter", version: "1", kind: "command" as const, platforms: [unsupportedPlatform], capabilities: ["command.run"], permissions: [], effects: ["read_only"] as string[], signature: "sig" };
    f.runtime.adapterRegister(base);
    assert.equal(f.runtime.adapterHealth("branch.adapter").status, "unavailable");
    assert.throws(() => f.runtime.adapterRollback("branch.adapter"), /quarantined/);
    f.runtime.adapterQuarantine("branch.adapter", "test");
    assert.equal(f.runtime.adapterHealth("branch.adapter").status, "unavailable");
    const manifestPath = join(f.root, "signed-adapter.json");
    await writeFile(manifestPath, JSON.stringify({ ...base, adapter_id: "signed.adapter", signature: "sig" }));
    await f.runtime.adapterInstall(manifestPath);
    await writeFile(manifestPath, JSON.stringify({ ...base, adapter_id: "unsigned.adapter", signature: undefined }));
    await assert.rejects(f.runtime.adapterInstall(manifestPath), /signature or expected integrity/);

    const shellFalse = new V01226Runtime(f.store, fakeSpawner());
    const run = await shellFalse.commandRun({ run_id: "branch-run", argv: ["echo", "x"], shell: false, cwd: f.root, output_limit: 256, timeout_ms: 100 });
    assert.equal((run.receipt as JsonObject).status, "completed");
    const cross = new V01226Runtime(f.store, slowSpawner());
    f.store.create("command_run", "cross-run", { request: { argv: ["wait"] }, status: "running" });
    assert.equal(cross.commandCancel("cross-run").cross_process, true);
    assert.throws(() => cross.commandCancel("missing-cross"), /Unknown/);
    assert.throws(() => f.runtime.commandPlan({ argv: ["echo"], effect: "read_only", cwd: "" }), /cwd/);

    assert.equal((f.runtime.capabilityProject({ candidates: [{ id: "a", capability: "a", token_cost: 2 }, { id: "b", capability: "b", token_cost: 2 }], token_budget: 2 }).excluded as JsonObject[]).length, 1);
    const generatedDurable = f.runtime.durableStart({});
    assert.equal((generatedDurable.run as JsonObject).status, "queued");
    assert.equal(f.runtime.durableTick("owner").claimed, true);
    assert.equal(f.runtime.durableTick("owner").claimed, false);
    const generatedId = String((generatedDurable.run as JsonObject).id);
    f.store.save("durable_run", generatedId, { ...f.store.get("durable_run", generatedId), lease_until: "2000-01-01T00:00:00.000Z" });
    assert.equal(f.runtime.durableRecover("owner").recovered, 1);
    assert.equal((f.runtime.modelRoute({ objective: "quality", candidates: [{ id: "q", quality: 1, cost: 9 }], budget: 1 }).selected as JsonObject).id, "q");
    const openapi = await importOpenApiDocument(f.runtime, { paths: { "/x": { get: { summary: "x" } } } });
    assert.equal((openapi.manifest as JsonObject).metadata && typeof (openapi.manifest as JsonObject).metadata === "object", true);
  } finally { await close(f); }
});
