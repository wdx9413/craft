import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";

const FORMAT = "craft.trace.archive.v1";
const LOCAL_STORAGE = "local_jsonl_gzip";
const OBJECT_STORAGE = "object_jsonl_gzip";

export type TraceArchiveBundle = {
  trace_id: string;
  trace_version: number;
  archived_at: string;
  trace: JsonObject;
  events: JsonObject[];
  feedback: JsonObject[];
};

export type TraceArchivePointer = {
  /** Logical storage plugin chosen when the segment was written. */
  backend_id?: string;
  storage: typeof LOCAL_STORAGE | typeof OBJECT_STORAGE;
  format: typeof FORMAT;
  locator: string;
  uri: string;
  content_digest: string;
  bytes: number;
};

export interface TraceArchiveStore {
  write(bundle: TraceArchiveBundle): TraceArchivePointer;
  read(pointer: TraceArchivePointer): TraceArchiveBundle;
}

/** Minimal synchronous seam for a deployment-owned object-store client. */
export interface TraceObjectBackend {
  put(key: string, body: Uint8Array): void;
  get(key: string): Uint8Array;
}

type EncodedArchive = { compressed: Uint8Array; contentDigest: string };

function digest(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}





function validTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error("archived_at must be an ISO timestamp");
  return value;
}

function line(type: "trace" | "event" | "feedback", value: JsonObject): string {
  return JSON.stringify({ type, value });
}

function encode(bundle: TraceArchiveBundle): EncodedArchive {
  const traceId = text(bundle.trace_id, "trace_id");
  const traceVersion = Number(bundle.trace_version);
  if (!Number.isInteger(traceVersion) || traceVersion < 1) throw new Error("trace_version must be a positive integer");
  const archivedAt = validTimestamp(text(bundle.archived_at, "archived_at"));
  const records = [line("trace", object(bundle.trace, "trace"))];
  for (const event of bundle.events) records.push(line("event", object(event, "event")));
  for (const feedback of bundle.feedback) records.push(line("feedback", object(feedback, "feedback")));
  const payload = `${records.join("\n")}\n`;
  const contentDigest = digest(payload);
  const manifest = JSON.stringify({ format: FORMAT, trace_id: traceId, trace_version: traceVersion, archived_at: archivedAt, content_digest: contentDigest });
  return { compressed: gzipSync(Buffer.from(`${manifest}\n${payload}`, "utf8")), contentDigest };
}

function decode(body: Uint8Array, pointer: TraceArchivePointer): TraceArchiveBundle {
  let decoded: string;
  try { decoded = gunzipSync(body).toString("utf8"); } catch { throw new Error("Trace archive cannot be decoded"); }
  const lines = decoded.split("\n");
  if (lines.length < 3 || lines.at(-1) !== "") throw new Error("Trace archive JSONL is malformed");
  let manifest: JsonObject;
  try { manifest = object(JSON.parse(lines[0]), "archive manifest"); } catch { throw new Error("Trace archive JSONL is malformed"); }
  if (manifest.format !== FORMAT || manifest.content_digest !== pointer.content_digest) throw new Error("Trace archive digest does not match pointer");
  const payload = `${lines.slice(1, -1).join("\n")}\n`;
  if (digest(payload) !== pointer.content_digest) throw new Error("Trace archive digest does not match payload");
  const traceId = text(manifest.trace_id, "archive trace_id");
  const traceVersion = Number(manifest.trace_version);
  if (!Number.isInteger(traceVersion) || traceVersion < 1) throw new Error("Trace archive trace_version is invalid");
  const archivedAt = validTimestamp(text(manifest.archived_at, "archive archived_at"));
  const events: JsonObject[] = []; const feedback: JsonObject[] = []; let trace: JsonObject | null = null;
  for (const item of lines.slice(1, -1)) {
    let record: JsonObject;
    try { record = object(JSON.parse(item), "archive record"); } catch { throw new Error("Trace archive JSONL is malformed"); }
    const value = object(record.value, "archive record value");
    if (record.type === "trace" && trace === null) trace = value;
    else if (record.type === "event") events.push(value);
    else if (record.type === "feedback") feedback.push(value);
    else throw new Error("Trace archive record is unsupported");
  }
  if (trace === null) throw new Error("Trace archive is missing its trace record");
  return { trace_id: traceId, trace_version: traceVersion, archived_at: archivedAt, trace, events, feedback };
}

