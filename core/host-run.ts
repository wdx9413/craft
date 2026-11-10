import { assertAttemptBudget } from "./work-attempt-budget.ts";
import { randomUUID } from "node:crypto";
import { HostProcessCleanupError, type HostDriver, type HostOutputObserver } from "./host-driver.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { TraceKernel } from "./trace-kernel.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";
import { assertTaskAssignmentOwner } from "./task-assignment.ts";



const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

export class HostRunKernel {
  readonly store: CraftStore; readonly drivers: Map<string, HostDriver>; readonly ownerId: string; readonly terminalObserver?: (run: JsonObject, receipt: JsonObject | null) => void; private controllers = new Map<string, AbortController>(); private completions = new Map<string, Promise<void>>();
  private cancellationPoller: ReturnType<typeof setInterval> | null = null;
  readonly trace?: TraceKernel;
  constructor(store: CraftStore, drivers: HostDriver[], ownerId = `runner_${randomUUID().replaceAll("-", "")}`, terminalObserver?: (run: JsonObject, receipt: JsonObject | null) => void, trace?: TraceKernel) { this.store = store; this.drivers = new Map(drivers.map((driver) => [driver.host, driver])); this.ownerId = ownerId; this.terminalObserver = terminalObserver; this.trace = trace; }
  private notifyTerminal(run: JsonObject, receipt: JsonObject | null): void { if (!this.terminalObserver) return; try { this.terminalObserver(run, receipt); } catch (error) { this.store.appendEvent(`host-run:${run.id}`, "host.projection_failed", { error_class: error instanceof Error ? error.name : "UnknownError" }); } }

  private observeCancellation(): void {
    for (const [id, controller] of this.controllers) {
      try { if (this.store.find("host_run", id)?.cancel_requested === true) controller.abort(); }
      catch { /* A transient store error must not terminate the running Host. */ }
    }
  }

