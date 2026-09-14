import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { CraftService } from "../src/service.ts";
import { McpServer } from "../src/mcp.ts";
import { ActionGatewayKernel, AcceptanceGateKernel, A2AProtocolKernel, DurableWorkerKernel, ProviderRouterKernel } from "../src/v01213-runtime.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v1213-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "task", { project_id: "project", title: "Task", goal: "Goal", status: "active" });
  return { root, store, service: new CraftService(store) };
}

test("v0.12.14 action gateway enforces workspace boundaries and approval", async () => {
  const f = await fixture();
  try {
    const kernel = new ActionGatewayKernel(f.store);
    const prepared = kernel.prepare({ action_id: "read", task_id: "task", workspace: f.root, operation: "workspace_read", input_digest: "sha256:i" });
    assert.equal(kernel.prepare({ action_id: "read", task_id: "task", workspace: f.root, operation: "workspace_read", input_digest: "sha256:i" }).idempotent, true);
    assert.throws(() => kernel.prepare({ action_id: "read", task_id: "task", workspace: f.root, operation: "workspace_read", input_digest: "sha256:x" }), /idempotency/);
    await assert.rejects(() => kernel.execute({ action_id: "read", relative_path: "missing.txt" }), /ENOENT/);
    await assert.rejects(() => kernel.execute({ action_id: prepared.action && (prepared.action as JsonObject).id, relative_path: "../escape" }), /escapes/);
    await assert.rejects(() => kernel.execute({ action_id: prepared.action && (prepared.action as JsonObject).id, relative_path: "x", operation: "shell" }), /ENOENT/);
    const file = join(f.root, "input.txt"); await (await import("node:fs/promises")).writeFile(file, "hello", "utf8");
    const read = await kernel.execute({ action_id: prepared.action && (prepared.action as JsonObject).id, relative_path: "input.txt" });
    assert.equal((read.result as JsonObject).content, "hello");
    assert.equal((await kernel.execute({ action_id: "read", relative_path: "input.txt" })).idempotent, true);
    assert.equal((kernel.get({ action_id: "read" }).action as JsonObject).status, "completed");

    const write = kernel.prepare({ action_id: "write", task_id: "task", workspace: f.root, operation: "workspace_write", effect: "local_write", input_digest: "sha256:w" });
    await assert.rejects(() => kernel.execute({ action_id: (write.action as JsonObject).id, relative_path: "out.txt", content: "x", approved: false }), /approval/);
    const written = await kernel.execute({ action_id: "write", relative_path: "out.txt", content: "x", approved: true });
    assert.equal((written.result as JsonObject).bytes, 1); assert.equal(await readFile(join(f.root, "out.txt"), "utf8"), "x");
    assert.throws(() => kernel.prepare({ action_id: "bad-effect", task_id: "task", workspace: f.root, operation: "workspace_read", effect: "nope", input_digest: "sha256:b" }), /Unsupported action effect/);
    await assert.rejects(() => kernel.execute({ action_id: (kernel.prepare({ action_id: "remote", task_id: "task", workspace: f.root, operation: "mcp_call", effect: "external_write", input_digest: "sha256:r" }).action as JsonObject).id, relative_path: "x", approved: true }), /requires an explicit/);
    await assert.rejects(() => kernel.execute({ action_id: (kernel.prepare({ action_id: "unknown", task_id: "task", workspace: f.root, operation: "unknown", input_digest: "sha256:u" }).action as JsonObject).id, relative_path: "x" }), /Unsupported action operation/);
  } finally { f.store.close(); }
});

