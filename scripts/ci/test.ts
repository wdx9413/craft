import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
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
// The suite intentionally shares one process. A few integration tests
// temporarily replace process globals (fetch and environment variables), so
// keep files deterministic by never executing top-level test files concurrently.
// Coverage is gated separately by `coverage-gates.ts`: it runs each declared
// source/test group in the compatible process shape and enforces 100% line,
// function, and branch coverage. A single aggregate V8 run is known to
// under-report modules with isolated capability assembly, so it is diagnostic
// only and must not turn a passing 100% module gate into a false failure.
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
  const detail = [...new Set(failureLines)].join("\n").slice(0, 6_000)
    .replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  process.stderr.write(`::error title=Craft unit test failure::${detail}\n`);
}

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
