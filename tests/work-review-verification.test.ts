import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { DockerSandboxAdapter, type DockerResult } from "../core/docker-sandbox.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { McpServer } from "../core/mcp.ts";
import { reviewVerificationConfiguration, verificationCriteria, taskReviewVerification, verifiedReviewProfile, assertReviewVerificationCheck, FROZEN_VERIFICATION_CRITERION } from "../core/work-review-verification.ts";

const image = `local/checker@sha256:${"a".repeat(64)}`;
const capabilities = { filesystem: "workspace_overlay", network: "denied", features: ["process_isolation", "cancel"], limits: { timeout_ms: 1000, memory_mb: 128, pids: 32, cpu_count: 1 } };
const ok: DockerResult = { code: 0, stdout: "", stderr: "", timed_out: false, output_limited: false };
async function fixture(options: { allowSimulated?: boolean; evidenceMode?: "runtime" | "simulation"; conformanceMode?: "runtime" | "simulation" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "craft-frozen-verification-")), store = await new CraftStore(craftPaths(root)).open();
  const calls: string[][] = []; let mode = "passed", pause: Promise<void> | null = null, started: (() => void) | undefined;
  const adapter = new DockerSandboxAdapter(async argv => {
    calls.push(argv);
    if (argv.includes("sleep 60")) return { ...ok, code: 1, timed_out: true };
    if (argv[0] === "ps") return mode === "residual" ? { ...ok, stdout: "owned-container" } : ok;
    if (argv[0] === "rm") { if (mode === "cleanup-throw") throw new Error("simulated cleanup unavailable"); return ok; }
    if (argv.includes("check-frozen")) {
      const mount = argv[argv.indexOf("--mount") + 1]!; const workspace = mount.slice("type=bind,src=".length).split(",dst=")[0]!;
      assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "frozen bytes");
      await writeFile(join(workspace, "result.txt"), "sandbox-only mutation");
      started?.(); if (pause) await pause;
      if (mode === "throw") throw new Error("simulated transport loss");
      if (mode === "nonerror") throw "simulated non-error loss";
      return mode === "failed" ? { ...ok, code: 1 } : mode === "timeout" ? { ...ok, code: 1, timed_out: true } : mode === "output" ? { ...ok, output_limited: true } : ok;
    }
    return ok;
  }, options.evidenceMode ?? "simulation");
  const service = new CraftService(store, undefined, undefined, adapter);
  service.sandboxProfileSave({ profile_id: "checker", name: "Pinned frozen checker", backend: "container", adapter_id: "docker", capabilities });
  const boundaryService = options.conformanceMode ? new CraftService(store, undefined, undefined, new DockerSandboxAdapter(adapter.runner, options.conformanceMode)) : service;
  await boundaryService.dockerSandboxConformance({ profile_id: "checker", profile_version: 1, image, probe_id: "checker-conformance" });
  const config = { profile_id: "checker", profile_version: 2, image, argv: ["check-frozen"], allow_simulated: options.allowSimulated ?? true };
  const task = service.taskOpen({ title: "Frozen verifier", goal: "Independently verify immutable bytes" }).task as JsonObject;
  service.codexHost.executor = async () => { await writeFile(join(root, "result.txt"), "frozen bytes"); return { exitCode: 0, signal: null, stdout: JSON.stringify({ type: "turn.completed", usage: {} }) + "\n", stderr: "", timedOut: false, cancelled: false, outputLimited: false }; };
  const contract = service.taskControlSave({ task_id: task.id, workspace: root, review_risks: ["data_migration"], review_verification: config }).contract as JsonObject;
  const prepared = service.taskRunPrepare({ task_run_id: "original", contract_id: contract.id, host: "codex-cli", prompt: "produce" });
  const launch = prepared.launch as JsonObject; await service.hostRuns.wait(String(launch.run_id));
  const freezeArgs = (id: string) => ({ candidate_id: id, task_run_id: "original", task_run_version: store.get("task_run", "original").version, launch_version: store.get("work_launch", String(launch.id)).version, host_run_version: store.get("host_run", String(launch.run_id)).version, plan_version: store.get("acceptance_plan", String(launch.acceptance_plan_id)).version, criterion_id: "risk_independent_review", actor: "worker", relative_paths: ["result.txt"] });
  const candidate = service.workReviewFreeze(freezeArgs("candidate")).candidate as JsonObject;
  const prepareArgs = { candidate_id: candidate.id, candidate_version: candidate.version, actor: "reviewer" };
  const prepare = () => service.workReviewVerificationPrepare(prepareArgs).verification as JsonObject;
  const executeArgs = (job: JsonObject) => ({ verification_id: job.id, verification_version: job.version, actor: "reviewer", confirmed_command: true });
  const verifyCalls = () => calls.filter(argv => argv.includes("check-frozen"));
  return { root, store, service, adapter, config, task, launch, candidate, freezeArgs, prepareArgs, prepare, executeArgs, calls, verifyCalls, setMode: (value: string) => { mode = value; }, hold: (value: Promise<void>, signal: () => void) => { pause = value; started = signal; }, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("frozen-copy check follows HTTP/MCP prepare, explicit execution, evidence and independent delivery", async () => {
  const f = await fixture(); try {
    const web = new WorkbenchWebApp(f.service, "token", "http://localhost");
    const prepared = web.handle({ method: "POST", path: "/api/work-reviews/candidate/verify-prepare", token: "token", body: JSON.stringify({ ...f.prepareArgs, candidate_id: "wrong-body" }) });
    assert.equal(prepared.status, 201); let job = (JSON.parse(String(prepared.body)) as JsonObject).verification as JsonObject;
    assert.equal(f.verifyCalls().length, 0);
    assert.equal((f.service.workReviewVerificationGet({ verification_id: job.id }).verification as JsonObject).current, null);
    assert.throws(() => f.service.acceptanceCheckRecord({ plan_id: f.candidate.plan_id, plan_version: f.candidate.plan_version, criterion_id: FROZEN_VERIFICATION_CRITERION, evaluator_type: "program", evaluator_id: "worker", result: "passed", summary: "self reported", evidence_ids: [f.store.list("evidence")[0]!.id] }), /frozen sandbox verification receipt/);
    assert.throws(() => f.service.workReviewFreeze(f.freezeArgs("another-candidate")), /Stop or reconcile/);
    assert.throws(() => f.service.taskReplanPrepare({ proposal_id: "cannot-replan-inflight", new_task_run_id: "unsafe-next", source_launch_id: f.launch.id, task_version: f.task.version, launch_version: f.launch.version, actor: "worker", change_type: "plan_change", change_summary: "Do not bypass active checker", prompt: "next" }), /Stop or reconcile/);
    assert.throws(() => f.service.workLaunchPrepare({ task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "escape" }), /Stop or reconcile/);
    await assert.rejects(f.service.workReviewVerificationExecute({ ...f.executeArgs(job), confirmed_command: false }), /explicit command/);
    const response = await web.handleAsync({ method: "POST", path: `/api/review-verifications/${job.id}/execute`, token: "token", origin: "http://localhost", body: JSON.stringify(f.executeArgs(job)) });
    assert.equal(response.status, 202); job = (JSON.parse(String(response.body)) as JsonObject).verification as JsonObject;
    const deadline = Date.now() + 5000;
    while (job.status !== "completed" && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); job = f.store.get("work_review_verification", String(job.id)); }
    assert.equal(job.status, "completed");
    assert.equal(job.result, "passed"); assert.equal(job.basis, "simulated_container");
    assert.equal((job.receipt as JsonObject).stale_candidate, false);
    assert.equal(await readFile(join(f.root, "result.txt"), "utf8"), "frozen bytes");
    const file = f.service.workReviewGet({ candidate_id: f.candidate.id, relative_path: "result.txt" }).file as JsonObject;
    assert.equal(Buffer.from(String(file.content_base64), "base64").toString(), "frozen bytes");
    assert.equal((await f.service.workReviewVerificationExecute(f.executeArgs(job))).idempotent, true); assert.equal(f.verifyCalls().length, 1);
    const read = await web.handleAsync({ method: "GET", path: `/api/review-verifications/${job.id}`, token: "token" }); assert.equal(read.status, 200);
    const evidence = f.store.get("evidence", String((job.evidence_ids as string[])[0])); assert.equal(evidence.confidence, "bounded");
    f.service.workReviewReport({ candidate_id: f.candidate.id, candidate_version: f.candidate.version, reviewer: "reviewer", result: "passed", summary: "Independent review of frozen bytes", findings: [] });
    assert.equal((f.service.taskRunRefresh({ task_run_id: "original" }).state as JsonObject).action, "deliver");
    const projected = (f.service.homeTask({ task_id: f.task.id }).work_reviews as JsonObject[])[0]!;
    assert.equal((projected.verification as JsonObject).result, "passed");
    const toolResult = await new McpServer(f.service, "full").handlers.craft_work_review_verification_get({ verification_id: job.id }) as JsonObject;
    assert.equal((toolResult.verification as JsonObject).id, job.id);
    for (const path of [`/api/review-verifications/${job.id}/execute`, `/api/review-verifications/${job.id}/stop`]) {
      assert.equal((await web.handleAsync({ method: "POST", path, body: "{}" })).status, 401);
      assert.equal((await web.handleAsync({ method: "POST", path, token: "token", origin: "http://other", body: "{}" })).status, 403);
    }
  } finally { await f.close(); }
});

