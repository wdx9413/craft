import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/**
 * Checks whether Craft's declared layers are actually enforced.
 *
 * `docs/architecture/layer-map.md` declares the direction
 * interfaces → application → domains → infrastructure: an outer layer may use an
 * inner one, never the reverse. That ordering is what lets a transport change or
 * a use-case change be made without dragging the domain kernels with it.
 *
 * The predecessor of this check (`scripts/audit-v01234-layering.mjs`) claimed to
 * verify it but could not have caught a regression:
 *
 *  - it walked a relative `"src"`, so invoking it from anywhere but the
 *    repository root failed with ENOENT;
 *  - it was wired into no package script and no workflow, so its result could
 *    not fail anything.
 *
 * It also only inspected kernels *outside* the layer directories. Under that
 * rule, moving an offending file into `application/` would silence the check
 * without fixing the dependency, so this version ranks every file and compares
 * the import against the layer the file itself lives in.
 */
const root = resolve(import.meta.dirname, "..", "..");

/**
 * Dependency order, innermost first. A file may import from its own rank or
 * below; importing from a higher rank is an upward dependency.
 */
const RANK: Record<string, number> = {
  infrastructure: 0,
  // Domain kernels live at the `src/` root (and in `domains/`); they sit above
  // infrastructure and below the application.
  "": 1,
  domains: 1,
  application: 2,
  interfaces: 3,
};

/**
 * Capability packages, which are ranked at kernel level rather than above the application.
 *
 * A capability under `capability/<name>/` owns kernels and assembles only those, so it
 * belongs at rank 1: it may use infrastructure and domain kernels, and it may not reach
 * into `application/` or `interfaces/`. That restriction is the point of the ranking. A
 * capability is discovered by the core, so if it could import the facade that discovers
 * it, the dependency would run both ways and neither side could be replaced alone.
 *
 * They were outside this audit entirely while they lived under `src/`, and moving a kernel
 * out of `src/` would have silently removed it from the check — the same
 * "moving the file silences the rule" failure this script was rewritten to close. So the
 * walk covers them, and their rank is declared here rather than inferred from the path.
 */
const CAPABILITY_RANK = 1;

/**
 * Re-export barrels, which are exempt by construction.
 *
 * `layer-map.md` describes `src/service.ts` and `src/mcp.ts` as stable thin
 * re-exports kept so existing adapters and third-party imports keep working.
 * Re-exporting the layer above is the entire purpose of an entrypoint.
 *
 * `src/infrastructure/index.ts` used to sit here too, for a reason that no longer
 * holds. Its note read: the persistence and path primitives it re-exports
 * (`store.ts`, `paths.ts`) live at the `src/` root rather than under
 * `infrastructure/`, so a rank comparison reads the barrel as importing upward when
 * it is in fact re-exporting its own implementation — and the honest fix was to move
 * those modules under `infrastructure/`. They now are, along with
 * `store-migrations.ts`, so the barrel imports its own layer and the exemption is
 * removed rather than left to excuse a problem that is gone.
 */
const REEXPORT_BARRELS = new Set([
  "core/service.ts",
  "core/mcp.ts",
  "core/domains/index.ts",
]);

/**
 * Upward imports that are known, deliberate, and still outstanding.
 *
 * Each entry states what would remove it. The list is deliberately temporary: an
 * entry that stops occurring is reported as *stale*, so an exemption cannot
 * silently outlive the problem it describes.
 *
 * This list held five entries. Four were `service-foundation.ts` reaching into
 * `application/coordinators/*`, and their own note named the fix: the module is
 * imported only by `application/craft-service.ts`, so it belongs in
 * `application/`. Moving it there made the ranks equal and the four edges stopped
 * being upward — removed here rather than left to be reported stale. The fifth
 * survives the move, because `interfaces/` still outranks `application/`.
 */
const KNOWN_UPWARD: Array<{ file: string; target: string; reason: string }> = [
  {
    file: "core/application/service-foundation.ts",
    target: "core/interfaces/canonical-tools.ts",
    reason: "canonical-tools re-exports the tool table from mcp-server; the table must move to a neutral module. Time-boxed: remove by moving the table, not by widening this list.",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const toRepoPath = (absolute: string): string => relative(root, absolute).split("\\").join("/");
const segmentOf = (repositoryPath: string): string =>
  repositoryPath.startsWith("core/") ? repositoryPath.slice(5).split("/")[0] : "";
/**
 * Rank of a file or import target.
 *
 * Only `src/` paths carry a layer, and a capability package carries {@link CAPABILITY_RANK}.
 * Anything else — `scripts/`, `tests/`, `adapters/`, `bin/` — returns `null`, which means
 * "not part of the layering question": the import is neither reported nor exempted.
 */
const rankOf = (repositoryPath: string): number | null => {
  if (repositoryPath.startsWith("capability/")) return CAPABILITY_RANK;
  if (!repositoryPath.startsWith("core/")) return null;
  const rest = repositoryPath.slice(5);
  const segment = segmentOf(repositoryPath);
  if (segment.endsWith(".ts")) return RANK[""]; // directly under src/
  return segment in RANK ? RANK[segment] : RANK[""];
};

const observed = new Map<string, { file: string; target: string; source: string }>();

// `capability/` is walked as well as `src/`, for the reason stated on CAPABILITY_RANK.
const scanned = [...walk(resolve(root, "core")), ...walk(resolve(root, "capability"))];

for (const file of scanned) {
  const repositoryPath = toRepoPath(file);
  if (REEXPORT_BARRELS.has(repositoryPath)) continue;

  const fileRank = rankOf(repositoryPath);
  if (fileRank === null) continue;

  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/gu)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const target = toRepoPath(resolve(dirname(file), specifier));
    const targetRank = rankOf(target);
    if (targetRank === null || targetRank <= fileRank) continue;
    observed.set(`${repositoryPath} -> ${target}`, { file: repositoryPath, target, source: specifier });
  }
}

const key = (file: string, target: string): string => `${file} -> ${target}`;
const known = new Map(KNOWN_UPWARD.map((entry) => [key(entry.file, entry.target), entry]));

const unexpected = [...observed.entries()].filter(([id]) => !known.has(id));
const stale = KNOWN_UPWARD.filter((entry) => !observed.has(key(entry.file, entry.target)));

console.log(`layer audit: ${observed.size} upward import(s) across ${Object.keys(RANK).length} declared layers`);
for (const entry of KNOWN_UPWARD) {
  if (observed.has(key(entry.file, entry.target))) console.log(`  known: ${key(entry.file, entry.target)}`);
}

let failed = false;
if (unexpected.length) {
  failed = true;
  console.error(`layer audit: ${unexpected.length} unexpected upward import(s)`);
  for (const [id, entry] of unexpected) console.error(`  ${id}   (via "${entry.source}")`);
  console.error("  An inner layer must not import an outer one. Move the dependency, or add a dated exemption with a reason.");
}
if (stale.length) {
  failed = true;
  console.error(`layer audit: ${stale.length} stale exemption(s) — the import no longer occurs, remove the entry`);
  for (const entry of stale) console.error(`  ${key(entry.file, entry.target)}`);
}

if (failed) process.exitCode = 1;
else console.log(`layer audit: clean (${KNOWN_UPWARD.length} documented exemption(s) outstanding)`);
