import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tests = readdirSync(resolve(root, "tests"))
  .filter((entry) => entry.endsWith(".test.ts"))
  .sort()
  .map((entry) => `tests/${entry}`);

if (!tests.length) throw new Error("No TypeScript tests were discovered");

const result = spawnSync(process.execPath, [
  "--test",
  "--test-isolation=none",
  "--experimental-test-coverage",
  "--test-coverage-exclude=tests/**",
  "--test-coverage-lines=100",
  "--test-coverage-functions=100",
  "--test-coverage-branches=100",
  ...tests,
], { cwd: root, stdio: "inherit" });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
