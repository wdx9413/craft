import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture(name: string) {
  const root = join(tmpdir(), `craft-capability-canary-${name}-${process.pid}-${Date.now()}`); await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store); const mcp = new McpServer(service, "full");
  const evidence = service.evidenceRecord({ evidence_id: `e-${name}`, source_type: "runtime", confidence: "confirmed", claim: "Observed result" });
  const baseline = store.create("capability_asset", `baseline-${name}`, { asset_type: "adapter", effect: "read_only", health: "healthy" });
  const candidate = store.create("capability_asset", `candidate-${name}`, { asset_type: "adapter", effect: "read_only", health: "healthy" });
  const publication = store.create("contract_publication", `publication-${name}`, { status: "active", asset_id: candidate.id, asset_version: candidate.version });
  return { root, store, service, mcp, evidence, baseline, candidate, publication };
}
const thresholds = { max_failure_rate_delta: 0, max_cost_ratio: 1.2, max_latency_ratio: 1.2, max_correction_rate_delta: 0 };

test("Capability Canary routes sticky traffic and halts evidence-backed regressions", async () => {
  const f = await fixture("regression");
  try {
    const started = await f.mcp.handlers.craft_capability_canary_start({ canary_id: "canary", publication_id: f.publication.id,
      baseline_asset_id: f.baseline.id, baseline_asset_version: f.baseline.version, allocation_percent: 50, min_samples_per_arm: 1, thresholds });
    const canary = started.canary as JsonObject; let baselineKey = ""; let candidateKey = "";
    for (let index = 0; index < 100 && (!baselineKey || !candidateKey); index += 1) {
      const key = `key-${index}`; const route = await f.mcp.handlers.craft_capability_canary_route({ canary_id: canary.id, routing_key: key });
      if (route.arm === "baseline") baselineKey = key; else candidateKey = key;
    }
    assert.ok(baselineKey && candidateKey); assert.deepEqual(await f.mcp.handlers.craft_capability_canary_route({ canary_id: canary.id, routing_key: candidateKey }),
      await f.mcp.handlers.craft_capability_canary_route({ canary_id: canary.id, routing_key: candidateKey }));
    const before = await f.mcp.handlers.craft_capability_canary_evaluate({ canary_id: canary.id }); assert.equal(before.ready, false);
    const sample = { canary_id: canary.id, evidence_ids: [f.evidence.id] };
    await f.mcp.handlers.craft_capability_canary_observe({ ...sample, sample_id: "base", arm: "baseline", outcome: "passed", cost: 10, latency_ms: 100 });
    const candidate = await f.mcp.handlers.craft_capability_canary_observe({ ...sample, sample_id: "candidate", arm: "candidate", outcome: "failed", cost: 20, latency_ms: 200, corrected: true });
    assert.equal((await f.mcp.handlers.craft_capability_canary_observe({ ...sample, sample_id: "candidate", arm: "candidate", outcome: "failed", cost: 20, latency_ms: 200, corrected: true })).idempotent, true);
    assert.equal((candidate.sample as JsonObject).corrected, true);
    const result = await f.mcp.handlers.craft_capability_canary_evaluate({ canary_id: canary.id });
    assert.equal(result.regression, true); assert.equal(result.rollback_recommended, true); assert.equal((result.canary as JsonObject).status, "halted");
    assert.equal((await f.mcp.handlers.craft_capability_canary_route({ canary_id: canary.id, routing_key: candidateKey })).arm, "baseline");
    assert.equal((await f.mcp.handlers.craft_capability_canary_evaluate({ canary_id: canary.id })).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Capability Canary promotes only comparable, sufficiently sampled non-regressions and fails closed", async () => {
  const f = await fixture("safe");
  try {
    const generated = f.service.capabilityCanaryStart({ publication_id: f.publication.id, baseline_asset_id: f.baseline.id,
      baseline_asset_version: f.baseline.version, allocation_percent: 10, min_samples_per_arm: 1, thresholds }).canary as JsonObject;
    assert.match(String(generated.id), /^capability_canary_/u);
    for (const arm of ["baseline", "candidate"]) f.service.capabilityCanaryObserve({ canary_id: generated.id, sample_id: arm, arm,
      outcome: "passed", cost: 1, latency_ms: 1, corrected: false, evidence_ids: [f.evidence.id] });
    const result = f.service.capabilityCanaryEvaluate({ canary_id: generated.id }); assert.equal(result.regression, false);
    assert.equal((result.canary as JsonObject).status, "ready_for_promotion");
    const paused = f.store.create("contract_publication", "paused", { status: "rolled_back", asset_id: f.candidate.id, asset_version: f.candidate.version });
    assert.throws(() => f.service.capabilityCanaryStart({ publication_id: paused.id, baseline_asset_id: f.baseline.id,
      baseline_asset_version: f.baseline.version, allocation_percent: 10, min_samples_per_arm: 1, thresholds }), /active/);
    const incompatible = f.store.create("capability_asset", "incompatible", { asset_type: "tool", effect: "destructive" });
    assert.throws(() => f.service.capabilityCanaryStart({ publication_id: f.publication.id, baseline_asset_id: incompatible.id,
      baseline_asset_version: incompatible.version, allocation_percent: 10, min_samples_per_arm: 1, thresholds }), /comparable/);
    for (const [field, value] of [["allocation_percent", 0], ["min_samples_per_arm", 1.5]]) assert.throws(() => f.service.capabilityCanaryStart({
      publication_id: f.publication.id, baseline_asset_id: f.baseline.id, baseline_asset_version: f.baseline.version,
      allocation_percent: 10, min_samples_per_arm: 1, thresholds, [field]: value }), /between|integer/);
    assert.throws(() => f.service.capabilityCanaryStart({ publication_id: f.publication.id, baseline_asset_id: f.baseline.id,
      baseline_asset_version: f.baseline.version, allocation_percent: 10, min_samples_per_arm: 1, thresholds: [] }), /object/);
    const running = f.service.capabilityCanaryStart({ canary_id: "errors", publication_id: f.publication.id, baseline_asset_id: f.baseline.id,
      baseline_asset_version: f.baseline.version, allocation_percent: 10, min_samples_per_arm: 2, thresholds }).canary as JsonObject;
    assert.throws(() => f.service.capabilityCanaryRoute({ canary_id: running.id, routing_key: " " }), /routing_key/);
    assert.throws(() => f.service.capabilityCanaryObserve({ canary_id: running.id, sample_id: "x", arm: "other", outcome: "passed", cost: 1, latency_ms: 1, evidence_ids: [f.evidence.id] }), /arm/);
    assert.throws(() => f.service.capabilityCanaryObserve({ canary_id: running.id, sample_id: "x", arm: "baseline", outcome: "passed", cost: 1, latency_ms: 1, evidence_ids: [] }), /Evidence/);
    assert.throws(() => f.service.capabilityCanaryObserve({ canary_id: running.id, sample_id: "x", arm: "baseline", outcome: "maybe", cost: 1, latency_ms: 1, evidence_ids: [f.evidence.id] }), /outcome/);
    f.service.capabilityCanaryObserve({ canary_id: running.id, sample_id: "x", arm: "baseline", outcome: "passed", cost: 1, latency_ms: 1, evidence_ids: [f.evidence.id] });
    assert.throws(() => f.service.capabilityCanaryObserve({ canary_id: running.id, sample_id: "x", arm: "baseline", outcome: "failed", cost: 1, latency_ms: 1, evidence_ids: [f.evidence.id] }), /idempotency/);
    f.store.save("capability_canary", String(running.id), { ...running, status: "halted" });
    assert.throws(() => f.service.capabilityCanaryObserve({ canary_id: running.id, sample_id: "y", arm: "baseline", outcome: "passed", cost: 1, latency_ms: 1, evidence_ids: [f.evidence.id] }), /not accepting/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
