import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");

test("CI packages plugin artifacts before plugin smoke and isolates protected Codex evaluation", async () => {
  const tests = await readFile(join(root, ".github/workflows/test.yml"), "utf8");
  assert.match(tests, /pnpm run build:plugin && pnpm run pack:plugin/u);
  const evaluation = await readFile(join(root, ".github/workflows/engineering-eval.yml"), "utf8");
  assert.match(evaluation, /workflow_dispatch/u); assert.match(evaluation, /refs\/heads\/main/u); assert.match(evaluation, /environment: codex-evals/u);
  assert.match(evaluation, /contents: read/u); assert.match(evaluation, /OPENAI_API_KEY/u); assert.doesNotMatch(evaluation, /pull_request|push:|gh pr|git push/u);
  assert.match(evaluation, /actions\/checkout@[0-9a-f]{40}/u); assert.match(evaluation, /pnpm\/action-setup@[0-9a-f]{40}/u); assert.match(evaluation, /actions\/setup-node@[0-9a-f]{40}/u);
});
