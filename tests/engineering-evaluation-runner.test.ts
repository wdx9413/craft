import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { EngineeringEvaluationRunner, loadEngineeringEvaluationCases, validateEvaluationCommand, workspaceSnapshotDigest } from "../capability/engineering-evaluation-runner.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
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
  const workspaces: string[] = [];
  try {
    const runner = new EngineeringEvaluationRunner(store, new CraftService(store), { fixture_root: fixtureRoot, archive_root: join(root, "archive"), model: "test-model", codex_version: "test-codex", environment_fingerprint: "sha256:environment", timeout_ms: 2_000, output_limit: 8_192, trials_per_pair: 5,
      executor: async (request) => { workspaces.push(request.cwd); const match = request.stdin.match(/lib\/(case-\d+\.mjs)/u); if (!match) throw new Error("missing fixture target"); await writeFile(join(request.cwd, "lib", match[1]!), "export function normalize(value) { return String(value).trim(); }\n"); return { exitCode: 0, signal: null, stderr: "", timedOut: false, outputLimited: false, stdout: `${JSON.stringify({ type: "thread.started", thread_id: "fixture" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "root cause found" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}` }; },
    });
    const result = await runner.run();
    // Reproducing a defect is not a root-cause proof. Internal retries and money
    // are not measured by this CLI stream, even when all fixture programs pass.
    assert.equal(result.evaluation.status, "rejected");
    assert.ok(store.list("engineering_quality_profile_evaluation_record", 1_000).every(record => record.cost_units === "unavailable" && record.retry_count === "unavailable" && record.status === "rejected"));
    assert.equal((store.list("engineering_quality_profile_evaluation_record", 1_000)).length, 120);
    assert.match(result.archive, /engineering-evaluation-/u);
    assert.equal(workspaces.length, 120);
    for (const workspace of workspaces) await assert.rejects(access(dirname(workspace)), { code: "ENOENT" });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("runner interruptions clean owned workspaces, preserve partial receipts and archive a content-free handoff", async (t) => {
  for (const failure of ["snapshot", "receipt", "later-receipt", "archive"] as const) {
    const root = await mkdtemp(join(tmpdir(), "craft-runner-handoff-"));
    const store = await new CraftStore(craftPaths(root)).open();
    const service = new CraftService(store);
    const fixtureRoot = join(dirname(import.meta.filename), "fixtures", "engineering-eval");
    const sourceDigest = await workspaceSnapshotDigest(fixtureRoot);
    const archive = join(root, "archive");
    const workspaces: string[] = [];
    const privateMessage = "private-verifier-output-that-must-not-be-archived";
    const originalImport = service.engineeringQualityProfileVerifiedReceiptImport.bind(service);
    let imports = 0;
    const mocked = t.mock.method(service, "engineeringQualityProfileVerifiedReceiptImport", (args: JsonObject) => {
      imports++;
      if (failure === "later-receipt" && imports === 1) return originalImport(args);
      if (failure === "receipt") throw privateMessage;
      throw new Error(privateMessage);
    });
    try {
      if (failure === "archive") await writeFile(archive, "owned fixture file");
      const runner = new EngineeringEvaluationRunner(store, service, {
        fixture_root: fixtureRoot, archive_root: archive, model: "test-model", codex_version: "test-codex",
        environment_fingerprint: "sha256:environment", timeout_ms: 2_000, output_limit: 8_192, trials_per_pair: 5,
        executor: async (request) => {
          workspaces.push(request.cwd);
          if (failure === "snapshot") await symlink(join(request.cwd, "lib"), join(request.cwd, "invalid-link"), "dir");
          return { exitCode: 0, signal: null, stdout: '{"type":"turn.completed"}', stderr: "", timedOut: false, outputLimited: false };
        },
        program_executor: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, outputLimited: false }),
      });
      await assert.rejects(runner.run(), failure === "archive" ? /EEXIST/ : /Engineering evaluation interrupted; handoff/);
      assert.equal(workspaces.length, failure === "later-receipt" ? 2 : 1, "never start another slot after interruption");
      for (const workspace of workspaces) await assert.rejects(access(dirname(workspace)), { code: "ENOENT" });
      assert.equal(await workspaceSnapshotDigest(fixtureRoot), sourceDigest);
      const plan = store.list("engineering_quality_profile_evaluation_plan", 10)[0]!;
      const handoff = store.get("engineering_quality_profile_rejection", String(plan.runner_handoff_id));
      assert.equal(handoff.handoff_required, true);
      assert.equal(handoff.reason, "runner_interrupted");
      assert.equal(handoff.case_id, "bug-fix-shared-caller-01");
      assert.equal(handoff.trial_index, 1);
      assert.equal(handoff.arm, failure === "later-receipt" ? "profile" : "baseline");
      assert.match(String(handoff.error_digest), /^sha256:[a-f0-9]{64}$/);
      const evaluation = store.list("engineering_quality_profile_evaluation", 10)[0]!;
      assert.equal(evaluation.status, "rejected");
      assert.equal(evaluation.routeable_candidate, false);
      const records = store.list("engineering_quality_profile_evaluation_record", 100);
      assert.equal(records.length, failure === "later-receipt" ? 1 : 0);
      if (failure === "later-receipt") assert.notEqual(plan.rejection_id, handoff.id, "preserve the first receipt rejection too");
      else assert.equal(plan.rejection_id, handoff.id);
      if (failure !== "archive") {
        const archived = await readFile(join(archive, (await readdir(archive))[0]!), "utf8");
        assert.equal(archived.includes(privateMessage), false);
        assert.equal(archived.includes(workspaces[0]!), false);
        assert.equal(JSON.parse(archived).runner_handoff.id, handoff.id);
        assert.equal(JSON.parse(archived).records.length, records.length);
      }
    } finally { mocked.mock.restore(); store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("fixture preparation failure is archived before any Host dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-runner-preparation-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const fixtureRoot = join(root, "fixtures");
  try {
    await mkdir(fixtureRoot);
    await cp(join(dirname(import.meta.filename), "fixtures", "engineering-eval", "cases.json"), join(fixtureRoot, "cases.json"));
    let executions = 0;
    const runner = new EngineeringEvaluationRunner(store, new CraftService(store), {
      fixture_root: fixtureRoot, archive_root: join(root, "archive"), model: "fixture", codex_version: "fixture",
      environment_fingerprint: "sha256:fixture", timeout_ms: 1_000, output_limit: 1_024, trials_per_pair: 5,
      executor: async () => { executions++; throw new Error("must not dispatch"); },
    });
    await assert.rejects(runner.run(), /Engineering evaluation interrupted/);
    assert.equal(executions, 0);
    assert.equal(store.list("host_session", 100).length, 0);
    assert.equal(store.list("engineering_quality_profile_evaluation", 10)[0]!.status, "rejected");
    assert.equal((await readdir(join(root, "archive"))).length, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
