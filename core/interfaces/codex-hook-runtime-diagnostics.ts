import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";

export type HookRuntimeEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "SessionEnd" | "PreCompact";
export type HookRuntimeMember = "context" | "knowledge" | "memory" | "experience" | "datasec";

export interface HookRuntimeTiming {
  readonly process_elapsed_ms?: number;
  readonly input_read_ms?: number;
  readonly input_parse_ms?: number;
  readonly input_bytes?: number;
  readonly rules_load_ms?: number;
  readonly store_open_ms?: number;
  readonly runtime_import_ms?: number;
  readonly service_open_ms?: number;
  readonly handler_ms?: number;
  readonly output_write_ms?: number;
  readonly store_close_ms?: number;
  readonly outcome?: "completed" | "failed" | "skipped";
  readonly error_code?: string;
  readonly error_type?: string;
  readonly database_role?: "primary" | "capability_partition";
  readonly database_phase?: "transaction_begin" | "transaction_operation" | "savepoint_begin" | "savepoint_operation";
  readonly busy_timeout_ms?: number;
  readonly waited_ms?: number;
  readonly retryable?: boolean;
}

const DATABASE_ROLES = new Set(["primary", "capability_partition"]);
const DATABASE_PHASES = new Set(["transaction_begin", "transaction_operation", "savepoint_begin", "savepoint_operation"]);
type HookStorageFailureDetails = { -readonly [K in "database_role" | "database_phase" | "busy_timeout_ms" | "waited_ms" | "retryable"]?: HookRuntimeTiming[K] };

/** Copy only bounded storage-lock metadata; exception messages and payloads are never persisted. */
export function hookStorageFailureDetails(error: unknown, errorCode: string): HookStorageFailureDetails {
  if (errorCode !== "STORAGE_BUSY" || !error || typeof error !== "object") return {};
  const details = (error as { safeDetails?: unknown }).safeDetails;
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  const value = details as Record<string, unknown>;
  const result: HookStorageFailureDetails = {};
  if (typeof value.database_role === "string" && DATABASE_ROLES.has(value.database_role)) result.database_role = value.database_role as HookRuntimeTiming["database_role"];
  if (typeof value.phase === "string" && DATABASE_PHASES.has(value.phase)) result.database_phase = value.phase as HookRuntimeTiming["database_phase"];
  if (typeof value.busy_timeout_ms === "number" && Number.isSafeInteger(value.busy_timeout_ms) && value.busy_timeout_ms >= 0 && value.busy_timeout_ms <= 60_000)
    result.busy_timeout_ms = value.busy_timeout_ms;
  if (typeof value.waited_ms === "number" && Number.isSafeInteger(value.waited_ms) && value.waited_ms >= 0 && value.waited_ms <= 3_600_000)
    result.waited_ms = value.waited_ms;
  if (typeof value.retryable === "boolean") result.retryable = value.retryable;
  return result;
}

export interface HookRuntimeRecorder {
  finish(timing?: HookRuntimeTiming): void;
}

