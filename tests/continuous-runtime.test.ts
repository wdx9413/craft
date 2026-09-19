import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { CraftService } from "../src/service.ts";
import { McpServer } from "../src/mcp.ts";
import { ContextPlaneKernel } from "../src/context-plane.ts";
import { CostLedgerKernel } from "../src/cost-ledger.ts";
import { DomainEvaluatorKernel } from "../src/domain-evaluator.ts";
import { FeedbackLearningKernel } from "../src/feedback-learning.ts";
import { HandoffManifestKernel } from "../src/handoff-manifest.ts";
import { LocalRuntimeServiceKernel } from "../src/local-runtime-service.ts";
import { ProjectBundleKernel } from "../src/project-bundle.ts";
import { ReplayRunnerKernel } from "../src/replay-runner.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v1211-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("project_brain", "brain", { project_id: "project", status: "active", name: "Project" });
  store.create("task", "task", { project_id: "project", status: "active", title: "Task" });
  store.create("trace", "trace", { task_id: "task", status: "completed", model_fingerprint: "m", environment_fingerprint: "e" });
  store.create("trace_event", "trace:1", { trace_id: "trace", sequence: 1, event_kind: "read", action_contract: { effect: "read_only" }, input_refs: [], output_refs: [] });
  store.create("trace_event", "trace:2", { trace_id: "trace", sequence: 2, event_kind: "observe", action_contract: { effect: "read_only" }, input_refs: [], output_refs: [] });
  return { root, store, service: new CraftService(store) };
}