test("verifier declarations reject moving images, unsupported fields, weak criteria and conflicting task contracts", async () => {
  assert.equal(reviewVerificationConfiguration(undefined), null); assert.equal(reviewVerificationConfiguration(null), null);
  const base = { profile_id: "p", profile_version: 1, image, argv: ["true"] };
  for (const patch of [{ image: "image:latest" }, { profile_version: "1" }, { profile_version: 0 }, { argv: [] }, { argv: [" "] }, { argv: Array(33).fill("x") }, { argv: ["x".repeat(4097)] }, { argv: Array(5).fill("x".repeat(4096)) }, { argv: ["bad\0arg"] }, { allow_simulated: "true" }, { arbitrary: true }]) assert.throws(() => reviewVerificationConfiguration({ ...base, ...patch }));
  assert.equal(reviewVerificationConfiguration(base)!.allow_simulated, false);
  assert.equal(verificationCriteria(undefined, null), undefined);
  assert.throws(() => verificationCriteria({}, {}), /must be an array/);
  for (const criteria of [[{ id: FROZEN_VERIFICATION_CRITERION, method: "human" }], [{ id: FROZEN_VERIFICATION_CRITERION, method: "program", required: false }], [{ id: FROZEN_VERIFICATION_CRITERION }, { id: FROZEN_VERIFICATION_CRITERION }]]) assert.throws(() => verificationCriteria(criteria, {}), /downgraded/);
  const criteria = [{ id: FROZEN_VERIFICATION_CRITERION, method: "program" }]; assert.deepEqual(verificationCriteria(criteria, {}), criteria);
  const f = await fixture(); try {
    assert.equal(taskReviewVerification(f.store, "other-task"), null);
    assert.deepEqual(taskReviewVerification(f.store, String(f.task.id)), f.config);
    assert.throws(() => f.service.taskControlSave({ contract_id: "changed", task_id: f.task.id, workspace: f.root, review_risks: ["data_migration"], review_verification: { ...f.config, argv: ["different"] } }), /cannot change/);
    const pastTask = f.service.taskOpen({ title: "Past execution", goal: "No retrospective verifier" }).task as JsonObject;
    f.store.create("work_launch", "past-launch", { task_id: pastTask.id, status: "failed" });
    assert.throws(() => f.service.taskControlSave({ contract_id: "late-check", task_id: pastTask.id, workspace: f.root, review_risks: ["data_migration"], review_verification: f.config }), /before execution/);
    assert.throws(() => f.service.taskControlSave({ contract_id: "no-risk", task_id: f.task.id, workspace: f.root, review_verification: f.config }), /declared review risk/);
    f.store.create("task_control_contract", "conflict", { task_id: f.task.id, review_verification: { ...f.config, argv: ["different"] } });
    assert.throws(() => taskReviewVerification(f.store, String(f.task.id)), /conflicting/);
    assert.throws(() => verifiedReviewProfile(f.store, { ...f.config, profile_version: 1 }), /current verified/);
  } finally { await f.close(); }
});