function dateParts(archivedAt: string): [string, string, string] {
  const date = new Date(archivedAt);
  return [String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")];
}

function traceFilename(bundle: TraceArchiveBundle, contentDigest: string): string {
  return `trace-${digest(bundle.trace_id).slice(-24)}.v${bundle.trace_version}.${contentDigest.slice(-16)}.jsonl.gz`;
}

function safeLocator(locator: string, prefix: string): string {
  const normalized = text(locator, "archive locator").replaceAll("\\", "/");
  if (!normalized.startsWith(`${prefix}/`) || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("Trace archive locator is unsafe");
  return normalized;
}

function pointer(storage: TraceArchivePointer["storage"], locator: string, contentDigest: string, bytes: number): TraceArchivePointer {
  return { storage, format: FORMAT, locator, uri: `craft://trace-archive/${storage === LOCAL_STORAGE ? "local" : "object"}/${contentDigest}`, content_digest: contentDigest, bytes };
}

/** Default adapter: private, date-partitioned local segments below Craft logs. */
export class LocalTraceArchiveStore implements TraceArchiveStore {
  readonly logsDir: string;
  constructor(logsDir: string) { this.logsDir = text(logsDir, "logsDir"); }

  write(bundle: TraceArchiveBundle): TraceArchivePointer {
    const encoded = encode(bundle); const [year, month, day] = dateParts(bundle.archived_at);
    const locator = `trace-archive/${year}/${month}/${day}/${traceFilename(bundle, encoded.contentDigest)}`;
    const path = join(this.logsDir, ...locator.split("/")); const result = pointer(LOCAL_STORAGE, locator, encoded.contentDigest, encoded.compressed.byteLength);
    mkdirSync(join(this.logsDir, "trace-archive", year, month, day), { recursive: true });
    if (existsSync(path)) { this.read(result); return result; }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, encoded.compressed, { mode: 0o600 }); renameSync(temporary, path); if (process.platform !== "win32") chmodSync(path, 0o600);
    return result;
  }

  read(value: TraceArchivePointer): TraceArchiveBundle {
    if (value.storage !== LOCAL_STORAGE || value.format !== FORMAT) throw new Error("Trace archive storage is unsupported");
    const locator = safeLocator(value.locator, "trace-archive");
    return decode(readFileSync(join(this.logsDir, ...locator.split("/"))), value);
  }
}

/** Deployment adapter: Craft owns the payload format, the operator owns transport and credentials. */
export class ObjectTraceArchiveStore implements TraceArchiveStore {
  readonly backend: TraceObjectBackend;
  readonly prefix: string;
  constructor(backend: TraceObjectBackend, prefix: string) {
    this.backend = backend; this.prefix = text(prefix, "object prefix").replace(/^\/+|\/+$/g, "");
    if (!this.prefix || this.prefix.split("/").some((part) => part === "." || part === ".." || !part)) throw new Error("object prefix is unsafe");
  }

  write(bundle: TraceArchiveBundle): TraceArchivePointer {
    const encoded = encode(bundle); const [year, month, day] = dateParts(bundle.archived_at);
    const locator = `${this.prefix}/${year}/${month}/${day}/${traceFilename(bundle, encoded.contentDigest)}`;
    this.backend.put(locator, encoded.compressed);
    return pointer(OBJECT_STORAGE, locator, encoded.contentDigest, encoded.compressed.byteLength);
  }

  read(value: TraceArchivePointer): TraceArchiveBundle {
    if (value.storage !== OBJECT_STORAGE || value.format !== FORMAT) throw new Error("Trace archive storage is unsupported");
    return decode(this.backend.get(safeLocator(value.locator, this.prefix)), value);
  }
}
