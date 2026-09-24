import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { payload } from "./digest.ts";


/** Persistent local service lifecycle. A host may call tick from a tray, cron, or OS scheduler. */
export class LocalRuntimeServiceKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  configure(args: JsonObject): JsonObject {
    const serviceId = String(args.service_id ?? "craft-local");
    const existing = this.store.find("local_runtime_service", serviceId);
    const record = { service_id: serviceId, schedule: String(args.schedule ?? "on_demand"), startup: String(args.startup ?? "manual"), notification: String(args.notification ?? "disabled"), crash_recovery: args.crash_recovery !== false };
    if (existing) return { service: this.store.save("local_runtime_service", serviceId, { ...payload(existing), ...record }), idempotent: false };
    return { service: this.store.create("local_runtime_service", serviceId, { ...record, status: "stopped", last_tick_at: null }), idempotent: false };
  }

  start(args: JsonObject = {}): JsonObject {
    const serviceId = String(args.service_id ?? "craft-local"); const service = this.store.find("local_runtime_service", serviceId) ?? (this.configure({ service_id: serviceId }).service as JsonObject);
    if (service.status === "running") return { service, idempotent: true };
    return { service: this.store.save("local_runtime_service", serviceId, { ...payload(service), status: "running", started_at: new Date().toISOString() }), idempotent: false };
  }

  stop(args: JsonObject = {}): JsonObject {
    const serviceId = String(args.service_id ?? "craft-local"); const service = this.store.get("local_runtime_service", serviceId);
    if (service.status === "stopped") return { service, idempotent: true };
    return { service: this.store.save("local_runtime_service", serviceId, { ...payload(service), status: "stopped", stopped_at: new Date().toISOString() }), idempotent: false };
  }

  tick(args: JsonObject = {}): JsonObject {
    const serviceId = String(args.service_id ?? "craft-local"); const service = this.store.get("local_runtime_service", serviceId);
    if (service.status !== "running") return { service, processed: [], count: 0, skipped: true };
    const now = args.now === undefined ? new Date().toISOString() : text(args.now, "now");
    const jobs = this.store.list("runtime_wakeup", 500, (item) => item.service_id === serviceId && item.status === "pending");
    const processed = jobs.map((job) => this.store.save("runtime_wakeup", String(job.id), { ...payload(job), status: "dispatched", dispatched_at: now }));
    const saved = this.store.save("local_runtime_service", serviceId, { ...payload(service), last_tick_at: now, processed_count: Number(service.processed_count ?? 0) + processed.length });
    return { service: saved, processed, count: processed.length, skipped: false };
  }

  get(args: JsonObject = {}): JsonObject { return { service: this.store.get("local_runtime_service", String(args.service_id ?? "craft-local")) }; }
}
