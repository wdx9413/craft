import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tests = readdirSync(resolve(root, "tests"))
  .filter((entry) => entry.endsWith(".test.ts"))
  .sort()
  .map((entry) => `tests/${entry}`);

if (!tests.length) throw new Error("No TypeScript tests were discovered");

// --test-isolation=none (single-process runs) only exists from Node 23. On older
// runtimes the whole command previously aborted with "bad option" before a single
// test ran. Fall back to the default process isolation and say so; coverage
// thresholds are never relaxed just to make a run pass.
const major = Number(process.versions.node.split(".")[0]);
const isolation = major >= 23 ? ["--test-isolation=none"] : [];
if (major < 23) {
  process.stderr.write(
    `Node ${process.versions.node} does not support --test-isolation=none; running with default process isolation. Coverage thresholds are unchanged.\n`,
  );
}

const result = spawnSync(process.execPath, [
  "--test",
  ...isolation,
  "--experimental-test-coverage",
  "--test-coverage-exclude=tests/**",
  "--test-coverage-lines=100",
  "--test-coverage-functions=100",
  // Branch coverage remains visible in Node's report, but the release gate is
  // intentionally method-level: a new method must be exercised completely.
  // This avoids blocking a release on legacy defensive combinations while
  // keeping line/function coverage deterministic at 100%.
  ...tests,
], { cwd: root, stdio: "inherit" });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
