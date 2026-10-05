import { createHash } from "node:crypto";

type RecordValue = Record<string, unknown>;
export const TRACE_SCHEMA = "craft.trace";
export const TRACE_SCHEMA_REVISION = 1;

function object(value: unknown, name: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as RecordValue;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function clean(value: unknown): RecordValue {
  return Object.fromEntries(Object.entries(object(value, "value")).filter(([key]) => !/(?:api[_-]?key|authorization|cookie|password|secret|token)/iu.test(key)));
}

export function standardizeTrace(input: RecordValue): RecordValue {
  const source = object(input, "trace");
  const legacy = source.schema === "craft.trace.v1";
  const traceId = text(source.trace_id ?? source.id, "trace_id");
  const sequence = source.sequence === undefined ? 0 : Number(source.sequence);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("sequence must be a non-negative integer");
  return { schema: TRACE_SCHEMA, schema_revision: TRACE_SCHEMA_REVISION, trace_id: traceId, sequence,
    event_kind: text(source.event_kind ?? source.event_type ?? "trace.observed", "event_kind"),
    status: source.status === undefined || source.status === null ? null : text(source.status, "status"),
    trust: source.trust === undefined ? "observed" : text(source.trust, "trust"),
    actor: source.actor === undefined ? "craft" : text(source.actor, "actor"),
    parent_span_id: source.parent_span_id ?? null, span_id: source.span_id ?? `${traceId}:span:${sequence}`,
    input_refs: Array.isArray(source.input_refs) ? source.input_refs.map(item => text(item, "input_refs")) : [],
    output_refs: Array.isArray(source.output_refs) ? source.output_refs.map(item => text(item, "output_refs")) : [],
    data_digest: source.data_digest ?? digest(clean(source.data ?? {})), raw_content: false,
    occurred_at: source.occurred_at ?? source.created_at ?? source.updated_at ?? null,
    duration_ms: source.duration_ms ?? null,
    ...(legacy ? { legacy_schema: "craft.trace.v1" } : {}) };
}

export function traceCorrelation(input: RecordValue): RecordValue {
  const trace = standardizeTrace(input);
  return { trace_id: trace.trace_id, span_id: trace.span_id, parent_span_id: trace.parent_span_id,
    schema: TRACE_SCHEMA, schema_revision: TRACE_SCHEMA_REVISION,
    baggage: { task_id: input.task_id ?? null, run_id: input.run_id ?? null, operation_id: input.operation_id ?? null } };
}

function spanHex(traceId: string, spanId: string): string {
  return createHash("sha256").update(`${traceId}:${spanId}`).digest("hex").slice(0, 16);
}
function nanos(value: unknown, fallback: number): bigint {
  const millis = typeof value === "string" ? Date.parse(value) : fallback;
  if (!Number.isFinite(millis) || millis < 0) throw new Error("trace timestamp must be valid");
  return BigInt(Math.trunc(millis)) * 1_000_000n;
}

/** OTLP/HTTP JSON with stable parent-child IDs and valid epoch-nanosecond times. */
export function toOtlpTrace(input: RecordValue, events: RecordValue[] = []): RecordValue {
  const trace = standardizeTrace(input);
  const normalized = events.length ? events.map(standardizeTrace) : [trace];
  const traceId = String(trace.trace_id);
  if (normalized.some(event => event.trace_id !== traceId)) throw new Error("OTLP events must belong to one trace");
  const traceHex = /^[0-9a-f]{32}$/iu.test(traceId) ? traceId.toLowerCase() : createHash("sha256").update(traceId).digest("hex").slice(0, 32);
  const known = new Map(normalized.map(event => [String(event.span_id), spanHex(traceId, String(event.span_id))]));
  const fallbackMillis = Date.now();
  const spans = normalized.map(event => {
    const start = nanos(event.occurred_at ?? trace.occurred_at, fallbackMillis);
    const duration = event.duration_ms === null ? 0 : Number(event.duration_ms);
    if (!Number.isFinite(duration) || duration < 0) throw new Error("trace duration_ms must be non-negative");
    const parent = event.parent_span_id === null ? undefined : String(event.parent_span_id);
    return { traceId: traceHex, spanId: known.get(String(event.span_id))!,
      ...(parent ? { parentSpanId: known.get(parent) ?? (/^[0-9a-f]{16}$/iu.test(parent) ? parent.toLowerCase() : spanHex(traceId, parent)) } : {}),
      name: String(event.event_kind), kind: String(event.event_kind).startsWith("tool.") ? 3 : String(event.event_kind).startsWith("model.") ? 2 : 1,
      startTimeUnixNano: String(start), endTimeUnixNano: String(start + BigInt(Math.trunc(duration * 1_000_000))),
      attributes: [
        { key: "craft.schema", value: { stringValue: TRACE_SCHEMA } },
        { key: "craft.schema_revision", value: { intValue: TRACE_SCHEMA_REVISION } },
        { key: "craft.trust", value: { stringValue: String(event.trust) } },
        { key: "craft.raw_content", value: { boolValue: false } },
        { key: "craft.data_digest", value: { stringValue: String(event.data_digest) } },
      ], status: { code: event.status === "failed" ? 2 : event.status === "completed" ? 1 : 0 } };
  });
  return { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "craft" } }] },
    scopeSpans: [{ scope: { name: "craft", version: String(TRACE_SCHEMA_REVISION) }, spans }] }] };
}

export interface OtlpFetchResponse { status: number; body: string }
export type OtlpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<OtlpFetchResponse>;

export async function exportOtlp(endpoint: string, payload: RecordValue, fetchImpl: OtlpFetch): Promise<RecordValue> {
  const url = text(endpoint, "endpoint");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("endpoint must be a valid HTTP(S) URL"); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error("endpoint must be an HTTP(S) URL without credentials or fragments");
  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) });
  if (response.status < 200 || response.status >= 300) throw new Error(`OTLP export failed with HTTP ${response.status}`);
  let result: unknown;
  try { result = JSON.parse(response.body); } catch { result = null; }
  const partial = result && typeof result === "object" && !Array.isArray(result) ? (result as RecordValue).partialSuccess : null;
  if (partial && typeof partial === "object" && !Array.isArray(partial)) {
    const rejected = Number((partial as RecordValue).rejectedSpans ?? 0);
    if (!Number.isSafeInteger(rejected) || rejected < 0) throw new Error("OTLP partialSuccess rejectedSpans is invalid");
    if (rejected > 0) throw new Error(`OTLP partial success rejected ${rejected} span(s)`);
  }
  return { endpoint: url, status: response.status, accepted: true, response_digest: digest(response.body) };
}
