import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beginHookRuntimeDiagnostic } from "../core/interfaces/codex-hook-runtime-diagnostics.ts";
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
      error_type: "E".repeat(100) });
    recorder.finish({ error_type: "ignored" });
    const records = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 2);
    assert.deepEqual({ phase: records[1]!.phase, duration_ms: records[1]!.duration_ms, process_elapsed_ms: records[1]!.process_elapsed_ms,
      input_read_ms: records[1]!.input_read_ms, input_parse_ms: records[1]!.input_parse_ms, input_bytes: records[1]!.input_bytes,
      rules_load_ms: records[1]!.rules_load_ms, runtime_import_ms: records[1]!.runtime_import_ms,
      store_open_ms: records[1]!.store_open_ms, service_open_ms: records[1]!.service_open_ms,
      handler_ms: records[1]!.handler_ms, output_write_ms: records[1]!.output_write_ms, store_close_ms: records[1]!.store_close_ms,
      outcome: records[1]!.outcome, error_code: records[1]!.error_code, error_type: records[1]!.error_type },
    { phase: "finished", duration_ms: 13, process_elapsed_ms: 100, input_read_ms: 1, input_parse_ms: 3, input_bytes: 2048, rules_load_ms: 3, runtime_import_ms: 3,
      store_open_ms: 4, service_open_ms: 5, handler_ms: 8, output_write_ms: 0, store_close_ms: 3,
      outcome: "failed", error_code: "STORAGE_BUSY", error_type: "E".repeat(80) });
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Hook diagnostics tolerate optional session IDs and clamp negative durations", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-diagnostics-"));
  try {
    const recorder = beginHookRuntimeDiagnostic({ data_root: root, request_id: "request-2", member: "memory", event: "Stop",
      now: () => 5, wall_clock: () => "2026-10-25T00:00:00Z" });
    recorder.finish({ process_elapsed_ms: -5, input_read_ms: -4, input_parse_ms: -3, input_bytes: -9, rules_load_ms: -1, runtime_import_ms: -1, store_open_ms: -4, service_open_ms: -2, handler_ms: -2,
      output_write_ms: -1, store_close_ms: -6, outcome: "failed", error_code: "E".repeat(100), error_type: "" });
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
  } finally { await rm(root, { recursive: true, force: true }); }
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
    await symlink(elsewhere, join(root, "trace"));
    assert.throws(() => beginHookRuntimeDiagnostic({ data_root: root, request_id: "request-3", member: "experience", event: "SessionStart" }),
      /regular directories/u);
    await rm(join(root, "trace"));
    await mkdir(join(root, "trace", "hook-runtime", "v1"), { recursive: true });
    const shard = createHash("sha256").update("request-4").digest()[0]!.toString(16).padStart(2, "0");
    await symlink(join(elsewhere, "outside.jsonl"), join(root, "trace", "hook-runtime", "v1", `${shard}.jsonl`));
    assert.throws(() => beginHookRuntimeDiagnostic({ data_root: root, request_id: "request-4", member: "knowledge", event: "PostToolUse" }),
      /regular file/u);
  } finally { await rm(root, { recursive: true, force: true }); await rm(elsewhere, { recursive: true, force: true }); }
});
