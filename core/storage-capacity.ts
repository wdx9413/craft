import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Counts = { files: number; bytes: number; allocated_bytes: number };
const PAGE_QUERY = `WITH pages AS MATERIALIZED (SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name)
SELECT (SELECT page_size FROM pragma_page_size) AS page_size,
(SELECT page_count FROM pragma_page_count) AS page_count,(SELECT freelist_count FROM pragma_freelist_count) AS free_pages,
COALESCE(SUM(CASE WHEN name IN (SELECT name FROM sqlite_schema WHERE type='table') THEN bytes ELSE 0 END),0) AS table_bytes,
COALESCE(SUM(CASE WHEN name IN (SELECT name FROM sqlite_schema WHERE type='index') THEN bytes ELSE 0 END),0) AS index_bytes,
COALESCE(SUM(CASE WHEN name IN (SELECT name FROM sqlite_schema WHERE type='table') THEN pages ELSE 0 END),0) AS table_pages,
COALESCE(SUM(CASE WHEN name IN (SELECT name FROM sqlite_schema WHERE type='index') THEN pages ELSE 0 END),0) AS index_pages
FROM pages`;

function databaseCapacity(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  let records = 0, payload = 0, referenced = 0;
  try {
    for (const table of ["records", "events"]) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some(column => column.name === "payload_json")) continue;
      const row = database.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))),0) AS bytes,
        COALESCE(SUM(CASE WHEN json_valid(payload_json) THEN COALESCE(json_extract(payload_json,'$._record_file.bytes'),0) ELSE 0 END),0) AS referenced FROM ${table}`).get()!;
      records += Number(row.count); payload += Number(row.bytes); referenced += Number(row.referenced);
    }
  } finally { database.close(); }
  try {
    const raw = execFileSync("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 1000", file, PAGE_QUERY], { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
    const pages = JSON.parse(raw)[0] as Record<string, number>;
    return { status: "measured", records, database_payload_bytes: payload, referenced_record_range_bytes: referenced, ...pages };
  } catch {
    // Some platforms omit dbstat. Payload and physical sizes remain facts; never invent an index split.
    return { status: "page_breakdown_unavailable", records, database_payload_bytes: payload, referenced_record_range_bytes: referenced,
      page_size: null, page_count: null, free_pages: null, table_bytes: null, index_bytes: null, table_pages: null, index_pages: null };
  }
}

/** The categories are disjoint. Allocated bytes deduplicate hard links within each measured tree. */
export function measureStorageCapacity(directory: string) {
  const root = resolve(directory), totals = new Map<string, Counts>(), inodes = new Set<string>();
  const databases: Array<Record<string, unknown>> = [];
  let symbolicLinks = 0;
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { symbolicLinks++; return; }
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) visit(join(path, name)); return; }
    if (!stat.isFile()) throw new Error("Capacity inventory requires regular files");
    const name = relative(root, path).replaceAll("\\", "/");
    const category = /\.(?:db|sqlite|sqlite3)$/iu.test(name) ? "sqlite"
      : /-(?:wal|shm|journal)$/u.test(name) ? "sqlite_sidecars"
        : /\.md$/iu.test(name) ? "markdown"
          : /\/records\/cold\//u.test(`/${name}`) ? "cold_records"
            : /\.jsonl$/iu.test(name) ? "event_files"
              : /\.json$/iu.test(name) ? "structured_files" : "other_files";
    const count = totals.get(category) ?? { files: 0, bytes: 0, allocated_bytes: 0 };
    const inode = `${stat.dev}:${stat.ino}`;
    count.files++; count.bytes += stat.size;
    if (!inodes.has(inode)) count.allocated_bytes += stat.blocks * 512;
    inodes.add(inode); totals.set(category, count);
    if (category === "sqlite") databases.push({ file: name, physical_bytes: stat.size, ...databaseCapacity(path) });
  };
  visit(root);
  return { schema: "craft.storage-capacity.v1", status: symbolicLinks ? "partial" : "measured", symbolic_links_not_followed: symbolicLinks,
    categories: Object.fromEntries(totals), databases,
    total_file_bytes: [...totals.values()].reduce((sum, item) => sum + item.bytes, 0),
    total_allocated_bytes: [...totals.values()].reduce((sum, item) => sum + item.allocated_bytes, 0),
    semantics: { page_breakdown: "SQLite table/index B-tree pages; FTS shadow tables remain table pages, not a separate semantic search-index measurement",
      database_payload_bytes: "UTF-8 bytes of committed records/events payload_json, including necessary metadata",
      referenced_record_range_bytes: "Committed immutable record-envelope byte ranges; Markdown and other files are accounted separately",
      categories: "Physical file inventory includes retained orphan files; paths outside this tree are excluded" } };
}
