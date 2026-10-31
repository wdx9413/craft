import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";

const samples = Number(process.argv[2] ?? 100);
assert.ok(Number.isSafeInteger(samples) && samples >= 20 && samples <= 200, "samples must be 20..200");
const bundle = resolve(process.argv[3] ?? "dist/plugin/craft-codex-hook.cjs");
const fingerprint = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bundleDigest = fingerprint(await readFile(bundle));
const startedAt = new Date().toISOString();
const root = await mkdtemp(join(tmpdir(), "craft-hook-latency-")), data = join(root, "data"), repository = join(root, "repo");
assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
const store = await new CraftStore(craftPaths(data)).open(); store.close();
const marker = "benchmark-only prompt must not appear in timing records";
const events = [
  ["SessionStart", {}], ["UserPromptSubmit", { prompt: marker }],
  ["PostToolUse.noop", { tool_name: "Bash", tool_input: { command: "pwd" } }],
  ["PostToolUse.edit", { tool_name: "Edit" }], ["Stop", {}], ["SessionEnd", {}],
] as const;
const timings: Record<string, number[]> = Object.fromEntries(events.map(([name]) => [name, []]));
async function execute(name: string, input: object, iteration: number) {
  const start = performance.now();
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, [bundle, "--member", "context"], { cwd: repository, env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1", CRAFT_DATA_DIR: data }, stdio: ["pipe", "pipe", "pipe"], timeout: 3_000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", reject);
    child.on("close", (code, signal) => { try { assert.equal(signal, null, `${name}: ${stderr}`); assert.equal(code, 0, `${name}: ${stderr}`); JSON.parse(stdout); accept(); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ cwd: repository, session_id: "latency-fixture", tool_use_id: `edit-${iteration}`, hook_event_name: name.split(".")[0], ...input }));
  });
  timings[name]!.push(performance.now() - start);
}
try {
  for (let index = 0; index < samples; index++) {
    for (const [name, input] of events) await execute(name, input, index);
    if ((index + 1) % 10 === 0) console.log(`Completed ${index + 1}/${samples} lifecycle samples`);
  }
  const records: Record<string, unknown>[] = [];
  const directory = join(data, "trace/hook-runtime/v1");
  for (const name of await readdir(directory)) {
    const text = await readFile(join(directory, name), "utf8"); assert.ok(!text.includes(marker));
    for (const line of text.trim().split("\n")) records.push(JSON.parse(line));
  }
  const finished = records.filter(record => record.phase === "finished");
  assert.equal(finished.length, samples * events.length, "Every Hook process needs a completed diagnostic");
  assert.ok(finished.every(record => record.outcome !== "failed" && !record.error_code), "A quiet Hook fallback is not a successful sample");
  const inspection = await new CraftStore(craftPaths(data)).open();
  try {
    assert.equal(inspection.list("context_resolution_receipt", samples + 1).length, samples);
    assert.equal(inspection.list("codex_hook_turn", samples + 1, row => !!row.closed_at && row.has_edit === true).length, samples);
    assert.equal(inspection.events("codex-hook").filter(event => event.event_type === "codex_hook.failed").length, 0);
  } finally { inspection.close(); }
  const summary = Object.fromEntries(Object.entries(timings).map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (p: number) => Math.round(sorted[Math.ceil(p * sorted.length) - 1]!);
    return [name, { samples: sorted.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99), max_ms: Math.round(sorted.at(-1)!), target_met: percentile(0.95) < 500 && percentile(0.99) < 1_000 }];
  }));
  assert.equal(fingerprint(await readFile(bundle)), bundleDigest, "Do not replace the Hook bundle during a benchmark");
  const receipt = { scope: "local synthetic lifecycle, cold process with persistent isolated datastore", node: process.version, platform: process.platform, bundle, bundle_sha256: bundleDigest, started_at: startedAt, finished_at: new Date().toISOString(), root, summary };
  await writeFile(join(root, "latency.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
  if (Object.values(summary).some(item => !item.target_met)) process.exitCode = 1;
} catch (error) {
  console.error(`Hook benchmark failed; retained isolated evidence at ${root}`); throw error;
}
