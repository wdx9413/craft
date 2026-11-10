import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { V01226Runtime } from "./generic-adapter-runtime.ts";
import { callMcpAdapter } from "./mcp-adapter-client.ts";
import { digestJson } from "./digest.ts";
import { text } from "./validation.ts";

const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function strings(value: unknown, name: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be a string array`);
  }
  return value as string[];
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

async function runJsonCommand(command: string, args: string[], cwd: string, request: JsonObject, timeoutMs: number, outputLimit: number): Promise<JsonObject> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: JsonObject) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error); else resolveResult(value ?? {});
    };
    const timer = setTimeout(() => finish(new Error("browser adapter timed out")), timeoutMs);
    timer.unref?.();
    child.on("error", (error) => finish(new Error(`browser adapter failed: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) { finish(new Error(`browser adapter exited with code ${code}: ${stderr.slice(0, 500)}`)); return; }
      try {
        const value = JSON.parse(stdout);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response is not an object");
        finish(null, value as JsonObject);
      } catch (error) {
        finish(new Error(`browser adapter returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, outputLimit); });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(0, outputLimit); });
    child.stdin.on("error", (error) => finish(new Error(`browser adapter input failed: ${error.message}`)));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

/** Run one shell-free argv command and parse its single JSON envelope from stdout. */
async function runArgvEnvelope(command: string, args: string[], timeoutMs: number, outputLimit: number): Promise<JsonObject> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: JsonObject) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error); else resolveResult(value ?? {});
    };
    const timer = setTimeout(() => finish(new Error("desktop adapter timed out")), timeoutMs);
    timer.unref?.();
    child.on("error", (error) => finish(new Error(`desktop adapter failed: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      try {
        const value = JSON.parse(stdout);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response is not an object");
        const envelope = value as JsonObject;
        if (code !== 0 || envelope.ok === false) {
          const error = envelope.error && typeof envelope.error === "object" && !Array.isArray(envelope.error)
            ? envelope.error as JsonObject : {};
          const detail = String(error.message ?? error.code ?? stderr.slice(0, 300) ?? "").trim();
          finish(new Error(`desktop adapter reported failure${detail ? `: ${detail}` : ""}`));
          return;
        }
        finish(null, envelope);
      } catch (error) {
        finish(new Error(`desktop adapter returned invalid JSON (exit ${code}): ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, outputLimit); });
    child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(0, outputLimit); });
  });
}

/**
 * Native command/MCP/browser execution for Craft's own loop.
 *
 * The kernel is deliberately not a sandbox: command effects are a contract
 * checked by the caller's approval broker. It does, however, keep argv
 * execution shell-free, bound cwd to the workspace, and cap every output path.
 */
export class NativeToolKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  async commandRun(args: JsonObject): Promise<JsonObject> {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const workspace = resolve(text(args.workspace, "workspace"));
    const cwd = args.cwd === undefined ? workspace : resolve(workspace, text(args.cwd, "cwd"));
    if (!contained(workspace, cwd)) throw new Error("command cwd escapes workspace");
    const argv = strings(args.argv, "argv", 1);
    if (argv[0]!.includes("\0") || argv.some((entry) => entry.length > 32_768)) throw new Error("argv is invalid");
    const effect = String(args.effect ?? "read_only");
    if (!EFFECTS.has(effect)) throw new Error("effect is unsupported");
    const result = await new V01226Runtime(this.store).commandRun({
      argv, cwd, shell: false, effect, timeout_ms: Number(args.timeout_ms ?? 120_000),
      output_limit: Number(args.output_limit ?? 65_536), adapter_id: args.adapter_id === undefined ? "craft.native.command" : String(args.adapter_id),
    });
    return { ...result, task_id: taskId, workspace, cwd, effect };
  }

  async mcpCall(args: JsonObject): Promise<JsonObject> {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const adapterId = text(args.adapter_id, "adapter_id");
    const manifest = this.store.get("adapter_manifest", adapterId);
    const result = await callMcpAdapter(manifest, {
      adapter_id: adapterId,
      tool: text(args.tool, "tool"),
      arguments: args.arguments === undefined ? {} : object(args.arguments, "arguments"),
      timeout_ms: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms),
      output_limit: args.output_limit === undefined ? undefined : Number(args.output_limit),
      // The Workbench trial surface shows the reply to a person deciding what to
      // do next, so it is worth naming the server's tools in the same roundtrip.
      include_tool_inventory: true,
    });
    return { task_id: taskId, ...result };
  }

  async browserAction(args: JsonObject): Promise<JsonObject> {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const workspace = resolve(text(args.workspace, "workspace"));
    const adapterId = text(args.adapter_id, "adapter_id");
    const manifest = this.store.get("adapter_manifest", adapterId);
    if (manifest.kind !== "browser") throw new Error("adapter is not a browser adapter");
    if (manifest.status !== "active") throw new Error("browser adapter is not active");
    const meta = manifest.metadata && typeof manifest.metadata === "object" && !Array.isArray(manifest.metadata)
      ? manifest.metadata as JsonObject : {};
    const command = String(meta.command ?? manifest.entry ?? "");
    if (!command) throw new Error("browser adapter has no command");
    const request = {
      operation: text(args.operation, "operation"),
      ...(args.url === undefined ? {} : { url: text(args.url, "url") }),
      ...(args.selector === undefined ? {} : { selector: text(args.selector, "selector") }),
      ...(args.value === undefined ? {} : { value: text(args.value, "value") }),
      task_id: taskId, workspace,
    };
    const timeoutMs = Math.max(100, Math.min(3_600_000, Number(args.timeout_ms ?? meta.timeout_ms ?? 120_000)));
    const outputLimit = Math.max(256, Math.min(10_000_000, Number(args.output_limit ?? meta.output_limit ?? 1_000_000)));
    const result = await runJsonCommand(command, strings(meta.args ?? [], "metadata.args"), workspace, request, timeoutMs, outputLimit);
    return { task_id: taskId, adapter_id: adapterId, operation: request.operation, result, result_digest: digestJson(result) };
  }

  /**
   * Dispatch one bounded agent-desktop command. Craft ships no desktop driver;
   * the adapter manifest supplies the executable and Craft forwards a thin,
   * shell-free argv plus the documented JSON envelope back to the caller.
   */
  async desktopAction(args: JsonObject): Promise<JsonObject> {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const adapterId = args.adapter_id === undefined ? "agent-desktop" : text(args.adapter_id, "adapter_id");
    const manifest = this.store.get("adapter_manifest", adapterId);
    if (manifest.kind !== "command") throw new Error("adapter is not a command adapter");
    if (manifest.status !== "active") throw new Error("desktop adapter is not active");
    const operation = text(args.operation, "operation");
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(operation)) throw new Error("desktop operation is invalid");
    const meta = manifest.metadata && typeof manifest.metadata === "object" && !Array.isArray(manifest.metadata)
      ? manifest.metadata as JsonObject : {};
    const command = String(meta.command ?? manifest.entry ?? "");
    if (!command) throw new Error("desktop adapter has no command");
    const ref = args.ref === undefined ? null : text(args.ref, "ref");
    const extra = args.args === undefined ? [] : strings(args.args, "args");
    const argv = [...strings(meta.args ?? [], "metadata.args"), operation, ...(ref ? [ref] : []), ...extra];
    if (args.app !== undefined && !argv.includes("--app")) argv.push("--app", text(args.app, "app"));
    if (args.window_id !== undefined && !argv.includes("--window-id")) argv.push("--window-id", text(args.window_id, "window_id"));
    if (args.headed === true && !argv.includes("--headed")) argv.push("--headed");
    const timeoutMs = Math.max(100, Math.min(600_000, Number(args.timeout_ms ?? 120_000)));
    const outputLimit = Math.max(256, Math.min(4_000_000, Number(args.output_limit ?? 1_000_000)));
    const result = await runArgvEnvelope(command, argv, timeoutMs, outputLimit);
    return { task_id: taskId, adapter_id: adapterId, operation, result, result_digest: digestJson(result) };
  }
}

