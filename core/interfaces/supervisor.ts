import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { atomicPrivateJson, type CraftPaths } from "../infrastructure/paths.ts";
import { CraftService, VERSION } from "../application/craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { SupervisorClient } from "../infrastructure/supervisor-client.ts";
export { SupervisorClient } from "../infrastructure/supervisor-client.ts";

const MAX_BODY = 256 * 1024;
const MAX_CONTEXT_BODY = 2 * 1024 * 1024;
const MAX_CONTEXT_TOTAL = 16 * 1024 * 1024;
const MAX_CONTEXT_ENTRIES = 1000;
const MAX_CONTEXT_TTL_MS = 86_400_000;
/** Narrow filesystem port for the lock file; injectable for deterministic cleanup tests. */
type SupervisorLockHandle = { fd: number; stat(): Promise<{ dev: number; ino: number }>; writeFile(data: string): Promise<void>; close(): Promise<void> };
type SupervisorLockFs = {
  open: (path: string, flags: "wx", mode: number) => Promise<SupervisorLockHandle>;
  lstat: (path: string) => Promise<{ dev: number; ino: number }>;
  unlink: (path: string) => Promise<void>;
};
const defaultLockFs: SupervisorLockFs = {
  open: async (path, flags, mode) => open(path, flags, mode),
  lstat: async (path) => { const value = await lstat(path); return { dev: Number(value.dev), ino: Number(value.ino) }; },
  unlink: (path) => unlink(path),
};
function equal(left: string | undefined, right: string): boolean { if (!left) return false; const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function parse(body: Buffer): JsonObject { const value: unknown = JSON.parse(body.toString("utf8") || "{}"); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supervisor request must be an object"); return value as JsonObject; }
export function assertSupervisorOwner(expected: unknown, actual: unknown): void { if (actual !== expected) throw new Error("Supervisor lock changed during recovery"); }

export class LocalSupervisor {
  readonly service: CraftService; readonly paths: CraftPaths; readonly ownerId: string; readonly host: string; readonly isProcessAlive: (pid: number) => boolean;
  readonly fs: SupervisorLockFs;
  readonly heartbeatMs: number;
  #server: Server | null = null; #heartbeat: NodeJS.Timeout | null = null; #heartbeatWork: Promise<void> | null = null;
  #heartbeatFailure: Error | null = null;
  #context = new Map<string, { session: string; value: JsonObject; expires: number; bytes: number }>();
  #endedContextSessions = new Map<string, number>();
  #contextClaims = new Map<string, Map<string, number>>();
  constructor(service: CraftService, paths: CraftPaths, options: { ownerId?: string; host?: string; heartbeatMs?: number; isProcessAlive?: (pid: number) => boolean;
    fs?: Partial<SupervisorLockFs> } = {}) {
    this.service = service; this.paths = paths; this.ownerId = options.ownerId ?? service.hostRuns.ownerId; this.host = options.host ?? hostname();
    this.fs = { ...defaultLockFs, ...options.fs };
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
      const server = createServer((request, response) => { const chunks: Buffer[] = []; let size = 0; const bodyLimit = String(request.url).startsWith("/context/") ? MAX_CONTEXT_BODY : MAX_BODY; request.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= bodyLimit) chunks.push(chunk); else if (!response.headersSent) { request.removeAllListeners("end"); response.writeHead(413, { "content-type": "application/json", "connection": "close" }); response.end(JSON.stringify({ error: "Supervisor request exceeds size limit" })); request.pause(); response.once("finish", () => request.destroy()); } }); request.on("end", async () => {
      const send = (status: number, value: JsonObject) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
      const token = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined; if (!equal(token, this.ownerId)) { send(401, { error: "Supervisor token required" }); return; }
      try { const url = new URL(String(request.url), "http://127.0.0.1"); const body = parse(Buffer.concat(chunks));
        if (request.method === "GET" && url.pathname === "/health") send(200, { status: "ok", version: VERSION, owner_id: this.ownerId });
        else if (request.method === "POST" && url.pathname.startsWith("/context/")) send(200, this.contextOperation(url.pathname, body));
        else if (request.method === "POST" && url.pathname === "/runs/start") send(202, this.service.hostRunStart(body));
        else if (request.method === "GET" && url.pathname.startsWith("/runs/")) send(200, this.service.hostRunGet({ run_id: decodeURIComponent(url.pathname.slice(6)) }));
        else if (request.method === "POST" && url.pathname.endsWith("/cancel") && url.pathname.startsWith("/runs/")) send(200, this.service.hostRunCancel({ ...body, run_id: decodeURIComponent(url.pathname.slice(6, -7)) }));
        else send(404, { error: "Not found" });
      } catch (error) { send(error instanceof SyntaxError ? 400 : error instanceof Error && error.message.includes("size limit") ? 413 : 422, { error: String(error) }); }
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
  private contextOperation(path: string, body: JsonObject): JsonObject {
    const session = body.session_key;
    if (typeof session !== "string" || !/^[a-z][a-z0-9_-]{0,31}--[a-f0-9]{64}$/u.test(session)) throw new Error("Context session key is invalid");
    const now = Date.now();
    for (const [key, entry] of this.#context) if (entry.expires <= now) this.#context.delete(key);
    for (const [key, expires] of this.#endedContextSessions) if (expires <= now) this.#endedContextSessions.delete(key);
    for (const [owner, claims] of this.#contextClaims) {
      for (const [token, expires] of claims) if (expires <= now) claims.delete(token);
      if (!claims.size) this.#contextClaims.delete(owner);
    }
    const hasClaim = typeof body.claim_token === "string" && (this.#contextClaims.get(session)?.has(body.claim_token) ?? false);
    if (path === "/context/claim") {
      if (this.#endedContextSessions.has(session)) throw new Error("SESSION_ARCHIVED: session Context is unavailable");
      const claims = this.#contextClaims.get(session) ?? new Map<string, number>();
      const totalClaims = [...this.#contextClaims.values()].reduce((total, entries) => total + entries.size, 0);
      if (claims.size >= 100 || totalClaims >= MAX_CONTEXT_ENTRIES || !this.#contextClaims.has(session) && this.#contextClaims.size >= MAX_CONTEXT_ENTRIES) throw new Error("Context claim capacity exceeded");
      const token = randomUUID(); claims.set(token, now + MAX_CONTEXT_TTL_MS); this.#contextClaims.set(session, claims);
      return { token };
    }
    if (path === "/context/release") {
      if (typeof body.token !== "string") throw new Error("Context claim token is invalid");
      const claims = this.#contextClaims.get(session), removed = claims?.delete(body.token) ?? false;
      if (claims && !claims.size) this.#contextClaims.delete(session);
      return { released: removed };
    }
    if (path === "/context/start") {
      if (this.#contextClaims.has(session)) throw new Error("SESSION_BUSY: session finalization is in progress");
      this.#endedContextSessions.delete(session);
      for (const key of this.#context.keys()) {
        const [owner, name] = JSON.parse(key) as [string, string];
        if (owner === session && name.startsWith("hook:session:")) this.#context.delete(key);
      }
      return { status: "started" };
    }
    if (path === "/context/end") {
      if (!this.#endedContextSessions.has(session) && this.#endedContextSessions.size >= MAX_CONTEXT_ENTRIES) throw new Error("Context session capacity exceeded");
      this.#endedContextSessions.set(session, now + MAX_CONTEXT_TTL_MS);
      if (this.#contextClaims.has(session)) throw new Error("SESSION_BUSY: session finalization is in progress");
      let removed = 0;
      for (const [key, entry] of this.#context) if (entry.session === session) { this.#context.delete(key); removed++; }
      return { status: "ended", removed };
    }
    if (path === "/context/purge" && body.key === undefined) {
      if (this.#endedContextSessions.has(session) && !hasClaim) throw new Error("SESSION_ARCHIVED: session Context is unavailable");
      if (body.prefix === undefined && body.all !== true) throw new Error("Context purge requires a key, prefix, or explicit all");
      if (body.prefix !== undefined && (typeof body.prefix !== "string" || body.prefix.length > 256)) throw new Error("Context prefix is invalid");
      let removed = 0;
      for (const [key, entry] of this.#context) {
        const storedKey = JSON.parse(key) as [string, string];
        if (entry.session === session && (body.prefix === undefined || storedKey[1].startsWith(String(body.prefix)))) {
          this.#context.delete(key); removed++;
        }
      }
      return { removed };
    }
    if (typeof body.key !== "string" || !body.key || body.key.length > 256) throw new Error("Context key is invalid");
    const key = JSON.stringify([session, body.key]);
    if (body.key.startsWith("index:") && [...this.#context.keys()].some(stored => {
      const [owner, name] = JSON.parse(stored) as [string, string];
      return name === body.key && owner !== session;
    })) throw new Error("ephemeral index scope mismatch");
    if (path === "/context/snapshot-get" || path === "/context/snapshot-publish" || path === "/context/snapshot-abort") {
      if (!/^learning-index:[a-f0-9]{24}:manifest$/u.test(body.key)) throw new Error("Learning snapshot key is invalid");
      if (path === "/context/snapshot-publish" && this.#endedContextSessions.has(session)) throw new Error("SESSION_ARCHIVED: session Context is unavailable");
      const prefix = body.key.slice(0, -"manifest".length);
      const previous = this.#context.get(key);
      if (path === "/context/snapshot-abort") {
        if (typeof body.generation !== "string" || !/^[a-f0-9-]{36}$/u.test(body.generation)) throw new Error("Learning snapshot generation is invalid");
        if (previous?.value.generation === body.generation) return { status: "retained" };
        let removed = 0;
        for (const stored of this.#context.keys()) {
          const [owner, name] = JSON.parse(stored) as [string, string];
          if (owner === session && name.startsWith(`${prefix}${body.generation}:`)) { this.#context.delete(stored); removed++; }
        }
        return { status: "aborted", removed };
      }
      const metadata = path === "/context/snapshot-get" ? previous?.value : body.value;
      if (metadata === undefined && path === "/context/snapshot-get") return { status: "unavailable" };
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Learning state manifest is invalid");
      const manifest = metadata as JsonObject;
      if (typeof manifest.generation !== "string" || !/^[a-f0-9-]{36}$/u.test(manifest.generation)
        || !Number.isSafeInteger(manifest.count) || Number(manifest.count) < 1 || Number(manifest.count) > 12
        || typeof manifest.digest !== "string") throw new Error("Learning state manifest is invalid");
      const chunks: string[] = [];
      for (let index = 0; index < Number(manifest.count); index++) {
        const entry = this.#context.get(JSON.stringify([session, `${prefix}${manifest.generation}:${index}`]));
        if (!entry || typeof entry.value.data !== "string") throw new Error("Learning state snapshot is unavailable");
        chunks.push(entry.value.data);
      }
      const encoded = chunks.join("");
      if (Buffer.byteLength(encoded) > 6 * 1024 * 1024) throw new Error("Learning state snapshot exceeds size limit");
      if (path === "/context/snapshot-get") return { status: "available", manifest, encoded };
      const ttl = body.ttl_ms;
      if (!Number.isSafeInteger(ttl) || Number(ttl) < 1 || Number(ttl) > MAX_CONTEXT_TTL_MS) throw new Error("Context TTL is invalid");
      const digest = `sha256:${createHash("sha256").update(JSON.stringify(encoded)).digest("hex")}`;
      if (manifest.digest !== digest) throw new Error("Learning state snapshot digest mismatch");
      for (let index = 0; index < Number(manifest.count); index++) {
        const chunk = this.#context.get(JSON.stringify([session, `${prefix}${manifest.generation}:${index}`]))!;
        chunk.expires = Math.max(chunk.expires, now + Number(ttl));
      }
      const bytes = Buffer.byteLength(JSON.stringify(manifest));
      const total = [...this.#context.values()].reduce((sum, entry) => sum + entry.bytes, 0) - (previous?.bytes ?? 0);
      if (total + bytes > MAX_CONTEXT_TOTAL || !previous && this.#context.size >= MAX_CONTEXT_ENTRIES) throw new Error("Context memory capacity exceeded");
      this.#context.set(key, { session, value: manifest, expires: now + Number(ttl), bytes });
      const old = previous?.value.generation;
      if (typeof old === "string" && old !== manifest.generation && /^[a-f0-9-]{36}$/u.test(old)) {
        const oldPrefix = `${prefix}${old}:`;
        for (const stored of this.#context.keys()) {
          const [owner, name] = JSON.parse(stored) as [string, string];
          if (owner === session && name.startsWith(oldPrefix)) this.#context.delete(stored);
        }
      }
      return { status: "stored" };
    }
    if (path === "/context/get") {
      const entry = this.#context.get(key);
      return entry ? { status: "available", value: entry.value } : { status: "unavailable", ...((String(body.key).startsWith("hook:") || String(body.key).startsWith("goal:")) && this.#endedContextSessions.has(session) && !hasClaim ? { ended: true } : {}) };
    }
    if (path === "/context/purge") {
      if (this.#endedContextSessions.has(session) && !hasClaim) throw new Error("SESSION_ARCHIVED: session Context is unavailable");
      const current = this.#context.get(key);
      if (current && body.source !== undefined && current.value.source !== body.source) throw new Error("ephemeral index scope mismatch");
      if (current && body.expected_identity_digest !== undefined && current.value.identity_digest !== body.expected_identity_digest) return { removed: 0, changed: true };
      if (current && body.expected_expires_at !== undefined && current.value.expires_at !== body.expected_expires_at) return { removed: 0, changed: true };
      return { removed: Number(this.#context.delete(key)) };
    }
    if (path !== "/context/put") throw new Error("Context operation is invalid");
    if (this.#endedContextSessions.has(session) && !hasClaim) throw new Error("SESSION_ARCHIVED: session Context is unavailable");
    if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) throw new Error("Context value must be an object");
    const ttl = body.ttl_ms;
    if (!Number.isSafeInteger(ttl) || Number(ttl) < 1 || Number(ttl) > MAX_CONTEXT_TTL_MS) throw new Error("Context TTL is invalid");
    const bytes = Buffer.byteLength(JSON.stringify(body.value));
    const current = this.#context.get(key);
    const snapshotChunk = /^(learning-index:[a-f0-9]{24}:)([a-f0-9-]{36}):[0-9]+$/u.exec(String(body.key));
    const publishedChunk = snapshotChunk && this.#context.get(JSON.stringify([session, `${snapshotChunk[1]}manifest`]))?.value.generation === snapshotChunk[2];
    if (publishedChunk && (!current || JSON.stringify(current.value) !== JSON.stringify(body.value))) throw new Error("Published learning snapshot is immutable");
    if (body.expected_digest !== undefined) {
      if (body.expected_digest !== null && (typeof body.expected_digest !== "string" || !/^[a-f0-9]{64}$/u.test(body.expected_digest))) throw new Error("Context expected digest is invalid");
      const digest = current ? createHash("sha256").update(JSON.stringify(current.value)).digest("hex") : null;
      if (digest !== body.expected_digest) return { status: "changed" };
    }
    if (current && String(body.key).startsWith("goal:") && JSON.stringify(current.value) !== JSON.stringify(body.value)) {
      throw new Error("Experience task-goal idempotency conflict");
    }
    if (current && String(body.key).startsWith("index:")) {
      const incoming = body.value as JsonObject;
      if (current.value.session_id !== incoming.session_id || current.value.session_host !== incoming.session_host || current.value.source !== incoming.source) {
        throw new Error("ephemeral index scope mismatch");
      }
    }
    const total = [...this.#context.values()].reduce((sum, entry) => sum + entry.bytes, 0) - (current?.bytes ?? 0);
    if (bytes > MAX_CONTEXT_BODY || total + bytes > MAX_CONTEXT_TOTAL || !current && this.#context.size >= MAX_CONTEXT_ENTRIES) throw new Error("Context memory capacity exceeded");
    this.#context.set(key, { session, value: body.value as JsonObject, expires: publishedChunk && current ? Math.max(current.expires, now + Number(ttl)) : now + Number(ttl), bytes });
    return { status: "stored" };
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
    this.#context.clear();
    this.#endedContextSessions.clear();
    this.#contextClaims.clear();
    const server = this.#server; this.#server = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  async close(): Promise<void> {
    this.#context.clear();
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
    try { handle = await this.fs.open(this.lockPath, "wx", 0o600); }
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
        const current = await this.fs.lstat(this.lockPath);
        if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Supervisor lock identity changed");
        await this.fs.unlink(this.lockPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw new AggregateError([error, cleanupError], "Supervisor lock initialization failed and cleanup requires reconciliation");
      }
      throw error;
    }
    return null;
  }
  private async heartbeat(): Promise<void> { const owner = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject; if (owner.owner_id !== this.ownerId) throw new Error("Supervisor lock ownership changed"); await atomicPrivateJson(this.lockPath, { ...owner, heartbeat_at: new Date().toISOString() }); }
  private async release(): Promise<void> { try { const owner = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject; if (owner.owner_id !== this.ownerId) throw new Error("Supervisor lock ownership changed"); await this.fs.unlink(this.lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
