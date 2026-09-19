import assert from "node:assert/strict";
import test from "node:test";
import {
  COVERAGE_COLUMNS,
  detectEnvironmentBlocker,
  findShortfall,
  parseCoverageRows,
  type CoverageThresholds,
} from "../scripts/coverage/coverage-gate-report.ts";

/**
 * The real header and rows Node prints, copied verbatim.
 *
 * The gate's bug was reading the branch column as the function column, so this
 * fixture is the regression lock: it is a genuine table with genuinely different
 * numbers in each column, and a swap cannot satisfy it.
 */
const REAL_TABLE = [
  "ℹ start of coverage report",
  "ℹ ---------------------------------------------------------------------------------------",
  "ℹ file                              | line % | branch % | funcs % | uncovered lines",
  "ℹ ---------------------------------------------------------------------------------------",
  "ℹ src                               |        |          |         | ",
  "ℹ  a2a-transport.ts                 | 100.00 |    63.64 |  100.00 | ",
  "ℹ  craft-service.ts                 |  99.68 |    98.52 |   99.91 | 932-945",
  "ℹ  isolated.ts                      |  96.23 |   100.00 |   72.73 | 31-32",
  "ℹ all files                         |  99.85 |    96.85 |   98.95 | ",
].join("\n");

const THRESHOLDS: CoverageThresholds = { lines: 100, functions: 100, branches: 100 };

test("v0.12.43 declares the column order it depends on", () => {
  // The export exists so a reader never has to guess the order from the regex.
  assert.deepEqual([...COVERAGE_COLUMNS], ["line", "branch", "funcs"]);
});

test("v0.12.43 reads line, branch and funcs from the right columns", () => {
  const rows = parseCoverageRows(REAL_TABLE);
  // The directory row carries no percentages, so it is not a module row.
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.file), ["a2a-transport.ts", "craft-service.ts", "isolated.ts", "all files"]);

  const transport = rows[0]!;
  // 63.64 sits in the branch column. Reading it as funcs is the exact defect this
  // module was extracted to fix, so the assertion names all three columns.
  assert.equal(transport.line, 100);
  assert.equal(transport.branch, 63.64);
  assert.equal(transport.funcs, 100);

  const isolated = rows[2]!;
  assert.equal(isolated.line, 96.23);
  assert.equal(isolated.branch, 100);
  assert.equal(isolated.funcs, 72.73);

  // A row whose percentages are all equal cannot detect a swap, so the fixture
  // deliberately contains none.
  assert.notEqual(transport.branch, transport.funcs);
  assert.notEqual(isolated.line, isolated.funcs);
});

test("v0.12.43 parses nothing from text that carries no table", () => {
  assert.deepEqual(parseCoverageRows(""), []);
  assert.deepEqual(parseCoverageRows("all tests passed\nno table here"), []);
  // The header itself has no numbers, so it must not become a row.
  assert.deepEqual(parseCoverageRows("ℹ file | line % | branch % | funcs % | uncovered lines"), []);
});

test("v0.12.43 reports a line or function shortfall whenever it appears", () => {
  const rows = parseCoverageRows(REAL_TABLE);
  // With branch gated every below-threshold column counts: a2a-transport is low
  // only on branch, the other two on line and funcs.
  const gated = findShortfall(rows, THRESHOLDS, true).map((row) => row.file);
  assert.deepEqual(gated, ["a2a-transport.ts", "craft-service.ts", "isolated.ts"]);

  // Line and function gaps survive with branch ungated; the branch-only row does not.
  const ungated = findShortfall(rows, THRESHOLDS, false).map((row) => row.file);
  assert.deepEqual(ungated, ["craft-service.ts", "isolated.ts"]);
});

test("v0.12.43 never reports an ungated branch gap as a shortfall", () => {
  // The regression that motivated this module: a branch gap in a `branches: false`
  // group used to be printed as a coverage failure while a real function gap in the
  // same group went unreported.
  const branchOnly = parseCoverageRows("ℹ  trust-profile.ts | 100.00 | 81.13 | 100.00 | ");
  assert.deepEqual(findShortfall(branchOnly, THRESHOLDS, false), []);
  assert.equal(findShortfall(branchOnly, THRESHOLDS, true).length, 1);

  // The mirror case: a function gap must be reported even when branch is ungated.
  const funcsOnly = parseCoverageRows("ℹ  subagent-execution.ts | 100.00 | 100.00 | 97.62 | ");
  assert.equal(findShortfall(funcsOnly, THRESHOLDS, false).length, 1);
});

test("v0.12.43 excludes the aggregate row from any shortfall", () => {
  // `all files` is routinely below 100 while every module row passes; counting it
  // would fail every group.
  const rows = parseCoverageRows(REAL_TABLE);
  for (const row of findShortfall(rows, THRESHOLDS, true)) assert.notEqual(row.file, "all files");

  const aggregateOnly = parseCoverageRows("ℹ all files | 50.00 | 50.00 | 50.00 | ");
  assert.deepEqual(findShortfall(aggregateOnly, THRESHOLDS, true), []);
});

test("v0.12.43 passes a table whose modules all meet the thresholds", () => {
  const clean = parseCoverageRows("ℹ  memory-wiring.ts | 100.00 | 100.00 | 100.00 | ");
  assert.deepEqual(findShortfall(clean, THRESHOLDS, true), []);
  assert.deepEqual(findShortfall(clean, THRESHOLDS, false), []);
});

test("v0.12.43 separates a blocked spawn from a coverage gap", () => {
  // The two produce the same red gate and need opposite responses, so a blocked
  // run must be named as such rather than printed as a missing test.
  const blocked = detectEnvironmentBlocker("Error: spawn EPERM\n  at child_process");
  assert.equal(typeof blocked, "string");
  assert.match(String(blocked), /spawn EPERM/u);
  assert.match(String(blocked), /sandbox denied a child process/u);

  // The real message from a denied spawnSync, copied verbatim. The executable path
  // sits between the call name and the errno, so a pattern that requires them
  // adjacent passes the test above and misses this — which is what happened.
  const real =
    "Error: spawnSync D:\\application\\dshdesktop\\DSH Desktop\\resources\\app\\node_modules\\node\\bin\\node.exe EPERM";
  assert.equal(detectEnvironmentBlocker(real), blocked);

  assert.equal(detectEnvironmentBlocker("✔ everything passed"), null);
  assert.equal(detectEnvironmentBlocker("ℹ all files | 100.00 | 100.00 | 100.00 | "), null);
});