test("v0.12.14 acceptance, worker and provider kernels form a durable local control path", async () => {
  const f = await fixture();
  try {
    const gate = new AcceptanceGateKernel(f.store);
    const prepared = gate.prepare({ gate_id: "gate", task_id: "task", work_id: "work", acceptance_ref: "accept", required_artifact_ids: ["a"], required_evidence_ids: ["e"] });
    assert.equal(gate.prepare({ gate_id: "gate", task_id: "task", work_id: "work", acceptance_ref: "accept", required_artifact_ids: ["a"], required_evidence_ids: ["e"] }).idempotent, true);
    assert.throws(() => gate.prepare({ gate_id: "gate", task_id: "task", work_id: "work", acceptance_ref: "other" }), /idempotency/);
    assert.throws(() => gate.outcome({ gate_id: "gate" }), /passed/);
    assert.throws(() => gate.assess({ gate_id: "gate", verdict: "passed" }), /requires artifacts/);
    assert.equal((gate.assess({ gate_id: "gate", verdict: "blocked" }).gate as JsonObject).status, "blocked");
    assert.equal(gate.assess({ gate_id: "gate", verdict: "blocked" }).idempotent, true);
    const gate2 = gate.prepare({ gate_id: "gate2", task_id: "task", work_id: "work2", acceptance_ref: "accept", required_artifact_ids: [], required_evidence_ids: [] });
    assert.equal((gate.assess({ gate_id: "gate2", verdict: "passed", artifact_ids: ["a"], evidence_ids: ["e"], assessor: "human" }).gate as JsonObject).status, "passed");
    assert.equal((gate.outcome({ gate_id: "gate2", summary: "accepted" }).outcome as JsonObject).verdict, "passed");
    assert.equal(gate.outcome({ gate_id: "gate2" }).idempotent, true); assert.equal((gate.get({ gate_id: "gate2" }).gate as JsonObject).status, "passed");

    const worker = new DurableWorkerKernel(f.store);
    assert.equal((worker.configure({ worker_id: "w", lease_ttl_ms: 1 }).worker as JsonObject).status, "stopped");
    worker.configure({ worker_id: "w", notification: "enabled" }); worker.start({ worker_id: "w" }); assert.equal(worker.start({ worker_id: "w" }).idempotent, true);
    const job = worker.enqueue({ worker_id: "w", job_id: "j", task_id: "task", action: "accept" }); assert.equal(worker.enqueue({ worker_id: "w", job_id: "j", task_id: "task", action: "accept" }).idempotent, true);
    assert.equal((worker.tick({ worker_id: "w", now: "2030-01-01T00:00:00Z" }).jobs as JsonObject[]).length, 1);
    assert.equal((worker.recover({ worker_id: "w", now: "2030-01-01T00:01:00Z" }).recovered as JsonObject[]).length, 1);
    worker.stop({ worker_id: "w" }); assert.equal(worker.stop({ worker_id: "w" }).idempotent, true); assert.equal(worker.tick({ worker_id: "w" }).skipped, true);
    assert.equal((worker.get({ worker_id: "w" }).worker as JsonObject).status, "stopped"); assert.equal((job.job as JsonObject).status, "pending");

    const router = new ProviderRouterKernel(f.store);
    assert.throws(() => router.plan({ providers: [] }), /must not be empty/);
    assert.throws(() => router.plan({ providers: ["a"], preferred: "b" }), /declared/);
    const route = router.plan({ route_id: "route", providers: ["a", "b"], preferred: "a", task_id: "task" });
    assert.equal(router.plan({ route_id: "route", providers: ["a", "b"], preferred: "a", task_id: "task" }).idempotent, true);
    assert.throws(() => router.plan({ route_id: "route", providers: ["a"], preferred: "a" }), /idempotency/);
    assert.throws(() => router.record({ route_id: "route", provider: "z" }), /not in/);
    assert.equal((router.record({ route_id: "route", provider: "b", usage: { input: 1 } }).route as JsonObject).selected_provider, "b");
    assert.equal((router.get({ route_id: (route.route as JsonObject).id }).route as JsonObject).status, "used");
  } finally { f.store.close(); }
});

test("v0.12.14 A2A standard operations are HTTPS-only and content-free", async () => {
  const response = async () => ({ ok: true, status: 200, json: async () => ({ task_id: "remote", status: "working" }) }) as Response;
  const fetchImpl = (async () => response()) as unknown as typeof fetch;
  const kernel = new A2AProtocolKernel();
  assert.equal((await kernel.sendMessage({ endpoint: "https://agent.test", message_digest: "sha256:m" }, fetchImpl)).operation, "message/send");
  assert.equal((await kernel.streamMessage({ endpoint: "https://agent.test", message_digest: "sha256:m" }, fetchImpl)).streaming, true);
  assert.equal((await kernel.listTasks({ endpoint: "https://agent.test" }, fetchImpl)).operation, "tasks/list");
  await assert.rejects(() => kernel.sendMessage({ endpoint: "http://agent.test", message_digest: "sha256:m" }, fetchImpl), /HTTPS/);
  const badFetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(() => kernel.listTasks({ endpoint: "https://agent.test" }, badFetch), /HTTP 503/);
});

