import { createHash } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { digestJson } from "./digest.ts";
import { compact } from "./compaction.ts";

/** Stable, versionless envelope name. Revisions evolve the shape without making callers rename the event kind. */
export const TRACE_SCHEMA = "craft.trace";
export const TRACE_SCHEMA_REVISION = 1;

export type ConversationRole = "system" | "user" | "assistant" | "tool";
export interface ConversationMessage {
  role: ConversationRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

function clean(value: unknown): JsonObject {
  return Object.fromEntries(Object.entries(object(value, "value")).filter(([key]) => !/(?:api[_-]?key|authorization|cookie|password|secret|token)/iu.test(key)));
}

/** Convert a legacy trace record or event into the stable envelope used by exports. */
export function standardizeTrace(input: JsonObject): JsonObject {
  const source = object(input, "trace");
  const legacy = typeof source.schema === "string" && source.schema === "craft.trace.v1";
  const traceId = text(source.trace_id ?? source.id, "trace_id");
  const sequence = source.sequence === undefined ? 0 : Number(source.sequence);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("sequence must be a non-negative integer");
  return { schema: TRACE_SCHEMA, schema_revision: TRACE_SCHEMA_REVISION, trace_id: traceId, sequence,
    event_kind: text(source.event_kind ?? source.event_type ?? "trace.observed", "event_kind"),
    status: source.status === undefined || source.status === null ? null : text(source.status, "status"),
    trust: source.trust === undefined ? "observed" : text(source.trust, "trust"),
    actor: source.actor === undefined ? "craft" : text(source.actor, "actor"),
    parent_span_id: source.parent_span_id ?? null, span_id: source.span_id ?? `${traceId}:span:${sequence}`,
    input_refs: Array.isArray(source.input_refs) ? source.input_refs.map((item) => text(item, "input_refs")) : [],
    output_refs: Array.isArray(source.output_refs) ? source.output_refs.map((item) => text(item, "output_refs")) : [],
    data_digest: source.data_digest ?? digestJson(clean(source.data ?? {})), raw_content: false,
    ...(legacy ? { legacy_schema: "craft.trace.v1" } : {}) };
}

/** Keep only a bounded, content-free projection suitable for a cross-process handoff. */
export function traceCorrelation(input: JsonObject): JsonObject {
  const trace = standardizeTrace(input);
  return { trace_id: trace.trace_id, span_id: trace.span_id, parent_span_id: trace.parent_span_id,
    schema: TRACE_SCHEMA, schema_revision: TRACE_SCHEMA_REVISION,
    baggage: { task_id: input.task_id ?? null, run_id: input.run_id ?? null, operation_id: input.operation_id ?? null } };
}

/** Map Craft events to the OpenTelemetry OTLP/HTTP JSON shape without leaking prompt content. */
export function toOtlpTrace(input: JsonObject, events: JsonObject[] = []): JsonObject {
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

function _internalSpanKind(kind: unknown): number { return String(kind).startsWith("tool.") ? 3 : String(kind).startsWith("model.") ? 2 : 1; }

export interface OtlpFetchResponse { status: number; body: string }
export type OtlpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<OtlpFetchResponse>;

/** Export one bounded OTLP payload. The network seam is injectable for tests and adapters. */
export async function exportOtlp(endpoint: string, payload: JsonObject, fetchImpl: OtlpFetch): Promise<JsonObject> {
  const url = text(endpoint, "endpoint");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("endpoint must be a valid HTTP(S) URL"); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error("endpoint must be an HTTP(S) URL without credentials or fragments");
  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) });
  if (response.status < 200 || response.status >= 300) throw new Error(`OTLP export failed with HTTP ${response.status}`);
  return { endpoint: url, status: response.status, accepted: true, response_digest: digestJson(response.body) };
}

/** Deterministically parse newline-delimited SSE data frames from a streaming provider. */
export function parseSseFrames(input: string): JsonObject[] {
  if (typeof input !== "string") throw new Error("SSE input must be a string");
  const frames: JsonObject[] = [];
  for (const line of input.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (!body || body === "[DONE]") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new Error("SSE data must be valid JSON"); }
    frames.push(object(parsed, "SSE frame"));
  }
  return frames;
}

