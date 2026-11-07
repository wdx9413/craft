import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HookRuntimeEvent, HookRuntimeHost, HookRuntimeMember } from "./codex-hook-runtime-diagnostics.ts";

const MAX_SHARD_BYTES = 8 * 1024;
const MAX_SHARDS = 256;
const MAX_LIMIT = 100;
const MEMBERS = new Set<HookRuntimeMember>(["context", "knowledge", "memory", "experience", "datasec"]);
const EVENTS = new Set<HookRuntimeEvent>(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd", "PreCompact"]);
const TIMINGS = ["duration_ms", "process_elapsed_ms", "input_read_ms", "input_parse_ms", "input_bytes", "rules_load_ms", "store_open_ms",
  "runtime_import_ms", "service_open_ms", "handler_ms", "output_write_ms", "store_close_ms"] as const;

export interface HookDiagnosticEntry {
  readonly request_id: string;
  readonly member: HookRuntimeMember;
  readonly host?: HookRuntimeHost;
  readonly event: HookRuntimeEvent;
  readonly status: "completed" | "unmatched_start";
  readonly started_at: string;
  readonly finished_at?: string;
  readonly outcome?: "completed" | "failed" | "skipped";
  readonly error_code?: string;
  readonly error_type?: string;
  readonly database_role?: "primary" | "capability_partition";
  readonly database_phase?: "transaction_begin" | "transaction_operation" | "savepoint_begin" | "savepoint_operation";
  readonly busy_timeout_ms?: number;
  readonly waited_ms?: number;
  readonly retryable?: boolean;
  readonly [timing: string]: unknown;
}

export interface HookDiagnosticsResult {
  readonly items: HookDiagnosticEntry[];
  readonly partial: boolean;
  readonly scanned_files: number;
  readonly malformed_rows: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function safeIdentifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value.length <= 80 && pattern.test(value);
}

function optionalInteger(row: Record<string, unknown>, key: string, max: number): number | undefined {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

function readTail(path: string): { lines: string[]; partial: boolean } {
  let descriptor: number;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) return { lines: [], partial: true };
    /* c8 ignore next 3 -- deterministic tests cover stable missing/symlink inputs; these branches require an OS race or injected filesystem failure. */
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  }
  catch { return { lines: [], partial: true }; }
  try {
    const stat = fstatSync(descriptor);
    /* c8 ignore next 1 -- only reachable if an external process swaps the file after lstat/open. */
    if (!stat.isFile()) return { lines: [], partial: true };
    const length = Math.min(stat.size, MAX_SHARD_BYTES);
    const buffer = Buffer.alloc(length);
    const count = readSync(descriptor, buffer, 0, length, Math.max(0, stat.size - length));
    let lines = buffer.subarray(0, count).toString("utf8").split("\n");
    if (stat.size > length) lines = lines.slice(1);
    if (lines.at(-1) === "") lines.pop();
    return { lines, partial: stat.size > length };
  } catch { /* c8 ignore next 1 -- disk/read failures need an injected filesystem error. */ return { lines: [], partial: true }; }
  finally { closeSync(descriptor); }
}

function readDirectory(path: string): string[] {
  return readdirSync(path).filter(name => /^[0-9a-f]{2}\.jsonl$/u.test(name)).slice(0, MAX_SHARDS);
}

function safeDirectoryChain(root: string): "ready" | "missing" | "unsafe" {
  let current = resolve(root);
  for (const name of ["", "trace", "hook-runtime", "v1"]) {
    if (name) current = join(current, name);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
    }
  }
  return "ready";
}

