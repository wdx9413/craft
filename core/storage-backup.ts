import { RecordFileStore } from "craft-common-store-local/record-files";
import { contentReference } from "craft-common-store-local/content-store";
import { catalogOwner, ensureOwnedLayoutFence, ownedCatalogFile, STORAGE_OWNERS, type StorageOwner } from "./infrastructure/owned-catalog.ts";
import { procedureDefinitionReference } from "./owner-history-archive.ts";
import { rebaseOwnedHistory } from "./owner-history-rebase.ts";
import { createHash } from "node:crypto";
import { createReadStream, realpathSync, lstatSync, readFileSync } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

// Resolve existing ancestors so /tmp and /private/tmp locators name the same authority.
function authorityPath(value: string): string {
  let path = resolve(value);
  const missing: string[] = [];
  while (!lstatSync(path, { throwIfNoEntry: false })) { missing.unshift(basename(path)); path = dirname(path); }
  return join(realpathSync(path), ...missing);
}

export type Entry = { path: string; bytes: number; digest: string; kind: "sqlite" | "file" };
type ExternalReference = { owner: string; storage_kind: "content" | "definition"; record_id: string; version: number; digest: string; scope?: string };
export type Manifest = { schema: "craft.storage-backup.v1"; source_root: string; entries: Entry[]; owner?: StorageOwner; external_references?: ExternalReference[]; relocation?: ReturnType<typeof rebaseOwnedHistory> };
const MANIFEST = "craft-storage-backup.json";
const MANIFEST_PAGE_ITEMS = 1000;
const MANIFEST_PAGE_BYTES = 1024 * 1024;
type EntryChunk = { path: string; count: number; bytes: number; digest: string };
type PagedManifest = Omit<Manifest, "schema" | "entries"> & { schema: "craft.storage-backup.v2"; entry_count: number; entry_chunks: EntryChunk[] };
const manifestChunks = new WeakMap<Entry[], readonly EntryChunk[]>();
function safeEntry(entry: Entry, seen?: Set<string>): void {
  if (!entry || typeof entry.path !== "string" || !entry.path || isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.split("/").some(part => !part || part === "." || part === "..")
    || seen?.has(entry.path) || !["sqlite", "file"].includes(entry.kind) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.digest)) throw new Error("Unsafe backup manifest entry");
}
function pagedEntries(root: string, header: PagedManifest): Entry[] {
  if (!Number.isSafeInteger(header.entry_count) || header.entry_count < 1 || !Array.isArray(header.entry_chunks)) throw new Error("Invalid paged backup manifest");
  let total = 0;
  for (const [index, chunk] of header.entry_chunks.entries()) {
    if (!chunk || chunk.path !== `manifest-entries/${index}.json` || !Number.isSafeInteger(chunk.count) || chunk.count < 1 || chunk.count > MANIFEST_PAGE_ITEMS
      || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 2 || chunk.bytes > MANIFEST_PAGE_BYTES || !/^[a-f0-9]{64}$/u.test(chunk.digest)) throw new Error("Invalid backup manifest chunk");
    total += chunk.count;
  }
  if (total !== header.entry_count) throw new Error("Backup manifest count mismatch");
  let cached = -1, page: Entry[] = [];
  const boundaries: number[] = []; let end = 0;
  for (const chunk of header.entry_chunks) { boundaries.push(end); end += chunk.count; }
  const valueAt = (offset: number): Entry => {
    let low = 0, high = boundaries.length - 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (boundaries[middle]! <= offset) low = middle; else high = middle - 1; }
    if (cached !== low) {
      const chunk = header.entry_chunks[low]!, path = join(root, chunk.path), stat = lstatSync(path);
      if (!stat.isFile() || stat.size !== chunk.bytes || !lstatSync(dirname(path)).isDirectory()) throw new Error("Invalid backup manifest chunk file");
      const bytes = readFileSync(path);
      if (createHash("sha256").update(bytes).digest("hex") !== chunk.digest) throw new Error("Backup manifest chunk digest mismatch");
      page = JSON.parse(bytes.toString("utf8")) as Entry[];
      if (!Array.isArray(page) || page.length !== chunk.count) throw new Error("Backup manifest chunk count mismatch");
      page.forEach(entry => safeEntry(entry)); cached = low;
    }
    return page[offset - boundaries[low]!]!;
  };
  const entries = new Proxy(new Array<Entry>(total), {
    get(target, key, receiver) { return typeof key === "string" && /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < total ? valueAt(Number(key)) : Reflect.get(target, key, receiver); },
    has(target, key) { return typeof key === "string" && /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < total || Reflect.has(target, key); },
  });
  manifestChunks.set(entries, header.entry_chunks);
  return entries;
}

