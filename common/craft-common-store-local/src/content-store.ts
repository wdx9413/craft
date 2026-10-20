import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { CraftPaths } from "./paths.ts";

export type ContentKind = "knowledge" | "memory" | "experience";
/** Experience keeps human-readable procedures by format without splitting its fact ledger. */
export type ExperienceFolder = "workflows" | "graphs" | "prompts";
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
  /** Human-readable label used only for the Markdown filename/frontmatter. */
  title?: string;
  /** Existing path used by source-aware migrations when a semantic rename is needed. */
  current_path?: string;
  /** Project checkout whose private Knowledge directory owns this content. */
  project_root?: string;
  /** Only Experience documents may select a managed, format-specific folder. */
  folder?: ExperienceFolder;
  /** Domain-owned scalar metadata that remains visible in the Markdown frontmatter. */
  frontmatter?: Readonly<Record<string, string | number | boolean>>;
}

export interface ContentRef {
  kind: ContentKind;
  record_id: string;
  version: number;
  path: string;
  digest: string;
  bytes: number;
  format: "markdown";
  title: string;
  /** Present on new references; callers may provide a legacy record's scope when reading. */
  scope?: string;
}

export type ProjectKnowledgeContentDirectoryResolver = (scope: string, options: {
  project_root?: string; reference_path?: string; create?: boolean;
}) => string | null;

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
  title?: string;
  [key: string]: string | number | boolean | undefined;
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
  if (manifest.schema_version !== "craft.content.v1" || !["knowledge", "memory", "experience"].includes(String(manifest.record_kind))
    || !manifest.record_id || !Number.isSafeInteger(manifest.record_version) || !manifest.scope || !manifest.status
    || !manifest.sensitivity || !manifest.source_id || !manifest.body_digest || !manifest.updated_at) {
    throw new Error("Content Markdown frontmatter is incomplete");
  }
  for (const [key, value] of fields) {
    if (key in manifest) continue;
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || !["string", "number", "boolean"].includes(typeof value)
      || typeof value === "string" && SECRET.test(value)) throw new Error("Content Markdown frontmatter contains unsafe metadata");
    (manifest as Record<string, unknown>)[key] = value;
  }
  return { manifest: manifest as ContentManifest, body: lines.slice(end + 2).join("\n") };
}