function parseDiagnostic(value: unknown): (HookDiagnosticEntry & { phase: "started" | "finished" }) | null {
  const row = record(value);
  if (!row || typeof row.request_id !== "string" || row.request_id.length < 1 || row.request_id.length > 100
    || !MEMBERS.has(row.member as HookRuntimeMember) || !EVENTS.has(row.event as HookRuntimeEvent)
    || !safeDate(row.started_at) || (row.phase !== "started" && row.phase !== "finished")) return null;
  const result: Record<string, unknown> = { request_id: row.request_id, member: row.member, event: row.event, started_at: row.started_at,
    phase: row.phase };
  if (row.host === "codex" || row.host === "claude") result.host = row.host;
  if (row.phase === "finished") {
    if (!safeDate(row.finished_at)) return null;
    result.finished_at = row.finished_at;
    for (const key of TIMINGS) {
      const value = optionalInteger(row, key, key === "input_bytes" ? 64 * 1024 * 1024 : 3_600_000);
      if (value !== undefined) result[key] = value;
    }
    if (row.outcome === "completed" || row.outcome === "failed" || row.outcome === "skipped") result.outcome = row.outcome;
    if (safeIdentifier(row.error_code, /^[A-Z0-9_-]+$/u)) result.error_code = row.error_code;
    if (safeIdentifier(row.error_type, /^[A-Za-z0-9_$]+$/u)) result.error_type = row.error_type;
    if (row.database_role === "primary" || row.database_role === "capability_partition") result.database_role = row.database_role;
    if (["transaction_begin", "transaction_operation", "savepoint_begin", "savepoint_operation"].includes(String(row.database_phase))) result.database_phase = row.database_phase;
    const timeout = optionalInteger(row, "busy_timeout_ms", 60_000);
    const waited = optionalInteger(row, "waited_ms", 3_600_000);
    if (timeout !== undefined) result.busy_timeout_ms = timeout;
    if (waited !== undefined) result.waited_ms = waited;
    if (typeof row.retryable === "boolean") result.retryable = row.retryable;
  }
  return result as HookDiagnosticEntry & { phase: "started" | "finished" };
}

export function queryHookRuntimeDiagnostics(args: {
  readonly data_root: string;
  readonly limit?: number;
  readonly member?: string;
  readonly event?: string;
}): HookDiagnosticsResult {
  const limit = args.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  if (args.member !== undefined && !MEMBERS.has(args.member as HookRuntimeMember)) throw new Error("member is not supported");
  if (args.event !== undefined && !EVENTS.has(args.event as HookRuntimeEvent)) throw new Error("event is not supported");

  const root = resolve(args.data_root);
  const chain = safeDirectoryChain(root);
  if (chain === "missing") return { items: [], partial: false, scanned_files: 0, malformed_rows: 0 };
  if (chain === "unsafe") return { items: [], partial: true, scanned_files: 0, malformed_rows: 0 };
  const directoryPath = join(root, "trace", "hook-runtime", "v1");
  const names = readDirectory(directoryPath);
  const items = new Map<string, HookDiagnosticEntry & { phase: "started" | "finished" }>();
  let partial = false;
  let malformed = 0;
  let scanned = 0;
  for (const name of names) {
    const shardPath = join(directoryPath, name);
    scanned += 1;
    const tail = readTail(shardPath);
    partial ||= tail.partial;
    for (const line of tail.lines) {
      if (!line) continue;
      let decoded: unknown;
      try { decoded = JSON.parse(line); } catch { malformed += 1; partial = true; continue; }
      const diagnostic = parseDiagnostic(decoded);
      if (!diagnostic) { malformed += 1; partial = true; continue; }
      const previous = items.get(diagnostic.request_id);
      if (!previous || diagnostic.phase === "finished" || Date.parse(diagnostic.started_at) >= Date.parse(previous.started_at)) items.set(diagnostic.request_id, diagnostic);
    }
  }
  const filtered = [...items.values()].filter(item => (args.member === undefined || item.member === args.member)
    && (args.event === undefined || item.event === args.event))
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at))
    .slice(0, limit)
    .map(item => {
      const { phase, ...entry } = item;
      return { ...entry, status: phase === "finished" ? "completed" as const : "unmatched_start" as const };
    });
  return { items: filtered, partial, scanned_files: scanned, malformed_rows: malformed };
}
