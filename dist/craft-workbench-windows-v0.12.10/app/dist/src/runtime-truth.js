import { createHash } from "node:crypto";
/** Stable, versionless envelope name. Revisions evolve the shape without making callers rename the event kind. */
export const TRACE_SCHEMA = "craft.trace";
export const TRACE_SCHEMA_REVISION = 1;
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    return value;
}
function digest(value) {
    return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function clean(value) {
    return Object.fromEntries(Object.entries(object(value, "value")).filter(([key]) => !/(?:api[_-]?key|authorization|cookie|password|secret|token)/iu.test(key)));
}
/** Convert a legacy trace record or event into the stable envelope used by exports. */
export function standardizeTrace(input) {
    const source = object(input, "trace");
    const legacy = typeof source.schema === "string" && source.schema === "craft.trace.v1";
    const traceId = text(source.trace_id ?? source.id, "trace_id");
    const sequence = source.sequence === undefined ? 0 : Number(source.sequence);
    if (!Number.isInteger(sequence) || sequence < 0)
        throw new Error("sequence must be a non-negative integer");
    return { schema: TRACE_SCHEMA, schema_revision: TRACE_SCHEMA_REVISION, trace_id: traceId, sequence,
        event_kind: text(source.event_kind ?? source.event_type ?? "trace.observed", "event_kind"),
        status: source.status === undefined || source.status === null ? null : text(source.status, "status"),
        trust: source.trust === undefined ? "observed" : text(source.trust, "trust"),
        actor: source.actor === undefined ? "craft" : text(source.actor, "actor"),
        parent_span_id: source.parent_span_id ?? null, span_id: source.span_id ?? `${traceId}:span:${sequence}`,
        input_refs: Array.isArray(source.input_refs) ? source.input_refs.map((item) => text(item, "input_refs")) : [],
        output_refs: Array.isArray(source.output_refs) ? source.output_refs.map((item) => text(item, "output_refs")) : [],
        data_digest: source.data_digest ?? digest(clean(source.data ?? {})), raw_content: false,
        ...(legacy ? { legacy_schema: "craft.trace.v1" } : {}) };
}
/** Keep only a bounded, content-free projection suitable for a cross-process handoff. */
export function traceCorrelation(input) {
    const trace = standardizeTrace(input);
    return { trace_id: trace.trace_id, span_id: trace.span_id, parent_span_id: trace.parent_span_id,
        schema: TRACE_SCHEMA, schema_revision: TRACE_SCHEMA_REVISION,
        baggage: { task_id: input.task_id ?? null, run_id: input.run_id ?? null, operation_id: input.operation_id ?? null } };
}
/** Map Craft events to the OpenTelemetry OTLP/HTTP JSON shape without leaking prompt content. */
export function toOtlpTrace(input, events = []) {
    const trace = standardizeTrace(input);
    const normalized = events.length ? events.map(standardizeTrace) : [trace];
    const traceHex = createHash("sha256").update(String(trace.trace_id)).digest("hex").slice(0, 32);
    const spans = normalized.map((event) => ({
        traceId: traceHex,
        spanId: createHash("sha256").update(`${trace.trace_id}:${event.sequence}`).digest("hex").slice(0, 16),
        parentSpanId: event.parent_span_id ? createHash("sha256").update(String(event.parent_span_id)).digest("hex").slice(0, 16) : undefined,
        name: String(event.event_kind),
        kind: _internalSpanKind(event.event_kind),
        attributes: [
            { key: "craft.schema", value: { stringValue: TRACE_SCHEMA } },
            { key: "craft.schema_revision", value: { intValue: TRACE_SCHEMA_REVISION } },
            { key: "craft.trust", value: { stringValue: String(event.trust) } },
            { key: "craft.raw_content", value: { boolValue: false } },
            { key: "craft.data_digest", value: { stringValue: String(event.data_digest) } },
        ],
        status: { code: event.status === "failed" ? 2 : 1 },
    }));
    return { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "craft" } }] },
                scopeSpans: [{ scope: { name: "craft", version: String(TRACE_SCHEMA_REVISION) }, spans }] }] };
}
function _internalSpanKind(kind) { return String(kind).startsWith("tool.") ? 3 : String(kind).startsWith("model.") ? 2 : 1; }
/** Export one bounded OTLP payload. The network seam is injectable for tests and adapters. */
export async function exportOtlp(endpoint, payload, fetchImpl) {
    const url = text(endpoint, "endpoint");
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error("endpoint must be a valid HTTP(S) URL");
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
        throw new Error("endpoint must be an HTTP(S) URL without credentials or fragments");
    const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) });
    if (response.status < 200 || response.status >= 300)
        throw new Error(`OTLP export failed with HTTP ${response.status}`);
    return { endpoint: url, status: response.status, accepted: true, response_digest: digest(response.body) };
}
/** Deterministically parse newline-delimited SSE data frames from a streaming provider. */
export function parseSseFrames(input) {
    if (typeof input !== "string")
        throw new Error("SSE input must be a string");
    const frames = [];
    for (const line of input.split(/\r?\n/u)) {
        if (!line.startsWith("data:"))
            continue;
        const body = line.slice(5).trim();
        if (!body || body === "[DONE]")
            continue;
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            throw new Error("SSE data must be valid JSON");
        }
        frames.push(object(parsed, "SSE frame"));
    }
    return frames;
}
/** Parse OpenAI-compatible and Anthropic tool blocks into one provider-neutral action list. */
export function parseToolCalls(payload) {
    const result = [];
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const calls = choices[0]?.message?.tool_calls;
    if (Array.isArray(calls))
        for (const raw of calls) {
            const item = object(raw, "tool_call");
            const fn = object(item.function, "tool_call.function");
            const name = text(fn.name, "tool name");
            const rawArgs = fn.arguments ?? {};
            let args = rawArgs;
            if (typeof rawArgs === "string") {
                try {
                    args = JSON.parse(rawArgs);
                }
                catch {
                    throw new Error("tool arguments must be valid JSON");
                }
            }
            result.push({ id: text(item.id ?? `tool_${result.length + 1}`, "tool call id"), name, arguments: object(args, "tool arguments") });
        }
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    for (const block of blocks.filter((item) => item.type === "tool_use"))
        result.push({ id: text(block.id, "tool_use id"), name: text(block.name, "tool name"), arguments: object(block.input ?? {}, "tool input") });
    return result;
}
export function toolResultMessage(callId, result) {
    return { role: "tool", tool_call_id: text(callId, "tool_call_id"), content: JSON.stringify(clean(result)) };
}
/** Compact old turns while preserving system instructions, the latest work, and a verifiable summary note. */
export function compactConversation(messages, maxChars = 32_000) {
    if (!Array.isArray(messages) || !messages.length)
        throw new Error("messages must contain at least one item");
    if (!Number.isInteger(maxChars) || maxChars < 256)
        throw new Error("maxChars must be an integer of at least 256");
    const total = messages.reduce((sum, item) => sum + String(item.content ?? "").length, 0);
    if (total <= maxChars)
        return { messages, compacted: false, omitted: 0, summary_digest: digest(messages) };
    const system = messages.filter((item) => item.role === "system").slice(0, 1);
    const tail = [];
    let used = system.reduce((sum, item) => sum + String(item.content ?? "").length, 0);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const item = messages[index];
        if (item.role === "system")
            continue;
        if (used + String(item.content ?? "").length > Math.floor(maxChars * 0.65))
            break;
        tail.unshift(item);
        used += String(item.content ?? "").length;
    }
    const omitted = messages.length - system.length - tail.length;
    const summary = `Compacted ${omitted} earlier turns; retain only their digest for replay: ${digest(messages.slice(0, messages.length - tail.length))}`;
    const note = { role: "system", content: summary };
    return { messages: [...system, note, ...tail], compacted: true, omitted, summary_digest: digest(summary) };
}
export function createWorkNote(args) {
    const goal = text(args.goal, "goal");
    const list = (value, name) => (value ?? []).map((item) => text(item, name));
    const note = { goal, decisions: list(args.decisions, "decisions"), constraints: list(args.constraints, "constraints"), open_questions: list(args.open_questions, "open_questions"), artifacts: list(args.artifacts, "artifacts") };
    return { ...note, digest: digest(note), raw_content: false };
}
//# sourceMappingURL=runtime-truth.js.map