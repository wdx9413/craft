import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { win32 } from "node:path";
import type { JsonObject } from "./infrastructure/store.ts";
import { digestJson } from "./digest.ts";

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



export class HostProcessCleanupError extends Error {
  constructor(cause: unknown) { super("Windows Host process tree cleanup could not be confirmed", { cause }); this.name = "HostProcessCleanupError"; }
}

/** Windows has no POSIX process-group signal; taskkill owns tree termination. */
export function stopWindowsHostProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid < 1) return Promise.reject(new Error("Host process id must be a positive safe integer"));
  return new Promise((resolve, reject) => {
    execFile(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 2000, maxBuffer: 16384 }, (error, stdout, stderr) => {
        if (!error) { resolve(); return; }
        // taskkill reports a nonzero code when the PID already exited between
        // the spawn and the cleanup call. That is the desired end state, not an
        // unconfirmed cleanup; only a still-running target is a real failure.
        // taskkill returns exit code 128 when the PID is already gone. Its
        // stderr is localised (and arrives as a non-UTF8 console encoding on
        // zh-CN Windows), so the code is the language-independent signal.
        const code = (error as { code?: unknown }).code;
        const text = `${String(stdout ?? "")}\n${String(stderr ?? "")}\n${(error as Error).message}`;
        if (code === 128 || /not found|not running|no process|not exist/i.test(text)) { resolve(); return; }
        reject(error);
      });
  });
}

/**
 * One bounded, cancellable child process with output caps. Every host driver
 * shares it, so sandboxing, output limiting and cancellation behave identically
 * whether the host is Codex, Claude, or a user-declared model CLI.
 */
export const executeHostProcess: HostExecutor = async (request) => new Promise((accept, reject) => {
  if (request.signal?.aborted) {
    accept({ exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: true, outputLimited: false });
    return;
  }
  const processGroup = process.platform !== "win32";
  const child = spawn(request.executable, request.argv, { cwd: request.cwd, shell: false, windowsHide: true, detached: processGroup, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let outputLimited = false; let timedOut = false; let cancelled = false;
  let inputError: Error | null = null;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  let windowsTreeStop: Promise<void> | undefined;
  let treeStopError: Error | null = null;
  const terminate = (signal: NodeJS.Signals) => {
    if (!processGroup && child.pid !== undefined) {
      windowsTreeStop ??= stopWindowsHostProcessTree(child.pid).catch(error => { treeStopError = error; child.kill("SIGKILL"); });
      return;
    }
    if (child.pid === undefined) { child.kill(signal); return; }
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
  };
  const stop = () => {
    clearTimeout(timer);
    terminate("SIGTERM");
    if (!forceStop) forceStop = setTimeout(() => terminate("SIGKILL"), 1000);
  };
  const append = (current: string, chunk: Buffer): string => { const next = current + chunk.toString("utf8"); if (Buffer.byteLength(next) <= request.outputLimit) return next; outputLimited = true; return Buffer.from(next).subarray(0, request.outputLimit).toString("utf8"); };
  const observed = (stream: "stdout" | "stderr", chunk: Buffer) => request.observe?.({ stream, bytes: chunk.length, digest: digestJson(chunk.toString("utf8")) });
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); observed("stdout", chunk); if (outputLimited) stop(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); observed("stderr", chunk); if (outputLimited) stop(); });
  // Closing/killing a child can race with a queued stdin write. Consume that
  // stream error and wait for close before settling, so callers never clean a
  // workspace while its child is still running. Lost input is never success.
  child.stdin.on("error", (error: Error) => { inputError = error; stop(); });
  child.once("error", (error) => { clearTimeout(timer); clearTimeout(forceStop); request.signal?.removeEventListener("abort", abort); reject(error); });
  const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs);
  const abort = () => { cancelled = true; stop(); }; request.signal?.addEventListener("abort", abort, { once: true }); if (request.signal?.aborted) abort();
  child.once("close", async (exitCode, signal) => {
    // A root may close its pipes while descendants still run. Finish stopping its
    // owned group before callers receive a terminal result and reuse the workspace.
    if (forceStop !== undefined && processGroup) terminate("SIGKILL");
    clearTimeout(timer); clearTimeout(forceStop); request.signal?.removeEventListener("abort", abort);
    await windowsTreeStop;
    if (treeStopError) reject(new HostProcessCleanupError(treeStopError));
    else if (inputError && !cancelled && !timedOut) reject(inputError);
    else accept({ exitCode, signal, stdout, stderr, timedOut, cancelled, outputLimited });
  });
  child.stdin.end(request.stdin);
});