test("nonzero, timeout, lost transport and cleanup uncertainty never become a passing verification", async () => {
  for (const mode of ["failed", "timeout", "output", "throw", "nonerror", "residual", "cleanup-throw"]) {
    const f = await fixture(); try {
      f.setMode(mode); const job = f.prepare();
      const result = await f.service.workReviewVerificationExecute(f.executeArgs(job)); const saved = result.verification as JsonObject;
      if (["residual", "cleanup-throw", "timeout", "output", "throw", "nonerror"].includes(mode)) {
        assert.equal(saved.status, "unknown"); assert.equal((await f.service.workReviewVerificationExecute(f.executeArgs(saved))).idempotent, true);
        assert.throws(() => f.service.workReviewFreeze(f.freezeArgs("next")), /Stop or reconcile/);
        f.setMode("passed"); const stopped = await f.service.workReviewVerificationStop({ verification_id: saved.id, verification_version: saved.version, actor: "operator", confirmed_execution_stopped: true });
        assert.equal((stopped.verification as JsonObject).status, "cancelled");
        f.service.workReviewFreeze(f.freezeArgs("next"));
      } else { assert.equal(saved.status, "completed"); assert.equal(saved.result, mode === "throw" || mode === "nonerror" ? "blocked" : "failed"); }
      assert.equal(f.verifyCalls().length, 1);
      assert.notEqual((f.service.taskRunRefresh({ task_run_id: "original" }).state as JsonObject).action, "deliver");
    } finally { await f.close(); }
  }
});

