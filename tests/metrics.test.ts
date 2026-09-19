import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultHooks } from "../src/hooks.ts";
import { McpServer } from "../src/mcp.ts";
import { MetricsKernel, usageTokens } from "../src/metrics.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";

const ISO = (offsetMs: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), `craft-metrics-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, kernel: new MetricsKernel(store) };
}

test("an empty store reports zero samples instead of a perfect score", async () => {
  const f = await fixture();
  try {
    const report = f.kernel.report();
    assert.equal(report.totals.runs, 0);
    assert.equal(report.totals.success_rate, null);
    assert.equal(report.totals.cost_per_success, null);
    assert.deepEqual(report.by_host, {});
    assert.ok(report.generated_at);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("host runs aggregate status, duration and success rate", async () => {
  const f = await fixture();
  try {
    f.store.create("host_run", "r1", { host: "codex-cli", status: "completed", started_at: ISO(0), finished_at: ISO(1_000) });
    f.store.create("host_run", "r2", { host: "codex-cli", status: "failed", started_at: ISO(0), finished_at: ISO(2_000) });
    f.store.create("host_run", "r3", { host: "internal", status: "completed", started_at: ISO(0), finished_at: ISO(500) });
    // A status Craft does not model must be counted as a sample but not as an outcome.
    f.store.create("host_run", "r4", { host: "internal", status: "weird", started_at: ISO(0), finished_at: ISO(0) });
    // Missing or inverted timestamps contribute no duration rather than a negative one.
    f.store.create("host_run", "r5", { host: "internal", status: "cancelled" });
    f.store.create("host_run", "r6", { host: "internal", status: "interrupted", started_at: ISO(5_000), finished_at: ISO(0) });
    // A run with no host at all is still counted, under a name that says so.
    f.store.create("host_run", "r7", { status: "completed" });

    const report = f.kernel.report();
    assert.equal(report.totals.runs, 7);
    assert.equal(report.totals.completed, 3);
    assert.equal(report.by_host.unknown.runs, 1);
    assert.equal(report.totals.failed, 1);
    assert.equal(report.totals.cancelled, 1);
    assert.equal(report.totals.interrupted, 1);
    assert.equal(report.totals.duration_ms, 3_500);
    assert.ok(report.totals.success_rate !== null && Math.abs(report.totals.success_rate - 3 / 7) < 1e-9);

    assert.equal(report.by_host["codex-cli"].runs, 2);
    assert.equal(report.by_host["codex-cli"].duration_ms, 3_000);
    assert.equal(report.by_host["internal"].runs, 4);
    assert.equal(report.by_host["internal"].duration_ms, 500);
    assert.equal(report.by_host["codex-cli"].success_rate, 0.5);

    const filtered = f.kernel.report({ host: "internal" });
    assert.equal(filtered.totals.runs, 4);
    assert.deepEqual(Object.keys(filtered.by_host), ["internal"]);
    // An explicit null host is treated the same as omitting it.
    assert.equal(f.kernel.report({ host: null }).totals.runs, 7);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("outcomes produce cost per successful outcome", async () => {
  const f = await fixture();
  try {
    f.store.create("outcome", "o1", { verdict: "passed", costs: { cost_usd: 0.3, duration_ms: 100, usage: { total_tokens: 1_000 } } });
    f.store.create("outcome", "o2", { verdict: "failed", costs: { cost_usd: 0.7, usage: { tokens: 2_000 } } });
    // A rejected or malformed costs block must not crash the projection.
    f.store.create("outcome", "o3", { verdict: "passed", costs: "nope" });
    f.store.create("outcome", "o4", { verdict: "passed" });

    const report = f.kernel.report();
    assert.equal(report.totals.outcomes, 4);
    assert.equal(report.totals.passed, 3);
    assert.equal(report.totals.tokens, 3_000);
    assert.ok(Math.abs(report.totals.cost_usd - 1) < 1e-9);
    assert.ok(report.totals.cost_per_success !== null && Math.abs(report.totals.cost_per_success - 1 / 3) < 1e-9);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("usage shapes are tolerated and never invent a number", () => {
  assert.equal(usageTokens(null), 0);
  assert.equal(usageTokens([]), 0);
  assert.equal(usageTokens("x"), 0);
  assert.equal(usageTokens({ total_tokens: 5 }), 5);
  assert.equal(usageTokens({ tokens: 6 }), 6);
  assert.equal(usageTokens({ totalTokens: 7 }), 7);
  assert.equal(usageTokens({ total_tokens: "abc" }), 0);
});

test("the launch gate reports the default gates and honours a blocking one", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    // The default gates are built-ins, so they pass and record why.
    const open = await service.launchGate({ payload: { launch_id: "l1", host: "internal", effect: "read_only" } });
    assert.equal(open.blocked, false);
    assert.equal(open.point, "before_effect");
    assert.equal((open.outcomes as JsonObject[]).length, 2);

    // A fail_closed command hook turns the same payload into a refusal.
    const blocked = await service.launchGate({ payload: { launch_id: "l1" },
      hooks: [{ id: "policy", point: "before_effect", kind: "command", target: "deny-external", fail_policy: "fail_closed" }] });
    assert.equal(blocked.blocked, true);
    assert.match(String((blocked.outcomes as JsonObject[])[0].detail), /external invoker/);

    // A fail_open command hook is recorded but does not stop anything.
    const noted = await service.launchGate({ payload: { launch_id: "l1" },
      hooks: [{ id: "warn", point: "before_effect", kind: "command", target: "note", fail_policy: "fail_open" }] });
    assert.equal(noted.blocked, false);

    // A non-object payload must not be able to smuggle anything in.
    const bare = await service.launchGate({ payload: "nope" });
    assert.equal(bare.blocked, false);
    assert.deepEqual(defaultHooks().map((hook) => `${hook.point}:${hook.target}`).sort(),
      ["after_receipt:builtin:receipt-check", "before_effect:builtin:audit-log", "before_effect:builtin:token-meter"]);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("metrics are reachable over MCP as a read-only projection", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const server = new McpServer(service, "full");
    f.store.create("host_run", "r1", { host: "internal", status: "completed", started_at: ISO(0), finished_at: ISO(1_000) });
    const response = await server.handle({ id: 1, method: "tools/call", params: { name: "craft_metrics_report", arguments: {} } });
    const result = response?.result as JsonObject;
    assert.equal(result.isError, false);
    const report = result.structuredContent as JsonObject;
    assert.equal((report.totals as JsonObject).runs, 1);
    assert.ok(report.by_host);

    const gate = await server.handle({ id: 2, method: "tools/call", params: { name: "craft_launch_gate",
      arguments: { payload: { launch_id: "l1" } } } });
    const gateResult = gate?.result as JsonObject;
    assert.equal(gateResult.isError, false);
    assert.equal((gateResult.structuredContent as JsonObject).blocked, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
