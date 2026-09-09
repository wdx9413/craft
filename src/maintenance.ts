import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { atomicPrivateJson, type CraftPaths } from "./paths.ts";
import { CraftService } from "./service.ts";
import { type JsonObject } from "./store.ts";

function integer(value: unknown, name: string, fallback: number, min: number, max: number): number { const result = value === undefined ? fallback : Number(value); if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); return result; }
function instant(value: unknown): string { const result = value === undefined ? new Date().toISOString() : String(value); if (Number.isNaN(Date.parse(result))) throw new Error("now must be an ISO timestamp"); return result; }
function payload(record: JsonObject): JsonObject { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }

export class MaintenanceKernel {
  readonly service: CraftService;
  constructor(service: CraftService) { this.service = service; }

  tick(args: JsonObject = {}): JsonObject {
    const now = instant(args.now); const nowMs = Date.parse(now); const limit = integer(args.limit, "limit", 100, 1, 1000);
    const baseBackoffMs = integer(args.base_backoff_ms, "base_backoff_ms", 1_000, 100, 3_600_000);
    const maxBackoffMs = integer(args.max_backoff_ms, "max_backoff_ms", 300_000, baseBackoffMs, 86_400_000);
    const outcomes: JsonObject[] = []; const execute = (component: string, operation: () => JsonObject): JsonObject | null => {
      const previous = this.service.store.find("maintenance_component", component); const nextRetry = previous?.next_retry_at ? Date.parse(String(previous.next_retry_at)) : 0;
      if (nextRetry > nowMs) { outcomes.push({ component, status: "backoff", next_retry_at: previous!.next_retry_at }); return null; }
      try { const result = operation(); this.service.store.save("maintenance_component", component, { status: "healthy", consecutive_failures: 0, last_success_at: now, next_retry_at: null }); outcomes.push({ component, status: "passed" }); return result; }
      catch (error) { const failures = Number(previous?.consecutive_failures ?? 0) + 1; const delay = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.min(failures - 1, 20));
        const errorType = error instanceof Error ? error.name : "NonErrorThrow"; const errorFingerprint = `sha256:${createHash("sha256").update(`${errorType}:${error instanceof Error ? error.message : String(error)}`).digest("hex")}`;
        const nextRetryAt = new Date(nowMs + delay).toISOString(); this.service.store.save("maintenance_component", component, { status: failures >= 3 ? "open" : "degraded", consecutive_failures: failures,
          last_failure_at: now, next_retry_at: nextRetryAt, error_type: errorType, error_fingerprint: errorFingerprint });
        this.service.store.create("maintenance_failure", `maintenance_failure_${randomUUID().replaceAll("-", "")}`, { component, observed_at: now, consecutive_failures: failures,
          error_type: errorType, error_fingerprint: errorFingerprint, next_retry_at: nextRetryAt }); outcomes.push({ component, status: "failed", next_retry_at: nextRetryAt }); return null; }
    };
    const recoveryLeases = execute("recovery_leases", () => this.service.recoveryLeaseRecover({ now, limit }));
    const hydrationLeases = execute("hydration_leases", () => this.service.hydrationLeaseRecover({ now, limit }));
    const speculative = execute("speculative_expiry", () => this.service.speculativeExpire({ now, limit }));
    const acceptance = execute("acceptance_evaluation_leases", () => this.service.acceptanceEvaluationRecover({ now, limit }));
    const sources = this.service.store.list("hub_source", limit); const reconciliations = sources.map((source) => execute(`hub:${source.id}`, () => this.service.supplyChainReconcile({ source_id: source.id }))).filter(Boolean) as JsonObject[];
    const recovery = execute("recovery_projection", () => this.service.recoveryQueueRefresh({ now, limit }));
    const attention = execute("attention_projection", () => this.service.attentionRefresh({ now, limit }));
    const degraded = outcomes.some((item) => item.status !== "passed");
    const previous = this.service.store.find("maintenance_status", "local");
    const receipt = this.service.store.create("maintenance_tick", `maintenance_tick_${randomUUID().replaceAll("-", "")}`, { observed_at: now, limit,
      source_count: sources.length, invalidated_count: reconciliations.reduce((sum, item) => sum + Number(item.count), 0), recovery_count: Number(recovery?.count ?? 0),
      recovered_recovery_leases: Number(recoveryLeases?.recovered ?? 0), recovered_hydration_leases: Number(hydrationLeases?.recovered ?? 0),
      expired_speculative_candidates: Number(speculative?.expired ?? 0), recovered_acceptance_jobs: Number(acceptance?.recovered ?? 0), exhausted_acceptance_jobs: Number(acceptance?.exhausted ?? 0), attention_count: Number(attention?.count ?? 0), component_outcomes: outcomes, status: degraded ? "degraded" : "passed" });
    const status = this.service.store.save("maintenance_status", "local", { ...(previous ? payload(previous) : {}), status: degraded ? "degraded" : "healthy", last_tick_at: now,
      limit, source_count: sources.length, invalidated_count: reconciliations.reduce((sum, item) => sum + Number(item.count), 0),
      recovery_count: Number(recovery?.count ?? 0), recovered_recovery_leases: Number(recoveryLeases?.recovered ?? 0),
      recovered_hydration_leases: Number(hydrationLeases?.recovered ?? 0), expired_speculative_candidates: Number(speculative?.expired ?? 0),
      recovered_acceptance_jobs: Number(acceptance?.recovered ?? 0), exhausted_acceptance_jobs: Number(acceptance?.exhausted ?? 0), attention_count: Number(attention?.count ?? 0), last_tick_id: receipt.id });
    return { status, receipt, outcomes, reconciliations, recovery, attention };
  }
}