test("stop wins against a late container receipt and stale working bytes cannot pass", async () => {
  for (const action of ["stop", "stop-unknown", "external-stop", "external-unknown", "change", "revoke-profile"]) {
    const f = await fixture(); let release!: () => void, begin!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { begin = resolve; }); f.hold(held, begin);
    try {
      const job = f.prepare(), running = f.service.workReviewVerificationExecute(f.executeArgs(job)); await started;
      assert.equal((await f.service.workReviewVerificationExecute(f.executeArgs(job))).idempotent, true);
      if (action.startsWith("stop")) {
        if (action === "stop-unknown") f.setMode("throw");
        const latest = f.store.get("work_review_verification", String(job.id));
        const stop = await f.service.workReviewVerificationStop({ verification_id: job.id, verification_version: latest.version, actor: "operator" }); assert.equal((stop.verification as JsonObject).status, "stopping");
      } else if (action.startsWith("external")) {
        const current = f.store.get("work_review_verification", String(job.id));
        f.store.save("work_review_verification", String(job.id), { ...current, status: action === "external-stop" ? "cancelled" : "unknown", stopped_by: "simulated-other-controller", cleanup: { passed: true, confirmation_basis: "operator_declaration" } });
      } else if (action === "change") await writeFile(join(f.root, "result.txt"), "changed by user");
      else f.service.sandboxProfileSave({ profile_id: "checker", name: "Changed checker", backend: "container", adapter_id: "docker", capabilities });
      release(); const result = await running, saved = result.verification as JsonObject;
      assert.equal(saved.status, action === "stop" || action.startsWith("external") ? "cancelled" : action === "stop-unknown" ? "unknown" : "completed"); if (action === "change" || action === "revoke-profile") assert.equal(saved.result, "blocked");
      assert.equal(f.verifyCalls().length, 1);
      assert.equal(f.store.list("acceptance_check", 100, check => check.criterion_id === FROZEN_VERIFICATION_CRITERION).length, 0);
    } finally { release(); await f.close(); }
  }
});