/** Parse OpenAI-compatible and Anthropic tool blocks into one provider-neutral action list. */
export function parseToolCalls(payload: JsonObject): ParsedToolCall[] {
  const result: ParsedToolCall[] = [];
  const choices = Array.isArray(payload.choices) ? payload.choices as JsonObject[] : [];
  const calls = (choices[0]?.message as JsonObject | undefined)?.tool_calls;
  if (Array.isArray(calls)) for (const raw of calls) {
    const item = object(raw, "tool_call"); const fn = object(item.function, "tool_call.function");
    const name = text(fn.name, "tool name"); const rawArgs = fn.arguments ?? {};
    let args: unknown = rawArgs;
    if (typeof rawArgs === "string") { try { args = JSON.parse(rawArgs); } catch { throw new Error("tool arguments must be valid JSON"); } }
    result.push({ id: text(item.id ?? `tool_${result.length + 1}`, "tool call id"), name, arguments: object(args, "tool arguments") });
  }
  const blocks = Array.isArray(payload.content) ? payload.content as JsonObject[] : [];
  for (const block of blocks.filter((item) => item.type === "tool_use")) result.push({ id: text(block.id, "tool_use id"), name: text(block.name, "tool name"), arguments: object(block.input ?? {}, "tool input") });
  return result;
}

/**
 * The ceiling on one tool result in the transcript.
 *
 * A tool result is the one input a tool author does not control: a listing over a
 * large workspace or a deep trace can be arbitrarily large, and an unbounded
 * result evicts the rest of the conversation at the next compaction -- which is
 * how a single call silently destroys what the run had learned. The ceiling is
 * counted in characters so it holds without a tokenizer; the loop's own token
 * budget is a separate decision, this only stops one result from dominating it.
 */
export const MAX_TOOL_RESULT_CHARS = 8_000;

export function truncateToolResult(result: JsonObject, maxChars = MAX_TOOL_RESULT_CHARS): JsonObject {
  const encoded = JSON.stringify(result);
  if (encoded.length <= maxChars) return result;
  // The head is kept rather than the tail: ids, names and summaries lead. What
  // was dropped is stated rather than hidden, so a model can ask for a narrower
  // view instead of guessing at content it can no longer see.
  return { truncated: true, original_chars: encoded.length, kept_chars: maxChars, head: encoded.slice(0, maxChars) };
}

export function toolResultMessage(callId: string, result: JsonObject): ConversationMessage {
  // Redaction runs before truncation: the head a result keeps must already be
  // free of anything a tool was never allowed to echo.
  return { role: "tool", tool_call_id: text(callId, "tool_call_id"), content: JSON.stringify(clean(truncateToolResult(result))) };
}

/** Compact old turns while preserving system instructions, the latest work, and a verifiable summary note. */
export interface CompactConversationOptions {
  /**
   * The budget the compacted result must fit. When omitted the legacy 32,000
   * *character* ceiling is used; a caller that knows its real token budget should
   * pass it so compaction is governed by the same estimate the rest of the budget
   * layer uses, not by an unrelated character count.
   */
  budget?: { estimate: (value: string) => number; maxTokens: number };
  /**
   * Stages after rule-based elision: an optional summariser turns the dropped
   * middle turns into a readable note instead of a bare digest. The loop passes a
   * deterministic fallback when no model is attached, so the decision "compact"
   * is always reproducible; only the *quality* of the note changes with a model.
   */
  summarize?: (messages: ConversationMessage[]) => string;
}

