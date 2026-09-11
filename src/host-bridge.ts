import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _createdAt, updated_at: _updatedAt, ...rest } = record; return rest; }
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * Binds an already-prepared Execution Fabric to one actual Host invocation.
 * It deliberately stores only references and prompt digests. Host execution,
 * authorization and state observation remain in their specialised kernels.
 */
export class HostBridgeKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  prepare(args: JsonObject): JsonObject {
    const fabric = this.store.get("execution_fabric", text(args.fabric_id, "fabric_id"));
    const manifest = this.store.get("host_activation_manifest", String(fabric.manifest_id));
    const loop = this.store.get("verified_work_loop", String(fabric.work_loop_id));
    const taskRun = this.store.get("task_run", String(loop.task_run_id));
    const launch = this.store.get("work_launch", String(taskRun.launch_id));
    if (manifest.task_id !== loop.task_id || launch.task_id !== loop.task_id || launch.host !== manifest.host) {
      throw new Error("Host Bridge requires one Fabric, Task, Manifest, Work Loop, and Host Launch");
    }
    if (!["prepared", "awaiting_approval", "running"].includes(String(launch.status))) throw new Error("Host Bridge Launch is not executable");
    const identity = { fabric_id: fabric.id, manifest_id: manifest.id, manifest_version: manifest.version,
      work_loop_id: loop.id, task_run_id: taskRun.id, task_id: loop.task_id, launch_id: launch.id,
      host: launch.host, dispatch_id: launch.dispatch_id, sandbox: launch.sandbox, prompt_digest: launch.prompt_digest };
    const invocationId = String(args.invocation_id ?? `host_bridge_${fabric.id}`); const existing = this.store.find("host_bridge_invocation", invocationId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Host Bridge invocation idempotency conflict"); return { invocation: existing, idempotent: true }; }
    return { invocation: this.store.create("host_bridge_invocation", invocationId, { ...identity, identity_digest: identityDigest, status: "prepared", activation_receipt_id: null, run_id: null }), idempotent: false };
  }

  start(args: JsonObject): JsonObject {
    const invocation = this.store.get("host_bridge_invocation", text(args.invocation_id, "invocation_id"));
    const run = this.store.get("host_run", text(args.run_id, "run_id")); const receipt = this.store.get("host_activation_receipt", text(args.activation_receipt_id, "activation_receipt_id"));
    if (invocation.status === "running") {
      if (invocation.run_id !== run.id || invocation.activation_receipt_id !== receipt.id) throw new Error("Host Bridge start idempotency conflict");
      return { invocation, idempotent: true };
    }
    if (invocation.status !== "prepared" || run.host !== invocation.host || run.dispatch_id !== invocation.dispatch_id || receipt.manifest_id !== invocation.manifest_id) {
      throw new Error("Host Bridge start facts do not match its prepared invocation");
    }
    return { invocation: this.store.save("host_bridge_invocation", String(invocation.id), { ...payload(invocation), status: "running", run_id: run.id, activation_receipt_id: receipt.id, started_at: new Date().toISOString() }), idempotent: false };
  }

  finish(args: JsonObject): JsonObject {
    const invocation = this.store.get("host_bridge_invocation", text(args.invocation_id, "invocation_id")); const run = this.store.get("host_run", text(args.run_id, "run_id"));
    if (!TERMINAL.has(String(run.status))) throw new Error("Host Bridge can finish only after a terminal Host receipt");
    if (invocation.run_id !== run.id) throw new Error("Host Run does not belong to Host Bridge invocation");
    if (TERMINAL.has(String(invocation.status))) return { invocation, idempotent: true };
    if (invocation.status !== "running") throw new Error("Host Bridge invocation was not started");
    return { invocation: this.store.save("host_bridge_invocation", String(invocation.id), { ...payload(invocation), status: run.status, finished_at: run.finished_at ?? new Date().toISOString() }), idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const invocation = this.store.get("host_bridge_invocation", text(args.invocation_id, "invocation_id"));
    return { invocation, fabric: this.store.get("execution_fabric", String(invocation.fabric_id)), manifest: this.store.get("host_activation_manifest", String(invocation.manifest_id)) };
  }
}