/** Read legacy manifests or expose large manifests through a one-page Array-compatible view. */
export async function readStorageBackupManifest(root: string): Promise<Manifest> {
  const path = join(root, MANIFEST), stat = await lstat(path);
  if (!stat.isFile()) throw new Error("Backup manifest must be a regular file");
  if (stat.size > 16 * 1024 * 1024) throw new Error("Backup manifest exceeds its size budget");
  let raw: Manifest | PagedManifest;
  try { raw = JSON.parse(await readFile(path, "utf8")) as Manifest | PagedManifest; }
  catch { throw new Error("Invalid storage backup manifest JSON"); }
  if (!raw || typeof raw !== "object") throw new Error("Invalid storage backup manifest");
  if (raw.schema === "craft.storage-backup.v2") return { ...raw, schema: "craft.storage-backup.v1", entries: pagedEntries(root, raw) };
  if (raw.schema !== "craft.storage-backup.v1" || !Array.isArray(raw.entries)) throw new Error("Invalid storage backup manifest");
  return raw;
}

/** Publish a bounded-page manifest; small archives retain the byte-compatible v1 layout. */
export async function writeStorageBackupManifest(root: string, metadata: Omit<Manifest, "entries">, input: AsyncIterable<Entry> | Iterable<Entry>): Promise<Manifest> {
  const chunks: EntryChunk[] = [];
  let page: Entry[] = [], pageBytes = 2, count = 0;
  const flush = async () => {
    const content = JSON.stringify(page), path = `manifest-entries/${chunks.length}.json`;
    await mkdir(join(root, "manifest-entries"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), content, { flag: "wx", mode: 0o600 });
    chunks.push({ path, count: page.length, bytes: Buffer.byteLength(content), digest: createHash("sha256").update(content).digest("hex") });
    page = []; pageBytes = 2;
  };
  for await (const entry of input) {
    safeEntry(entry);
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes + 2 > MANIFEST_PAGE_BYTES) throw new Error("Backup manifest entry exceeds its page budget");
    if (page.length && (page.length === MANIFEST_PAGE_ITEMS || pageBytes + bytes > MANIFEST_PAGE_BYTES)) await flush();
    page.push(entry); pageBytes += bytes; count++;
  }
  if (!chunks.length) {
    const manifest = { ...metadata, entries: page };
    await writeFile(join(root, MANIFEST), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 }); return manifest;
  }
  if (page.length) await flush();
  const header: PagedManifest = { ...metadata, schema: "craft.storage-backup.v2", entry_count: count, entry_chunks: chunks };
  await writeFile(join(root, MANIFEST), JSON.stringify(header), { flag: "wx", mode: 0o600 });
  return { ...metadata, entries: pagedEntries(root, header) };
}
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
async function sha(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function files(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Storage backup rejects symbolic links");
    if (info.isDirectory()) for (const item of await files(root, path)) result.push(item);
    else if (info.isFile()) result.push(relative(root, path).split(sep).join("/"));
    else throw new Error("Storage backup requires regular files");
  }
  return result;
}
function dataFiles(paths: string[]): string[] {
  const names = new Set(paths);
  return paths.filter(path => !["-wal", "-shm", "-journal"].some(suffix => path.endsWith(suffix) && names.has(path.slice(0, -suffix.length))));
}
async function targetPath(source: string, output: string): Promise<string> {
  if (!isAbsolute(output)) throw new Error("Backup output must be absolute");
  const target = join(await realpath(dirname(output)), basename(output));
  if (inside(source, target) || inside(target, source)) throw new Error("Backup and restore output must be outside the source tree");
  await mkdir(target, { mode: 0o700 }); // EEXIST refuses all existing destinations.
  return target;
}
async function checkDatabase(path: string): Promise<void> {
  const db = new DatabaseSync(path, { readOnly: true });
  try { if (db.prepare("PRAGMA quick_check").get()!.quick_check !== "ok") throw new Error("Backup database integrity check failed"); }
  finally { db.close(); }
}