test("v0.12.12 adds the unified context, replay, service, bundle and feedback kernels", async () => {
  const f = await fixture();
  try {
    const context = new ContextPlaneKernel(f.store);
    assert.throws(() => context.save({ project_id: null, task_id: "task" }), /project_id/);
    assert.throws(() => context.save({ project_id: "project", task_id: "" }), /task_id/);
    assert.throws(() => context.save({ project_id: "project", task_id: "task", knowledge_refs: "bad" }), /array/);
    const saved = context.save({ project_id: "project", task_id: "task", manifest_id: "manifest", knowledge_refs: ["k"], capability_refs: ["c"], workflow_refs: ["w"], excluded_refs: ["x"], model: "gpt", host: "internal", acceptance_ref: "accept", selection_rationale: "evidence" });
    assert.equal((saved.manifest as JsonObject).status, "pinned");
    assert.equal(context.save({ project_id: "project", task_id: "task", manifest_id: "manifest", knowledge_refs: ["k"], capability_refs: ["c"], workflow_refs: ["w"], excluded_refs: ["x"], model: "gpt", host: "internal", acceptance_ref: "accept", selection_rationale: "evidence" }).idempotent, true);
    assert.equal((context.get({ manifest_id: "manifest" }).manifest as JsonObject).id, "manifest");
    assert.equal(context.audit({ manifest_id: "manifest" }).status, "ready");
    assert.equal(context.audit({ manifest_id: "manifest", expected_digest: "sha256:drift" }).status, "needs_replan");

    const replay = new ReplayRunnerKernel(f.store);
    assert.throws(() => replay.prepare({ trace_id: "trace", approval_ref: "", workspace_digest: "w" }), /approval_ref/);
    const prepared = replay.prepare({ trace_id: "trace", replay_id: "replay", approval_ref: "human-1", workspace_digest: "sha256:w" });
    assert.equal((prepared.replay as JsonObject).status, "prepared");
    assert.equal(replay.prepare({ trace_id: "trace", replay_id: "replay", approval_ref: "human-1", workspace_digest: "sha256:w" }).idempotent, true);
    const executed = await replay.execute({ replay_id: "replay", approval_ref: "human-1" }, async () => ({ ok: true }));
    assert.equal((executed.replay as JsonObject).status, "completed");
    assert.equal(replay.get({ replay_id: "replay" }).replay !== undefined, true);

    const runtime = new LocalRuntimeServiceKernel(f.store);
    runtime.configure({ service_id: "local", schedule: "minute", startup: "boot", notification: "toast" });
    f.store.create("runtime_wakeup", "wake", { service_id: "local", status: "pending" });
    assert.equal((runtime.start({ service_id: "local" }).service as JsonObject).status, "running");
    assert.equal((runtime.start({ service_id: "local" }).service as JsonObject).status, "running");
    assert.equal((runtime.tick({ service_id: "local", now: "2030-01-01T00:00:00.000Z" }).processed as JsonObject[]).length, 1);
    assert.equal((runtime.stop({ service_id: "local" }).service as JsonObject).status, "stopped");
    assert.equal(runtime.tick({ service_id: "local" }).skipped, true);
    assert.equal(runtime.get({ service_id: "local" }).service !== undefined, true);

    const bundles = new ProjectBundleKernel(f.store);
    const bundle = bundles.export({ project_id: "project", bundle_id: "bundle" });
    assert.equal((bundle.bundle as JsonObject).portable, true);
    assert.equal(bundles.export({ project_id: "project", bundle_id: "bundle" }).idempotent, true);
    assert.equal(bundles.verify({ bundle_id: "bundle" }).valid, true);

    const feedback = new FeedbackLearningKernel(f.store);
    const signal = feedback.record({ signal_id: "signal", scope: "project", project_id: "project", task_id: "task", action: "rewrite", diff_digest: "sha256:diff", reason: "clearer", accepted: true });
    assert.equal((signal.signal as JsonObject).status, "active");
    assert.equal(feedback.record({ signal_id: "signal", scope: "project", project_id: "project", task_id: "task", action: "rewrite", diff_digest: "sha256:diff", reason: "clearer", accepted: true }).idempotent, true);
    assert.equal(feedback.resolve({ signal_id: "signal", project_id: "project" }).status, "reusable");
    assert.equal(feedback.resolve({ signal_id: "signal", project_id: "other", stale: true }).status, "stale");

    const domains = new DomainEvaluatorKernel(f.store);
    domains.save({ evaluator_id: "video", domain: "video", name: "Quality", rules: { consistency: 0.8, rhythm: 0.7 } });
    assert.equal(domains.evaluate({ evaluator_id: "video", metrics: { consistency: 0.9, rhythm: 0.7 } }).verdict, "passed");

    const handoff = new HandoffManifestKernel(f.store);
    const created = handoff.create({ handoff_id: "handoff", task_id: "task", session_id: "session", context_manifest_id: "manifest", host: "claude-code", model: "claude", allowed_effects: ["read_only"], artifact_ids: [], evidence_ids: [], outcome_id: "outcome" });
    assert.equal((created.handoff as JsonObject).status, "ready");
    assert.equal(handoff.create({ handoff_id: "handoff", task_id: "task", session_id: "session", context_manifest_id: "manifest", host: "claude-code", model: "claude", allowed_effects: ["read_only"], artifact_ids: [], evidence_ids: [], outcome_id: "outcome" }).idempotent, true);
    assert.equal(handoff.get({ handoff_id: "handoff" }).handoff !== undefined, true);

    const costs = new CostLedgerKernel(f.store);
    costs.priceSave({ price_id: "price", provider: "openai", model: "gpt", input_per_million: 1, output_per_million: 2 });
    const usage = costs.usageRecord({ usage_id: "usage", provider: "openai", model: "gpt", project_id: "project", task_id: "task", input_tokens: 1000, output_tokens: 500 });
    assert.equal(Number((usage.usage as JsonObject).cost_usd), 0.002);
    assert.equal((costs.report({ project_id: "project" }).entries as JsonObject[]).length, 1);

    const service = f.service;
    service.contextManifestSave({ project_id: "project", task_id: "task", manifest_id: "service-manifest" });
    service.contextManifestGet({ manifest_id: "service-manifest" }); service.contextManifestAudit({ manifest_id: "service-manifest" });
    service.replayRunnerPrepare({ trace_id: "trace", replay_id: "service-replay", approval_ref: "human-1", workspace_digest: "sha256:w" });
    await service.replayRunnerExecute({ replay_id: "service-replay" }); service.replayRunnerGet({ replay_id: "service-replay" });
    service.localRuntimeServiceConfigure({ service_id: "service-local" }); service.localRuntimeServiceStart({ service_id: "service-local" }); service.localRuntimeServiceTick({ service_id: "service-local" }); service.localRuntimeServiceStop({ service_id: "service-local" }); service.localRuntimeServiceGet({ service_id: "service-local" });
    service.projectBundleExport({ project_id: "project", bundle_id: "service-bundle" }); service.projectBundleVerify({ bundle_id: "service-bundle" });
    service.feedbackLearningRecord({ signal_id: "service-signal", action: "review", diff_digest: "sha256:d", reason: "ok" }); service.feedbackLearningResolve({ signal_id: "service-signal" });
    service.domainEvaluatorSave({ evaluator_id: "service-eval", domain: "sales", name: "Accuracy", rules: { accuracy: 0.8 } }); service.domainEvaluatorEvaluate({ evaluator_id: "service-eval", metrics: { accuracy: 0.9 } });
    service.handoffManifestCreate({ handoff_id: "service-handoff", task_id: "task", context_manifest_id: "manifest", host: "internal" }); service.handoffManifestGet({ handoff_id: "service-handoff" });
    service.costPriceSave({ price_id: "service-price", provider: "anthropic", model: "claude", input_per_million: 1, output_per_million: 1 }); service.costUsageRecord({ usage_id: "service-usage", provider: "anthropic", model: "claude", input_tokens: 1, output_tokens: 1 }); service.costLedgerReport();
    assert.equal(service.contextManifestGet({ manifest_id: "manifest" }).manifest !== undefined, true);
    const mcp = new McpServer(service, "full");
    const calls: [string, JsonObject][] = [
      ["craft_context_manifest_save", { project_id: "project", task_id: "task", manifest_id: "mcp-manifest" }],
      ["craft_context_manifest_get", { manifest_id: "manifest" }],
      ["craft_context_manifest_audit", { manifest_id: "manifest" }],
      ["craft_replay_runner_prepare", { trace_id: "trace", replay_id: "mcp-replay", approval_ref: "mcp", workspace_digest: "sha256:m" }],
      ["craft_replay_runner_execute", { replay_id: "mcp-replay" }],
      ["craft_replay_runner_get", { replay_id: "replay" }],
      ["craft_local_service_configure", { service_id: "mcp-local" }],
      ["craft_local_service_start", { service_id: "mcp-local" }],
      ["craft_local_service_tick", { service_id: "mcp-local" }],
      ["craft_local_service_stop", { service_id: "mcp-local" }],
      ["craft_local_service_get", { service_id: "local" }],
      ["craft_project_bundle_export", { project_id: "project", bundle_id: "mcp-bundle" }],
      ["craft_project_bundle_verify", { bundle_id: "bundle" }],
      ["craft_feedback_learning_record", { signal_id: "mcp-signal", action: "review", diff_digest: "sha256:m", reason: "ok" }],
      ["craft_feedback_learning_resolve", { signal_id: "signal", project_id: "project" }],
      ["craft_domain_evaluator_save", { evaluator_id: "mcp-eval", domain: "education", name: "Quality", rules: { accuracy: 0.8 } }],
      ["craft_domain_evaluator_evaluate", { evaluator_id: "video", metrics: { consistency: 0.8, rhythm: 0.8 } }],
      ["craft_handoff_manifest_create", { handoff_id: "mcp-handoff", task_id: "task", context_manifest_id: "manifest", host: "internal" }],
      ["craft_handoff_manifest_get", { handoff_id: "handoff" }],
      ["craft_cost_price_save", { price_id: "mcp-price", provider: "deepseek", model: "deepseek-chat", input_per_million: 1, output_per_million: 1 }],
      ["craft_cost_usage_record", { usage_id: "mcp-usage", provider: "deepseek", model: "deepseek-chat", input_tokens: 1, output_tokens: 1 }],
      ["craft_cost_ledger_report", { project_id: "project" }],
    ];
    for (const [name, args] of calls) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } });
      assert.equal((response?.result as JsonObject).isError, false, name);
    }
  } finally { f.store.close(); }
});

