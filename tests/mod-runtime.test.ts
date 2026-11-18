import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { createActionHandlers } from "../core/application/actions/action-handlers.ts";
import { confinedModule, executeModHook, throwPendingModJobError, valueResult } from "../core/mod-runtime-sandbox.ts";
import { CraftService } from "../core/service.ts";

test("QuickJS pending job errors are surfaced and their handles are released", () => {
  let disposed = false;
  const errorHandle = { dispose: () => { disposed = true; } };
  assert.throws(() => throwPendingModJobError(
    { dump: () => ({ message: "async job failed" }) },
    { error: errorHandle as never },
  ), /async job failed/u);
  assert.equal(disposed, true);
  assert.throws(() => throwPendingModJobError(
    { dump: () => "plain async job failure" },
    { error: { dispose() {} } as never },
  ), /plain async job failure/u);
  assert.doesNotThrow(() => throwPendingModJobError({ dump: () => "unused" }, {}));
});

test("QuickJS call results preserve values and surface both structured and string errors", () => {
  const value = { dispose() {} };
  assert.equal(valueResult({ dump: () => "unused" }, { value }), value);
  for (const detail of [{ message: "structured QuickJS failure" }, "plain QuickJS failure"]) {
    let disposed = false;
    assert.throws(() => valueResult({ dump: () => detail }, { error: { dispose: () => { disposed = true; } } as never }), /QuickJS failure/u);
    assert.equal(disposed, true);
  }
  assert.throws(() => valueResult({ dump: () => "unused" }, {}), /returned no value/u);
});

