import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./store.ts";
import { CraftStore } from "./store.ts";
import { compactConversation, createWorkNote, exportOtlp, standardizeTrace, toOtlpTrace, type ConversationMessage } from "./runtime-truth.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function object(value: unknown, name: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject; }

/** Persistence facade for the versionless Runtime Truth protocol. */
export class RuntimeTruthKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  standardize(args: JsonObject): JsonObject {
    const trace = standardizeTrace(object(args.trace ?? args, "trace"));
    const id = text(args.export_id ?? `trace_export_${randomUUID().replaceAll("-", "")}`, "export_id");
    const existing = this.store.find("trace_export", id);
    if (existing) return { export: existing, idempotent: true };
    return { export: this.store.create("trace_export", id, { format: "craft.trace", schema: "craft.trace", schema_revision: trace.schema_revision, trace_id: trace.trace_id, trace }), idempotent: false };
  }

  otlp(args: JsonObject): JsonObject {
    const trace = standardizeTrace(object(args.trace ?? args, "trace"));
    const events = args.events === undefined ? [] : Array.isArray(args.events) ? args.events as JsonObject[] : (() => { throw new Error("events must be an array"); })();
    return { format: "otlp/json", schema: "craft.trace", payload: toOtlpTrace(trace, events) };
  }

  async export(args: JsonObject): Promise<JsonObject> {
    const endpoint = text(args.endpoint, "endpoint");
    const mapped = this.otlp(args);
    const injected = (args as { fetch_impl?: unknown }).fetch_impl;
    const transport = typeof injected === "function" ? injected as Parameters<typeof exportOtlp>[2] : async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => { const response = await fetch(url, init); return { status: response.status, body: await response.text() }; };
    const result = await exportOtlp(endpoint, mapped.payload as JsonObject, transport);
    const id = text(args.export_id ?? `trace_otlp_${randomUUID().replaceAll("-", "")}`, "export_id");
    const existing = this.store.find("trace_otlp_export", id);
    if (existing) return { export: existing, idempotent: true };
    const payloadDigest = `sha256:${createHash("sha256").update(JSON.stringify(mapped.payload)).digest("hex")}`;
    return { export: this.store.create("trace_otlp_export", id, { endpoint, status: result.status, accepted: result.accepted, payload_digest: payloadDigest, raw_content: false }), idempotent: false };
  }

  compact(args: JsonObject): JsonObject {
    const messages = args.messages;
    if (!Array.isArray(messages)) throw new Error("messages must be an array");
    const result = compactConversation(messages as ConversationMessage[], [undefined, Number(args.max_chars)][Number(args.max_chars !== undefined)]);
    const id = text(args.session_id ?? `context_${randomUUID().replaceAll("-", "")}`, "session_id");
    const saved = this.store.save("context_compaction", id, { session_id: id, compacted: result.compacted, omitted: result.omitted, summary_digest: result.summary_digest, messages: result.messages });
    return { ...result, compaction: saved };
  }

  workNote(args: JsonObject): JsonObject {
    const note = createWorkNote({ goal: text(args.goal, "goal"), decisions: args.decisions as string[] | undefined, constraints: args.constraints as string[] | undefined, open_questions: args.open_questions as string[] | undefined, artifacts: args.artifacts as string[] | undefined });
    const id = text(args.note_id ?? `work_note_${randomUUID().replaceAll("-", "")}`, "note_id");
    const existing = this.store.find("work_note", id);
    if (existing) return { note: existing, idempotent: true };
    return { note: this.store.create("work_note", id, note), idempotent: false };
  }
}