test("v0.12.14 service and MCP expose the new runtime surface", async () => {
  const f = await fixture();
  try {
    const service = f.service;
    await writeFile(join(f.root, "model-input.txt"), "input", "utf8");
    const invoke = (service as unknown as { invokeInternalAction: (action: string, args: JsonObject) => Promise<JsonObject> }).invokeInternalAction.bind(service);
    assert.equal((await invoke("workspace_read", { task_id: "task", workspace: f.root, relative_path: "model-input.txt" })).result && true, true);
    assert.equal((await invoke("workspace_write", { task_id: "task", workspace: f.root, relative_path: "model-output.txt", content: "output", approved: true })).result && true, true);
    service.durableWorkerConfigure({ worker_id: "service-worker" }); service.durableWorkerStart({ worker_id: "service-worker" }); service.durableWorkerEnqueue({ worker_id: "service-worker", task_id: "task", action: "wake" }); service.durableWorkerTick({ worker_id: "service-worker" }); service.durableWorkerGet({ worker_id: "service-worker" }); service.durableWorkerStop({ worker_id: "service-worker" }); service.durableWorkerRecover({ worker_id: "service-worker" });
    service.providerRoutePlan({ route_id: "service-route", providers: ["a"] }); service.providerRouteRecord({ route_id: "service-route", provider: "a" }); service.providerRouteGet({ route_id: "service-route" });
    const mcp = new McpServer(service, "full");
    for (const [name, args] of [["craft_action_gateway_prepare", { action_id: "mcp-action", task_id: "task", workspace: f.root, operation: "workspace_read", input_digest: "sha256:m" }], ["craft_action_gateway_execute", { action_id: "mcp-action", relative_path: "model-input.txt" }], ["craft_action_gateway_get", { action_id: "mcp-action" }], ["craft_acceptance_gate_prepare", { gate_id: "mcp-gate", task_id: "task", work_id: "mcp-work", acceptance_ref: "a" }], ["craft_acceptance_gate_assess", { gate_id: "mcp-gate", verdict: "failed" }], ["craft_acceptance_gate_get", { gate_id: "mcp-gate" }], ["craft_durable_worker_configure", { worker_id: "mcp-worker" }], ["craft_durable_worker_start", { worker_id: "mcp-worker" }], ["craft_durable_worker_stop", { worker_id: "mcp-worker" }], ["craft_durable_worker_enqueue", { worker_id: "mcp-worker", task_id: "task", action: "wake" }], ["craft_durable_worker_tick", { worker_id: "mcp-worker" }], ["craft_durable_worker_recover", { worker_id: "mcp-worker" }], ["craft_durable_worker_get", { worker_id: "mcp-worker" }], ["craft_provider_route_plan", { route_id: "mcp-route", providers: ["a"] }], ["craft_provider_route_record", { route_id: "mcp-route", provider: "a" }], ["craft_provider_route_get", { route_id: "mcp-route" }]] as [string, JsonObject][]) {
      const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } }); assert.equal((result?.result as JsonObject).isError, false);
    }
    for (const [name, args] of [["craft_acceptance_gate_prepare", { gate_id: "mcp-gate-pass", task_id: "task", work_id: "mcp-work-pass", acceptance_ref: "a" }], ["craft_acceptance_gate_assess", { gate_id: "mcp-gate-pass", verdict: "passed", artifact_ids: ["a"], evidence_ids: ["e"] }], ["craft_acceptance_gate_outcome", { gate_id: "mcp-gate-pass" }]] as [string, JsonObject][]) {
      const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } }); assert.equal((result?.result as JsonObject).isError, false);
    }
    for (const name of ["craft_a2a_message_send", "craft_a2a_message_stream", "craft_a2a_task_list"]) {
      const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: { endpoint: "http://invalid", message_digest: "sha256:m" } } }); assert.equal((result?.result as JsonObject).isError, true);
    }
  } finally { f.store.close(); }
});
