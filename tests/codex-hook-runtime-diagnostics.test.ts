import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { linkDirectory } from "./symlink-support.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beginHookRuntimeDiagnostic, hookStorageFailureDetails } from "../core/interfaces/codex-hook-runtime-diagnostics.ts";
import { queryHookRuntimeDiagnostics } from "../core/interfaces/hook-runtime-query.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("Hook diagnostics leave a content-free start marker and one bounded completion record", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-diagnostics-"));
  try {
    let clock = 10;
    let wall = 0;
    const recorder = beginHookRuntimeDiagnostic({ data_root: root, request_id: "request-1", member: "context",
      event: "UserPromptSubmit", session_id: "session-secret", now: () => clock,
      wall_clock: () => `2026-10-25T00:00:0${wall++}Z` });
    const traceDir = join(root, "trace", "hook-runtime", "v1");
    const shard = createHash("sha256").update("request-1").digest()[0]!.toString(16).padStart(2, "0");
    const path = join(traceDir, `${shard}.jsonl`);
    const started = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, unknown>;
    assert.equal(started.phase, "started");
    assert.equal(started.member, "context");
    assert.equal(started.event, "UserPromptSubmit");
    assert.equal(started.session_hash, createHash("sha256").update("session-secret").digest("hex"));
    assert(!JSON.stringify(started).includes("session-secret"));
    clock = 22.6;
    recorder.finish({ process_elapsed_ms: 100.4, input_read_ms: 1.2, input_parse_ms: 2.6, input_bytes: 2048, rules_load_ms: 3.4, runtime_import_ms: 3.4, store_open_ms: 4.3, service_open_ms: 5.4,
      handler_ms: 7.7, output_write_ms: 0.4, store_close_ms: 3.2, outcome: "failed", error_code: "STORAGE_BUSY",
      error_type: "E".repeat(100), database_role: "primary", database_phase: "transaction_begin", busy_timeout_ms: 100, waited_ms: 103, retryable: true });
    recorder.finish({ error_type: "ignored" });
    const records = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 2);
    assert.deepEqual({ phase: records[1]!.phase, duration_ms: records[1]!.duration_ms, process_elapsed_ms: records[1]!.process_elapsed_ms,
      input_read_ms: records[1]!.input_read_ms, input_parse_ms: records[1]!.input_parse_ms, input_bytes: records[1]!.input_bytes,
      rules_load_ms: records[1]!.rules_load_ms, runtime_import_ms: records[1]!.runtime_import_ms,
      store_open_ms: records[1]!.store_open_ms, service_open_ms: records[1]!.service_open_ms,
      handler_ms: records[1]!.handler_ms, output_write_ms: records[1]!.output_write_ms, store_close_ms: records[1]!.store_close_ms,
      outcome: records[1]!.outcome, error_code: records[1]!.error_code, error_type: records[1]!.error_type,
      database_role: records[1]!.database_role, database_phase: records[1]!.database_phase, busy_timeout_ms: records[1]!.busy_timeout_ms, waited_ms: records[1]!.waited_ms,
      retryable: records[1]!.retryable },
    { phase: "finished", duration_ms: 13, process_elapsed_ms: 100, input_read_ms: 1, input_parse_ms: 3, input_bytes: 2048, rules_load_ms: 3, runtime_import_ms: 3,
      store_open_ms: 4, service_open_ms: 5, handler_ms: 8, output_write_ms: 0, store_close_ms: 3,
      outcome: "failed", error_code: "STORAGE_BUSY", error_type: "E".repeat(80), database_role: "primary", database_phase: "transaction_begin",
      busy_timeout_ms: 100, waited_ms: 103, retryable: true });
    // Windows has no POSIX file mode; the private-file mode is a POSIX guarantee.
    if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hook diagnostics tolerate optional session IDs and clamp negative durations", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-diagnostics-"));
  try {
    const recorder = beginHookRuntimeDiagnostic({ data_root: root, request_id: "request-2", member: "memory", event: "Stop",
      now: () => 5, wall_clock: () => "2026-10-25T00:00:00Z" });
    recorder.finish({ process_elapsed_ms: -5, input_read_ms: -4, input_parse_ms: -3, input_bytes: -9, rules_load_ms: -1, runtime_import_ms: -1, store_open_ms: -4, service_open_ms: -2, handler_ms: -2,
      output_write_ms: -1, store_close_ms: -6, outcome: "failed", error_code: "E".repeat(100), error_type: "",
      database_role: "primary", database_phase: "transaction_begin", busy_timeout_ms: -100, waited_ms: -100, retryable: "yes" as never });
    const files = await readdir(join(root, "trace", "hook-runtime", "v1"));
    const records = (await readFile(join(root, "trace", "hook-runtime", "v1", files[0]!), "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal("session_hash" in records[0]!, false);
    assert.equal(records[1]!.duration_ms, 0);
    assert.equal(records[1]!.store_open_ms, 0);
    assert.equal(records[1]!.input_bytes, 0);
    assert.equal(records[1]!.rules_load_ms, 0);
    assert.equal(records[1]!.runtime_import_ms, 0);
    assert.equal(records[1]!.service_open_ms, 0);
    assert.equal(records[1]!.handler_ms, 0);
    assert.equal(records[1]!.process_elapsed_ms, 0);
    assert.equal(records[1]!.input_read_ms, 0);
    assert.equal(records[1]!.input_parse_ms, 0);
    assert.equal(records[1]!.output_write_ms, 0);
    assert.equal(records[1]!.store_close_ms, 0);
    assert.equal(records[1]!.outcome, "failed");
    assert.equal(records[1]!.error_code, "E".repeat(80));
    assert.equal("error_type" in records[1]!, false);
    assert.equal(records[1]!.database_role, "primary");
    assert.equal(records[1]!.database_phase, "transaction_begin");
    assert.equal("busy_timeout_ms" in records[1]!, false);
    assert.equal("waited_ms" in records[1]!, false);
    assert.equal("retryable" in records[1]!, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hook storage failure details accept only bounded SQLite metadata", () => {
  const error = (safeDetails: unknown) => Object.assign(new Error("database is locked"), { safeDetails });
  assert.deepEqual(hookStorageFailureDetails(error({ database_role: "primary", phase: "transaction_begin", busy_timeout_ms: 100, waited_ms: 103, retryable: true }), "STORAGE_BUSY"),
    { database_role: "primary", database_phase: "transaction_begin", busy_timeout_ms: 100, waited_ms: 103, retryable: true });
  assert.deepEqual(hookStorageFailureDetails(error({ database_role: "capability_partition", phase: "savepoint_operation", busy_timeout_ms: 60_000, retryable: false }), "STORAGE_BUSY"),
    { database_role: "capability_partition", database_phase: "savepoint_operation", busy_timeout_ms: 60_000, retryable: false });
  assert.deepEqual(hookStorageFailureDetails(error({ database_role: "secret", phase: "invalid", busy_timeout_ms: 60_001, retryable: "true" }), "STORAGE_BUSY"), {});
  for (const waited of [-1, 3_600_001, 1.5, "100", null, 0, 3_600_000]) {
    assert.deepEqual(hookStorageFailureDetails(error({ waited_ms: waited }), "STORAGE_BUSY"),
      waited === 0 || waited === 3_600_000 ? { waited_ms: waited } : {});
  }
  assert.deepEqual(hookStorageFailureDetails(error(null), "STORAGE_BUSY"), {});
  assert.deepEqual(hookStorageFailureDetails(null, "STORAGE_BUSY"), {});
  assert.deepEqual(hookStorageFailureDetails(error({ database_role: "primary" }), "OPERATION_FAILED"), {});
});

test("DataSec Hook diagnostics identify the standalone PreToolUse event without content", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-diagnostics-"));
  try {
    const recorder = beginHookRuntimeDiagnostic({ data_root: root, request_id: "datasec-request", member: "datasec", event: "PreToolUse" });
    recorder.finish({ input_bytes: 512, rules_load_ms: 2, handler_ms: 4, outcome: "completed" });
    const files = await readdir(join(root, "trace", "hook-runtime", "v1"));
    const records = (await readFile(join(root, "trace", "hook-runtime", "v1", files[0]!), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records[0].member, "datasec");
    assert.equal(records[0].event, "PreToolUse");
    assert.equal(records[1].input_bytes, 512);
    assert.equal(records[1].rules_load_ms, 2);
    assert.equal(records[1].handler_ms, 4);
    assert.equal(records[1].outcome, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hook diagnostics query pairs completion records and exposes interrupted starts without private payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-query-"));
  try {
    beginHookRuntimeDiagnostic({ data_root: root, request_id: "request-interrupted", member: "context", host: "codex",
      event: "UserPromptSubmit", session_id: "private-session", wall_clock: () => "2026-11-07T10:00:00.000Z" });
    const completed = beginHookRuntimeDiagnostic({ data_root: root, request_id: "request-completed", member: "datasec", host: "claude",
      event: "PreToolUse", wall_clock: () => "2026-11-07T10:01:00.000Z" });
    completed.finish({ outcome: "failed", error_code: "STORAGE_BUSY", handler_ms: 9, database_role: "primary", database_phase: "transaction_begin" });

    const result = queryHookRuntimeDiagnostics({ data_root: root, limit: 10 });

    assert.equal(result.partial, false);
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.map(item => ({ member: item.member, event: item.event, status: item.status })), [
      { member: "datasec", event: "PreToolUse", status: "completed" },
      { member: "context", event: "UserPromptSubmit", status: "unmatched_start" },
    ]);
    assert.equal(result.items[0]!.error_code, "STORAGE_BUSY");
    assert.equal(result.items[0]!.host, "claude");
    assert.equal(result.items[0]!.handler_ms, 9);
    assert.equal(result.items[0]!.database_role, "primary");
    assert.equal(result.items[1]!.host, "codex");
    assert.equal(result.items[0]!.outcome, "failed");
    assert.equal("session_hash" in result.items[1]!, false);
    assert(!JSON.stringify(result).includes("private-session"));
    assert.deepEqual(queryHookRuntimeDiagnostics({ data_root: root, member: "datasec", event: "PreToolUse" }).items.map(item => item.request_id), ["request-completed"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hook diagnostics query handles missing roots, malformed rows, symlinks and invalid filters", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-query-"));
  try {
    assert.deepEqual(queryHookRuntimeDiagnostics({ data_root: join(root, "missing") }), { items: [], partial: false, scanned_files: 0, malformed_rows: 0 });
    assert.equal(queryHookRuntimeDiagnostics({ data_root: "\0" }).partial, true);
    assert.throws(() => queryHookRuntimeDiagnostics({ data_root: root, limit: 0 }), /limit must be an integer/u);
    assert.throws(() => queryHookRuntimeDiagnostics({ data_root: root, member: "unknown" }), /member is not supported/u);
    assert.throws(() => queryHookRuntimeDiagnostics({ data_root: root, event: "unknown" }), /event is not supported/u);

    const directory = join(root, "trace", "hook-runtime", "v1");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "00.jsonl"), "not-json\n");
    await writeFile(join(directory, "03.jsonl"), "{}\n");
    await writeFile(join(directory, "06.jsonl"), "[]\n");
    const validTime = "2026-11-07T10:00:00.000Z";
    const invalidDetails = { request_id: "invalid-details", member: "memory", event: "Stop", phase: "finished", started_at: validTime, finished_at: validTime,
      outcome: "other", error_code: "credential hidden", error_type: "Not Type!", database_role: "unknown", database_phase: "unknown",
      busy_timeout_ms: -1, waited_ms: "long", retryable: "true", duration_ms: -1, process_elapsed_ms: -1, input_read_ms: -1, input_parse_ms: -1,
      input_bytes: -1, rules_load_ms: -1, store_open_ms: -1, runtime_import_ms: -1, service_open_ms: -1, handler_ms: -1, output_write_ms: -1, store_close_ms: -1 };
    await writeFile(join(directory, "04.jsonl"), JSON.stringify(invalidDetails) + "\n");
    await writeFile(join(directory, "05.jsonl"), JSON.stringify({ ...invalidDetails, request_id: "invalid-finished-at", finished_at: "unknown" }) + "\n");
    const validDetails = { ...invalidDetails, request_id: "valid-details", host: "codex", outcome: "skipped", error_code: "SAFE_CODE",
      error_type: "SafeError", database_role: "capability_partition", database_phase: "savepoint_operation", busy_timeout_ms: 60_000,
      waited_ms: 3_600_000, retryable: false, handler_ms: 0 };
    const newerStart = { request_id: "newest-start", member: "memory", event: "Stop", phase: "started", started_at: "2026-11-07T10:02:00.000Z" };
    const olderStart = { ...newerStart, started_at: "2026-11-07T09:00:00.000Z" };
    await writeFile(join(directory, "07.jsonl"), `\n${JSON.stringify(validDetails)}\n${JSON.stringify(newerStart)}\n${JSON.stringify(olderStart)}\n`);
    await writeFile(join(directory, "ignored.txt"), "not a shard\n");
    await writeFile(join(root, "outside.jsonl"), "not read\n");
    await symlink(join(root, "outside.jsonl"), join(directory, "01.jsonl"));
    await mkdir(join(directory, "02.jsonl"));
    const malformed = queryHookRuntimeDiagnostics({ data_root: root });
    assert.equal(malformed.partial, true);
    assert.equal(malformed.malformed_rows, 4);
    assert.equal(malformed.scanned_files, 8);
    const details = malformed.items.find(item => item.request_id === "valid-details");
    assert.equal(details?.host, "codex");
    assert.equal(details?.outcome, "skipped");
    assert.equal(details?.error_code, "SAFE_CODE");
    assert.equal(details?.error_type, "SafeError");
    assert.equal(details?.database_role, "capability_partition");
    assert.equal(details?.database_phase, "savepoint_operation");
    assert.equal(details?.busy_timeout_ms, 60_000);
    assert.equal(details?.waited_ms, 3_600_000);
    assert.equal(details?.retryable, false);
    assert.equal(details?.handler_ms, 0);
    assert.equal(malformed.items.find(item => item.request_id === "newest-start")?.started_at, newerStart.started_at);

    const linkRoot = join(root, "linked");
    await mkdir(linkRoot);
    await symlink(directory, join(linkRoot, "trace"));
    const linked = queryHookRuntimeDiagnostics({ data_root: linkRoot });
    assert.equal(linked.partial, true);
    assert.equal(linked.scanned_files, 0);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); }
});

test("Hook diagnostics query bounds each shard read to a recent tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-query-"));
  try {
    const directory = join(root, "trace", "hook-runtime", "v1");
    await mkdir(directory, { recursive: true });
    const requestId = "recent-tail";
    const shard = createHash("sha256").update(requestId).digest()[0]!.toString(16).padStart(2, "0");
    const path = join(directory, `${shard}.jsonl`);
    const recent = JSON.stringify({ request_id: requestId, member: "context", event: "UserPromptSubmit", phase: "started", started_at: "2026-11-07T10:00:00.000Z" });
    await writeFile(path, "x".repeat(9_000) + "\n" + recent + "\n");
    const result = queryHookRuntimeDiagnostics({ data_root: root });
    assert.equal(result.partial, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.request_id, requestId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hook diagnostics use default clocks and append to an existing shard", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-diagnostics-"));
  try {
    const args = { data_root: root, request_id: "same-request", member: "experience" as const, event: "SessionEnd" as const };
    const first = beginHookRuntimeDiagnostic(args);
    const second = beginHookRuntimeDiagnostic(args);
    first.finish();
    second.finish();
    const directory = join(root, "trace", "hook-runtime", "v1");
    const names = await readdir(directory);
    assert.equal(names.length, 1);
    const lines = (await readFile(join(directory, names[0]!), "utf8")).trim().split("\n");
    assert.equal(lines.length, 4);
    const records = lines.map(line => JSON.parse(line) as JsonObject);
    assert(records.every(record => typeof record.started_at === "string" && !Number.isNaN(Date.parse(String(record.started_at)))));
    assert(records.filter(record => record.phase === "finished").every(record => typeof record.duration_ms === "number"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hook diagnostics reject a data root that is a regular file", async () => {
  const parent = await mkdtemp(join(tmpdir(), "craft-hook-diagnostics-"));
  const rootFile = join(parent, "not-a-directory");
  try {
    await writeFile(rootFile, "file");
    assert.throws(() => beginHookRuntimeDiagnostic({ data_root: rootFile, request_id: "request-file",
      member: "context", event: "SessionStart" }), /regular directories/u);
    assert.throws(() => beginHookRuntimeDiagnostic({ data_root: join(rootFile, "child"), request_id: "request-not-directory",
      member: "context", event: "SessionStart" }));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("Hook diagnostics fail closed on symlinked trace storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-diagnostics-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "craft-hook-diagnostics-target-"));
  try {
    await linkDirectory(elsewhere, join(root, "trace"));
    assert.throws(() => beginHookRuntimeDiagnostic({ data_root: root, request_id: "request-3", member: "experience", event: "SessionStart" }),
      /regular directories/u);
    await rm(join(root, "trace"));
    await mkdir(join(root, "trace", "hook-runtime", "v1"), { recursive: true });
    const shard = createHash("sha256").update("request-4").digest()[0]!.toString(16).padStart(2, "0");
    await linkDirectory(join(elsewhere, "outside.jsonl"), join(root, "trace", "hook-runtime", "v1", `${shard}.jsonl`));
    assert.throws(() => beginHookRuntimeDiagnostic({ data_root: root, request_id: "request-4", member: "knowledge", event: "PostToolUse" }),
      /regular file/u);
  } finally { await rm(root, { recursive: true, force: true }); await rm(elsewhere, { recursive: true, force: true }); }
});
