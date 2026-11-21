import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STORAGE_OWNERS = ["knowledge", "memory", "experience", "codebase", "notes", "eval", "context", "runtime"] as const;

export type StorageOwner = typeof STORAGE_OWNERS[number];

function markerFile(root: string): string {
  return join(root, ".craft-storage-owner");
}

export function ownedCatalogFile(root: string, owner: StorageOwner): string {
  return join(root, owner, "publication.db");
}

export function catalogOwner(root: string): StorageOwner | undefined {
  const marker = markerFile(root);
  const stat = lstatSync(marker, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.size > 64) throw new Error("Storage owner marker is invalid");
  const value = readFileSync(marker, "utf8");
  const owner = STORAGE_OWNERS.find(item => value === `v1:${item}\n`);
  if (!owner) throw new Error("Storage owner marker is invalid");
  return owner;
}

export function presentStorageOwners(root: string): StorageOwner[] {
  return STORAGE_OWNERS.filter(owner => lstatSync(ownedCatalogFile(root, owner), { throwIfNoEntry: false }));
}

/** A complete marker must become visible before the first write to the catalog. */
export function initializeOwnedCatalog(root: string, owner: StorageOwner): void {
  ensureOwnedLayoutFence(root);
  const directory = join(root, owner);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.craft-storage-owner.${randomUUID()}.tmp`);
  writeFileSync(temporary, `v1:${owner}\n`, { flag: "wx", mode: 0o600 });
  try {
    try { linkSync(temporary, markerFile(directory)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (catalogOwner(directory) !== owner) throw new Error("Capability initialization owner conflict");
    }
  } finally {
    unlinkSync(temporary);
  }
}

type OwnedLayout = { schema?: string; archive_digest?: string; layout_id?: string };
function layoutIdentity(root: string, layout: OwnedLayout): string | undefined {
  if (layout.schema === "craft.owned-layout.v1" && typeof layout.layout_id === "string") return layout.layout_id;
  if (layout.schema === "craft.owner-cutover.v1" && typeof layout.archive_digest === "string"
    && existsSync(join(root, ".craft-history-import")) && readFileSync(join(root, ".craft-history-import"), "utf8") === layout.archive_digest) return layout.archive_digest;
  return undefined;
}

/** Directory tombstones make old binaries fail before they can recreate shared SQLite. */
export function ensureOwnedLayoutFence(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = join(root, ".craft-storage-layout.json");
  if (!existsSync(marker)) {
    const temporary = `${marker}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schema: "craft.owned-layout.v1", layout_id: randomUUID() }), { flag: "wx", mode: 0o600 });
    try { linkSync(temporary, marker); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { unlinkSync(temporary); }
  }
  if (!lstatSync(marker).isFile()) throw new Error("Owned layout marker is invalid");
  const identity = layoutIdentity(root, JSON.parse(readFileSync(marker, "utf8")) as OwnedLayout);
  if (!identity) throw new Error("Owned layout marker is invalid");
  for (const path of [join(root, "db", "craft.db"), join(root, "craft.db")]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error("Shared database must be migrated before installing an owner fence");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const fence = join(path, ".craft-write-fence");
    if (!existsSync(fence)) {
      try { writeFileSync(fence, identity, { flag: "wx", mode: 0o400 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (!lstatSync(fence).isFile() || readFileSync(fence, "utf8") !== identity) throw new Error("Shared writer fence is invalid");
  }
}

export function hasSharedWriterFence(root: string): boolean {
  const marker = join(root, ".craft-storage-layout.json");
  if (!existsSync(marker) || !lstatSync(marker).isFile()) return false;
  const identity = layoutIdentity(root, JSON.parse(readFileSync(marker, "utf8")) as OwnedLayout);
  if (!identity) return false;
  return [join(root, "db", "craft.db"), join(root, "craft.db")].every(path => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    const fence = join(path, ".craft-write-fence");
    return stat?.isDirectory() && existsSync(fence) && lstatSync(fence).isFile() && readFileSync(fence, "utf8") === identity;
  });
}

/** Maintenance owns directory relocation; ordinary startup must never recreate a missing active root. */
export function assertStorageAvailable(root: string): void {
  const lock = `${root}.craft-cutover.lock`;
  const stat = lstatSync(lock, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.size > 1024) throw new Error("Storage maintenance lock is invalid");
  let value: unknown;
  try { value = JSON.parse(readFileSync(lock, "utf8")); } catch { throw new Error("Storage maintenance lock is invalid"); }
  if (!value || typeof value !== "object" || !("pid" in value) || !("token" in value)
    || !Number.isSafeInteger(value.pid) || typeof value.token !== "string" || !value.token) throw new Error("Storage maintenance lock is invalid");
  if (value.pid !== process.pid) throw new Error("Storage is under maintenance; recover or complete its cutover before startup");
}
