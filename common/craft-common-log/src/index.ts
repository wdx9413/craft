import { createHash, randomUUID } from "node:crypto";

export type TelemetrySignal = "log" | "trace" | "metric" | "usage" | "evaluation";
export type TelemetryOutcome = "observed" | "succeeded" | "failed" | "unverified" | "verified";
export type TelemetryAttributes = Record<string, string | number | boolean | null>;
export interface TelemetryEvent {
  schema: "craft.telemetry.v1";
  event_id: string;
  signal: TelemetrySignal;
  capability_id: string;
  operation: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  occurred_at: string;
  outcome: TelemetryOutcome;
  attributes: TelemetryAttributes;
  evidence_ids: string[];
}
export interface TelemetrySink { append(event: TelemetryEvent): void | Promise<void> }
export interface TelemetryReceipt { recorded: boolean; event: TelemetryEvent; error?: Error }

const SAFE_KEY = /^(?:reason_code|(?:[a-z][a-z0-9_]*_)?(?:id|digest|count|bytes|duration_ms|status|stage|provider|model|unit|cost_usd|input_tokens|output_tokens|name))$/u;
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]/iu;

function required(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error(`${field} must be a non-empty string of at most 256 characters`);
  return value.trim();
}

function safeAttributes(input: TelemetryAttributes): TelemetryAttributes {
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error("telemetry attributes exceed the 32-field limit");
  const output: TelemetryAttributes = {};
  for (const [key, value] of entries) {
    if (!SAFE_KEY.test(key)) throw new Error(`telemetry attribute is not allowed: ${key}`);
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw new Error(`telemetry metric must be finite and non-negative: ${key}`);
    if (typeof value === "string" && (value.length > 256 || SECRET.test(value))) throw new Error(`telemetry attribute contains unsafe content: ${key}`);
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error(`telemetry attribute must be scalar: ${key}`);
    output[key] = value;
  }
  return output;
}

export function telemetryEvent(input: Omit<TelemetryEvent, "schema" | "event_id" | "occurred_at" | "attributes" | "evidence_ids"> & {
  event_id?: string; occurred_at?: string; attributes?: TelemetryAttributes; evidence_ids?: string[];
}): TelemetryEvent {
  if (!["log", "trace", "metric", "usage", "evaluation"].includes(input.signal)) throw new Error("telemetry signal is unsupported");
  if (!["observed", "succeeded", "failed", "unverified", "verified"].includes(input.outcome)) throw new Error("telemetry outcome is unsupported");
  if (input.attributes !== undefined && (!input.attributes || typeof input.attributes !== "object" || Array.isArray(input.attributes))) throw new Error("telemetry attributes must be an object");
  const evidence = input.evidence_ids ?? [];
  if (!Array.isArray(evidence) || evidence.length > 32) throw new Error("telemetry evidence_ids must be a bounded array");
  const evidence_ids = [...new Set(evidence.map(id => required(id, "evidence_id")))];
  if (input.signal === "evaluation" && input.outcome === "verified" && !evidence_ids.length) throw new Error("verified evaluation requires evidence_ids");
  if (input.signal === "usage") {
    const attrs = input.attributes ?? {};
    if (attrs.input_tokens === undefined && attrs.output_tokens === undefined && attrs.cost_usd === undefined) throw new Error("usage requires measured tokens or cost");
    for (const key of ["input_tokens", "output_tokens"] as const) {
      if (attrs[key] !== undefined && (!Number.isSafeInteger(attrs[key]) || Number(attrs[key]) < 0)) throw new Error(`${key} must be a non-negative integer`);
    }
  }
  if (input.signal === "metric" && !Object.values(input.attributes ?? {}).some(value => typeof value === "number")) {
    throw new Error("metric requires a numeric measurement");
  }
  const occurred_at = input.occurred_at ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(occurred_at) || !Number.isFinite(Date.parse(occurred_at))) throw new Error("occurred_at must be an ISO timestamp");
  return { schema: "craft.telemetry.v1", event_id: required(input.event_id ?? `evt_${randomUUID()}`, "event_id"),
    signal: input.signal, capability_id: required(input.capability_id, "capability_id"), operation: required(input.operation, "operation"),
    trace_id: required(input.trace_id, "trace_id"), span_id: required(input.span_id, "span_id"),
    parent_span_id: input.parent_span_id === null ? null : required(input.parent_span_id, "parent_span_id"),
    occurred_at, outcome: input.outcome, attributes: safeAttributes(input.attributes ?? {}), evidence_ids };
}

/** Telemetry failures are reported separately from business results. */
export class CraftTelemetry {
  readonly sink: TelemetrySink;
  constructor(sink: TelemetrySink) { this.sink = sink; }

  async record(input: Parameters<typeof telemetryEvent>[0]): Promise<TelemetryReceipt> {
    const event = telemetryEvent(input);
    try { await this.sink.append(event); return { recorded: true, event }; }
    catch (error) { return { recorded: false, event, error: error instanceof Error ? error : new Error(String(error)) }; }
  }

  async capture<T>(input: { capability_id: string; operation: string; trace_id: string; parent_span_id?: string | null;
    attributes?: TelemetryAttributes; }, run: () => T | Promise<T>): Promise<{ result: T; telemetry: TelemetryReceipt[] }> {
    const span_id = `span_${randomUUID()}`;
    const common = { ...input, span_id, parent_span_id: input.parent_span_id ?? null };
    const start = Date.now();
    const receipts = [await this.record({ ...common, signal: "trace", outcome: "observed", attributes: input.attributes })];
    try {
      const result = await run();
      receipts.push(await this.record({ ...common, signal: "trace", outcome: "succeeded", attributes: { duration_ms: Date.now() - start } }));
      return { result, telemetry: receipts };
    } catch (error) {
      receipts.push(await this.record({ ...common, signal: "trace", outcome: "failed", attributes: { duration_ms: Date.now() - start, reason_code: error instanceof Error ? error.name : "NonErrorThrow" } }));
      throw error;
    }
  }
}

/** Stable correlation for retries, without recording business input. */
export function operationEventId(traceId: string, requestId: string, phase: string): string {
  const raw = [required(traceId, "trace_id"), required(requestId, "request_id"), required(phase, "phase")].join(":");
  return `event_${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

export * from "./otlp.ts";
export * from "./store-sink.ts";
export * from "./evaluation-contract.ts";
export * from "./cost-ledger.ts";
