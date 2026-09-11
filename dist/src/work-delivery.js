import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
/** Read-only closure over an exact Host receipt and independent acceptance state. */
export class WorkDeliveryKernel {
    store;
    constructor(store) { this.store = store; }
    observe(args) {
        const launch = this.store.get("work_launch", text(args.launch_id, "launch_id"));
        const run = launch.run_id ? this.store.get("host_run", String(launch.run_id)) : null;
        if (!run || !["completed", "failed", "cancelled", "interrupted"].includes(String(run.status)))
            throw new Error("Work Launch has no terminal Host receipt");
        const acceptance = launch.acceptance_plan_id ? this.store.find("acceptance_assessment", `assessment_${launch.acceptance_plan_id}`) : null;
        const hostPassed = run.status === "completed";
        const status = !hostPassed ? "host_failed" : launch.acceptance_plan_id === undefined ? "ready_for_delivery" : acceptance?.status === "passed" ? "accepted" : acceptance?.status === "failed" ? "rejected" : acceptance?.status === "blocked" ? "blocked" : "awaiting_acceptance";
        const identity = { launch_id: launch.id, launch_version: launch.version, run_id: run.id, run_version: run.version, acceptance_id: acceptance?.id ?? null, acceptance_version: acceptance?.version ?? null, status };
        const deliveryId = String(args.delivery_id ?? `delivery_${launch.id}`);
        const existing = this.store.find("work_delivery", deliveryId);
        const observationDigest = digest(identity);
        if (existing) {
            if (existing.observation_digest !== observationDigest)
                throw new Error("Work delivery observation changed; use a new delivery_id");
            return { delivery: existing, launch, run, acceptance, idempotent: true };
        }
        return { delivery: this.store.create("work_delivery", deliveryId, { ...identity, observation_digest: observationDigest }), launch, run, acceptance, idempotent: false };
    }
    get(args) { return { delivery: this.store.get("work_delivery", text(args.delivery_id, "delivery_id")) }; }
}
//# sourceMappingURL=work-delivery.js.map