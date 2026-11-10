/**
 * Local-process sandbox backend.
 *
 * Docker is optional, so a machine without it has no *executing* sandbox at
 * all: `SandboxKernel` can record a `local_process` profile but nothing runs it.
 * This adapter makes that backend real.
 *
 * It enforces exactly what a plain child process can enforce and no more:
 *   - argv-only execution (no shell, so no quoting/expansion surprises),
 *   - a working directory confined to the runtime root,
 *   - an environment allowlist that never forwards credential-shaped variables,
 *   - a wall-clock timeout with process-tree termination,
 *   - a bounded stdout/stderr buffer.
 *
 * It does NOT provide an OS jail. The child can still read files outside the
 * workspace, open sockets, and raise its own limits. Every result therefore
 * carries `os_sandbox_guaranteed: false`, and `conformance()` checks only the
 * properties this backend actually claims. Code that requires network denial or
 * a read-only root must use the container backend.
 */
import { createHash } from "node:crypto";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import type { JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";

export type LocalProcessResult = { code: number; stdout: string; stderr: string; timed_out: boolean; output_limited: boolean };
export type LocalProcessRunner = (argv: string[], options: {
  cwd: string; timeoutMs: number; outputLimit: number; env: JsonObject;
}) => Promise<LocalProcessResult>;

const OUTPUT_LIMIT = 1024 * 1024;

/** Variables a normal CLI needs; nothing credential-shaped is forwarded. */
const SAFE_ENV = ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "LANG", "LC_ALL", "TZ"] as const;

const SECRET_NAME = /(?:key|token|secret|password|passwd|credential|cookie|authorization)/iu;

function command(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error("command must be a non-empty string array");
  return value.map((item) => text(item, "command"));
}

function numberLimit(limits: JsonObject, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = limits[name] === undefined ? fallback : Number(limits[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Local process ${name} limit is unsupported`);
  return value;
}

function scrub(value: string): string {
  return value.replace(/(api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/giu, "$1=[REDACTED]");
}

export function localProcessRequestDigest(commandValue: string[], workspace: string): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ command: commandValue, workspace })).digest("hex")}`;
}

/**
 * Build the child environment from the allowlist plus explicit safe overrides.
 * Any name matching the credential pattern is dropped even if the caller asks.
 */
export function localProcessEnvironment(overrides: JsonObject = {}, source: NodeJS.ProcessEnv = process.env): JsonObject {
  const env: JsonObject = {};
  for (const name of SAFE_ENV) { const value = source[name]; if (value !== undefined) env[name] = value; }
  for (const [name, value] of Object.entries(overrides)) {
    if (SECRET_NAME.test(name)) continue;
    if (typeof value !== "string") throw new Error(`environment override ${name} must be a string`);
    env[name] = value;
  }
  return env;
}

/** Confine a ticket workspace to the runtime root; the same rule the container backend uses. */
export function localProcessWorkspace(runtimeRootValue: unknown, ticketIdValue: unknown): string {
  const runtimeRoot = resolve(text(runtimeRootValue, "runtime_root"));
  const ticketId = text(ticketIdValue, "ticket_id");
  const workspace = resolve(runtimeRoot, ticketId);
  const rel = relative(runtimeRoot, workspace);
  if (!rel || rel.split(/[\\/]+/u).includes("..") || isAbsolute(rel)) throw new Error("Local process workspace escapes the runtime root");
  return workspace;
}

function killTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }, platform: NodeJS.Platform, spawnProcess: typeof spawn): void {
  if (!child.pid) { child.kill("SIGKILL"); return; }
  if (platform === "win32") {
    // `child.kill` only ends the direct child; npm/node wrappers outlive it.
    spawnProcess("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

export function runLocalProcess(argv: string[], options: {
  cwd: string; timeoutMs: number; outputLimit: number; env: JsonObject;
}, spawnProcess: typeof spawn = spawn, platform: NodeJS.Platform = process.platform): Promise<LocalProcessResult> {
  return new Promise((resolveResult, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: options.env as NodeJS.ProcessEnv, ...(platform === "win32" ? {} : { detached: true }),
    };
    let child: ReturnType<typeof spawn>;
    try { child = spawnProcess(argv[0]!, argv.slice(1), spawnOptions); }
    catch (error) { reject(error); return; }
    let stdout = ""; let stderr = ""; let settled = false; let timedOut = false; let outputLimited = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child, platform, spawnProcess); }, options.timeoutMs);
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) <= options.outputLimit) return next;
      outputLimited = true; killTree(child, platform, spawnProcess); return next.slice(0, options.outputLimit);
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once("close", (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolveResult({ code: code ?? 1, stdout: scrub(stdout), stderr: scrub(stderr), timed_out: timedOut, output_limited: outputLimited });
    });
  });
}

function localFlags(capabilities: JsonObject): { timeoutMs: number; outputLimit: number; envOverrides: JsonObject } {
  if (capabilities.filesystem !== "workspace_overlay") {
    throw new Error("Local process backend currently requires workspace_overlay");
  }
  if (capabilities.network !== "unrestricted") {
    throw new Error("Local process backend cannot deny network; declare network=unrestricted or use the container backend");
  }
  const features = capabilities.features as string[];
  const unsupported = features.filter((item) => item !== "process_isolation" && item !== "cancel");
  if (!features.includes("process_isolation") || !features.includes("cancel") || unsupported.length) {
    throw new Error("Local process backend requires process_isolation and cancel and does not claim unsupported features");
  }
  const limits = capabilities.limits as JsonObject;
  const timeoutMs = numberLimit(limits, "timeout_ms", 30_000, 10, 3_600_000);
  const outputLimit = numberLimit(limits, "output_limit", OUTPUT_LIMIT, 1_024, 16 * 1024 * 1024);
  const known = new Set(["timeout_ms", "output_limit"]);
  if (Object.keys(limits).some((name) => !known.has(name))) throw new Error("Local process backend received an unsupported resource limit");
  return { timeoutMs, outputLimit, envOverrides: {} };
}

