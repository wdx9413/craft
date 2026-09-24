import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { ContextPlaneKernel } from "../core/context-plane.ts";
import { VerifiedAutonomousWorkKernel, SandboxConformanceKernel, TraceExplorerKernel } from "../core/verified-autonomous-work.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v1212-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "task", { project_id: "project", status: "active", title: "Task" });
  store.create("trace", "trace", { task_id: "task", status: "completed", model_fingerprint: "m", environment_fingerprint: "e" });
  store.create("trace_event", "event", { trace_id: "trace", sequence: 1, event_kind: "tool.call", source: "host", trust: "observed", data: { ok: true }, usage: { input_tokens: 2 } });
  const context = new ContextPlaneKernel(store).save({ project_id: "project", task_id: "task", manifest_id: "context", knowledge_refs: [], capability_refs: [], workflow_refs: [], excluded_refs: [], model: "gpt", host: "internal", acceptance_ref: "accept" });
  return { store, service: new CraftService(store), contextId: String((context.manifest as JsonObject).id) };
}

test("v0.12.12 verifies action authorization, re-observation, delivery, handoff and platform admission", async () => {
  const f = await fixture();
  try {
    const kernel = new VerifiedAutonomousWorkKernel(f.store);
    const prepared = kernel.prepare({ work_id: "work", task_id: "task", context_manifest_id: f.contextId, host: "internal", model: "gpt", effect: "read_only", workspace_digest: "sha256:before", action_digest: "sha256:action", acceptance_ref: "accept", budget: { tokens: 100 } });
    assert.equal((prepared.work as JsonObject).status, "prepared");
    assert.equal(kernel.prepare({ work_id: "work", task_id: "task", context_manifest_id: f.contextId, host: "internal", model: "gpt", effect: "read_only", workspace_digest: "sha256:before", action_digest: "sha256:action", acceptance_ref: "accept", budget: { tokens: 100 } }).idempotent, true);
    assert.equal((kernel.authorize({ work_id: "work", authorization_ref: "read" }).work as JsonObject).status, "authorized");
    const action = kernel.recordAction({ work_id: "work", action_contract: { operation: "read" }, idempotency_key: "one", input_digest: "sha256:in", result_digest: "sha256:out", reobserved: true });
    assert.equal((action.receipt as JsonObject).status, "observed");
    assert.equal(kernel.recordAction({ work_id: "work", action_contract: { operation: "read" }, idempotency_key: "one", input_digest: "sha256:in", result_digest: "sha256:out" }).idempotent, true);
    assert.equal(kernel.reobserve({ work_id: "work", observed_digest: "sha256:drift" }).status, "needs_replan");
    assert.equal(kernel.handoff({ work_id: "work", target_host: "claude-code", handoff_id: "handoff" }).idempotent, false);
    assert.equal(kernel.resume({ work_id: "work", context_digest: "sha256:ctx", expected_context_digest: "sha256:ctx", observed_digest: "sha256:after" }).resumed, true);
    assert.equal(kernel.reobserve({ work_id: "work", observed_digest: "sha256:before" }).status, "observed");
    assert.equal((kernel.deliver({ work_id: "work", acceptance_verdict: "failed" }).work as JsonObject).status, "blocked");
    assert.equal(kernel.reobserve({ work_id: "work", observed_digest: "sha256:before" }).status, "observed");
    assert.equal(kernel.deliver({ work_id: "work", acceptance_verdict: "passed", artifact_ids: ["artifact"], evidence_ids: ["evidence"] }).delivered, true);
    assert.equal((kernel.get({ work_id: "work" }).work as JsonObject).status, "delivered");

    const write = kernel.prepare({ work_id: "write", task_id: "task", context_manifest_id: f.contextId, host: "internal", effect: "local_write", workspace_digest: "sha256:w", action_digest: "sha256:a", acceptance_ref: "accept" });
    assert.equal((write.work as JsonObject).effect, "local_write");
    assert.throws(() => kernel.authorize({ work_id: "write", authorization_ref: "w" }), /explicit approval/);
    assert.throws(() => kernel.authorize({ work_id: "write", authorization_ref: "w", approved: true }), /platform profile/);
    assert.equal((kernel.authorize({ work_id: "write", authorization_ref: "w", approved: true, approved_by: "human", platform_profile_id: "sandbox" }).work as JsonObject).status, "authorized");
    assert.throws(() => kernel.resume({ work_id: "write", context_digest: "x", observed_digest: "y" }), /Only paused/);

    const sandbox = new SandboxConformanceKernel(f.store);
    assert.equal(sandbox.admit({ effect: "read_only" }).allowed, true);
    sandbox.save({ profile_id: "sandbox", platform: "windows", isolation: "verified", network: "deny", checks: { fs: true }, verifier: "ci", status: "unverified", capabilities: ["local_write"] });
    assert.throws(() => sandbox.admit({ effect: "local_write", profile_id: "sandbox" }), /does not admit/);
    sandbox.save({ profile_id: "sandbox", platform: "windows", isolation: "verified", network: "deny", checks: { fs: true }, verifier: "ci", status: "verified", capabilities: ["local_write"] });
    assert.equal((sandbox.admit({ effect: "local_write", profile_id: "sandbox" }).profile as JsonObject).platform, "windows");
    assert.equal((sandbox.get({ profile_id: "sandbox" }).profile as JsonObject).status, "verified");
    assert.throws(() => sandbox.admit({ effect: "unknown", profile_id: "sandbox" }), /Unsupported effect/);

    const explorer = new TraceExplorerKernel(f.store);
    assert.equal((explorer.query({ task_id: "task", status: "completed", limit: 5 }).traces as JsonObject[]).length, 1);
    assert.equal(explorer.query({ limit: 5 }).count, 1);

    const service = f.service;
    service.verifiedWorkPrepare({ work_id: "service-work", task_id: "task", context_manifest_id: f.contextId, host: "internal", workspace_digest: "sha256:s", action_digest: "sha256:a", acceptance_ref: "accept" });
    service.verifiedWorkAuthorize({ work_id: "service-work", authorization_ref: "read" });
    service.verifiedWorkAction({ work_id: "service-work", action_contract: { operation: "read" }, idempotency_key: "one", input_digest: "sha256:i", result_digest: "sha256:o" });
    service.verifiedWorkReobserve({ work_id: "service-work", observed_digest: "sha256:s" });
    service.verifiedWorkDeliver({ work_id: "service-work", acceptance_verdict: "passed", artifact_ids: ["a"], evidence_ids: ["e"] });
    service.verifiedWorkGet({ work_id: "service-work" });
    service.verifiedWorkPrepare({ work_id: "service-handoff", task_id: "task", context_manifest_id: f.contextId, host: "internal", workspace_digest: "sha256:s", action_digest: "sha256:a", acceptance_ref: "accept" });
    service.verifiedWorkAuthorize({ work_id: "service-handoff", authorization_ref: "read" });
    service.verifiedWorkHandoff({ work_id: "service-handoff", target_host: "claude-code" });
    service.verifiedWorkResume({ work_id: "service-handoff", context_digest: "sha256:ctx", observed_digest: "sha256:state" });
    service.sandboxConformanceSave({ profile_id: "service-sandbox", platform: "linux", isolation: "verified", network: "deny", checks: {}, verifier: "ci", status: "verified", capabilities: ["local_write"] });
    service.sandboxConformanceAdmit({ effect: "local_write", profile_id: "service-sandbox" }); service.sandboxConformanceGet({ profile_id: "service-sandbox" }); service.traceExplorerQuery({ task_id: "task" });

    const mcp = new McpServer(service, "full");
    const calls: [string, JsonObject][] = [
      ["craft_verified_work_prepare", { work_id: "mcp-work", task_id: "task", context_manifest_id: f.contextId, host: "internal", workspace_digest: "sha256:m", action_digest: "sha256:a", acceptance_ref: "accept" }],
      ["craft_verified_work_authorize", { work_id: "mcp-work", authorization_ref: "read" }],
      ["craft_verified_work_action", { work_id: "mcp-work", action_contract: { operation: "read" }, idempotency_key: "one", input_digest: "sha256:i", result_digest: "sha256:o" }],
      ["craft_verified_work_reobserve", { work_id: "mcp-work", observed_digest: "sha256:m" }],
      ["craft_verified_work_deliver", { work_id: "mcp-work", acceptance_verdict: "passed", artifact_ids: ["a"], evidence_ids: ["e"] }],
      ["craft_verified_work_get", { work_id: "mcp-work" }],
      ["craft_verified_work_prepare", { work_id: "mcp-handoff", task_id: "task", context_manifest_id: f.contextId, host: "internal", workspace_digest: "sha256:h", action_digest: "sha256:a", acceptance_ref: "accept" }],
      ["craft_verified_work_authorize", { work_id: "mcp-handoff", authorization_ref: "read" }],
      ["craft_verified_work_handoff", { work_id: "mcp-handoff", target_host: "claude-code" }],
      ["craft_verified_work_resume", { work_id: "mcp-handoff", context_digest: "sha256:c", observed_digest: "sha256:o" }],
      ["craft_sandbox_conformance_save", { profile_id: "mcp-sandbox", platform: "macos", isolation: "verified", network: "deny", checks: {}, verifier: "ci", status: "verified", capabilities: ["local_write"] }],
      ["craft_sandbox_conformance_admit", { effect: "local_write", profile_id: "mcp-sandbox" }],
      ["craft_sandbox_conformance_get", { profile_id: "mcp-sandbox" }],
      ["craft_trace_explorer_query", { task_id: "task" }],
    ];
    for (const [name, args] of calls) { const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } }); assert.equal((response?.result as JsonObject).isError, false, name); }
  } finally { f.store.close(); }
});

