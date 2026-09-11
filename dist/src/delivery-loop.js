import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
import { WorkDeliveryKernel } from "./work-delivery.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function terminal(status) { return ["completed", "failed", "cancelled", "interrupted"].includes(String(status)); }
function nextAction(status) {
    if (["accepted", "ready_for_delivery"].includes(status))
        return { phase: "complete", action: "deliver" };
    if (status === "awaiting_acceptance")
        return { phase: "waiting", action: "collect_acceptance" };
    if (status === "blocked")
        return { phase: "waiting", action: "human_handoff" };
    if (status === "host_failed" || status === "rejected")
        return { phase: "recovery", action: "retry_or_handoff" };
    return { phase: "running", action: "wait_for_host" };
}
/** Durable, content-free next-action projection over independently observed facts. */
export class DeliveryLoopKernel {
    store;
    deliveries;
    constructor(store, deliveries) { this.store = store; this.deliveries = deliveries; }
    refresh(args) {
        const launch = this.store.get("work_launch", text(args.launch_id, "launch_id"));
        const run = launch.run_id ? this.store.find("host_run", String(launch.run_id)) : null;
        const assessment = launch.acceptance_plan_id ? this.store.find("acceptance_assessment", `assessment_${launch.acceptance_plan_id}`) : null;
        const delivery = run && terminal(run.status) ? this.deliveries.observe({ launch_id: launch.id, delivery_id: `delivery_${launch.id}_${run.version}_${assessment?.version ?? 0}` }).delivery : null;
        const deliveryStatus = String(delivery?.status ?? "awaiting_host");
        const guidance = nextAction(deliveryStatus);
        const identity = { launch_id: launch.id, launch_version: launch.version, run_id: run?.id ?? null, run_version: run?.version ?? null, assessment_id: assessment?.id ?? null, assessment_version: assessment?.version ?? null, delivery_id: delivery?.id ?? null, delivery_version: delivery?.version ?? null, delivery_status: deliveryStatus, ...guidance };
        const loopId = String(args.loop_id ?? `delivery_loop_${launch.id}`);
        const current = this.store.find("delivery_loop", loopId);
        const stateDigest = digest(identity);
        if (current?.state_digest === stateDigest)
            return { loop: current, delivery, idempotent: true };
        const loop = current ? this.store.save("delivery_loop", loopId, { ...identity, state_digest: stateDigest }) : this.store.create("delivery_loop", loopId, { ...identity, state_digest: stateDigest });
        return { loop, delivery, idempotent: false };
    }
    get(args) { return { loop: this.store.get("delivery_loop", text(args.loop_id, "loop_id")) }; }
}
//# sourceMappingURL=delivery-loop.js.map