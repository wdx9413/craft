#!/usr/bin/env node
/** One-time offline importer; the legacy tree is never read by runtime MCP/Host code. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

function option(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const argv = process.argv.slice(2);
const sourceRoot = option(argv, "--source-root", "/Users/didi/Documents/kefu_llm_wiki");
const dataRoot = option(argv, "--data-root", process.env.CRAFT_DATA_DIR || craftPaths().root);
const migrationId = option(argv, "--migration-id", `offline_kefu_import_${Date.now()}`);
const dryRun = argv.includes("--dry-run");
const temporaryRoot = dryRun ? await mkdtemp(join(tmpdir(), "craft-import-dry-run-")) : null;
const store = await new CraftStore(craftPaths(temporaryRoot ?? dataRoot)).open();
try {
  if (!dryRun) store.backup();
  const service = new CraftService(store);
  const discovered = await service.legacyKnowledgeMigrationDiscover({ migration_id: migrationId, source_root: sourceRoot, offline: true });
  const migration = discovered.migration as JsonObject;
  const entries = (migration.entries as JsonObject[] | undefined) ?? [];
  const eligible = entries.filter((entry) => entry.eligibility === "eligible").map((entry) => String(entry.rel_path));
  const excluded = entries.filter((entry) => entry.eligibility !== "eligible").map((entry) => ({ rel_path: entry.rel_path, reason: entry.reason }));
  const result: JsonObject = { mode: dryRun ? "dry_run" : "import", migration_id: migration.id, source_digest: migration.source_digest, eligible_count: eligible.length, excluded_count: excluded.length, excluded };
  if (!dryRun) {
    const imported = await service.legacyKnowledgeMigrationCandidateImport({ migration_id: migrationId, candidate_ids: eligible, offline: true });
    const candidates = (imported.candidates as JsonObject[] | undefined) ?? [];
    result.imported_count = candidates.filter((item) => item.status === "candidate").length;
    result.duplicate_count = candidates.filter((item) => item.status === "duplicate").length;
    result.failure_count = ((imported.failures as JsonObject[] | undefined) ?? []).length;
    result.failure_report_id = imported.report_id;
    result.rollback = "Restore the pre-import DB backup or retract individual candidates; the source tree is untouched.";
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  store.close();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
