import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { MessageInbox, type InboxMessage } from "../core/message-inbox.ts";
import { type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/application/craft-service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-msg-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, inbox: new MessageInbox(store) };
}
const asMsg = (value: unknown): InboxMessage => (value as JsonObject) as unknown as InboxMessage;

test("a message is stored with zero inference and surfaces in priority order", async () => {
  const { store, inbox } = await fixture();
  try {
    const high = asMsg(inbox.record({ source: "email", from: "boss@x.com", subject: "决策", summary: "需要回复", priority: "high" }));
    assert.equal(high.readAt, null);
    const low = asMsg(inbox.record({ source: "im", from: "bot", subject: "hi", priority: "low" }));
    const list = (inbox.list().items as InboxMessage[]);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, high.id); // high priority first
    assert.equal(list[1].id, low.id);
    // Unread filter hides the read one.
    inbox.markRead({ id: low.id });
    const unread = (inbox.list({ unread_only: true }).items as InboxMessage[]);
    assert.equal(unread.length, 1);
    assert.equal(unread[0].id, high.id);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("processing a message records intent without calling a model", async () => {
  const { store, inbox } = await fixture();
  try {
    const msg = asMsg(inbox.record({ source: "email", from: "a@b.com", subject: "s", priority: "normal" }));
    const processed = inbox.markProcessed({ id: msg.id });
    assert.notEqual(processed.processedAt, null);
    assert.notEqual(processed.readAt, null);
    // Idempotent-ish: a second process keeps the original timestamp.
    const again = inbox.markProcessed({ id: msg.id });
    assert.equal(again.processedAt, processed.processedAt);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("rejects malformed message input", async () => {
  const { store, inbox } = await fixture();
  try {
    assert.throws(() => inbox.record({ source: "email" }), /non-empty string/); // from missing
    assert.throws(() => inbox.record({ source: "fax", from: "a", subject: "s" }), /email, im, webhook or other/);
    assert.throws(() => inbox.record({ source: "email", from: "a", subject: "s", priority: "urgent" }), /low, normal or high/);
    assert.throws(() => inbox.markRead({ id: "missing" }), /Unknown message/);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("normalizes defaults, bounds summaries, filters priorities and reads malformed rows", async () => {
  const { store, inbox } = await fixture();
  try {
    // Omitted, null and explicit "other" sources all normalize to "other".
    assert.equal(asMsg(inbox.record({ from: "a", subject: "s" })).source, "other");
    assert.equal(asMsg(inbox.record({ source: null, from: "a", subject: "s" })).source, "other");
    assert.equal(asMsg(inbox.record({ source: "other", from: "a", subject: "s" })).source, "other");
    // Omitted and null summaries become empty; non-strings and oversized text are refused.
    assert.equal(asMsg(inbox.record({ from: "a", subject: "s", summary: null })).summary, "");
    assert.throws(() => inbox.record({ from: "a", subject: "s", summary: 5 }), /must be a string/u);
    assert.throws(() => inbox.record({ from: "a", subject: "s", summary: "x".repeat(4_001) }), /4000 characters/u);
    assert.throws(() => inbox.markProcessed({ id: "missing" }), /Unknown message/u);
    // Priority filters only return that priority.
    inbox.record({ from: "a", subject: "h", priority: "high" });
    inbox.record({ from: "a", subject: "l", priority: "low" });
    assert.ok((inbox.list({ priority: "high" }).items as InboxMessage[]).every(item => item.priority === "high"));
    assert.ok((inbox.list({ priority: "low" }).items as InboxMessage[]).every(item => item.priority === "low"));
    // A stored row written outside record() must still project with safe defaults.
    store.save("message_inbox", "raw", { id: "raw", received_at: "2020-01-01T00:00:00.000Z" });
    const raw = (inbox.list().items as InboxMessage[]).find(item => item.id === "raw");
    assert.deepEqual([raw?.source, raw?.from, raw?.subject, raw?.summary, raw?.priority, raw?.readAt, raw?.processedAt],
      ["other", "", "", "", "normal", null, null]);
    // Mixed normal-priority rows exercise both directions of the receivedAt tie-break.
    for (const [id, at] of [["n2022", "2022-01-01T00:00:00.000Z"], ["n2023", "2023-01-01T00:00:00.000Z"], ["n2021", "2021-01-01T00:00:00.000Z"]] as const) {
      store.save("message_inbox", id, { id, source: "im", from: "a", subject: "s", summary: "", priority: "normal", received_at: at, read_at: null, processed_at: null });
    }
    const ordered = (inbox.list().items as InboxMessage[]).filter(item => item.id.startsWith("n"));
    assert.deepEqual(ordered.map(item => item.id), ["n2023", "n2022", "n2021"]);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("webhook ingest stores a bounded summary and on-demand processing dispatches a Pilot turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-msg-svc-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    const ingested = service.messageIngest({ source: "webhook", from: "ci@bot", subject: "构建失败",
      summary: "main 分支构建失败，请生成简报", priority: "high" }) as unknown as InboxMessage;
    assert.equal(ingested.priority, "high");
    const listed = (service.messageList({ unread_only: true }) as JsonObject).items as InboxMessage[];
    assert.equal(listed.length, 1);
    // Processing is the only step that creates a session/turn (on-demand AI).
    const processed = service.messageProcess({ id: ingested.id }) as unknown as { dispatched: boolean; session_id: string; turn_id: string | null };
    assert.equal(processed.dispatched, true);
    assert.equal(processed.session_id, `pilot_session_msg_${ingested.id}`);
    assert.notEqual(processed.turn_id, null);
    // Idempotent: re-processing never creates a second turn.
    const again = service.messageProcess({ id: ingested.id }) as unknown as { turn_id: string | null };
    assert.equal(again.turn_id, processed.turn_id);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("inbound message credentials are redacted before storage, sender stays readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-msg-datasec-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    const secret = ["alpha", "bravo", "charlie", "12345678"].join("_");
    const label = ["api", "key"].join("_");
    const sender = "zhang" + String.fromCharCode(64) + "example" + "." + "com";
    const saved = service.messageIngest({ source: "email", from: sender,
      subject: "配置更新", summary: `${label}: ${secret} 请查收`, priority: "high" }) as unknown as InboxMessage;
    assert.equal(saved.from, sender, "sender stays readable, not masked");
    assert.equal(String(saved.summary).includes(secret), false, "credential never reaches the store");
    assert.match(String(saved.summary), /REDACTED/u);
    const raw = JSON.stringify(store.get("message_inbox", saved.id));
    assert.equal(raw.includes(secret), false);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("console batch read is 0-Token and one bad id does not drop the others", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-msg-batch-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    const a = service.messageIngest({ source: "email", from: "a@x", subject: "A" }) as unknown as InboxMessage;
    const b = service.messageIngest({ source: "email", from: "b@x", subject: "B" }) as unknown as InboxMessage;
    const done = service.messageBatch({ action: "read", ids: [a.id, "missing", b.id] }) as unknown as {
      succeeded: number; failed: number; tokens_spent_only_on_demand: boolean; results: { ok: boolean }[];
    };
    assert.equal(done.succeeded, 2);
    assert.equal(done.failed, 1);
    assert.equal(done.tokens_spent_only_on_demand, false);
    assert.equal(((service.messageList({ unread_only: true }) as JsonObject).items as unknown[]).length, 0);
    assert.throws(() => service.messageBatch({ action: "read", ids: [] }), /ids must not be empty/u);
    assert.throws(() => service.messageBatch({ action: "delete", ids: [a.id] }), /action must/u);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("a blocked Coordinator intake is reported honestly, not as a dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-msg-blocked-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    // Two equally plausible directories make the Navigator ask instead of guess.
    for (const name of ["alpha", "belta"]) {
      await mkdir(join(root, name));
      service.workspaceResolveOrCreate({ root_path: join(root, name) });
    }
    const ingested = service.messageIngest({ source: "webhook", from: "ci@bot", subject: "整理 alpha belta",
      summary: "整理 alpha belta" }) as unknown as InboxMessage;
    const result = service.messageProcess({ id: ingested.id }) as unknown as {
      dispatched: boolean; status: string; turn_id: string | null; questions: { options?: string[] }[];
    };
    assert.equal(result.dispatched, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.turn_id, null);
    assert.equal(result.questions[0]?.options?.length, 2);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});