test("verification rejects stale versions, self review, unproven profiles and fabricated acceptance receipts", async (t) => {
  const f = await fixture(); try {
    assert.throws(() => f.service.workReviewVerificationPrepare({ ...f.prepareArgs, candidate_version: 999 }), /candidate version/);
    assert.throws(() => f.service.workReviewVerificationPrepare({ ...f.prepareArgs, actor: "worker" }), /independent reviewer/);
    f.store.create("task_assignment", `task_assignment_${f.task.id}`, { status: "active", owner: "reviewer" });
    assert.throws(() => f.prepare(), /independent reviewer/);
    f.store.save("task_assignment", `task_assignment_${f.task.id}`, { status: "released", owner: "reviewer" });
    const originalGet = f.store.get.bind(f.store);
    const withoutContract = t.mock.method(f.store, "get", (...args: Parameters<typeof f.store.get>) => args[0] === "work_launch" ? { ...originalGet(...args), review_verification: undefined } : originalGet(...args));
    assert.throws(() => f.prepare(), /not declared/); withoutContract.mock.restore();
    const profile = f.store.get("sandbox_profile", "checker"), assessment = f.store.get("sandbox_assessment", String(profile.assessment_id)), evidence = f.store.get("evidence", String((profile.evidence_ids as string[])[0]));
    for (const patch of [{ kind: "sandbox_assessment", values: { verifier: "operator" } }, { kind: "sandbox_assessment", values: { status: "failed" } }, { kind: "evidence", values: { source_type: "human" } }, { kind: "evidence", values: { record_origin: "caller_asserted" } }, { kind: "evidence", values: { artifact_id: null } }, { kind: "evidence", values: { confidence: "rejected" } }, { kind: "evidence", values: { metadata: { revoked: true } } }, { kind: "artifact", values: { kind: "untrusted" } }, { kind: "artifact", values: { metadata: { image: "wrong" } } }]) {
      const changed = t.mock.method(f.store, "get", (...args: Parameters<typeof f.store.get>) => args[0] === patch.kind ? { ...originalGet(...args), ...patch.values } : originalGet(...args));
      assert.throws(() => verifiedReviewProfile(f.store, f.config), /Docker conformance/); changed.mock.restore();
    }
    assert.ok(assessment); assert.ok(evidence);
    const job = f.prepare(); assert.equal(f.service.workReviewVerificationPrepare(f.prepareArgs).idempotent, true);
    assert.throws(() => f.service.workReviewVerificationPrepare({ ...f.prepareArgs, actor: "other" }), /assigned/);
    await assert.rejects(f.service.workReviewVerificationExecute({ ...f.executeArgs(job), actor: "other" }), /another reviewer/);
    await assert.rejects(f.service.workReviewVerificationExecute({ ...f.executeArgs(job), verification_version: 999 }), /exact version/);
    await assert.rejects(f.service.workReviewVerificationStop({ verification_id: job.id, verification_version: 999, actor: "operator" }), /version changed/);
    assert.throws(() => assertReviewVerificationCheck(f.store, { criterion_id: FROZEN_VERIFICATION_CRITERION, verification_id: job.id }, f.store.get("work_launch", String(f.launch.id))), /receipt/);
    const stopped = await f.service.workReviewVerificationStop({ verification_id: job.id, verification_version: job.version, actor: "operator" });
    const saved = stopped.verification as JsonObject;
    assert.equal((await f.service.workReviewVerificationStop({ verification_id: saved.id, verification_version: saved.version, actor: "operator" })).idempotent, true);
    assert.equal(f.verifyCalls().length, 0);
  } finally { await f.close(); }
});

