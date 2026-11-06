import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluationProcess } from "../core/evaluation-process.ts";

test("installed evaluation package executes in a worker and returns progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-eval-integration-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const paths: [string, string, string, string, string] = [join(root, "suite.json"), join(root, "subject.json"), join(root, "runtime.json"), workspace, join(root, "out")];
    const suite = { schema: "craft-eval.eval.v1", suite_id: "integration", subject_kind: "software", partition: "development", sanitized: true, cases: [{ id: "exit", argv: [process.execPath, "-e", "process.exit(0)"], checks: [{ id: "status", kind: "exit_code", equals: 0 }] }] };
    await writeFile(paths[0], JSON.stringify(suite));
    await writeFile(paths[1], JSON.stringify({ kind: "software", id: "fixture", version: "1" }));
    await writeFile(paths[2], JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "test"]))));
    const progress: string[] = [];
    const result = await runEvaluationProcess(paths, { on_progress: event => progress.push(event.case_id) });
    assert.equal(result.report.passed, 1); assert.deepEqual(progress, ["exit"]);
    await assert.rejects(runEvaluationProcess([join(root, "missing"), ...paths.slice(1)] as typeof paths), /ENOENT/);
    const cancelled = new AbortController(); cancelled.abort();
    assert.throws(() => runEvaluationProcess(paths, { signal: cancelled.signal }), /abort/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installed evaluation worker completes when an adapter leaves inherited output pipes open", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-eval-worker-pipes-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    await writeFile(join(workspace, "adapter.mjs"), `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:['ignore','inherit','inherit']});child.unref();`);
    const paths: [string, string, string, string, string] = [join(root, "suite.json"), join(root, "subject.json"), join(root, "runtime.json"), workspace, join(root, "out")];
    await writeFile(paths[0], JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "worker-pipes", subject_kind: "software", partition: "development", sanitized: true, cases: [{ id: "exit", argv: [process.execPath, "adapter.mjs"], timeout_s: 1, checks: [{ id: "status", kind: "exit_code", equals: 0 }] }] }));
    await writeFile(paths[1], JSON.stringify({ kind: "software", id: "fixture", version: "1" }));
    await writeFile(paths[2], JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "test"]))));
    const { report } = await runEvaluationProcess(paths);
    assert.equal(report.passed, 1);
    assert.equal(report.results[0]!.issue, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
