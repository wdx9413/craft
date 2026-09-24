/** Idempotent, lease-bound maintenance scheduling. Light work may run at a
 * session boundary; review/deep require an explicit idle budget and never publish. */
import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import type { MemoryMaintenanceKernel } from "./memory-maintenance.ts";
import { stableDigest } from "./digest.ts";

export class MaintenanceScheduler {
  readonly store: CraftStore; readonly maintenance: MemoryMaintenanceKernel;
  constructor(store: CraftStore, maintenance: MemoryMaintenanceKernel) { this.store = store; this.maintenance = maintenance; }
  tick(args: JsonObject = {}): JsonObject {
    const stage = String(args.stage ?? "light");
    if (!new Set(["light", "review", "deep"]).has(stage)) throw new Error("maintenance stage is unsupported");
    if (stage !== "light" && (args.idle !== true || args.budget_available !== true || args.model_available !== true)) {
      return { status: "skipped", reason: "idle_budget_or_model_unavailable", stage };
    }
    const leaseId = String(args.lease_id ?? `maintenance_lease_${randomUUID().replaceAll("-", "")}`);
    const identity = { stage, scope: args.scope ?? null, cursor: args.cursor ?? null };
    const existing = this.store.find("maintenance_schedule_receipt", leaseId);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Maintenance schedule idempotency conflict");
      return { status: existing.status, receipt: existing, idempotent: true };
    }
    const result = this.maintenance.run({ stage, maintenance_id: `scheduled_${leaseId}` });
    const receipt = this.store.create("maintenance_schedule_receipt", leaseId, { ...identity, identity_digest: stableDigest(identity), status: "completed", run_id: (result.run as JsonObject).id, publication_allowed: false });
    return { status: "completed", receipt, result, idempotent: false };
  }
}