test("simulation needs prior opt-in and runtime receipts preserve their distinct evidence basis", async () => {
  for (const mode of ["simulation", "runtime"] as const) {
    const f = await fixture({ allowSimulated: false, evidenceMode: mode, conformanceMode: "runtime" }); try {
      const job = f.prepare();
      if (mode === "simulation") await assert.rejects(f.service.workReviewVerificationExecute(f.executeArgs(job)), /does not permit simulated/);
      else {
        const result = await f.service.workReviewVerificationExecute(f.executeArgs(job)), saved = result.verification as JsonObject;
        assert.equal(saved.basis, "docker_runtime"); assert.equal((result.evidence as JsonObject).confidence, "confirmed");
      }
    } finally { await f.close(); }
  }
});

test("copy staging is cancellable and start authorization is checked again immediately before Docker", async (t) => {
  for (const phase of ["staging", "stopping", "before-start"]) {
    const f = await fixture(); let unblock!: () => void, entered!: () => void, stopping: Promise<JsonObject> | undefined;
    const held = new Promise<void>(resolve => { unblock = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    try {
      const job = f.prepare();
      let injected: { mock: { restore(): void } };
      if (phase !== "before-start") {
        const originalWrite = fsPromises.writeFile;
        injected = t.mock.method(fsPromises, "writeFile", async (...args: Parameters<typeof fsPromises.writeFile>) => {
          const result = await originalWrite(...args);
          if (String(args[0]).includes(String(job.scratch_name))) { entered(); await held; }
          return result;
        }); syncBuiltinESMExports();
      } else {
        const originalExecute = f.adapter.execute.bind(f.adapter);
        injected = t.mock.method(f.adapter, "execute", (args: JsonObject, beforeStart?: () => void) => originalExecute(args, () => {
          const current = f.store.get("work_review_verification", String(job.id)); stopping = f.service.workReviewVerificationStop({ verification_id: current.id, verification_version: current.version, actor: "operator" }); beforeStart!();
        }));
      }
      const execution = f.service.workReviewVerificationExecute(f.executeArgs(job));
      if (phase !== "before-start") {
        await reached; const current = f.store.get("work_review_verification", String(job.id));
        if (phase === "stopping") {
          const originalRunner = f.adapter.runner;
          t.mock.method(f.adapter, "runner", async (...args: Parameters<typeof originalRunner>) => { if (args[0][0] === "rm") await held; return originalRunner(...args); });
          stopping = f.service.workReviewVerificationStop({ verification_id: current.id, verification_version: current.version, actor: "operator" });
          unblock();
        } else { await f.service.workReviewVerificationStop({ verification_id: current.id, verification_version: current.version, actor: "operator" }); unblock(); }
      }
      await execution; await stopping; injected!.mock.restore(); syncBuiltinESMExports();
      assert.equal(f.store.get("work_review_verification", String(job.id)).status, "cancelled"); assert.equal(f.verifyCalls().length, 0);
    } finally { unblock(); await stopping; syncBuiltinESMExports(); await f.close(); }
  }
});

test("ambiguous frozen paths and failed stop proofs remain blocked rather than replayed", async () => {
  const f = await fixture(); try {
    const candidate = f.service.workReviewFreeze({ ...f.freezeArgs("aliased"), relative_paths: ["result.txt", "./result.txt"] }).candidate as JsonObject;
    const job = f.service.workReviewVerificationPrepare({ candidate_id: candidate.id, candidate_version: candidate.version, actor: "reviewer" }).verification as JsonObject;
    const result = await f.service.workReviewVerificationExecute(f.executeArgs(job)); assert.equal((result.verification as JsonObject).result, "blocked"); assert.equal(f.verifyCalls().length, 0);
  } finally { await f.close(); }
  for (const mode of ["residual", "cleanup-throw"]) {
    const f = await fixture(); try {
      const job = f.prepare(); f.setMode(mode);
      const stopped = await f.service.workReviewVerificationStop({ verification_id: job.id, verification_version: job.version, actor: "operator" });
      assert.equal((stopped.verification as JsonObject).status, "unknown");
    } finally { await f.close(); }
  }
});

test("receipt persistence failures do not replay work and revoked verification evidence blocks reassessment", async (t) => {
  const f = await fixture(); try {
    const job = f.prepare(), save = f.store.save.bind(f.store);
    const failed = t.mock.method(f.store, "save", (...args: Parameters<typeof f.store.save>) => { const saved = save(...args); if (args[0] === "work_review_verification" && args[2].evidence_ids) throw new Error("simulated verification receipt persistence failure"); return saved; });
    await assert.rejects(f.service.workReviewVerificationExecute(f.executeArgs(job)), /persistence failure/); failed.mock.restore();
    const pending = f.store.get("work_review_verification", String(job.id)); assert.equal(pending.status, "running");
    assert.equal((await f.service.workReviewVerificationExecute(f.executeArgs(pending))).idempotent, true); assert.equal(f.verifyCalls().length, 1);
    assert.equal(f.store.find("evidence", `evidence_${job.id}`), null);
    await f.service.workReviewVerificationStop({ verification_id: pending.id, verification_version: pending.version, actor: "operator" });
    const next = f.service.workReviewFreeze(f.freezeArgs("fresh-after-recovery")).candidate as JsonObject;
    const newJob = f.service.workReviewVerificationPrepare({ candidate_id: next.id, candidate_version: next.version, actor: "reviewer" }).verification as JsonObject;
    const result = await f.service.workReviewVerificationExecute(f.executeArgs(newJob)), evidence = result.evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, metadata: { ...(evidence.metadata as JsonObject), revoked: true } });
    f.service.workReviewReport({ candidate_id: next.id, candidate_version: next.version, reviewer: "reviewer", result: "passed", summary: "Review cannot override revoked verifier evidence", findings: [] });
    assert.equal((f.service.acceptanceAssess({ plan_id: next.plan_id }).assessment as JsonObject).status, "blocked");
    assert.equal((f.service.workReviewVerificationGet({ verification_id: newJob.id }).verification as JsonObject).current, false);
    assert.notEqual((f.service.taskRunRefresh({ task_run_id: "original" }).state as JsonObject).action, "deliver");
  } finally { await f.close(); }
});