type RunOptions = { intervalMs?: number; maxTicks?: number; now?: () => string; wait?: (ms: number) => Promise<void>; signal?: AbortSignal };

export class LocalMaintenanceWorker {
  readonly kernel: MaintenanceKernel; readonly paths: CraftPaths; readonly token = randomUUID(); readonly host: string;
  readonly staleAfterMs: number; readonly isProcessAlive: (pid: number) => boolean; readonly afterTick: (() => Promise<unknown>) | null;
  constructor(kernel: MaintenanceKernel, paths: CraftPaths, options: { host?: string; staleAfterMs?: number; isProcessAlive?: (pid: number) => boolean; afterTick?: () => Promise<unknown> } = {}) {
    this.kernel = kernel; this.paths = paths; this.host = options.host ?? hostname();
    this.staleAfterMs = integer(options.staleAfterMs, "stale_after_ms", 120_000, 1_000, 86_400_000);
    this.afterTick = options.afterTick ?? null; this.isProcessAlive = options.isProcessAlive ?? ((pid) => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } });
  }
  private get lockPath(): string { return join(this.paths.runtimeDir, "maintenance.lock.json"); }
  private get statePath(): string { return join(this.paths.runtimeDir, "maintenance-worker.json"); }

  async run(options: RunOptions = {}): Promise<JsonObject> {
    const intervalMs = integer(options.intervalMs, "interval_ms", 30_000, 100, 3_600_000); const maxTicks = integer(options.maxTicks, "max_ticks", Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    await this.acquire(); let ticks = 0;
    try {
      while (ticks < maxTicks && !options.signal?.aborted) { const now = options.now?.() ?? new Date().toISOString(); const result = this.kernel.tick({ now }); if (this.afterTick) await this.afterTick(); ticks += 1; await this.heartbeat(now);
        await atomicPrivateJson(this.statePath, { status: "running", pid: process.pid, token: this.token, ticks, last_tick_at: now,
          maintenance_status_version: (result.status as JsonObject).version });
        if (ticks < maxTicks && !options.signal?.aborted) await (options.wait ?? ((ms) => new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms); options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        })))(intervalMs);
      }
      return { status: "stopped", ticks };
    } finally { await this.release(); await atomicPrivateJson(this.statePath, { status: "stopped", pid: process.pid, token: this.token, ticks, stopped_at: new Date().toISOString() }); }
  }

  async status(): Promise<JsonObject> {
    try { const state = JSON.parse(await readFile(this.statePath, "utf8")) as JsonObject; let owner: JsonObject | null = null;
      try { owner = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const online = Boolean(owner && owner.token === state.token && owner.host === this.host && this.isProcessAlive(Number(owner.pid)));
      return { ...state, online }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "not_started" }; throw error; }
  }

  private async acquire(retry = true): Promise<void> {
    let handle;
    try { handle = await open(this.lockPath, "wx", 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.token, host: this.host, heartbeat_at: new Date().toISOString() })); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { if (!retry) throw new Error("Craft maintenance worker lock changed during recovery"); await this.reclaimStale(); return this.acquire(false); } throw error; }
    finally { await handle?.close(); }
  }
  private async heartbeat(now: string): Promise<void> { const owner = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject;
    if (owner.token !== this.token) throw new Error("Craft maintenance lock ownership changed");
    await atomicPrivateJson(this.lockPath, { ...owner, heartbeat_at: now });
  }
  private async reclaimStale(): Promise<void> { const owner = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject; const heartbeat = Date.parse(String(owner.heartbeat_at));
    if (owner.host !== this.host || this.isProcessAlive(Number(owner.pid)) || Number.isNaN(heartbeat) || Date.now() - heartbeat <= this.staleAfterMs) throw new Error("Craft maintenance worker is already running");
    const recovered = join(this.paths.runtimeDir, `maintenance.lock.recovered.${Date.now()}.${String(owner.token)}.json`); await rename(this.lockPath, recovered);
    const moved = JSON.parse(await readFile(recovered, "utf8")) as JsonObject; this.assertSameOwner(owner, moved);
  }
  private assertSameOwner(expected: JsonObject, actual: JsonObject): void { if (actual.token !== expected.token) throw new Error("Craft maintenance lock changed during recovery"); }
  private async release(): Promise<void> {
    let owner: JsonObject;
    try { owner = JSON.parse(await readFile(this.lockPath, "utf8")) as JsonObject; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (owner.token !== this.token) throw new Error("Craft maintenance lock ownership changed");
    await unlink(this.lockPath);
  }
}
