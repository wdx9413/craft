import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { EngineeringEvaluationRunner, loadEngineeringEvaluationCases, validateEvaluationCommand, workspaceSnapshotDigest } from "../capability/engineering-evaluation-runner.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";

test("Engineering evaluation fixtures only admit declared Node argv arrays inside their fixture root", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-engineering-eval-fixture-"));
  try {
    await writeFile(join(root, "cases.json"), JSON.stringify({ version: 1, cases: [{ id: "bug-fix-shared-caller-01", task: "repair", workspace: "workspace", allowed_paths: ["lib"], acceptance: ["node", "verify.mjs"], siblings: [["node", "sibling-a.mjs"], ["node", "sibling-b.mjs"]] }] }));
    const cases = await loadEngineeringEvaluationCases(root);
    assert.equal(cases.length, 1);
    assert.deepEqual(cases[0]!.acceptance, ["node", "verify.mjs"]);
    assert.throws(() => validateEvaluationCommand(["sh", "-c", "node verify.mjs"]), /Node argv/u);
    assert.throws(() => validateEvaluationCommand(["node", "../escape.mjs"]), /relative/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Engineering evaluation fixture loader fails closed on malformed declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-engineering-eval-invalid-"));
  const valid = { id: "bug-fix-shared-caller-01", task: "repair", workspace: "workspace", allowed_paths: ["lib"], acceptance: ["node", "verify.mjs"], siblings: [["node", "a.mjs"], ["node", "b.mjs"]] };
  try {
    const reject = async (value: unknown) => { await writeFile(join(root, "cases.json"), typeof value === "string" ? value : JSON.stringify(value)); await assert.rejects(loadEngineeringEvaluationCases(root)); };
    await reject("{"); await reject(null); await reject([]); await reject({ version: 1, cases: [[]] }); await reject({ version: 2, cases: [valid] }); await reject({ version: 1, cases: [] }); await reject({ version: 1, cases: [valid, valid] });
    for (const changed of [
      { ...valid, id: "bad" }, { ...valid, id: 1 }, { ...valid, task: " " }, { ...valid, task: 1 }, { ...valid, workspace: "../outside" }, { ...valid, workspace: 1 }, { ...valid, allowed_paths: [] }, { ...valid, allowed_paths: ["../outside"] }, { ...valid, siblings: [] }, { ...valid, acceptance: [] }, { ...valid, acceptance: ["node", "/outside"] }, { ...valid, siblings: [["node", "a.mjs"], ["sh", "b.mjs"]] },
    ]) await reject({ version: 1, cases: [changed] });
    for (const command of [[], ["node"], ["node", ""], ["node", "/absolute"], ["node", "../escape"], ["node", "bad;arg"]] as string[][]) assert.throws(() => validateEvaluationCommand(command));
    await writeFile(join(root, "target.json"), JSON.stringify({ version: 1, cases: [valid] })); await rm(join(root, "cases.json")); await symlink(join(root, "target.json"), join(root, "cases.json"));
    await assert.rejects(loadEngineeringEvaluationCases(root), /symbolic/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Engineering evaluation turns host/program failure into rejected evidence instead of a verified result", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-engineering-eval-reject-")); const fixtureRoot = join(root, "fixtures"); await cp(join(dirname(import.meta.filename), "fixtures", "engineering-eval"), fixtureRoot, { recursive: true }); const store = await new CraftStore(craftPaths(root)).open();
  try {
    const runner = new EngineeringEvaluationRunner(store, new CraftService(store), { fixture_root: fixtureRoot, archive_root: join(root, "archive"), model: "test-model", codex_version: "test-codex", environment_fingerprint: "sha256:environment", timeout_ms: 2_000, output_limit: 8_192, trials_per_pair: 5,
      executor: async () => ({ exitCode: 1, signal: null, stderr: "failed", timedOut: false, outputLimited: false, stdout: "not-json" }), program_executor: (() => { let calls = 0; return async () => { calls += 1; if (calls === 1) { await writeFile(join(fixtureRoot, "workspace", "lib", "case-01.mjs"), "export function normalize(value) { return value; }\n"); throw "verifier unavailable"; } throw new Error("verifier unavailable"); }; })(),
    });
    const result = await runner.run(); assert.equal(result.evaluation.status, "rejected"); assert.equal(store.list("engineering_quality_profile_evaluation_record", 1_000).every((record) => record.status === "rejected"), true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Engineering evaluation runner rejects unsafe trees and implicit execution options", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-engineering-eval-options-"));
  const fixtureRoot = join(dirname(import.meta.filename), "fixtures", "engineering-eval");
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    await symlink(join(root, "missing"), join(root, "link"));
    await assert.rejects(workspaceSnapshotDigest(root), /symbolic/u);
    const runner = new EngineeringEvaluationRunner(store, new CraftService(store), { fixture_root: fixtureRoot, archive_root: join(root, "archive"), model: "", codex_version: "test", environment_fingerprint: "sha256:env", timeout_ms: 1, output_limit: 1_024, trials_per_pair: 5 });
    await assert.rejects(runner.run(), /explicit model/u);
    const malformedCases = join(root, "malformed-cases"); await mkdir(malformedCases); await writeFile(join(malformedCases, "cases.json"), JSON.stringify({ version: 1, cases: [{ id: "bug-fix-shared-caller-01", task: "repair", workspace: "workspace", allowed_paths: ["lib"], acceptance: ["node", "verify.mjs"], siblings: [["node", "a.mjs"], ["node", "b.mjs"]] }] }));
    const insufficient = new EngineeringEvaluationRunner(store, new CraftService(store), { fixture_root: malformedCases, archive_root: join(root, "archive"), model: "test", codex_version: "test", environment_fingerprint: "sha256:env", timeout_ms: 1_000, output_limit: 1_024, trials_per_pair: 5 });
    await assert.rejects(insufficient.run(), /exactly 12/u);
    const source = join(root, "source"); const workspace = join(root, "workspace"); await mkdir(join(source, "lib"), { recursive: true }); await mkdir(join(workspace, "lib"), { recursive: true }); await writeFile(join(source, "lib", "target.mjs"), "before\n"); await writeFile(join(workspace, "lib", "target.mjs"), "after\n");
    const privateRunner = runner as unknown as { changedOnlyAllowed(source: string, workspace: string, allowed: readonly string[]): Promise<boolean> };
    assert.equal(await privateRunner.changedOnlyAllowed(source, workspace, ["lib"]), true); assert.equal(await privateRunner.changedOnlyAllowed(source, workspace, ["other"]), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Engineering evaluation runner uses disposable fixture copies and records only complete paired receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-engineering-eval-run-"));
  const fixtureRoot = join(dirname(import.meta.filename), "fixtures", "engineering-eval");
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const runner = new EngineeringEvaluationRunner(store, new CraftService(store), { fixture_root: fixtureRoot, archive_root: join(root, "archive"), model: "test-model", codex_version: "test-codex", environment_fingerprint: "sha256:environment", timeout_ms: 2_000, output_limit: 8_192, trials_per_pair: 5,
      executor: async (request) => { const match = request.stdin.match(/lib\/(case-\d+\.mjs)/u); if (!match) throw new Error("missing fixture target"); await writeFile(join(request.cwd, "lib", match[1]!), "export function normalize(value) { return String(value).trim(); }\n"); return { exitCode: 0, signal: null, stderr: "", timedOut: false, outputLimited: false, stdout: `${JSON.stringify({ type: "thread.started", thread_id: "fixture" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "root cause found" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}` }; },
    });
    const result = await runner.run();
    // The injected executor makes all receipts valid; real elapsed timing is still
    // compared, so this deterministic fake may remain a candidate rejection.
    assert.equal(["shadow_candidate", "rejected"].includes(String(result.evaluation.status)), true);
    assert.equal((store.list("engineering_quality_profile_evaluation_record", 1_000)).length, 120);
    assert.match(result.archive, /engineering-evaluation-/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
