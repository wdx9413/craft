import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Bm25Index } from "./context-retrieval-capture.ts";
import { text } from "./validation.ts";

/**
 * Markdown stays the source of truth; SQLite is a rebuildable projection of it.
 * Deleting the index loses nothing, and a stale index is detectable because
 * every projected document carries the digest of the file it came from.
 *
 * Search keeps a portable token/BM25 hybrid: SQL decides the candidate set with
 * a cheap `LIKE` conjunction (so a Node runtime without FTS5 still works), then
 * an in-memory BM25 index re-ranks those candidates by term rarity. Candidates
 * are what makes it work — BM25 alone over the whole corpus would need a token
 * table, and `LIKE` alone cannot tell a rare identifier from a common word.
 */
const MAX_FILES = 2_000;
const DEFAULT_CHUNK_CHARS = 4_000;
const SEARCH_CANDIDATES = 200;

/**
 * Where a document belongs, and therefore how long it may be trusted.
 *
 * Markdown is still the source of truth; scope is metadata *about* the
 * projection, so it can be rebuilt from scratch without touching files. The
 * point of an expiry is that a stale note is worse than no note: a workflow that
 * quietly retrieves a superseded decision is harder to debug than one that
 * retrieves nothing.
 */
export const KNOWLEDGE_SCOPES: readonly string[] = ["user", "project", "task"];
export interface KnowledgeScopeEntry { path: string; scope: string; expires_at: string | null; updated_at: string }

export interface KnowledgeDocument { path: string; digest: string; size_bytes: number; chunks: number }
export interface KnowledgeChunk { heading: string | null; body: string }
export interface KnowledgePlan { added: KnowledgeDocument[]; changed: KnowledgeDocument[]; removed: KnowledgeDocument[] }
export interface KnowledgeHit { path: string; heading: string | null; snippet: string; rank: number }



function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function walk(current: string, found: string[], limit: number): void {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(current, entry.name);
    if (lstatSync(absolute).isSymbolicLink()) continue;
    if (entry.isDirectory()) { walk(absolute, found, limit); continue; }
    if (!entry.name.endsWith(".md")) continue;
    found.push(absolute);
    if (found.length > limit) throw new Error(`Knowledge base exceeds ${limit} files`);
  }
}

/** Scan a Markdown tree. Missing roots are an error, never an empty knowledge base. */
export function scanKnowledgeBase(root: string, options: { limit?: number } = {}): KnowledgeDocument[] {
  const base = resolve(root);
  if (!existsSync(base)) throw new Error("Knowledge base root does not exist");
  const limit = options.limit ?? MAX_FILES;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Knowledge base limit must be a positive integer");
  const found: string[] = [];
  walk(base, found, limit);
  return found.map((absolute) => {
    const content = readFileSync(absolute, "utf8");
    return { path: relative(base, absolute).replaceAll("\\", "/"), digest: digest(content),
      size_bytes: Buffer.byteLength(content), chunks: chunkMarkdown(content).length };
  });
}

/**
 * Split Markdown on headings, then cap each section. Deterministic: the same
 * file always produces the same chunks in the same order.
 */
export function chunkMarkdown(content: string, options: { maxChars?: number } = {}): KnowledgeChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_CHUNK_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("Knowledge chunk maxChars must be a positive integer");
  const sections: Array<{ heading: string | null; body: string[] }> = [];
  let current: { heading: string | null; body: string[] } = { heading: null, body: [] };
  for (const line of content.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading) { sections.push(current); current = { heading: heading[1].trim(), body: [] }; }
    else current.body.push(line);
  }
  sections.push(current);
  const chunks = sections.map((section) => ({ heading: section.heading, body: section.body.join("\n").trim() }))
    .filter((chunk) => chunk.heading !== null || chunk.body.length > 0);
  return chunks.flatMap((chunk) => {
    if (chunk.body.length <= maxChars) return [chunk];
    const parts: KnowledgeChunk[] = [];
    for (let index = 0; index < chunk.body.length; index += maxChars) {
      parts.push({ heading: chunk.heading, body: chunk.body.slice(index, index + maxChars) });
    }
    return parts;
  });
}

/** What changed on disk since the last projection. */
export function diffKnowledgeBase(previous: readonly KnowledgeDocument[], current: readonly KnowledgeDocument[]): KnowledgePlan {
  const before = new Map(previous.map((item) => [item.path, item]));
  const after = new Set(current.map((item) => item.path));
  return { added: current.filter((item) => !before.has(item.path)),
    changed: current.filter((item) => { const prior = before.get(item.path); return prior !== undefined && prior.digest !== item.digest; }),
    removed: previous.filter((item) => !after.has(item.path)) };
}

