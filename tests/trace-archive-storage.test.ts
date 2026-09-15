import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ObjectTraceArchiveStore, type TraceArchiveBundle, type TraceObjectBackend } from "../src/trace-archive-store.ts";
import { TraceArchiveStorageKernel } from "../src/trace-archive-storage.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { TraceKernel } from "../src/trace-kernel.ts";
import { CraftService } from "../src/service.ts";
import { McpServer } from "../src/mcp.ts";
import { MaintenanceKernel } from "../src/maintenance.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-archive-storage-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const objects = new Map<string, Uint8Array>();
  const backend: TraceObjectBackend = {
    put(key, body) { objects.set(key, body); },
    get(key) { const body = objects.get(key); if (!body) throw new Error(`missing ${key}`); return body; },
  };
  const archives = new TraceArchiveStorageKernel(store, [
    { backend_id: "test.object", store: new ObjectTraceArchiveStore(backend, "tenant/craft") },
    { backend_id: "test.failing", store: { write() { throw new Error("archive backend offline"); }, read() { throw new Error("archive backend offline"); } } },
  ]);
  const trace = new TraceKernel(store, archives);
  store.create("task", "task", { title: "Trace storage", goal: "retain" });
  return { root, store, objects, archives, trace };
}

function terminal(trace: TraceKernel, id: string): void {
  trace.start({ trace_id: id, task_id: "task" });
  trace.append({ trace_id: id, event_kind: "action", data: {}, action_contract: { effect: "read_only" } });
  trace.finalize({ trace_id: id, status: "completed", summary: "done" });
}

function bundle(): TraceArchiveBundle {
  return { trace_id: "local", trace_version: 1, archived_at: "2030-01-01T00:00:00.000Z", trace: { id: "local" }, events: [], feedback: [] };
}

