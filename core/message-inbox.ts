/**
 * 消息插件骨架（纯工程监听 + 0 Token 展示）.
 *
 * Inbox messages (email / IM / webhook pushes) are stored as plain records and
 * rendered by the UI with zero model inference — the listing, sender, subject and
 * a precomputed priority are all engineering output. Only an explicit "智能处理"
 * action triggers an AI Worker, and that path is recorded as an `intent` event
 * without this module ever calling a model itself (honest boundary: the inbox
 * stores and lists; the brain stays with the Pilot/Worker layer).
 */
import { randomUUID } from "node:crypto";
import { type CraftStore, type JsonObject } from "./infrastructure/store.ts";

export type MessageSource = "email" | "im" | "webhook" | "other";
export type MessagePriority = "low" | "normal" | "high";

export interface InboxMessage {
  id: string;
  source: MessageSource;
  from: string;
  subject: string;
  summary: string;
  priority: MessagePriority;
  receivedAt: string;
  readAt: string | null;
  processedAt: string | null;
}

function normalizeSource(value: unknown): MessageSource {
  if (value === "email" || value === "im" || value === "webhook") return value;
  if (value === undefined || value === null || value === "other") return "other";
  throw new Error("source must be email, im, webhook or other");
}

function normalizePriority(value: unknown): MessagePriority {
  if (value === "high" || value === "low") return value;
  if (value === undefined || value === null || value === "normal") return "normal";
  throw new Error("priority must be low, normal or high");
}

function toRecord(payload: JsonObject): InboxMessage {
  return {
    id: String(payload.id),
    source: (payload.source === "email" || payload.source === "im" || payload.source === "webhook" ? payload.source : "other") as MessageSource,
    from: String(payload.from ?? ""),
    subject: String(payload.subject ?? ""),
    summary: String(payload.summary ?? ""),
    priority: (payload.priority === "high" || payload.priority === "low" ? payload.priority : "normal") as MessagePriority,
    receivedAt: String(payload.received_at),
    readAt: payload.read_at === undefined || payload.read_at === null ? null : String(payload.read_at),
    processedAt: payload.processed_at === undefined || payload.processed_at === null ? null : String(payload.processed_at),
  };
}

export class MessageInbox {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /** Store an inbound message from a pure-engineering listener (no AI involved). */
  record(args: JsonObject): InboxMessage {
    const source = normalizeSource(args.source);
    const from = text(args.from, "from");
    const subject = text(args.subject, "subject");
    const summary = args.summary === undefined || args.summary === null ? "" : bodyText(args.summary, "summary");
    const priority = normalizePriority(args.priority);
    const now = new Date().toISOString();
    const id = String(args.id ?? `msg_${randomUUID()}`);
    const payload = { id, source, from, subject, summary, priority, received_at: now, read_at: null, processed_at: null };
    this.store.save("message_inbox", id, payload);
    return toRecord(payload);
  }

  markRead(args: JsonObject): InboxMessage {
    const id = text(args.id, "id");
    const existing = this.store.find("message_inbox", id);
    if (!existing) throw new Error(`Unknown message: ${id}`);
    const payload = { ...existing, read_at: new Date().toISOString() };
    this.store.save("message_inbox", id, payload);
    return toRecord(payload);
  }

  /**
   * Record that a human asked the brain to handle this message. The inbox does
   * not perform the inference; it only timestamps the intent so the Pilot/Worker
   * layer can pick it up and so the action is auditable.
   */
  markProcessed(args: JsonObject): InboxMessage {
    const id = text(args.id, "id");
    const existing = this.store.find("message_inbox", id);
    if (!existing) throw new Error(`Unknown message: ${id}`);
    const processedAt = String(existing.processed_at ?? new Date().toISOString());
    const readAt = existing.read_at === undefined || existing.read_at === null ? new Date().toISOString() : String(existing.read_at);
    const payload = { ...existing, processed_at: processedAt, read_at: readAt };
    this.store.save("message_inbox", id, payload);
    return toRecord(payload);
  }

  list(args: JsonObject = {}): JsonObject {
    const unreadOnly = args.unread_only === true;
    const priority = args.priority === "high" || args.priority === "low" ? args.priority : null;
    const items = this.store
      .list("message_inbox", 1_000, (item) => (unreadOnly ? item.read_at === null : true)
        && (priority === null || item.priority === priority))
      .map(toRecord)
      .sort((a, b) => (a.priority === "high" ? -1 : a.priority === "low" ? 1 : 0) - (b.priority === "high" ? -1 : b.priority === "low" ? 1 : 0)
        || (a.receivedAt < b.receivedAt ? 1 : -1));
    return { items };
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function bodyText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (value.length > 4_000) throw new Error(`${name} must be 4000 characters or fewer`);
  return value;
}
