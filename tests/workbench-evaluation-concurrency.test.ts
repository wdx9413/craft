import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import cp from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { WorkbenchEvaluations } from "../core/workbench-evaluations.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}
async function fixture() {
  const EvaluationService: typeof WorkbenchEvaluations = process.env.CRAFT_TEST_EVALUATION_RUNTIME_ROOT
    ? (await import(pathToFileURL(join(process.env.CRAFT_TEST_EVALUATION_RUNTIME_ROOT, "dist/core/workbench-evaluations.js")).href)).WorkbenchEvaluations
    : WorkbenchEvaluations;
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "craft-evaluation-concurrency-"))), workspace = join(root, "project"); await fs.mkdir(workspace);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(), evaluations = new EvaluationService(store);
  const args = { suite: join(root, "suite.json"), subject: join(root, "subject.json"), runtime: join(root, "runtime.json"), workspace };
  async function code(source: string) {
    await fs.writeFile(args.suite, JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "concurrency", subject_kind: "software", partition: "development", sanitized: true,
      cases: [{ id: "one", argv: [process.execPath, "-e", source], timeout_s: 15, checks: [{ id: "exit", kind: "exit_code", equals: 0 }] }] }));
  }
  await code("process.exit(0)"); await fs.writeFile(args.subject, JSON.stringify({ kind: "software", id: "subject", version: "1" }));
  await fs.writeFile(args.runtime, JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "fixed"]))));
  return { root, args, store, evaluations, code, async close() { await evaluations.close(); store.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function complete(f: Fixture, operation_id: string): Promise<JsonObject> {
  const record = await f.evaluations.submit({ ...f.args, operation_id });
  await until(() => !["starting", "running", "cancelling"].includes(String(f.evaluations.get(String(record.id)).state)), "evaluation did not finish");
  const result = f.evaluations.get(String(record.id)); assert.equal(result.state, "completed", String(result.error)); return result;
}

test("concurrent duplicate submissions run once and the fifth active reservation is refused", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const starts = join(f.root, "starts");
    await f.code(`require('node:fs').appendFileSync(${JSON.stringify(starts)},'x');setInterval(()=>{},1000)`);
    const duplicates = await Promise.all(Array.from({ length: 6 }, () => f.evaluations.submit({ ...f.args, operation_id: "same" })));
    assert.equal(new Set(duplicates.map(record => record.id)).size, 1);
    await until(async () => { try { return (await fs.readFile(starts, "utf8")).length === 1; } catch { return false; } }, "first command did not start");
    await Promise.all(["two", "three", "four"].map(operation_id => f.evaluations.submit({ ...f.args, operation_id })));
    await assert.rejects(f.evaluations.submit({ ...f.args, operation_id: "five" }), /capacity reached/);
    assert.equal(f.store.list("workbench_evaluation", 10).length, 4);
    await until(async () => (await fs.readFile(starts, "utf8")).length === 4, "four admitted commands did not start");
    await fs.writeFile(f.args.subject, JSON.stringify({ kind: "software", id: "changed", version: "2" }));
    await assert.rejects(f.evaluations.submit({ ...f.args, operation_id: "same" }), /already bound to different inputs/);
    await f.evaluations.close();
    for (const record of f.store.list("workbench_evaluation", 10)) assert.equal(record.state, "cancelled");
    assert.equal(await fs.readFile(starts, "utf8"), "xxxx");
  } finally { await f.close(); }
});

test("progress retention is bounded while a real worker is active and cancellation settles", { timeout: 15_000 }, async () => {
  const f = await fixture(), original = cp.fork; let worker: ReturnType<typeof cp.fork> | undefined;
  try {
    await f.code("setInterval(()=>{},1000)");
    cp.fork = ((...args: Parameters<typeof cp.fork>) => { worker = original(...args); return worker; }) as typeof cp.fork; syncBuiltinESMExports();
    const record = await f.evaluations.submit({ ...f.args, operation_id: "progress" }), id = String(record.id);
    await until(() => !!worker && f.evaluations.get(id).state === "running", "worker did not start");
    // Inject only progress IPC; the command and cancellation use the real worker.
    for (let index = 0; index < 260; index++) worker!.emit("message", { type: "progress", event: { case_id: `event-${index}`, verdict: "passed" } });
    const events = f.evaluations.events(id).events as JsonObject[];
    assert.equal(events.length, 256); assert.equal(events[0]!.case_id, "event-4"); assert.equal(events.at(-1)!.case_id, "event-259");
    assert.equal(f.evaluations.cancel(id).state, "cancelling");
    await until(() => f.evaluations.get(id).state === "cancelled", "cancel did not settle");
    assert.deepEqual(f.evaluations.events(id).events, []); assert.ok(worker!.exitCode !== null || worker!.signalCode !== null);
  } finally { cp.fork = original; syncBuiltinESMExports(); await f.close(); }
});