test("v0.12.12 defaults and failure states remain explicit", async () => {
  const f = await fixture();
  try {
    const kernel = new VerifiedAutonomousWorkKernel(f.store);
    assert.throws(() => kernel.prepare({ task_id: null as never, context_manifest_id: f.contextId, host: "internal", workspace_digest: "sha256:w", action_digest: "sha256:a", acceptance_ref: "accept" }), /task_id/);
    assert.throws(() => kernel.prepare({ task_id: "task", context_manifest_id: f.contextId, host: "internal", workspace_digest: "sha256:w", action_digest: "sha256:a", acceptance_ref: "accept", budget: [] as never }), /budget/);
    const prepared = kernel.prepare({ work_id: "defaults", task_id: "task", context_manifest_id: f.contextId, host: "internal", workspace_digest: "sha256:w", action_digest: "sha256:a", acceptance_ref: "accept" });
    assert.equal((prepared.work as JsonObject).model, null);
    assert.equal(kernel.authorize({ work_id: "defaults" }).work !== undefined, true);
    const action = kernel.recordAction({ work_id: "defaults", action_contract: {}, idempotency_key: "k", input_digest: "sha256:i", result_digest: "sha256:o" });
    assert.equal((action.work as JsonObject).status, "running");
    assert.equal(kernel.recordAction({ work_id: "defaults", action_contract: {}, idempotency_key: "k", input_digest: "sha256:i", result_digest: "sha256:o" }).idempotent, true);
    assert.equal(kernel.reobserve({ work_id: "defaults", observed_digest: "sha256:w" }).drifted, false);
    assert.equal((kernel.deliver({ work_id: "defaults", acceptance_verdict: "blocked" }).work as JsonObject).status, "blocked");
    const observed = kernel.prepare({ work_id: "observed", task_id: "task", context_manifest_id: f.contextId, host: "internal", workspace_digest: "sha256:w", action_digest: "sha256:a", acceptance_ref: "accept" });
    kernel.authorize({ work_id: "observed" }); kernel.recordAction({ work_id: "observed", action_contract: {}, idempotency_key: "k", input_digest: "sha256:i", result_digest: "sha256:o" }); kernel.reobserve({ work_id: String((observed.work as JsonObject).id), observed_digest: "sha256:w" });
    assert.throws(() => kernel.deliver({ work_id: "observed", acceptance_verdict: "passed" }), /artifacts/);

    const paused = kernel.prepare({ work_id: "paused", task_id: "task", context_manifest_id: f.contextId, host: "internal", workspace_digest: "sha256:w", action_digest: "sha256:a", acceptance_ref: "accept" });
    f.store.save("verified_work", String((paused.work as JsonObject).id), { ...(paused.work as JsonObject), status: "paused" });
    assert.throws(() => kernel.resume({ work_id: "paused", context_digest: "x", expected_context_digest: "y", observed_digest: "z" }), /replan/);
    assert.equal(kernel.resume({ work_id: "paused", context_digest: "x", observed_digest: "z" }).resumed, true);
    const handoff = kernel.handoff({ work_id: "paused", target_host: "other", handoff_id: "h" });
    assert.equal(kernel.handoff({ work_id: "paused", target_host: "other", handoff_id: "h" }).idempotent, true);
    assert.equal((handoff.work as JsonObject).status, "paused");
    const sandbox = new SandboxConformanceKernel(f.store);
    assert.throws(() => sandbox.save({ platform: "linux", isolation: "verified", network: "deny", checks: [] as never, verifier: "ci" }), /checks/);
    sandbox.save({ profile_id: "defaults-sandbox", platform: "linux", isolation: "verified", network: "deny", checks: {}, verifier: "ci" });
    assert.equal((sandbox.get({ profile_id: "defaults-sandbox" }).profile as JsonObject).status, "unverified");
    assert.throws(() => new TraceExplorerKernel(f.store).query({ limit: 0 }), /between/);
  } finally { f.store.close(); }
});

