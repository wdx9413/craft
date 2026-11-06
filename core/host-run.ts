import { randomUUID } from "node:crypto";
import type { HostDriver, HostOutputObserver } from "./host-driver.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { TraceKernel } from "./trace-kernel.ts";
import { text } from "./validation.ts";
import { payload } from "./digest.ts";



const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

export class HostRunKernel {
  readonly store: CraftStore; readonly drivers: Map<string, HostDriver>; readonly ownerId: string; readonly terminalObserver?: (run: JsonObject, receipt: JsonObject | null) => void; private controllers = new Map<string, AbortController>(); private completions = new Map<string, Promise<void>>();
  readonly trace?: TraceKernel;
  constructor(store: CraftStore, drivers: HostDriver[], ownerId = `runner_${randomUUID().replaceAll("-", "")}`, terminalObserver?: (run: JsonObject, receipt: JsonObject | null) => void, trace?: TraceKernel) { this.store = store; this.drivers = new Map(drivers.map((driver) => [driver.host, driver])); this.ownerId = ownerId; this.terminalObserver = terminalObserver; this.trace = trace; }
  private notifyTerminal(run: JsonObject, receipt: JsonObject | null): void { if (!this.terminalObserver) return; try { this.terminalObserver(run, receipt); } catch (error) { this.store.appendEvent(`host-run:${run.id}`, "host.projection_failed", { error_class: error instanceof Error ? error.name : "UnknownError" }); } }

  start(args: JsonObject): JsonObject {
    const host = text(args.host, "host"); const driver = this.drivers.get(host); if (!driver) throw new Error("Host Driver is unavailable");
    const dispatchId = text(args.dispatch_id, "dispatch_id"); const prompt = text(args.prompt, "prompt"); const runId = String(args.run_id ?? `host_run_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("host_run", runId); if (existing) { if (existing.host !== host || existing.dispatch_id !== dispatchId) throw new Error("Host run idempotency conflict"); return { run: existing, idempotent: true }; }
    // The dispatch record kind is owned by the driver, so adding a model CLI
    // never requires editing this kernel.
    const kind = driver.dispatchKind; const dispatch = this.store.get(kind, dispatchId); if (dispatch.status !== "prepared") throw new Error("Host dispatch must be prepared");
    const run = this.store.create("host_run", runId, { host, dispatch_id: dispatchId, task_id: dispatch.task_id, owner_id: this.ownerId, status: "running", cancel_requested: false, event_count: 0, started_at: new Date().toISOString() }); const controller = new AbortController(); this.controllers.set(runId, controller);
    const traceId = `host_run:${runId}`;
    if (this.trace) { this.trace.start({ trace_id: traceId, task_id: String(dispatch.task_id), run_id: runId, operation_id: dispatchId, metadata: { host } }); this.trace.append({ trace_id: traceId, event_kind: "host.started", actor: host, source: "host-run", trust: "observed", data: {}, summary: "Host execution started" }); }
    const observe: HostOutputObserver = (event) => { const current = this.store.get("host_run", runId); this.store.appendEvent(`host-run:${runId}`, "host.output", event); this.store.save("host_run", runId, { ...payload(current), event_count: Number(current.event_count) + 1 }); };
    const completion = driver.execute({ ...args, dispatch_id: dispatchId, prompt }, { signal: controller.signal, observe }).then((result) => { const current = this.store.get("host_run", runId); const receipt = result.receipt as JsonObject; const status = current.cancel_requested || receipt.cancelled ? "cancelled" : receipt.status === "completed" ? "completed" : "failed"; const saved = this.store.save("host_run", runId, { ...payload(current), status, receipt_id: receipt.id, finished_at: new Date().toISOString() }); this.store.appendEvent(`host-run:${runId}`, "host.finished", { status, receipt_id: receipt.id }); if (this.trace) { this.trace.append({ trace_id: traceId, event_kind: "host.finished", actor: "host-run", source: "host-run", trust: "observed", data: {}, output_refs: [String(receipt.id)], status, summary: "Host execution finished" }); this.trace.finalize({ trace_id: traceId, status: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed", summary: "Host run terminal" }); } this.notifyTerminal(saved, receipt); }).catch((error) => { const current = this.store.get("host_run", runId); const saved = this.store.save("host_run", runId, { ...payload(current), status: current.cancel_requested ? "cancelled" : "failed", error_class: error instanceof Error ? error.name : "UnknownError", finished_at: new Date().toISOString() }); if (this.trace) { this.trace.append({ trace_id: traceId, event_kind: "host.failed", actor: "host-run", source: "host-run", trust: "observed", data: {}, error_class: error instanceof Error ? error.name : "UnknownError", status: "failed", summary: "Host execution failed" }); this.trace.finalize({ trace_id: traceId, status: "failed", summary: "Host execution failed" }); } this.notifyTerminal(saved, null); }).finally(() => { this.controllers.delete(runId); });
    this.completions.set(runId, completion); return { run, idempotent: false };
  }

  get(args: JsonObject): JsonObject { const run = this.store.get("host_run", text(args.run_id, "run_id")); return { run, events: this.store.events(`host-run:${run.id}`), active: this.controllers.has(String(run.id)) }; }
  cancel(args: JsonObject): JsonObject { const run = this.store.get("host_run", text(args.run_id, "run_id")); if (TERMINAL.has(String(run.status))) return { run, idempotent: true }; const controller = this.controllers.get(String(run.id)); if (!controller) throw new Error("Host run is not owned by this process; recover it only after verifying the original runner stopped"); const saved = this.store.save("host_run", String(run.id), { ...payload(run), cancel_requested: true, cancel_reason: text(args.reason, "reason") }); controller.abort(); return { run: saved, idempotent: false }; }
  recover(args: JsonObject): JsonObject { if (args.confirmed_original_runner_stopped !== true) throw new Error("Recovery requires confirmed_original_runner_stopped=true"); const ownerId = text(args.owner_id, "owner_id"); const recovered: JsonObject[] = []; for (const run of this.store.list("host_run", Number.MAX_SAFE_INTEGER, (item) => new Set(["running", "cancel_requested"]).has(String(item.status)) && item.owner_id === ownerId)) if (!this.controllers.has(String(run.id))) { const saved = this.store.save("host_run", String(run.id), { ...payload(run), status: "interrupted", finished_at: new Date().toISOString() }); recovered.push(saved); this.notifyTerminal(saved, null); } return { recovered, count: recovered.length }; }
  async wait(runId: string): Promise<void> { const completion = this.completions.get(runId); await completion; if (completion) this.completions.delete(runId); }
}
