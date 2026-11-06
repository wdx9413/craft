import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalDropAdapter, MessageListener, ImapAdapter, type RawMessage } from "../core/message-listener.ts";

async function dropDir() {
  const dir = await mkdtemp(join(tmpdir(), "craft-listener-"));
  return dir;
}

test("local drop adapter reads JSON and Markdown messages and dedups by content hash", async () => {
  const dir = await dropDir();
  try {
    await writeFile(join(dir, "a.json"), JSON.stringify({ source: "email", from: "boss", subject: "plan", summary: "review next week", priority: "high" }), "utf8");
    await writeFile(join(dir, "b.md"), "---\nfrom: ops\nsubject: incident\n---\nserver down, please look\n", "utf8");
    await writeFile(join(dir, "ignored.txt"), "not a message", "utf8");
    const adapter = new LocalDropAdapter(dir);
    const first = await adapter.poll();
    assert.equal(first.length, 2);
    const byFrom = Object.fromEntries(first.map((m) => [m.from, m]));
    assert.equal(byFrom.boss.subject, "plan");
    assert.equal(byFrom.boss.priority, "high");
    assert.match(byFrom.ops.summary, /server down/u);
    // Re-poll without changes yields nothing new.
    const second = await adapter.poll();
    assert.equal(second.length, 0);
    // A new file is picked up.
    await writeFile(join(dir, "c.json"), JSON.stringify({ from: "qa", subject: "case" }), "utf8");
    const third = await adapter.poll();
    assert.equal(third.length, 1);
    assert.equal(third[0].from, "qa");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("listener ingests each unseen message once through the gate and reports per source", async () => {
  const dir = await dropDir();
  try {
    await writeFile(join(dir, "a.json"), JSON.stringify({ source: "im", from: "alice", subject: "hi", summary: "s" }), "utf8");
    const ingested: RawMessage[] = [];
    const listener = new MessageListener([new LocalDropAdapter(dir)], (raw) => { ingested.push(raw); });
    const reports = await listener.pollAll();
    assert.equal(reports[0].ingested, 1);
    assert.equal(ingested.length, 1);
    // A second pollAll ingests nothing new (dedup by externalId).
    const again = await listener.pollAll();
    assert.equal(again[0].ingested, 0);
    assert.equal(ingested.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failing adapter is reported, not thrown, so other sources keep working", async () => {
  const dir = await dropDir();
  try {
    await writeFile(join(dir, "a.json"), JSON.stringify({ from: "x", subject: "y", summary: "z" }), "utf8");
    const broken = { id: "imap", poll: () => Promise.reject(new Error("no server")) };
    let count = 0;
    const listener = new MessageListener([broken, new LocalDropAdapter(dir)], () => { count++; });
    const reports = await listener.pollAll();
    const imap = reports.find((r) => r.source === "imap") ?? { source: "", ingested: 0, error: "" };
    const drop = reports.find((r) => r.source.startsWith("drop:")) ?? { source: "", ingested: 0 };
    assert.match(imap.error ?? "", /no server/u);
    assert.equal(drop.ingested, 1);
    assert.equal(count, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("IMAP adapter fails loudly without configuration rather than swallowing messages", async () => {
  const adapter = new ImapAdapter();
  await assert.rejects(() => adapter.poll(), /host and user/u);
});

test("invalid JSON message file surfaces a clear error", async () => {
  const dir = await dropDir();
  try {
    await writeFile(join(dir, "bad.json"), "{not json", "utf8");
    const adapter = new LocalDropAdapter(dir);
    await assert.rejects(() => adapter.poll(), /invalid JSON/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
