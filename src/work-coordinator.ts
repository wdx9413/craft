import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";
import { ManagedRunKernel } from "./managed-run.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }

/** One durable coordinator per Execution Fabric. It owns no model loop: the
 * Host remains replaceable while Craft owns the safe state transitions. */
export class WorkCoordinatorKernel {
  readonly store: CraftStore; readonly managed: ManagedRunKernel;
  constructor(store: CraftStore, managed: ManagedRunKernel) { this.store = store; this.managed = managed; }

  prepare(args: JsonObject): JsonObject {
    const fabric = this.store.get("execution_fabric", text(args.fabric_id, "fabric_id")); const loop = this.store.get("verified_work_loop", String(fabric.work_loop_id));
    const managed = this.managed.create({ managed_run_id: args.managed_run_id, work_loop_id: loop.id }).run as JsonObject;
    const identity = {
      fabric_id: fabric.id,
      fabric_identity_digest: fabric.identity_digest,
      work_loop_id: loop.id,
      managed_run_id: managed.id,
      managed_run_identity_digest: managed.identity_digest,
    };
    const coordinatorId = String(args.coordinator_id ?? `work_coordinator_${fabric.id}`); const existing = this.store.find("work_coordinator", coordinatorId); const identityDigest = digest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Work Coordinator idempotency conflict"); return { coordinator: existing, managed_run: managed, idempotent: true }; }
    const coordinator = this.store.create("work_coordinator", coordinatorId, { ...identity, identity_digest: identityDigest, lifecycle: "prepared", active_host_run_id: null, latest_observation_id: null, next_action: "start_or_handoff" });
    this.event(coordinator, "prepared", { fabric_id: fabric.id, managed_run_id: managed.id }); return { coordinator, managed_run: managed, idempotent: false };
  }

  attachHostRun(args: JsonObject): JsonObject {
    const coordinator = this.store.get("work_coordinator", text(args.coordinator_id, "coordinator_id")); const run = this.store.get("host_run", text(args.host_run_id, "host_run_id"));
    const fabric = this.store.get("execution_fabric", String(coordinator.fabric_id)); const loop = this.store.get("verified_work_loop", String(fabric.work_loop_id)); const taskRun = this.store.get("task_run", String(loop.task_run_id)); const launch = this.store.get("work_launch", String(taskRun.launch_id));
    if (coordinator.lifecycle === "needs_replan") throw new Error("Work Coordinator requires replan before another Host Run");
    if (run.dispatch_id !== launch.dispatch_id || run.host !== launch.host) throw new Error("Host Run does not match Work Coordinator Fabric");
    if (coordinator.active_host_run_id && coordinator.active_host_run_id !== run.id) throw new Error("Work Coordinator already owns a Host Run");
    const saved = this.store.save("work_coordinator", String(coordinator.id), { ...payload(coordinator), lifecycle: "running", active_host_run_id: run.id, next_action: "wait_for_host_receipt" }); this.event(saved, "host_attached", { host_run_id: run.id }); return { coordinator: saved };
  }

  observe(args: JsonObject): JsonObject {
    const coordinator = this.store.get("work_coordinator", text(args.coordinator_id, "coordinator_id")); const managed = this.store.get("managed_run", String(coordinator.managed_run_id));
    const observed = this.managed.observe({ managed_run_id: managed.id, task_run_state_id: text(args.task_run_state_id, "task_run_state_id"), snapshot_id: text(args.snapshot_id, "snapshot_id"), work_loop_receipt_id: text(args.work_loop_receipt_id, "work_loop_receipt_id"), observation_id: args.observation_id });
    const observation = observed.observation as JsonObject; const lifecycle = observation.status === "needs_replan" ? "needs_replan" : observation.status === "paused" ? "paused" : "observed";
    const nextAction = lifecycle === "needs_replan" ? "prepare_fresh_work_loop" : lifecycle === "paused" ? "resume_from_handoff" : "run_acceptance_or_handoff";
    const saved = this.store.save("work_coordinator", String(coordinator.id), { ...payload(coordinator), lifecycle, latest_observation_id: observation.id, next_action: nextAction, active_host_run_id: lifecycle === "observed" ? null : coordinator.active_host_run_id }); this.event(saved, "observed", { observation_id: observation.id, lifecycle }); return { coordinator: saved, managed_run: observed.run, observation };
  }

  handoff(args: JsonObject): JsonObject {
    const coordinator = this.store.get("work_coordinator", text(args.coordinator_id, "coordinator_id")); const handoff = this.managed.handoff({ ...args, managed_run_id: coordinator.managed_run_id }); const saved = this.store.save("work_coordinator", String(coordinator.id), { ...payload(coordinator), lifecycle: "paused", next_action: "resume_from_handoff" }); this.event(saved, "handoff", { handoff_id: (handoff.handoff as JsonObject).id }); return { coordinator: saved, ...handoff };
  }

  get(args: JsonObject): JsonObject { const coordinator = this.store.get("work_coordinator", text(args.coordinator_id, "coordinator_id")); return { coordinator, managed_run: this.managed.get({ managed_run_id: coordinator.managed_run_id }), timeline: this.store.events(`work-coordinator:${coordinator.id}`) }; }
  private event(coordinator: JsonObject, type: string, data: JsonObject): void { this.store.appendEvent(`work-coordinator:${coordinator.id}`, `work_coordinator.${type}`, data); }
}
