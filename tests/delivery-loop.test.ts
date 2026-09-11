import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("delivery loop materializes the next recoverable action from Host and acceptance facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-delivery-loop-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const add = (id: string, hostStatus: string, acceptance?: string) => {
      store.create("host_run", `run-${id}`, { status: hostStatus });
      store.create("work_launch", `launch-${id}`, { run_id: `run-${id}`, ...(acceptance === undefined ? {} : { acceptance_plan_id: `plan-${id}` }) });
      if (acceptance !== undefined) store.create("acceptance_assessment", `assessment_plan-${id}`, { status: acceptance });
    };
    add("live", "running"); add("ready", "completed"); add("accepted", "completed", "passed"); add("waiting", "completed", "pending"); add("failed", "failed"); add("blocked", "completed", "blocked");
    const loop = (id: string) => service.deliveryLoopRefresh({ launch_id: `launch-${id}` }).loop as JsonObject;
    assert.deepEqual([loop("live").action, loop("ready").action, loop("accepted").action, loop("waiting").action, loop("failed").action, loop("blocked").action], ["wait_for_host", "deliver", "deliver", "collect_acceptance", "retry_or_handoff", "human_handoff"]);
    const ready = loop("ready"); assert.equal(service.deliveryLoopRefresh({ launch_id: "launch-ready" }).idempotent, true); assert.equal((service.deliveryLoopGet({ loop_id: ready.id }).loop as JsonObject).delivery_status, "ready_for_delivery"); assert.equal((((service.homeView({ limit: 10 }).work_launches as JsonObject[]).find((item) => item.id === "launch-ready") as JsonObject).delivery_action), "deliver");
    store.save("host_run", "run-live", { ...store.get("host_run", "run-live"), status: "failed" }); const revised = loop("live"); assert.equal(revised.version, 2); assert.equal(revised.action, "retry_or_handoff");
    const mcp = new McpServer(service, "full"); assert.equal(((await mcp.handlers.craft_delivery_loop_get({ loop_id: revised.id })).loop as JsonObject).id, revised.id); assert.equal(((await mcp.handlers.craft_delivery_loop_refresh({ launch_id: "launch-ready" })).loop as JsonObject).id, ready.id);
    assert.throws(() => service.deliveryLoopRefresh({ launch_id: "missing" }), /Unknown/); assert.throws(() => service.deliveryLoopGet({ loop_id: " " }), /loop_id/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
