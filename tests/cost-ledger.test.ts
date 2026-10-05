import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CostLedgerKernel } from "../core/cost-ledger.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { TOOLS } from "../core/mcp/tool-catalog.ts";
import { payload, stableDigest } from "../core/digest.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-cost-ledger-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, costs: new CostLedgerKernel(store), async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("cost ledger rejects missing, coerced and unsafe metrics before writing", async () => {
  const f = await fixture();
  try {
    const tool = TOOLS.find((item) => item.name === "craft_cost_usage_record");
    assert.ok(tool); assert.deepEqual(tool.inputSchema.required, ["provider", "model", "input_tokens", "output_tokens"]);
    const price = { provider: "local", model: "fixture", input_per_million: 1, output_per_million: 2 };
    for (const field of ["input_per_million", "output_per_million"]) {
      for (const value of [undefined, null, false, true, "0", "", [], {}, -1, NaN, Infinity]) {
        assert.throws(() => f.costs.priceSave({ ...price, [field]: value }), /prices/);
      }
    }
    assert.equal(f.store.list("provider_price", 100).length, 0);
    f.costs.priceSave(price);
    const usage = { provider: "local", model: "fixture", input_tokens: 1, output_tokens: 2 };
    for (const field of ["input_tokens", "output_tokens"]) {
      for (const value of [undefined, null, false, true, "0", "", [], {}, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => f.costs.usageRecord({ ...usage, [field]: value }), /token counts/);
      }
    }
    assert.equal(f.store.list("usage_ledger", 100).length, 0);
  } finally { await f.close(); }
});

test("cost ledger keeps explicit zero and scoped totals distinct from missing metrics", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.costs.report(), { entries: [], total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, truncated: false, unavailable_metrics: [] });
    assert.throws(() => f.costs.usageRecord({ provider: "none", model: "none", input_tokens: 0, output_tokens: 0 }), /No provider price/);
    const price = f.costs.priceSave({ provider: "local", model: "fixture", input_per_million: 0, output_per_million: 0 }).price as JsonObject;
    const updated = f.costs.priceSave({ provider: "local", model: "fixture", price_id: price.id, input_per_million: 1, output_per_million: 2, effective_at: "2026-01-01T00:00:00Z" }).price as JsonObject;
    assert.equal(updated.id, price.id); assert.equal(updated.effective_at, "2026-01-01T00:00:00Z");
    const zero = f.costs.usageRecord({ provider: "local", model: "fixture", input_tokens: 0, output_tokens: 0 }).usage as JsonObject;
    assert.equal(zero.cost_usd, 0); assert.equal(zero.project_id, null); assert.equal(zero.task_id, null);
    const usage = f.costs.usageRecord({ usage_id: "scoped", provider: "local", model: "fixture", input_tokens: 1000, output_tokens: 500, project_id: "project", task_id: "task" }).usage as JsonObject;
    assert.equal(usage.cost_usd, 0.002); assert.equal(usage.price_id, price.id);
    assert.deepEqual(f.costs.report({ project_id: "project" }), { entries: [usage], total_cost_usd: 0.002, total_input_tokens: 1000, total_output_tokens: 500, truncated: false, unavailable_metrics: [] });
    assert.equal((f.costs.report({ project_id: "other" }).entries as JsonObject[]).length, 0);
    // Preserve the historical record, but do not silently fill its missing metrics.
    f.store.create("usage_ledger", "legacy", {});
    const report = f.costs.report(); assert.equal((report.entries as JsonObject[]).length, 3); assert.equal(report.total_cost_usd, null);
    assert.deepEqual(report.unavailable_metrics, ["cost_usd", "input_tokens", "output_tokens"]);
  } finally { await f.close(); }
});

test("cost report marks each invalid historical metric unavailable without changing records", async (t) => {
  const f = await fixture();
  try {
    const valid = { cost_usd: 0.5, input_tokens: 2, output_tokens: 3 };
    for (const key of ["cost_usd", "input_tokens", "output_tokens"]) {
      const invalid = [undefined, null, false, "0", [], {}, -1, NaN, Infinity];
      if (key !== "cost_usd") invalid.push(0.5, Number.MAX_SAFE_INTEGER + 1);
      for (const value of invalid) {
        const entry = { ...valid, [key]: value };
        const list = t.mock.method(f.store, "list", () => [entry]);
        const report = f.costs.report();
        assert.equal(report[`total_${key}`], null); assert.deepEqual(report.unavailable_metrics, [key]);
        for (const other of Object.keys(valid).filter((field) => field !== key)) assert.equal(report[`total_${other}`], valid[other as keyof typeof valid]);
        assert.deepEqual(report.entries, [entry]); list.mock.restore();
      }
    }
    const historical = f.store.create("usage_ledger", "legacy-partial", { project_id: "old", input_tokens: 1, output_tokens: 2 });
    const before = f.store.get("usage_ledger", "legacy-partial");
    assert.equal(f.costs.report({ project_id: "old" }).total_cost_usd, null);
    assert.equal(f.costs.report({ project_id: "other" }).total_cost_usd, 0);
    assert.deepEqual(f.store.get("usage_ledger", "legacy-partial"), before); assert.equal(before.id, historical.id);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("cost report does not return overflowed cost or unsafe token sums", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 2; index += 1) f.store.create("usage_ledger", `large-${index}`, {
      cost_usd: Number.MAX_VALUE, input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER,
    });
    const report = f.costs.report();
    assert.equal(report.total_cost_usd, null); assert.equal(report.total_input_tokens, null); assert.equal(report.total_output_tokens, null);
    assert.deepEqual(report.unavailable_metrics, ["cost_usd", "input_tokens", "output_tokens"]);
  } finally { await f.close(); }
});

