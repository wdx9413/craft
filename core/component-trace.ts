import { randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { TraceKernel } from "./trace-kernel.ts";
import { currentOperation, observeOperation, operationErrorCode, operationResultStatus } from "../common/craft-common-log/src/index.ts";

export type ComponentTraceResult = {
  ok: boolean;
  result?: JsonObject;
  error?: unknown;
  correlation: JsonObject | null;
  telemetry_error?: string;
};

/** Content-free capture shared by protocol, Hook and embedded service entrances. */
export class ComponentTraceKernel {
  readonly trace: TraceKernel;
  readonly sessionId: string;
  constructor(trace: TraceKernel, sessionId: string) { this.trace = trace; this.sessionId = sessionId; }

  async capture(args: { requestId: string; component: string; operation: string; input: JsonObject; handler: () => JsonObject | Promise<JsonObject> }): Promise<ComponentTraceResult> {
    let correlation: JsonObject | null = null, telemetryError: unknown;
    const metadata = () => ({ correlation, ...(telemetryError ? { telemetry_error: telemetryError instanceof Error ? telemetryError.name : "TelemetryError" } : {}) });
    try {
      const result = await this.run({ ...args, correlated: value => { correlation = value; }, telemetryFailed: error => { telemetryError = error; } });
      return { ok: true, result, ...metadata() };
    } catch (error) { return { ok: false, error, ...metadata() }; }
  }

  run<T>(args: { requestId: string; component: string; operation: string; input: JsonObject; handler: () => T;
    correlated?: (value: JsonObject) => void; telemetryFailed?: (error: unknown) => void }): T {
    const input = args.input, parent = currentOperation(this.trace.store);
    const supplied = input.trace_id ?? input.correlation_trace_id;
    const explicit = typeof supplied === "string" && supplied.trim() ? supplied.trim() : null;
    let traceId = explicit ?? parent?.traceId ?? `component:${this.sessionId}:${randomUUID()}`;
    const telemetryFailed = args.telemetryFailed ?? parent?.onError;
    const observe = (write: () => void): void => { try { write(); } catch (error) { telemetryFailed?.(error); } };
    if (!parent) observe(() => { this.trace.maintain(); });
    let existing: JsonObject | null = null, archived = false;
    observe(() => { existing = this.trace.store.find("trace", traceId); archived = this.trace.store.find("trace_archive", traceId) !== null; });
    const prior = existing as JsonObject | null;
    const terminal = archived || prior && ["completed", "failed", "cancelled", "blocked"].includes(String(prior.status));
    const linked = terminal ? traceId : null;
    if (terminal) { traceId = `component:${this.sessionId}:${randomUUID()}`; existing = null; }
    const automatic = terminal || explicit === null && !parent;
    const taskId = prior?.task_id ?? (typeof input.task_id === "string" ? input.task_id : `component:${this.sessionId}`);
    const correlation: JsonObject = { trace_id: traceId, task_id: taskId, session_id: this.sessionId, request_id: args.requestId,
      component: args.component, operation: args.operation, auto_finalized: Boolean(automatic), linked_trace_id: linked };
    observe(() => {
      if (existing && !Number.isInteger(Number(existing.next_sequence))) {
        const count = this.trace.store.list("trace_event", 10_000, event => event.trace_id === traceId).length;
        this.trace.store.save("trace", traceId, { ...existing, next_sequence: count, event_count: count });
      }
      if (!existing) this.trace.start({ trace_id: traceId, task_id: taskId, telemetry_only: true });
    });
    args.correlated?.(correlation);
    const completed = (result: unknown): void => {
      if (automatic) observe(() => this.trace.finalize({ trace_id: traceId, status: "completed", verdict: operationResultStatus(result), summary: "Component handler returned" }));
    };
    const failed = (error: unknown): void => {
      if (automatic) observe(() => this.trace.finalize({ trace_id: traceId, status: "failed", verdict: operationErrorCode(error), summary: "Component handler failed" }));
    };
    try {
      const result = observeOperation(this.trace.store, args.component, args.operation, input, args.handler, {
        traceId, onError: telemetryFailed,
        observe: ({ event, phase, refs }) => {
          if (event.operation === args.operation && event.capability_id === args.component && phase === "started") correlation.span_id ??= event.span_id;
          this.trace.append({ trace_id: traceId, event_id: event.event_id, event_kind: `component.call.${phase}`, actor: "host",
            source: event.capability_id, trust: "observed", span_id: event.span_id, parent_span_id: event.parent_span_id,
            operation_id: event.operation, duration_ms: event.attributes.duration_ms, status: event.attributes.status,
            error_class: phase === "failed" ? event.attributes.reason_code : undefined,
            input_refs: phase === "started" ? refs : [], output_refs: phase === "completed" ? refs : [], data: event.attributes, summary: `${event.capability_id}.${event.operation} ${phase}` });
        },
      });
      if (result instanceof Promise) return result.then(value => { completed(value); return value; }, error => { failed(error); throw error; }) as T;
      completed(result); return result;
    } catch (error) { failed(error); throw error; }
  }
}
