import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { runHeldOutAdapter } from "../deploy/experience-learning/held-out-adapter.ts";
import { safeWorkerErrorClass, learningWorkFound, runOnce, runEvaluationOnce, runProgramMemorySubmissionOnce } from "../deploy/experience-learning/worker.ts";

const env = (script: string, timeout = "1000") => ({ ...process.env,
  CRAFT_HELD_OUT_ADAPTER_COMMAND: JSON.stringify([process.execPath, "-e", script]), CRAFT_HELD_OUT_ADAPTER_TIMEOUT_MS: timeout });

test("configured held-out evaluator receives the exact dispatch and returns a report without interpreting prose", async () => {
  assert.equal(await runHeldOutAdapter({}, {}), null);
  const script = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({dispatch:JSON.parse(s).dispatch})))`;
  await runHeldOutAdapter({}, { ...env(script), CRAFT_HELD_OUT_ADAPTER_TIMEOUT_MS: undefined });
  assert.deepEqual(await runHeldOutAdapter({ id: "dispatch", procedure_version: 2 }, env(script)), { dispatch: { id: "dispatch", procedure_version: 2 } });
  for (const value of ["[]", '"shell"', '[""]', '[1]']) await assert.rejects(runHeldOutAdapter({}, { CRAFT_HELD_OUT_ADAPTER_COMMAND: value }), /ConfigurationError/);
  await assert.rejects(runHeldOutAdapter({}, { CRAFT_HELD_OUT_ADAPTER_COMMAND: "invalid" }), /HeldOutAdapterConfigurationError/u);
  for (const timeout of ["0", "NaN", "3600001", "1.5"]) await assert.rejects(runHeldOutAdapter({}, env("process.stdout.write('{}')", timeout)), /ConfigurationError/);
  for (const output of ["null", "[]", "invalid"]) await assert.rejects(runHeldOutAdapter({}, env(`process.stdout.write(${JSON.stringify(output)})`)), /InvalidReport/);
  await assert.rejects(runHeldOutAdapter({}, env("process.exit(1)")), /Failed/);
  await assert.rejects(runHeldOutAdapter({}, env("setTimeout(()=>{},10000)", "10")), /Timeout/);
  await assert.rejects(runHeldOutAdapter({}, env("process.stdout.write('x'.repeat(8000000))")), /OutputLimit/);
  await assert.rejects(runHeldOutAdapter({}, { CRAFT_HELD_OUT_ADAPTER_COMMAND: '["/missing/held-out-adapter"]' }), /Unavailable|InputError/);
});

test("worker records a signed report through the existing verifier before advancing its exact dispatch", async () => {
  const calls: string[] = [];
  const script = 'process.stdout.write(JSON.stringify({contract_id:"contract",evaluation_id:"evaluation",evaluator_signature:"fixture-signature"}))';
  const client = { async call(name: string) {
    calls.push(name);
    if (name === "craft_experience_learning_evaluation_dispatch_next") return { status: "idle" };
    if (name.endsWith("dispatch_list")) return { dispatches: [{ id: "held-out", stage: "held_out" }] };
    if (name === "craft_evaluation_contract_task_effect_record") return { result: { eligible: true } };
    if (name === "craft_evaluation_contract_get") return { contract: {} };
    if (name === "craft_evaluation_contract_record") return {};
    if (name.endsWith("evaluation_result")) return { dispatch: { status: "passed" } };
    throw new Error(name);
  } };
  assert.equal((await runEvaluationOnce(client, env(script))).processed, 1);
  assert.deepEqual(calls, ["craft_experience_learning_evaluation_dispatch_next", "craft_experience_learning_evaluation_dispatch_list", "craft_evaluation_contract_task_effect_record", "craft_evaluation_contract_get", "craft_evaluation_contract_record", "craft_experience_learning_evaluation_result"]);
  calls.length = 0;
  const rejecting = { async call(name: string) { if (name === "craft_evaluation_contract_task_effect_record") throw new Error("SignatureRejected"); return client.call(name); } };
  const rejected = await runEvaluationOnce(rejecting, env(script));
  assert.equal((rejected.outcomes as {status:string}[])[0]!.status, "retryable");
  assert.equal(calls.includes("craft_experience_learning_evaluation_result"), false);
});

test("background Program Memory submission requires explicit project scopes and uses its local owner port", async () => {
  const client = { async call() { throw new Error("MCP must not mint Host authorization"); } };
  assert.equal((await runProgramMemorySubmissionOnce(client, {})).reason, "waiting_configuration");
  await assert.rejects(runProgramMemorySubmissionOnce(client, { CRAFT_LEARNING_PROJECT_SCOPES: '[{"kind":"global","id":"x"}]' }), /explicit project/);
  const scopes = { CRAFT_LEARNING_PROJECT_SCOPES: '[{"kind":"project","id":"project:test"}]' };
  const calls: string[] = [];
  const result = await runProgramMemorySubmissionOnce(client, scopes, {
    due(scope) { assert.equal(scope.id, "project:test"); return { items: [{ id: "waiting", status: "waiting", }, { id: "ready", status: "ready" }, { id: "bad", status: "ready" }, { id: "shape", status: "ready" }, { id: "missing-procedure", status: "ready" }] }; },
    submit(id) { calls.push(id); if (id === "bad") throw new Error("Unavailable"); if (id === "shape") return { status: "diagnostic" }; if (id === "missing-procedure") return { status: "submitted" }; return { status: "submitted", procedure_id: "procedure" }; },
    dispatch(id) { assert.equal(id, "procedure"); return { dispatch: { id: "shadow" } }; },
  });
  assert.equal(safeWorkerErrorClass("opaque private error", "SubmissionError"), "SubmissionError");
  assert.equal(safeWorkerErrorClass(Object.assign(new Error(), { name: "unsafe-error-name" }), "SubmissionError"), "SubmissionError");
  assert.equal(learningWorkFound({ program_memory_submission: { processed: 1 } }), true);
  assert.equal(result.processed, 4); assert.equal(result.waiting, 1); assert.deepEqual(calls, ["ready", "bad", "shape", "missing-procedure"]);
});


test("held-out malformed adapter identities and missing dispatch statuses remain visible without promotion", async () => {
  for (const report of [{}, { contract_id: "contract", evaluation_id: "evaluation" }]) {
    const result = await runEvaluationOnce({ async call(name) {
      if (name.endsWith("dispatch_list")) return { dispatches: [{ id: "held", stage: "held_out" }] };
      if (name.endsWith("task_effect_record")) return { result: { eligible: false } };
      if (name.endsWith("evaluation_result")) return { dispatch: {} };
      throw new Error(name);
    } }, env(`process.stdout.write(${JSON.stringify(JSON.stringify(report))})`));
    assert.equal((result.outcomes as {status:string}[])[0]!.status, "contract_id" in report ? "unknown" : "retryable");
  }
});

test("submission without its Experience owner waits and malformed project configuration is reported", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-no-experience-"));
  const client = { async call(name: string) {
    if (name === "craft_evaluation_model_ticket_list") return { tickets: [] };
    if (name.endsWith("dispatch_list")) return { dispatches: [] };
    throw new Error(name);
  } };
  try {
    const result = await runProgramMemorySubmissionOnce(client, { ...process.env, CRAFT_DATA_DIR: root,
      CRAFT_LEARNING_PROJECT_SCOPES: '[{"kind":"project","id":"project:test"}]' });
    assert.equal(result.reason, "experience_owner_unavailable");
    const broken = await runOnce({ client, env: { CRAFT_LEARNING_PROJECT_SCOPES: "invalid" } });
    assert.equal((broken.program_memory_submission as {failure_kind:string}).failure_kind, "SyntaxError");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("held-out stage replay uses exact trusted report and follows only structured next dispatch", async () => {
  for (const history of [null, [{ stage: "business_eligible", verification: "trusted", evidence: ["evaluation"] }, { stage: "business_eligible", verification: "trusted", evidence: null }]]) {
    const calls: string[] = [];
    await runEvaluationOnce({ async call(name) {
      calls.push(name);
      if (name.endsWith("dispatch_list")) return { dispatches: [{ id: "held", stage: "held_out" }] };
      if (name.endsWith("task_effect_record")) return { result: { eligible: true } };
      if (name.endsWith("contract_get")) return { contract: { stage_history: history } };
      if (name.endsWith("contract_record")) return {};
      if (name.endsWith("evaluation_result")) return { dispatch: { status: "passed" }, next_dispatch: history === null ? "invalid" : { id: "shadow-next", stage: "shadow" } };
      if (name.endsWith("evaluation_run")) return { dispatch: { status: "passed" } };
      throw new Error(name);
    } }, env('process.stdout.write(JSON.stringify({contract_id:"contract",evaluation_id:"evaluation"}))'));
    assert.equal(calls.includes("craft_evaluation_contract_record"), history === null);
  }
});
