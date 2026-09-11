import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _createdAt, updated_at: _updatedAt, ...rest } = record; return rest; }

/**
 * Immutable join records for Craft's one public work path. The kernel has no
 * scheduler: service code obtains observed Work Loop facts first, then records
 * their relationship to the exact Host activation manifest.
 */
export class ExecutionFabricKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  create(args: JsonObject): JsonObject {
    const loop = this.store.get("verified_work_loop", text(args.work_loop_id, "work_loop_id"));
    const manifest = this.store.get("host_activation_manifest", text(args.manifest_id, "manifest_id"));
    const contract = this.store.get("task_control_contract", String(loop.contract_id));
    if (loop.task_id !== manifest.task_id || contract.activation_profile === null ||
      (contract.activation_profile as JsonObject).id !== manifest.profile_id || Number((contract.activation_profile as JsonObject).version) !== Number(manifest.profile_version)) {
      throw new Error("Execution Fabric requires one Task, Contract, Profile, Work Loop, and Host Manifest");
    }
    const identity = { task_id: loop.task_id, contract_id: loop.contract_id, work_loop_id: loop.id,
      task_run_id: loop.task_run_id, manifest_id: manifest.id, manifest_version: manifest.version };
    const fabricId = String(args.fabric_id ?? `execution_fabric_${loop.id}`); const existing = this.store.find("execution_fabric", fabricId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Execution Fabric idempotency conflict"); return { fabric: existing, idempotent: true }; }
    return { fabric: this.store.create("execution_fabric", fabricId, { ...identity, identity_digest: identityDigest, lifecycle: "prepared", latest_loop_receipt_id: null, activation_receipt_id: null }), idempotent: false };
  }

  advance(args: JsonObject): JsonObject {
    const fabric = this.store.get("execution_fabric", text(args.fabric_id, "fabric_id"));
    const receipt = this.store.get("verified_work_loop_receipt", text(args.work_loop_receipt_id, "work_loop_receipt_id"));
    if (receipt.work_loop_id !== fabric.work_loop_id) throw new Error("Work Loop receipt does not belong to Execution Fabric");
    const activationReceipt = args.activation_receipt_id === undefined ? null : this.store.get("host_activation_receipt", text(args.activation_receipt_id, "activation_receipt_id"));
    if (activationReceipt && activationReceipt.manifest_id !== fabric.manifest_id) throw new Error("Host Activation receipt does not belong to Execution Fabric");
    const lifecycle = String(receipt.status) === "needs_replan" ? "needs_replan" : String(receipt.status);
    const identity = { fabric_id: fabric.id, work_loop_receipt_id: receipt.id, work_loop_receipt_version: receipt.version,
      activation_receipt_id: activationReceipt?.id ?? null, lifecycle };
    const advanceId = String(args.advance_id ?? `execution_fabric_advance_${fabric.id}_${receipt.id}_${receipt.version}_${activationReceipt?.id ?? "none"}`); const existing = this.store.find("execution_fabric_advance", advanceId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Execution Fabric advance idempotency conflict"); return { fabric, advance: existing, idempotent: true }; }
    const saved = this.store.save("execution_fabric", String(fabric.id), { ...payload(fabric), lifecycle, latest_loop_receipt_id: receipt.id,
      activation_receipt_id: activationReceipt?.id ?? fabric.activation_receipt_id });
    return { fabric: saved, advance: this.store.create("execution_fabric_advance", advanceId, { ...identity, identity_digest: identityDigest }), idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const fabric = this.store.get("execution_fabric", text(args.fabric_id, "fabric_id"));
    return { fabric, advances: this.store.list("execution_fabric_advance", 1000, (item) => item.fabric_id === fabric.id) };
  }
}