test("QuickJS module resolution rejects symlinks and empty Hook registrations safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-module-resolution-"));
  try {
    const entry = join(root, "register.mjs"), target = join(root, "target.mjs"), link = join(root, "link.mjs");
    await writeFile(entry, "export function register() {}\n");
    await writeFile(target, "export const value = true;\n");
    await symlink(target, link);
    const packageRoot = realpathSync(root);
    assert.equal(confinedModule(packageRoot, "register.mjs"), join(packageRoot, "register.mjs"));
    assert.throws(() => confinedModule(packageRoot, "link.mjs"), /regular files/u);
    assert.throws(() => confinedModule(packageRoot, "../outside.mjs"), /relative \.mjs modules/u);
    await assert.rejects(executeModHook(root, { entry: "register.mjs", hooks: [] }, "craft.input.submit@1", {}, 9), /timeout is unsupported/u);
    const noDeclaredHooks = await executeModHook(root, { entry: "register.mjs", hooks: [] }, "craft.input.submit@1", {}, 100);
    const absentHookManifest = await executeModHook(root, { entry: "register.mjs" }, "craft.input.submit@1", {}, 100);
    assert.equal(noDeclaredHooks.value, undefined);
    assert.equal(absentHookManifest.value, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Mod stays inert until its exact code and capability version is trusted", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-runtime-"));
  const packageRoot = join(root, "sample-mod");
  await mkdir(packageRoot);
  const entry = join(packageRoot, "register.mjs");
  await writeFile(entry, `export function register(on) {
    on("craft.input.submit@1", async (event) => ({ kind: "patch", patch: { text: event.text.toUpperCase() } }));
  }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const staged = service.modRuntimeStage({ manifest: {
      id: "uppercase-input", name: "Uppercase input", version: "1.0.0", origin: "human",
      entry: "register.mjs", hooks: [{ event: "craft.input.submit@1", capability: "event.patch" }], capabilities: ["event.patch"],
    }, package_root: packageRoot }) as JsonObject;
    assert.equal((staged.mod as JsonObject).trust_status, "review_required");
    assert.equal(service.modRuntimeStage({ manifest: {
      id: "uppercase-input", name: "Uppercase input", version: "1.0.0", origin: "human", entry: "register.mjs",
      hooks: [{ event: "craft.input.submit@1", capability: "event.patch" }], capabilities: ["event.patch"],
    }, package_root: packageRoot }).idempotent, true);
    assert.equal(((service.modRuntimeList().mods as JsonObject[])[0] as JsonObject).trust_status, "review_required");
    const inert = await service.modRuntimeDispatch({ event: "craft.input.submit@1", input: { text: "hello" } }) as JsonObject;
    assert.deepEqual(inert.result, { text: "hello" });
    assert.equal((inert.receipt as JsonObject).status, "completed");

    const review = service.modRuntimeReview({ mod_id: "uppercase-input" }) as JsonObject;
    assert.match(String(((review.source as JsonObject[])[0]?.content)), /register\(on\)/u);
    const trusted = service.modRuntimeTrust({ mod_id: "uppercase-input", code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:test" }) as JsonObject;
    assert.equal(trusted.status, "trusted");

    const dispatched = await service.modRuntimeDispatch({ event: "craft.input.submit@1", input: { text: "hello" } }) as JsonObject;
    assert.deepEqual(dispatched.result, { text: "HELLO" });
    assert.equal((dispatched.receipt as JsonObject).status, "completed");

    await writeFile(entry, `export function register(on) { on("craft.input.submit@1", async () => ({ kind: "reject" })); }\n`);
    const changedReview = service.modRuntimeReview({ mod_id: "uppercase-input" }) as JsonObject;
    assert.equal(changedReview.trust_status, "review_required");
    const afterChange = await service.modRuntimeDispatch({ event: "craft.input.submit@1", input: { text: "again" } });
    assert.deepEqual(afterChange.result, { text: "again" }, "reviewing changed bytes disables the old trusted code before dispatch");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trust-currently-reviewed-set requires an exact review receipt for every pending human Mod", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-trust-set-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const manifest = (id: string) => ({ id, name: id, version: "1.0.0", entry: "register.mjs",
    hooks: [{ event: "craft.input.submit@1", capability: "event.observe" }], capabilities: ["event.observe"] });
  try {
    const firstRoot = join(root, "first");
    const secondRoot = join(root, "second");
    await mkdir(firstRoot); await mkdir(secondRoot);
    const source = `export function register(on) { on("craft.input.submit@1", () => ({ kind: "continue" })); }\n`;
    await writeFile(join(firstRoot, "register.mjs"), source);
    await writeFile(join(secondRoot, "register.mjs"), source);
    service.modRuntimeStage({ manifest: manifest("first-mod"), package_root: firstRoot });
    service.modRuntimeStage({ manifest: manifest("second-mod"), package_root: secondRoot });
    const first = service.modRuntimeReview({ mod_id: "first-mod" }) as JsonObject;
    const second = service.modRuntimeReview({ mod_id: "second-mod" }) as JsonObject;
    assert.throws(() => service.modRuntimeTrustAll({ actor: "user:test" }), /reviews must contain/u);
    assert.throws(() => service.modRuntimeTrustAll({ actor: "user:test", reviews: [first] }), /exactly match/u);
    await writeFile(join(secondRoot, "register.mjs"), source + "// changed after review\n");
    assert.throws(() => service.modRuntimeTrustAll({ actor: "user:test", reviews: [first, second] }), /changed after review/u);
    assert.equal((store.find("runtime_mod", "first-mod") as JsonObject).trust_status, "review_required", "trust-all rolls back as one decision");
    const changedSecond = service.modRuntimeReview({ mod_id: "second-mod" }) as JsonObject;
    const result = service.modRuntimeTrustAll({ actor: "user:test", reviews: [first, changedSecond] }) as JsonObject;
    assert.equal(result.count, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the versioned Hook boundary validates continue, patch, reject, takeover, and declared execution order", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-outcomes-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const event = "craft.task.lifecycle@1";
  const register = async (id: string, capability: string, expression: string, order = 0, eventName = event) => {
    const packageRoot = join(root, id);
    await mkdir(packageRoot);
    await writeFile(join(packageRoot, "register.mjs"), `export function register(on) { on("${eventName}", () => (${expression})); }\n`);
    service.modRuntimeStage({ manifest: { id, name: id, version: "1.0.0", entry: "register.mjs",
      hooks: [{ event: eventName, capability, order }], capabilities: [capability] }, package_root: packageRoot });
    const review = service.modRuntimeReview({ mod_id: id }) as JsonObject;
    service.modRuntimeTrust({ mod_id: id, code_digest: review.code_digest, permission_digest: review.permission_digest, actor: "user:test" });
  };
  try {
    const eventNames = { continue: "craft.task.lifecycle@1", patch: "craft.context.assemble@1", reject: "craft.input.submit@1", takeover: "craft.tool.call@1", order: "craft.channel.receive@1" };
    await register("z-continue", "event.observe", `{ kind: "continue" }`, 0, eventNames.continue);
    let result = await service.modRuntimeDispatch({ event: eventNames.continue, input: { task_id: "task", status: "running" } });
    assert.deepEqual(result.result, { task_id: "task", status: "running" });
    assert.equal(((result.receipt as JsonObject).execution as JsonObject[])[0]?.result, "continue");

    await register("patcher", "event.patch", `{ kind: "patch", patch: { query: "changed" } }`, 0, eventNames.patch);
    result = await service.modRuntimeDispatch({ event: eventNames.patch, input: { query: "before" } });
    assert.deepEqual(result.result, { query: "changed" });

    await register("rejector", "event.reject", `{ kind: "reject", reason: "blocked" }`, 0, eventNames.reject);
    result = await service.modRuntimeDispatch({ event: eventNames.reject, input: {} });
    assert.equal(result.status, "rejected");

    await register("takeover", "event.takeover", `{ kind: "takeover", result: { handled: true } }`, 0, eventNames.takeover);
    result = await service.modRuntimeDispatch({ event: eventNames.takeover, input: {} });
    assert.deepEqual(result.result, { handled: true });

    await register("order-a", "event.patch", `{ kind: "patch", patch: { content: "second" } }`, 20, eventNames.order);
    await register("order-z", "event.patch", `{ kind: "patch", patch: { content: "first" } }`, 1, eventNames.order);
    result = await service.modRuntimeDispatch({ event: eventNames.order, input: {} });
    assert.deepEqual((result.receipt as JsonObject).execution && ((result.receipt as JsonObject).execution as JsonObject[]).map((item) => item.mod_id), ["order-z", "order-a"]);

    await register("unknown-outcome", "event.observe", `{ kind: "invented" }`, 0, "craft.asset.lifecycle@1");
    const unknownOutcome = await service.modRuntimeDispatch({ event: "craft.asset.lifecycle@1", input: { asset_id: "asset", kind: "tool", status: "ready" } });
    assert.equal(unknownOutcome.status, "failed");
    assert.match(String(unknownOutcome.failure_reason), /Unsupported Hook result/u);
    const invalidScopeMod = store.find("runtime_mod", "z-continue")!;
    store.save("runtime_mod", "z-continue", { ...invalidScopeMod, scope_kind: "invalid", scope_id: "task" });
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "task", scope_id: "task", task_id: "task" }), false,
      "unknown persisted scope kinds fail closed rather than matching a task or project");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mod code runs in a bounded QuickJS sandbox without Node, filesystem, or network globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-sandbox-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const event = "craft.input.submit@1";
  const disable = (id: string) => {
    const mod = store.find("runtime_mod", id)!;
    store.save("runtime_mod", id, { ...mod, enabled: false });
  };
  const install = async (id: string, source: string, timeoutMs = 1_000, extraFiles: Record<string, string> = {}) => {
    const hookEvent = ({ "safe-globals": "craft.input.submit@1", "local-import": "craft.context.assemble@1", "external-import": "craft.channel.receive@1", "infinite-loop": "craft.tool.call@1", "promise-rejection": "craft.channel.send@1", "pending-job-failure": "craft.channel.receive@1", "missing-handler": "craft.input.submit@1", "undeclared-handler": "craft.input.submit@1", "duplicate-handler": "craft.input.submit@1", "nonfunction-handler": "craft.input.submit@1", "undefined-result": "craft.input.submit@1", "oversized-result": "craft.input.submit@1", "oversized-input": "craft.input.submit@1", "traversal-import": "craft.input.submit@1" } as Record<string, string>)[id]!;
    const packageRoot = join(root, id);
    await mkdir(packageRoot);
    await writeFile(join(packageRoot, "register.mjs"), source.replaceAll(event, hookEvent));
    for (const [name, content] of Object.entries(extraFiles)) await writeFile(join(packageRoot, name), content);
    service.modRuntimeStage({ manifest: { id, name: id, version: "1.0.0", entry: "register.mjs",
      hooks: [{ event: hookEvent, capability: "event.patch", timeout_ms: timeoutMs }], capabilities: ["event.patch"] }, package_root: packageRoot });
    const review = service.modRuntimeReview({ mod_id: id }) as JsonObject;
    service.modRuntimeTrust({ mod_id: id, code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:test" });
    return hookEvent;
  };
  try {
    const globalsEvent = await install("safe-globals", `export function register(on) { on("${event}", () => ({ kind: "patch", patch: { text: [typeof process, typeof require, typeof fetch, typeof console].join(",") } })); }\n`);
    const sandboxed = await service.modRuntimeDispatch({ event: globalsEvent, input: { text: "" } });
    assert.equal((sandboxed.result as JsonObject).text, "undefined,undefined,undefined,undefined");

    const importEvent = await install("local-import", `import { upper } from "./helper.mjs";\nexport function register(on) { on("${event}", (input) => ({ kind: "patch", patch: { query: upper(input.query) } })); }\n`, 1_000, {
      "helper.mjs": "export function upper(value) { return value.toUpperCase(); }\n",
    });
    const localImport = await service.modRuntimeDispatch({ event: importEvent, input: { query: "local" } });
    assert.equal((localImport.result as JsonObject).query, "LOCAL");

    const externalEvent = await install("external-import", `export function register(on) { on("${event}", async () => await import("node:fs")); }\n`);
    const blockedImport = await service.modRuntimeDispatch({ event: externalEvent, input: {} });
    assert.equal(blockedImport.status, "failed");
    assert.match(String(blockedImport.failure_reason), /relative \.mjs modules|bare, absolute, and builtin imports/u);

    const rejectedPromiseEvent = await install("promise-rejection", `export function register(on) { on("craft.input.submit@1", async () => { await Promise.reject(new Error("async failure")); }); }\n`);
    const rejectedPromise = await service.modRuntimeDispatch({ event: rejectedPromiseEvent, input: {} });
    assert.equal(rejectedPromise.status, "failed");
    assert.match(String(rejectedPromise.failure_reason), /async failure/u);

    const pendingJobEvent = await install("pending-job-failure", `export function register(on) { on("${event}", () => { Promise.resolve().then(() => import("node:fs")); return { kind: "continue" }; }); }\n`);
    const pendingJobFailure = await service.modRuntimeDispatch({ event: pendingJobEvent, input: {} });
    assert.equal(pendingJobFailure.status, "failed");
    assert.match(String(pendingJobFailure.failure_reason), /relative \.mjs modules|bare, absolute, and builtin imports/u);

    const missingHandlerEvent = await install("missing-handler", `export function register() {}\n`);
    const missingHandler = await service.modRuntimeDispatch({ event: missingHandlerEvent, input: {} });
    assert.equal(missingHandler.status, "failed");
    assert.match(String(missingHandler.failure_reason), /register every declared Hook/u);
    disable("missing-handler");

    const undeclaredHandlerEvent = await install("undeclared-handler", `export function register(on) { on("craft.context.assemble@1", () => ({ kind: "continue" })); }\n`);
    const undeclaredHandler = await service.modRuntimeDispatch({ event: undeclaredHandlerEvent, input: {} });
    assert.equal(undeclaredHandler.status, "failed");
    assert.match(String(undeclaredHandler.failure_reason), /undeclared event|register every declared Hook/u);
    disable("undeclared-handler");

    const duplicateHandlerEvent = await install("duplicate-handler", `export function register(on) { on("${event}", () => ({ kind: "continue" })); on("${event}", () => ({ kind: "continue" })); }\n`);
    const duplicateHandler = await service.modRuntimeDispatch({ event: duplicateHandlerEvent, input: {} });
    assert.equal(duplicateHandler.status, "failed");
    assert.match(String(duplicateHandler.failure_reason), /more than once/u);
    disable("duplicate-handler");

    const nonfunctionHandlerEvent = await install("nonfunction-handler", `export function register(on) { on("${event}", 1); }\n`);
    const nonfunctionHandler = await service.modRuntimeDispatch({ event: nonfunctionHandlerEvent, input: {} });
    assert.equal(nonfunctionHandler.status, "failed");
    assert.match(String(nonfunctionHandler.failure_reason), /must be a function/u);
    disable("nonfunction-handler");

    const undefinedResultEvent = await install("undefined-result", `export function register(on) { on("${event}", () => undefined); }\n`);
    const undefinedResult = await service.modRuntimeDispatch({ event: undefinedResultEvent, input: {} });
    assert.equal(undefinedResult.status, "completed", "undefined Hook output is treated as a continue observer");
    disable("undefined-result");

    const oversizedResultEvent = await install("oversized-result", `export function register(on) { on("${event}", () => ({ kind: "patch", patch: { text: "x".repeat(300000) } })); }\n`);
    const oversizedResult = await service.modRuntimeDispatch({ event: oversizedResultEvent, input: { text: "small" } });
    assert.equal(oversizedResult.status, "failed");
    assert.match(String(oversizedResult.failure_reason), /exceeds 256 KiB/u);
    disable("oversized-result");

    const oversizedInputEvent = await install("oversized-input", `export function register(on) { on("${event}", () => ({ kind: "continue" })); }\n`);
    const oversizedInput = await service.modRuntimeDispatch({ event: oversizedInputEvent, input: { text: "x".repeat(300_000) } });
    assert.equal(oversizedInput.status, "failed");
    assert.match(String(oversizedInput.failure_reason), /input exceeds 256 KiB/u);

    const traversalImportEvent = await install("traversal-import", `import "../outside.mjs";\nexport function register(on) { on("${event}", () => ({ kind: "continue" })); }\n`);
    const traversalImport = await service.modRuntimeDispatch({ event: traversalImportEvent, input: {} });
    assert.equal(traversalImport.status, "failed");
    assert.match(String(traversalImport.failure_reason), /relative \.mjs modules|escapes the reviewed package/u);

    const loopEvent = await install("infinite-loop", `export function register(on) { on("${event}", () => { while (true) {} }); }\n`, 30);
    const startedAt = Date.now();
    const timedOut = await service.modRuntimeDispatch({ event: loopEvent, input: {} });
    assert.equal(timedOut.status, "failed");
    assert.match(String(timedOut.failure_reason), /timeout|interrupted/u);
    assert.ok(Date.now() - startedAt < 2_000, "a runaway Hook is interrupted within the declared bound");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approval strategy is human-trusted, exact-action scoped, and cannot be spoofed by a self-evolved origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-approval-"));
  const packageRoot = join(root, "approval-mod");
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "register.mjs"), `export function register(on) {
    on("craft.approval.decide@1", async (event) => ({ kind: "approval", decision: event.action === "task.execute" ? "allow" : "deny" }));
  }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const staged = service.modRuntimeStage({ manifest: {
      id: "approval-helper", name: "Approval helper", version: "1.0.0", origin: "self_evolved",
      entry: "register.mjs", hooks: [{ event: "craft.approval.decide@1", capability: "approval.strategy" }], capabilities: ["approval.strategy"],
    }, package_root: packageRoot });
    assert.equal((staged.mod as JsonObject).origin, "human", "manifest source labels cannot set runtime-controlled origin");
    const review = service.modRuntimeReview({ mod_id: "approval-helper" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "approval-helper", code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:test" });
    service.modRuntimeApprovalPolicySet({ actions: ["task.execute", "task.cancel"], actor: "user:test" });
    assert.equal(await service.modRuntime.approvalStrategy("task.execute", "side_effect", {}), "allow");
    assert.equal(await service.modRuntime.approvalStrategy("task.cancel", "side_effect", {}), "deny");
    assert.equal(await service.modRuntime.approvalStrategy("account.delete", "side_effect", {}), null);
    service.setInternalApprovalPolicy(() => "ask");
    assert.equal(await service.internalApprovalBroker.policy("task.execute", "side_effect", {}), "allow");
    const authorization = await service.internalApprovalBroker.authorize("task.execute", {}, "side_effect");
    const approvalRecord = store.find("internal_action_approval", String(authorization.approval_ref));
    assert.equal(approvalRecord?.status, "approved", "the configured strategy enters Craft's normal approval broker");

    store.create("workspace", "approval-project", { name: "Approval project" });
    store.create("task", "approval-task", { workspace_id: "approval-project" });
    const projectRoot = join(root, "project-approval-mod"); await mkdir(projectRoot);
    await writeFile(join(projectRoot, "register.mjs"), `export function register(on) { on("craft.approval.decide@1", () => ({ kind: "approval", decision: "allow" })); }\n`);
    service.modRuntimeStage({ manifest: { id: "project-approval", name: "Project approval", version: "1.0.0", entry: "register.mjs",
      scope_kind: "project", scope_id: "approval-project", capabilities: ["approval.strategy"],
      hooks: [{ event: "craft.approval.decide@1", capability: "approval.strategy" }] }, package_root: projectRoot });
    const projectReview = service.modRuntimeReview({ mod_id: "project-approval" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "project-approval", code_digest: projectReview.code_digest,
      permission_digest: projectReview.permission_digest, actor: "user:test" });
    const globalMod = store.find("runtime_mod", "approval-helper")!;
    store.save("runtime_mod", "approval-helper", { ...globalMod, enabled: false });
    assert.equal(await service.modRuntime.approvalStrategy("task.execute", "side_effect", { task_id: "approval-task" }), "allow");
    assert.equal(await service.modRuntime.approvalStrategy("task.execute", "side_effect", { project_id: "other-project" }), null,
      "a project-scoped strategy is not evaluated outside its project and normal approval handling receives no decision");

    const stored = store.find("runtime_mod", "approval-helper");
    assert.ok(stored);
    store.save("runtime_mod", "approval-helper", { ...stored, origin: "self_evolved", enabled: false, trust_status: "review_required" });
    const evolvedReview = service.modRuntimeReview({ mod_id: "approval-helper" }) as JsonObject;
    assert.throws(() => service.modRuntimeTrust({ mod_id: "approval-helper", code_digest: evolvedReview.code_digest,
      permission_digest: evolvedReview.permission_digest, actor: "user:test" }), /self-evolved Mods cannot use approval strategy/u);
    const trusted = service.modRuntimeTrustAll({ actor: "user:test", reviews: [] }) as JsonObject;
    assert.equal(trusted.count, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("event contracts report Host support, reject undeclared patch fields, and deduplicate deliveries", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-contracts-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  const install = async (id: string, source: string, event: string) => {
    const packageRoot = join(root, id); await mkdir(packageRoot); await writeFile(join(packageRoot, "register.mjs"), source);
    service.modRuntimeStage({ manifest: { id, name: id, version: "1.0.0", entry: "register.mjs",
      hooks: [{ event, capability: "event.patch" }], capabilities: ["event.patch"] }, package_root: packageRoot });
    const review = service.modRuntimeReview({ mod_id: id }) as JsonObject;
    service.modRuntimeTrust({ mod_id: id, code_digest: review.code_digest, permission_digest: review.permission_digest, actor: "user:test" });
  };
  try {
    const catalog = service.modRuntimeEventCatalog({ host: "codex" }) as JsonObject;
    const inputContract = (catalog.events as JsonObject[]).find((item) => item.event === "craft.input.submit@1");
    assert(inputContract);
    assert.equal(inputContract.scope, "invocation_scope");
    assert.equal(inputContract.ordering, "declared_order_then_mod_id");
    assert.equal(inputContract.timeout_max_ms, 30_000);
    assert.deepEqual(inputContract.platforms, ["darwin", "linux", "win32"]);
    assert.equal(((service.modRuntimeEventCatalog({ host: "codex", platform: "win32" }) as JsonObject).events as JsonObject[])
      .some((item) => item.event === "craft.input.submit@1"), true);
    const unsupportedPlatform = await service.modRuntimeDispatch({ event: "craft.input.submit@1", host: "codex", platform: "freebsd", input: { text: "unsupported" } });
    assert.equal(unsupportedPlatform.status, "unsupported");
    assert.equal(unsupportedPlatform.reason, "platform_not_supported");
    assert(!(catalog.events as JsonObject[]).some((item) => item.event === "craft.task.lifecycle@1"));
    assert.equal(((service.modRuntimeEventCatalog({ host: "claude" }) as JsonObject).events as JsonObject[]).length, 0,
      "the event catalog does not claim an unimplemented Claude Hook adapter");
    assert.equal(((service.modRuntimeEventCatalog({ host: "unregistered-host" }) as JsonObject).events as JsonObject[]).length, 0);
    assert.equal((await service.modRuntimeDispatch({ event: "craft.input.submit@1", host: "claude", input: { text: "no adapter" } })).status, "unsupported");
    const unsupported = await service.modRuntimeDispatch({ event: "craft.task.lifecycle@1", host: "codex", input: { task_id: "t" } });
    assert.equal(unsupported.status, "unsupported");
    assert.throws(() => service.modRuntimeStage({ manifest: { id: "unknown-event", name: "unknown", version: "1", entry: "x.mjs",
      hooks: [{ event: "craft.unknown@1", capability: "event.patch" }], capabilities: ["event.patch"] }, package_root: root }), /Unsupported Mod event/u);

    await install("bad-patch", `export function register(on) { on("craft.input.submit@1", () => ({ kind: "patch", patch: { query: "illegal" } })); }\n`, "craft.input.submit@1");
    const invalid = await service.modRuntimeDispatch({ event: "craft.input.submit@1", input: { text: "original" } });
    assert.equal(invalid.status, "failed");
    assert.deepEqual(invalid.result, { text: "original" }, "invalid patches never reach the caller");
    await install("valid-delivery", `export function register(on) { on("craft.context.assemble@1", () => ({ kind: "patch", patch: { query: "once" } })); }\n`, "craft.context.assemble@1");
    const first = await service.modRuntimeDispatch({ event: "craft.context.assemble@1", input: { query: "before" }, delivery_id: "delivery-once" });
    const replay = await service.modRuntimeDispatch({ event: "craft.context.assemble@1", input: { query: "before" }, delivery_id: "delivery-once" });
    assert.equal(replay.idempotent, true);
    assert.equal((replay.receipt as JsonObject).id, (first.receipt as JsonObject).id);
    assert.equal(store.list("mod_runtime_receipt", 100, item => item.delivery_id === "delivery-once").length, 1);
    const selfEvolvedRoot = join(root, "self-evolved-failure"); await mkdir(selfEvolvedRoot);
    await writeFile(join(selfEvolvedRoot, "register.mjs"), `export function register(on) { on("craft.tool.call@1", () => { throw new Error("regression"); }); }\n`);
    service.modRuntimeStage({ manifest: { id: "self-evolved-failure", name: "self evolved", version: "1", entry: "register.mjs",
      hooks: [{ event: "craft.tool.call@1", capability: "event.observe" }], capabilities: ["event.observe"] }, package_root: selfEvolvedRoot });
    const selfReview = service.modRuntimeReview({ mod_id: "self-evolved-failure" }) as JsonObject;
    const stagedSelf = store.find("runtime_mod", "self-evolved-failure")!;
    store.save("runtime_mod", "self-evolved-failure", { ...stagedSelf, origin: "self_evolved" });
    const selfRegression = await service.modRuntimeCandidateRegressionRun({ mod_id: "self-evolved-failure" });
    const selfRegressionRecord = selfRegression.regression as JsonObject;
    service.modRuntimeTrust({ mod_id: "self-evolved-failure", code_digest: selfReview.code_digest,
      permission_digest: selfReview.permission_digest, actor: "user:test" });
    store.save("runtime_mod_rollout", "self-evolved-failure", { id: "self-evolved-failure", mod_id: "self-evolved-failure",
      status: "active", stage: "task", scope_kind: "task", scope_id: "task-1",
      runtime_version: selfRegressionRecord.runtime_version, regression_digest: selfRegressionRecord.suite_digest });
    await service.modRuntimeDispatch({ event: "craft.tool.call@1", input: { tool: "tool" } });
    const disabledSelf = store.find("runtime_mod", "self-evolved-failure");
    assert.equal(disabledSelf?.enabled, false, "a self-evolved Hook failure disables that version immediately");
    assert.equal(disabledSelf?.safety_disable_reason, "self_evolved_hook_failure");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("the shared capability asset action emits a lifecycle event after the registry write", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-asset-lifecycle-"));
  const packageRoot = join(root, "asset-observer");
  await mkdir(packageRoot);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    await writeFile(join(packageRoot, "register.mjs"), `export function register(on) {
      on("craft.asset.lifecycle@1", () => ({ kind: "continue" }));
    }\n`);
    service.modRuntimeStage({ manifest: { id: "asset-observer", name: "Asset observer", version: "1.0.0", entry: "register.mjs",
      hooks: [{ event: "craft.asset.lifecycle@1", capability: "event.observe" }], capabilities: ["event.observe"] }, package_root: packageRoot });
    const review = service.modRuntimeReview({ mod_id: "asset-observer" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "asset-observer", code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:test" });
    const saved = await createActionHandlers(service).craft_capability_asset_save!({ asset_id: "runtime-asset", name: "Runtime asset",
      asset_type: "tool", source_uri: "local://runtime-asset", effect: "read_only" }) as JsonObject;
    const receipt = store.list("mod_runtime_receipt", 10, item => item.event === "craft.asset.lifecycle@1")[0];
    assert.equal(saved.id, "runtime-asset");
    assert.equal((receipt?.result as JsonObject).asset_id, "runtime-asset");
    assert.equal(receipt?.host, "craft-runtime");
    assert.equal(receipt?.status, "completed");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("self-evolved executable candidates remain drafts without independently bound repair evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-candidate-draft-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    store.create("pilot_failure_observation", "failure-1", { task_id: "task-1", attributed: true,
      failure_class: "scope_gap", injection_verified: true, mod_evidence_kind: "current_verified" });
    const result = await service.modRuntimeCandidateCreate({ candidate_id: "candidate-1", observation_id: "failure-1" });
    assert.equal((result.candidate as JsonObject).status, "draft");
    assert.equal((result.candidate as JsonObject).mod_id, undefined);
    assert.deepEqual((result.candidate as JsonObject).blockers, [
      "repair_run_missing", "verification_assessment_missing", "executable_package_missing",
    ]);
    assert.equal(store.find("runtime_mod", "candidate-1"), null, "a draft is never staged into the executable registry");
    const packageRoot = join(root, "candidate"); await mkdir(packageRoot);
    await writeFile(join(packageRoot, "register.mjs"), `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n`);
    const retried = await service.modRuntimeCandidateCreate({ candidate_id: "candidate-1", observation_id: "failure-1",
      package_root: packageRoot, manifest: { id: "candidate-1", name: "Candidate", version: "1.0.0", entry: "register.mjs",
        scope_kind: "task", scope_id: "task-1", capabilities: ["event.observe"],
        hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] } });
    assert.deepEqual((retried.candidate as JsonObject).blockers, ["repair_run_missing", "verification_assessment_missing"]);
    assert.equal(store.find("runtime_mod", "candidate-1"), null, "a retried draft remains outside the executable registry");
    const wrongScope = await service.modRuntimeCandidateCreate({ candidate_id: "wrong-scope-candidate", observation_id: "failure-1",
      package_root: packageRoot, manifest: { id: "wrong-scope-candidate", name: "Wrong scope", version: "1.0.0", entry: "register.mjs",
        scope_kind: "task", scope_id: "another-task", capabilities: ["event.observe"],
        hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] } });
    assert(((wrongScope.candidate as JsonObject).blockers as string[]).some((item) => item.includes("repair task scope")));
    await assert.rejects(service.modRuntimeCandidateCreate({ candidate_id: "candidate-1", observation_id: "another-failure" }), /idempotency conflict/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("candidate creation cannot replace an existing human-authored Runtime Mod", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-candidate-id-conflict-"));
  const packageRoot = join(root, "existing-mod"); await mkdir(packageRoot);
  await writeFile(join(packageRoot, "register.mjs"), `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    service.modRuntimeStage({ manifest: { id: "reserved-mod", name: "Human Mod", version: "1.0.0", entry: "register.mjs",
      scope_kind: "task", scope_id: "task-1", capabilities: ["event.observe"],
      hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] }, package_root: packageRoot });
    const original = store.get("runtime_mod", "reserved-mod");
    store.create("pilot_failure_observation", "candidate-conflict-observation", { task_id: "task-1", attributed: true,
      failure_class: "scope_gap", injection_verified: true, mod_evidence_kind: "current_verified" });
    const result = await service.modRuntimeCandidateCreate({ candidate_id: "reserved-mod", observation_id: "candidate-conflict-observation" });
    assert.equal((result.candidate as JsonObject).status, "draft");
    assert((result.candidate as JsonObject).blockers instanceof Array);
    assert(((result.candidate as JsonObject).blockers as string[]).includes("candidate_id_already_exists"));
    assert.equal(store.get("runtime_mod", "reserved-mod").origin, "human");
    assert.equal(store.get("runtime_mod", "reserved-mod").code_digest, original.code_digest);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("changed self-evolved package bytes pause the trusted rollout and require new review", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-runtime-identity-change-"));
  const packageRoot = join(root, "mod"); await mkdir(packageRoot);
  const entry = join(packageRoot, "register.mjs");
  await writeFile(entry, `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const manifest = { id: "identity-change", name: "Identity change", version: "1.0.0", entry: "register.mjs",
      scope_kind: "task", scope_id: "task-1", capabilities: ["event.observe"],
      hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] };
    const staged = service.modRuntimeStage({ manifest, package_root: packageRoot });
    store.save("runtime_mod", "identity-change", { ...(staged.mod as JsonObject), origin: "self_evolved" });
    const regression = await service.modRuntime.candidateRegressionRun("identity-change");
    const regressionRecord = regression.regression as JsonObject;
    const review = service.modRuntimeReview({ mod_id: "identity-change" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "identity-change", code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:reviewer" });
    store.save("runtime_mod_rollout", "identity-change", { id: "identity-change", status: "active", stage: "task",
      runtime_version: regressionRecord.runtime_version, regression_digest: regressionRecord.suite_digest });
    await writeFile(entry, `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n// changed bytes\n`);
    await assert.rejects(service.modRuntimeDispatch({ event: "craft.task.lifecycle@1", host: "workbench",
      scope_kind: "task", scope_id: "task-1", task_id: "task-1",
      input: { task_id: "task-1", status: "running", scope_kind: "task", scope_id: "task-1" } }), /review required/u);
    assert.throws(() => service.modRuntimeStage({ manifest, package_root: packageRoot }), /versions are immutable/u);
    assert.equal(store.get("runtime_mod", "identity-change").enabled, false);
    assert.equal(store.get("runtime_mod", "identity-change").trust_status, "review_required");
    assert.equal(store.get("runtime_mod_rollout", "identity-change").status, "paused");
    assert.equal(store.get("runtime_mod_rollout", "identity-change").pause_reason, "qualification_identity_changed");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("failed fixed regression blocks rollout start and rolls back a later stage regression", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-stage-regression-"));
  const packageRoot = join(root, "mod"); await mkdir(packageRoot);
  await writeFile(join(packageRoot, "register.mjs"), `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const manifest = { id: "stage-regression", name: "Stage regression", version: "1.0.0", entry: "register.mjs",
      scope_kind: "task", scope_id: "task-1", capabilities: ["event.observe"],
      hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] };
    const staged = service.modRuntimeStage({ manifest, package_root: packageRoot });
    store.save("runtime_mod", "stage-regression", { ...(staged.mod as JsonObject), origin: "self_evolved",
      candidate_provenance: { source_project_id: "project-1" } });
    const candidateRun = await service.modRuntime.candidateRegressionRun("stage-regression");
    const candidateRegression = candidateRun.regression as JsonObject;
    store.create("runtime_mod_candidate", "stage-regression", { status: "qualified_untrusted", regression_id: candidateRegression.id, blockers: [] });
    const review = service.modRuntimeReview({ mod_id: "stage-regression" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "stage-regression", code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:reviewer" });
    store.save("runtime_mod_regression", String(candidateRegression.id), { ...candidateRegression, verdict: "failed" });
    assert.throws(() => service.modRuntimeRolloutStart({ mod_id: "stage-regression", actor: "user:reviewer" }), /current passing fixed regression/u);
    store.save("runtime_mod_regression", String(candidateRegression.id), candidateRegression);
    store.save("runtime_mod_candidate", "stage-regression", { ...store.get("runtime_mod_candidate", "stage-regression"),
      status: "qualified_untrusted", blockers: [], regression_verdict: "passed" });
    service.modRuntimeRolloutStart({ mod_id: "stage-regression", actor: "user:reviewer" });

    const stageRun = await service.modRuntime.candidateRegressionRun("stage-regression", "task");
    const stageRegression = stageRun.regression as JsonObject;
    store.save("runtime_mod_regression", String(stageRegression.id), { ...stageRegression, verdict: "failed" });
    store.create("workspace", "project-1", { name: "Project 1" });
    store.create("task", "task-1", { workspace_id: "project-1" });
    store.create("host_run", "host-run-1", { status: "completed", task_id: "task-1" });
    const launch = store.create("work_launch", "launch-1", { task_id: "task-1", run_id: "host-run-1" });
    const hostRun = store.get("host_run", "host-run-1");
    const taskRun = store.create("task_run", "task-run-1", { launch_id: launch.id, launch_identity: { task_id: "task-1" } });
    store.create("task_run_state", "task_run_state_task-run-1", { task_run_version: taskRun.version,
      status: "ready_for_delivery", action: "deliver" });
    store.create("work_delivery", "delivery-1", { launch_id: launch.id, launch_version: launch.version,
      run_id: hostRun.id, run_version: hostRun.version, status: "ready_for_delivery" });
    const dispatched = await service.modRuntimeDispatch({ event: "craft.task.lifecycle@1", host: "workbench", delivery_id: "stage-regression-event",
      scope_kind: "task", scope_id: "task-1", task_id: "task-1", project_id: "project-1",
      input: { task_id: "task-1", task_run_id: "task-run-1", delivery_id: "delivery-1", status: "ready_for_delivery",
        action: "deliver", scope_kind: "task", scope_id: "task-1" } });
    assert.equal(dispatched.status, "completed");
    assert.equal(store.get("runtime_mod_rollout", "stage-regression").reason, "stage_regression_failed");
    assert.equal(store.get("runtime_mod", "stage-regression").enabled, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a paused rollout rolls back when its resume regression fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-resume-regression-"));
  const packageRoot = join(root, "mod"); await mkdir(packageRoot);
  await writeFile(join(packageRoot, "register.mjs"), `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const manifest = { id: "resume-regression", name: "Resume regression", version: "1.0.0", entry: "register.mjs",
      scope_kind: "task", scope_id: "task-1", capabilities: ["event.observe"],
      hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] };
    const staged = service.modRuntimeStage({ manifest, package_root: packageRoot });
    store.save("runtime_mod", "resume-regression", { ...(staged.mod as JsonObject), origin: "self_evolved" });
    const candidateResult = await service.modRuntime.candidateRegressionRun("resume-regression");
    const candidateRegression = candidateResult.regression as JsonObject;
    store.create("runtime_mod_candidate", "resume-regression", { status: "qualified_untrusted", regression_id: candidateRegression.id, blockers: [] });
    const review = service.modRuntimeReview({ mod_id: "resume-regression" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "resume-regression", code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:reviewer" });
    service.modRuntimeRolloutStart({ mod_id: "resume-regression", actor: "user:reviewer" });
    service.modRuntimeRolloutPause({ mod_id: "resume-regression", actor: "user:reviewer", reason: "hold for review" });
    const stageResult = await service.modRuntime.candidateRegressionRun("resume-regression", "task");
    const stageRegression = stageResult.regression as JsonObject;
    store.save("runtime_mod_regression", String(stageRegression.id), { ...stageRegression, verdict: "failed" });
    const resumed = await service.modRuntimeRolloutResume({ mod_id: "resume-regression", actor: "user:reviewer" });
    assert.equal(resumed.status, "rolled_back");
    assert.equal(store.get("runtime_mod_rollout", "resume-regression").reason, "resume_regression_failed");
    assert.equal(store.get("runtime_mod", "resume-regression").enabled, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("verified repair evidence creates an exact executable candidate that still requires user trust and rollout", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-candidate-qualified-"));
  const packageRoot = join(root, "candidate"); await mkdir(packageRoot);
  await writeFile(join(packageRoot, "register.mjs"), `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const observationId = "failure-bound", candidateId = "verified-candidate", repairRunId = "repair-run-bound";
    store.create("pilot_failure_observation", observationId, { task_id: "repair-task", attributed: true,
      failure_class: "scope_gap", injection_verified: true, mod_evidence_kind: "current_verified" });
    store.create("work_launch", "repair-launch", { task_id: "repair-task", run_id: "repair-host" });
    store.create("host_run", "repair-host", { task_id: "repair-task", status: "completed" });
    store.create("task_run", repairRunId, { launch_id: "repair-launch", launch_identity: { task_id: "repair-task" } });
    const manifest = { id: candidateId, name: "Verified candidate", version: "1.0.0", entry: "register.mjs",
      scope_kind: "task", scope_id: "repair-task", capabilities: ["event.observe"],
      hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] };
    const packageBytes = await readFile(join(packageRoot, "register.mjs"));
    const expectedCodeDigest = `sha256:${createHash("sha256").update("register.mjs\0").update(packageBytes).update("\0").digest("hex")}`;
    store.create("verification_plan", "verification-plan-bound", { change_ref: `runtime-mod:${candidateId}:${expectedCodeDigest}:${repairRunId}@1:craft-mod-runtime@2`, candidate_change: true });
    store.create("verification_check", "verification-check-bound", { verification_id: "verification-plan-bound", status: "passed" });
    store.create("evidence", "verification-evidence-bound", { confidence: "confirmed" });
    store.create("verification_receipt", "verification-receipt-bound", { verification_id: "verification-plan-bound",
      check_id: "verification-check-bound", status: "passed", evidence_ids: ["verification-evidence-bound"] });
    store.create("verification_assessment", "verification-assessment-bound", { verification_id: "verification-plan-bound", verdict: "eligible" });

    const result = await service.modRuntimeCandidateCreate({ candidate_id: candidateId, observation_id: observationId,
      lineage_id: "verified-lineage", repair_run_id: repairRunId, verification_id: "verification-assessment-bound", package_root: packageRoot, manifest });
    assert.equal((result.candidate as JsonObject).status, "qualified_untrusted");
    const repeated = await service.modRuntimeCandidateCreate({ candidate_id: candidateId, observation_id: observationId,
      lineage_id: "verified-lineage", repair_run_id: repairRunId, verification_id: "verification-assessment-bound", package_root: packageRoot, manifest });
    assert.equal(repeated.idempotent, true, "repeating the exact evidence-bound candidate request returns its prior result");
    assert.equal((((result.candidate as JsonObject).before_after_evaluation as JsonObject).after as JsonObject).verification_verdict, "eligible");
    assert.equal(((result.candidate as JsonObject).before_after_evaluation as JsonObject).module_contract_quality_threshold, 1);
    const beforeAfter = (result.candidate as JsonObject).before_after_evaluation as JsonObject;
    assert.equal((beforeAfter.before as JsonObject).result, "input_passthrough");
    assert.equal((beforeAfter.after as JsonObject).regression_sample_count, 3);
    const candidate = store.get("runtime_mod", candidateId);
    assert.equal(candidate.origin, "self_evolved");
    assert.equal(candidate.lineage_id, "verified-lineage");
    assert.equal(candidate.enabled, false);
    assert.equal(candidate.candidate_provenance && (candidate.candidate_provenance as JsonObject).repair_run_id, repairRunId);
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "task", scope_id: "repair-task", task_id: "repair-task" }), false);

    const candidateReview = service.modRuntimeReview({ mod_id: candidateId }) as JsonObject;
    service.modRuntimeTrust({ mod_id: candidateId, code_digest: candidateReview.code_digest,
      permission_digest: candidateReview.permission_digest, actor: "user:reviewer" });
    assert.throws(() => service.modRuntimeStage({ manifest: { ...manifest, side_effects: ["changed after trust"] }, package_root: packageRoot }), /versions are immutable/u);
    assert.equal(store.get("runtime_mod", candidateId).origin, "self_evolved", "restaging cannot rewrite the runtime-controlled origin to human-authored");
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "task", scope_id: "repair-task", task_id: "repair-task" }), false,
      "review trust is still separate from enabling the task-stage rollout");
    service.modRuntimeRolloutStart({ mod_id: candidateId, actor: "user:reviewer" });
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "task", scope_id: "repair-task", task_id: "repair-task" }), true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("fixed executable Mod regression runs in the sandbox and does not grant trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-candidate-regression-"));
  const packageRoot = join(root, "candidate"); await mkdir(packageRoot);
  await writeFile(join(packageRoot, "register.mjs"), `export function register(on) { on("craft.input.submit@1", (input) => ({ kind: "patch", patch: { text: input.text.toUpperCase() } })); }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    service.modRuntimeStage({ manifest: { id: "candidate-runtime", name: "Candidate", version: "1.0.0", entry: "register.mjs",
      capabilities: ["event.patch"], hooks: [{ event: "craft.input.submit@1", capability: "event.patch" }] }, package_root: packageRoot });
    const staged = store.get("runtime_mod", "candidate-runtime");
    store.save("runtime_mod", "candidate-runtime", { ...staged, origin: "self_evolved" });
    const result = await service.modRuntimeCandidateRegressionRun({ mod_id: "candidate-runtime" });
    const regression = result.regression as JsonObject;
    assert.equal(result.verdict, "passed");
    assert.equal(regression.suite, "craft.mod-runtime.system-regression.v2");
    assert.equal(regression.quality_score, 1);
    assert.equal(regression.quality_threshold, 1);
    assert.equal(regression.hard_safety_passed, true);
    assert.equal(regression.sample_count, 3, "minimum samples count only module behavior cases, not system safety assertions");
    assert.equal(regression.safety_case_count, 3);
    const moduleCases = (regression.cases as JsonObject[]).filter((item) => String(item.id).startsWith("module:"));
    assert.equal(moduleCases.length, 3);
    assert.equal(moduleCases.every((item) => item.passed === true && item.before && item.after), true);
    const candidate = store.get("runtime_mod", "candidate-runtime");
    assert.equal(candidate.enabled, false);
    assert.equal(candidate.trust_status, "review_required");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("project package reuse rejects credential-like source and safety rollback disables without a valid baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-project-copy-security-"));
  const packageRoot = join(root, "candidate"); await mkdir(packageRoot);
  await writeFile(join(packageRoot, "register.mjs"), `// token=credential-like-value-123456789\nexport function register(on) { on("craft.task.lifecycle@1", (event) => { if (event.status === "ready_for_delivery") throw new Error("unsafe candidate"); return { kind: "continue" }; }); }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const manifest = { id: "isolated-secret-mod", name: "Isolated secret Mod", version: "1.0.0", entry: "register.mjs",
      scope_kind: "task", scope_id: "repair-task", capabilities: ["event.observe"],
      hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] };
    assert.throws(() => service.modRuntimeStage({ package_root: packageRoot, manifest: { ...manifest, id: "bad-side-effect", side_effects: [""] } }), /side_effects/u);
    const invalidEntryRoot = join(root, "invalid-entry"); await mkdir(invalidEntryRoot); await mkdir(join(invalidEntryRoot, "directory.mjs"));
    assert.throws(() => service.modRuntimeStage({ package_root: invalidEntryRoot, manifest: { ...manifest, id: "directory-entry", entry: "directory.mjs" } }), /regular file/u);

    const staged = service.modRuntimeStage({ package_root: packageRoot, manifest });
    const mod = staged.mod as JsonObject;
    store.save("runtime_mod", "isolated-secret-mod", { ...mod, origin: "self_evolved", lineage_id: "no-baseline-lineage",
      candidate_provenance: { source_project_id: "source-project" } });
    const regression = await service.modRuntimeCandidateRegressionRun({ mod_id: "isolated-secret-mod" });
    const record = regression.regression as JsonObject;
    store.create("runtime_mod_candidate", "isolated-secret-mod", { status: "qualified_untrusted", regression_id: record.id, blockers: [] });
    const review = service.modRuntimeReview({ mod_id: "isolated-secret-mod" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "isolated-secret-mod", code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:reviewer" });
    service.modRuntimeRolloutStart({ mod_id: "isolated-secret-mod", actor: "user:reviewer" });
    store.create("workspace", "source-project", { name: "Source" });
    store.create("workspace", "target-project", { name: "Target" });
    store.save("runtime_mod", "isolated-secret-mod", { ...store.get("runtime_mod", "isolated-secret-mod"),
      scope_kind: "global", scope_id: "global" });
    store.save("runtime_mod_rollout", "isolated-secret-mod", { ...store.get("runtime_mod_rollout", "isolated-secret-mod"),
      stage: "global", scope_kind: "global", scope_id: "global", status: "active", global_gate_passed: true,
      source_project_id: "source-project", allowed_project_ids: ["source-project"] });
    await assert.rejects(service.modRuntimeRolloutAuthorizeProject({ mod_id: "isolated-secret-mod", target_project_id: "target-project",
      actor: "user:source-owner", reason: "test isolated copy scanner" }), /credential-like value/u);

    const failed = await service.modRuntimeDispatch({ event: "craft.task.lifecycle@1", host: "workbench",
      scope_kind: "global", scope_id: "global", project_id: "source-project", task_id: "repair-task",
      input: { task_id: "repair-task", status: "ready_for_delivery", scope_kind: "global", scope_id: "global" } });
    assert.equal(failed.status, "failed");
    assert.equal(store.get("runtime_mod_rollout", "isolated-secret-mod").status, "rolled_back");
    assert.equal(store.get("runtime_mod_rollout", "isolated-secret-mod").rollback_target_digest, null);
    assert.equal(store.get("runtime_mod", "isolated-secret-mod").enabled, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("trusted self-evolved Mods advance task to project to global only after distinct real event receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-rollout-"));
  const packageRoot = join(root, "candidate"); await mkdir(packageRoot);
  await writeFile(join(packageRoot, "register.mjs"), `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    service.modRuntimeStage({ manifest: { id: "rollout-mod", name: "Rollout Mod", version: "1.0.0", entry: "register.mjs",
      scope_kind: "task", scope_id: "repair-task", capabilities: ["event.observe"],
      hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] }, package_root: packageRoot });
    store.create("workspace", "project-a", { name: "Project A", root_path: root });
    store.create("workspace", "project-b", { name: "Project B", root_path: root });
    store.create("workspace", "project-c", { name: "Project C", root_path: root });
    store.create("workspace", "project-d", { name: "Project D", root_path: root });
    const staged = store.get("runtime_mod", "rollout-mod");
    store.save("runtime_mod", "rollout-mod", { ...staged, origin: "self_evolved" });
    const regressionResult = await service.modRuntimeCandidateRegressionRun({ mod_id: "rollout-mod" });
    const regression = regressionResult.regression as JsonObject;
    store.create("runtime_mod_candidate", "rollout-mod", { status: "qualified_untrusted", regression_id: regression.id, blockers: [] });
    const review = service.modRuntimeReview({ mod_id: "rollout-mod" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "rollout-mod", code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:test" });
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "task", scope_id: "repair-task", task_id: "repair-task" }), false,
      "user trust alone does not expose a self-evolved Mod before rollout starts");
    service.modRuntimeRolloutStart({ mod_id: "rollout-mod", actor: "user:test" });
    assert.equal(service.modRuntimeRolloutStart({ mod_id: "rollout-mod", actor: "user:test" }).idempotent, true,
      "restarting an already active rollout does not create a second deployment record");
    const dispatch = (scopeKind: string, scopeId: string, taskId: string, projectId: string) => service.modRuntimeDispatch({
      event: "craft.task.lifecycle@1", host: "workbench", scope_kind: scopeKind, scope_id: scopeId,
      task_id: taskId, project_id: projectId,
      input: { task_id: taskId, task_run_id: `run-${taskId}`, delivery_id: `delivery-${taskId}`,
        status: "ready_for_delivery", action: "deliver", scope_kind: scopeKind, scope_id: scopeId },
    });
    const dispatchRealDelivery = async (scopeKind: string, scopeId: string, taskId: string, projectId: string) => {
      store.create("task", taskId, { id: taskId, workspace_id: projectId });
      store.create("host_run", `host-${taskId}`, { status: "completed", task_id: taskId });
      store.create("work_launch", `launch-${taskId}`, { id: `launch-${taskId}`, task_id: taskId, run_id: `host-${taskId}` });
      const run = store.create("task_run", `run-${taskId}`, { launch_id: `launch-${taskId}`, launch_identity: { task_id: taskId } });
      store.create("task_run_state", `task_run_state_run-${taskId}`, { task_run_version: run.version,
        status: "ready_for_delivery", action: "deliver" });
      store.create("work_delivery", `delivery-${taskId}`, { launch_id: `launch-${taskId}`, launch_version: 1,
        run_id: `host-${taskId}`, run_version: 1, status: "ready_for_delivery" });
      return dispatch(scopeKind, scopeId, taskId, projectId);
    };

    await dispatch("task", "repair-task", "spoof-task", "project-a");
    assert.equal(store.get("runtime_mod_rollout", "rollout-mod").stage, "task", "caller-supplied ready status cannot promote without a persisted TaskRun, HostRun and WorkDelivery");
    await dispatchRealDelivery("task", "repair-task", "repair-task", "project-a");
    assert.equal(store.get("runtime_mod_rollout", "rollout-mod").stage, "project");
    assert.equal(store.get("runtime_mod", "rollout-mod").scope_id, "project-a");
    await dispatchRealDelivery("project", "project-a", "project-task-1", "project-a");
    const projectProgress = (service.modRuntimeRolloutGet({ mod_id: "rollout-mod" }).rollout as JsonObject).gate_progress as JsonObject;
    assert.equal(projectProgress.task_samples, 1);
    assert.equal(projectProgress.remaining_task_samples, 2);
    assert.equal(projectProgress.state, "collecting_samples");
    for (let index = 2; index <= 3; index += 1) await dispatchRealDelivery("project", "project-a", `project-task-${index}`, "project-a");
    assert.equal(store.get("runtime_mod_rollout", "rollout-mod").stage, "global", JSON.stringify(store.get("runtime_mod_rollout", "rollout-mod")));
    assert.equal(store.get("runtime_mod_rollout", "rollout-mod").status, "paused");
    assert.equal(store.get("runtime_mod", "rollout-mod").scope_kind, "project", "global scope waits for cross-project approval");
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-b", project_id: "project-b" }), false);
    await assert.rejects(service.modRuntimeRolloutResume({ mod_id: "rollout-mod", actor: "user:test" }), /source-approval route/u);
    const sourceBytes = await readFile(join(packageRoot, "register.mjs"), "utf8");
    await writeFile(join(packageRoot, "register.mjs"), `${sourceBytes}// changed before project authorization\n`);
    await assert.rejects(service.modRuntimeRolloutAuthorizeProject({ mod_id: "rollout-mod", target_project_id: "project-b",
      actor: "user:source-owner", reason: "approved isolated code reuse" }), /renewed review and trust/u);
    await writeFile(join(packageRoot, "register.mjs"), sourceBytes);
    await service.modRuntimeRolloutAuthorizeProject({ mod_id: "rollout-mod", target_project_id: "project-b", actor: "user:source-owner", reason: "approved isolated code reuse" });
    assert.equal(store.get("runtime_mod", "rollout-mod").scope_kind, "global");
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-b", project_id: "project-b" }), true);
    service.modRuntimeRolloutPause({ mod_id: "rollout-mod", actor: "user:test", reason: "verify resume path" });
    assert.equal((await service.modRuntimeRolloutResume({ mod_id: "rollout-mod", actor: "user:test" })).status, "active");
    store.create("task", "project-b-derived-task", { workspace_id: "project-b" });
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "task", scope_id: "project-b-derived-task",
      task_id: "project-b-derived-task" }), true, "project scope can be derived from an authoritative Task workspace binding");
    const projectApproval = store.get("runtime_mod_project_approval", "runtime_mod_project_approval_rollout-mod_project-b");
    assert.equal(projectApproval.package_copy_digest, store.get("runtime_mod", "rollout-mod").code_digest);
    assert.equal(projectApproval.source_data_included, false);
    const copiedEntry = join(String(projectApproval.package_copy_path), "register.mjs");
    const copiedSource = await readFile(copiedEntry, "utf8");
    assert.match(copiedSource, /register\(on\)/u);
    store.save("runtime_mod_project_approval", String(projectApproval.id), { ...projectApproval,
      package_copy_path: join(root, "missing-isolated-copy") });
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-b", project_id: "project-b" }), false,
      "a missing project copy fails closed and records an unavailable-copy event");
    store.save("runtime_mod_project_approval", String(projectApproval.id), projectApproval);
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-b", project_id: "project-b" }), true);
    await writeFile(copiedEntry, `${copiedSource}// tampered after approval\n`);
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-b", project_id: "project-b" }), false,
      "a changed isolated copy is unavailable even while the source package remains trusted");
    await writeFile(copiedEntry, copiedSource);
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-b", project_id: "project-b" }), true);
    for (let index = 1; index <= 4; index += 1) await dispatchRealDelivery("global", "global", `global-task-${index}`, "project-a");
    const crossProjectRun = await dispatchRealDelivery("global", "global", "global-task-5", "project-b");
    assert.equal(crossProjectRun.status, "completed");
    assert.equal(((crossProjectRun.receipt as JsonObject).execution as JsonObject[]).some((item) => item.mod_id === "rollout-mod"), true,
      "the approved project's isolated package copy executes the same exact trusted version");
    const rollout = store.get("runtime_mod_rollout", "rollout-mod");
    assert.equal(rollout.global_gate_passed, true);
    assert.equal((rollout.stage_history as JsonObject[]).length, 3);
    assert.equal(service.modRuntimeRolloutGet({ mod_id: "rollout-mod" }).rollout && true, true);
    const repeatedApproval = await service.modRuntimeRolloutAuthorizeProject({ mod_id: "rollout-mod", target_project_id: "project-b",
      actor: "user:source-owner", reason: "approved isolated code reuse" });
    assert.equal((repeatedApproval.approval as JsonObject).id, projectApproval.id,
      "repeating the exact project approval reuses the reviewed isolated copy");
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-c", project_id: "project-c" }), false,
      "passing the global gate does not silently authorize unreviewed project data");
    await service.modRuntimeRolloutAuthorizeProject({ mod_id: "rollout-mod", target_project_id: "project-c", actor: "user:source-owner", reason: "approved isolated code reuse" });
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-c", project_id: "project-c" }), true);
    service.modRuntimeWithdraw({ mod_id: "rollout-mod", scope_kind: "project", scope_id: "project-c",
      actor: "user:project-owner", reason: "project owner withdrew reuse" });
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-c", project_id: "project-c" }), false);
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-b", project_id: "project-b" }), true,
      "project withdrawal revokes only the selected project's package authorization");
    assert.equal(store.get("runtime_mod_project_approval", "runtime_mod_project_approval_rollout-mod_project-c").status, "withdrawn");
    store.save("runtime_mod_rollout", "rollout-mod", { ...rollout, regression_digest: "sha256:stale-regression-set" });
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-a", project_id: "project-a" }), false);
    assert.equal(store.get("runtime_mod_rollout", "rollout-mod").pause_reason, "qualification_runtime_changed");
    await service.modRuntimeRolloutResume({ mod_id: "rollout-mod", actor: "user:test" });
    const requalified = store.get("runtime_mod_rollout", "rollout-mod");
    store.save("runtime_mod_rollout", "rollout-mod", { ...requalified, global_revalidated_at: "2026-01-01T00:00:00.000Z" });
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "project", scope_id: "project-a", project_id: "project-a" }), false);
    assert.equal(store.get("runtime_mod_rollout", "rollout-mod").pause_reason, "global_revalidation_due");
    const trustedSource = await readFile(join(packageRoot, "register.mjs"), "utf8");
    await writeFile(join(packageRoot, "register.mjs"), `${trustedSource}// temporarily changed\n`);
    await assert.rejects(service.modRuntimeRolloutResume({ mod_id: "rollout-mod", actor: "user:test" }), /renewed review and trust/u);
    await writeFile(join(packageRoot, "register.mjs"), trustedSource);
    await service.modRuntimeRolloutResume({ mod_id: "rollout-mod", actor: "user:test" });
    service.modRuntimeRolloutPause({ mod_id: "rollout-mod", actor: "user:test", reason: "manual review" });
    assert.equal(service.modRuntimeHasTrustedEvent("craft.task.lifecycle@1", { scope_kind: "global", scope_id: "global", task_id: "later-task", project_id: "project-a" }), false);
    await service.modRuntimeRolloutResume({ mod_id: "rollout-mod", actor: "user:test" });
    assert.equal(store.get("runtime_mod_rollout", "rollout-mod").status, "active");
    const globalRegression = await service.modRuntime.candidateRegressionRun("rollout-mod", "global");
    const globalRegressionRecord = globalRegression.regression as JsonObject;
    store.save("runtime_mod_regression", String(globalRegressionRecord.id), { ...globalRegressionRecord, verdict: "failed" });
    const failedCrossProjectRegression = await service.modRuntimeRolloutAuthorizeProject({ mod_id: "rollout-mod", target_project_id: "project-d",
      actor: "user:source-owner", reason: "exercise failed global regression gate" });
    assert.equal(failedCrossProjectRegression.status, "rolled_back");
    assert.equal(store.get("runtime_mod", "rollout-mod").enabled, false);
    assert.equal(store.get("runtime_mod_rollout", "rollout-mod").reason, "cross_project_regression_failed");
    service.modRuntimeWithdraw({ mod_id: "rollout-mod", scope_kind: "global", scope_id: "global", actor: "user:test", reason: "operator withdrawal" });
    assert.equal(store.get("runtime_mod_rollout", "rollout-mod").status, "withdrawn");
    assert.equal(store.get("runtime_mod", "rollout-mod").enabled, false);

    const qualityBaselineRoot = join(root, "quality-baseline"); await mkdir(qualityBaselineRoot);
    await writeFile(join(qualityBaselineRoot, "register.mjs"), `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n`);
    service.modRuntimeStage({ manifest: { id: "quality-baseline", name: "Quality baseline", version: "1.0.0", entry: "register.mjs",
      scope_kind: "task", scope_id: "quality-task", capabilities: ["event.observe"],
      hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] }, package_root: qualityBaselineRoot });
    const stagedBaseline = store.get("runtime_mod", "quality-baseline");
    store.save("runtime_mod", "quality-baseline", { ...stagedBaseline, origin: "self_evolved", lineage_id: "quality-lineage",
      candidate_provenance: { source_project_id: "project-a" } });
    const baselineRegression = await service.modRuntimeCandidateRegressionRun({ mod_id: "quality-baseline" });
    const baselineRegressionRecord = baselineRegression.regression as JsonObject;
    store.create("runtime_mod_candidate", "quality-baseline", { status: "qualified_untrusted",
      regression_id: baselineRegressionRecord.id, blockers: [] });
    const baselineReview = service.modRuntimeReview({ mod_id: "quality-baseline" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "quality-baseline", code_digest: baselineReview.code_digest,
      permission_digest: baselineReview.permission_digest, actor: "user:test" });

    const qualityRoot = join(root, "quality-candidate"); await mkdir(qualityRoot);
    await writeFile(join(qualityRoot, "register.mjs"), `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n`);
    service.modRuntimeStage({ manifest: { id: "quality-mod", name: "Quality Mod", version: "1.0.0", entry: "register.mjs",
      scope_kind: "task", scope_id: "quality-task", capabilities: ["event.observe"],
      hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] }, package_root: qualityRoot });
    const stagedQuality = store.get("runtime_mod", "quality-mod");
    store.save("runtime_mod", "quality-mod", { ...stagedQuality, origin: "self_evolved", lineage_id: "quality-lineage",
      candidate_provenance: { source_project_id: "project-a" } });
    const qualityRegression = await service.modRuntimeCandidateRegressionRun({ mod_id: "quality-mod" });
    const qualityRegressionRecord = qualityRegression.regression as JsonObject;
    store.create("runtime_mod_candidate", "quality-mod", { status: "qualified_untrusted",
      regression_id: qualityRegressionRecord.id, blockers: [] });
    const qualityReview = service.modRuntimeReview({ mod_id: "quality-mod" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "quality-mod", code_digest: qualityReview.code_digest,
      permission_digest: qualityReview.permission_digest, actor: "user:test" });
    service.modRuntimeRolloutStart({ mod_id: "quality-mod", actor: "user:test" });
    store.create("task", "quality-task", { id: "quality-task", workspace_id: "project-a" });
    store.create("host_run", "quality-host", { status: "completed", task_id: "quality-task" });
    store.create("work_launch", "quality-launch", { id: "quality-launch", task_id: "quality-task", run_id: "quality-host" });
    const qualityRun = store.create("task_run", "quality-run", { launch_id: "quality-launch", launch_identity: { task_id: "quality-task" } });
    store.create("task_run_state", "task_run_state_quality-run", { task_run_version: qualityRun.version,
      status: "recovery", action: "retry_or_handoff" });
    store.create("work_delivery", "quality-delivery", { launch_id: "quality-launch", launch_version: 1,
      run_id: "quality-host", run_version: 1, status: "rejected" });
    await service.modRuntimeDispatch({ event: "craft.task.lifecycle@1", host: "workbench", scope_kind: "task",
      scope_id: "quality-task", task_id: "quality-task", project_id: "project-a", delivery_id: "quality-event",
      input: { task_id: "quality-task", task_run_id: "quality-run", delivery_id: "quality-delivery",
        status: "recovery", action: "retry_or_handoff", scope_kind: "task", scope_id: "quality-task" } });
    assert.equal(store.get("runtime_mod_rollout", "quality-mod").reason, "quality_regression");
    assert.equal(store.get("runtime_mod_rollout", "quality-mod").trigger_kind, "work_delivery");
    assert.equal(store.get("runtime_mod", "quality-mod").code_digest, baselineReview.code_digest,
      "quality rollback restores the latest exact trusted version in the lineage");
    assert.equal(store.get("runtime_mod", "quality-mod").enabled, true);
    assert.equal(store.get("runtime_mod", "quality-mod").trust_status, "trusted");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a failing self-evolved task Hook immediately restores the latest still-valid trusted Mod version", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-rollout-rollback-"));
  const baselineRoot = join(root, "baseline"); const candidateRoot = join(root, "candidate");
  await mkdir(baselineRoot); await mkdir(candidateRoot);
  await writeFile(join(baselineRoot, "register.mjs"), `export function register(on) { on("craft.task.lifecycle@1", () => ({ kind: "continue" })); }\n`);
  await writeFile(join(candidateRoot, "register.mjs"), `export function register(on) { on("craft.task.lifecycle@1", (event) => { if (event.status === "ready_for_delivery") throw new Error("candidate regressed"); return { kind: "continue" }; }); }\n`);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const manifest = { id: "rollback-mod", name: "Rollback Mod", version: "1.0.0", entry: "register.mjs", scope_kind: "task", scope_id: "repair-task",
      capabilities: ["event.observe"], hooks: [{ event: "craft.task.lifecycle@1", capability: "event.observe" }] };
    service.modRuntimeStage({ manifest, package_root: baselineRoot });
    let review = service.modRuntimeReview({ mod_id: "rollback-mod" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "rollback-mod", code_digest: review.code_digest, permission_digest: review.permission_digest, actor: "user:test" });
    service.modRuntimeStage({ manifest, package_root: candidateRoot });
    const staged = store.get("runtime_mod", "rollback-mod");
    store.save("runtime_mod", "rollback-mod", { ...staged, origin: "self_evolved" });
    const regressionResult = await service.modRuntimeCandidateRegressionRun({ mod_id: "rollback-mod" });
    const regression = regressionResult.regression as JsonObject;
    store.create("runtime_mod_candidate", "rollback-mod", { status: "qualified_untrusted", regression_id: regression.id, blockers: [] });
    review = service.modRuntimeReview({ mod_id: "rollback-mod" }) as JsonObject;
    service.modRuntimeTrust({ mod_id: "rollback-mod", code_digest: review.code_digest,
      permission_digest: review.permission_digest, actor: "user:test" });
    service.modRuntimeRolloutStart({ mod_id: "rollback-mod", actor: "user:test" });

    const failed = await service.modRuntimeDispatch({ event: "craft.task.lifecycle@1", host: "workbench",
      scope_kind: "task", scope_id: "repair-task", task_id: "repair-task", project_id: "project-a",
      input: { task_id: "repair-task", status: "ready_for_delivery", scope_kind: "task", scope_id: "repair-task" } });
    assert.equal(failed.status, "failed");
    const restored = store.get("runtime_mod", "rollback-mod");
    assert.equal(restored.code_digest, store.list("runtime_mod_version", 10)[0]?.code_digest);
    assert.equal(restored.origin, "human");
    assert.equal(restored.enabled, true);
    assert.equal(restored.trust_status, "trusted");
    const rollout = store.get("runtime_mod_rollout", "rollback-mod");
    assert.equal(rollout.status, "rolled_back");
    assert.equal(rollout.reason, "safety_regression");
    assert.equal(rollout.rollback_target_digest, restored.code_digest);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
