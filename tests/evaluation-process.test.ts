import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { runEvaluationProcess } from "../core/evaluation-process.ts";

test("controlled evaluation rejects result tampering before the final report", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-eval-tamper-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const paths: [string, string, string, string, string] = [join(root, "suite.json"), join(root, "subject.json"), join(root, "runtime.json"), workspace, join(root, "out")];
    const cases = ["first", "second"].map((id, index) => ({ id, argv: [process.execPath, "-e", index ? "setTimeout(() => {}, 300)" : "process.exit(0)"], checks: [{ id: "status", kind: "exit_code", equals: 0 }] }));
    await writeFile(paths[0], JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "tamper", subject_kind: "software", partition: "development", sanitized: true, cases }));
    await writeFile(paths[1], JSON.stringify({ kind: "software", id: "fixture", version: "1" }));
    await writeFile(paths[2], JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "test"]))));
    await assert.rejects(runEvaluationProcess(paths, { on_progress: event => {
      if (event.case_id !== "first") return;
      const resultPath = join(paths[4], event.run_id, "results", "first-1.json");
      const result = JSON.parse(readFileSync(resultPath, "utf8")); result.verdict = "failed";
      writeFileSync(resultPath, JSON.stringify(result));
    } }), /evaluation result evidence does not match report/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("controlled evaluation rejects plan tampering before the final report", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-eval-plan-tamper-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const paths: [string, string, string, string, string] = [join(root, "suite.json"), join(root, "subject.json"), join(root, "runtime.json"), workspace, join(root, "out")];
    const cases = ["first", "second"].map((id, index) => ({ id, argv: [process.execPath, "-e", index ? "setTimeout(() => {}, 300)" : "process.exit(0)"], checks: [{ id: "status", kind: "exit_code", equals: 0 }] }));
    await writeFile(paths[0], JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "plan", subject_kind: "software", partition: "development", sanitized: true, cases }));
    await writeFile(paths[1], JSON.stringify({ kind: "software", id: "fixture", version: "1" }));
    await writeFile(paths[2], JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "test"]))));
    await assert.rejects(runEvaluationProcess(paths, { on_progress: event => {
      if (event.case_id !== "first") return;
      const planPath = join(paths[4], event.run_id, "plan.json");
      const plan = JSON.parse(readFileSync(planPath, "utf8")); plan.runtime.environment_digest = "altered";
      writeFileSync(planPath, JSON.stringify(plan));
    } }), /plan.*(changed|evidence|invalid)/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("controlled evaluation rejects a changed plan restored after report calculation", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-eval-plan-restore-")), previousOptions = process.env.NODE_OPTIONS;
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const paths: [string, string, string, string, string] = [join(root, "suite.json"), join(root, "subject.json"), join(root, "runtime.json"), workspace, join(root, "out")];
    const cases = ["first", "second"].map((id, index) => ({ id, argv: [process.execPath, "-e", index ? "setTimeout(() => {}, 300)" : "process.exit(0)"], checks: [{ id: "status", kind: "exit_code", equals: 0 }] }));
    await writeFile(paths[0], JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "restore", subject_kind: "software", partition: "development", sanitized: true, cases }));
    await writeFile(paths[1], JSON.stringify({ kind: "software", id: "fixture", version: "1" }));
    await writeFile(paths[2], JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "test"]))));
    const preload = join(root, "restore.cjs"), saved = join(root, "plan-original");
    await writeFile(preload, `if (process.argv[1]?.endsWith('craft-evaluation-worker.ts')) { const send = process.send.bind(process), fs = require('node:fs'); process.send = (message, ...args) => { if (message.type === 'result') fs.writeFileSync(require('node:path').join(message.run, 'plan.json'), fs.readFileSync(${JSON.stringify(saved)})); return send(message, ...args); }; }\n`);
    process.env.NODE_OPTIONS = `--require=${preload}`;
    const pending = runEvaluationProcess(paths, { on_progress: event => {
      if (event.case_id !== "first") return;
      const planPath = join(paths[4], event.run_id, "plan.json"), original = readFileSync(planPath, "utf8");
      writeFileSync(saved, original); const plan = JSON.parse(original); plan.runtime.environment_digest = "altered";
      writeFileSync(planPath, JSON.stringify(plan));
    } });
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    await assert.rejects(pending, /plan.*(changed|evidence|invalid)/i);
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    await rm(root, { recursive: true, force: true });
  }
});

test("worker nonzero exit cannot be accepted even after sending a report", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-eval-exit-"));
  const previousOptions = process.env.NODE_OPTIONS;
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const paths: [string, string, string, string, string] = [join(root, "suite.json"), join(root, "subject.json"), join(root, "runtime.json"), workspace, join(root, "out")];
    await writeFile(paths[0], JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "exit", subject_kind: "software", partition: "development", sanitized: true, cases: [{ id: "one", argv: [process.execPath, "-e", "process.exit(0)"], checks: [{ id: "status", kind: "exit_code", equals: 0 }] }] }));
    await writeFile(paths[1], JSON.stringify({ kind: "software", id: "fixture", version: "1" }));
    await writeFile(paths[2], JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "test"]))));
    const preload = join(root, "preload.cjs");
    const marker = join(root, "result-sent");
    await writeFile(preload, `if (process.argv[1]?.endsWith('craft-evaluation-worker.ts')) { const original = process.send.bind(process); process.send = (message, ...args) => { if (message.type === 'result') require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'sent'); return original(message, ...args); }; process.exitCode = 1; }\n`);
    process.env.NODE_OPTIONS = `--require=${preload}`;
    const pending = runEvaluationProcess(paths);
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    await assert.rejects(pending, /without a terminal result/);
    assert.equal(readFileSync(marker, "utf8"), "sent");
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    await rm(root, { recursive: true, force: true });
  }
});

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
