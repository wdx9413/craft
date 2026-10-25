import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";

export type HookRuntimeEvent = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "SessionEnd";
export type HookRuntimeMember = "context" | "knowledge" | "memory" | "experience";

export interface HookRuntimeTiming {
  readonly store_open_ms?: number;
  readonly handler_ms?: number;
  readonly error_type?: string;
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
      ...(timing.store_open_ms === undefined ? {} : { store_open_ms: Math.max(0, Math.round(timing.store_open_ms)) }),
      ...(timing.handler_ms === undefined ? {} : { handler_ms: Math.max(0, Math.round(timing.handler_ms)) }),
      ...(timing.error_type ? { error_type: timing.error_type.slice(0, 80) } : {}) });
  } };
}