test("v0.12.12 compatibility kernels cover generated ids and guarded transitions", async () => {
  const f = await fixture();
  try {
    const kernel = new VerifiedAutonomousWorkKernel(f.store);
    const generated = kernel.prepare({ task_id: "task", context_manifest_id: f.contextId, host: "internal", workspace_digest: "sha256:g", action_digest: "sha256:a", acceptance_ref: "accept" });
    assert.match(String((generated.work as JsonObject).id), /^verified_work_/);
    f.store.save("verified_work", String((generated.work as JsonObject).id), { ...generated.work as JsonObject, status: "delivered", action_count: undefined });
    assert.throws(() => kernel.authorize({ work_id: String((generated.work as JsonObject).id), authorization_ref: "r" }), /awaiting/);
    f.store.save("verified_work", String((generated.work as JsonObject).id), { ...generated.work as JsonObject, status: "prepared", action_count: undefined });
    kernel.authorize({ work_id: String((generated.work as JsonObject).id), authorization_ref: "r" });
    assert.throws(() => kernel.recordAction({ work_id: "missing", action_contract: {}, idempotency_key: "x", input_digest: "i", result_digest: "o" }), /Unknown/);
    const action = kernel.recordAction({ work_id: String((generated.work as JsonObject).id), action_contract: {}, idempotency_key: "x", input_digest: "i", result_digest: "o" });
    assert.equal((action.work as JsonObject).action_count, 1);
    f.store.save("verified_work", String((generated.work as JsonObject).id), { ...action.work as JsonObject, status: "delivered" });
    assert.throws(() => kernel.handoff({ work_id: String((generated.work as JsonObject).id), target_host: "other" }), /handoffable/);
    assert.throws(() => kernel.deliver({ work_id: String((generated.work as JsonObject).id), acceptance_verdict: "passed", artifact_ids: [], evidence_ids: [] }), /re-observed/);

    const sandbox = new SandboxConformanceKernel(f.store);
    const profile = sandbox.save({ platform: "linux", isolation: "verified", network: "deny", checks: {}, verifier: "ci" });
    assert.match(String((profile.profile as JsonObject).id), /^sandbox_conformance_linux$/);
    assert.equal(sandbox.admit({ effect: "read_only" }).reason, "portable_read_only");
    const explorer = new TraceExplorerKernel(f.store);
    f.store.create("trace", "trace-empty-fields", { task_id: "task", status: "failed" });
    f.store.create("trace_event", "trace-empty-event", { trace_id: "trace-empty-fields", sequence: 1, event_kind: "done" });
    const rows = explorer.query({ task_id: "task" }).traces as JsonObject[];
    assert.ok(rows.some((row) => String((row.trace as JsonObject).id) === "trace-empty-fields"));
  } finally { f.store.close(); }
});
