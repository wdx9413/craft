import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { JsonObject } from "./store.ts";

export type DockerResult = { code: number; stdout: string; stderr: string; timed_out: boolean; output_limited: boolean };
export type DockerRunner = (argv: string[], timeoutMs: number, outputLimit: number) => Promise<DockerResult>;
const OUTPUT_LIMIT = 1024 * 1024;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim();
}
function command(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error("command must be a non-empty string array");
  return value.map((item) => text(item, "command"));
}
function numberLimit(limits: JsonObject, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = limits[name] === undefined ? fallback : Number(limits[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Docker ${name} limit is unsupported`);
  return value;
}
function scrub(value: string): string {
  return value.replace(/(api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/giu, "$1=[REDACTED]");
}
export function dockerRequestDigest(image: string, requestedCommand: string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ image, command: requestedCommand })).digest("hex")}`;
}
function containerName(value: string): string {
  return `craft-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function runDocker(argv: string[], timeoutMs: number, outputLimit = OUTPUT_LIMIT, spawnProcess: typeof spawn = spawn): Promise<DockerResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawnProcess("docker", argv, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_V8_COVERAGE: "" } });
    let stdout = ""; let stderr = ""; let settled = false; let outputLimited = false; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) <= outputLimit) return next;
      outputLimited = true; child.kill(); return next.slice(0, outputLimit);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once("close", (code) => { if (!settled) { settled = true; clearTimeout(timer);
      resolveResult({ code: code ?? 1, stdout: scrub(stdout), stderr: scrub(stderr), timed_out: timedOut, output_limited: outputLimited }); } });
  });
}

function dockerFlags(capabilities: JsonObject, workspace?: string): { flags: string[]; timeoutMs: number } {
  if (capabilities.filesystem !== "workspace_overlay" || capabilities.network !== "denied") {
    throw new Error("Docker Adapter currently requires workspace_overlay and denied network");
  }
  const features = capabilities.features as string[]; const unsupported = features.filter((item) => !["process_isolation", "cancel"].includes(item));
  if (!features.includes("process_isolation") || !features.includes("cancel") || unsupported.length) {
    throw new Error("Docker Adapter requires process_isolation and cancel and does not claim unsupported features");
  }
  const limits = capabilities.limits as JsonObject;
  const memoryMb = numberLimit(limits, "memory_mb", 256, 16, 131_072);
  const timeoutMs = numberLimit(limits, "timeout_ms", 30_000, 10, 3_600_000);
  const pids = numberLimit(limits, "pids", 64, 1, 4096);
  const cpuCount = numberLimit(limits, "cpu_count", 1, 0.1, 256);
  const known = new Set(["memory_mb", "timeout_ms", "pids", "cpu_count"]);
  if (Object.keys(limits).some((name) => !known.has(name))) throw new Error("Docker Adapter received an unsupported resource limit");
  const flags = ["--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", `${memoryMb}m`, "--pids-limit", String(pids), "--cpus", String(cpuCount), "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"];
  if (workspace) flags.push("--mount", `type=bind,src=${workspace},dst=/workspace`, "--workdir", "/workspace");
  return { flags, timeoutMs };
}

export class DockerSandboxAdapter {
  readonly runner: DockerRunner;
  constructor(runner: DockerRunner = runDocker) { this.runner = runner; }

  async probe(imageValue: unknown, capabilities: JsonObject): Promise<JsonObject> {
    const image = text(imageValue, "image"); const configured = dockerFlags(capabilities);
    for (const argv of [["version", "--format", "{{.Server.Version}}"], ["image", "inspect", image],
      ["run", "--rm", ...configured.flags, image, "true"]]) {
      const result = await this.runner(argv, configured.timeoutMs, OUTPUT_LIMIT);
      if (result.code !== 0 || result.timed_out || result.output_limited) throw new Error("Docker Sandbox probe failed closed");
    }
    return { adapter_id: "docker", image, observed_capabilities: capabilities,
      probe_digest: dockerRequestDigest(image, ["true"]), status: "passed" };
  }

  async conformance(probeIdValue: unknown, imageValue: unknown, capabilities: JsonObject, runtimeRootValue: unknown): Promise<JsonObject> {
    const probeId = text(probeIdValue, "probe_id"); const image = text(imageValue, "image");
    const runtimeRoot = text(runtimeRootValue, "runtime_root"); const workspace = resolve(runtimeRoot, containerName(probeId));
    await mkdir(workspace, { recursive: true });
    const configured = dockerFlags(capabilities, workspace); const name = containerName(probeId);
    const base = ["run", "--rm", "--name", name, ...configured.flags, image, "sh", "-c"];
    const checks: Array<[string, string, "pass" | "timeout"]> = [
      ["baseline", "true", "pass"],
      ["root_read_only", "touch /craft-root-probe >/dev/null 2>&1; test $? -ne 0", "pass"],
      ["workspace_write", "echo ok > /workspace/craft-probe && test -s /workspace/craft-probe", "pass"],
      ["network_denied", "test \"$(ls -A /sys/class/net 2>/dev/null | tr -d '\\n')\" = \"lo\"", "pass"],
      ["secret_absent", "! env | grep -Eiq '(TOKEN|PASSWORD|SECRET|API_KEY|COOKIE|AUTHORIZATION)='", "pass"],
      ["timeout_cancel", "sleep 60", "timeout"],
    ];
    const results: JsonObject[] = [];
    for (const [check, script, expectation] of checks) {
      const timeout = expectation === "timeout" ? 50 : configured.timeoutMs;
      const result = await this.runner([...base, script], timeout, OUTPUT_LIMIT);
      const passed = expectation === "timeout" ? result.timed_out : result.code === 0 && !result.timed_out && !result.output_limited;
      results.push({ check, passed, code: result.code, timed_out: result.timed_out, output_limited: result.output_limited });
      if (expectation === "timeout") await this.runner(["rm", "-f", name], configured.timeoutMs, OUTPUT_LIMIT);
    }
    const residual = await this.runner(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"], configured.timeoutMs, OUTPUT_LIMIT);
    const residualPassed = residual.code === 0 && !residual.stdout.trim(); results.push({ check: "no_residual_container", passed: residualPassed, code: residual.code });
    if (results.some((result) => result.passed !== true)) throw new Error("Docker Sandbox conformance failed closed");
    return { adapter_id: "docker", image, probe_id: probeId, observed_capabilities: capabilities,
      conformance_version: 1, status: "passed", checks: results };
  }

  async execute(args: JsonObject): Promise<JsonObject> {
    const image = text(args.image, "image"); const requestedCommand = command(args.command);
    if (text(args.request_digest, "request_digest") !== dockerRequestDigest(image, requestedCommand)) {
      throw new Error("Docker execution request digest mismatch");
    }
    const ticketId = text(args.ticket_id, "ticket_id"); const runtimeRoot = text(args.runtime_root, "runtime_root");
    const workspace = resolve(runtimeRoot, ticketId);
    const relativeWorkspace = relative(resolve(runtimeRoot), workspace);
    if (!relativeWorkspace || relativeWorkspace.startsWith("..") || isAbsolute(relativeWorkspace)) {
      throw new Error("Docker workspace escapes the runtime root");
    }
    await mkdir(workspace, { recursive: true });
    const configured = dockerFlags(args.capabilities as JsonObject, workspace); const name = containerName(ticketId);
    const result = await this.runner(["run", "--rm", "--name", name, ...configured.flags, image, ...requestedCommand], configured.timeoutMs, OUTPUT_LIMIT);
    let cleanup: JsonObject | null = null;
    if (result.timed_out || result.output_limited) {
      const removed = await this.runner(["rm", "-f", name], configured.timeoutMs, OUTPUT_LIMIT);
      const residual = await this.runner(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"], configured.timeoutMs, OUTPUT_LIMIT);
      cleanup = { remove_code: removed.code, residual_check_code: residual.code,
        residual_container: residual.stdout.trim() || null, passed: residual.code === 0 && !residual.stdout.trim() };
    }
    const status = result.timed_out ? cleanup?.passed === true ? "timed_out" : "failed"
      : result.code === 0 && !result.output_limited ? "passed" : "failed";
    return { status, image, command_digest: dockerRequestDigest(image, requestedCommand), workspace,
      stdout: result.stdout, stderr: result.stderr, exit_code: result.code, output_limited: result.output_limited,
      cleanup, observed_capabilities: args.capabilities };
  }
}
