import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CraftPaths } from "./paths.ts";

export type ContentKind = "knowledge" | "memory";
export type ContentStatus = "candidate" | "reviewed" | "active" | "disputed" | "superseded" | "expired" | "revoked";

export interface ContentWriteInput {
  kind: ContentKind;
  record_id: string;
  version: number;
  scope: string;
  status: ContentStatus | string;
  sensitivity: string;
  source_id: string;
  body: string;
}

export interface ContentRef {
  kind: ContentKind;
  record_id: string;
  version: number;
  path: string;
  digest: string;
  bytes: number;
  format: "markdown";
}

export interface ContentManifest {
  schema_version: "craft.content.v1";
  record_kind: ContentKind;
  record_id: string;
  record_version: number;
  scope: string;
  status: string;
  sensitivity: string;
  source_id: string;
  body_digest: string;
  updated_at: string;
}

export interface ContentReadResult { body: string; manifest: ContentManifest; }
export interface ContentVerification { status: "verified" | "missing" | "drifted"; path: string; digest: string | null; }

const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
const SAFE_ID = /^[A-Za-z0-9._-]+$/u;

function bodyDigest(body: string): string { return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`; }
export function validateContentBody(body: string): void {
  if (typeof body !== "string" || !body.trim()) throw new Error("Content body must not be empty");
  if (SECRET.test(body)) throw new Error("Content body must not contain credentials or secrets");
}
function quote(value: string): string { return JSON.stringify(value); }
function parseScalar(value: string): string { try { return JSON.parse(value) as string; } catch { return value; } }

function parseDocument(raw: string): { manifest: ContentManifest; body: string } {
  const lines = raw.split(/\r?\n/u);
  if (lines[0] !== "---") throw new Error("Content Markdown frontmatter is missing");
  const end = lines.slice(1).findIndex((line) => line === "---");
  if (end < 0) throw new Error("Content Markdown frontmatter is not closed");
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end + 1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("Content Markdown frontmatter is invalid");
    fields.set(line.slice(0, separator).trim(), parseScalar(line.slice(separator + 1).trim()));
  }
  const manifest = {
    schema_version: fields.get("schema_version"), record_kind: fields.get("record_kind"), record_id: fields.get("record_id"),
    record_version: Number(fields.get("record_version")), scope: fields.get("scope"), status: fields.get("status"),
    sensitivity: fields.get("sensitivity"), source_id: fields.get("source_id"), body_digest: fields.get("body_digest"), updated_at: fields.get("updated_at"),
  } as Partial<ContentManifest>;
  if (manifest.schema_version !== "craft.content.v1" || (manifest.record_kind !== "knowledge" && manifest.record_kind !== "memory")
    || !manifest.record_id || !Number.isSafeInteger(manifest.record_version) || !manifest.scope || !manifest.status
    || !manifest.sensitivity || !manifest.source_id || !manifest.body_digest || !manifest.updated_at) {
    throw new Error("Content Markdown frontmatter is incomplete");
  }
  return { manifest: manifest as ContentManifest, body: lines.slice(end + 2).join("\n") };
}

function safeFileName(id: string): string {
  if (!id.trim() || id.includes("/") || id.includes("\\") || id.includes("..")) throw new Error("Content record_id is an unsafe identifier");
  if (SAFE_ID.test(id)) return id;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${id.replace(/[^A-Za-z0-9._-]/gu, "_")}-${digest}`;
}

export class MarkdownContentStore {
  readonly paths: CraftPaths;
  constructor(paths: CraftPaths) { this.paths = paths; }

  pathFor(kind: ContentKind, recordId: string, version?: number): string {
    const directory = kind === "knowledge" ? this.paths.knowledgeContentDir : this.paths.memoryContentDir;
    return join(directory, `${safeFileName(recordId)}${version === undefined ? "" : `.v${version}`}.md`);
  }

  legacyPathFor(kind: ContentKind, recordId: string, version?: number): string {
    const directory = kind === "knowledge" ? join(this.paths.root, "content", "knowledge", "md") : join(this.paths.root, "content", "memory", "md");
    return join(directory, `${safeFileName(recordId)}${version === undefined ? "" : `.v${version}`}.md`);
  }

  isCanonicalRef(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path">): boolean {
    return resolve(ref.path) === resolve(this.pathFor(ref.kind, ref.record_id, ref.version));
  }

