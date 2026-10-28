import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextExtensionsKernel, computeCommand, computeEnv } from "../core/context-extensions.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { TOOLS } from "../core/mcp/tool-catalog.ts";
import { CONTEXT_ROUTED_TOOL_NAMES } from "../core/mcp/context-tools.ts";

async function openStore(): Promise<{ store: CraftStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "craft-context-ext-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, root };
}

test("routing render names the compute/capture/search tools", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const byDefault = kernel.renderRouting({});
    assert.equal(byDefault.client, "codex");
    assert.match(String(byDefault.content), /craft_context_compute/u);
    const explicit = kernel.renderRouting({ client: "claude" });
    assert.equal(explicit.client, "claude");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("computeCommand selects a runner for every language/platform pair", () => {
  assert.equal(computeCommand("javascript", "linux", "/w", "/node").command, "/node");
  assert.equal(computeCommand("python", "win32", "/w", "/node").command, "python");
  assert.equal(computeCommand("python", "linux", "/w", "/node").command, "python3");
  assert.equal(computeCommand("shell", "win32", "/w", "/node").command, "powershell");
  assert.equal(computeCommand("shell", "linux", "/w", "/node").command, "/bin/sh");
  assert.equal(computeCommand("javascript", "linux", "/w", "/node").file, join("/w", "main.mjs"));
});

test("computeEnv keeps only the allowlisted environment keys", () => {
  const bare = computeEnv("/tmp/work", {});
  assert.equal(bare.PATH, undefined);
  assert.equal(bare.SystemRoot, undefined);
  const full = computeEnv("/tmp/work", { PATH: "p", SystemRoot: "s", PATHEXT: "e" });
  assert.equal(full.PATH, "p");
  assert.equal(full.SystemRoot, "s");
  assert.equal(full.PATHEXT, "e");
  assert.equal(full.HOME, "/tmp/work");
});

test("ephemeral index records, deduplicates, updates and bounds input", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const first = kernel.recordEphemeral({ session_id: "s1", source: "logs",
      items: [{ id: "a", text: "alpha beta", title: "A" }, { id: "a", text: "alpha beta updated" }] });
    assert.equal(first.item_count, 1);
    const second = kernel.recordEphemeral({ session_id: "s1", source: "logs", items: [{ id: "b", text: "gamma" }] });
    assert.equal(second.item_count, 1);
    const contentOnly = kernel.recordEphemeral({ session_id: "s1", source: "logs", items: [{ content: "delta", source: "inline" }] });
    assert.equal(contentOnly.item_count, 1);
    assert.throws(() => kernel.recordEphemeral({ session_id: "s1", items: [] }), /non-empty array/u);
    assert.throws(() => kernel.recordEphemeral({ session_id: "s1", items: Array.from({ length: 501 }, (_, index) => ({ id: String(index), text: "x" })) }), /item limit/u);
    assert.throws(() => kernel.recordEphemeral({ session_id: "s1", items: [1] }), /object/u);
    assert.throws(() => kernel.recordEphemeral({ session_id: "s1", items: [{ id: "a", text: " " }] }), /items\.text/u);
    assert.throws(() => kernel.recordEphemeral({ session_id: "s1", items: [{ id: "a", text: "x".repeat(400_001) }] }), /character limit/u);
    assert.throws(() => kernel.recordEphemeral({ session_id: "s1", items: [{ id: "a", text: "x" }], ttl_seconds: 0 }), /ttl_seconds/u);
    assert.throws(() => kernel.recordEphemeral({ session_id: "s1", items: [{ id: "a", text: "x" }], now: "nope" }), /ISO timestamp/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("ephemeral search reports missing, expired, matched and unmatched indexes", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    assert.equal(kernel.searchEphemeral({ session_id: "none", query: "alpha" }).reason, "index_missing");
    kernel.recordEphemeral({ session_id: "s2", source: "docs", ttl_seconds: 1, now: "2020-01-01T00:00:00.000Z",
      items: [{ id: "a", text: "alpha beta" }] });
    assert.equal(kernel.searchEphemeral({ session_id: "s2", source: "docs", query: "alpha", now: "2020-01-02T00:00:00.000Z" }).reason, "index_expired");
    kernel.recordEphemeral({ session_id: "s3", source: "docs", items: [{ id: "a", text: "alpha beta" }, { id: "b", text: "gamma" }] });
    const matched = kernel.searchEphemeral({ session_id: "s3", source: "docs", query: "alpha" });
    assert.equal(matched.reason, "matched");
    assert.equal((matched.hits as unknown[]).length, 1);
    assert.equal(kernel.searchEphemeral({ session_id: "s3", source: "docs", query: "zzz" }).reason, "no_match");
    assert.equal(kernel.searchEphemeral({ session_id: "s4", query: "alpha" }).reason, "index_missing");
    assert.throws(() => kernel.searchEphemeral({ session_id: "s3", query: "alpha", limit: 0 }), /limit/u);
    assert.throws(() => kernel.searchEphemeral({ session_id: "s3", query: "" }), /query/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("ephemeral purge removes one source or a whole session", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    kernel.recordEphemeral({ session_id: "s", source: "one", items: [{ id: "a", text: "alpha" }] });
    kernel.recordEphemeral({ session_id: "s", source: "two", items: [{ id: "b", text: "beta" }] });
    assert.equal(kernel.purgeEphemeral({ session_id: "s", source: "one" }).removed, 1);
    assert.equal(kernel.purgeEphemeral({ session_id: "s" }).removed, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("output capture passes small results and indexes large ones", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    assert.equal(kernel.captureOutput({ tool_name: "Read", content: "small" }).action, "pass");
    const indexed = kernel.captureOutput({ tool_name: "Read", content: "x".repeat(9_000) });
    assert.equal(indexed.action, "indexed");
    const withTtl = kernel.captureOutput({ tool_name: "Read", content: "x".repeat(9_000), session_id: "s", ttl_seconds: 60 });
    assert.equal(withTtl.action, "indexed");
    assert.equal(kernel.captureOutput({ content: "x".repeat(9_000) }).action, "indexed");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("compute refuses without consent and bounds its inputs", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    assert.throws(() => kernel.compute({ language: "javascript", code: "1" }), /allow_execution/u);
    assert.throws(() => kernel.compute({ language: "ruby", code: "1", allow_execution: true }), /language/u);
    assert.throws(() => kernel.compute({ language: "javascript", code: "x".repeat(200_001), allow_execution: true }), /source limit/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("compute returns bounded stdout, truncates floods and reports timeouts", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const ok = kernel.compute({ language: "javascript", code: "console.log('hello')", allow_execution: true });
    assert.equal(ok.exit_code, 0);
    assert.equal(String(ok.stdout).trim(), "hello");
    assert.equal(ok.not_a_security_sandbox, true);
    const flood = kernel.compute({ language: "javascript", code: "console.log('x'.repeat(20000))", allow_execution: true, output_limit: 100 });
    assert.equal(flood.stdout_truncated, true);
    const slow = kernel.compute({ language: "javascript", code: "while(true){}", allow_execution: true, timeout_ms: 50 });
    assert.equal(slow.timed_out, true);
    const python = kernel.compute({ language: "python", code: "print(1)", allow_execution: true });
    assert.equal(typeof python.exit_code === "number" || python.exit_code === null, true);
    const shell = kernel.compute({ language: "shell", code: "Write-Output ok", allow_execution: true, timeout_ms: 10_000 });
    assert.equal(typeof shell.exit_code === "number" || shell.exit_code === null, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("resume snapshot checkpoints, reads and projects bounded content", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    assert.equal(kernel.getResume({ session_id: "r" }).resume_available, false);
    assert.equal(kernel.resolveResume({ session_id: "r" }).resume_available, false);
    const created = kernel.checkpointResume({ session_id: "r", scope: "project:p", files_touched: ["a.ts"], tasks: ["finish"], errors: ["boom"], decisions: ["use X"], open_questions: ["next?"] });
    assert.equal(created.content_free, true);
    const updated = kernel.checkpointResume({ session_id: "r", tasks: ["again"] });
    assert.equal(updated.snapshot !== null, true);
    const projected = kernel.resolveResume({ session_id: "r", max_chars: 5 });
    assert.equal(projected.truncated, true);
    const complete = kernel.resolveResume({ session_id: "r", max_chars: 8_000 });
    assert.equal(complete.truncated, false);
    assert.equal(kernel.getResume({ session_id: "r" }).resume_available, true);
    assert.throws(() => kernel.checkpointResume({ session_id: "r", now: "nope" }), /ISO timestamp/u);
    assert.throws(() => kernel.checkpointResume({ session_id: "r", tasks: "nope" }), /tasks/u);
    assert.equal(kernel.checkpointResume({ session_id: "r", tasks: [] }).content_free, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("sparse raw records fall back without fabricating content", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const future = new Date(Date.now() + 60_000).toISOString();
    store.create("context_ephemeral_index", "raw-items", { session_id: "s", source: "raw", expires_at: future,
      items: [{ id: "x", title: "alpha" }, { id: "y", text: "alpha" }] });
    const sparse = kernel.searchEphemeral({ session_id: "s", source: "raw", index_id: "raw-items", query: "alpha" });
    assert.equal(sparse.reason, "matched");
    assert.equal((sparse.hits as unknown[]).length, 2);
    store.create("context_ephemeral_index", "raw-no-items", { session_id: "s", source: "none", expires_at: future, items: "not-an-array" });
    assert.equal(kernel.searchEphemeral({ session_id: "s", source: "none", index_id: "raw-no-items", query: "alpha" }).reason, "no_match");
    const createdResume = kernel.checkpointResume({ session_id: "sparse" });
    store.save("context_resume_snapshot", String(createdResume.resume_id), { session_id: "sparse", files_touched: "not-an-array" });
    const projected = kernel.resolveResume({ session_id: "sparse" });
    assert.equal(projected.content, "");
    store.create("context_resolution_receipt", "empty-receipt", {});
    assert.equal(kernel.stats({}).estimated_tokens, 0);
    store.create("retrieval_adapter", "eligible-adapter", { status: "eligible" });
    store.create("retrieval_adapter", "configured-adapter", { status: "configured" });
    assert.equal(kernel.health({}).ok, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("stats and health summarize existing receipts without reading bodies", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    const empty = kernel.stats({});
    assert.equal(empty.receipts, 0);
    assert.equal((empty.feedback_outcomes as Record<string, number>).helpful, undefined);
    store.create("context_resolution_receipt", "r1", { total_used_chars: 300, omitted_count: 2, deduplicated_count: 1, total_items: 4 });
    store.create("context_working_set_receipt", "w1", {});
    store.create("context_emission", "e1", {});
    store.create("context_feedback", "f1", { outcome: "helpful" });
    store.create("context_feedback", "f2", { outcome: "helpful" });
    store.create("context_feedback", "f3", {});
    const populated = kernel.stats({});
    assert.equal(populated.receipts, 1);
    assert.equal(populated.feedback, 3);
    assert.equal((populated.feedback_outcomes as Record<string, number>).helpful, 2);
    assert.equal(populated.estimated_tokens, 100);
    const health = kernel.health({});
    assert.equal(health.ok, true);
    assert.equal((health.checks as unknown[]).length, 5);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("health fails closed when the store is unavailable", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    store.close();
    const health = kernel.health({});
    assert.equal(health.ok, false);
    assert.equal((health.checks as unknown[]).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("new context tools are registered and mounted on the context product", () => {
  const names = new Set(TOOLS.map((tool) => tool.name));
  for (const name of ["craft_context_routing_render", "craft_context_ephemeral_record", "craft_context_ephemeral_search",
    "craft_context_ephemeral_purge", "craft_context_output_capture", "craft_context_compute", "craft_context_resume_checkpoint",
    "craft_context_resume_get", "craft_context_resume_resolve", "craft_context_stats", "craft_context_health",
    "craft_context_correction_list", "craft_context_correction_decide",
    "craft_codebase_symbol_usage_record", "craft_codebase_symbol_usage_get"]) {
    assert.equal(names.has(name), true, `${name} must be registered`);
    assert.equal(CONTEXT_ROUTED_TOOL_NAMES.has(name), true, `${name} must be on the context product`);
  }
});

test("service delegates the context extension tools", async () => {
  const { store, root } = await openStore();
  try {
    const service = new CraftService(store);
    assert.equal(service.contextExtensionsStats({}).receipts, 0);
    assert.equal(service.contextExtensionsHealth({}).ok, true);
    assert.equal(service.contextExtensionsRenderRouting({}).client, "codex");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("correction tasks can be listed and resolved without changing source status", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    store.create("context_correction_task", "t1", { status: "pending_review", outcome: "incorrect",
      asset_ref: { member: "knowledge", id: "k1", version: 1 } });
    store.create("context_correction_task", "t2", { status: "pending_review", outcome: "stale",
      asset_ref: { member: "memory", id: "m1", version: 1 } });
    assert.equal(kernel.listCorrections({}).count, 2);
    assert.equal(kernel.listCorrections({ member: "memory" }).count, 1);
    assert.throws(() => kernel.listCorrections({ status: "nope" }), /status/u);
    const confirmed = kernel.decideCorrection({ task_id: "t1", decision: "confirmed", reason: "verified" });
    assert.equal(confirmed.changes_source_status, false);
    assert.equal((confirmed.correction as JsonObject).status, "confirmed");
    assert.equal(kernel.decideCorrection({ task_id: "t1", decision: "confirmed" }).idempotent, true);
    assert.throws(() => kernel.decideCorrection({ task_id: "t1", decision: "dismissed" }), /already resolved/u);
    assert.equal(kernel.decideCorrection({ task_id: "t2", decision: "dismissed" }).idempotent, false);
    assert.throws(() => kernel.decideCorrection({ task_id: "t2", decision: "other" }), /decision/u);
    assert.equal(kernel.listCorrections({ status: "confirmed" }).count, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("codebase symbol usage records and reads net per-symbol weights", async () => {
  const { store, root } = await openStore();
  try {
    const kernel = new ContextExtensionsKernel(store);
    kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s1", outcome: "passed" });
    kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s1", outcome: "passed" });
    kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s2", outcome: "failed" });
    kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s3", outcome: "read" });
    kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s4" });
    store.create("codebase_symbol_usage", "raw-usage", { index_id: "i1", symbol_id: "s5", outcome: "passed" });
    store.create("codebase_symbol_usage", "raw-no-symbol", { index_id: "i1", outcome: "passed" });
    store.create("codebase_symbol_usage", "raw-unknown", { index_id: "i1", symbol_id: "s6", outcome: "other" });
    const legacyId = `codebase_symbol_usage_${stableDigest({ index_id: "i1", symbol_id: "s7", outcome: "read", day: "2026-01-01" }).slice(-24)}`;
    store.create("codebase_symbol_usage", legacyId, { index_id: "i1", symbol_id: "s7", outcome: "read", day: "2026-01-01" });
    assert.equal((kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s7", outcome: "read", now: "2026-01-01T00:00:00.000Z" }).usage as JsonObject).count, 2);
    kernel.recordCodebaseUsage({ index_id: "i2", symbol_id: "s1", outcome: "passed" });
    assert.deepEqual(kernel.getCodebaseUsage({ index_id: "i1" }).weights as Array<[string, number]>,
      [["s1", 2], ["s2", -1], ["s3", 0.5], ["s4", 0.5], ["s5", 1], ["s7", 1]]);
    assert.throws(() => kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s1", outcome: "nope" }), /outcome/u);
    assert.throws(() => kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: "s1", now: "nope" }), /timestamp/u);
    assert.throws(() => kernel.recordCodebaseUsage({ index_id: "i1", symbol_id: " " }), /symbol_id/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