test("v0.12.11 kernels exercise default, invalid and transition branches", async () => {
  const f = await fixture();
  try {
    const context = new ContextPlaneKernel(f.store);
    const defaults = context.save({ project_id: "project", task_id: "task", manifest_id: "defaults" });
    assert.equal((defaults.manifest as JsonObject).model, null);
    assert.equal(context.audit({ manifest_id: "defaults", expected_digest: "sha256:drift" }).status, "needs_replan");
    assert.equal(context.audit({ manifest_id: "defaults", expected_digest: "sha256:drift" }).status, "needs_replan");
    assert.throws(() => context.save({ project_id: "project", task_id: "task", manifest_id: "defaults", model: "changed" }), /idempotency/);

    const replay = new ReplayRunnerKernel(f.store);
    f.store.save("trace", "trace", { ...f.store.get("trace", "trace"), status: "running" });
    assert.throws(() => replay.prepare({ trace_id: "trace", approval_ref: "a", workspace_digest: "w" }), /terminal/);
    f.store.save("trace", "trace", { ...f.store.get("trace", "trace"), status: "completed" });
    assert.throws(() => replay.prepare({ trace_id: "missing", approval_ref: "a", workspace_digest: "w" }), /Unknown/);
    const prepared = replay.prepare({ trace_id: "trace", replay_id: "edge-replay", approval_ref: "a", workspace_digest: "w" });
    assert.throws(() => replay.prepare({ trace_id: "trace", replay_id: "edge-replay", approval_ref: "b", workspace_digest: "w" }), /idempotency/);
    await assert.rejects(() => replay.execute({ replay_id: "edge-replay", approval_ref: "b" }), /does not match/);
    assert.equal((await replay.execute({ replay_id: String((prepared.replay as JsonObject).id) })).idempotent, false);
    assert.equal((await replay.execute({ replay_id: "edge-replay" })).idempotent, true);
    f.store.create("trace", "trace-drift", { task_id: "task", status: "completed", model_fingerprint: "m", environment_fingerprint: "e" });
    f.store.create("trace_event", "trace-drift:1", { trace_id: "trace-drift", sequence: 1, event_kind: "read", action_contract: { effect: "read_only" } });
    replay.prepare({ trace_id: "trace-drift", replay_id: "drift-replay", approval_ref: "a", workspace_digest: "w" });
    f.store.save("trace", "trace-drift", { ...f.store.get("trace", "trace-drift"), status: "failed" });
    await assert.rejects(() => replay.execute({ replay_id: "drift-replay" }), /changed/);

    const runtime = new LocalRuntimeServiceKernel(f.store);
    runtime.configure({ service_id: "local" }); runtime.configure({ service_id: "local", schedule: "hourly" });
    assert.equal(runtime.stop({ service_id: "local" }).idempotent, true);
    runtime.start({ service_id: "local" });
    assert.throws(() => runtime.tick({ service_id: "local", now: "" }), /now/);
    assert.equal((runtime.tick({ service_id: "local", now: "bad" }).service as JsonObject).last_tick_at, "bad");
    f.store.create("runtime_wakeup", "wake-2", { service_id: "local", status: "pending" });
    assert.equal(runtime.tick({ service_id: "local" }).skipped, false);

    const bundles = new ProjectBundleKernel(f.store);
    assert.throws(() => bundles.export({ project_id: "project", limit: 0 }), /between/);
    const bundle = bundles.export({ project_id: "project", bundle_id: "edge-bundle", exported_at: "2030-01-01T00:00:00.000Z" });
    f.store.save("project_bundle", "edge-bundle", { ...(bundle.bundle as JsonObject), bundle_digest: "sha256:drift" });
    assert.equal(bundles.verify({ bundle_id: "edge-bundle" }).valid, false);

    const feedback = new FeedbackLearningKernel(f.store);
    assert.throws(() => feedback.record({ scope: "project", action: "", diff_digest: "d", reason: "r" }), /action/);
    assert.throws(() => feedback.record({ scope: "invalid", action: "x", diff_digest: "d", reason: "r" }), /Unsupported/);
    const global = feedback.record({ signal_id: "global", scope: "global", action: "x", diff_digest: "d", reason: "r" });
    assert.equal(feedback.resolve({ signal_id: String((global.signal as JsonObject).id) }).status, "reusable");
    const taskOnly = feedback.record({ signal_id: "task-only", scope: "task", task_id: "task", action: "x", diff_digest: "d", reason: "r" });
    assert.equal(feedback.resolve({ signal_id: String((taskOnly.signal as JsonObject).id) }).status, "project_only");

    const domains = new DomainEvaluatorKernel(f.store);
    domains.save({ evaluator_id: "edge-domain", domain: "x", name: "X", criteria: { score: 1 } });
    domains.save({ evaluator_id: "edge-domain", domain: "x", name: "X2", criteria: { score: 2 } });
    assert.equal(domains.evaluate({ evaluator_id: "edge-domain", metrics: { score: 1 } }).verdict, "failed");
    assert.equal(domains.evaluate({ evaluator_id: "edge-domain", metrics: {} }).verdict, "failed");

    const handoff = new HandoffManifestKernel(f.store);
    const created = handoff.create({ handoff_id: "edge-handoff", task_id: "task", context_manifest_id: "defaults", host: "internal" });
    assert.equal((created.handoff as JsonObject).session_id, null);
    assert.throws(() => handoff.create({ handoff_id: "edge-handoff", task_id: "other", context_manifest_id: "defaults", host: "internal" }), /idempotency/);

    const costs = new CostLedgerKernel(f.store);
    assert.throws(() => costs.priceSave({ provider: "", model: "m", input_per_million: 1, output_per_million: 1 }), /provider/);
    assert.throws(() => costs.priceSave({ provider: "x", model: "m", input_per_million: -1, output_per_million: 1 }), /non-negative/);
    assert.throws(() => costs.usageRecord({ provider: "x", model: "m" }), /No provider price/);
    assert.deepEqual(costs.report().entries instanceof Array, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