/** Preserve one owner's entire catalog plus every typed authoritative body reference. */
export async function backupOwnerStorage(dataRoot: string, owner: StorageOwner, output: string): Promise<Manifest> {
  if (!STORAGE_OWNERS.includes(owner)) throw new Error("Unknown storage owner");
  return backupData(dataRoot, output, owner);
}

export async function backupStorage(dataRoot: string, output: string): Promise<Manifest> {
  return backupData(dataRoot, output);
}

async function ownerInventory(root: string, owner: StorageOwner, initial: string[]): Promise<{ paths: string[]; external_references: ExternalReference[] }> {
  if (catalogOwner(join(root, owner)) !== owner) throw new Error("Owner backup requires its matching catalog marker");
  if (!initial.includes(`${owner}/publication.db`)) throw new Error("Owner backup publication catalog is missing");
  const external = new Map<string, ExternalReference>();
  const available = new Set(initial);
  const selected = new Set(initial.filter(path => path.startsWith(`${owner}/`)));
  const catalog = ownedCatalogFile(root, owner);
  const payloads = new RecordFileStore(root, dirname(catalog));
  const evaluationFiles = new Map<string, string[]>();
  if (owner === "eval") for (const name of initial) {
    const match = /^evaluations\/([^/]+)\//u.exec(name);
    if (!match) continue;
    const group = evaluationFiles.get(match[1]!) ?? [];
    group.push(name); evaluationFiles.set(match[1]!, group);
  }
  const snapshotFiles = new Map<string, string[]>();
  if (owner === "codebase" || owner === "runtime") for (const name of initial) {
    const match = /^(projects\/[^/]+\/codebase\/snapshots\/[^/]+\/[^/]+)\//u.exec(name);
    if (!match) continue;
    const key = match[1]!;
    const group = snapshotFiles.get(key) ?? []; group.push(name); snapshotFiles.set(key, group);
  }
  const checkpointAuthority = (payload: Record<string, unknown>): void => {
    if (typeof payload.snapshot_root !== "string") return;
    const path = authorityPath(payload.snapshot_root), name = relative(root, path).split(sep).join("/");
    if (!inside(root, path) || !/^projects\/[^/]+\/codebase\/snapshots\/[^/]+\/[^/]+$/u.test(name)) throw new Error("Checkpoint backup authority must remain in its managed snapshots directory");
    const referenced = snapshotFiles.get(name);
    if (!referenced?.length && Array.isArray(payload.entries) && payload.entries.length) throw new Error("Checkpoint backup authoritative directory is missing");
    for (const file of referenced ?? []) selected.add(file);
  };

  const evaluationAuthority = (payload: Record<string, unknown>): void => {
    for (const field of ["report_root", "run_directory"]) {
      if (typeof payload[field] !== "string") continue;
      const path = authorityPath(payload[field]);
      if (!path.startsWith(join(root, "evaluations") + sep)) throw new Error("Eval backup authority must remain in its managed evaluations directory");
      const name = relative(root, path).split(sep).join("/");
      const group = evaluationFiles.get(name.split("/")[1]!) ?? [];
      const referenced = group.filter(file => file.startsWith(name + "/"));
      if (!referenced.length && payload.state === "completed") throw new Error("Eval backup authoritative directory is missing");
      for (const file of referenced) selected.add(file);
    }
  };
  const visit = (value: unknown): void => {
    if (contentReference(value) || procedureDefinitionReference(value)) {
      const content = contentReference(value);
      if (content ? value.kind !== owner : owner !== "experience") {
        const ref: ExternalReference = content
          ? { owner: value.kind, storage_kind: "content", record_id: value.record_id, version: value.version, digest: value.digest, scope: value.scope }
          : { owner: "experience", storage_kind: "definition", record_id: value.procedure_id, version: value.procedure_version, digest: value.digest, ...(value.scope ? { scope: value.scope } : {}) };
        external.set(JSON.stringify(ref), ref); return;
      }
      const path = authorityPath(value.path);
      if (!inside(root, path)) throw new Error("Owner backup authority must remain inside its data root");
      const name = relative(root, path).split(sep).join("/");
      if (!available.has(name)) throw new Error("Owner backup authoritative reference is missing");
      selected.add(name);
      return;
    }
    if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === "object") for (const item of Object.values(value)) visit(item);
  };
  for (const path of [...selected].filter(path => /\.(db|sqlite|sqlite3)$/iu.test(path))) {
    const database = new DatabaseSync(join(root, path), { readOnly: true });
    try {
      if (path === `${owner}/publication.db` && !database.prepare("SELECT 1 FROM meta WHERE key='owner_records' AND value='v1'").get()) throw new Error("Owner backup requires verified owner-record storage");
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'").get()) {
        for (const row of database.prepare("SELECT kind,id,version,payload_json FROM records").iterate()) {
          const payload = payloads.payload(String(row.kind), String(row.id), Number(row.version), JSON.parse(String(row.payload_json)));
          visit(payload);
          if (owner === "eval" && row.kind === "workbench_evaluation") evaluationAuthority(payload);
          if ((owner === "codebase" || owner === "runtime") && row.kind === "workspace_checkpoint") checkpointAuthority(payload);
        }
      }
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) {
        for (const row of database.prepare("SELECT stream,sequence,event_type,payload_json FROM events").iterate()) visit(payloads.payload(`event:${row.event_type}`, String(row.stream), Number(row.sequence), JSON.parse(String(row.payload_json))));
      }
    } finally { database.close(); }
  }
  return { paths: [...selected].sort(), external_references: [...external.values()] };
}