  start(args: JsonObject): JsonObject {
    const host = text(args.host, "host"); const driver = this.drivers.get(host); if (!driver) throw new Error("Host Driver is unavailable");
    const dispatchId = text(args.dispatch_id, "dispatch_id"); const prompt = text(args.prompt, "prompt"); const runId = String(args.run_id ?? `host_run_${randomUUID().replaceAll("-", "")}`);
    // The dispatch record kind is owned by the driver, so adding a model CLI
    // never requires editing this kernel.
    const registration = this.store.transaction(() => {
      const existing = this.store.find("host_run", runId);
      if (existing) {
        if (existing.host !== host || existing.dispatch_id !== dispatchId) throw new Error("Host run idempotency conflict");
        const dispatch = this.store.get(driver.dispatchKind, dispatchId);
        if (typeof dispatch.prompt_digest === "string" && dispatch.prompt_digest !== digestJson(prompt)) throw new Error("Host run prompt does not match the prepared digest");
        return { run: existing, idempotent: true };
      }
      if (this.store.list("host_run", 1, item => item.host === host && item.dispatch_id === dispatchId).length) throw new Error("Host dispatch already has a run; prepare a new dispatch to retry");
      const dispatch = this.store.get(driver.dispatchKind, dispatchId);
      if (typeof dispatch.prompt_digest === "string" && dispatch.prompt_digest !== digestJson(prompt)) throw new Error("Host run prompt does not match the prepared digest");
      if (dispatch.status !== "prepared") throw new Error("Host dispatch must be prepared");
      assertTaskAssignmentOwner(this.store, String(dispatch.task_id), args.actor);
      const launch = this.store.list("work_launch", 1, item => item.dispatch_id === dispatchId)[0];
      if (launch) assertAttemptBudget(this.store, launch);
      if (this.store.list("task_run", 1, item => item.dispatch_id === dispatchId && item.lifecycle !== "active").length) throw new Error("Paused or cancelled Task Run cannot start its Host");
      return { run: this.store.create("host_run", runId, { host, dispatch_id: dispatchId, task_id: dispatch.task_id, owner_id: this.ownerId, status: "running", cancel_requested: false, event_count: 0, started_at: new Date().toISOString() }), idempotent: false };
    });
    if (registration.idempotent) return registration;
    const run = registration.run; const controller = new AbortController(); this.controllers.set(runId, controller);
    if (!this.cancellationPoller) { this.cancellationPoller = setInterval(() => this.observeCancellation(), 250); this.cancellationPoller.unref(); }
    const traceId = `host_run:${runId}`;
    if (this.trace) { this.trace.start({ trace_id: traceId, task_id: String(run.task_id), run_id: runId, operation_id: dispatchId, metadata: { host } }); this.trace.append({ trace_id: traceId, event_kind: "host.started", actor: host, source: "host-run", trust: "observed", data: {}, summary: "Host execution started" }); }
    const observe: HostOutputObserver = (event) => { this.store.transaction(() => { const current = this.store.get("host_run", runId); this.store.appendEvent(`host-run:${runId}`, "host.output", event); this.store.save("host_run", runId, { ...payload(current), event_count: Number(current.event_count) + 1 }); }); };
    const completion = driver.execute({ ...args, dispatch_id: dispatchId, prompt }, { signal: controller.signal, observe }).then((result) => { const receipt = result.receipt as JsonObject; const status = receipt.cancelled ? "cancelled" : receipt.status === "completed" ? "completed" : "failed"; const saved = this.store.transaction(() => { const current = this.store.get("host_run", runId); return this.store.save("host_run", runId, { ...payload(current), status, receipt_id: receipt.id, finished_at: new Date().toISOString() }); }); this.store.appendEvent(`host-run:${runId}`, "host.finished", { status, receipt_id: receipt.id }); if (this.trace) { this.trace.append({ trace_id: traceId, event_kind: "host.finished", actor: "host-run", source: "host-run", trust: "observed", data: {}, output_refs: [String(receipt.id)], status, summary: "Host execution finished" }); this.trace.finalize({ trace_id: traceId, status: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed", summary: "Host run terminal" }); } this.notifyTerminal(saved, receipt); }).catch((error) => { const saved = this.store.transaction(() => { const current = this.store.get("host_run", runId); return this.store.save("host_run", runId, { ...payload(current), status: current.cancel_requested || error instanceof HostProcessCleanupError ? "interrupted" : "failed", ...(error instanceof HostProcessCleanupError ? { cleanup_unconfirmed: true } : {}), error_class: error instanceof Error ? error.name : "UnknownError", finished_at: new Date().toISOString() }); }); if (this.trace) { this.trace.append({ trace_id: traceId, event_kind: "host.failed", actor: "host-run", source: "host-run", trust: "observed", data: {}, error_class: error instanceof Error ? error.name : "UnknownError", status: "failed", summary: "Host execution failed" }); this.trace.finalize({ trace_id: traceId, status: "failed", summary: "Host execution failed" }); } this.notifyTerminal(saved, null); }).finally(() => { this.controllers.delete(runId); if (this.controllers.size === 0 && this.cancellationPoller) { clearInterval(this.cancellationPoller); this.cancellationPoller = null; } });
    this.completions.set(runId, completion); return { run, idempotent: false };
  }

  get(args: JsonObject): JsonObject { const run = this.store.get("host_run", text(args.run_id, "run_id")); return { run, events: this.store.events(`host-run:${run.id}`), active: this.controllers.has(String(run.id)) }; }
  cancel(args: JsonObject): JsonObject {
    const result = this.store.transaction(() => {
      const run = this.store.get("host_run", text(args.run_id, "run_id"));
      if (TERMINAL.has(String(run.status)) || run.cancel_requested === true) return { run, idempotent: true };
      const saved = this.store.save("host_run", String(run.id), { ...payload(run), cancel_requested: true, cancel_reason: text(args.reason, "reason") });
      return { run: saved, idempotent: false };
    });
    if (!result.idempotent) queueMicrotask(() => this.observeCancellation());
    return result;
  }
  recover(args: JsonObject): JsonObject {
    if (args.confirmed_original_runner_stopped !== true) throw new Error("Recovery requires confirmed_original_runner_stopped=true");
    const ownerId = text(args.owner_id, "owner_id");
    const runId = args.run_id === undefined ? null : text(args.run_id, "run_id");
    if (runId === null && args.run_version !== undefined) throw new Error("run_version requires run_id for scoped recovery");
    const actor = runId !== null || args.actor !== undefined ? text(args.actor, "actor") : null;
    const recovered = this.store.transaction(() => {
      let candidates: JsonObject[];
      if (runId !== null) {
        const run = this.store.get("host_run", runId);
        if (!Number.isSafeInteger(args.run_version) || Number(args.run_version) < 1 || run.version !== args.run_version) throw new Error("Host run version changed; refresh before recovery");
        if (run.owner_id !== ownerId) throw new Error("Host run recovery owner does not match");
        if (this.controllers.has(runId)) throw new Error("Original Runner is still active");
        candidates = [run];
      } else candidates = this.store.list("host_run", Number.MAX_SAFE_INTEGER, item => item.owner_id === ownerId);
      const saved: JsonObject[] = [];
      for (const run of candidates) if ((["running", "cancel_requested"].includes(String(run.status)) || run.cleanup_unconfirmed === true || (runId !== null && run.status === "interrupted" && !run.stopped_confirmation)) && !this.controllers.has(String(run.id))) {
        saved.push(this.store.save("host_run", String(run.id), { ...payload(run), status: "interrupted", ...(run.cleanup_unconfirmed === true ? { cleanup_unconfirmed: false } : {}), ...(actor === null ? {} : { stopped_confirmation: { actor, confirmed_at: new Date().toISOString(), source: "explicit_operator_confirmation" } }), finished_at: new Date().toISOString() }));
      }
      return saved;
    });
    for (const run of recovered) this.notifyTerminal(run, null);
    return { recovered, count: recovered.length };
  }

  async wait(runId: string): Promise<void> { const completion = this.completions.get(runId); await completion; if (completion) this.completions.delete(runId); }
}