function safeDirectory(path: string): void {
  try { mkdirSync(path, { recursive: true, mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Hook diagnostics path must use regular directories");
}

function appendLine(path: string, value: Record<string, unknown>): void {
  const fd = openSync(path, "a", 0o600);
  try { writeSync(fd, `${JSON.stringify(value)}\n`); }
  finally { closeSync(fd); }
}

/**
 * Write a content-free start marker before opening Craft Store. If the Host kills
 * this process on timeout, the unmatched start marker identifies the event.
 */
export function beginHookRuntimeDiagnostic(args: {
  readonly data_root: string;
  readonly request_id: string;
  readonly member: HookRuntimeMember;
  readonly event: HookRuntimeEvent;
  readonly session_id?: string;
  readonly now?: () => number;
  readonly wall_clock?: () => string;
}): HookRuntimeRecorder {
  const root = resolve(args.data_root);
  const traceRoot = join(root, "trace");
  const hookRoot = join(traceRoot, "hook-runtime");
  const directory = join(hookRoot, "v1");
  safeDirectory(root);
  safeDirectory(traceRoot);
  safeDirectory(hookRoot);
  safeDirectory(directory);
  const shard = createHash("sha256").update(args.request_id).digest()[0]!.toString(16).padStart(2, "0");
  const path = join(directory, `${shard}.jsonl`);
  const existingFile = lstatSync(path, { throwIfNoEntry: false });
  if (existingFile) {
    const stat = existingFile;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Hook diagnostics file must be a regular file");
  }
  const now = args.now ?? (() => performance.now());
  const wallClock = args.wall_clock ?? (() => new Date().toISOString());
  const started = now();
  const sessionHash = args.session_id ? createHash("sha256").update(args.session_id).digest("hex") : undefined;
  const base = { request_id: args.request_id, member: args.member, event: args.event, started_at: wallClock(),
    ...(sessionHash ? { session_hash: sessionHash } : {}) };
  appendLine(path, { ...base, phase: "started" });
  let finished = false;
  return { finish(timing = {}) {
    if (finished) return;
    finished = true;
    const duration = now() - started;
    appendLine(path, { ...base, phase: "finished", finished_at: wallClock(), duration_ms: Math.max(0, Math.round(duration)),
      ...(timing.process_elapsed_ms === undefined ? {} : { process_elapsed_ms: Math.max(0, Math.round(timing.process_elapsed_ms)) }),
      ...(timing.input_read_ms === undefined ? {} : { input_read_ms: Math.max(0, Math.round(timing.input_read_ms)) }),
      ...(timing.input_parse_ms === undefined ? {} : { input_parse_ms: Math.max(0, Math.round(timing.input_parse_ms)) }),
      ...(timing.input_bytes === undefined ? {} : { input_bytes: Math.max(0, Math.round(timing.input_bytes)) }),
      ...(timing.rules_load_ms === undefined ? {} : { rules_load_ms: Math.max(0, Math.round(timing.rules_load_ms)) }),
      ...(timing.store_open_ms === undefined ? {} : { store_open_ms: Math.max(0, Math.round(timing.store_open_ms)) }),
      ...(timing.runtime_import_ms === undefined ? {} : { runtime_import_ms: Math.max(0, Math.round(timing.runtime_import_ms)) }),
      ...(timing.service_open_ms === undefined ? {} : { service_open_ms: Math.max(0, Math.round(timing.service_open_ms)) }),
      ...(timing.handler_ms === undefined ? {} : { handler_ms: Math.max(0, Math.round(timing.handler_ms)) }),
      ...(timing.output_write_ms === undefined ? {} : { output_write_ms: Math.max(0, Math.round(timing.output_write_ms)) }),
      ...(timing.store_close_ms === undefined ? {} : { store_close_ms: Math.max(0, Math.round(timing.store_close_ms)) }),
      ...(timing.outcome ? { outcome: timing.outcome } : {}),
      ...(timing.error_code ? { error_code: timing.error_code.slice(0, 80) } : {}),
      ...(timing.error_type ? { error_type: timing.error_type.slice(0, 80) } : {}),
      ...(timing.database_role && DATABASE_ROLES.has(timing.database_role) ? { database_role: timing.database_role } : {}),
      ...(timing.database_phase && DATABASE_PHASES.has(timing.database_phase) ? { database_phase: timing.database_phase } : {}),
      ...(Number.isSafeInteger(timing.busy_timeout_ms) && Number(timing.busy_timeout_ms) >= 0 && Number(timing.busy_timeout_ms) <= 60_000
        ? { busy_timeout_ms: timing.busy_timeout_ms } : {}),
      ...(Number.isSafeInteger(timing.waited_ms) && Number(timing.waited_ms) >= 0 && Number(timing.waited_ms) <= 3_600_000
        ? { waited_ms: timing.waited_ms } : {}),
      ...(typeof timing.retryable === "boolean" ? { retryable: timing.retryable } : {}) });
  } };
}
