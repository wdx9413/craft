import test from "node:test";
import assert from "node:assert/strict";
import { commandAblationHost, runAblations } from "../scripts/eval/run-component-ablation.ts";
import { codebaseAdapterPreflight } from "../scripts/codebase/adapter-preflight.ts";
import { fixture } from "./helpers/procedure-invocation-fixture.ts";
import { digestJson } from "../core/digest.ts";
import { prepareContextEvaluationRun } from "./helpers/context-host-evaluation-fixture.ts";

const manifest = { case_ids: Array.from({ length: 20 }, (_, i) => `case-${i}`), environment: { host: "fixture", model: "fixture", repository_revision: "fixture", data_snapshot_digest: "fixture", tool_schema_digest: "fixture", model_fingerprint: "fixture", host_fingerprint: "fixture" }, budget: { tokens: 100 },
  harnesses: { none: "none", knowledge: "k", memory: "m", experience: "e", codebase: "c", all: "all" }, acceptance_ref: "fixture-contract", trials_per_case: 2 };

test("ablation runner preflights, binds real campaign slots and stops for unbound reconciliation", async () => {
  const f = await fixture();
  try {
    assert.equal((await runAblations(f.service, manifest, { async preflight() { return { ready: false }; }, async execute() { throw new Error("must not execute"); } })).status, "blocked");
    assert.equal(f.store.count("eval_campaign"), 0);
    for (const id of manifest.case_ids) f.service.deliveryEvaluationCaseSave({ case_id: id, name: id, domain: "software", partition: "held_out", sanitized: true, approved_by: "synthetic-test-only", acceptance_contract_ref: "fixture-contract" });
    const result = await runAblations(f.service, manifest, { async preflight() { return { ready: true, environment_digest: digestJson(manifest.environment), budget_digest: digestJson(manifest.budget) }; }, async execute(dispatch) {
      if (dispatch.arm === "candidate") throw new Error("host failed with unknown effect");
      const id = String(dispatch.id);
      f.store.create("task_run", id, { environment_digest: digestJson(manifest.environment), budget_digest: digestJson(manifest.budget) }); return id;
    } });
    assert.equal(result.status, "reconciliation_required"); assert.equal(f.store.list("eval_campaign_slot", 1000, slot => slot.status === "bound").length, 1);
    assert.equal((await runAblations(f.service, manifest, { async preflight() { return { ready: true, environment_digest: digestJson(manifest.environment), budget_digest: digestJson(manifest.budget) }; }, async execute() { throw new Error("must not retry"); } })).status, "reconciliation_required");
  } finally { await f.close(); }
});