test("archive storage configuration rejects malformed or unsafe plugin declarations and preserves the built-in fallback", async () => {
  const f = await fixture();
  try {
    const local = f.archives.write(bundle());
    assert.equal(local.backend_id, "local");
    assert.deepEqual(f.archives.read(local), bundle());
    assert.deepEqual(f.archives.read({ ...local, backend_id: undefined }), bundle());
    assert.throws(() => f.archives.activate({ storage_id: "" }), /must not be empty/);
    assert.throws(() => f.archives.register({ storage_id: "local", backend_id: "test.object" }), /built in/);
    assert.throws(() => f.archives.register({ storage_id: "builtin-backend", backend_id: "builtin.local" }), /builtin/);
    assert.throws(() => f.archives.register({ storage_id: "Bad Id", backend_id: "test.object" }), /invalid/);
    assert.throws(() => f.archives.register({ storage_id: "bad-backend", backend_id: "Bad Id" }), /invalid/);
    assert.throws(() => f.archives.list({ limit: 0 }), /between/);
    assert.throws(() => new TraceArchiveStorageKernel(f.store, [{ backend_id: "test.object", store: new ObjectTraceArchiveStore({ put() {}, get() { return new Uint8Array(); } }, "a") }, { backend_id: "test.object", store: new ObjectTraceArchiveStore({ put() {}, get() { return new Uint8Array(); } }, "b") }]), /duplicated/);
    assert.throws(() => new TraceArchiveStorageKernel(f.store, [{ backend_id: "invalid-store", store: {} as never }]), /invalid/);
    assert.throws(() => new TraceArchiveStorageKernel(f.store, [{ backend_id: "missing-read", store: { write() { return local; } } as never }]), /invalid/);
    assert.throws(() => new TraceArchiveStorageKernel(f.store, [{ backend_id: "builtin.local", store: new ObjectTraceArchiveStore({ put() {}, get() { return new Uint8Array(); } }, "a") }]), /duplicated/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a configured archive storage plugin is activated only when its runtime backend is available", async () => {
  const f = await fixture();
  try {
    assert.equal(((f.archives.list().storages as JsonObject[])[0]).storage_id, "local");
    const registered = f.archives.register({ storage_id: "tenant-object", backend_id: "test.object", credential_ref: "broker://archive/tenant" });
    assert.equal((registered.storage as JsonObject).available, true);
    assert.equal(f.archives.register({ storage_id: "tenant-object", backend_id: "test.object", credential_ref: "broker://archive/tenant" }).idempotent, true);
    assert.throws(() => f.archives.register({ storage_id: "tenant-object", backend_id: "test.object", credential_ref: "broker://changed" }), /idempotency conflict/);
    assert.equal((f.archives.register({ storage_id: "tenant-object", backend_id: "test.object", credential_ref: "broker://changed", replace: true }).storage as JsonObject).credential_ref, "broker://changed");
    assert.equal((f.archives.activate({ storage_id: "tenant-object" }).active as JsonObject).storage_id, "tenant-object");
    assert.equal(f.archives.activate({ storage_id: "tenant-object" }).idempotent, true);
    f.archives.register({ storage_id: "tenant-object-two", backend_id: "test.object", credential_ref: "broker://archive/tenant-two" });
    f.archives.activate({ storage_id: "tenant-object-two" });
    f.archives.activate({ storage_id: "tenant-object" });
    terminal(f.trace, "old");
    const old = f.store.get("trace", "old");
    f.store.save("trace", "old", { ...old, last_event_at: "2020-01-01T00:00:00.000Z" });
    assert.equal(f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z" }).archived, 1);
    assert.equal(f.objects.size, 1);
    assert.equal((f.store.get("trace_archive", "old")).archive_backend_id, "tenant-object");
    assert.equal((f.trace.get({ trace_id: "old" }).trace as JsonObject).status, "completed");
    f.archives.register({ storage_id: "not-loaded", backend_id: "missing.plugin", credential_ref: "broker://archive/missing", configuration_ref: "config://archive/missing" });
    assert.equal(((f.archives.list({ limit: 10 }).storages as JsonObject[]).find((item) => item.storage_id === "not-loaded") as JsonObject).available, false);
    assert.throws(() => f.archives.activate({ storage_id: "not-loaded" }), /unavailable/);
    const saved = f.archives.write(bundle());
    assert.throws(() => f.archives.read({ ...saved, backend_id: "not-loaded" }), /unavailable/);
    assert.throws(() => f.archives.register({ storage_id: "bad-ref", backend_id: "test.object", credential_ref: "api_key=secret" }), /sensitive/);
    assert.equal((f.archives.register({ storage_id: "null-ref", backend_id: "test.object", credential_ref: null, configuration_ref: null }).storage as JsonObject).credential_ref, null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the persisted default policy drives maintenance-equivalent sweeps and archive failure leaves hot records intact", async () => {
  const f = await fixture();
  try {
    assert.equal((f.trace.retentionPlan({ policy_id: "default", max_days: 10, max_events: 20 }).policy as JsonObject).max_days, 10);
    assert.throws(() => f.trace.retentionPlan({ policy_id: "default", max_days: 7, max_events: 20 }), /idempotency conflict/);
    assert.equal((f.trace.retentionPlan({ policy_id: "default", max_days: 7, max_events: 20, replace: true }).policy as JsonObject).max_days, 7);
    terminal(f.trace, "old");
    const old = f.store.get("trace", "old");
    f.store.save("trace", "old", { ...old, last_event_at: "2029-12-24T00:00:00.000Z" });
    const automatic = f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z" });
    assert.equal(automatic.policy_id, "default");
    assert.equal(automatic.max_days, 7);
    assert.equal(automatic.archived, 1);
    f.archives.register({ storage_id: "failing", backend_id: "test.failing", credential_ref: "broker://archive/failing" });
    f.archives.activate({ storage_id: "failing" });
    terminal(f.trace, "must-stay-hot");
    const failed = f.store.get("trace", "must-stay-hot");
    f.store.save("trace", "must-stay-hot", { ...failed, last_event_at: "2020-01-01T00:00:00.000Z" });
    assert.throws(() => f.trace.retentionSweep({ now: "2030-01-01T00:00:00.000Z" }), /offline/);
    assert.equal(f.store.get("trace", "must-stay-hot").status, "completed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("full MCP exposes policy and archive storage configuration while unavailable plugins cannot be activated", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const mcp = new McpServer(service, "full");
    const call = async (name: string, args: JsonObject) => mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } });
    const listed = await call("craft_trace_archive_storage_list", {});
    assert.equal((listed?.result as JsonObject).isError, false);
    const registered = await call("craft_trace_archive_storage_register", { storage_id: "mcp-object", backend_id: "mcp.object", credential_ref: "broker://archive/mcp" });
    assert.equal((registered?.result as JsonObject).isError, false);
    const activated = await call("craft_trace_archive_storage_activate", { storage_id: "mcp-object" });
    assert.equal((activated?.result as JsonObject).isError, true);
    const policy = await call("craft_trace_retention_plan", { policy_id: "default", max_days: 14, max_events: 100, replace: true });
    assert.equal((policy?.result as JsonObject).isError, false);
    service.traceStart({ trace_id: "kept-by-policy", task_id: "task" });
    service.traceFinalize({ trace_id: "kept-by-policy", status: "completed", summary: "done" });
    const old = f.store.get("trace", "kept-by-policy");
    f.store.save("trace", "kept-by-policy", { ...old, last_event_at: "2029-12-24T00:00:00.000Z" });
    const tick = new MaintenanceKernel(service).tick({ now: "2030-01-01T00:00:00.000Z" });
    assert.equal(((tick.trace_retention as JsonObject).max_days), 14);
    assert.equal(((tick.trace_retention as JsonObject).archived), 0);
    assert.equal(mcp.tools.some((tool) => tool.name === "craft_trace_archive_storage_activate"), true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