export class LocalProcessSandboxAdapter {
  readonly runner: LocalProcessRunner;
  readonly evidenceMode: "runtime" | "simulation";
  constructor(runner: LocalProcessRunner = runLocalProcess, evidenceMode: "runtime" | "simulation" = "runtime") {
    this.runner = runner; this.evidenceMode = evidenceMode;
  }

  /** Run a trivial argv in a scratch directory; proves the backend can execute. */
  async probe(runtimeRootValue: unknown, capabilities: JsonObject): Promise<JsonObject> {
    const workspace = localProcessWorkspace(runtimeRootValue, "probe");
    await mkdir(workspace, { recursive: true });
    const configured = localFlags(capabilities);
    const result = await this.runner([process.execPath, "-e", "process.exit(0)"],
      { cwd: workspace, timeoutMs: configured.timeoutMs, outputLimit: configured.outputLimit, env: localProcessEnvironment(configured.envOverrides) });
    if (result.code !== 0 || result.timed_out || result.output_limited) throw new Error("Local process sandbox probe failed closed");
    return { adapter_id: "local_process", runtime_root: resolve(text(runtimeRootValue, "runtime_root")),
      observed_capabilities: capabilities, os_sandbox_guaranteed: false, status: "passed",
      probe_digest: localProcessRequestDigest([process.execPath, "-e", "process.exit(0)"], workspace) };
  }

  /**
   * Check only what is claimed: confinement of the working directory, env
   * allowlist, timeout, and output bound. It deliberately does not claim
   * filesystem or network isolation.
   */
  async conformance(probeIdValue: unknown, runtimeRootValue: unknown, capabilities: JsonObject): Promise<JsonObject> {
    const workspace = localProcessWorkspace(runtimeRootValue, probeIdValue);
    await mkdir(workspace, { recursive: true });
    const configured = localFlags(capabilities);
    const env = localProcessEnvironment({ CRAFT_PROBE_TOKEN: "must-not-leak", SAFE_MARKER: "visible" });
    const base = { cwd: workspace, timeoutMs: configured.timeoutMs, outputLimit: configured.outputLimit, env };
    const checks: Array<[string, string[], "pass" | "timeout" | "output_limit"]> = [
      ["baseline", [process.execPath, "-e", "process.exit(0)"], "pass"],
      ["workspace_write", [process.execPath, "-e", "require('node:fs').writeFileSync('craft-probe.txt','ok')"], "pass"],
      ["env_allowlisted", [process.execPath, "-e", "process.exit(process.env.CRAFT_PROBE_TOKEN === undefined && process.env.SAFE_MARKER === 'visible' ? 0 : 3)"], "pass"],
      ["timeout_cancel", [process.execPath, "-e", "setTimeout(() => {}, 60000)"], "timeout"],
      ["output_limit", [process.execPath, "-e", "for (let i = 0; i < 200000; i++) process.stdout.write('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n')"], "output_limit"],
    ];
    const results: JsonObject[] = [];
    for (const [check, argv, expectation] of checks) {
      // The cancellation check must not wait the full production timeout.
      const options = expectation === "timeout" ? { ...base, timeoutMs: Math.min(base.timeoutMs, 500) } : base;
      const result = await this.runner(argv, options);
      const passed = expectation === "timeout" ? result.timed_out
        : expectation === "output_limit" ? result.output_limited
          : result.code === 0 && !result.timed_out && !result.output_limited;
      results.push({ check, passed, code: result.code, timed_out: result.timed_out, output_limited: result.output_limited });
    }
    if (results.some((result) => result.passed !== true)) throw new Error("Local process sandbox conformance failed closed");
    return { adapter_id: "local_process", runtime_root: resolve(text(runtimeRootValue, "runtime_root")),
      observed_capabilities: capabilities, os_sandbox_guaranteed: false,
      conformance_version: 1, status: "passed", checks: results };
  }

  async execute(args: JsonObject, beforeStart?: () => void): Promise<JsonObject> {
    const requestedCommand = command(args.command);
    const ticketId = text(args.ticket_id, "ticket_id");
    const workspace = localProcessWorkspace(args.runtime_root, ticketId);
    if (text(args.request_digest, "request_digest") !== localProcessRequestDigest(requestedCommand, workspace)) {
      throw new Error("Local process execution request digest mismatch");
    }
    await mkdir(workspace, { recursive: true });
    const configured = localFlags(args.capabilities as JsonObject);
    const env = localProcessEnvironment(
      args.environment && typeof args.environment === "object" && !Array.isArray(args.environment) ? args.environment as JsonObject : {},
      process.env,
    );
    beforeStart?.();
    const result = await this.runner(requestedCommand, { cwd: workspace, timeoutMs: configured.timeoutMs, outputLimit: configured.outputLimit, env });
    const status = result.timed_out ? "timed_out" : result.code === 0 && !result.output_limited ? "passed" : "failed";
    return { status, adapter_id: "local_process", command_digest: localProcessRequestDigest(requestedCommand, workspace),
      workspace, stdout: result.stdout, stderr: result.stderr, exit_code: result.code,
      output_limited: result.output_limited, timed_out: result.timed_out,
      os_sandbox_guaranteed: false, observed_capabilities: args.capabilities };
  }
}
