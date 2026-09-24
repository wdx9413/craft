import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  LocalTraceArchiveStore,
  ObjectTraceArchiveStore,
  type TraceArchiveBundle,
  type TraceObjectBackend,
} from "../core/trace-archive-store.ts";

function bundle(): TraceArchiveBundle {
  return {
    trace_id: "trial:trace-1",
    trace_version: 2,
    archived_at: "2030-01-02T03:04:05.000Z",
    trace: { id: "trial:trace-1", version: 2, task_id: "task", status: "completed" },
    events: [{ id: "event-1", sequence: 1, event_kind: "action.completed" }],
    feedback: [{ id: "feedback-1", signal: "accepted" }],
  };
}

function pathFor(root: string, locator: string): string { return join(root, "logs", ...locator.split("/")); }
function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function rewrite(root: string, saved: ReturnType<LocalTraceArchiveStore["write"]>, records: string[], manifestPatch: Record<string, unknown> = {}) {
  const path = pathFor(root, saved.locator); const current = gunzipSync(readFileSync(path)).toString("utf8"); const [first] = current.split("\n");
  const payload = `${records.join("\n")}\n`; const manifest = { ...JSON.parse(first), ...manifestPatch, content_digest: digest(payload) };
  const pointer = { ...saved, content_digest: manifest.content_digest };
  writeFileSync(path, gzipSync(Buffer.from(`${JSON.stringify(manifest)}\n${payload}`, "utf8")));
  return pointer;
}

test("local Trace archive writes a private partitioned JSONL gzip segment and reads it through an opaque pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-archive-"));
  try {
    const archives = new LocalTraceArchiveStore(join(root, "logs"));
    const saved = archives.write(bundle());
    assert.equal(saved.storage, "local_jsonl_gzip");
    assert.match(saved.locator, /^trace-archive\/2030\/01\/02\/trace-[a-f0-9]+\.v2\.[a-f0-9]+\.jsonl\.gz$/);
    assert.equal(saved.uri.startsWith("craft://trace-archive/local/"), true);
    assert.equal(saved.bytes > 0, true);
    assert.deepEqual(archives.read(saved), bundle());
    assert.deepEqual(archives.write(bundle()), saved);
    assert.throws(() => archives.read({ ...saved, locator: "../outside.jsonl.gz" }), /locator/);
    assert.throws(() => archives.read({ ...saved, content_digest: "sha256:bad" }), /digest/);
    assert.throws(() => archives.read({ ...saved, format: "bad" as never }), /storage/);
    assert.throws(() => archives.write({ ...bundle(), trace_id: "" }), /must not be empty/);
    assert.throws(() => archives.write({ ...bundle(), trace_version: 0 }), /positive integer/);
    assert.throws(() => archives.write({ ...bundle(), archived_at: "bad" }), /ISO timestamp/);
    assert.throws(() => archives.write({ ...bundle(), trace: [] as unknown as TraceArchiveBundle["trace"] }), /must be an object/);
    assert.throws(() => archives.write({ ...bundle(), events: [null as unknown as TraceArchiveBundle["events"][number]] }), /must be an object/);
    assert.throws(() => archives.write({ ...bundle(), feedback: [null as unknown as TraceArchiveBundle["feedback"][number]] }), /must be an object/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local Trace archive fails closed for corrupt or structurally invalid segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-trace-archive-invalid-"));
  try {
    const archives = new LocalTraceArchiveStore(join(root, "logs"));
    const make = (suffix: string) => archives.write({ ...bundle(), trace_id: `trace-${suffix}` });
    const compressed = make("compressed"); writeFileSync(pathFor(root, compressed.locator), new Uint8Array([1, 2, 3]));
    assert.throws(() => archives.read(compressed), /cannot be decoded/);
    const malformed = make("malformed"); writeFileSync(pathFor(root, malformed.locator), gzipSync(Buffer.from("{}\n", "utf8")));
    assert.throws(() => archives.read(malformed), /JSONL is malformed/);
    const invalidManifest = make("invalid-manifest"); writeFileSync(pathFor(root, invalidManifest.locator), gzipSync(Buffer.from("[]\n{}\n", "utf8")));
    assert.throws(() => archives.read(invalidManifest), /JSONL is malformed/);
    const payloadMismatch = make("payload-mismatch"); const mismatchPath = pathFor(root, payloadMismatch.locator); const mismatchRaw = gunzipSync(readFileSync(mismatchPath)).toString("utf8");
    writeFileSync(mismatchPath, gzipSync(Buffer.from(mismatchRaw.replace("action.completed", "action.changed"), "utf8")));
    assert.throws(() => archives.read(payloadMismatch), /digest does not match payload/);
    const version = make("version"); const versionPointer = rewrite(root, version, [JSON.stringify({ type: "trace", value: bundle().trace })], { trace_version: 0 });
    assert.throws(() => archives.read(versionPointer), /trace_version is invalid/);
    const badRecord = make("bad-record"); const badRecordPointer = rewrite(root, badRecord, ["not-json"]);
    assert.throws(() => archives.read(badRecordPointer), /JSONL is malformed/);
    const duplicate = make("duplicate"); const duplicatePointer = rewrite(root, duplicate, [JSON.stringify({ type: "trace", value: bundle().trace }), JSON.stringify({ type: "trace", value: bundle().trace })]);
    assert.throws(() => archives.read(duplicatePointer), /record is unsupported/);
    const missing = make("missing"); const missingPointer = rewrite(root, missing, [JSON.stringify({ type: "event", value: bundle().events[0] })]);
    assert.throws(() => archives.read(missingPointer), /missing its trace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("object Trace archive remains a synchronous storage seam and never exposes a backend path as its public URI", () => {
  const objects = new Map<string, Uint8Array>();
  const backend: TraceObjectBackend = {
    put(key, body) { objects.set(key, body); },
    get(key) { const body = objects.get(key); if (!body) throw new Error(`missing ${key}`); return body; },
  };
  const archives = new ObjectTraceArchiveStore(backend, "craft/traces");
  const saved = archives.write(bundle());
  assert.equal(saved.storage, "object_jsonl_gzip");
  assert.match(saved.locator, /^craft\/traces\/2030\/01\/02\/trace-[a-f0-9]+\.v2\.[a-f0-9]+\.jsonl\.gz$/);
  assert.match(saved.uri, /^craft:\/\/trace-archive\/object\/sha256:/);
  assert.deepEqual(archives.read(saved), bundle());
  assert.throws(() => new ObjectTraceArchiveStore(backend, "../unsafe"), /prefix/);
  assert.throws(() => archives.read({ ...saved, storage: "local_jsonl_gzip" }), /storage/);
});