test("cost report distinguishes an exact limit from a truncated project ledger", async () => {
  const f = await fixture();
  try {
    f.store.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) f.store.create("usage_ledger", `row-${index}`, { project_id: "project", cost_usd: 1, input_tokens: 1, output_tokens: 1 });
      f.store.create("usage_ledger", "other-project", { project_id: "other", cost_usd: 9, input_tokens: 9, output_tokens: 9 });
    });
    const exact = f.costs.report({ project_id: "project" });
    assert.equal(exact.total_cost_usd, 10_000); assert.equal(exact.truncated, false); assert.deepEqual(exact.unavailable_metrics, []);
    f.store.create("usage_ledger", "overflow-project", { project_id: "project", cost_usd: 1, input_tokens: 1, output_tokens: 1 });
    const truncated = f.costs.report({ project_id: "project" });
    assert.equal((truncated.entries as JsonObject[]).length, 10_000); assert.equal(truncated.truncated, true);
    assert.equal(truncated.total_cost_usd, null); assert.equal(truncated.total_input_tokens, null); assert.equal(truncated.total_output_tokens, null);
    assert.deepEqual(truncated.unavailable_metrics, ["cost_usd", "input_tokens", "output_tokens"]);
    assert.equal(f.costs.report({ project_id: "other" }).total_cost_usd, 9);
  } finally { await f.close(); }
});

test("cost ledger refuses non-finite calculated costs without partial writes", async () => {
  const f = await fixture();
  try {
    f.costs.priceSave({ provider: "local", model: "fixture", input_per_million: Number.MAX_VALUE, output_per_million: 0 });
    assert.throws(() => f.costs.usageRecord({ provider: "local", model: "fixture", input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 }), /cost.*finite/);
    assert.equal(f.store.list("usage_ledger", 100).length, 0);
    const finite = f.costs.usageRecord({ provider: "local", model: "fixture", input_tokens: 2, output_tokens: 0 }).usage as JsonObject;
    assert.equal(finite.cost_usd, (2 / 1_000_000) * Number.MAX_VALUE);
    f.costs.priceSave({ provider: "local", model: "fixture", input_per_million: Number.MIN_VALUE, output_per_million: 0 });
    const tiny = f.costs.usageRecord({ provider: "local", model: "fixture", input_tokens: 1_000_000, output_tokens: 0 }).usage as JsonObject;
    assert.equal(tiny.cost_usd, Number.MIN_VALUE);
  } finally { await f.close(); }
});

test("usage pins the exact historical price version and content across price updates", async () => {
  const f = await fixture();
  try {
    const config = { provider: "local", model: "fixture", price_id: "pinned-price", input_per_million: 1, output_per_million: 2, effective_at: "2026-01-01T00:00:00Z" };
    const firstPrice = f.costs.priceSave(config).price as JsonObject;
    const input = { provider: "local", model: "fixture", input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const first = f.costs.usageRecord({ ...input, usage_id: "first" }).usage as JsonObject;
    assert.equal(first.price_version, firstPrice.version); assert.equal(first.price_digest, stableDigest(payload(firstPrice)));
    const secondPrice = f.costs.priceSave({ ...config, input_per_million: 5, output_per_million: 6 }).price as JsonObject;
    const second = f.costs.usageRecord({ ...input, usage_id: "second", price_version: 999, price_digest: "forged" }).usage as JsonObject;
    assert.equal(second.price_version, secondPrice.version); assert.equal(second.price_digest, stableDigest(payload(secondPrice)));
    assert.notEqual(first.price_digest, second.price_digest);
    for (const usage of [first, second]) {
      const bound = f.store.get("provider_price", String(usage.price_id), Number(usage.price_version));
      assert.equal(stableDigest(payload(bound)), usage.price_digest);
      assert.equal(usage.cost_usd, Number(bound.input_per_million) + Number(bound.output_per_million));
    }
    assert.equal(first.cost_usd, 3); assert.equal(second.cost_usd, 11);
    assert.deepEqual(f.store.get("usage_ledger", "first"), first);
    const legacy = f.store.create("usage_ledger", "unbound", { cost_usd: 2, input_tokens: 1, output_tokens: 1, price_id: "pinned-price" });
    f.costs.report(); assert.deepEqual(f.store.get("usage_ledger", "unbound"), legacy);
    assert.equal(legacy.price_version, undefined); assert.equal(legacy.price_digest, undefined);
  } finally { await f.close(); }
});

test("usage refuses malformed historical price rates before creating a ledger record", async () => {
  const f = await fixture();
  try {
    for (const key of ["input_per_million", "output_per_million"]) {
      for (const value of [undefined, null, "0", false, -1, [], {}]) {
        f.store.save("provider_price", "legacy-price", { provider: "local", model: "fixture", input_per_million: 1, output_per_million: 2, [key]: value });
        const stored = f.store.get("provider_price", "legacy-price");
        assert.throws(() => f.costs.usageRecord({ provider: "local", model: "fixture", input_tokens: 1, output_tokens: 1 }), /prices/);
        assert.equal(f.store.list("usage_ledger", 100).length, 0);
        assert.deepEqual(f.store.get("provider_price", "legacy-price"), stored);
      }
    }
  } finally { await f.close(); }
});