test("lost controllers and unknown dispatches need an explicit stop declaration after residual checks", async () => {
  const f = await fixture(); try {
    const job = f.prepare();
    const lost = f.store.save("work_review_verification", String(job.id), { ...job, status: "running", execution_owner: "simulated-prior-process" });
    const first = await f.service.workReviewVerificationStop({ verification_id: lost.id, verification_version: lost.version, actor: "operator" });
    assert.equal((first.verification as JsonObject).status, "unknown");
    assert.equal(((first.verification as JsonObject).cleanup as JsonObject).controller_settled, false);
    const current = first.verification as JsonObject;
    const stopped = await f.service.workReviewVerificationStop({ verification_id: current.id, verification_version: current.version, actor: "operator", confirmed_execution_stopped: true });
    assert.equal((stopped.verification as JsonObject).status, "cancelled");
    assert.equal(((stopped.verification as JsonObject).cleanup as JsonObject).confirmation_basis, "operator_declaration");
    assert.equal(f.verifyCalls().length, 0);
  } finally { await f.close(); }
});

test("a late stop proof cannot overwrite a newer cancelled observation", async (t) => {
  const f = await fixture(); let releaseRun!: () => void, releaseCleanup!: () => void, begin!: () => void;
  const runHeld = new Promise<void>(resolve => { releaseRun = resolve; }), cleanupHeld = new Promise<void>(resolve => { releaseCleanup = resolve; }), started = new Promise<void>(resolve => { begin = resolve; });
  f.hold(runHeld, begin);
  try {
    const job = f.prepare(), execution = f.service.workReviewVerificationExecute(f.executeArgs(job)); await started;
    const original = f.adapter.runner; let first = true;
    t.mock.method(f.adapter, "runner", async (...args: Parameters<typeof original>) => { if (args[0][0] === "rm" && first) { first = false; await cleanupHeld; } return original(...args); });
    const current = f.store.get("work_review_verification", String(job.id));
    const stop = f.service.workReviewVerificationStop({ verification_id: current.id, verification_version: current.version, actor: "operator" });
    releaseRun(); const result = await execution; assert.equal((result.verification as JsonObject).status, "cancelled");
    releaseCleanup(); const stopped = await stop; assert.equal(stopped.idempotent, true); assert.equal((stopped.verification as JsonObject).status, "cancelled");
  } finally { releaseRun(); releaseCleanup(); await f.close(); }
});

