import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
test("strategy recommendations stay conservative when based on held-out comparisons", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-strategy-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "Choose", goal: "Choose evidence-backed route" }).task as JsonObject;
    const make = (id: string, split = "held_out", assessment = "improved", pass = 1, cost = -1) => store.create("evaluation_comparison", id, { split, assessment, baseline: { pass_rate: 0.5, subject_type: "workflow", subject_id: "old", subject_version: 1 }, candidate: { pass_rate: pass, subject_type: "workflow", subject_id: "new", subject_version: 2 }, comparison: { costs: { cost_usd: { delta: cost } } } });
    const recommended = service.strategyRecommend({ recommendation_id: "good", task_id: task.id, comparison_id: make("good-comparison").id, cost_metric: "cost_usd" }).recommendation as JsonObject; assert.equal(recommended.status, "recommended"); assert.equal(((recommended.selected_subject as JsonObject).id), "new");
    assert.equal((service.strategyRecommend({ recommendation_id: "good", task_id: task.id, comparison_id: "good-comparison", cost_metric: "cost_usd" }) as JsonObject).idempotent, true);
    await assert.rejects(Promise.resolve().then(() => service.strategyRecommend({ recommendation_id: "good", task_id: task.id, comparison_id: "good-comparison" })), /idempotency/);
    for (const [id, split, assessment, pass, cost] of [["nonheld", "development", "improved", 1, -1], ["regressed", "held_out", "regressed", 1, -1], ["quality", "held_out", "improved", 0.4, -1], ["cost", "held_out", "improved", 1, 1]] as const) assert.equal(((service.strategyRecommend({ task_id: task.id, comparison_id: make(id, split, assessment, pass, cost).id, cost_metric: "cost_usd" }).recommendation as JsonObject).status), "insufficient");
    const noCost = service.strategyRecommend({ task_id: task.id, comparison_id: make("no-cost").id }).recommendation as JsonObject; assert.equal(noCost.status, "recommended");
    const mcp = new McpServer(service, "full"); const result = await mcp.handle({ id: "strategy", method: "tools/call", params: { name: "craft_strategy_recommend", arguments: { task_id: task.id, comparison_id: "good-comparison", recommendation_id: "mcp" } } }); assert.equal((result?.result as JsonObject).isError, false);
    assert.equal(VERSION, "0.11.47");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
