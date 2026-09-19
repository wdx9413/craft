import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-intent-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  return { root, store, service: new CraftService(store) };
}

test("generic intent compilation is shared by service and MCP adapters", async () => {
  const f = await fixture();
  try {
    const input = {
      intent_id: "build-intent", goal: "Build a reusable report from the supplied material", workspace: f.root,
      materials: ["brief.md"], non_goals: "Do not publish externally", allowed_effects: ["read_only"],
      host: "internal", model: "standard", budget: { max_tokens: 2_000 }, acceptance: { id: "artifact", method: "program", evaluator: "file", path: "report.md" },
    };
    const first = f.service.intentCompile(input); const intent = first.intent as JsonObject;
    assert.equal(intent.route, "governed"); assert.equal(intent.task_type, "creation"); assert.deepEqual(intent.materials, ["brief.md"]);
    assert.equal(f.service.intentCompile(input).idempotent, true);
    assert.throws(() => f.service.intentCompile({ ...input, goal: "different" }), /idempotency conflict/);
    const acceptance = f.service.acceptanceCompile({ intent_id: intent.id, acceptance_id: "build-acceptance" });
    assert.equal((acceptance.acceptance as JsonObject).criteria instanceof Array, true);
    assert.equal((f.service.acceptanceCompile({ intent_id: intent.id, acceptance_id: "build-acceptance" })).idempotent, true);
    assert.equal((f.service.intentGet({ intent_id: intent.id }).intent as JsonObject).id, intent.id);
    assert.equal((f.service.acceptanceContractGet({ acceptance_id: "build-acceptance" }).acceptance as JsonObject).id, "build-acceptance");
    const mcp = new McpServer(f.service, "core");
    const viaMcp = await mcp.handlers.craft_intent_compile({ intent_id: "mcp-intent", goal: "研究并整理当前方案", require_governance: true });
    assert.equal((viaMcp.intent as JsonObject).route, "governed");
    const generic = f.service.intentCompile({ intent_id: "generic", goal: "研究当前项目并给出结论", require_governance: true }).intent as JsonObject;
    const genericAcceptance = f.service.acceptanceCompile({ intent_id: generic.id }).acceptance as JsonObject;
    assert.equal((genericAcceptance.criteria as JsonObject[])[0].evaluator, "human_confirmation");
    for (const [name, arguments_] of [["craft_intent_compile", { intent_id: "mcp-compiled", goal: "请整理一个可验收的方案" }], ["craft_acceptance_compile", { intent_id: intent.id }], ["craft_intent_get", { intent_id: intent.id }], ["craft_acceptance_contract_get", { acceptance_id: "build-acceptance" }]] as [string, JsonObject][]) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as JsonObject).isError, false);
    }
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("coverage intent compiles an incremental method-level acceptance contract", async () => {
  const f = await fixture();
  try {
    const result = f.service.intentCompile({ intent_id: "coverage-intent", goal: "将增量单元测试覆盖率做到 100%", metric: "methods", scope: "changed", threshold: 100, test_command: "pnpm test", changed_paths: ["src/a.ts"] });
    const intent = result.intent as JsonObject;
    assert.equal(intent.route, "governed"); assert.equal(intent.task_type, "coverage_verification"); assert.equal(intent.metric, "methods");
    const acceptance = f.service.acceptanceCompile({ intent_id: intent.id }).acceptance as JsonObject;
    const criterion = (acceptance.criteria as JsonObject[])[0]; assert.equal(criterion.evaluator, "coverage_report"); assert.equal(criterion.threshold, 100); assert.equal(criterion.scope, "changed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("ambiguous coverage and invalid declarations fail closed", async () => {
  const f = await fixture();
  try {
    const ambiguous = f.service.intentCompile({ intent_id: "ambiguous", goal: "Make coverage 100%" }).intent as JsonObject;
    assert.equal(ambiguous.status, "needs_clarification"); assert.equal((ambiguous.clarifications as JsonObject[])[0].id, "coverage_metric");
    assert.throws(() => f.service.acceptanceCompile({ intent_id: ambiguous.id }), /requires clarification/);
    assert.equal((f.service.intentCompile({ intent_id: "simple", goal: "What is Craft?" }).intent as JsonObject).route, "simple");
    assert.throws(() => f.service.acceptanceCompile({ intent_id: "simple" }), /Simple intents/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-metric", goal: "coverage", metric: "classes" }), /metric is unsupported/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-metric-type", goal: "coverage", metric: 1 }), /metric must not be empty/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-threshold", goal: "coverage", metric: "lines", threshold: 101 }), /threshold must be between/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-threshold-text", goal: "coverage", metric: "lines", threshold: "x" }), /threshold must be between/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-scope", goal: "coverage", metric: "lines", scope: "files" }), /scope is unsupported/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-scope-type", goal: "coverage", metric: "lines", scope: 2 }), /scope must not be empty/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-paths", goal: "coverage", metric: "lines", changed_paths: "src/a.ts" }), /changed_paths must be an array/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-path-item", goal: "coverage", metric: "lines", changed_paths: [""] }), /changed_paths must not be empty/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-workspace", goal: "coverage", metric: "lines", workspace: " " }), /workspace must not be empty/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-acceptance", goal: "coverage", metric: "lines", acceptance: [] }), /acceptance must be an object/);
    assert.throws(() => f.service.intentCompile({ intent_id: "bad-budget", goal: "coverage", metric: "lines", budget: [] }), /budget must be an object/);
    assert.equal((f.service.intentCompile({ intent_id: "specified", goal: "coverage", metric: "lines", scope: "specified" }).intent as JsonObject).status, "needs_clarification");
    assert.equal((f.service.intentCompile({ intent_id: "functions", goal: "function coverage", metric: "functions" }).intent as JsonObject).unit, "function");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
