import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { workbenchCliEnvironment } from "./workbench-cli-path.ts";
import { resolveCodexExecutable } from "./codex-executable.ts";

type RpcId = string | number;
type RpcObject = Record<string, unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type CodexServerEvent =
  | { type: "notification"; method: string; params: unknown }
  | { type: "request"; id: RpcId; method: string; params: unknown }
  | { type: "closed"; error: string };

/** One app-server transport. Provider messages remain in memory and are not written to Craft storage. */
export class CodexAppServerClient {
  readonly process: ChildProcessWithoutNullStreams;
  readonly onEvent: (event: CodexServerEvent) => void;
  readonly timeoutMs: number;
  private nextId = 0;
  private pending = new Map<RpcId, Pending>();
  private serverRequests = new Set<RpcId>();
  private buffer = "";
  private closed = false;
  private readonly ownsProcessGroup: boolean;

  constructor(options: { onEvent: (event: CodexServerEvent) => void; timeoutMs?: number; start?: () => ChildProcessWithoutNullStreams }) {
    this.onEvent = options.onEvent;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.ownsProcessGroup = !options.start && process.platform !== "win32";
    this.process = (options.start ?? (() => spawn(resolveCodexExecutable(), ["app-server", "--listen", "stdio://"], { stdio: "pipe", shell: false, detached: process.platform !== "win32", env: workbenchCliEnvironment() })))();
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.process.stderr.resume();
    this.process.stdin.on("error", error => { this.fail(`Codex app-server input error: ${error.message}`); this.process.kill(); });
    this.process.on("error", error => this.fail(`Codex app-server process error: ${error.message}`));
    this.process.on("exit", (code, signal) => this.fail(`Codex app-server exited (code=${code}, signal=${signal})`));
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", { clientInfo: { name: "craft-workbench", title: "Craft Workbench", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized" });
    return result;
  }

  request(method: string, params: RpcObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex app-server request timed out: ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  respond(id: RpcId, result: RpcObject): void {
    if (!this.serverRequests.has(id)) throw new Error("Unknown or resolved Codex server request");
    this.send({ id, result });
    this.serverRequests.delete(id);
  }

  close(): void {
    if (!this.closed) this.fail("Codex app-server closed");
    if (!this.process.killed) {
      if (this.ownsProcessGroup && this.process.pid) { try { process.kill(-this.process.pid, "SIGTERM"); return; } catch { /* Fall back when the process already exited. */ } }
      this.process.kill();
    }
  }

  private send(message: RpcObject): void {
    if (this.closed || !this.process.stdin.writable) throw new Error("Codex app-server is closed");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) { this.fail("Codex app-server output exceeds limit"); this.process.kill(); return; }
    let newline: number;
    while (!this.closed && (newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line); }
      catch { this.fail("Codex app-server sent invalid JSON"); this.process.kill(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { this.fail("Codex app-server sent invalid message"); this.process.kill(); return; }
      const item = message as RpcObject;
      const id = typeof item.id === "string" || typeof item.id === "number" ? item.id : undefined;
      if (typeof item.method === "string") {
        if (id === undefined) this.onEvent({ type: "notification", method: item.method, params: item.params });
        else {
          if (this.serverRequests.has(id)) { this.fail("Codex app-server reused a pending request id"); this.process.kill(); return; }
          this.serverRequests.add(id); this.onEvent({ type: "request", id, method: item.method, params: item.params });
        }
      } else if (id !== undefined) {
        const pending = this.pending.get(id);
        if (!pending) continue; // A late reply to a timed-out request must not be reused.
        this.pending.delete(id); clearTimeout(pending.timer);
        if (item.error !== undefined) pending.reject(new Error(`Codex app-server request failed: ${JSON.stringify(item.error)}`));
        else pending.resolve(item.result);
      } else { this.fail("Codex app-server sent invalid message"); this.process.kill(); return; }
    }
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    this.pending.clear(); this.serverRequests.clear();
    this.onEvent({ type: "closed", error: message });
  }
}
