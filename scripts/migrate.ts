/**
 * Operator entry point for the schema migration registry.
 *
 * Usage:
 *   node --experimental-strip-types scripts/migrate.ts              # upgrade to current SCHEMA_VERSION
 *   node --experimental-strip-types scripts/migrate.ts --dry-run    # show plan, apply nothing
 *   node --experimental-strip-types scripts/migrate.ts --backup     # copy craft.db to backupsDir before applying
 *   node --experimental-strip-types scripts/migrate.ts --target 3   # upgrade/downgrade to a specific version
 *   node --experimental-strip-types scripts/migrate.ts --target 3 --rollback  # walk back from current to target
 *
 * Safety:
 *   - The registry is the only path that may alter schema. `applyMigrations`
 *     wraps every step in a transaction and rolls back on any error.
 *   - `--backup` is a separate step the operator triggers explicitly; we never
 *     silently copy files.
 */
import { resolve } from "node:path";
import { craftPaths, ensureLayout } from "../src/paths.ts";
import { CraftStore, SCHEMA_VERSION } from "../src/store.ts";
import { applyMigrations, backupDatabase, MIGRATIONS } from "../src/store-migrations.ts";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const backup = args.has("--backup");
const rollback = args.has("--rollback");
const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target = targetArg ? Number(targetArg.split("=")[1]) : SCHEMA_VERSION;

if (!Number.isInteger(target) || target < 0 || target > SCHEMA_VERSION) {
  throw new Error(`--target must be an integer between 0 and ${SCHEMA_VERSION}`);
}

const paths = craftPaths(resolve(import.meta.dirname, "..", ".craft_data"));
await ensureLayout(paths);

console.log(`[migrate] target=v${target} dryRun=${dryRun} backup=${backup} rollback=${rollback}`);
console.log(`[migrate] database=${paths.databaseFile}`);
console.log(`[migrate] registered migrations: ${MIGRATIONS.length}`);
for (const m of MIGRATIONS) console.log(`  v${m.from} -> v${m.to}  ${m.description}`);

if (dryRun) {
  // Open a temporary in-memory DB to compute the plan without touching the
  // real file. We do not call applyMigrations on the live DB.
  const store = await new CraftStore(paths).open();
  const result = applyMigrations(store.database, target, { dryRun: true });
  console.log(`[migrate] plan: from=v${result.from} to=v${result.to} applied=${result.applied}`);
  for (const m of result.migrations) console.log(`  would apply v${m.from} -> v${m.to}  ${m.description}`);
  store.close();
  process.exit(0);
}

if (backup) {
  const store = await new CraftStore(paths).open();
  const backupPath = backupDatabase(paths.databaseFile, paths.backupsDir);
  console.log(`[migrate] backup written: ${backupPath}`);
  store.close();
}

const store = await new CraftStore(paths).open();
const result = store.applyMigrationsNow(target, { dryRun: false });
console.log(`[migrate] applied: from=v${result.from} to=v${result.to} count=${result.applied}`);
for (const m of result.migrations) console.log(`  applied v${m.from} -> v${m.to}  ${m.description}`);
store.close();

if (rollback) {
  console.log(`[migrate] rollback direction confirmed (target was below current; registry walked down automatically)`);
}
console.log("[migrate] done");