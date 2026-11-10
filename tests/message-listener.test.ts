import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

test("invalid JSON message file surfaces a clear diagnostic", async () => {
  const dir = await dropDir();
  try {
    await writeFile(join(dir, "bad.json"), "{not json", "utf8");
    const adapter = new LocalDropAdapter(dir);
    assert.deepEqual(await adapter.poll(), []);
    assert.deepEqual(adapter.diagnostics(), { failed: 1, errors: ["无法读取或解析消息文件: bad.json"] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("file error diagnostics are bounded and returned as a copy", async () => {
  const dir = await dropDir();
  try {
    for (let index = 0; index < 21; index++) await writeFile(join(dir, `${index}.json`), "{");
    const adapter = new LocalDropAdapter(dir);
    await adapter.poll();
    const diagnostics = adapter.diagnostics();
    assert.equal(diagnostics.failed, 21);
    assert.equal(diagnostics.errors.length, 20);
    diagnostics.errors.length = 0;
    assert.equal(adapter.diagnostics().errors.length, 20);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("local source refuses symlinks and oversized files without blocking valid files", async (context) => {
  const dir = await dropDir();
  const outside = await dropDir();
  try {
    await writeFile(join(outside, "secret.json"), JSON.stringify({ from: "outside", subject: "secret" }));
    let symlinkAvailable = true;
    try {
      await symlink(join(outside, "secret.json"), join(dir, "link.json"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ERROR_PRIVILEGE_NOT_HELD"].includes(code ?? "")) throw error;
      symlinkAvailable = false;
      context.diagnostic(`symlink creation unavailable (${code}); skipping only the symlink assertions`);
    }
    await writeFile(join(dir, "large.md"), "x".repeat(1024 * 1024 + 1));
    await writeFile(join(dir, "valid.json"), JSON.stringify({ from: "a", subject: "valid" }));
    await mkdir(join(dir, "folder.json"));
    const adapter = new LocalDropAdapter(dir);
    assert.deepEqual((await adapter.poll()).map(message => message.subject), ["valid"]);
    const result = adapter.diagnostics();
    assert.equal(result.failed, symlinkAvailable ? 2 : 1);
    if (symlinkAvailable) assert.ok(result.errors.some(error => error.includes("link.json")));
    assert.ok(result.errors.some(error => error.includes("large.md")));
    await writeFile(join(dir, "large.md"), "repaired");
    assert.deepEqual((await adapter.poll()).map(message => message.summary), ["repaired"]);
    assert.equal(adapter.diagnostics().failed, symlinkAvailable ? 1 : 0);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("local source accepts a message at the byte limit", async () => {
  const dir = await dropDir();
  try {
    await writeFile(join(dir, "boundary.md"), "x".repeat(1024 * 1024));
    const adapter = new LocalDropAdapter(dir);
    assert.equal((await adapter.poll())[0].summary.length, 1024 * 1024);
    assert.equal(adapter.diagnostics().failed, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a malformed file does not block valid messages and is retried after repair", async () => {
  const dir = await dropDir();
  try {
    await writeFile(join(dir, "a.json"), JSON.stringify({ subject: "first" }));
    await writeFile(join(dir, "b.json"), "{");
    const adapter = new LocalDropAdapter(dir);
    assert.deepEqual((await adapter.poll()).map((message) => message.subject), ["first"]);
    assert.equal(adapter.diagnostics().failed, 1);
    await writeFile(join(dir, "b.json"), JSON.stringify({ subject: "second" }));
    assert.deepEqual((await adapter.poll()).map((message) => message.subject), ["second"]);
    assert.equal(adapter.diagnostics().failed, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed ingestion retries only the failed message and continues with later messages", async () => {
  const dir = await dropDir();
  try {
    for (const name of ["a", "b", "c"]) await writeFile(join(dir, `${name}.json`), JSON.stringify({ subject: name }));
    const delivered: string[] = [];
    let fail = true;
    const listener = new MessageListener([new LocalDropAdapter(dir)], (message) => {
      if (message.subject === "b" && fail) { fail = false; throw new Error("store unavailable"); }
      delivered.push(message.subject);
    });
    const first = await listener.pollAll();
    assert.equal(first[0].ingested, 2);
    assert.match(first[0].errors?.[0] ?? "", /store unavailable/u);
    assert.equal((await listener.pollAll())[0].ingested, 1);
    assert.deepEqual(delivered, ["a", "c", "b"]);
    assert.equal((await listener.pollAll())[0].ingested, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("retry ignores messages from other sources", async () => {
  const dir = await dropDir();
  try {
    await writeFile(join(dir, "a.json"), JSON.stringify({ subject: "a" }));
    const adapter = new LocalDropAdapter(dir, "one");
    const [message] = await adapter.poll();
    adapter.retry([{ ...message, externalId: message.externalId.replace(/^one#/u, "other#") }]);
    assert.deepEqual(await adapter.poll(), []);
    adapter.retry([message]);
    assert.equal((await adapter.poll()).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("listener reports ingestion errors from adapters without retry support", async () => {
  const adapter = { id: "source", poll: async () => [{ externalId: "1", source: "other" as const, from: "x", subject: "x", summary: "x" }] };
  const listener = new MessageListener([adapter], () => { throw new Error("failed"); });
  assert.deepEqual(await listener.pollAll(), [{ source: "source", ingested: 0, failed: 1, errors: ["failed"] }]);
});

test("listener bounds ingestion diagnostics and handles non-Error failures", async () => {
  const adapter = { id: "source", poll: async () => Array.from({ length: 21 }, (_, index) => ({ externalId: String(index), source: "other" as const, from: "a", subject: "b", summary: "" })) };
  const listener = new MessageListener([adapter], () => { throw "rejected"; });
  const [report] = await listener.pollAll();
  assert.equal(report.failed, 21);
  assert.equal(report.errors?.length, 20);
  assert.equal(report.errors?.[0], "消息入库失败");
});
