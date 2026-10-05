import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { atomicPrivateJson, type CraftPaths } from "../infrastructure/paths.ts";
import { CraftService, VERSION } from "../application/craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";

const MAX_BODY = 256 * 1024;
function equal(left: string | undefined, right: string): boolean { if (!left) return false; const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function parse(body: Buffer): JsonObject { const value: unknown = JSON.parse(body.toString("utf8") || "{}"); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supervisor request must be an object"); return value as JsonObject; }
export function assertSupervisorOwner(expected: unknown, actual: unknown): void { if (actual !== expected) throw new Error("Supervisor lock changed during recovery"); }

export class LocalSupervisor {
  readonly service: CraftService; readonly paths: CraftPaths; readonly ownerId: string; readonly host: string; readonly isProcessAlive: (pid: number) => boolean;
  readonly heartbeatMs: number;
  #server: Server | null = null; #heartbeat: NodeJS.Timeout | null = null; #heartbeatWork: Promise<void> | null = null;
  #heartbeatFailure: Error | null = null;
  constructor(service: CraftService, paths: CraftPaths, options: { ownerId?: string; host?: string; heartbeatMs?: number; isProcessAlive?: (pid: number) => boolean } = {}) {
    this.service = service; this.paths = paths; this.ownerId = options.ownerId ?? service.hostRuns.ownerId; this.host = options.host ?? hostname();
    if (this.ownerId !== service.hostRuns.ownerId) throw new Error("Supervisor owner must match HostRun owner");
    this.heartbeatMs = options.heartbeatMs ?? 10_000; if (!Number.isInteger(this.heartbeatMs) || this.heartbeatMs < 5 || this.heartbeatMs > 60_000) throw new Error("heartbeatMs must be between 5 and 60000");
    this.isProcessAlive = options.isProcessAlive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } });
  }
  private get lockPath(): string { return join(this.paths.runtimeDir, "supervisor.lock.json"); }
  private get statePath(): string { return join(this.paths.runtimeDir, "supervisor.json"); }

  async start(port = 0): Promise<JsonObject> {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer between 0 and 65535"); if (this.#server) throw new Error("Supervisor is already running");
    const previousOwner = await this.acquire();
    this.#heartbeatFailure = null;
    try {
      if (previousOwner) this.service.hostRunRecover({ owner_id: previousOwner, confirmed_original_runner_stopped: true });
      const server = createServer((request, response) => { const chunks: Buffer[] = []; let size = 0; request.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk); }); request.on("end", async () => {
      const send = (status: number, value: JsonObject) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
      const token = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined; if (!equal(token, this.ownerId)) { send(401, { error: "Supervisor token required" }); return; }
      try { const url = new URL(String(request.url), "http://127.0.0.1"); const body = size > MAX_BODY ? (() => { throw new Error("Supervisor request exceeds 256 KiB"); })() : parse(Buffer.concat(chunks));
        if (request.method === "GET" && url.pathname === "/health") send(200, { status: "ok", version: VERSION, owner_id: this.ownerId });
        else if (request.method === "POST" && url.pathname === "/runs/start") send(202, this.service.hostRunStart(body));
        else if (request.method === "GET" && url.pathname.startsWith("/runs/")) send(200, this.service.hostRunGet({ run_id: decodeURIComponent(url.pathname.slice(6)) }));
        else if (request.method === "POST" && url.pathname.endsWith("/cancel") && url.pathname.startsWith("/runs/")) send(200, this.service.hostRunCancel({ ...body, run_id: decodeURIComponent(url.pathname.slice(6, -7)) }));
        else send(404, { error: "Not found" });
      } catch (error) { send(error instanceof SyntaxError ? 400 : error instanceof Error && error.message.includes("256 KiB") ? 413 : 422, { error: String(error) }); }
      }); });
      this.#server = server;
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      const activePort = (server.address() as AddressInfo).port; const state = { status: "running", pid: process.pid, host: this.host, owner_id: this.ownerId, url: `http://127.0.0.1:${activePort}`, started_at: new Date().toISOString() }; await atomicPrivateJson(this.statePath, state); await this.heartbeat();
      this.#heartbeat = setInterval(() => {
        if (this.#heartbeatWork) return;
        this.#heartbeatWork = this.heartbeat().catch(async (error: unknown) => {
          this.#heartbeatFailure = new Error("Supervisor heartbeat failed; handoff required", { cause: error });
          this.stopHeartbeat(); await this.stopListening();
        }).finally(() => { this.#heartbeatWork = null; });
      }, this.heartbeatMs);
      this.#heartbeat.unref(); return state;
    } catch (error) {
      // Owning the lock is not successful startup. Stop a partially published
      // listener before releasing ownership, including incomplete HTTP peers.
      await this.stopListening();
      try { await this.release(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Supervisor startup failed and lock cleanup requires reconciliation"); }
      throw error;
    }
  }
  /** Start the local supervisor, or reuse a healthy one owned by another
   * Craft process (for example the MCP host) without taking its lock. */
  async startOrReuse(port = 0): Promise<{ state: JsonObject; owned: boolean }> {
    try { return { state: await this.start(port), owned: true }; }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("already running")) throw error;
      const health = await new SupervisorClient(this.paths).status();
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as JsonObject;
      return { state: { ...state, ...health }, owned: false };
    }
  }
  private stopHeartbeat(): void { if (this.#heartbeat) clearInterval(this.#heartbeat); this.#heartbeat = null; }
  private async stopListening(): Promise<void> {
    const server = this.#server; this.#server = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  async close(): Promise<void> {
    this.stopHeartbeat(); await this.#heartbeatWork; await this.stopListening();
    try {
      await this.release();
      await atomicPrivateJson(this.statePath, { status: "stopped", pid: process.pid, host: this.host, owner_id: this.ownerId,
        stopped_at: new Date().toISOString(), handoff_required: this.#heartbeatFailure !== null });
    } catch (cleanupError) {
      if (this.#heartbeatFailure) throw new AggregateError([this.#heartbeatFailure, cleanupError], "Supervisor heartbeat failed and cleanup requires reconciliation");
      throw cleanupError;
    }
    if (this.#heartbeatFailure) throw this.#heartbeatFailure;
  }
  private async acquire(retry = true): Promise<string | null> {
    let handle;
    try { handle = await open(this.lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!retry) throw new Error("Supervisor lock changed during recovery");
      const previous = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject;
      if (previous.host !== this.host || this.isProcessAlive(Number(previous.pid))) throw new Error("Craft Supervisor is already running");
      // Owner identities remain opaque ledger data, never path components.
      const ownerDigest = createHash("sha256").update(String(previous.owner_id)).digest("hex");
      const recovered = join(this.paths.runtimeDir, `supervisor.lock.recovered.${Date.now()}.${ownerDigest}.json`);
      await rename(this.lockPath, recovered);
      const moved = JSON.parse(await readFile(recovered, "utf8")) as JsonObject;
      assertSupervisorOwner(previous.owner_id, moved.owner_id);
      await this.acquire(false); return String(previous.owner_id);
    }
    // Only exclusive-open EEXIST enters recovery. A later write failure is
    // not evidence of another owner, even if it carries the same error code.
    const creation: { identity?: { dev: number; ino: number } } = {};
    try {
      try {
        creation.identity = await handle.stat();
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: this.host, owner_id: this.ownerId, heartbeat_at: new Date().toISOString() }));
      } catch (writeError) {
        try { await handle.close(); }
        catch (closeError) { throw new AggregateError([writeError, closeError], "Supervisor lock write and close failed"); }
        throw writeError;
      }
      await handle.close();
    } catch (error) {
      // Partial JSON cannot prove ownership. Compare the created file identity
      // instead; this is defensive cleanup, not an atomic cross-process CAS.
      const identity = creation.identity;
      if (!identity) throw new Error("Supervisor lock identity unavailable; reconciliation required", { cause: error });
      try {
        const current = await lstat(this.lockPath);
        if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Supervisor lock identity changed");
        await unlink(this.lockPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw new AggregateError([error, cleanupError], "Supervisor lock initialization failed and cleanup requires reconciliation");
      }
      throw error;
    }
    return null;
  }
  private async heartbeat(): Promise<void> { const owner = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject; if (owner.owner_id !== this.ownerId) throw new Error("Supervisor lock ownership changed"); await atomicPrivateJson(this.lockPath, { ...owner, heartbeat_at: new Date().toISOString() }); }
  private async release(): Promise<void> { try { const owner = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject; if (owner.owner_id !== this.ownerId) throw new Error("Supervisor lock ownership changed"); await unlink(this.lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

export class SupervisorClient {
  readonly paths: CraftPaths; constructor(paths: CraftPaths) { this.paths = paths; }
  async call(method: "GET" | "POST", path: string, body: JsonObject = {}): Promise<JsonObject> {
    const state = JSON.parse(await readFile(join(this.paths.runtimeDir, "supervisor.json"), "utf8")) as JsonObject;
    if (state.status !== "running") throw new Error("Craft Supervisor is not running");
    const base = new URL(String(state.url)); const target = new URL(path, base);
    // Validate the resolved target before attaching local credentials. A path
    // can otherwise replace the origin, even when the saved URL is loopback.
    if (base.hostname !== "127.0.0.1" || base.protocol !== "http:" || target.origin !== base.origin || target.username || target.password) throw new Error("Supervisor state has an unsafe endpoint");
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = httpRequest(target, { method, headers: { authorization: `Bearer ${String(state.owner_id)}`, "content-type": "application/json", "content-length": data.length } }, (response) => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY) response.destroy(new Error("Supervisor response exceeds 256 KiB"));
          else chunks.push(chunk);
        });
        response.once("error", (error) => { clearTimeout(timer); reject(error); });
        response.on("end", () => {
          clearTimeout(timer);
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supervisor response must be an object");
            if (Number(response.statusCode) >= 400) reject(new Error(String((value as JsonObject).error)));
            else resolve(value as JsonObject);
          } catch (error) { reject(error); }
        });
      });
      // Wall-clock deadline also bounds a peer that keeps dribbling bytes.
      const timer = setTimeout(() => request.destroy(new Error("Supervisor request timed out")), 5_000);
      request.once("error", (error) => { clearTimeout(timer); reject(error); });
      request.end(data);
    });
  }
  status(): Promise<JsonObject> { return this.call("GET", "/health"); }
}
