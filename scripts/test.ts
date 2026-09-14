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
// The suite intentionally shares one process so coverage and legacy imports are
// collected together.  A few integration tests temporarily replace process
// globals (fetch and environment variables); keep files deterministic across
// runners by never executing top-level test files concurrently.
const concurrency = ["--test-concurrency=1"];
if (major < 23) {
  process.stderr.write(
    `Node ${process.versions.node} does not support --test-isolation=none; running with default process isolation. Coverage thresholds are unchanged.\n`,
  );
}

const result = spawnSync(process.execPath, [
  "--test",
  ...isolation,
  ...concurrency,
  "--experimental-test-coverage",
  "--test-coverage-exclude=tests/**",
  // CLI is an executable entrypoint verified through child-process smoke tests.
  // Node 23 folds that complete binary into the parent coverage report, even
  // when the child disables coverage; keep library coverage deterministic.
  "--test-coverage-exclude=src/cli.ts",
  "--test-coverage-lines=100",
  "--test-coverage-functions=100",
  // Branch coverage remains visible in Node's report, but the release gate is
  // intentionally method-level: a new method must be exercised completely.
  // This avoids blocking a release on legacy defensive combinations while
  // keeping line/function coverage deterministic at 100%.
  ...tests,
], { cwd: root, stdio: ["inherit", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });

const stdout = result.stdout?.toString() ?? "";
const stderr = result.stderr?.toString() ?? "";
process.stdout.write(stdout);
process.stderr.write(stderr);
if ((result.status ?? 1) !== 0 && process.env.GITHUB_ACTIONS === "true") {
  const combined = `${stdout}\n${stderr}`.trim();
  // Node's TAP reporter has changed its summary wording across releases. Pick
  // the assertion/test failure lines directly so a platform-only failure is
  // diagnosable from the check annotation even when the full log is gated.
  const lines = combined.split(/\r?\n/);
  const failureLines = lines.filter((line) =>
    /(?:^|\s)(?:not ok|✖|AssertionError|TypeError|ReferenceError|Error:|ERR_[A-Z_]+|symbolic|mkfifo)/i.test(line),
  );
  // Coverage failures can be platform-specific even when all tests pass.
  // Keep only rows that contain a sub-100 percentage to identify the source
  // file without flooding the annotation with the complete coverage table.
  const uncoveredRows = lines.filter((line) => {
    const match = line.match(/^\s*ℹ\s+([^|]+)\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
    // The third percentage column is the function/method gate. Branch gaps
    // are intentionally informational and must not be reported as failures.
    return match !== null && Number(match[4]) < 100;
  });
  const detail = [...new Set([...failureLines, ...uncoveredRows])].join("\n").slice(0, 6_000)
    .replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  process.stderr.write(`::error title=Craft unit test failure::${detail}\n`);
}

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
