import { createHash } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { TraceKernel } from "./trace-kernel.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export type ComponentTraceResult = {
  ok: boolean;
  result?: JsonObject;
  error?: unknown;
  correlation: JsonObject | null;
};

/**
 * Adds one content-free Trace envelope around a host/component operation.
 * Explicit trace ids join an existing parent run; omitted ids get a short-lived
 * terminal trace so standalone plugin calls remain observable by default.
 */
export class ComponentTraceKernel {
  readonly trace: TraceKernel;
  readonly sessionId: string;

  constructor(trace: TraceKernel, sessionId: string) {
    this.trace = trace;
    this.sessionId = sessionId;
  }

  async capture(args: {
    requestId: string;
    component: string;
    operation: string;
    input: JsonObject;
    handler: () => JsonObject | Promise<JsonObject>;
  }): Promise<ComponentTraceResult> {
    const input = args.input;
    const explicitTraceId = typeof input.trace_id === "string" && input.trace_id.trim()
      ? input.trace_id.trim()
      : typeof input.correlation_trace_id === "string" && input.correlation_trace_id.trim()
        ? input.correlation_trace_id.trim() : null;
    const traceId = explicitTraceId ?? `component:${this.sessionId}:${args.requestId}`;
    const existing = this.trace.store.find("trace", traceId);
    const taskId = existing?.task_id ?? text(input.task_id, `mcp:${this.sessionId}`);
    const correlation = { trace_id: traceId, task_id: taskId, session_id: this.sessionId,
      request_id: args.requestId, component: args.component, operation: args.operation,
      auto_finalized: explicitTraceId === null };
    const terminal = existing && ["completed", "failed", "cancelled", "blocked"].includes(String(existing.status));
    if (existing && !terminal && !Number.isInteger(Number(existing.next_sequence))) {
      const eventCount = this.trace.store.list("trace_event", 10_000, (event) => event.trace_id === traceId).length;
      this.trace.store.save("trace", traceId, { ...existing, next_sequence: eventCount, event_count: eventCount });
    }
    if (!existing) this.trace.start({ trace_id: traceId, task_id: taskId,
      metadata: { component: args.component, operation: args.operation, session_id: this.sessionId, request_id: args.requestId } });
    if (!terminal) {
      this.trace.append({ trace_id: traceId, event_id: `${traceId}:call.started`, event_kind: "component.call.started",
        actor: "host", source: args.component, trust: "observed", data: { input_digest: digest(input), request_id: args.requestId },
        summary: `${args.component}.${args.operation} started` });
    }
    try {
      const result = await args.handler();
      if (!terminal) {
        this.trace.append({ trace_id: traceId, event_id: `${traceId}:call.completed`, event_kind: "component.call.completed",
          actor: "host", source: args.component, trust: "observed", status: "completed",
          data: { result_digest: digest(result ?? {}) }, summary: `${args.component}.${args.operation} completed` });
        if (explicitTraceId === null) this.trace.finalize({ trace_id: traceId, status: "completed", summary: "Component call completed" });
      }
      return { ok: true, result, correlation };
    } catch (error) {
      if (!terminal) {
        const errorName = error instanceof Error ? error.name : "NonErrorThrow";
        this.trace.append({ trace_id: traceId, event_id: `${traceId}:call.failed`, event_kind: "component.call.failed",
          actor: "host", source: args.component, trust: "observed", status: "failed",
          error_class: errorName, data: { error_class: errorName }, summary: `${args.component}.${args.operation} failed` });
        if (explicitTraceId === null) this.trace.finalize({ trace_id: traceId, status: "failed", summary: "Component call failed" });
      }
      return { ok: false, error, correlation };
    }
  }
}
