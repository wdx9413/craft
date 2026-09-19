/**
 * Coverage-table interpretation, separated from the gate script so it can be tested.
 *
 * The column order is the entire reason this module exists. Node prints
 * `file | line % | branch % | funcs %`, and the gate used to compare the *branch*
 * column against the *function* threshold and the *function* column against the
 * *branch* threshold. All three thresholds are 100, so for a group that gates
 * every column the swap was invisible — the same set of rows was flagged either
 * way. For a `branches: false` group it was not harmless: a genuine function
 * shortfall went unreported, while an ungated branch gap was printed as a
 * coverage failure. That is how an environment failure or a non-gated gap gets
 * mistaken for a missing test, which is the one mistake this project keeps
 * naming.
 *
 * Living in `scripts/` rather than `src/` is deliberate: `tsconfig.build.json`
 * includes only `src/**` and `bin/**`, so this stays a development tool and never
 * ships. `tsconfig.json` still typechecks it, and both gates still measure it.
 */

/** The percentage columns of Node's coverage table, in the order it prints them. */
export const COVERAGE_COLUMNS = ["line", "branch", "funcs"] as const;
export type CoverageColumn = typeof COVERAGE_COLUMNS[number];

export interface CoverageRow {
  file: string;
  line: number;
  branch: number;
  funcs: number;
}

export interface CoverageThresholds {
  lines: number;
  functions: number;
  branches: number;
}

/**
 * One percentage row of Node's coverage table.
 *
 * Captures are positional, so the mapping below is the contract: group 2 is the
 * line column, group 3 the branch column, group 4 the function column. A test
 * pins this against the real table header.
 */
const COVERAGE_ROW = /^\s*\u2139\s+([^|]+?)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/u;

/** The summary row Node prints for the whole run; it is not a module. */
const AGGREGATE_FILE = "all files";

/** Parse every percentage row from a coverage report, ignoring everything else. */
export function parseCoverageRows(text: string): CoverageRow[] {
  const rows: CoverageRow[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = COVERAGE_ROW.exec(line);
    if (!match) continue;
    rows.push({
      file: match[1],
      line: Number(match[2]),
      branch: Number(match[3]),
      funcs: Number(match[4]),
    });
  }
  return rows;
}

/**
 * The rows that actually fell below a threshold this group enforces.
 *
 * Line and function coverage are always gated. Branch coverage is only gated when
 * the group asks for it, so a branch gap in a `branches: false` group is reported
 * as a gap while measuring something the group explicitly does not require.
 */
export function findShortfall(rows: CoverageRow[], thresholds: CoverageThresholds, gateBranches: boolean): CoverageRow[] {
  return rows.filter((row) => {
    if (row.file === AGGREGATE_FILE) return false;
    if (row.line < thresholds.lines || row.funcs < thresholds.functions) return true;
    return gateBranches && row.branch < thresholds.branches;
  });
}

/**
 * A condition that stopped the test run rather than a coverage gap in the code.
 *
 * These are separated because the two produce the same red gate but demand
 * opposite responses: a shortfall means "write a test", a blocked spawn means
 * "run this somewhere the sandbox permits child processes". Reporting the second
 * as the first sends someone to fix code that was never executed.
 */
const ENVIRONMENT_BLOCKERS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // Matches both the bare form and the real one, which is
    // `Error: spawnSync <absolute node path> EPERM` — the executable sits between
    // the call name and the errno, so a pattern requiring them adjacent misses it.
    pattern: /spawn\w*[^\n]*EPERM/u,
    reason: "spawn EPERM: the sandbox denied a child process, so the covering test aborted before exercising this code",
  },
];

/** The first environment blocker present in a run's output, or null. */
export function detectEnvironmentBlocker(text: string): string | null {
  for (const blocker of ENVIRONMENT_BLOCKERS) if (blocker.pattern.test(text)) return blocker.reason;
  return null;
}