test("a configuration growing after stat is refused before reservation", async () => {
  const f = await fixture(), original = fs.open; let changed = false, readBytes = 0, closed = false;
  try {
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const file = await original(...args);
      if (String(args[0]) === f.args.suite) {
        const stat = file.stat.bind(file), read = file.read.bind(file), close = file.close.bind(file);
        file.stat = (async (...options: Parameters<typeof file.stat>) => { const info = await stat(...options); if (!changed) { changed = true; await fs.writeFile(f.args.suite, " ".repeat(4 * 1024 * 1024)); } return info; }) as typeof file.stat;
        file.read = (async (...options: Parameters<typeof file.read>) => { const result = await read(...options); readBytes += result.bytesRead; return result; }) as typeof file.read;
        file.close = async () => { closed = true; await close(); };
      }
      return file;
    }) as typeof fs.open; syncBuiltinESMExports();
    await assert.rejects(f.evaluations.submit({ ...f.args, operation_id: "growing" }), /config exceeds 1 MiB/);
    assert.equal(readBytes, 1024 * 1024 + 1); assert.equal(closed, true);
    assert.equal(f.store.list("workbench_evaluation", 10).length, 0);
  } finally { fs.open = original; syncBuiltinESMExports(); await f.close(); }
});

test("configuration reads handle short reads, enforce the exact byte ceiling and reject non-files", async () => {
  const f = await fixture(), original = fs.open; let shortReads = 0, closed = false;
  try {
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const file = await original(...args);
      if (String(args[0]) === f.args.suite) {
        const read = file.read.bind(file), close = file.close.bind(file);
        file.read = ((buffer: Buffer, offset: number, length: number, position: number) => { shortReads++; return read(buffer, offset, Math.min(length, 7), position); }) as typeof file.read;
        file.close = async () => { closed = true; await close(); };
      }
      return file;
    }) as typeof fs.open; syncBuiltinESMExports();
    await complete(f, "short-reads"); assert.ok(shortReads > 2); assert.equal(closed, true);
    fs.open = original; syncBuiltinESMExports();
    const suite = await fs.readFile(f.args.suite);
    await fs.writeFile(f.args.suite, Buffer.concat([suite, Buffer.alloc(1024 * 1024 - suite.length, 0x20)]));
    await complete(f, "exact-limit");
    await fs.appendFile(f.args.suite, " "); await assert.rejects(f.evaluations.submit({ ...f.args, operation_id: "too-large" }), /exceeds 1 MiB/);
    await assert.rejects(f.evaluations.submit({ ...f.args, suite: f.args.workspace, operation_id: "directory" }), error => /must be a regular file/.test(String(error)) || ["EPERM", "EISDIR"].includes(String((error as NodeJS.ErrnoException).code)));
    assert.equal(f.store.list("workbench_evaluation", 10).length, 2);
  } finally { fs.open = original; syncBuiltinESMExports(); await f.close(); }
});

test("configuration read failure closes its descriptor and creates no execution record", async () => {
  const f = await fixture(), original = fs.open; let closed = false;
  try {
    for (const mode of ["read-failure", "descriptor-type-change"]) {
      closed = false;
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        const file = await original(...args);
        if (String(args[0]) === f.args.suite) {
          const close = file.close.bind(file), stat = file.stat.bind(file);
          if (mode === "descriptor-type-change") file.stat = (async (...options: Parameters<typeof file.stat>) => { const result = await stat(...options); result.isFile = () => false; return result; }) as typeof file.stat;
          else file.read = (async () => { throw new Error("injected configuration read failure"); }) as typeof file.read;
          file.close = async () => { closed = true; await close(); };
        }
        return file;
      }) as typeof fs.open; syncBuiltinESMExports();
      await assert.rejects(f.evaluations.submit({ ...f.args, operation_id: mode }), mode === "read-failure" ? /injected configuration read failure/ : /must be a regular file/);
      assert.equal(closed, true); assert.equal(f.store.list("workbench_evaluation", 10).length, 0);
    }
  } finally { fs.open = original; syncBuiltinESMExports(); await f.close(); }
});

test("report verification keeps the same input budget for frozen configurations", async () => {
  const f = await fixture();
  try {
    const record = await complete(f, "frozen-budget"), id = String(record.id), file = join(String(record.report_root), "runtime.json"), original = await fs.readFile(file);
    await fs.writeFile(file, " ".repeat(4 * 1024 * 1024));
    await assert.rejects(f.evaluations.inputs(id), /config exceeds 1 MiB/);
    await assert.rejects(f.evaluations.report(id), /config exceeds 1 MiB/);
    assert.equal(f.evaluations.get(id).state, "completed");
    await fs.writeFile(file, original); assert.equal((await f.evaluations.report(id)).integrity, "verified_against_controlled_run");
  } finally { await f.close(); }
});

