import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TOKEN = /\[CRAFT_DATASEC_[a-z0-9_]+_[a-f0-9]{32}\]/g;
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()) throw new Error("Unsafe vault directory");
}
function openPrivate(path: string, flags = constants.O_RDONLY): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()) throw new Error("Unsafe vault file");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function readPrivate(path: string): Buffer {
  const fd = openPrivate(path);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
/** Publish a complete immutable record. Readers never see a half-written key or mapping. */
function publish(directory: string, name: string, value: Buffer | string): void {
  const temp = mkdtempSync(join(directory, ".write-"));
  try {
    const source = join(temp, "record");
    writeFileSync(source, value, { mode: 0o600 });
    try { linkSync(source, join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
export class TokenVault {
  private readonly directory: string;
  private readonly key: Buffer;
  private readonly database: DatabaseSync;
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<string, { name: string; value: string }>();
  private closed = false;
  constructor(root: string, session: string) {
    if (!session) throw new Error("Missing session identity");
    privateDirectory(root);
    this.directory = join(root, createHash("sha256").update(session).digest("hex"));
    privateDirectory(this.directory);
    publish(this.directory, "key", randomBytes(32));
    this.key = readPrivate(join(this.directory, "key"));
    if (this.key.length !== 32) throw new Error("Invalid vault key");
    const file = join(this.directory, "mappings.sqlite");
    closeSync(openPrivate(file, constants.O_CREAT | constants.O_RDWR));
    this.database = new DatabaseSync(file);
    try {
      // Keep SQLite's rollback journal: changing journal_mode during simultaneous
      // first opens can return SQLITE_BUSY before ordinary transaction retries.
      this.database.exec("PRAGMA busy_timeout=1500; CREATE TABLE IF NOT EXISTS mappings (token TEXT PRIMARY KEY, name TEXT NOT NULL, value TEXT NOT NULL) STRICT;");
    } catch (error) { this.database.close(); throw error; }
  }
  token(name: string, value: string): string {
    const cacheKey = `${name}\0${value}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const digest = createHmac("sha256", this.key).update(`${name}\0${value}`).digest("hex").slice(0, 32);
    const token = `[CRAFT_DATASEC_${name}_${digest}]`;
    this.pending.set(token, { name, value });
    this.cache.set(cacheKey, token);
    return token;
  }
  /** One transaction per hook output, rather than a filesystem write per occurrence. */
  flush(): void {
    if (!this.pending.size) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.database.prepare("INSERT OR IGNORE INTO mappings VALUES (?, ?, ?)");
      for (const [token, record] of this.pending) insert.run(token, record.name, record.value);
      this.database.exec("COMMIT");
      this.pending.clear();
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  close(): void {
    if (!this.closed) { this.database.close(); this.closed = true; }
  }
  restore(text: string): string {
    const restored = text.replace(TOKEN, token => {
      const record = this.pending.get(token) ?? this.database.prepare("SELECT name, value FROM mappings WHERE token = ?").get(token) as { name: string; value: string } | undefined;
      if (!record) throw new Error("Unknown mapping");
      const expected = `[CRAFT_DATASEC_${record.name}_${createHmac("sha256", this.key).update(`${record.name}\0${record.value}`).digest("hex").slice(0, 32)}]`;
      if (expected !== token) throw new Error("Invalid mapping");
      return record.value;
    });
    // Reject truncated/edited placeholders instead of silently writing them into a source file.
    if (restored.includes("[CRAFT_DATASEC_")) throw new Error("Unknown placeholder");
    return restored;
  }
}