test("a copy I/O failure records bounded blocked evidence without starting a container", async (t) => {
  const f = await fixture(); let injected: { mock: { restore(): void } } | undefined;
  try {
    const job = f.prepare(), original = fsPromises.writeFile;
    injected = t.mock.method(fsPromises, "writeFile", async (...args: Parameters<typeof fsPromises.writeFile>) => { if (String(args[0]).includes(String(job.scratch_name))) throw "simulated copy I/O error"; return original(...args); }); syncBuiltinESMExports();
    const result = await f.service.workReviewVerificationExecute(f.executeArgs(job));
    assert.equal((result.verification as JsonObject).result, "blocked"); assert.equal(((result.verification as JsonObject).receipt as JsonObject).error_class, "NonErrorThrow"); assert.equal(f.verifyCalls().length, 0);
  } finally { injected?.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});

test("corrupted scratch identities cannot escape through staging or cleanup", async () => {
  const f = await fixture(); try {
    const job = f.prepare();
    const corrupt = f.store.save("work_review_verification", String(job.id), { ...job, scratch_name: "../../user-workspace" });
    await assert.rejects(f.service.workReviewVerificationExecute(f.executeArgs(corrupt)), /scratch identity/);
    await assert.rejects(f.service.workReviewVerificationStop({ verification_id: corrupt.id, verification_version: corrupt.version, actor: "operator" }), /scratch identity/);
    assert.equal(f.store.get("work_review_verification", String(job.id)).status, "prepared"); assert.equal(f.verifyCalls().length, 0);
  } finally { await f.close(); }
});

test("background start exposes a durable phase and converts receipt loss to unknown without replay", async (t) => {
  const f = await fixture(); try {
    const job = f.prepare();
    await assert.rejects(f.service.workReviewVerificationStart({ ...f.executeArgs(job), confirmed_command: false }), /confirmation/);
    const save = f.store.save.bind(f.store);
    const fail = t.mock.method(f.store, "save", (...args: Parameters<typeof f.store.save>) => { const value = save(...args); if (args[0] === "work_review_verification" && args[2].evidence_ids) throw new Error("simulated asynchronous receipt failure"); return value; });
    const started = await f.service.workReviewVerificationStart(f.executeArgs(job)); assert.equal(started.accepted, true);
    let current = started.verification as JsonObject; const deadline = Date.now() + 5000;
    while (current.status !== "unknown" && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); current = f.store.get("work_review_verification", String(job.id)); }
    fail.mock.restore(); assert.equal(current.status, "unknown"); assert.equal(current.error_class, "verification_receipt_unavailable"); assert.equal(f.verifyCalls().length, 1);
    const repeated = await f.service.workReviewVerificationStart(f.executeArgs(current)); assert.equal(repeated.idempotent, true); assert.equal(f.verifyCalls().length, 1);
    await f.service.workReviewVerificationStop({ verification_id: current.id, verification_version: current.version, actor: "operator", confirmed_execution_stopped: true });
  } finally { await f.close(); }
});
