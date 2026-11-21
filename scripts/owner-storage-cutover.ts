import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";
import { presentStorageOwners } from "../core/infrastructure/owned-catalog.ts";
import { historyArchiveEntries, readArchivedHistory, verifyHistoryArchiveSources, type HistoryArchiveManifest } from "../core/owner-history-archive.ts";
import { switchOwnerStorage, rollbackOwnerStorage, recoverOwnerStorage } from "../core/owner-storage-cutover.ts";
import { stableDigest } from "../core/digest.ts";

const args = process.argv.slice(2);
const options = new Map<string, string>();
for (const arg of args) {
  const match = /^--(active|staged|previous|archive|manifest|preserve-new)=(.+)$/u.exec(arg);
  if (match) { if (options.has(match[1]!)) throw new Error("Duplicate cutover option"); options.set(match[1]!, match[2]!); }
  else if (arg !== "--apply" && arg !== "--rollback" && arg !== "--recover") throw new Error("Unknown cutover option");
}
if (new Set(args).size !== args.length || !options.has("active")) throw new Error("Cutover requires one explicit --active=<root>");
const active = options.get("active")!;
if (args.includes("--recover")) {
  if (!args.includes("--apply") || args.includes("--rollback") || options.size !== 1) throw new Error("Recovery requires only --active=<root> --recover --apply");
  const result = await recoverOwnerStorage(active, async root => {
    const owners = presentStorageOwners(root);
    if (owners.length) for (const owner of owners) { const runtime = await openCapabilityService(owner, { CRAFT_DATA_DIR: root }); runtime.close(); }
    else {
      const { DatabaseSync } = await import("node:sqlite");
      const { craftPaths } = await import("../core/infrastructure/paths.ts");
      const database = new DatabaseSync(craftPaths(root).databaseFile, { readOnly: true });
      try { if (database.prepare("PRAGMA quick_check").get()!.quick_check !== "ok") throw new Error("Recovered shared database failed verification"); } finally { database.close(); }
    }
  });
  process.stdout.write(JSON.stringify({ mode: "recovered", ...result }) + "\n");
} else if (args.includes("--rollback")) {
  if (!args.includes("--apply") || !options.has("preserve-new") || options.size !== 2) throw new Error("Rollback requires --active=<root> --preserve-new=<separate-root> --rollback --apply");
  await rollbackOwnerStorage(active, options.get("preserve-new")!, async root => {
    // The preserved old tree must at least reopen through its original public Store.
    const { CraftStore } = await import("../core/infrastructure/store.ts");
    const { craftPaths } = await import("../core/infrastructure/paths.ts");
    const store = await new CraftStore(craftPaths(root)).open(); store.close();
  });
  process.stdout.write(JSON.stringify({ mode: "rolled-back", new_assets_preserved_at: options.get("preserve-new") }) + "\n");
} else {
  if (options.size !== 5 || !["staged", "previous", "archive", "manifest"].every(key => options.has(key))
    || !/^manifest-[a-f0-9]{64}\.json$/u.test(options.get("manifest")!)) throw new Error("Cutover requires --active=<root> --staged=<root> --previous=<new-backup-root> --archive=<root> --manifest=manifest-<digest>.json [--apply]");
  const archive = options.get("archive")!;
  const manifest = JSON.parse(readFileSync(join(archive, options.get("manifest")!), "utf8")) as HistoryArchiveManifest;
  verifyHistoryArchiveSources(manifest);
  const verify = async (root: string) => {
    const owners = new Map<string, Awaited<ReturnType<typeof openCapabilityService>>>();
    try {
      for (const owner of presentStorageOwners(root)) owners.set(owner, await openCapabilityService(owner, { CRAFT_DATA_DIR: root }));
      for (const entry of historyArchiveEntries(archive, manifest)) {
        if (entry.state !== "published" || entry.unresolved || entry.owner === "identity" || !owners.has(entry.owner)) continue;
        const expected = readArchivedHistory(archive, entry);
        const record = owners.get(entry.owner)!.store.get(entry.kind, entry.id, entry.version);
        if (record.version !== entry.version || record.created_at !== expected.created_at || record.updated_at !== expected.updated_at) throw new Error("Imported history metadata mismatch");
        const original = expected.payload as Record<string, unknown>;
        for (const key of ["status", "lifecycle", "content", "signature", "report_signature"]) {
          if (original[key] !== undefined && stableDigest(record[key]) !== stableDigest(original[key])) throw new Error("Imported history lifecycle, body or signature mismatch");
        }
      }
    } finally { for (const owner of owners.values()) owner.close(); }
  };
  if (args.includes("--apply")) {
    const result = await switchOwnerStorage(active, options.get("staged")!, options.get("previous")!, manifest, verify);
    process.stdout.write(JSON.stringify({ mode: "switched", ...result }) + "\n");
  } else {
    await verify(options.get("staged")!);
    process.stdout.write(JSON.stringify({ mode: "verified-dry-run", source_switched: false, archive_digest: manifest.digest }) + "\n");
  }
}