test("a named pipe is rejected without waiting for a writer", { skip: process.platform === "win32", timeout: 5_000 }, async () => {
  const f = await fixture();
  try {
    const pipe = join(f.root, "config-pipe"); cp.execFileSync("mkfifo", [pipe], { timeout: 1_000 });
    await assert.rejects(f.evaluations.submit({ ...f.args, suite: pipe, operation_id: "named-pipe" }), /must be a regular file/);
    assert.equal(f.store.list("workbench_evaluation", 10).length, 0);
  } finally { await f.close(); }
});

test("preparation rejects non-Error failures and early cancellation never starts a worker", async () => {
  const f = await fixture(), original = fs.writeFile;
  try {
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      if (/[\\/]evaluations[\\/][^\\/]+[\\/]suite\.json$/u.test(String(args[0]))) throw "injected non-Error write failure";
      return original(...args);
    }) as typeof fs.writeFile; syncBuiltinESMExports();
    const record = await f.evaluations.submit({ ...f.args, operation_id: "primitive-failure" });
    await until(() => f.evaluations.get(String(record.id)).state === "failed", "preparation did not fail");
    assert.equal(f.evaluations.get(String(record.id)).error, "evaluation failed");
    assert.equal(f.evaluations.get(String(record.id)).execution_engine, undefined);
    fs.writeFile = original; syncBuiltinESMExports();
    const cancelled = await f.evaluations.submit({ ...f.args, operation_id: "cancel-before-preparation" });
    f.evaluations.cancel(String(cancelled.id)); await f.evaluations.close();
    assert.equal(f.evaluations.get(String(cancelled.id)).state, "cancelled");
  } finally { fs.writeFile = original; syncBuiltinESMExports(); await f.close(); }
});

test("cancellation during report persistence cannot become a completed execution", async () => {
  const f = await fixture(), original = fs.writeFile; let id = "", cancelled = false;
  try {
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      if (basename(String(args[0])) === "controlled-report.json") { assert.ok(id); f.evaluations.cancel(id); cancelled = true; }
      return original(...args);
    }) as typeof fs.writeFile; syncBuiltinESMExports();
    const record = await f.evaluations.submit({ ...f.args, operation_id: "late-cancel" }); id = String(record.id);
    await until(() => f.evaluations.get(id).state === "cancelled", "late cancellation did not settle");
    assert.equal(cancelled, true); assert.equal((await f.evaluations.report(id)).integrity, "verified_against_controlled_run");
  } finally { fs.writeFile = original; syncBuiltinESMExports(); await f.close(); }
});

test("a changed engine environment rejects an otherwise completed synthetic agent run", async () => {
  const f = await fixture(), save = f.store.save.bind(f.store), key = "CRAFT_EVALUATION_ENVIRONMENT_RACE_TEST", previous = process.env[key];
  try {
    process.env[key] = "before";
    await fs.writeFile(join(f.args.workspace, "host.mjs"), "console.log(JSON.stringify({type:'system',subtype:'init',model:'synthetic'}));console.log(JSON.stringify({type:'result',subtype:'success',result:'synthetic'}));");
    await fs.writeFile(f.args.suite, JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "environment-change", subject_kind: "agent", partition: "development", sanitized: true,
      cases: [{ id: "one", prompt: "synthetic", checks: [{ id: "exit", kind: "exit_code", equals: 0 }] }] }));
    await fs.writeFile(f.args.subject, JSON.stringify({ kind: "agent", id: "synthetic", version: "1", host: { kind: "claude", binary: process.execPath, args_prefix: ["host.mjs"] } }));
    f.store.save = (kind, id, record) => { if (kind === "workbench_evaluation" && record.state === "running") process.env[key] = "changed"; return save(kind, id, record); };
    const record = await f.evaluations.submit({ ...f.args, operation_id: "changed-environment" });
    await until(() => f.evaluations.get(String(record.id)).state === "failed", "environment change was not rejected");
    assert.match(String(f.evaluations.get(String(record.id)).error), /engine or environment changed during execution/);
  } finally { f.store.save = save; try { await f.close(); } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; } }
});