export function compactConversation(
  messages: ConversationMessage[],
  maxCharsOrOptions: number | CompactConversationOptions = 32_000,
): { messages: ConversationMessage[]; compacted: boolean; omitted: number; summary_digest: string } {
  const options: CompactConversationOptions = typeof maxCharsOrOptions === "number"
    ? { budget: { estimate: (value) => value.length, maxTokens: Math.floor(maxCharsOrOptions) } }
    : maxCharsOrOptions;
  const estimate = options.budget?.estimate ?? ((value: string) => value.length);
  const budget = options.budget?.maxTokens ?? 32_000;
  if (!Array.isArray(messages) || !messages.length) throw new Error("messages must contain at least one item");
  if (!Number.isInteger(budget) || budget < 256) throw new Error("the compaction budget must be at least 256 tokens");
  const total = messages.reduce((sum, item) => sum + estimate(String(item.content ?? "")), 0);
  if (total <= budget) return { messages, compacted: false, omitted: 0, summary_digest: digestJson(messages) };

  // The selection is `compact()`'s, with the transcript's two inputs: the first system message is
  // protected rather than ranked (a conversation's constraints must not compete with its task
  // state), and 65% of the budget is reserved for a contiguous recent suffix. This used to be a
  // third independent implementation of the same budget arithmetic.
  const systemIndex = messages.findIndex((item) => item.role === "system");
  const first = messages[0];
  const spansProtectedSystem = systemIndex === 0;
  const segments = messages.map((item, index) => ({
    id: String(index),
    role: item.role,
    content: String(item.content ?? ""),
  }));
  const outcome = compact({
    segments,
    max_tokens: budget,
    estimate,
    // Only a *leading* system message can be protected by id here, because the protected text is
    // re-emitted first and a system message in the middle would silently move to the front. The
    // original loop had the same constraint implicitly, by counting `system` against the tail
    // budget; naming it makes the assumption checkable.
    protect: spansProtectedSystem ? ["0"] : [],
    tail_share: 0.65,
    ...(options.summarize ? { summarize: (elided) => options.summarize!(elided.map((segment) => messages[Number(segment.id)]!)) } : {}),
  });

  const kept = new Set(outcome.kept);
  const system = systemIndex >= 0 && kept.has(String(systemIndex)) ? [messages[systemIndex]!] : [];
  // The tail is the kept suffix, and it must be a suffix for `omitted` to describe one span: the
  // policy's contiguous-reservation stage guarantees it, and a hole would mean a segment was
  // protected in the middle, which `spansProtectedSystem` has already excluded.
  const tail = messages.filter((_, index) => index !== systemIndex && kept.has(String(index)));
  const omitted = outcome.elided.length;
  const middle = messages.filter((_, index) => outcome.elided.includes(String(index)));
  // Rule-based elision ran first; the summariser is the second stage. A caller that provides one
  // (typically a small model) gets a readable note; one that does not gets the deterministic digest
  // form from the policy. Both are honest about what was removed.
  const summary = options.summarize
    ? options.summarize(middle)
    : `Compacted ${omitted} earlier turns; retain only their digest for replay: ${digestJson(middle)}`;
  const note: ConversationMessage = { role: "system", content: summary };
  return { messages: [...system, note, ...tail], compacted: true, omitted, summary_digest: digestJson(summary) };
}

/**
 * A deterministic condensation of the turns a compaction dropped.
 *
 * A bare digest tells a model nothing it can act on, and spending a second model
 * call to summarise would double the price of every compaction. So the note is
 * built from facts already present in the transcript -- what the turns asked for,
 * which actions ran -- and carries the digest alongside, so the elided text stays
 * exactly referenceable even though it is out of the window.
 */
export function summarizeConversation(messages: ConversationMessage[]): string {
  const firstLine = (value: string): string => value.split(/[\r\n]/u)[0]!.trim().slice(0, 160);
  const asked = messages
    .filter((message) => message.role === "user" && typeof message.content === "string" && message.content.trim())
    .slice(0, 2)
    .map((message) => firstLine(String(message.content)));
  const actions = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls as Array<{ function?: { name?: unknown } }>) {
      const name = call?.function?.name;
      if (typeof name === "string" && name) actions.add(name);
    }
  }
  const parts: string[] = [];
  if (asked.length) parts.push(`asked: ${asked.join(" | ")}`);
  if (actions.size) parts.push(`actions: ${[...actions].sort().join(", ")}`);
  parts.push(`digest ${digestJson(messages)}`);
  return `Compacted ${messages.length} earlier turn(s); ${parts.join("; ")}`;
}

export function createWorkNote(args: { goal: string; decisions?: string[]; constraints?: string[]; open_questions?: string[]; artifacts?: string[] }): JsonObject {
  const goal = text(args.goal, "goal");
  const list = (value: string[] | undefined, name: string) => (value ?? []).map((item) => text(item, name));
  const note = { goal, decisions: list(args.decisions, "decisions"), constraints: list(args.constraints, "constraints"), open_questions: list(args.open_questions, "open_questions"), artifacts: list(args.artifacts, "artifacts") };
  return { ...note, digest: digestJson(note), raw_content: false };
}