function safeFileName(id: string): string {
  if (!id.trim() || id.includes("/") || id.includes("\\") || id.includes("..")) throw new Error("Content record_id is an unsafe identifier");
  if (SAFE_ID.test(id)) return id;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${id.replace(/[^A-Za-z0-9._-]/gu, "_")}-${digest}`;
}

function titleFromBody(body: string): string | undefined {
  const heading = body.split(/\r?\n/u).find((line) => /^\s{0,3}#{1,6}\s+\S/u.test(line));
  const first = heading ? heading.replace(/^\s{0,3}#{1,6}\s+/u, "") : body.split(/\r?\n/u).find((line) => line.trim());
  if (!first) return undefined;
  return first.trim().slice(0, 120);
}

export function contentTitle(body: string, title?: string, fallback = "untitled"): string {
  const value = (title ?? titleFromBody(body) ?? fallback).normalize("NFKC").trim().replace(/[\r\n]+/gu, " ");
  if (!value) throw new Error("Content title must not be empty");
  if (SECRET.test(value)) throw new Error("Content title must not contain credentials or secrets");
  return value.slice(0, 120);
}

function titleSlug(title: string): string {
  const slug = title
    .replace(/[\\/]/gu, " ")
    .replace(/[^\p{L}\p{N}._ -]/gu, " ")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 96);
  return slug || "untitled";
}

function idSuffix(recordId: string): string {
  const hash = createHash("sha256").update(recordId, "utf8").digest("hex").slice(0, 12);
  return hash;
}

export class MarkdownContentStore {
  readonly paths: CraftPaths;
  #projectKnowledgeDirectory: ProjectKnowledgeContentDirectoryResolver | undefined;
  #projectMemoryDirectory: ProjectKnowledgeContentDirectoryResolver | undefined;
  constructor(paths: CraftPaths) { this.paths = paths; }

  setProjectKnowledgeDirectoryResolver(resolver: ProjectKnowledgeContentDirectoryResolver): void {
    this.#projectKnowledgeDirectory = resolver;
  }

  setProjectMemoryDirectoryResolver(resolver: ProjectKnowledgeContentDirectoryResolver): void {
    this.#projectMemoryDirectory = resolver;
  }

  pathFor(kind: ContentKind, recordId: string, version?: number, folder?: ExperienceFolder, scope?: string, projectRoot?: string): string {
    const directory = this.directory(kind, folder, scope, projectRoot, undefined, true);
    return join(directory, `${safeFileName(recordId)}${version === undefined ? "" : `.v${version}`}.md`);
  }

  /** Stable, human-readable path. The hash suffix keeps duplicate titles distinct. */
  namedPathFor(kind: ContentKind, recordId: string, version: number | undefined, title: string, folder?: ExperienceFolder,
    scope?: string, projectRoot?: string, referencePath?: string): string {
    const directory = this.directory(kind, folder, scope, projectRoot, referencePath, true);
    safeFileName(recordId);
    return join(directory, `${titleSlug(title)}--${idSuffix(recordId)}${version === undefined ? "" : `.v${version}`}.md`);
  }

  legacyPathFor(kind: ContentKind, recordId: string, version?: number): string {
    const directory = join(this.paths.root, "content", kind, "md");
    return join(directory, `${safeFileName(recordId)}${version === undefined ? "" : `.v${version}`}.md`);
  }

  isCanonicalRef(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "scope">): boolean {
    const directory = resolve(this.directory(ref.kind, undefined, ref.scope, undefined, ref.path));
    const target = resolve(ref.path);
    const inDirectory = ref.kind === "experience"
      ? target.startsWith(`${directory}${sep}`)
      : dirname(target) === directory;
    return inDirectory && target.endsWith(`.v${ref.version}.md`);
  }

  async write(input: ContentWriteInput): Promise<ContentRef> {
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("Content version must be a positive integer");
    validateContentBody(input.body);
    const title = contentTitle(input.body, input.title, input.record_id);
    const path = this.namedPathFor(input.kind, input.record_id, input.version, title, input.folder, input.scope, input.project_root);
    await mkdir(resolve(path, ".."), { recursive: true });
    const digest = bodyDigest(input.body);
    const existingPath = existsSync(path) ? path : this.findCanonicalPath(input.kind, input.record_id, input.version, input.scope, input.project_root);
    try {
      const existing = await this.readPath(existingPath ?? path);
      if (existing.manifest.record_id !== input.record_id || existing.manifest.record_kind !== input.kind) throw new Error("Content file identity conflict");
      if (existing.manifest.body_digest === digest && existing.manifest.record_version === input.version) return this.ref(input.kind, input.record_id, input.version, existingPath!, digest, input.body, existing.manifest.title ?? title, input.scope);
      throw new Error("Content version already exists with different body");
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|no such file/iu.test(error.message)) throw error;
    }
    const manifest = this.manifest(input, digest);
    const raw = this.serialize(manifest, input.body);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, raw, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    return this.ref(input.kind, input.record_id, input.version, path, digest, input.body, title, input.scope);
  }

  writeSync(input: ContentWriteInput): ContentRef {
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("Content version must be a positive integer");
    validateContentBody(input.body);
    const title = contentTitle(input.body, input.title, input.record_id);
    const path = this.namedPathFor(input.kind, input.record_id, input.version, title, input.folder, input.scope, input.project_root); mkdirSync(resolve(path, ".."), { recursive: true });
    const digest = bodyDigest(input.body);
    const existingPath = existsSync(path) ? path : this.findCanonicalPath(input.kind, input.record_id, input.version, input.scope, input.project_root);
    try {
      const existing = parseDocument(readFileSync(existingPath ?? path, "utf8"));
      if (existing.manifest.record_id !== input.record_id || existing.manifest.record_kind !== input.kind) throw new Error("Content file identity conflict");
      if (existing.manifest.body_digest === digest && existing.manifest.record_version === input.version) return this.ref(input.kind, input.record_id, input.version, existingPath!, digest, input.body, existing.manifest.title ?? title, input.scope);
      throw new Error("Content version already exists with different body");
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|no such file/iu.test(error.message)) throw error;
    }
    const raw = this.serialize(this.manifest(input, digest), input.body);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, raw, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, path);
    return this.ref(input.kind, input.record_id, input.version, path, digest, input.body, title, input.scope);
  }

  /** Replace the body of an existing canonical document without changing its
   * identity or version. This is reserved for source-aware migrations: normal
   * domain writes remain append-only and must create a new record version. */
  rewriteSync(input: ContentWriteInput): ContentRef {
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("Content version must be a positive integer");
    validateContentBody(input.body);
    const title = contentTitle(input.body, input.title, input.record_id);
    const currentPath = input.current_path ?? this.findCanonicalPath(input.kind, input.record_id, input.version, input.scope, input.project_root) ?? this.pathFor(input.kind, input.record_id, input.version, input.folder, input.scope, input.project_root);
    // Ordinary rewrites preserve the current path; source-aware migrations may
    // explicitly pass current_path to opt into a semantic filename rename.
    const path = input.current_path ? this.namedPathFor(input.kind, input.record_id, input.version, title, input.folder ?? this.folderOf(input.kind, currentPath), input.scope, input.project_root, currentPath) : currentPath;
    const existing = parseDocument(readFileSync(currentPath, "utf8"));
    if (existing.manifest.record_id !== input.record_id || existing.manifest.record_kind !== input.kind
      || existing.manifest.record_version !== input.version) throw new Error("Content rewrite identity conflict");
    const digest = bodyDigest(input.body);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, this.serialize(this.manifest(input, digest), input.body), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    if (resolve(currentPath) !== resolve(path)) unlinkSync(currentPath);
    return this.ref(input.kind, input.record_id, input.version, path, digest, input.body, title, input.scope);
  }

  async read(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "digest" | "scope">): Promise<ContentReadResult> {
    if (!this.isCanonicalRef(ref)) throw new Error("Content reference path is outside the canonical directory");
    const result = await this.readPath(ref.path);
    if (result.manifest.record_id !== ref.record_id || result.manifest.record_kind !== ref.kind || result.manifest.record_version !== ref.version
      || ref.scope !== undefined && result.manifest.scope !== ref.scope) throw new Error("Content reference metadata drifted");
    if (result.manifest.body_digest !== ref.digest || bodyDigest(result.body) !== ref.digest) throw new Error("Content body digest drifted");
    return result;
  }

  readSync(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "digest" | "scope">): ContentReadResult {
    if (!this.isCanonicalRef(ref)) throw new Error("Content reference path is outside the canonical directory");
    const result = parseDocument(readFileSync(ref.path, "utf8"));
    if (result.manifest.record_id !== ref.record_id || result.manifest.record_kind !== ref.kind || result.manifest.record_version !== ref.version
      || ref.scope !== undefined && result.manifest.scope !== ref.scope) throw new Error("Content reference metadata drifted");
    if (result.manifest.body_digest !== ref.digest || bodyDigest(result.body) !== ref.digest) throw new Error("Content body digest drifted");
    return result;
  }

  /** Read a reference from the current location or the pre-v0.12.31 content
   * tree. Legacy reads are still digest-checked and are only a compatibility
   * bridge for migration; new writes always use the canonical domain path. */
  readCompatSync(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "digest" | "scope">, expectedScope?: string): ContentReadResult {
    const scopedRef = ref.scope === undefined && expectedScope ? { ...ref, scope: expectedScope } : ref;
    if (this.isCanonicalRef(scopedRef)) return this.readSync(scopedRef);
    const globalDirectory = resolve(this.directory(ref.kind));
    const target = resolve(scopedRef.path);
    const isLegacySharedProjectRef = (scopedRef.kind === "knowledge" || scopedRef.kind === "memory") && scopedRef.scope?.startsWith("project:")
      && (target === globalDirectory || target.startsWith(`${globalDirectory}${sep}`));
    if (!isLegacySharedProjectRef && target !== resolve(this.legacyPathFor(scopedRef.kind, scopedRef.record_id, scopedRef.version))) {
      throw new Error("Content reference path is outside the canonical directory");
    }
    const result = parseDocument(readFileSync(scopedRef.path, "utf8"));
    if (result.manifest.record_id !== scopedRef.record_id || result.manifest.record_kind !== scopedRef.kind || result.manifest.record_version !== scopedRef.version
      || scopedRef.scope !== undefined && result.manifest.scope !== scopedRef.scope) throw new Error("Content reference metadata drifted");
    if (result.manifest.body_digest !== scopedRef.digest || bodyDigest(result.body) !== scopedRef.digest) throw new Error("Content body digest drifted");
    return result;
  }

  readUncheckedSync(path: string): ContentReadResult { return parseDocument(readFileSync(path, "utf8")); }

  async verify(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "digest" | "scope">): Promise<ContentVerification> {
    try { await this.read(ref); return { status: "verified", path: ref.path, digest: ref.digest }; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: /ENOENT|no such file/iu.test(message) ? "missing" : "drifted", path: ref.path, digest: null };
    }
  }

  verifySync(ref: Pick<ContentRef, "kind" | "record_id" | "version" | "path" | "digest" | "scope">): ContentVerification {
    try { this.readSync(ref); return { status: "verified", path: ref.path, digest: ref.digest }; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: /ENOENT|no such file/iu.test(message) ? "missing" : "drifted", path: ref.path, digest: null };
    }
  }

  private async readPath(path: string): Promise<ContentReadResult> { return parseDocument(await readFile(path, "utf8")); }

  private findCanonicalPath(kind: ContentKind, recordId: string, version: number, scope?: string, projectRoot?: string): string | null {
    const directory = this.directory(kind, undefined, scope, projectRoot, undefined, true);
    try {
      const suffix = `--${idSuffix(recordId)}.v${version}.md`;
      for (const path of this.files(directory, kind === "experience")) {
        if (!path.endsWith(suffix)) continue;
        try {
          const manifest = parseDocument(readFileSync(path, "utf8")).manifest;
          if (manifest.record_kind === kind && manifest.record_version === version) return path;
          return path;
        } catch {
          // A matching filename is still returned so callers fail closed on malformed metadata.
          return path;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private files(directory: string, recursive: boolean): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile()) result.push(path);
      else if (recursive && entry.isDirectory()) result.push(...this.files(path, true));
    }
    return result;
  }

  private manifest(input: ContentWriteInput, digest: string): ContentManifest {
    const base: ContentManifest = { schema_version: "craft.content.v1", record_kind: input.kind, record_id: input.record_id,
      record_version: input.version, scope: input.scope, status: input.status, sensitivity: input.sensitivity, source_id: input.source_id,
      body_digest: digest, updated_at: new Date().toISOString(), title: contentTitle(input.body, input.title, input.record_id) };
    const protectedFields = new Set(Object.keys(base));
    for (const [key, value] of Object.entries(input.frontmatter ?? {})) {
      if (!/^[a-z][a-z0-9_]*$/u.test(key) || protectedFields.has(key)) throw new Error("Content frontmatter key is invalid or reserved");
      if (typeof value === "string" && SECRET.test(value)) throw new Error("Content frontmatter must not contain credentials or secrets");
      base[key] = value;
    }
    return base;
  }

  private ref(kind: ContentKind, recordId: string, version: number, path: string, digest: string, body: string, title: string, scope: string): ContentRef {
    return { kind, record_id: recordId, version, path, digest, bytes: Buffer.byteLength(body, "utf8"), format: "markdown", title, scope };
  }

  private serialize(manifest: ContentManifest, body: string): string {
    const lines = Object.entries(manifest).map(([key, value]) => `${key}: ${typeof value === "number" || typeof value === "boolean" ? value : quote(String(value))}`);
    return `---\n${lines.join("\n")}\n---\n${body}`;
  }

  private directory(kind: ContentKind, folder?: ExperienceFolder, scope?: string, projectRoot?: string, referencePath?: string, writing = false): string {
    if (kind === "knowledge" || kind === "memory") {
      if (folder !== undefined) throw new Error("Only Experience content supports folders");
      if (kind === "memory" && scope?.startsWith("project:")) {
        const projectDirectory = this.#projectMemoryDirectory?.(scope, {
          ...(projectRoot ? { project_root: projectRoot } : {}), ...(referencePath ? { reference_path: referencePath } : {}), ...(writing ? { create: true } : {}),
        });
        if (projectDirectory) return projectDirectory;
        if (writing && this.#projectMemoryDirectory) throw new Error("Project Memory scope has no registered project root");
      }
      if (kind === "memory" && scope?.startsWith("session:")) {
        const sessionId = scope.slice("session:".length);
        if (!sessionId || sessionId.trim() !== sessionId || sessionId === "." || sessionId === ".." || /[/\\\x00-\x1f\x7f]/u.test(sessionId)
          || Buffer.byteLength(sessionId, "utf8") > 255) throw new Error("session_id must be one bounded, safe directory name");
        return join("/tmp", ".craft_data", "memory", sessionId, "md");
      }
      if (kind === "knowledge" && scope?.startsWith("project:")) {
        const projectDirectory = this.#projectKnowledgeDirectory?.(scope, {
          ...(projectRoot ? { project_root: projectRoot } : {}), ...(referencePath ? { reference_path: referencePath } : {}), ...(writing ? { create: true } : {}),
        });
        if (projectDirectory) return projectDirectory;
        if (writing && this.#projectKnowledgeDirectory) throw new Error("Project Knowledge scope has no registered project root");
      }
      return kind === "knowledge" ? this.paths.knowledgeContentDir : this.paths.memoryContentDir;
    }
    if (folder === undefined) return this.paths.experienceContentDir;
    if (!["workflows", "graphs", "prompts"].includes(folder)) throw new Error("Experience content folder is unsupported");
    return join(this.paths.experienceContentDir, folder);
  }

  private folderOf(kind: ContentKind, path: string): ExperienceFolder | undefined {
    if (kind !== "experience") return undefined;
    const relative = resolve(path).slice(resolve(this.paths.experienceContentDir).length + 1).split(/[\\/]/u)[0];
    return relative === "workflows" || relative === "graphs" || relative === "prompts" ? relative : undefined;
  }
}

export function contentReference(value: unknown): value is ContentRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (item.kind === "knowledge" || item.kind === "memory" || item.kind === "experience") && typeof item.record_id === "string" && Number.isSafeInteger(item.version)
    && typeof item.path === "string" && typeof item.digest === "string" && item.format === "markdown";
}