/** Maintenance operation: all discovered databases are writer-fenced before any copying. */
async function backupData(dataRoot: string, output: string, owner?: StorageOwner): Promise<Manifest> {
  if ((await lstat(dataRoot)).isSymbolicLink()) throw new Error("Storage root must be a regular directory");
  const source = await realpath(dataRoot);
  const initial = dataFiles(await files(source));
  if (initial.includes(MANIFEST)) throw new Error("Storage root already contains a backup manifest");
  const guards: DatabaseSync[] = [];
  let target: string | undefined;
  try {
    for (const path of initial.filter(path => /\.(db|sqlite|sqlite3)$/iu.test(path))) {
      const db = new DatabaseSync(join(source, path));
      guards.push(db); db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    }
    const selection = owner ? await ownerInventory(source, owner, initial) : { paths: initial, external_references: [] };
    target = await targetPath(source, output);
    const destinationRoot = target;
    const copiedBodies = new Map<string, string>();
    const entries = async function* (): AsyncGenerator<Entry> {
      for (const path of selection.paths) {
        const input = join(source, path), destination = join(destinationRoot, path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const kind = /\.(db|sqlite|sqlite3)$/iu.test(path) ? "sqlite" : "file";
        if (kind === "sqlite") {
          const reader = new DatabaseSync(input, { readOnly: true });
          try { await backup(reader, destination); } finally { reader.close(); }
          const snapshot = new DatabaseSync(destination);
          try { snapshot.exec("PRAGMA journal_mode=DELETE"); } finally { snapshot.close(); }
          await checkDatabase(destination);
        } else {
          const before = await sha(input);
          const previous = copiedBodies.get(before);
          if (previous) await link(previous, destination); else { await copyFile(input, destination); copiedBodies.set(before, destination); }
          if (before !== await sha(destination) || before !== await sha(input)) throw new Error("Storage file changed during backup");
        }
        yield { path, bytes: (await lstat(destination)).size, digest: await sha(destination), kind };
      }
    };
    const manifest = await writeStorageBackupManifest(target, { schema: "craft.storage-backup.v1", source_root: resolve(dataRoot), ...(owner ? { owner, external_references: selection.external_references } : {}) }, entries());
    if (JSON.stringify(initial) !== JSON.stringify(dataFiles(await files(source)))) throw new Error("Storage inventory changed during backup");
    for (const entry of manifest.entries) if (entry.kind === "file" && await sha(join(source, entry.path)) !== entry.digest) throw new Error("Storage file changed during backup");
    return manifest;
  } catch (error) { if (target) await rm(target, { recursive: true, force: true }); throw error; }
  finally { for (const db of guards.reverse()) { try { db.exec("ROLLBACK"); } catch { /* BEGIN may have failed. */ } db.close(); } }
}

export async function restoreStorage(archiveRoot: string, output: string): Promise<Manifest> {
  if ((await lstat(archiveRoot)).isSymbolicLink()) throw new Error("Backup root must be a regular directory");
  const source = await realpath(archiveRoot);
  const manifest = await readStorageBackupManifest(source);
  if (manifest.external_references !== undefined && (!Array.isArray(manifest.external_references) || manifest.external_references.length > 100_000 || manifest.external_references.some(ref => !ref || !STORAGE_OWNERS.includes(ref.owner as StorageOwner) || !["content", "definition"].includes(ref.storage_kind) || typeof ref.record_id !== "string" || !Number.isSafeInteger(ref.version) || typeof ref.digest !== "string"))) throw new Error("Invalid backup external references");
  if (manifest.owner !== undefined && !STORAGE_OWNERS.includes(manifest.owner)) throw new Error("Invalid backup owner");
  const actual = await files(source), expected = new Set<string>([MANIFEST, ...(manifestChunks.get(manifest.entries) ?? []).map(chunk => chunk.path)]);
  for (const entry of manifest.entries) {
    safeEntry(entry, expected);
    expected.add(entry.path);
  }
  if (actual.length !== expected.size || actual.some(path => !expected.has(path))) throw new Error("Backup inventory does not match its manifest");
  if (manifest.owner && manifest.entries.some(entry => STORAGE_OWNERS.some(owner => owner !== manifest.owner && entry.path === `${owner}/publication.db`))) throw new Error("Owner backup contains another publication catalog");
  let target: string | undefined;
  try {
    target = await targetPath(source, output);
    const restoredBodies = new Map<string, string>();
    for (const entry of manifest.entries) {
      const input = join(source, entry.path), destination = join(target, entry.path);
      if ((await lstat(input)).size !== entry.bytes || await sha(input) !== entry.digest) throw new Error("Backup content digest mismatch");
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const previous = entry.kind === "file" ? restoredBodies.get(entry.digest) : undefined;
      if (previous) await link(previous, destination); else { await copyFile(input, destination); if (entry.kind === "file") restoredBodies.set(entry.digest, destination); }
      if (await sha(destination) !== entry.digest) throw new Error("Restored content digest mismatch");
      if (entry.kind === "sqlite") await checkDatabase(destination);
    }
    if (manifest.owner && catalogOwner(join(target, manifest.owner)) !== manifest.owner) throw new Error("Restored owner catalog marker is missing or mismatched");
    if (manifest.owner) {
      const relocation = rebaseOwnedHistory(target, resolve(output), manifest.source_root);
      ensureOwnedLayoutFence(target);
      return { ...manifest, relocation };
    }
    return manifest;
  } catch (error) { if (target) await rm(target, { recursive: true, force: true }); throw error; }
}