  async write(input: ContentWriteInput): Promise<ContentRef> {
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("Content version must be a positive integer");
    validateContentBody(input.body);
    const path = this.pathFor(input.kind, input.record_id, input.version);
    await mkdir(resolve(path, ".."), { recursive: true });
    const digest = bodyDigest(input.body);
    try {
      const existing = await this.readPath(path);
      if (existing.manifest.record_id !== input.record_id || existing.manifest.record_kind !== input.kind) throw new Error("Content file identity conflict");
      if (existing.manifest.body_digest === digest && existing.manifest.record_version === input.version) return this.ref(input.kind, input.record_id, input.version, path, digest, input.body);
      throw new Error("Content version already exists with different body");
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|no such file/iu.test(error.message)) throw error;
    }
    const manifest = this.manifest(input, digest);
    const raw = this.serialize(manifest, input.body);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, raw, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    return this.ref(input.kind, input.record_id, input.version, path, digest, input.body);
  }

  writeSync(input: ContentWriteInput): ContentRef {
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("Content version must be a positive integer");
    validateContentBody(input.body);
    const path = this.pathFor(input.kind, input.record_id, input.version); mkdirSync(resolve(path, ".."), { recursive: true });
    const digest = bodyDigest(input.body);
    try {
      const existing = parseDocument(readFileSync(path, "utf8"));
      if (existing.manifest.record_id !== input.record_id || existing.manifest.record_kind !== input.kind) throw new Error("Content file identity conflict");
      if (existing.manifest.body_digest === digest && existing.manifest.record_version === input.version) return this.ref(input.kind, input.record_id, input.version, path, digest, input.body);
      throw new Error("Content version already exists with different body");
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|no such file/iu.test(error.message)) throw error;
    }
    const raw = this.serialize(this.manifest(input, digest), input.body);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, raw, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, path);
    return this.ref(input.kind, input.record_id, input.version, path, digest, input.body);
  }

  async read(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "digest">): Promise<ContentReadResult> {
    const expected = this.pathFor(ref.kind, ref.record_id, ref.version);
    if (resolve(ref.path) !== resolve(expected)) throw new Error("Content reference path is outside the canonical directory");
    const result = await this.readPath(ref.path);
    if (result.manifest.record_id !== ref.record_id || result.manifest.record_kind !== ref.kind || result.manifest.record_version !== ref.version) throw new Error("Content reference metadata drifted");
    if (result.manifest.body_digest !== ref.digest || bodyDigest(result.body) !== ref.digest) throw new Error("Content body digest drifted");
    return result;
  }

  readSync(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "digest">): ContentReadResult {
    const expected = this.pathFor(ref.kind, ref.record_id, ref.version);
    if (resolve(ref.path) !== resolve(expected)) throw new Error("Content reference path is outside the canonical directory");
    const result = parseDocument(readFileSync(ref.path, "utf8"));
    if (result.manifest.record_id !== ref.record_id || result.manifest.record_kind !== ref.kind || result.manifest.record_version !== ref.version) throw new Error("Content reference metadata drifted");
    if (result.manifest.body_digest !== ref.digest || bodyDigest(result.body) !== ref.digest) throw new Error("Content body digest drifted");
    return result;
  }

  /** Read a reference from the current location or the pre-v0.12.31 content
   * tree. Legacy reads are still digest-checked and are only a compatibility
   * bridge for migration; new writes always use the canonical domain path. */
  readCompatSync(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "digest">): ContentReadResult {
    if (this.isCanonicalRef(ref)) return this.readSync(ref);
    if (resolve(ref.path) !== resolve(this.legacyPathFor(ref.kind, ref.record_id, ref.version))) {
      throw new Error("Content reference path is outside the canonical directory");
    }
    const result = parseDocument(readFileSync(ref.path, "utf8"));
    if (result.manifest.record_id !== ref.record_id || result.manifest.record_kind !== ref.kind || result.manifest.record_version !== ref.version) throw new Error("Content reference metadata drifted");
    if (result.manifest.body_digest !== ref.digest || bodyDigest(result.body) !== ref.digest) throw new Error("Content body digest drifted");
    return result;
  }

  readUncheckedSync(path: string): ContentReadResult { return parseDocument(readFileSync(path, "utf8")); }

  async verify(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "digest">): Promise<ContentVerification> {
    try { await this.read(ref); return { status: "verified", path: ref.path, digest: ref.digest }; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: /ENOENT|no such file/iu.test(message) ? "missing" : "drifted", path: ref.path, digest: null };
    }
  }

  verifySync(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "digest">): ContentVerification {
    try { this.readSync(ref); return { status: "verified", path: ref.path, digest: ref.digest }; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: /ENOENT|no such file/iu.test(message) ? "missing" : "drifted", path: ref.path, digest: null };
    }
  }

  private async readPath(path: string): Promise<ContentReadResult> { return parseDocument(await readFile(path, "utf8")); }

  private manifest(input: ContentWriteInput, digest: string): ContentManifest {
    return { schema_version: "craft.content.v1", record_kind: input.kind, record_id: input.record_id,
      record_version: input.version, scope: input.scope, status: input.status, sensitivity: input.sensitivity, source_id: input.source_id,
      body_digest: digest, updated_at: new Date().toISOString() };
  }

  private ref(kind: ContentKind, recordId: string, version: number, path: string, digest: string, body: string): ContentRef {
    return { kind, record_id: recordId, version, path, digest, bytes: Buffer.byteLength(body, "utf8"), format: "markdown" };
  }

  private serialize(manifest: ContentManifest, body: string): string {
    const lines = Object.entries(manifest).map(([key, value]) => `${key}: ${typeof value === "number" ? value : quote(value)}`);
    return `---\n${lines.join("\n")}\n---\n${body}`;
  }
}

export function contentReference(value: unknown): value is ContentRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (item.kind === "knowledge" || item.kind === "memory") && typeof item.record_id === "string" && Number.isSafeInteger(item.version)
    && typeof item.path === "string" && typeof item.digest === "string" && item.format === "markdown";
}
