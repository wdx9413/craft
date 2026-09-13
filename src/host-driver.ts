import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { JsonObject } from "./store.ts";

export type HostSandbox = "read-only" | "workspace-write";
export type HostOutputObserver = (event: { stream: "stdout" | "stderr"; bytes: number; digest: string }) => void;
export interface HostExecutionRequest { executable: string; argv: string[]; cwd: string; stdin: string; timeoutMs: number; outputLimit: number; signal?: AbortSignal; observe?: HostOutputObserver }
export interface HostExecutionResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; cancelled?: boolean; outputLimited: boolean }
export type HostExecutor = (request: HostExecutionRequest) => Promise<HostExecutionResult>;

export interface HostDriver {
  readonly host: string;
  /**
   * The dispatch record kind this driver owns. Declaring it here is what lets a
   * new model CLI plug in without editing the service's host branches, so it is
   * required rather than optional.
   */
  readonly dispatchKind: string;
  prepare(args: JsonObject): JsonObject;
  execute(args: JsonObject, options?: { signal?: AbortSignal; observe?: HostOutputObserver }): Promise<JsonObject>;
}

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

/**
 * One bounded, cancellable child process with output caps. Every host driver
 * shares it, so sandboxing, output limiting and cancellation behave identically
 * whether the host is Codex, Claude, or a user-declared model CLI.
 */
export const executeHostProcess: HostExecutor = async (request) => new Promise((accept, reject) => {
  const child = spawn(request.executable, request.argv, { cwd: request.cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let outputLimited = false; let timedOut = false; let cancelled = false;
  const append = (current: string, chunk: Buffer): string => { const next = current + chunk.toString("utf8"); if (Buffer.byteLength(next) <= request.outputLimit) return next; outputLimited = true; return Buffer.from(next).subarray(0, request.outputLimit).toString("utf8"); };
  const observed = (stream: "stdout" | "stderr", chunk: Buffer) => request.observe?.({ stream, bytes: chunk.length, digest: digest(chunk.toString("utf8")) });
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); observed("stdout", chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); observed("stderr", chunk); });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, request.timeoutMs);
  const abort = () => { cancelled = true; child.kill(); }; request.signal?.addEventListener("abort", abort, { once: true }); if (request.signal?.aborted) abort();
  child.once("close", (exitCode, signal) => { clearTimeout(timer); request.signal?.removeEventListener("abort", abort); accept({ exitCode, signal, stdout, stderr, timedOut, cancelled, outputLimited }); });
  child.stdin.end(request.stdin);
});
