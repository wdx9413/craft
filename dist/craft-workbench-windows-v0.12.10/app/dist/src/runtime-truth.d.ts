import type { JsonObject } from "./store.ts";
/** Stable, versionless envelope name. Revisions evolve the shape without making callers rename the event kind. */
export declare const TRACE_SCHEMA = "craft.trace";
export declare const TRACE_SCHEMA_REVISION = 1;
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
/** Convert a legacy trace record or event into the stable envelope used by exports. */
export declare function standardizeTrace(input: JsonObject): JsonObject;
/** Keep only a bounded, content-free projection suitable for a cross-process handoff. */
export declare function traceCorrelation(input: JsonObject): JsonObject;
/** Map Craft events to the OpenTelemetry OTLP/HTTP JSON shape without leaking prompt content. */
export declare function toOtlpTrace(input: JsonObject, events?: JsonObject[]): JsonObject;
export interface OtlpFetchResponse {
    status: number;
    body: string;
}
export type OtlpFetch = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
}) => Promise<OtlpFetchResponse>;
/** Export one bounded OTLP payload. The network seam is injectable for tests and adapters. */
export declare function exportOtlp(endpoint: string, payload: JsonObject, fetchImpl: OtlpFetch): Promise<JsonObject>;
/** Deterministically parse newline-delimited SSE data frames from a streaming provider. */
export declare function parseSseFrames(input: string): JsonObject[];
/** Parse OpenAI-compatible and Anthropic tool blocks into one provider-neutral action list. */
export declare function parseToolCalls(payload: JsonObject): ParsedToolCall[];
export declare function toolResultMessage(callId: string, result: JsonObject): ConversationMessage;
/** Compact old turns while preserving system instructions, the latest work, and a verifiable summary note. */
export declare function compactConversation(messages: ConversationMessage[], maxChars?: number): {
    messages: ConversationMessage[];
    compacted: boolean;
    omitted: number;
    summary_digest: string;
};
export declare function createWorkNote(args: {
    goal: string;
    decisions?: string[];
    constraints?: string[];
    open_questions?: string[];
    artifacts?: string[];
}): JsonObject;
