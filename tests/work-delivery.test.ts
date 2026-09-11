import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("work delivery closes Host and acceptance facts without inventing a business outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-delivery-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const add = (id: string, runStatus: string, acceptance?: string) => { store.create("host_run", `run-${id}`, { status: runStatus }); store.create("work_launch", `launch-${id}`, { run_id: `run-${id}`, ...(acceptance ? { acceptance_plan_id: `plan-${id}` } : {}) }); if (acceptance && acceptance !== "pending") store.create("acceptance_assessment", `assessment_plan-${id}`, { status: acceptance }); };
    add("ready", "completed"); add("pass", "completed", "passed"); add("fail", "completed", "failed"); add("block", "completed", "blocked"); add("wait", "completed", "pending"); add("host", "failed"); store.create("work_launch", "launch-live", {}); store.create("work_launch", "launch-no-run", {}); store.create("host_run", "run-live", { status: "running" }); store.save("work_launch", "launch-live", { ...store.get("work_launch", "launch-live"), run_id: "run-live" });
    const status = (id: string) => ((service.workDeliveryObserve({ launch_id: `launch-${id}` }).delivery as JsonObject).status);
    assert.deepEqual([status("ready"), status("pass"), status("fail"), status("block"), status("wait"), status("host")], ["ready_for_delivery", "accepted", "rejected", "blocked", "awaiting_acceptance", "host_failed"]);
    assert.equal(service.workDeliveryObserve({ launch_id: "launch-ready" }).idempotent, true); assert.equal((service.workDeliveryGet({ delivery_id: "delivery_launch-ready" }).delivery as JsonObject).status, "ready_for_delivery");
    const named = service.workDeliveryObserve({ launch_id: "launch-pass", delivery_id: "named" }).delivery as JsonObject; assert.equal(named.id, "named"); const mcp = new McpServer(service, "full"); assert.equal(((await mcp.handlers.craft_work_delivery_get({ delivery_id: named.id })).delivery as JsonObject).id, named.id); assert.equal((((await mcp.handlers.craft_work_delivery_observe({ launch_id: "launch-block", delivery_id: "from-mcp" })).delivery as JsonObject).status), "blocked");
    assert.throws(() => service.workDeliveryObserve({ launch_id: "launch-live" }), /terminal Host receipt/); assert.throws(() => service.workDeliveryObserve({ launch_id: "launch-no-run" }), /terminal Host receipt/); assert.throws(() => service.workDeliveryGet({ delivery_id: " " }), /delivery_id/);
    store.save("host_run", "run-ready", { ...store.get("host_run", "run-ready"), note: "drift" }); assert.throws(() => service.workDeliveryObserve({ launch_id: "launch-ready" }), /observation changed/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
