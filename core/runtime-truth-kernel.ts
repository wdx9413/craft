import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftStore } from "./infrastructure/store.ts";
import { compactConversation, createWorkNote, exportOtlp, standardizeTrace, toOtlpTrace, type ConversationMessage } from "./runtime-truth.ts";
import { object, text } from "./validation.ts";

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

  /**
   * Read back the compaction that was written for one session.
   *
   * `compact` was persist-only until this existed, which made the stored history unusable: the
   * one thing a resuming Host needs is the compacted window it produced earlier, and there was
   * no way to ask for it. Every other kernel in Craft has a `get` for what it saves; this pair
   * was the exception, and the exception was the bug.
   *
   * The record id *is* the session id, so no separate index is needed: `compact` saves under
   * `args.session_id`, so a session can be resumed knowing only its own name.
   */
  compactionGet(args: JsonObject): JsonObject {
    const sessionId = text(args.session_id, "session_id");
    return { compaction: this.store.get("context_compaction", sessionId, args.version === undefined ? undefined : Number(args.version)) };
  }

  /** List stored compactions, newest first, so a Host can find a session it did not name. */
  compactionList(args: JsonObject = {}): JsonObject {
    const limit = args.limit === undefined ? 50 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be an integer between 1 and 1000");
    const items = this.store.list("context_compaction", limit);
    return { compactions: items.map((item) => ({ id: item.id, version: item.version, session_id: item.session_id, compacted: item.compacted, omitted: item.omitted, summary_digest: item.summary_digest, updated_at: item.updated_at })), count: items.length };
  }

  workNote(args: JsonObject): JsonObject {
    const note = createWorkNote({ goal: text(args.goal, "goal"), decisions: args.decisions as string[] | undefined, constraints: args.constraints as string[] | undefined, open_questions: args.open_questions as string[] | undefined, artifacts: args.artifacts as string[] | undefined });
    const id = text(args.note_id ?? `work_note_${randomUUID().replaceAll("-", "")}`, "note_id");
    const existing = this.store.find("work_note", id);
    if (existing) return { note: existing, idempotent: true };
    return { note: this.store.create("work_note", id, note), idempotent: false };
  }

  /**
   * Read back one work note.
   *
   * A work note exists to be the thing a long-running session reads on resume — that is what its
   * own description says — so a note that could only be written was not doing its job. Same
   * defect as `compactionGet`, fixed in the same place so the pair stays symmetric.
   */
  workNoteGet(args: JsonObject): JsonObject {
    const noteId = text(args.note_id, "note_id");
    return { note: this.store.get("work_note", noteId, args.version === undefined ? undefined : Number(args.version)) };
  }
}
