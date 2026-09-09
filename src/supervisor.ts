import { timingSafeEqual } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { atomicPrivateJson, type CraftPaths } from "./paths.ts";
import { CraftService, VERSION } from "./service.ts";
import type { JsonObject } from "./store.ts";

const MAX_BODY = 256 * 1024;
function equal(left: string | undefined, right: string): boolean { if (!left) return false; const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function parse(body: Buffer): JsonObject { const value: unknown = JSON.parse(body.toString("utf8") || "{}"); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supervisor request must be an object"); return value as JsonObject; }
export function assertSupervisorOwner(expected: unknown, actual: unknown): void { if (actual !== expected) throw new Error("Supervisor lock changed during recovery"); }

export class LocalSupervisor {
  readonly service: CraftService; readonly paths: CraftPaths; readonly ownerId: string; readonly host: string; readonly isProcessAlive: (pid: number) => boolean;
  readonly heartbeatMs: number;
  #server: Server | null = null; #heartbeat: NodeJS.Timeout | null = null; #heartbeatWork: Promise<void> = Promise.resolve();
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
    const previousOwner = await this.acquire(); if (previousOwner) this.service.hostRunRecover({ owner_id: previousOwner, confirmed_original_runner_stopped: true });
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
    try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); } catch (error) { await this.release(); throw error; }
    this.#server = server; const activePort = (server.address() as AddressInfo).port; const state = { status: "running", pid: process.pid, host: this.host, owner_id: this.ownerId, url: `http://127.0.0.1:${activePort}`, started_at: new Date().toISOString() }; await atomicPrivateJson(this.statePath, state); await this.heartbeat(); this.#heartbeat = setInterval(() => { this.#heartbeatWork = this.#heartbeatWork.then(() => this.heartbeat()); }, this.heartbeatMs); this.#heartbeat.unref(); return state;
  }
  async close(): Promise<void> { if (this.#heartbeat) clearInterval(this.#heartbeat); this.#heartbeat = null; await this.#heartbeatWork; const server = this.#server; this.#server = null; if (server) await new Promise<void>((resolve) => server.close(() => resolve())); await this.release(); await atomicPrivateJson(this.statePath, { status: "stopped", pid: process.pid, host: this.host, owner_id: this.ownerId, stopped_at: new Date().toISOString() }); }
  private async acquire(retry = true): Promise<string | null> { try { const handle = await open(this.lockPath, "wx", 0o600); try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: this.host, owner_id: this.ownerId, heartbeat_at: new Date().toISOString() })); } finally { await handle.close(); } return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (!retry) throw new Error("Supervisor lock changed during recovery"); const previous = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject; if (previous.host !== this.host || this.isProcessAlive(Number(previous.pid))) throw new Error("Craft Supervisor is already running"); const recovered = join(this.paths.runtimeDir, `supervisor.lock.recovered.${Date.now()}.${String(previous.owner_id)}.json`); await rename(this.lockPath, recovered); const moved = JSON.parse(await readFile(recovered, "utf8")) as JsonObject; assertSupervisorOwner(previous.owner_id, moved.owner_id); await this.acquire(false); return String(previous.owner_id); } }
  private async heartbeat(): Promise<void> { const owner = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject; if (owner.owner_id !== this.ownerId) throw new Error("Supervisor lock ownership changed"); await atomicPrivateJson(this.lockPath, { ...owner, heartbeat_at: new Date().toISOString() }); }
  private async release(): Promise<void> { try { const owner = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject; if (owner.owner_id !== this.ownerId) throw new Error("Supervisor lock ownership changed"); await unlink(this.lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}

export class SupervisorClient {
  readonly paths: CraftPaths; constructor(paths: CraftPaths) { this.paths = paths; }
  async call(method: "GET" | "POST", path: string, body: JsonObject = {}): Promise<JsonObject> { const state = JSON.parse(await readFile(join(this.paths.runtimeDir, "supervisor.json"), "utf8")) as JsonObject; if (state.status !== "running") throw new Error("Craft Supervisor is not running"); const base = new URL(String(state.url)); if (base.hostname !== "127.0.0.1" || base.protocol !== "http:") throw new Error("Supervisor state has an unsafe endpoint"); const data = Buffer.from(JSON.stringify(body)); return new Promise((resolve, reject) => { const request = httpRequest(new URL(path, base), { method, headers: { authorization: `Bearer ${String(state.owner_id)}`, "content-type": "application/json", "content-length": data.length } }, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject; if (Number(response.statusCode) >= 400) reject(new Error(String(value.error))); else resolve(value); } catch (error) { reject(error); } }); }); request.once("error", reject); request.end(data); }); }
  status(): Promise<JsonObject> { return this.call("GET", "/health"); }
}