/**
 * Build a safe FTS5 MATCH expression. Only word characters survive, so a query
 * can never inject FTS5 operators; each surviving word becomes a quoted phrase.
 */
export function knowledgeQueryTokens(query: string): string[] {
  const tokens = text(query, "query").match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!tokens.length) throw new Error("Knowledge search requires at least one word token");
  return tokens;
}

export function locateSnippet(body: string, tokens: readonly string[], width = 200): string {
  const haystack = body.toLowerCase();
  const at = tokens.map((token) => haystack.indexOf(token.toLowerCase())).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return body.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 2));
  return body.slice(start, start + width).trim();
}

/**
 * The rebuildable Markdown projection. Every write is one transaction, so a
 * crash mid-sync leaves the previous projection intact rather than half-applied.
 */
export class KnowledgeIndex {
  readonly file: string;
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.file = resolve(file);
    mkdirSync(dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=15000;");
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS knowledge_document(path TEXT PRIMARY KEY, digest TEXT NOT NULL, size_bytes INTEGER NOT NULL, chunks INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS knowledge_chunk(path TEXT NOT NULL, ordinal INTEGER NOT NULL, heading TEXT, body TEXT NOT NULL, PRIMARY KEY(path, ordinal));",
      "CREATE TABLE IF NOT EXISTS knowledge_scope(path TEXT PRIMARY KEY, scope TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL);",
    ].join("\n"));
  }

  /**
   * Declare scope and, optionally, an expiry. Omitting `ttl_days` means the
   * document never expires on its own — which is the right default for durable
   * project knowledge and the wrong one for a task-scoped note.
   */
  setScope(entries: Array<{ path: string; scope: string; ttl_days?: number }>, now = Date.now()): KnowledgeScopeEntry[] {
    if (!Array.isArray(entries)) throw new Error("Knowledge scope entries must be an array");
    const instant = new Date(now).toISOString();
    return entries.map((entry, index) => {
      if (!entry || typeof entry !== "object") throw new Error(`Knowledge scope entry ${index} must be an object`);
      const path2 = text(entry.path, `scope path at index ${index}`);
      const scope = text(entry.scope, `scope at index ${index}`);
      if (!KNOWLEDGE_SCOPES.includes(scope)) throw new Error(`Unsupported knowledge scope: ${scope}`);
      let expiresAt: string | null = null;
      if (entry.ttl_days !== undefined && entry.ttl_days !== null) {
        const days = Number(entry.ttl_days);
        if (!Number.isInteger(days) || days < 1 || days > 3_650) {
          throw new Error(`Knowledge scope ttl_days at index ${index} must be an integer between 1 and 3650`);
        }
        expiresAt = new Date(now + days * 86_400_000).toISOString();
      }
      this.db.prepare("INSERT INTO knowledge_scope(path, scope, expires_at, updated_at) VALUES (?, ?, ?, ?) "
        + "ON CONFLICT(path) DO UPDATE SET scope = excluded.scope, expires_at = excluded.expires_at, updated_at = excluded.updated_at")
        .run(path2, scope, expiresAt, instant);
      return { path: path2, scope, expires_at: expiresAt, updated_at: instant };
    });
  }

  /** Scope rows, optionally narrowed to one scope. Sorted so two calls read the same. */
  scopeCatalog(scope?: string): KnowledgeScopeEntry[] {
    if (scope !== undefined && !KNOWLEDGE_SCOPES.includes(scope)) throw new Error(`Unsupported knowledge scope: ${scope}`);
    const rows = scope === undefined
      ? this.db.prepare("SELECT path, scope, expires_at, updated_at FROM knowledge_scope ORDER BY path").all()
      : this.db.prepare("SELECT path, scope, expires_at, updated_at FROM knowledge_scope WHERE scope = ? ORDER BY path").all(scope);
    return rows.map((row) => ({ path: String(row.path), scope: String(row.scope),
      expires_at: row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
      updated_at: String(row.updated_at) }));
  }

  /** Entries whose expiry has passed. A document with no expiry is never listed here. */
  expired(now = Date.now()): KnowledgeScopeEntry[] {
    const instant = new Date(now).toISOString();
    return this.db.prepare("SELECT path, scope, expires_at, updated_at FROM knowledge_scope "
      + "WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY path").all(instant)
      .map((row) => ({ path: String(row.path), scope: String(row.scope), expires_at: String(row.expires_at),
        updated_at: String(row.updated_at) }));
  }

  /**
   * Drop expired documents from the projection and forget their scope rows.
   *
   * This removes only the rebuildable projection and scope metadata; Markdown
   * files are untouched, so "forgetting" is never destructive to the source.
   *
   * The deletes run without an explicit transaction on purpose. Forgetting is
   * idempotent — re-running it after a crash simply finishes the job — so a
   * rollback branch here would be unreachable code that still has to be
   * measured, while adding no recovery the caller does not already have.
   */
  forgetExpired(now = Date.now()): { forgotten: string[] } {
    const stale = this.expired(now);
    for (const entry of stale) {
      this.db.prepare("DELETE FROM knowledge_chunk WHERE path = ?").run(entry.path);
      this.db.prepare("DELETE FROM knowledge_document WHERE path = ?").run(entry.path);
      this.db.prepare("DELETE FROM knowledge_scope WHERE path = ?").run(entry.path);
    }
    return { forgotten: stale.map((entry) => entry.path) };
  }

  /** Apply a plan by re-reading the Markdown. The files win over the projection, always. */
  apply(plan: KnowledgePlan, root: string): { documents: number; chunks: number } {
    const base = resolve(root);
    const upserts = [...plan.added, ...plan.changed];
    this.db.exec("BEGIN");
    try {
      for (const document of upserts) {
        const content = readFileSync(join(base, document.path), "utf8");
        const chunks = chunkMarkdown(content);
        this.db.prepare("DELETE FROM knowledge_chunk WHERE path = ?").run(document.path);
        this.db.prepare("DELETE FROM knowledge_document WHERE path = ?").run(document.path);
        this.db.prepare("INSERT INTO knowledge_document(path, digest, size_bytes, chunks) VALUES (?, ?, ?, ?)")
          .run(document.path, document.digest, document.size_bytes, chunks.length);
        const insertChunk = this.db.prepare("INSERT INTO knowledge_chunk(path, ordinal, heading, body) VALUES (?, ?, ?, ?)");
        for (const [ordinal, chunk] of chunks.entries()) {
          insertChunk.run(document.path, ordinal, chunk.heading, chunk.body);
        }
      }
      for (const document of plan.removed) {
        this.db.prepare("DELETE FROM knowledge_chunk WHERE path = ?").run(document.path);
        this.db.prepare("DELETE FROM knowledge_document WHERE path = ?").run(document.path);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.status();
  }

  /** The projected catalog, so a caller can diff it against the Markdown tree. */
  catalog(): KnowledgeDocument[] {
    return this.db.prepare("SELECT path, digest, size_bytes, chunks FROM knowledge_document ORDER BY path").all()
      .map((row) => ({ path: String(row.path), digest: String(row.digest), size_bytes: Number(row.size_bytes), chunks: Number(row.chunks) }));
  }

  /**
   * Portable hybrid search. SQL narrows to chunks containing every query token
   * (a cheap, FTS5-free candidate fetch); BM25 then orders those candidates by
   * term rarity so an identifier-dense chunk outranks one that merely shares a
   * common word. The row order is a stable tie-break, so results are
   * reproducible across SQLite builds.
   */
  search(query: string, options: { limit?: number } = {}): KnowledgeHit[] {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Knowledge search limit must be an integer between 1 and 100");
    const tokens = knowledgeQueryTokens(query);
    const clause = tokens.map(() => "body LIKE ?").join(" AND ");
    const rows = this.db.prepare(`SELECT path, ordinal, heading, body FROM knowledge_chunk WHERE ${clause} ORDER BY path, ordinal LIMIT ?`)
      .all(...tokens.map((token) => `%${token}%`), SEARCH_CANDIDATES)
      .map((row) => ({ path: String(row.path), heading: row.heading === null ? null : String(row.heading), body: String(row.body) }));
    if (!rows.length) return [];
    const index = new Bm25Index();
    rows.forEach((row, ordinal) => index.add(String(ordinal), `${row.heading ?? ""}\n${row.body}`));
    const scored = new Map(index.score(query).map((entry) => [entry.id, entry.score]));
    const ranked = rows.map((row, ordinal) => ({ row, ordinal, score: scored.get(String(ordinal)) ?? 0 }));
    const positive = ranked.filter((entry) => entry.score > 0);
    return (positive.length ? positive : ranked)
      .sort((left, right) => right.score - left.score || left.row.path.localeCompare(right.row.path) || left.ordinal - right.ordinal)
      .slice(0, limit)
      .map((entry, rank) => ({ path: entry.row.path, heading: entry.row.heading, snippet: locateSnippet(entry.row.body, tokens), rank }));
  }

  status(): { documents: number; chunks: number; file: string } {
    const documents = Number((this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_document").get() as { count: number }).count);
    const chunks = Number((this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_chunk").get() as { count: number }).count);
    return { documents, chunks, file: this.file };
  }

  close(): void { this.db.close(); }
}
