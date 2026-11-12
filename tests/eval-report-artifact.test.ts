import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LEDGER_MIN_OBSERVATIONS } from "../core/eval-suite.ts";

const root = mkdtempSync(join(tmpdir(), "craft-eval-report-test-"));

test("a report is written only on request, never overwrites, and carries no credential", () => {
  const reportPath = join(root, "run.json");
  // `datasec` is a kernel-only scope: no model is needed, so this check is
  // offline and fast. It still exercises the real CLI report path.
  const run = (extra: string[] = []) => execFileSync(process.execPath,
    ["--experimental-strip-types", "node_modules/craft-eval/dist/src/suite.js", "datasec", ...extra],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, CRAFT_EVAL_BASE_URL: "" } });

  const withoutReport = run();
  assert.doesNotMatch(withoutReport, /report written/u, "no file is written unless --report is passed");

  const output = run(["--report", reportPath]);
  assert.match(output, /report written/u);
  const artifact = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
  assert.equal(artifact.schema, "craft-eval-run-report.v1");
  assert.equal(artifact.suite_id, "craft.subcapabilities");
  assert.match(String(artifact.suite_digest), /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(artifact.minimum_observations, LEDGER_MIN_OBSERVATIONS);
  assert.equal(artifact.quotable, false, "a kernel-only scope cannot satisfy the behavioural ledgers");
  assert.ok(Array.isArray(artifact.ledgers));
  assert.ok(Array.isArray(artifact.results));
  // Trial ledger: one row per prompted model turn, with cost signals but no
  // raw reply. A kernel-only scope has no model turn, so the ledger is empty.
  assert.ok(Array.isArray(artifact.trials));
  assert.equal((artifact.trials as unknown[]).length, Number(artifact.prompted_turns));
  assert.equal(JSON.stringify(artifact).includes("raw reply"), false);
  assert.equal(typeof artifact.trial_totals, "object");
  assert.equal(artifact.isolation, "shared_local_store_scoped",
    "the report must name its isolation level so a comparator can refuse a different one");
  for (const key of ["api_key_env", "provider", "base_url", "model"]) {
    assert.equal(typeof artifact[key], "string", `${key} is part of the run identity`);
  }
  // The report names the key variable, never its value.
  assert.equal(String(artifact.api_key_env).length > 0, true);
  assert.doesNotMatch(JSON.stringify(artifact), /magpie|replace-with-your-real-key/u);

  // An existing report is never overwritten: the caller must choose a new path,
  // so a baseline cannot be silently replaced by a later candidate run.
  const before = readFileSync(reportPath, "utf8");
  let rejected = false;
  try { run(["--report", reportPath]); } catch { rejected = true; }
  assert.equal(rejected, true);
  assert.equal(readFileSync(reportPath, "utf8"), before);

  // A second explicit path produces a second comparable artifact.
  const secondPath = join(root, "run2.json");
  run(["--report", secondPath]);
  const second = JSON.parse(readFileSync(secondPath, "utf8")) as Record<string, unknown>;
  assert.equal(second.suite_digest, artifact.suite_digest, "same suite scope has the same digest");
  assert.notEqual(second.recorded_at, undefined);
});

test("missing --report value fails fast rather than writing to a guessed path", () => {
  let failed = false;
  try {
    execFileSync(process.execPath,
      ["--experimental-strip-types", "node_modules/craft-eval/dist/src/suite.js", "datasec", "--report"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, CRAFT_EVAL_BASE_URL: "" } });
  } catch { failed = true; }
  assert.equal(failed, true);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
