import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { WorkbenchEvaluations } from "../core/interfaces/workbench-evaluations.ts";
import { EvaluationOutcomeUnknownError } from "../core/evaluation-process.ts";
import { prepareTaskInput } from "craft-eval";

// A real evaluation spawns a host process and runs craft-eval; a fixed 2s poll
// is too short when the whole suite runs in parallel. Wait up to 30s and stop
// as soon as any terminal state is reached, so a genuine failure surfaces fast.
const TERMINAL = new Set(["completed", "failed", "unknown", "cancelled"]);
async function waitSettled(evaluations: { get: (id: string) => { state?: string; error?: unknown } }, id: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!TERMINAL.has(String(evaluations.get(id).state ?? ""))) {
    if (Date.now() > deadline) throw new Error(`evaluation ${id} did not settle within 30s (state: ${String(evaluations.get(id).state)})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("controlled worker preserves context input receipts from the installed evaluator package", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-context-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const evaluations = new WorkbenchEvaluations(store);
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    await writeFile(join(workspace, "host.mjs"), `console.log(JSON.stringify({type:'system',subtype:'init',model:'test-host'})); console.log(JSON.stringify({type:'result',subtype:'success',result:process.argv.at(-1)}));`);
    const context = { id: "candidate-revision", text: "Exact candidate context 中文" }, prompt = "Original held out task";
    const suite = join(root, "suite.json"), subject = join(root, "subject.json"), runtime = join(root, "runtime.json");
    await writeFile(suite, JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "context", subject_kind: "agent", partition: "held_out", sanitized: true, approved_by: "test", cases: [{ id: "task", prompt, checks: [{ id: "exit", kind: "exit_code", equals: 0 }] }] }));
    await writeFile(subject, JSON.stringify({ kind: "agent", id: "context", version: "1", host: { kind: "claude", binary: process.execPath, args_prefix: ["host.mjs"] }, context }));
    await writeFile(runtime, JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "test"]))));
    const created = await evaluations.submit({ operation_id: "context", workspace, suite, subject, runtime });
    const id = String(created.id);
    await waitSettled(evaluations, id);
    assert.equal(evaluations.get(id).state, "completed", String(evaluations.get(id).error ?? ""));
    const result = await evaluations.report(id);
    const report = result.report as { results: Array<{ input_receipt: unknown; verdict: string }> };
    assert.equal(report.results[0]!.verdict, "passed");
    assert.deepEqual(report.results[0]!.input_receipt, prepareTaskInput(prompt, context).receipt);
    assert.equal(evaluations.get(id).evaluator_version, "0.5.0");
    const engine = evaluations.get(id).execution_engine as { kind: string; sha256: string };
    assert.equal(engine.kind, "claude"); assert.match(engine.sha256, /^[a-f0-9]{64}$/u);
    const frozenSubject = join(String(evaluations.get(id).report_root), "subject.json");
    const originalSubject = await readFile(frozenSubject, "utf8");
    await writeFile(frozenSubject, originalSubject.replace("Exact candidate context", "Forged candidate context"));
    await assert.rejects(evaluations.report(id), /inputs changed after reservation/);
    await writeFile(frozenSubject, originalSubject);
    assert.equal(store.list("knowledge_task_effect", 10).length, 0, "A controlled input receipt must not grant Knowledge effect authority");
    const path = join(String(evaluations.get(id).run_directory), "results/task-1.json");
    const saved = JSON.parse(await readFile(path, "utf8")); saved.input_receipt.context_sha256 = "forged"; await writeFile(path, JSON.stringify(saved));
    await assert.rejects(evaluations.report(id), /changed after completion/);
  } finally { await evaluations.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Context receipt audit API authenticates, persists a bounded report and rejects changed retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-context-audit-api-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const evaluations = new WorkbenchEvaluations(store), service = new CraftService(store);
  const origin = "http://localhost:4173", base = "/api/workbench/evaluations";
  const app = new WorkbenchWebApp(service, "token", origin, { evaluations });
  const call = async (method: string, path: string, body?: object, requestOrigin = origin) => app.handleAsync({ method, path, token: "token", origin: requestOrigin, body: body && JSON.stringify(body) });
  try {
    assert.equal((await app.handleAsync({ method: "POST", path: `${base}/context-audit` })).status, 401);
    assert.equal((await call("POST", `${base}/context-audit`, {}, "https://example.com")).status, 403);
    const pack = join(root, "pack.json"), expectations = join(root, "expectations.json");
    const input = { operation_id: "context-audit-api", pack_path: pack, expectations_path: expectations };
    await writeFile(pack, JSON.stringify({ asset_refs: [{ member: "memory", id: "memory-1" }], items: [{ id: "memory-1", content: "private memory body" }], pack_receipt: { partial: false, max_items: 1, max_chars: 500, total_items: 1, total_used_chars: 20 } }));
    await writeFile(expectations, JSON.stringify({ schema: "craft-eval.context-audit.v1", case_id: "api", required_refs: [{ member: "memory", id: "memory-1" }], reference_only_members: ["memory"] }));
    assert.equal((await call("POST", `${base}/context-audit`, { ...input, pack_path: "relative.json" })).status, 422);
    const submitted = await call("POST", `${base}/context-audit`, input);
    assert.equal(submitted.status, 200, submitted.body);
    const body = JSON.parse(submitted.body);
    assert.equal(body.audit.status, "failed", "reference-only violations must stay visible");
    assert.equal(submitted.body.includes("private memory body"), false);
    assert.equal((await call("GET", `${base}/context-audit/${body.audit.id}/report`)).status, 200);
    assert.equal((await call("GET", `${base}/context-audit/${"a".repeat(64)}/report`)).status, 404);
    assert.equal((await call("GET", `${base}/context-audit/not-an-id/report`)).status, 404);
    await writeFile(expectations, JSON.stringify({ schema: "craft-eval.context-audit.v1", case_id: "api", required_refs: [{ member: "knowledge", id: "different" }] }));
    assert.equal((await call("POST", `${base}/context-audit`, input)).status, 422);
  } finally { await evaluations.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("controlled worker classifies unknown and non-Error failures without losing the terminal state", async () => {
  for (const [operation, failure, expectedState, expectedError] of [
    ["non-error", "simulated storage failure", "failed", "evaluation failed"],
    ["unknown-error", new EvaluationOutcomeUnknownError(), "unknown", new EvaluationOutcomeUnknownError().message],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), `workbench-eval-${operation}-`));
    const store = await new CraftStore(craftPaths(join(root, "data"))).open();
    const evaluations = new WorkbenchEvaluations(store);
    try {
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const suite = join(root, "suite.json"), subject = join(root, "subject.json"), runtime = join(root, "runtime.json");
      await writeFile(suite, JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: operation, subject_kind: "software", partition: "development", sanitized: true, cases: [{ id: "exit", argv: [process.execPath, "-e", "process.exit(0)"], checks: [{ id: "exit", kind: "exit_code", equals: 0 }] }] }));
      await writeFile(subject, JSON.stringify({ kind: "software", id: operation, version: "1" }));
      await writeFile(runtime, JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "test"]))));
      const save = store.save.bind(store); let rejectCompletion = true;
      store.save = ((kind: string, id: string, record: Record<string, unknown>) => {
        if (kind === "workbench_evaluation" && record.state === "completed" && rejectCompletion) { rejectCompletion = false; throw failure; }
        return save(kind, id, record);
      }) as typeof store.save;
      const created = await evaluations.submit({ operation_id: operation, workspace, suite, subject, runtime });
      await waitSettled(evaluations, String(created.id));
      assert.equal(evaluations.get(String(created.id)).state, expectedState);
      assert.equal(evaluations.get(String(created.id)).error, expectedError);
    } finally { await evaluations.close(); store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("evaluation API authenticates, freezes inputs, deduplicates, reports and cancels real workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-eval-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const evaluations = new WorkbenchEvaluations(store);
  const service = new CraftService(store);
  const origin = "http://localhost:4173", base = "/api/workbench/evaluations";
  const app = new WorkbenchWebApp(service, "token", origin, { evaluations });
  const call = async (method: string, path: string, body?: object) => app.handleAsync({ method, path, token: "token", origin, body: body && JSON.stringify(body) });
  try {
    assert.equal((await app.handleAsync({ method: "POST", path: base })).status, 401);
    assert.equal((await app.handleAsync({ method: "POST", path: base, token: "token", origin: "https://example.com" })).status, 403);
    assert.equal((await call("GET", `${base}/knowledge-context`)).status, 422);
    assert.equal((await call("GET", `${base}/knowledge-context?retrieval_run_id=missing`)).status, 422);
    assert.equal((await call("POST", `${base}/knowledge-assess`, { retrieval_run_id: "missing", baseline_id: "bad", candidate_id: "bad" })).status, 422);
    assert.equal((await call("POST", `${base}/knowledge-assess`, { retrieval_run_id: "missing", baseline_id: "a".repeat(64), candidate_id: "b".repeat(64) })).status, 422);
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const suite = join(root, "suite.json"), subject = join(root, "subject.json"), runtime = join(root, "runtime.json");
    const input = { operation_id: "first", suite, subject, runtime, workspace };
    const saveSuite = (code: string) => writeFile(suite, JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "api", subject_kind: "software", partition: "development", sanitized: true, cases: [{ id: "exit", argv: [process.execPath, "-e", code], checks: [{ id: "status", kind: "exit_code", equals: 0 }] }] }));
    await saveSuite("process.exit(0)");
    await writeFile(subject, JSON.stringify({ kind: "software", id: "api", version: "1" }));
    await writeFile(runtime, JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "test"]))));
    const created = await call("POST", base, input); assert.equal(created.status, 202, created.body);
    const id = JSON.parse(created.body).evaluation.id;
    assert.equal(JSON.parse((await call("POST", base, input)).body).evaluation.id, id);
    await saveSuite("process.exit(1)");
    assert.equal((await call("POST", base, input)).status, 422);
    await waitSettled(evaluations, id);
    assert.equal(evaluations.get(id).state, "completed", String(evaluations.get(id).error ?? ""));
    const report = await call("GET", `${base}/${id}/report`);
    assert.equal(report.status, 200, report.body); assert.equal(JSON.parse(report.body).report.passed, 1);
    const receipt = evaluations.get(id);
    assert.equal(receipt.evaluator_version, "0.5.0");
    assert.equal(receipt.node_version, process.versions.node);
    assert.equal(JSON.parse(report.body).integrity, "verified_against_controlled_run");
    const resultPath = join(String(receipt.run_directory), "results/exit-1.json");
    const originalResult = await readFile(resultPath, "utf8");
    const altered = JSON.parse(originalResult); altered.verdict = "failed";
    await writeFile(resultPath, JSON.stringify(altered));
    assert.equal((await call("GET", `${base}/${id}/report`)).status, 422);
    await writeFile(resultPath, originalResult);
    const snapshotPath = join(String(receipt.report_root), "controlled-report.json");
    const originalSnapshot = await readFile(snapshotPath, "utf8");
    await writeFile(snapshotPath, JSON.stringify({ passed: 999 }));
    assert.equal((await call("GET", `${base}/${id}/report`)).status, 422);
    await writeFile(snapshotPath, originalSnapshot);
    assert.equal((await call("GET", `${base}/${id}/report`)).status, 200);
    assert.equal((await call("GET", `${base}/${id}/events`)).status, 200);
    assert.equal((await call("GET", `${base}/${id}`)).status, 200);
    assert.equal((await call("POST", `${base}/${id}/cancel`)).status, 422);
    await saveSuite("process.exit(0)");
    await writeFile(subject, JSON.stringify({ kind: "software", id: "api", version: "2" }));
    const candidate = JSON.parse((await call("POST", base, { ...input, operation_id: "candidate" })).body).evaluation.id;
    await waitSettled(evaluations, candidate);
    assert.equal(evaluations.get(candidate).state, "completed", String(evaluations.get(candidate).error ?? ""));
    assert.equal((await call("POST", `${base}/compare`, { baseline_id: id, candidate_id: id })).status, 422);
    assert.equal((await call("POST", `${base}/compare`, { baseline_id: "bad", candidate_id: candidate })).status, 422);
    const planPath = join(String(receipt.run_directory), "plan.json");
    const originalPlan = await readFile(planPath, "utf8");
    const editedPlan = JSON.parse(originalPlan); editedPlan.runtime.environment_digest = "changed";
    await writeFile(planPath, JSON.stringify(editedPlan));
    assert.equal((await call("GET", `${base}/${id}/report`)).status, 422);
    assert.equal((await call("POST", `${base}/compare`, { baseline_id: id, candidate_id: candidate })).status, 422);
    await writeFile(planPath, originalPlan);
    const comparison = await call("POST", `${base}/compare`, { baseline_id: id, candidate_id: candidate });
    assert.equal(comparison.status, 200, comparison.body);
    const result = JSON.parse(comparison.body).comparison;
    assert.equal(result.metrics.measured_pairs, 1); assert.equal(result.metrics.ties, 1);
    assert.equal(result.knowledge_promotion_authorized, false);
    assert.equal(JSON.parse((await call("POST", `${base}/compare`, { baseline_id: id, candidate_id: candidate })).body).idempotent, true);
    const candidateRecord = evaluations.get(candidate);
    store.save("workbench_evaluation", candidate, { ...candidateRecord, evaluator_version: "different" });
    assert.equal((await call("POST", `${base}/compare`, { baseline_id: id, candidate_id: candidate })).status, 422);
    store.save("workbench_evaluation", candidate, candidateRecord);

    await saveSuite("setInterval(() => {}, 1000)");
    const second = JSON.parse((await call("POST", base, { ...input, operation_id: "second" })).body).evaluation.id;
    assert.equal((await call("POST", `${base}/${second}/cancel`)).status, 200);
    await evaluations.close();
    assert.equal(evaluations.get(second).state, "cancelled");
    assert.equal((await call("POST", base, { ...input, operation_id: "third" })).status, 422);
  } finally { await evaluations.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
