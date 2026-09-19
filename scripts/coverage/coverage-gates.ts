import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectEnvironmentBlocker, findShortfall, parseCoverageRows } from "./coverage-gate-report.ts";

/**
 * Enforces the per-module coverage gates.
 *
 * `scripts/test.ts` covers the common case: every test, one run, 100% line and
 * function coverage across all of `src/`. A subset of modules is held to a
 * stricter standard, including branch coverage, and that subset used to live one
 * release at a time in `package.json` -- `test:v01216` ... `test:v01242`, each
 * hard-coding both its modules and its test files. Two consequences made it
 * worth replacing: renaming a module broke its gate silently, and every release
 * added another script plus another `&&` to the aggregate chain.
 *
 * The groups are now data (`tests/coverage-gates.json`) and each still runs as
 * its own `node --test` invocation. They are deliberately not merged into one
 * run: with every test in a single process, `context-retrieval-capture.ts`
 * reports 98.67% line coverage where its own group reports 100%, so a combined
 * run would be a stricter gate than the one being replaced.
 */
const root = resolve(import.meta.dirname, "..", "..");

interface GateGroup {
  name: string;
  include: string[];
  tests: string[];
  branches: boolean;
  /** Platforms where the branch threshold cannot be met because the branch is unreachable. */
  skipBranchesOn?: string[];
  branchesNote?: string;
}

interface GateManifest {
  thresholds: { lines: number; functions: number; branches: number };
  groups: GateGroup[];
}

const manifest = JSON.parse(readFileSync(resolve(root, "tests/coverage-gates.json"), "utf8")) as GateManifest;

if (!Array.isArray(manifest.groups) || manifest.groups.length === 0) {
  throw new Error("tests/coverage-gates.json must define at least one group");
}

const major = Number(process.versions.node.split(".")[0]);
// --test-isolation=none (single-process runs) only exists from Node 23. The
// scripts this replaces hard-coded it, so on an older runtime every gate aborted
// with "bad option" before running a test.
const isolation = major >= 23 ? ["--test-isolation=none"] : [];
if (major < 23) {
  process.stderr.write(
    `Node ${process.versions.node} does not support --test-isolation=none; running with default process isolation. Gate thresholds are unchanged.\n`,
  );
}

const { lines, functions, branches } = manifest.thresholds;
const failures: string[] = [];

for (const group of manifest.groups) {
  if (!group.include?.length || !group.tests?.length) {
    failures.push(`${group.name}: group must name at least one module and one test file`);
    continue;
  }

  // A branch can be unreachable on one platform and covered on another; holding
  // it to 100% there would measure the platform rather than the code.
  const branchesApply = group.branches && !(group.skipBranchesOn ?? []).includes(process.platform);
  if (group.branches && !branchesApply) {
    console.log(`NOTE  ${group.name}: branch gate skipped on ${process.platform}${group.branchesNote ? ` -- ${group.branchesNote}` : ""}`);
  }

  // A spawn can fail in two ways: some sandboxes return a result carrying `error`,
  // others fail the call outright. Both mean the group never ran, so both are
  // handled here rather than crashing the script on the first group and hiding the
  // state of every group after it.
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(process.execPath, [
      "--test",
      ...isolation,
      "--test-concurrency=1",
      "--experimental-test-coverage",
      ...group.include.map((file) => `--test-coverage-include=${file}`),
      `--test-coverage-lines=${lines}`,
      `--test-coverage-functions=${functions}`,
      ...(branchesApply ? [`--test-coverage-branches=${branches}`] : []),
      ...group.tests,
    ], { cwd: root, stdio: ["inherit", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    result = { error: error as Error } as ReturnType<typeof spawnSync>;
  }

  if (result.error) {
    // The spawn failed, so there is no coverage table to read. `EPERM` arrives on the
    // error object rather than in stdout, which is why the blocker is detected from
    // the error text here and not from the output below.
    const blocker = detectEnvironmentBlocker(String(result.error));
    failures.push(group.name);
    console.log(`FAIL  ${group.name.padEnd(38)} spawn failed`);
    console.log(`      ${blocker ?? String(result.error)}`);
    continue;
  }

  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  const output = `${stdout}\n${stderr}`;
  const rows = output.split(/\r?\n/u);
  const counts = rows.filter((line) => /ℹ (tests|fail) \d+/u.test(line)).map((line) => line.trim()).join("  ");
  const aggregate = rows.find((line) => /ℹ all files/u.test(line))?.trim() ?? "(no coverage table)";

  const passed = (result.status ?? 1) === 0;
  console.log(`${passed ? "PASS" : "FAIL"}  ${group.name.padEnd(38)} ${counts}`);
  console.log(`      ${aggregate}`);

  if (!passed) {
    failures.push(group.name);
    // A blocked child process and a genuine coverage gap both turn the gate red and
    // need opposite responses, so the environment cause is named first instead of
    // being printed as a missing test.
    const blocker = detectEnvironmentBlocker(output);
    if (blocker) console.log(`        environment: ${blocker}`);
    // Then the rows that actually fell below a threshold this group enforces. The
    // column mapping lives in `coverage-gate-report.ts` and is pinned by a test,
    // because the gate used to read the branch column as the function column.
    const shortfall = findShortfall(parseCoverageRows(output), { lines, functions, branches }, branchesApply);
    for (const row of shortfall) {
      console.log(`        under threshold: ${row.file} | line ${row.line} | branch ${row.branch} | funcs ${row.funcs}`);
    }
    // Only fall back to raw output when nothing above explained the failure.
    if (!shortfall.length && !blocker) {
      console.log(`        ${stderr.split(/\r?\n/u).filter(Boolean).slice(-4).join("\n        ")}`);
    }
  }

}

console.log(`\ncoverage gates: ${manifest.groups.length - failures.length}/${manifest.groups.length} groups passed`);
if (failures.length) {
  console.error(`failing groups: ${failures.join(", ")}`);
  process.exitCode = 1;
}
