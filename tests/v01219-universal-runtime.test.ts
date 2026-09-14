import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeMemoryRuntime } from "../src/knowledge-memory-runtime.ts";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { VerifiedWorkLoopKernel } from "../src/verified-work-loop.ts";
import { WorkRuntimeModeKernel } from "../src/work-runtime-mode.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v1219-")); const store = await new CraftStore(craftPaths(root)).open();
  store.create("task", "task", { project_id: "project", title: "Goal", goal: "deliver", status: "active" });
  store.create("evidence", "evidence", { confidence: "confirmed", summary: "verified" });
  return { root, store, runtime: new KnowledgeMemoryRuntime(store), modes: new WorkRuntimeModeKernel(store, ["codex-cli", "internal"]), service: new CraftService(store) };
}

test("v0.12.19 makes Knowledge Sources, Memory Ledger, receipts and retrieval selection explicit", async () => {
  const f = await fixture();
  try {
    const builtins = f.runtime.installBuiltins().sources as JsonObject[]; assert.deepEqual(builtins.map((item) => item.id).sort(), ["builtin.evidence-wiki", "builtin.serena-project-knowledge"]);
    assert.equal((f.runtime.installBuiltins().sources as JsonObject[])[0].id, "builtin.evidence-wiki");
    const source = f.runtime.sourceRegister({ source_id: "kefu", kind: "kefu_wiki", label: "Formal wiki", scope_kind: "project", scope_id: "project", locator: "/wiki", content_digest: "sha256:kefu", trust: "verified", access: "read_only" }).source as JsonObject;
    assert.equal((f.runtime.sourceRegister({ source_id: "kefu", kind: "kefu_wiki", label: "Formal wiki", scope_kind: "project", scope_id: "project", locator: "/wiki", content_digest: "sha256:kefu", trust: "verified", access: "read_only" }) as JsonObject).idempotent, true);
    assert.equal((f.runtime.sourceList({ scope_kind: "project", scope_id: "project" }).sources as JsonObject[]).length, 1);
    assert.throws(() => f.runtime.sourceList({ scope_kind: "project" }), /together/);
    assert.throws(() => f.runtime.sourceRegister({ kind: "bad", label: "x", scope_kind: "project", scope_id: "project", locator: "x", content_digest: "x" }), /kind/);
    assert.throws(() => f.runtime.sourceRegister({ kind: "readme", label: "x", scope_kind: "bad", scope_id: "project", locator: "x", content_digest: "x" }), /scope_kind/);
    assert.throws(() => f.runtime.sourceRegister({ kind: "readme", label: "secret=12345678", scope_kind: "project", scope_id: "project", locator: "x", content_digest: "x" }), /credentials/);
    assert.throws(() => f.runtime.sourceTransition({ source_id: source.id, status: "active", reason: "x" }), /unsupported/);

    const working = f.runtime.remember({ memory_id: "working", source_id: source.id, kind: "working", scope_kind: "project", scope_id: "project", content: "Use controlled workflow", sensitivity: "internal" }).memory as JsonObject;
    assert.equal((f.runtime.remember({ memory_id: "working", source_id: source.id, kind: "working", scope_kind: "project", scope_id: "project", content: "Use controlled workflow", sensitivity: "internal" }) as JsonObject).idempotent, true);
    assert.throws(() => f.runtime.remember({ source_id: source.id, kind: "procedural", scope_kind: "project", scope_id: "project", content: "always test" }), /requires Evidence/);
    const procedural = f.runtime.remember({ memory_id: "procedure", source_id: source.id, kind: "procedural", scope_kind: "project", scope_id: "project", content: "Test the changed behavior", confidence: "confirmed", evidence_ids: ["evidence"], valid_until: "2030-01-01T00:00:00.000Z" }).memory as JsonObject;
    assert.throws(() => f.runtime.remember({ source_id: source.id, kind: "working", scope_kind: "project", scope_id: "project", content: "token=secretsecret" }), /credentials/);
    assert.throws(() => f.runtime.transition({ memory_id: working.id, status: "superseded", reason: "new" }), /replacement/);
    const replacement = f.runtime.remember({ memory_id: "replacement", source_id: source.id, kind: "preference", scope_kind: "project", scope_id: "project", content: "Keep changes minimal" }).memory as JsonObject;
    assert.equal((f.runtime.transition({ memory_id: working.id, status: "superseded", replacement_id: replacement.id, reason: "new policy" }).memory as JsonObject).status, "superseded");
    assert.throws(() => f.runtime.transition({ memory_id: procedural.id, status: "active", reason: "x" }), /unsupported/);
    f.store.create("memory_item", "legacy", { scope: "project", content: "legacy", status: "active" });
    assert.equal((f.runtime.compatBind({ binding_id: "legacy-bind", legacy_kind: "memory_item", legacy_id: "legacy", source_id: source.id }).binding as JsonObject).migration_performed, false);
    assert.equal((f.runtime.compatBind({ binding_id: "legacy-bind", legacy_kind: "memory_item", legacy_id: "legacy", source_id: source.id }) as JsonObject).idempotent, true);
    assert.throws(() => f.runtime.compatBind({ legacy_kind: "wrong", legacy_id: "legacy", source_id: source.id }), /unsupported/);

    const keyword = f.runtime.retrievalConfigure({ adapter_id: "keyword", strategy: "keyword" }).adapter as JsonObject;
    assert.equal((f.runtime.retrievalEvaluate({ adapter_id: keyword.id, metrics: { recall: 0, cross_project_leak_count: 0, latency_ms: 0, cost_usd: 0 } }).adapter as JsonObject).status, "eligible");
    assert.throws(() => f.runtime.retrievalConfigure({ strategy: "vector" }), /provider_fingerprint/);
    const vector = f.runtime.retrievalConfigure({ adapter_id: "vector", strategy: "vector", provider_fingerprint: "embed:v1", configuration: { timeout_ms: 100 } }).adapter as JsonObject;
    assert.equal((f.runtime.retrievalEvaluate({ adapter_id: vector.id, metrics: { recall: 0.7, cross_project_leak_count: 1, latency_ms: 2, cost_usd: 0.01 } }).evaluation as JsonObject).verdict, "rejected");
    const vector2 = f.runtime.retrievalConfigure({ adapter_id: "vector-2", strategy: "vector", provider_fingerprint: "embed:v1", configuration: {} }).adapter as JsonObject;
    assert.equal((f.runtime.retrievalEvaluate({ adapter_id: vector2.id, metrics: { recall: 0.9, cross_project_leak_count: 0, latency_ms: 2, cost_usd: 0.01 }, max_latency_ms: 3, max_cost_usd: 0.02 }).adapter as JsonObject).status, "eligible");
    assert.throws(() => f.runtime.retrievalEvaluate({ adapter_id: vector2.id, metrics: { recall: 2, cross_project_leak_count: 0, latency_ms: 0, cost_usd: 0 } }), /invalid/);

    const resolved = f.runtime.resolve({ receipt_id: "context", query: "controlled workflow", scope_kind: "project", scope_id: "project", memory_ids: [replacement.id], retrieval_adapter_id: vector2.id, max_items: 3, max_chars: 200 }) as JsonObject;
    assert.equal((resolved.receipt as JsonObject).retrieval_mode, "vector"); assert.equal((resolved.items as JsonObject[]).length, 1);
    assert.equal((f.runtime.resolve({ receipt_id: "context", query: "controlled workflow", scope_kind: "project", scope_id: "project", memory_ids: [replacement.id], retrieval_adapter_id: vector2.id, max_items: 3, max_chars: 200 }) as JsonObject).idempotent, true);
    assert.throws(() => f.runtime.resolve({ query: "x", scope_kind: "project", scope_id: "other", memory_ids: [replacement.id] }), /unavailable/);
    assert.throws(() => f.runtime.resolve({ query: "workflow", scope_kind: "project", scope_id: "project", memory_ids: [procedural.id], max_chars: 1 }), /exceeds/);
    assert.equal((f.runtime.receiptGet({ receipt_id: "context" }).receipt as JsonObject).content_free, true);
    f.runtime.sourceTransition({ source_id: source.id, status: "disabled", reason: "off" });
    assert.throws(() => f.runtime.remember({ source_id: source.id, kind: "working", scope_kind: "project", scope_id: "project", content: "blocked" }), /not active/);
    assert.equal((f.runtime.get({ memory_id: procedural.id }).memory as JsonObject).kind, "procedural");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.19 keeps Console and Agent mode as a mode-neutral plan over verified work", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.modes.configure({ mode: "bad", allowed_hosts: [] }), /unsupported/);
    assert.throws(() => f.modes.configure({ mode: "console", allowed_hosts: ["missing"] }), /unavailable/);
    const consoleProfile = f.modes.configure({ profile_id: "console", mode: "console", allowed_hosts: ["codex-cli"], default_host: "codex-cli" }).profile as JsonObject;
    assert.equal((f.modes.configure({ profile_id: "console", mode: "console", allowed_hosts: ["codex-cli"], default_host: "codex-cli" }) as JsonObject).idempotent, true);
    assert.throws(() => f.modes.configure({ mode: "agent", allowed_hosts: ["internal"] }), /requires default_model/);
    const agent = f.modes.configure({ profile_id: "agent", mode: "agent", allowed_hosts: ["internal"], default_host: "internal", default_model: "provider:model" }).profile as JsonObject;
    f.store.create("activation_profile", "profile", { task_id: "task", status: "recommended" }); f.store.create("context_resolution_receipt", "receipt", { content_free: true });
    const consolePlan = f.modes.prepare({ plan_id: "console-plan", task_id: "task", profile_id: consoleProfile.id, context_receipt_id: "receipt" }).plan as JsonObject;
    assert.equal(consolePlan.host, "codex-cli");
    assert.equal((f.modes.prepare({ plan_id: "agent-plan", task_id: "task", profile_id: agent.id, activation_profile_id: "profile", context_receipt_id: "receipt" }).plan as JsonObject).model, "provider:model");
    assert.throws(() => f.modes.prepare({ task_id: "task", profile_id: consoleProfile.id, host: "internal" }), /not allowed/);
    assert.throws(() => f.modes.prepare({ task_id: "task", profile_id: agent.id, activation_profile_id: "missing" }), /Unknown/);
    assert.equal((f.modes.get({ plan_id: "console-plan" }).plan as JsonObject).execution_authority, false);

    const loop = new VerifiedWorkLoopKernel(f.store); f.store.create("task_control_contract", "contract", { task_id: "task" }); f.store.create("task_run", "run", { contract_id: "contract" }); f.store.create("state_snapshot", "snapshot", { workspace_id: "workspace", snapshot_digest: "sha256:one", workspace_state_revision: 1 });
    assert.equal((loop.create({ work_loop_id: "loop", task_id: "task", contract_id: "contract", task_run_id: "run", snapshot_id: "snapshot" }).loop as JsonObject).phase, "prepare");
    f.store.create("task_run_state", "running", { task_run_id: "run", status: "running", action: "host", actor: "host" });
    assert.equal((loop.advance({ work_loop_id: "loop", task_run_state_id: "running", snapshot_id: "snapshot" }).loop as JsonObject).phase, "act");
    assert.equal((loop.decide({ work_loop_id: "loop", decision: "accept", actor: "human", summary: "accepted" }).decision as JsonObject).decision, "accept");
    assert.equal((loop.get({ work_loop_id: "loop" }).protocol as JsonObject).current_phase, "learn");
    f.store.create("verified_work_loop", "legacy-observation", { task_run_id: "run", workspace_id: "workspace", latest_snapshot_id: "snapshot", lifecycle: "active" });
    f.store.create("task_run_state", "legacy-delivery", { task_run_id: "run", status: "ready_for_delivery", action: "host", actor: "host" });
    assert.equal((loop.advance({ work_loop_id: "legacy-observation", task_run_state_id: "legacy-delivery", snapshot_id: "snapshot" }).loop as JsonObject).phase, "deliver");
    f.store.create("verified_work_loop", "legacy-decision", { lifecycle: "active" });
    assert.equal((loop.get({ work_loop_id: "legacy-decision" }).protocol as JsonObject).current_phase, "prepare");
    assert.equal((loop.decide({ work_loop_id: "legacy-decision", decision: "approve", actor: "human", summary: "approved" }).decision as JsonObject).decision, "approve");
    assert.equal((loop.get({ work_loop_id: "legacy-decision" }).protocol as JsonObject).current_phase, "act");
    const mcp = new McpServer(f.service, "full");
    for (const [name, args] of [["craft_knowledge_memory_install_builtins", {}], ["craft_work_runtime_mode_configure", { profile_id: "mcp-console", mode: "console", allowed_hosts: ["codex-cli"], default_host: "codex-cli" }]] as [string, JsonObject][]) {
      const response = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: args } }); assert.equal((response?.result as JsonObject).isError, false, name);
    }
    assert.equal(new McpServer(f.service, "core").tools.some((tool) => tool.name === "craft_context_resolution_resolve"), true);
    assert.equal(VERSION, "0.12.20");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.19 fails closed for untrusted, stale, restricted, malformed and drifting runtime facts", async () => {
  const f = await fixture();
  try {
    const trusted = f.runtime.sourceRegister({ source_id: "trusted", kind: "readme", label: "README", scope_kind: "project", scope_id: "project", locator: "README.md", content_digest: "sha256:readme", trust: "bounded", access: "read_only" }).source as JsonObject;
    const untrusted = f.runtime.sourceRegister({ source_id: "untrusted", kind: "custom", label: "untrusted", scope_kind: "project", scope_id: "project", locator: "custom", content_digest: "sha256:custom", trust: "untrusted", access: "proposal_only" }).source as JsonObject;
    assert.equal((f.runtime.sourceList().sources as JsonObject[]).length, 2);
    assert.throws(() => f.runtime.sourceRegister({ source_id: "trusted", kind: "readme", label: "changed", scope_kind: "project", scope_id: "project", locator: "README.md", content_digest: "sha256:readme", trust: "bounded", access: "read_only" }), /conflict/);
    assert.throws(() => f.runtime.sourceRegister({ kind: "readme", label: "x", scope_kind: "project", scope_id: "project", locator: "x", content_digest: "x", trust: "bad" }), /trust/);
    assert.throws(() => f.runtime.sourceRegister({ kind: "readme", label: "x", scope_kind: "project", scope_id: "project", locator: "x", content_digest: "x", access: "write" }), /access/);
    assert.equal((f.runtime.sourceTransition({ source_id: untrusted.id, status: "revoked", reason: "withdrawn" }).source as JsonObject).status, "revoked");

    assert.throws(() => f.runtime.remember({ source_id: trusted.id, kind: "bad", scope_kind: "project", scope_id: "project", content: "x" }), /kind/);
    assert.throws(() => f.runtime.remember({ source_id: trusted.id, kind: "working", scope_kind: "project", scope_id: "project", content: "x", sensitivity: "bad" }), /sensitivity/);
    assert.throws(() => f.runtime.remember({ source_id: trusted.id, kind: "working", scope_kind: "bad", scope_id: "project", content: "x" }), /scope_kind/);
    assert.throws(() => f.runtime.remember({ source_id: trusted.id, kind: "working", scope_kind: "project", scope_id: "project", content: "x", confidence: "bad" }), /confidence/);
    assert.throws(() => f.runtime.remember({ source_id: trusted.id, kind: "working", scope_kind: "project", scope_id: "project", content: "x", confidence: "confirmed" }), /requires Evidence/);
    assert.throws(() => f.runtime.remember({ source_id: trusted.id, kind: "working", scope_kind: "project", scope_id: "project", content: "x", evidence_ids: ["missing"] }), /Unknown/);
    assert.throws(() => f.runtime.remember({ source_id: trusted.id, kind: "working", scope_kind: "project", scope_id: "project", content: "x", valid_until: "never" }), /ISO/);
    const normal = f.runtime.remember({ memory_id: "normal", source_id: trusted.id, kind: "working", scope_kind: "project", scope_id: "project", content: "normal information" }).memory as JsonObject;
    const restricted = f.runtime.remember({ memory_id: "restricted", source_id: trusted.id, kind: "preference", scope_kind: "project", scope_id: "project", content: "restricted information", sensitivity: "restricted" }).memory as JsonObject;
    const otherScope = f.runtime.remember({ memory_id: "other", source_id: trusted.id, kind: "working", scope_kind: "task", scope_id: "task", content: "other" }).memory as JsonObject;
    assert.throws(() => f.runtime.transition({ memory_id: normal.id, status: "superseded", replacement_id: otherScope.id, reason: "wrong scope" }), /same scope/);
    assert.equal((f.runtime.transition({ memory_id: otherScope.id, status: "expired", reason: "finished" }).memory as JsonObject).status, "expired");
    assert.equal((f.runtime.transition({ memory_id: normal.id, status: "revoked", reason: "withdrawn" }).memory as JsonObject).status, "revoked");
    f.store.create("episodic_memory", "episode", { content: "old" }); f.store.create("semantic_memory", "semantic", { content: "old" });
    assert.ok((f.runtime.compatBind({ legacy_kind: "episodic_memory", legacy_id: "episode", source_id: trusted.id }).binding as JsonObject).id);
    assert.ok((f.runtime.compatBind({ legacy_kind: "semantic_memory", legacy_id: "semantic", source_id: trusted.id }).binding as JsonObject).id);

    assert.throws(() => f.runtime.retrievalConfigure({ strategy: "bad" }), /unsupported/);
    assert.throws(() => f.runtime.retrievalConfigure({ strategy: "keyword", configuration: [] }), /object/);
    assert.throws(() => f.runtime.retrievalConfigure({ strategy: "keyword", configuration: { token: "abcdefgh" } }), /credentials/);
    const keyword = f.runtime.retrievalConfigure({ adapter_id: "keyword-2", strategy: "keyword" }).adapter as JsonObject;
    assert.equal((f.runtime.retrievalConfigure({ adapter_id: "keyword-2", strategy: "keyword" }) as JsonObject).idempotent, true);
    assert.throws(() => f.runtime.retrievalConfigure({ adapter_id: "keyword-2", strategy: "vector", provider_fingerprint: "x" }), /conflict/);
    assert.throws(() => f.runtime.retrievalEvaluate({ adapter_id: keyword.id, metrics: {} }), /invalid/);
    assert.throws(() => f.runtime.retrievalEvaluate({ adapter_id: keyword.id, metrics: { recall: 0, cross_project_leak_count: 0, latency_ms: 0, cost_usd: 0 }, minimum_recall: 2 }), /thresholds/);
    assert.equal((f.runtime.retrievalEvaluate({ evaluation_id: "keyword-eval", adapter_id: keyword.id, metrics: { recall: 0, cross_project_leak_count: 0, latency_ms: 0, cost_usd: 0 } }).evaluation as JsonObject).verdict, "eligible");
    assert.equal((f.runtime.retrievalEvaluate({ evaluation_id: "keyword-eval", adapter_id: keyword.id, metrics: { recall: 0, cross_project_leak_count: 0, latency_ms: 0, cost_usd: 0 } }) as JsonObject).idempotent, true);
    assert.throws(() => f.runtime.retrievalEvaluate({ evaluation_id: "keyword-eval", adapter_id: keyword.id, metrics: { recall: 1, cross_project_leak_count: 0, latency_ms: 0, cost_usd: 0 } }), /conflict/);

    assert.throws(() => f.runtime.resolve({ query: "token=abcdefgh", scope_kind: "project", scope_id: "project" }), /credentials/);
    assert.throws(() => f.runtime.resolve({ query: "x", scope_kind: "project", scope_id: "project", now: "never" }), /ISO/);
    assert.throws(() => f.runtime.resolve({ query: "x", scope_kind: "project", scope_id: "project", max_items: 0 }), /budget/);
    assert.throws(() => f.runtime.resolve({ query: "x", scope_kind: "project", scope_id: "project", source_ids: ["untrusted"] }), /Source/);
    assert.throws(() => f.runtime.resolve({ query: "x", scope_kind: "project", scope_id: "project", memory_ids: [restricted.id] }), /unavailable/);
    const allowed = f.runtime.resolve({ receipt_id: "restricted-ok", query: "restricted", scope_kind: "project", scope_id: "project", source_ids: [trusted.id], memory_ids: [restricted.id], allow_restricted: true, max_items: 1, max_chars: 100 }) as JsonObject;
    assert.equal((allowed.items as JsonObject[])[0].sensitivity, "restricted");
    assert.throws(() => f.runtime.resolve({ receipt_id: "restricted-ok", query: "different", scope_kind: "project", scope_id: "project", source_ids: [trusted.id], memory_ids: [restricted.id], allow_restricted: true, max_items: 1, max_chars: 100 }), /conflict/);
    f.runtime.sourceTransition({ source_id: trusted.id, status: "disabled", reason: "maintenance" });
    assert.throws(() => f.runtime.resolve({ query: "normal", scope_kind: "project", scope_id: "project", source_ids: [trusted.id] }), /Source/);

    assert.throws(() => f.modes.configure({ mode: "console", allowed_hosts: "codex-cli" as unknown as string[] }), /array/);
    assert.throws(() => f.modes.configure({ mode: "console", allowed_hosts: ["codex-cli", "codex-cli"] }), /unique/);
    assert.throws(() => f.modes.configure({ mode: "console", allowed_hosts: ["codex-cli"], default_host: "internal" }), /allowed/);
    const bare = f.modes.configure({ profile_id: "bare", mode: "console", allowed_hosts: [] }).profile as JsonObject;
    assert.throws(() => f.modes.prepare({ task_id: "task", profile_id: bare.id }), /host/);
    const console = f.modes.configure({ profile_id: "console-2", mode: "console", allowed_hosts: ["codex-cli"], default_host: "codex-cli" }).profile as JsonObject;
    assert.throws(() => f.modes.configure({ profile_id: "console-2", mode: "console", allowed_hosts: ["codex-cli"], default_host: "codex-cli", default_model: "extra" }), /conflict/);
    const plan = f.modes.prepare({ plan_id: "plan", task_id: "task", profile_id: console.id, model: "optional" }).plan as JsonObject;
    assert.equal((f.modes.prepare({ plan_id: "plan", task_id: "task", profile_id: console.id, model: "optional" }) as JsonObject).idempotent, true);
    assert.throws(() => f.modes.prepare({ plan_id: "plan", task_id: "task", profile_id: console.id, model: "different" }), /conflict/);
    f.store.create("task", "other-task", { title: "other" }); f.store.create("activation_profile", "other-profile", { task_id: "other-task" });
    assert.throws(() => f.modes.prepare({ task_id: "task", profile_id: console.id, activation_profile_id: "other-profile" }), /another Task/);
    assert.equal((f.modes.get({ plan_id: plan.id, version: 1 }).plan as JsonObject).id, "plan");

    const generatedSource = f.runtime.sourceRegister({ kind: "project_note", label: "generated", scope_kind: "project", scope_id: "project", locator: "note.md", content_digest: "sha256:note", trust: "verified", access: "read_only" }).source as JsonObject;
    const generatedMemory = f.runtime.remember({ source_id: generatedSource.id, kind: "episodic", scope_kind: "project", scope_id: "project", content: "alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha" }).memory as JsonObject;
    f.runtime.remember({ memory_id: "alpha-two", source_id: generatedSource.id, kind: "episodic", scope_kind: "project", scope_id: "project", content: "alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha" });
    assert.match(String(generatedSource.id), /^knowledge_source_/); assert.match(String(generatedMemory.id), /^memory_ledger_/);
    assert.throws(() => f.runtime.remember({ memory_id: generatedMemory.id, source_id: generatedSource.id, kind: "episodic", scope_kind: "project", scope_id: "project", content: "changed" }), /conflict/);
    assert.throws(() => f.runtime.compatBind({ binding_id: "compat-conflict", legacy_kind: "memory_item", legacy_id: "missing", source_id: generatedSource.id }), /Unknown/);
    f.store.create("memory_item", "compat", { content: "compat" }); f.runtime.compatBind({ binding_id: "compat-conflict", legacy_kind: "memory_item", legacy_id: "compat", source_id: generatedSource.id });
    assert.throws(() => f.runtime.compatBind({ binding_id: "compat-conflict", legacy_kind: "memory_item", legacy_id: "compat", source_id: trusted.id }), /conflict/);
    const nested = f.runtime.retrievalConfigure({ strategy: "vector", provider_fingerprint: "nested", configuration: { nested: ["safe"] } }).adapter as JsonObject;
    const fallback = f.runtime.resolve({ query: "alpha", scope_kind: "project", scope_id: "project", retrieval_adapter_id: nested.id, max_items: 1, max_chars: 5 }) as JsonObject;
    assert.equal((fallback.receipt as JsonObject).retrieval_mode, "keyword"); assert.equal((fallback.receipt as JsonObject).omitted_count, 2);
    const keywordResult = f.runtime.resolve({ query: "alpha", scope_kind: "project", scope_id: "project", source_ids: [generatedSource.id], max_items: 2, max_chars: 200 }) as JsonObject;
    assert.equal((keywordResult.items as JsonObject[])[0].reason, "keyword_overlap");
    f.runtime.retrievalEvaluate({ adapter_id: nested.id, metrics: { recall: 1, cross_project_leak_count: 0, latency_ms: 0, cost_usd: 0 } });
    assert.equal(((f.runtime.resolve({ query: "alpha", scope_kind: "project", scope_id: "project", retrieval_adapter_id: nested.id, max_items: 1, max_chars: 200 }) as JsonObject).items as JsonObject[])[0].reason, "evaluated_vector_adapter");
    assert.equal(((f.runtime.resolve({ query: "!!!", scope_kind: "project", scope_id: "project" }) as JsonObject).items as JsonObject[]).length, 0);
    assert.throws(() => f.runtime.resolve({ query: "x", scope_kind: "project", scope_id: "project", source_ids: "generated" as unknown as string[] }), /array/);
    assert.throws(() => f.runtime.resolve({ query: "x", scope_kind: "project", scope_id: "project", source_ids: [String(generatedSource.id), String(generatedSource.id)] }), /unique/);
    assert.throws(() => f.runtime.sourceTransition({ source_id: "", status: "disabled", reason: "x" }), /empty/);
    assert.equal((f.runtime.get({ memory_id: generatedMemory.id, version: 1 }).memory as JsonObject).id, generatedMemory.id);
    assert.equal((f.runtime.receiptGet({ receipt_id: (keywordResult.receipt as JsonObject).id as string, version: 1 }).receipt as JsonObject).id, (keywordResult.receipt as JsonObject).id);
    const autoPlan = f.modes.prepare({ task_id: "task", profile_id: console.id }).plan as JsonObject; assert.match(String(autoPlan.id), /^work_runtime_plan_/);
    f.store.create("work_runtime_mode", "agent-without-model", { mode: "agent", allowed_hosts: ["internal"], default_host: "internal", default_model: null });
    assert.throws(() => f.modes.prepare({ task_id: "task", profile_id: "agent-without-model" }), /requires a model/);

    assert.ok((f.service.knowledgeMemoryInstallBuiltins().sources as JsonObject[]).length > 0);
    const facadeSource = f.service.knowledgeSourceRegister({ source_id: "facade-source", kind: "readme", label: "facade", scope_kind: "project", scope_id: "project", locator: "README.facade", content_digest: "sha256:facade", trust: "verified", access: "read_only" }).source as JsonObject;
    assert.ok((f.service.knowledgeSourceList({ scope_kind: "project", scope_id: "project" }).sources as JsonObject[]).some((item) => item.id === facadeSource.id));
    const facadeMemory = f.service.memoryLedgerRemember({ memory_id: "facade-memory", source_id: facadeSource.id, kind: "working", scope_kind: "project", scope_id: "project", content: "facade context" }).memory as JsonObject;
    f.store.create("memory_item", "facade-legacy", { content: "legacy" }); assert.ok((f.service.memoryLedgerCompatBind({ legacy_kind: "memory_item", legacy_id: "facade-legacy", source_id: facadeSource.id }).binding as JsonObject).id);
    const facadeRetrieval = f.service.retrievalAdapterConfigure({ adapter_id: "facade-keyword", strategy: "keyword" }).adapter as JsonObject;
    assert.equal((f.service.retrievalAdapterEvaluate({ adapter_id: facadeRetrieval.id, metrics: { recall: 0, cross_project_leak_count: 0, latency_ms: 0, cost_usd: 0 } }).adapter as JsonObject).status, "eligible");
    const facadeResolution = f.service.contextResolutionResolve({ receipt_id: "facade-resolution", query: "facade", scope_kind: "project", scope_id: "project", memory_ids: [facadeMemory.id] }) as JsonObject;
    assert.equal((f.service.contextResolutionGet({ receipt_id: (facadeResolution.receipt as JsonObject).id as string }).receipt as JsonObject).id, "facade-resolution");
    assert.equal((f.service.memoryLedgerTransition({ memory_id: facadeMemory.id, status: "expired", reason: "done" }).memory as JsonObject).status, "expired");
    assert.equal((f.service.knowledgeSourceTransition({ source_id: facadeSource.id, status: "disabled", reason: "done" }).source as JsonObject).status, "disabled");
    const facadeMode = f.service.workRuntimeModeConfigure({ profile_id: "facade-mode", mode: "console", allowed_hosts: ["codex-cli"], default_host: "codex-cli" }).profile as JsonObject;
    const facadePlan = f.service.workRuntimeModePrepare({ plan_id: "facade-plan", task_id: "task", profile_id: facadeMode.id }).plan as JsonObject;
    assert.equal((f.service.workRuntimeModeGet({ plan_id: facadePlan.id }).plan as JsonObject).id, facadePlan.id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
