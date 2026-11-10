import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/application/craft-service.ts";

test("poll rolls back the inbox if recording the deduplication marker fails, then retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-poll-atomic-"));
  const drop = await mkdtemp(join(tmpdir(), "craft-poll-source-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    await writeFile(join(drop, "a.json"), JSON.stringify({ from: "a", subject: "hello", summary: "body" }));
    const service = new CraftService(store);
    const save = store.save.bind(store);
    let fail = true;
    store.save = (...args) => {
      if (args[0] === "message_seen" && fail) { fail = false; throw new Error("marker write failed"); }
      return save(...args);
    };
    const first = await service.messagePoll({ drop_dirs: [drop] });
    assert.equal(first.ingested, 0);
    assert.match(String((first.reports as Array<{ errors: string[] }>)[0].errors[0]), /marker write failed/u);
    assert.equal(store.list("message_inbox", 100).length, 0);
    assert.equal(store.list("message_seen", 100).length, 0);
    const second = await service.messagePoll({ drop_dirs: [drop] });
    assert.equal(second.ingested, 1);
    assert.equal(store.list("message_inbox", 100).length, 1);
    assert.equal(store.list("message_seen", 100).length, 1);
    assert.equal((await service.messagePoll({ drop_dirs: [drop] })).ingested, 0);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); await rm(drop, { recursive: true, force: true }); }
});

test("concurrent polls record and count the same message only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-poll-concurrent-"));
  const drop = await mkdtemp(join(tmpdir(), "craft-poll-source-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    await writeFile(join(drop, "a.json"), JSON.stringify({ from: "a", subject: "hello", summary: "body" }));
    const service = new CraftService(store);
    const results = await Promise.all([service.messagePoll({ drop_dirs: [drop] }), service.messagePoll({ drop_dirs: [drop] })]);
    assert.deepEqual(results.map(result => result.ingested).sort(), [0, 1]);
    assert.deepEqual(results.map(result => (result.reports as Array<{ ingested: number }>)[0].ingested).sort(), [0, 1]);
    assert.equal(store.list("message_inbox", 100).length, 1);
    assert.equal(store.list("message_seen", 100).length, 1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); await rm(drop, { recursive: true, force: true }); }
});

test("poll accepts a message without a summary and still rejects a non-string summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-poll-empty-"));
  const drop = await mkdtemp(join(tmpdir(), "craft-poll-source-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    await writeFile(join(drop, "a.json"), JSON.stringify({ from: "a", subject: "hello" }));
    const service = new CraftService(store);
    assert.equal((await service.messagePoll({ drop_dirs: [drop] })).ingested, 1);
    assert.equal(store.list("message_inbox", 100)[0].summary, "");
    assert.equal(service.messageIngest({ source: "email", from: "a", subject: "b" }).summary, "");
    assert.equal(service.messageIngest({ source: "email", from: "a", subject: "b", summary: null }).summary, "");
    assert.throws(() => service.messageIngest({ source: "email", from: "a", subject: "b", summary: 42 }), /summary/u);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); await rm(drop, { recursive: true, force: true }); }
});

test("poll preserves source timestamps and links the source identity to the inbox message", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-poll-time-"));
  const drop = await mkdtemp(join(tmpdir(), "craft-poll-source-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    await writeFile(join(drop, "a.json"), JSON.stringify({ from: "a", subject: "older", received_at: "2024-01-01T08:00:00+08:00" }));
    await writeFile(join(drop, "b.json"), JSON.stringify({ from: "b", subject: "newer", receivedAt: "2025-01-01T00:00:00Z" }));
    const service = new CraftService(store);
    assert.equal((await service.messagePoll({ drop_dirs: [drop] })).ingested, 2);
    const messages = (service.messageList({}).items as Array<{ id: string; subject: string; receivedAt: string }>);
    assert.deepEqual(messages.map(message => message.subject), ["newer", "older"]);
    assert.equal(messages[1].receivedAt, "2024-01-01T00:00:00.000Z");
    const seen = store.list("message_seen", 100);
    assert.deepEqual(seen.map(item => item.message_id).sort(), messages.map(item => item.id).sort());
    assert.throws(() => service.messageIngest({ source: "email", from: "a", subject: "b", received_at: "2024-01-01" }), /timezone/u);
    assert.throws(() => service.messageIngest({ source: "email", from: "a", subject: "b", received_at: 123 }), /timezone/u);
    assert.throws(() => service.messageIngest({ source: "email", from: "a", subject: "b", received_at: "2024-99-01T00:00:00Z" }), /valid timestamp/u);
    assert.equal(typeof service.messageIngest({ source: "email", from: "a", subject: "b", received_at: null }).receivedAt, "string");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); await rm(drop, { recursive: true, force: true }); }
});

test("poll reports bad files while importing valid files and retries them after repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-poll-partial-"));
  const drop = await mkdtemp(join(tmpdir(), "craft-poll-source-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    await writeFile(join(drop, "a.json"), "not json");
    await writeFile(join(drop, "b.json"), JSON.stringify({ from: "a", subject: "valid" }));
    const service = new CraftService(store);
    const first = await service.messagePoll({ drop_dirs: [drop] });
    assert.equal(first.ingested, 1);
    const report = (first.reports as Array<{ failed: number; errors: string[] }>)[0];
    assert.equal(report.failed, 1);
    assert.match(report.errors[0], /a\.json/u);
    assert.equal(store.list("message_inbox", 100).length, 1);
    await writeFile(join(drop, "a.json"), JSON.stringify({ from: "a", subject: "repaired" }));
    const second = await service.messagePoll({ drop_dirs: [drop] });
    assert.equal(second.ingested, 1);
    assert.equal(store.list("message_inbox", 100).length, 2);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); await rm(drop, { recursive: true, force: true }); }
});

test("invalid message fields do not block subsequent messages and are retried after correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-poll-invalid-"));
  const drop = await mkdtemp(join(tmpdir(), "craft-poll-source-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    await writeFile(join(drop, "a.json"), JSON.stringify({ from: "a", subject: "bad", received_at: "bad time" }));
    await writeFile(join(drop, "b.json"), JSON.stringify({ from: "b", subject: "valid" }));
    const service = new CraftService(store);
    const first = await service.messagePoll({ drop_dirs: [drop] });
    assert.equal(first.ingested, 1);
    assert.match((first.reports as Array<{ errors: string[] }>)[0].errors[0], /received_at/u);
    await writeFile(join(drop, "a.json"), JSON.stringify({ from: "a", subject: "fixed", received_at: "2024-01-01T00:00:00Z" }));
    assert.equal((await service.messagePoll({ drop_dirs: [drop] })).ingested, 1);
    assert.equal(store.list("message_inbox", 100).length, 2);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); await rm(drop, { recursive: true, force: true }); }
});
