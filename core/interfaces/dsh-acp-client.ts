import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DshLaunch } from "../dsh-executable.ts";

type RpcId = string | number;
type RpcObject = Record<string, unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export type DshAcpEvent =
  | { type: "notification"; method: string; params: unknown }
  | { type: "request"; id: RpcId; method: string; params: unknown }
  | { type: "closed"; error: string };

export type DshAcpStart = () => ChildProcessWithoutNullStreams;

export type DshAcpClientOptions = {
  onEvent: (event: DshAcpEvent) => void;
  launch?: DshLaunch;
  start?: DshAcpStart;
  timeoutMs?: number;
  outputLimit?: number;
};

export type DshAcpSession = {
  sessionId: string;
  configOptions?: unknown[];
};

/**
 * ACP v1 client for the DeepSeek Harness automation profile.
 *
 * The packaged desktop wrapper prints diagnostic lines to stdout before the
 * protocol starts. Those lines are intentionally ignored; malformed JSON that
 * looks like a protocol frame fails closed.
 */
export class DshAcpClient {
  readonly process: ChildProcessWithoutNullStreams;
  readonly onEvent: (event: DshAcpEvent) => void;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  private nextId = 0;
  private pending = new Map<RpcId, Pending>();
  private serverRequests = new Set<RpcId>();
  private buffer = "";
  private bytes = 0;
  private closed = false;
  private readonly ownsProcessGroup: boolean;

  constructor(options: DshAcpClientOptions) {
    this.onEvent = options.onEvent;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.outputLimit = options.outputLimit ?? 8 * 1024 * 1024;
    this.ownsProcessGroup = !options.start && process.platform !== "win32";
    this.process = (options.start ?? (() => {
      if (!options.launch) throw new Error("DSH launch configuration is required");
      return spawn(options.launch.executable, options.launch.args, {
        cwd: process.cwd(),
        env: { ...process.env, ...options.launch.env, DSH_HOME: options.launch.dshHome },
        stdio: "pipe",
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    }))();
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.process.stderr.resume();
    this.process.stdin.on("error", (error) => { this.fail(`DSH ACP input error: ${error.message}`); this.process.kill(); });
    this.process.on("error", (error) => this.fail(`DSH ACP process error: ${error.message}`));
    this.process.on("exit", (code, signal) => this.fail(`DSH ACP exited (code=${code}, signal=${signal})`));
  }

  async initialize(): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "craft-workbench", version: "0.1.0" },
    });
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<DshAcpSession> {
    const result = await this.request("session/new", { cwd, mcpServers });
    return sessionResult(result, "session/new");
  }

  async resumeSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<DshAcpSession> {
    const result = await this.request("session/resume", { sessionId, cwd, mcpServers });
    return { sessionId, configOptions: configOptions(result) };
  }

  async listSessions(cursor?: string | null, cwd?: string | null): Promise<{ sessions: unknown[]; nextCursor: string | null }> {
    const result = await this.request("session/list", {
      ...(cursor ? { cursor } : {}),
      ...(cwd ? { cwd } : {}),
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("DSH session/list returned an invalid result");
    const value = result as RpcObject;
    if (!Array.isArray(value.sessions)) throw new Error("DSH session/list omitted sessions");
    return { sessions: value.sessions, nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null };
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown[]> {
    const result = await this.request("session/set_config_option", { sessionId, configId, value });
    return configOptions(result);
  }

  prompt(sessionId: string, text: string, timeoutMs = 0): Promise<unknown> {
    return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, timeoutMs);
  }

  notify(method: string, params: RpcObject): void {
    this.send({ method, params });
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  request(method: string, params: RpcObject, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("DSH ACP client is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`DSH ACP request timed out: ${method}`));
          }, timeoutMs)
        : setTimeout(() => undefined, 2_147_483_647);
      if (timeoutMs <= 0) timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  respond(id: RpcId, result: RpcObject): void {
    if (!this.serverRequests.has(id)) throw new Error("Unknown or resolved DSH server request");
    this.send({ id, result });
    this.serverRequests.delete(id);
  }

  respondError(id: RpcId, message: string): void {
    if (!this.serverRequests.has(id)) throw new Error("Unknown or resolved DSH server request");
    this.send({ id, error: { code: -32601, message } });
    this.serverRequests.delete(id);
  }

  close(): void {
    if (!this.closed) this.fail("DSH ACP client closed");
    if (!this.process.killed) {
      if (this.ownsProcessGroup && this.process.pid) {
        try {
          process.kill(-this.process.pid, "SIGTERM");
          return;
        } catch {
          // Fall through when the process already exited.
        }
      }
      this.process.kill();
    }
  }

  private send(message: RpcObject): void {
    if (this.closed || !this.process.stdin.writable) throw new Error("DSH ACP client is closed");
    const line = `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
    if (process.env.CRAFT_DSH_DEBUG === "1") process.stderr.write(`[craft-dsh] send: ${line}`);
    this.process.stdin.write(line);
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > this.outputLimit) {
      this.fail("DSH ACP output exceeds limit");
      this.process.kill();
      return;
    }
    let newline: number;
    while (!this.closed && (newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      // The packaged harness wrapper writes diagnostics before and during boot.
      if (!line.startsWith("{")) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail("DSH ACP sent invalid JSON");
        this.process.kill();
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        this.fail("DSH ACP sent an invalid message");
        this.process.kill();
        return;
      }
      const item = message as RpcObject;
      const id = typeof item.id === "string" || typeof item.id === "number" ? item.id : undefined;
      if (typeof item.method === "string") {
        if (id === undefined) {
          this.onEvent({ type: "notification", method: item.method, params: item.params });
        } else {
          if (this.serverRequests.has(id)) {
            this.fail("DSH ACP reused a pending request id");
            this.process.kill();
            return;
          }
          this.serverRequests.add(id);
          this.onEvent({ type: "request", id, method: item.method, params: item.params });
        }
        continue;
      }
      if (id === undefined) {
        // Some DSH plugins log structured JSON to stdout. Only a JSON-RPC
        // frame is a protocol error; ordinary log objects are ignored.
        if (item.jsonrpc === "2.0") {
          if (process.env.CRAFT_DSH_DEBUG === "1") process.stderr.write(`[craft-dsh] invalid frame: ${line}\n`);
          this.fail("DSH ACP sent a message without method or id");
          this.process.kill();
          return;
        }
        continue;
      }
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (item.error !== undefined) pending.reject(new Error(`DSH ACP request failed: ${JSON.stringify(item.error)}`));
      else pending.resolve(item.result);
    }
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.onEvent({ type: "closed", error: message });
  }
}

function configOptions(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const options = (value as RpcObject).configOptions;
  return Array.isArray(options) ? options : [];
}

function sessionResult(value: unknown, method: string): DshAcpSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`DSH ${method} returned an invalid result`);
  const result = value as RpcObject;
  if (typeof result.sessionId !== "string" || !result.sessionId.trim()) throw new Error(`DSH ${method} omitted sessionId`);
  return { sessionId: result.sessionId, configOptions: configOptions(result) };
}

