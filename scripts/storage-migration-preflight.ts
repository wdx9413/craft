import { homedir } from "node:os";
import { join } from "node:path";
import { craftPaths } from "../common/craft-common-store-local/src/paths.ts";
import { legacySessionMemoryPreflight } from "../core/legacy-session-memory-preflight.ts";
import { storageMigrationPreflight } from "../core/storage-migration-preflight.ts";

const options = process.argv.slice(2);
if (options.some(value => !/^--(?:limit|cursor|data-root|legacy-cursor)=.+$/u.test(value))) throw new Error("Unsupported preflight argument");
const value = (name: string) => options.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = value("data-root") ?? join(homedir(), ".craft_data");
const maxRecords = value("limit") === undefined ? 100 : Number(value("limit"));
const result = storageMigrationPreflight(craftPaths(root), { max_records: maxRecords, ...(value("cursor") ? { cursor: value("cursor") } : {}) });
const legacyMemory = legacySessionMemoryPreflight(craftPaths(root), { legacy_root: join("/tmp", ".craft_data", "memory"),
  max_entries: maxRecords, ...(value("legacy-cursor") ? { cursor: value("legacy-cursor") } : {}) });
console.log(JSON.stringify({ ...result, status_counts: result.entries.reduce<Record<string, number>>((counts, entry) => {
  counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return counts;
}, {}), project_identity_status_counts: result.entries.reduce<Record<string, number>>((counts, entry) => {
  if (entry.project_identity_status !== null) counts[entry.project_identity_status] = (counts[entry.project_identity_status] ?? 0) + 1;
  return counts;
}, {}), legacy_session_memory: { ...legacyMemory, status_counts: legacyMemory.entries.reduce<Record<string, number>>((counts, entry) => {
  counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return counts;
}, {}) } }, null, 2));