test("argv adapter validates execution, malformed responses, probes and missing tools without a shell", async () => {
  for (const configuration of [{}, { argv: [] }, { argv: [1] }, { argv: ["node"], timeout_ms: 0 }, { argv: ["node"], timeout_ms: 3600001 }]) assert.throws(() => commandAblationHost(configuration));
  const host = commandAblationHost({ argv: [process.execPath, "-e", 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let x=JSON.parse(s);console.log(JSON.stringify(x.action==="preflight"?{ready:true}:{task_run_id:"run"}))})'] });
  assert.equal((await host.preflight()).ready, true); assert.equal(await host.execute({}, {}, {}), "run");
  const missing = commandAblationHost({ argv: ["/definitely/missing"] }); assert.equal((await missing.preflight()).ready, false); await assert.rejects(missing.execute({}, {}, {}), /failed/);
  const invalid = commandAblationHost({ argv: [process.execPath, "-e", 'console.log("invalid")'], timeout_ms: 1000 }); assert.equal((await invalid.preflight()).ready, false);
  const failed = commandAblationHost({ argv: [process.execPath, "-e", "process.exit(1)"] }); assert.equal((await failed.preflight()).ready, false);
  assert.throws(() => codebaseAdapterPreflight({ invalid: [] })); assert.throws(() => codebaseAdapterPreflight({ invalid: [1] as never }));
  const probes = codebaseAdapterPreflight({ available: [process.execPath, "--version"], failed: [process.execPath, "-e", "process.exit(1)"], missing: ["/missing"] }).languages as any[];
  assert.deepEqual(probes.map(probe => probe.available), [true, false, false]); assert(probes.every(probe => probe.semantic_conformance === "unverified"));
});

test("completed Host calls without terminal delivery Evidence remain unmeasured", async () => {
  const f = await fixture();
  try {
    for (const id of manifest.case_ids) f.service.deliveryEvaluationCaseSave({ case_id: id, name: id, domain: "software", partition: "held_out", sanitized: true, approved_by: "synthetic-test-only", acceptance_contract_ref: "fixture-contract" });
    const host = { async preflight() { return { ready: true, environment_digest: digestJson(manifest.environment), budget_digest: digestJson(manifest.budget) }; }, async execute(dispatch: any) {
      const id = String(dispatch.id); f.store.create("task_run", id, { environment_digest: digestJson(manifest.environment), budget_digest: digestJson(manifest.budget) }); return id;
    } };
    const result = await runAblations(f.service, manifest, host); assert.equal(result.status, "awaiting_actual_outcomes"); assert.equal(result.model_effect_proven, false); assert.equal((result.missing_slot_ids as unknown[]).length, 80);
  } finally { await f.close(); }
});

test("orchestration delegates completed slots to the campaign grader without claiming model benefit", async t => {
  const f = await fixture();
  try {
    for (const id of manifest.case_ids) f.service.deliveryEvaluationCaseSave({ case_id: id, name: id, domain: "software", partition: "held_out", sanitized: true, approved_by: "synthetic-test-only", acceptance_contract_ref: "fixture-contract" });
    t.mock.method(f.service.campaignRunners, "advance", () => ({ campaign: { status: "inconclusive" } }));
    t.mock.method(f.service, "evalCampaignReport", () => ({ status: "synthetic_unmeasured" }));
    const result = await runAblations(f.service, manifest, { async preflight() { return { ready: true, environment_digest: digestJson(manifest.environment), budget_digest: digestJson(manifest.budget) }; }, async execute(dispatch) {
      const id = String(dispatch.id); f.store.create("task_run", id, { launch_id: id, environment_digest: digestJson(manifest.environment), budget_digest: digestJson(manifest.budget) }); f.store.create("work_delivery", id, { launch_id: id, fixture_only: true }); return id;
    } });
    assert.equal(result.status, "graded"); assert.equal((result.results as unknown[]).length, 5); assert.equal(result.model_effect_proven, false);
    const mismatch = await runAblations(f.service, manifest, { async preflight() { return { ready: true, environment_digest: "wrong" }; }, async execute() { throw new Error("must not execute"); } }); assert.equal(mismatch.status, "blocked");
  } finally { await f.close(); }
});

test("execution and adapter CLIs are runnable and keep unavailable providers unmeasured", async () => {
  const { execFileSync } = await import("node:child_process"); const { writeFileSync } = await import("node:fs"); const { join } = await import("node:path");
  const f = await fixture();
  try {
    const script = new URL("../scripts/eval/run-component-ablation.ts", import.meta.url).pathname;
    assert.throws(() => execFileSync(process.execPath, [script], { stdio: "pipe" }));
    const path = join(f.root, "ablation.json"); writeFileSync(path, JSON.stringify({ ...manifest, host_adapter: { argv: [process.execPath, "-e", 'console.log(JSON.stringify({ready:false}))'] } }));
    assert.equal(JSON.parse(execFileSync(process.execPath, [script, join(f.root, "cli-data"), path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).status, "blocked");
    const probes = new URL("../scripts/codebase/adapter-preflight.ts", import.meta.url).pathname;
    assert.equal(JSON.parse(execFileSync(process.execPath, [probes], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).production_verified, false);
  } finally { await f.close(); }
});

test("Host observation adapter binds exact emissions and preserves missing-measurement reconciliation", async t => {
  const f = await fixture();
  try {
    const context = { host: "codex", host_id: "codex-cli", discovery_mode: "full_mcp", protocol_version: "2025-11-25", tool_schema_digest: "schema", definition_ids: ["open"], initial_ids: ["open"], host_fingerprint: "host", model_fingerprint: "model" };
    const input = { ...manifest, context_host_contract: context };
    const preflight = async () => ({ ready: true, environment_digest: digestJson(manifest.environment), budget_digest: digestJson(manifest.budget) });
    await assert.rejects(runAblations(f.service, input, { preflight, async execute() { throw new Error("unused"); } }), /observation adapter/);
    for (const id of manifest.case_ids) f.service.deliveryEvaluationCaseSave({ case_id: id, name: id, domain: "software", partition: "held_out", sanitized: true, approved_by: "synthetic-test-only", acceptance_contract_ref: "fixture-contract" });
    t.mock.method(f.service.campaignRunners, "advance", () => ({ campaign: { status: "inconclusive" } }));
    t.mock.method(f.service, "evalCampaignReport", () => ({ status: "fixture_only" }));
    const observations = new Map<string, any>();
    const host = { preflight, async execute(dispatch: any) {
      const id = String(dispatch.id); const observed = await prepareContextEvaluationRun(f.service, f.root, id, manifest.environment, manifest.budget);
      observations.set(id, observed); f.store.create("work_delivery", id, { launch_id: (observed.task_run as any).launch_id }); return id;
    }, async observeContext(id: string) { return observations.get(id); } };
    const result = await runAblations(f.service, input, host); assert.equal(result.status, "graded"); assert.equal((result.context_emissions as unknown[]).length, 400);
    assert.equal(f.store.list("context_host_observation_pending", 1000, row => row.status === "pending").length, 0);
    const command = commandAblationHost({ argv: [process.execPath, "-e", 'console.log(JSON.stringify({observation:true}))'], observe_context: true });
    assert.equal((await command.observeContext!("run")).observation, true);
    f.store.create("context_host_observation_pending", "unmeasured", { status: "pending" });
    assert.equal((await runAblations(f.service, input, host)).status, "reconciliation_required");
  } finally { await f.close(); }
});

test("lost Context observation never redispatches an already bound Host execution", async () => {
  const f = await fixture();
  try {
    for (const id of manifest.case_ids) f.service.deliveryEvaluationCaseSave({ case_id: id, name: id, domain: "software", partition: "held_out", sanitized: true, approved_by: "synthetic-test-only", acceptance_contract_ref: "fixture-contract" });
    const context = { host: "codex", host_id: "codex-cli", discovery_mode: "full_mcp", protocol_version: "2025-11-25", tool_schema_digest: "schema", definition_ids: ["open"], initial_ids: ["open"], host_fingerprint: "host", model_fingerprint: "model" };
    const input = { ...manifest, context_host_contract: context }; let executions = 0;
    const host = { async preflight() { return { ready: true, environment_digest: digestJson(manifest.environment), budget_digest: digestJson(manifest.budget) }; }, async execute(dispatch: any) { executions++; const id = String(dispatch.id); await prepareContextEvaluationRun(f.service, f.root, id, manifest.environment, manifest.budget); return id; }, async observeContext() { throw new Error("Host observation lost"); } };
    assert.equal((await runAblations(f.service, input, host)).status, "reconciliation_required");
    assert.equal(f.store.list("context_host_observation_pending", 10).length, 1);
    assert.equal((await runAblations(f.service, input, host)).status, "reconciliation_required"); assert.equal(executions, 1);
  } finally { await f.close(); }
});
