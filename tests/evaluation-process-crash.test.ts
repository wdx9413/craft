import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { WorkbenchEvaluations } from "../core/workbench-evaluations.ts";

type Owned = { adapter: number; guardian: number; descendant: number };
const marker = "CRAFT_EVAL_CORE_CRASH_ADAPTER";
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
function ps(pid: number, field: string): string {
  try { return execFileSync("ps", ["-p", String(pid), "-o", field + "="], { encoding: "utf8", timeout: 1_000 }).trim(); }
  catch { return ""; }
}
function running(pid: number): boolean { const state = ps(pid, "stat"); return !!state && !state.startsWith("Z"); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-evaluation-crash-")), workspace = join(root, "project"); await mkdir(workspace);
  const identity = join(root, "owned.json"), starts = join(root, "starts");
  await writeFile(join(workspace, "adapter.mjs"), `import {spawn} from 'node:child_process';import {writeFileSync,appendFileSync} from 'node:fs';
process.title=${JSON.stringify(marker)};const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
appendFileSync(${JSON.stringify(starts)},'x');writeFileSync(${JSON.stringify(identity)},JSON.stringify({adapter:process.pid,guardian:process.ppid,descendant:child.pid}));setInterval(()=>{},1000);`);
  const suite = join(root, "suite.json"), subject = join(root, "subject.json"), runtime = join(root, "runtime.json");
  await writeFile(suite, JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "worker-crash", subject_kind: "software", partition: "development", sanitized: true, cases: [{ id: "one", argv: [process.execPath, "adapter.mjs"], timeout_s: 30, checks: [{ id: "exit", kind: "exit_code", equals: 0 }] }] }));
  await writeFile(subject, JSON.stringify({ kind: "software", id: "worker-crash", version: "1" }));
  await writeFile(runtime, JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "fixed"]))));
  return { root, workspace, suite, subject, runtime, identity, starts };
}
async function ready(path: string): Promise<Owned> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")) as Owned; } catch { await pause(); }
  }
  throw new Error("owned command did not start");
}
async function stopped(owned: Owned): Promise<void> {
  const deadline = Date.now() + 3_000;
  while ((running(owned.adapter) || running(owned.descendant)) && Date.now() < deadline) await pause();
  assert.equal(running(owned.adapter), false); assert.equal(running(owned.descendant), false);
}
function cleanup(owned: Owned | undefined): void {
  if (owned && ps(owned.adapter, "command").includes(marker)) try { process.kill(-owned.adapter, "SIGKILL"); } catch { /* Already cleaned. */ }
}

test("worker SIGKILL becomes unknown and an identical controlled operation never replays", { skip: process.platform === "win32" }, async () => {
  const f = await fixture(), store = await new CraftStore(craftPaths(join(f.root, "data"))).open(), evaluations = new WorkbenchEvaluations(store);
  let owned: Owned | undefined;
  try {
    const args = { operation_id: "crash-once", workspace: f.workspace, suite: f.suite, subject: f.subject, runtime: f.runtime };
    const record = await evaluations.submit(args), id = String(record.id);
    owned = await ready(f.identity);
    const worker = Number(ps(owned.guardian, "ppid"));
    assert.equal(Number(ps(worker, "ppid")), process.pid, "only kill this test's direct worker");
    assert.match(ps(worker, "command"), /craft-evaluation-worker\.ts/);
    process.kill(worker, "SIGKILL");
    const deadline = Date.now() + 5_000;
    while (evaluations.get(id).state !== "unknown" && Date.now() < deadline) await pause();
    assert.equal(evaluations.get(id).state, "unknown");
    assert.match(String(evaluations.get(id).error), /without a terminal result/);
    const duplicate = await evaluations.submit(args); assert.equal(duplicate.id, id); assert.equal(duplicate.state, "unknown");
    assert.equal(await readFile(f.starts, "utf8"), "x");
    await assert.rejects(evaluations.report(id), /report is not available/);
    await stopped(owned);
  } finally { await evaluations.close(); cleanup(owned); store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Craft IPC disconnect aborts the worker, reaps commands and exits without an IPC error", { skip: process.platform === "win32" }, async () => {
  const f = await fixture(); let owned: Owned | undefined;
  const worker = fork(new URL("../bin/craft-evaluation-worker.ts", import.meta.url), [], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exit = new Promise<number | null>(resolve => worker.once("exit", resolve));
  try {
    worker.send({ type: "run", paths: [f.suite, f.subject, f.runtime, f.workspace, join(f.root, "out")], options: {} });
    owned = await ready(f.identity);
    worker.disconnect();
    assert.equal(await exit, 0); await stopped(owned);
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); await exit; cleanup(owned); await rm(f.root, { recursive: true, force: true }); }
});