test("report binding independently rejects changed subject, suite and runtime even with a matching file hash", async () => {
  const f = await fixture();
  try {
    const record = await complete(f, "plan"), id = String(record.id), file = join(String(record.run_directory), "plan.json"), original = await fs.readFile(file);
    for (const field of ["subject", "suite", "runtime"]) {
      const plan = JSON.parse(original.toString());
      if (field === "subject") plan.subject.digest = "different-subject";
      else if (field === "suite") plan.suite_digest = "different-suite";
      else plan.runtime.environment_digest = "different-runtime";
      const changed = JSON.stringify(plan); await fs.writeFile(file, changed);
      f.store.save("workbench_evaluation", id, { ...f.store.get("workbench_evaluation", id), plan_digest: hash(changed) });
      await assert.rejects(f.evaluations.report(id), /does not match reserved inputs/);
    }
    await fs.writeFile(file, original); f.store.save("workbench_evaluation", id, { ...f.store.get("workbench_evaluation", id), plan_digest: record.plan_digest });
    assert.equal((await f.evaluations.report(id)).integrity, "verified_against_controlled_run");
  } finally { await f.close(); }
});

test("comparison rejects plan and result changes between verification and copy and cleans its temporary directory", async () => {
  const f = await fixture(), originalCopy = fs.copyFile;
  try {
    const records = await Promise.all([complete(f, "baseline"), complete(f, "candidate")]);
    for (const part of ["plan.json", "one-1.json"]) {
      const source = join(String(records[0]!.run_directory), part === "plan.json" ? part : "results/" + part), original = await fs.readFile(source); let temporary = "", changed = false;
      try {
        fs.copyFile = (async (...args: Parameters<typeof fs.copyFile>) => {
          if (String(args[0]) === source && !changed) {
            changed = true; temporary = dirname(dirname(String(args[1]))); if (part !== "plan.json") temporary = dirname(temporary);
            const value = JSON.parse(original.toString()); if (part === "plan.json") value.runtime.environment_digest = "changed-during-copy"; else value.duration_ms += 1;
            await fs.writeFile(source, JSON.stringify(value));
          }
          return originalCopy(...args);
        }) as typeof fs.copyFile; syncBuiltinESMExports();
        await assert.rejects(f.evaluations.compare(String(records[0]!.id), String(records[1]!.id)), part === "plan.json" ? /plan changed while freezing/ : /results changed while freezing/);
        assert.equal(changed, true); await assert.rejects(fs.stat(temporary), { code: "ENOENT" });
      } finally { fs.copyFile = originalCopy; syncBuiltinESMExports(); await fs.writeFile(source, original); }
    }
    assert.equal(f.store.list("workbench_evaluation_comparison", 10).length, 0);
  } finally { fs.copyFile = originalCopy; syncBuiltinESMExports(); await f.close(); }
});

test("comparison rejects changed result keys before reading paths outside its frozen result set", async () => {
  const f = await fixture(), originalRead = fs.readFile;
  try {
    const records = await Promise.all([complete(f, "baseline"), complete(f, "candidate")]);
    const file = join(String(records[0]!.report_root), "controlled-report.json"), snapshot = await fs.readFile(file, "utf8");
    for (const value of [{ case_id: "../escape", trial: 1 }, { case_id: "one", trial: 1.5 }, { case_id: "one", trial: 0 }]) {
      let reads = 0;
      fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === file && ++reads === 2) {
          const altered = JSON.parse(snapshot); Object.assign(altered.results[0], value); return JSON.stringify(altered);
        }
        return originalRead(...args);
      }) as typeof fs.readFile; syncBuiltinESMExports();
      await assert.rejects(f.evaluations.compare(String(records[0]!.id), String(records[1]!.id)), /invalid controlled comparison result key/);
      fs.readFile = originalRead; syncBuiltinESMExports();
    }
    assert.equal(f.store.list("workbench_evaluation_comparison", 10).length, 0);
  } finally { fs.readFile = originalRead; syncBuiltinESMExports(); await f.close(); }
});

test("two comparisons crossing the transaction boundary create only one diagnostic receipt", async () => {
  const f = await fixture(), original = f.store.transactionWithRetry.bind(f.store);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  let first: Promise<JsonObject> | undefined;
  try {
    const records = await Promise.all([complete(f, "baseline"), complete(f, "candidate")]); let count = 0;
    f.store.transactionWithRetry = (async (...args: Parameters<typeof f.store.transactionWithRetry>) => { if (++count === 1) { entered(); await held; } return original(...args); }) as typeof f.store.transactionWithRetry;
    const ids = records.map(record => String(record.id)) as [string, string];
    first = f.evaluations.compare(...ids); await ready;
    const second = await f.evaluations.compare(...ids); release();
    const result = await first; assert.equal((result.comparison as JsonObject).id, (second.comparison as JsonObject).id);
    assert.equal(f.store.list("workbench_evaluation_comparison", 10).length, 1);
    assert.equal((result.comparison as JsonObject).knowledge_promotion_authorized, false);
  } finally { release(); await first?.catch(() => undefined); f.store.transactionWithRetry = original; await f.close(); }
});
