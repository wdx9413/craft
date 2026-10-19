import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { CraftService } from "../../core/service.ts";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { defaultSettings } from "../../core/settings.ts";
import { projectIdentityFromRoot } from "../../core/scope-identity.ts";
import { stableDigest } from "../../core/digest.ts";
import { AUTOMATIC_SIGNOFF_POLICY } from "../../capability/craft-experience/scenario-evaluation.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";

const sourceMcpEntrypoint = process.env.CRAFT_SMOKE_MCP_ENTRYPOINT?.trim();
const sourceHookEntrypoint = process.env.CRAFT_SMOKE_HOOK_ENTRYPOINT?.trim();
const plugin = sourceMcpEntrypoint || resolve(import.meta.dirname, "../../plugins/craft-context/dist/plugin/craft-mcp.cjs");
const contextPlugin = plugin;
const packagedContextHook = sourceHookEntrypoint || resolve(import.meta.dirname, "../../plugins/craft-context/dist/plugin/craft-codex-hook.cjs");
const generatedWorkflow = { name: "Automatically distilled verification", description: "A read-only assertion distilled from verified tasks.", inputs: ["project_root", "case_path"],
  steps: [{ id: "sentinel", type: "assertion", evaluator: "file_exists", path: "{{case_path}}", side_effect: "read_only" }] };
const revisedWorkflow = { name: "Automatically distilled verification v2", description: "Keep the prior check and add a newly verified marker.", inputs: ["project_root", "case_path"],
  steps: [{ id: "sentinel", type: "assertion", evaluator: "file_exists", path: "{{case_path}}", side_effect: "read_only" },
    { id: "sentinel-v2", type: "assertion", evaluator: "file_exists", path: "sentinel-v2.txt", side_effect: "read_only" }] };
const delay = (milliseconds: number) => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const isUnder = (root: string, path: unknown): boolean => {
  if (typeof path !== "string") return false;
  const canonicalRoot = realpathSync(root), canonicalPath = realpathSync(path);
  return canonicalPath === canonicalRoot || canonicalPath.startsWith(`${canonicalRoot}${sep}`);
};
function temporaryMemoryDirectory(sessionId: string): string {
  return join("/tmp", ".craft_data", "memory", createHash("sha256").update(sessionId).digest("hex").slice(0, 32));
}
function scenarioCatalog(projectRoot: string, heldOutPath: string, scenarioKey = "auto-build"): JsonObject {
  const cases = (caseId: string, casePath: string) => [{ case_id: caseId, project_root: projectRoot, inputs: { case_path: casePath } }];
  const caseSet = (values: JsonObject[], independent = false) => ({ case_set_ref: stableDigest(values), cases: values,
    ...(independent ? { independent_of_training: true } : {}) });
  return { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: scenarioKey, verification_commands: ["pnpm test"],
    evaluation: { schema: "craft.experience-evaluation.v1", signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY,
      stages: { shadow: caseSet(cases("shadow", "sentinel.txt")),
        held_out: caseSet(cases("held-out", heldOutPath), true), canary: caseSet(cases("canary", "sentinel.txt")) } } }] };
}

const dataRoot = await mkdtemp(join(tmpdir(), "craft-auto-evolution-data-"));
const projectRoot = await mkdtemp(join(tmpdir(), "craft-auto-evolution-project-"));
const memoryProjectRoots = [projectRoot, join(dataRoot, "projects", "memory-project-b"), join(dataRoot, "projects", "memory-project-c")];
const paths = craftPaths(dataRoot);
const providerStatePath = join(dataRoot, "model-fixture-state.json");
const modelFixture = resolve(import.meta.dirname, "../../tests/fixtures/mock-learning-model.mjs");
const previousNodeOptions = process.env.NODE_OPTIONS;
const previousLearningApiKey = process.env.CRAFT_LEARNING_E2E_API_KEY;
async function providerCallCount(): Promise<number> {
  try { return Number((JSON.parse(await readFile(providerStatePath, "utf8")) as JsonObject).calls ?? 0); }
  catch { return 0; }
}
async function knowledgeClassificationCallCount(): Promise<number> {
  try { return Number((JSON.parse(await readFile(providerStatePath, "utf8")) as JsonObject).knowledge_classification_calls ?? 0); }
  catch { return 0; }
}
function callPackagedMemoryHook(dataRoot: string, input: JsonObject): JsonObject {
  return callPackagedContextHook(dataRoot, input);
}

function callPackagedContextHook(dataRoot: string, input: JsonObject): JsonObject {
  const result = spawnSync(process.execPath, [packagedContextHook, "--member", "context"], {
    cwd: typeof input.cwd === "string" ? input.cwd : projectRoot,
    env: { ...process.env, CRAFT_DATA_DIR: dataRoot }, input: JSON.stringify(input), encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined, `packaged Context Hook must start: ${result.error?.message ?? ""}`);
  assert.equal(result.status, 0, `packaged Context Hook must exit cleanly: ${result.stderr}`);
  try { return JSON.parse(result.stdout) as JsonObject; }
  catch { assert.fail(`packaged Context Hook must return JSON: ${result.stdout}`); }
}

function recordVerifiedContextTask(dataRoot: string, sessionId: string, turnId: string): void {
  const base = { cwd: projectRoot, session_id: sessionId, turn_id: turnId };
  callPackagedContextHook(dataRoot, { ...base, hook_event_name: "UserPromptSubmit", prompt: "Complete and verify this project change." });
  callPackagedContextHook(dataRoot, { ...base, hook_event_name: "PostToolUse", tool_name: "Edit" });
  callPackagedContextHook(dataRoot, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: { exit_code: 0 } });
  callPackagedContextHook(dataRoot, { ...base, hook_event_name: "Stop" });
  callPackagedContextHook(dataRoot, { ...base, hook_event_name: "SessionEnd" });
}

interface ContextWorkerProbe {
  seed?(dataRoot: string): Promise<void>;
  environment?: NodeJS.ProcessEnv;
  verifyArtifact?(dataRoot: string): Promise<void>;
  cleanup?(): Promise<void>;
}

async function verifyContextWorker(component: "knowledge" | "experience", expected: string[], forbidden: string[], probe: ContextWorkerProbe = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `craft-${component}-worker-data-`));
  const entrypoint = contextPlugin;
  try { await probe.seed?.(root); }
  catch (error) { await rm(root, { recursive: true, force: true }); await probe.cleanup?.(); throw error; }
  const processHandle = spawn(process.execPath, [entrypoint, "--product", "context"], { env: { ...process.env,
    ...probe.environment, CRAFT_DATA_DIR: root, CRAFT_CONTINUOUS_LEARNING: "1", CRAFT_KNOWLEDGE_POLL_MS: "60000", CRAFT_EXPERIENCE_POLL_MS: "1000" },
    stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  processHandle.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
  processHandle.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, rejectClose) => {
    processHandle.once("error", rejectClose);
    processHandle.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  try {
    processHandle.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } })}\n`);
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`${component} MCP initialization timed out`)), 5_000);
      const onData = (chunk: string) => {
        if (!output.includes('"id":"init"')) return;
        clearTimeout(timeout);
        processHandle.stdout.off("data", onData);
        resolveReady();
      };
      processHandle.stdout.on("data", onData);
    });
    processHandle.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const paths = craftPaths(root);
    let observedCalls = new Set<string>();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const store = await new CraftStore(paths).open();
      try { observedCalls = new Set(store.list("trace_event", 10_000).map(row => String(row.operation_id))); }
      finally { store.close(); }
      if (expected.every(name => observedCalls.has(name))) break;
      await delay(100);
    }
    for (const name of expected) assert(observedCalls.has(name), `${component} package worker must call ${name}; stderr=${errors}`);
    for (const name of forbidden) assert(!observedCalls.has(name), `${component} package worker must not call ${name}`);
    assert(!/learning worker failed|learning worker stopped/iu.test(errors), `${component} package worker must not report a worker failure: ${errors}`);
    await probe.verifyArtifact?.(root);

    processHandle.stdin.end();
    const exit = await Promise.race([closed, delay(5_000).then(() => { throw new Error(`${component} MCP did not shut down cleanly`); })]);
    assert.equal(exit.code, 0, `${component} MCP package failed during shutdown: ${errors}`);
    assert.equal(output.split("\n").filter(Boolean).length, 1, "standalone worker output must stay off the MCP protocol stream");
  } finally {
    if (processHandle.exitCode === null) {
      processHandle.stdin.end();
      const stopped = await Promise.race([closed.then(() => true), delay(5_000).then(() => false)]);
      if (!stopped) { processHandle.kill("SIGKILL"); await closed; }
    }
    await rm(root, { recursive: true, force: true });
    await probe.cleanup?.();
  }
}

let child: ChildProcessWithoutNullStreams | undefined;
let childOutput = "", childError = "";
let childClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
try {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(providerStatePath, JSON.stringify({ calls: 0 }));
  process.env.NODE_OPTIONS = [previousNodeOptions, `--import=${pathToFileURL(modelFixture).href}`].filter(Boolean).join(" ");
  await writeFile(join(projectRoot, "sentinel.txt"), "shadow and canary fixture");
  await writeFile(join(projectRoot, "held-out-sentinel.txt"), "independent held-out fixture");
  const knowledgeText = "# Project rule\nRun focused verification before delivery.\n";
  const knowledgeSourceRoots = ["a", "b"].map(name => join(projectRoot, `knowledge-${name}`));
  for (const [index, sourceRoot] of knowledgeSourceRoots.entries()) {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "README.md"), knowledgeText);
  }
  await Promise.all(memoryProjectRoots.slice(1).map(root => mkdir(root, { recursive: true })));
  const settings = defaultSettings(paths);
  settings.models = [{ id: "local-e2e", name: "local-e2e", protocol: "openai-compatible", baseUrl: "http://craft-e2e.invalid/v1",
    model: "local-e2e-model", apiKeyEnv: "CRAFT_LEARNING_E2E_API_KEY", supportsTools: false }];
  await writeFile(paths.settingsFile, JSON.stringify(settings));
  process.env.CRAFT_LEARNING_E2E_API_KEY = "local-test-credential";

  const store = await new CraftStore(paths).open();
  try {
    const service = new CraftService(store);
    const project = projectIdentityFromRoot(projectRoot).canonical_scope as JsonObject;
    for (const [index, sourceRoot] of knowledgeSourceRoots.entries()) service.knowledgeSourceRegister({ source_id: `e2e-knowledge-${index}`,
      kind: "readme", label: `Verified fixture ${index}`, scope_kind: "project", scope_id: project.id, locator: sourceRoot,
      content_digest: `fixture:${index}`, trust: "verified", access: "read_only" });
    const memorySessions: string[] = [];
    for (const [projectIndex, root] of memoryProjectRoots.entries()) {
      for (const sessionId of [`memory-e2e-${projectIndex}-a`, `memory-e2e-${projectIndex}-b`]) {
        memorySessions.push(sessionId);
        callPackagedMemoryHook(dataRoot, { hook_event_name: "UserPromptSubmit", cwd: root, session_id: sessionId, prompt: "本项目默认使用 Node.js" });
      }
    }
    try {
      assert.match(await readFile(join(dataRoot, "memory", "memory.md"), "utf8"), /Node\.js/u,
        "three projects with repeated independent sessions must automatically promote Memory to global tier");
      for (const root of memoryProjectRoots) assert.match(await readFile(join(root, ".craft_data", "memory", "memory.md"), "utf8"), /Node\.js/u,
        "repeated independent sessions must promote Memory to each project tier");
      assert(store.list("activation_proof_receipt", 1_000, proof => proof.component === "memory" && proof.event === "UserPromptSubmit" && proof.memory_written === true).length > 0,
        "automatic Memory capture and promotion must leave a current Host invocation receipt");
      assert(store.list("trace_event", 10_000, event => event.source === "craft-hook" && event.operation_id === "handle").length > 0,
        "Memory Hook invocation must leave a queryable component trace");
    } finally {
      for (const sessionId of memorySessions) {
        callPackagedMemoryHook(dataRoot, { hook_event_name: "SessionEnd", cwd: projectRoot, session_id: sessionId });
        assert(service.memoryGovernance.ledger.files.isSessionArchived(sessionId), "SessionEnd must persist Memory archive state");
        assert(!existsSync(temporaryMemoryDirectory(sessionId)), "archived Memory sessions must delete their temporary directories");
      }
    }
    const scenarioDirectory = join(projectRoot, ".craft_data", "experience");
    await mkdir(scenarioDirectory, { recursive: true });
    await writeFile(join(scenarioDirectory, "experience-scenarios.json"), JSON.stringify(scenarioCatalog(projectRoot, "held-out-sentinel.txt")));
    recordVerifiedContextTask(dataRoot, "experience-session-one", "experience-turn-one");
    recordVerifiedContextTask(dataRoot, "experience-session-two", "experience-turn-two");
    const requests = store.list("workflow_evolution_request", 100);
    assert.equal(store.list("workflow_evolution_observation", 100).filter(row => row.scenario_key && String(row.scenario_key).startsWith("scenario:")).length, 2,
      "packaged Context Hook must turn two independent edit-and-passed-verification turns into Experience observations");
    const request = requests.find(row => row.lifecycle === "awaiting_model");
    assert(request, "the second independently verified Hook turn must automatically produce a Workflow Evolution request");
    const ticket = store.list("evaluation_model_ticket", 100, row => row.purpose === "workflow_evolution"
      && (row.target as JsonObject | undefined)?.id === request.id)[0];
    assert(ticket, "automatic Hook completion must issue a model ticket");
    assert.match(String(ticket.profile_id), /^evaluation_model_profile_auto_/u,
      "the only configured Craft model must bootstrap a bounded workflow evolution profile and ticket");
    assert.equal(ticket.status, "ready_for_adapter");
    const profile = service.evaluationModelProfileGet({ profile_id: String(ticket.profile_id) }).profile as JsonObject;
    assert.equal(profile.provider, "local-e2e");
    assert.equal(profile.model, "local-e2e-model");
    assert.equal(profile.network_execution_enabled, true);
    assert.equal(profile.max_attempts, 1);
    assert.equal(profile.max_output_tokens, 2_048);

  } finally { store.close(); }

  child = spawn(process.execPath, [plugin, "--product", "context"], { env: { ...process.env, CRAFT_DATA_DIR: dataRoot,
    CRAFT_CONTINUOUS_LEARNING: "1", CRAFT_LEARNING_E2E_API_KEY: "local-test-credential", CRAFT_EXPERIENCE_POLL_MS: "1000",
    CRAFT_KNOWLEDGE_POLL_MS: "60000", CRAFT_LEARNING_E2E_PROVIDER_STATE: providerStatePath,
    CRAFT_LEARNING_E2E_WORKFLOWS: JSON.stringify([generatedWorkflow, revisedWorkflow]) }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8").on("data", chunk => { childOutput += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { childError += chunk; });
  childClosed = new Promise((resolveClose, rejectClose) => {
    child!.once("error", rejectClose);
    child!.once("close", (code, signal) => resolveClose({ code, signal }));
  });

  let routeable: JsonObject | undefined;
  let evidenceCount = 0;
  let evidenceStages = new Set<string>();
  let runCount = 0;
  let knowledgeClaimPromoted = false;
  let promotedKnowledgeClaim: JsonObject | undefined;
  let knowledgeIngestCallsBeforeUpdate = 0;
  let revisedKnowledgeClaim: JsonObject | undefined;
  let originalKnowledgeClaimStale = false;
  let revisedKnowledgeSupportCount = 0;
  let knowledgeIngestCallsAfterUpdate = 0;
  let knowledgeClassificationEvents: JsonObject[] = [];
  let classifiedKnowledgeClaim = false;
  let tracedCalls = new Set<string>();
  let diagnostic: JsonObject = {};
  const expectedCalls = new Set(["handle", "craft_evaluation_model_ticket_list", "craft_experience_learning_request_get", "craft_experience_procedure_submit",
    "craft_experience_learning_evaluation_dispatch", "craft_experience_learning_evaluation_dispatch_list", "craft_experience_learning_evaluation_run",
    "craft_knowledge_source_list", "craft_knowledge_source_ingest"]);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const observed = await new CraftStore(paths).open();
    try {
      routeable = observed.list("experience_procedure", 100, row => row.title === generatedWorkflow.name
        && row.procedure_kind === "workflow" && row.lifecycle === "routeable" && row.routeable === true)[0];
      const evaluationEvidence = observed.list("evidence", 100, row => {
        const metadata = row.metadata as JsonObject | undefined;
        return typeof metadata?.experience_evaluation_dispatch_id === "string";
      });
      evidenceCount = evaluationEvidence.length;
      evidenceStages = new Set(evaluationEvidence.map(row => String((row.metadata as JsonObject).stage)));
      runCount = observed.list("workflow_run", 100, row => typeof row.evaluator_dispatch_id === "string").length;
      promotedKnowledgeClaim = observed.list("knowledge_claim", 100, row => row.status === "reviewed").find(claim =>
        observed.list("knowledge_claim_support", 1_000, support => support.claim_id === claim.id).length >= 2);
      knowledgeClaimPromoted = Boolean(promotedKnowledgeClaim);
      classifiedKnowledgeClaim = observed.list("knowledge_claim", 100, row => row.id === promotedKnowledgeClaim?.id && row.status === "reviewed"
        && row.scenario_key === "project.delivery.verification").length === 1;
      knowledgeClassificationEvents = observed.list("trace_event", 10_000, row => row.actor === "knowledge-classification-worker")
        .sort((a, b) => Number(a.sequence) - Number(b.sequence))
        .map(({ event_kind, error_class, status, operation_id, data }) => ({ event_kind, error_class, status, operation_id,
          failure_stage: (data as JsonObject | undefined)?.failure_stage }));
      knowledgeIngestCallsBeforeUpdate = observed.list("trace_event", 10_000, row => row.operation_id === "craft_knowledge_source_ingest").length;
      tracedCalls = new Set(observed.list("trace_event", 10_000, row => expectedCalls.has(String(row.operation_id))).map(row => String(row.operation_id)));
      diagnostic = { requests: observed.list("workflow_evolution_request", 20).map(({ id, lifecycle }) => ({ id, lifecycle })),
        knowledge_claims: observed.list("knowledge_claim", 100).map(({ id, status, scenario_key, scope }) => ({ id, status, scenario_key: scenario_key ?? null, scope })),
        knowledge_classification_tickets: observed.list("evaluation_model_ticket", 100, row => row.purpose === "knowledge_scenario_classification")
          .map(({ id, status, target }) => ({ id, status, target })),
        knowledge_classification_calls: await knowledgeClassificationCallCount(),
        knowledge_classification_events: knowledgeClassificationEvents,
        tickets: observed.list("evaluation_model_ticket", 20).map(({ id, lifecycle, readiness, target }) => ({ id, lifecycle, readiness, target })),
        procedures: observed.list("experience_procedure", 20).map(({ id, lifecycle, title, procedure_kind, routeable }) => ({ id, lifecycle, title, procedure_kind, routeable })),
        dispatches: observed.list("experience_evaluation_dispatch", 20).map(({ id, stage, status, reason }) => ({ id, stage, status, reason })),
        provider_calls: await providerCallCount(), knowledge_claim_promoted: knowledgeClaimPromoted, traced_calls: [...tracedCalls] };
    } finally { observed.close(); }
    if (routeable && evidenceCount === 4 && evidenceStages.size === 4 && runCount === 3 && knowledgeClaimPromoted && classifiedKnowledgeClaim
      && knowledgeClassificationEvents.length === 3
      && tracedCalls.size === expectedCalls.size && await providerCallCount() === 1 && await knowledgeClassificationCallCount() > 0) break;
    await delay(100);
  }

  assert(routeable, `packaged Context worker did not formally promote a Workflow; stderr=${childError}; state=${JSON.stringify(diagnostic)}`);
  assert.equal(evidenceCount, 4, "Shadow, Held-out, Signoff and Canary must each persist bound Evidence");
  assert.deepEqual(evidenceStages, new Set(["shadow", "held_out", "signoff", "canary"]), "all four ordered gates must persist Evidence");
  assert.equal(runCount, 3, "Shadow, Held-out and Canary each execute the evaluator; automatic Signoff consumes their Evidence");
  assert(knowledgeClaimPromoted, "two independently registered verified Knowledge sources must auto-promote their shared Claim");
  assert(classifiedKnowledgeClaim, `the continuous Knowledge classifier must classify the reviewed Claim without changing its review status; state=${JSON.stringify(diagnostic)}; stderr=${childError}`);
  assert.deepEqual(knowledgeClassificationEvents.map(event => event.event_kind), ["model.request", "model.completed", "classification.saved", "model.result_bound"],
    "Knowledge classification must persist the model request, response and saved candidate Trace without content");
  assert((await knowledgeClassificationCallCount()) > 0, "the packaged learning worker must use its model to classify Knowledge");
  assert(existsSync(paths.knowledgeDatabaseFile), "Knowledge artifacts must persist in the central .craft_data/knowledge store");
  assert(isUnder(join(projectRoot, ".craft_data", "knowledge", "md"), (promotedKnowledgeClaim!.content_ref as JsonObject | undefined)?.path),
    "Project-scoped Knowledge Markdown must stay under that project's .craft_data/knowledge/md directory");
  assert(isUnder(paths.experienceContentDir, (routeable!.content_ref as JsonObject | undefined)?.path),
    "Experience review content must stay under the central .craft_data/experience directory");
  assert(isUnder(join(paths.experienceDir, "graph"), (routeable!.definition_ref as JsonObject | undefined)?.path),
    "Experience executable definitions must stay under the central .craft_data/experience/graph directory");
  assert.deepEqual(tracedCalls, expectedCalls, "worker model, submission, evaluation and Knowledge calls must be traced");
  assert.equal(await providerCallCount(), 1, "the packaged worker must execute one model request against the local fixture");

  const originalKnowledgeDigest = String(promotedKnowledgeClaim!.content_digest);
  const revisedKnowledgeText = "# Project rule\nRun focused and full verification before delivery.\n";
  for (const sourceRoot of knowledgeSourceRoots) await writeFile(join(sourceRoot, "README.md"), revisedKnowledgeText);
  let knowledgeRevisionDiagnostic: JsonObject = {};
  for (let attempt = 0; attempt < 750; attempt += 1) {
    const observed = await new CraftStore(paths).open();
    try {
      const claims = observed.list("knowledge_claim", 1_000);
      knowledgeIngestCallsAfterUpdate = observed.list("trace_event", 10_000, row => row.operation_id === "craft_knowledge_source_ingest").length;
      const original = claims.find(claim => claim.content_digest === originalKnowledgeDigest);
      originalKnowledgeClaimStale = original?.status === "stale";
      revisedKnowledgeClaim = claims.find(claim => claim.status === "reviewed" && claim.content_digest !== originalKnowledgeDigest
        && observed.list("knowledge_claim_support", 1_000, support => support.claim_id === claim.id).length >= 2);
      revisedKnowledgeSupportCount = revisedKnowledgeClaim
        ? observed.list("knowledge_claim_support", 1_000, support => support.claim_id === revisedKnowledgeClaim!.id).length : 0;
      knowledgeRevisionDiagnostic = { original_claim_status: original?.status ?? null,
        revised_claims: claims.filter(claim => claim.content_digest !== originalKnowledgeDigest).map(({ id, status, content_digest }) => ({ id, status, content_digest })),
        source_revisions: observed.list("knowledge_source_revision", 100, revision => revision.status === "current").map(({ id, source_id }) => ({ id, source_id })) };
    } finally { observed.close(); }
    if (originalKnowledgeClaimStale && revisedKnowledgeClaim) break;
    await delay(100);
  }
  assert(originalKnowledgeClaimStale,
    `a changed trusted Source must stale the previously promoted Knowledge Claim; state=${JSON.stringify(knowledgeRevisionDiagnostic)}`);
  assert(revisedKnowledgeClaim,
    `independent updated Sources must create and auto-promote a new Knowledge Claim; state=${JSON.stringify(knowledgeRevisionDiagnostic)}`);
  assert.notEqual(revisedKnowledgeClaim!.content_digest, originalKnowledgeDigest, "Knowledge iteration must create a new immutable Claim identity");
  assert.equal(revisedKnowledgeSupportCount, 2,
    "the revised Claim must retain independent support from both verified Sources");
  assert(knowledgeIngestCallsAfterUpdate > knowledgeIngestCallsBeforeUpdate,
    "the second Knowledge promotion must be caused by a later, traceable worker ingestion pass");

  const firstProcedureId = String(routeable.id), firstProcedureVersion = Number(routeable.version);
  await writeFile(join(projectRoot, "sentinel-v2.txt"), "newly observed marker");
  await writeFile(join(projectRoot, "held-out-sentinel-v2.txt"), "independent held-out fixture for iteration two");
  const scenarioPath = join(projectRoot, ".craft_data", "experience", "experience-scenarios.json");
  await writeFile(scenarioPath, JSON.stringify(scenarioCatalog(projectRoot, "held-out-sentinel-v2.txt")));

  const nextStore = await new CraftStore(paths).open();
  try {
    recordVerifiedContextTask(dataRoot, "experience-session-three", "experience-turn-three");
    const scenario = String(nextStore.list("workflow_evolution_observation", 100)[0]?.scenario_key ?? "");
    assert.equal(nextStore.list("workflow_evolution_request", 100, row => row.scenario_key === scenario).length, 2,
      "a later packaged Hook verification must create a second request for the same scenario, even if the worker already consumed it");
  } finally { nextStore.close(); }

  let evolved: JsonObject | undefined;
  let evolvedEvidence: JsonObject | undefined;
  let evolvedEvidenceCount = 0;
  let evolvedRunCount = 0;
  let evolvedTraceCalls = new Set<string>();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const observed = await new CraftStore(paths).open();
    try {
      evolved = observed.list("experience_procedure", 100, row => row.title === revisedWorkflow.name && row.lifecycle === "routeable" && row.routeable === true)[0];
      const allEvaluationEvidence = observed.list("evidence", 100, row => typeof (row.metadata as JsonObject | undefined)?.experience_evaluation_dispatch_id === "string");
      evolvedEvidenceCount = allEvaluationEvidence.length;
      evolvedEvidence = allEvaluationEvidence.find(row => {
        const metadata = row.metadata as JsonObject;
        return metadata.procedure_id === firstProcedureId && metadata.stage === "canary" && Number(metadata.baseline_version) === firstProcedureVersion;
      });
      evolvedRunCount = observed.list("workflow_run", 100, row => typeof row.evaluator_dispatch_id === "string").length;
      evolvedTraceCalls = new Set(observed.list("trace_event", 10_000, row => expectedCalls.has(String(row.operation_id))).map(row => String(row.operation_id)));
    } finally { observed.close(); }
    if (evolved && Number(evolved.version) > firstProcedureVersion && evolvedEvidenceCount === 8 && evolvedRunCount === 7
      && evolvedEvidence && evolvedTraceCalls.size === expectedCalls.size && await providerCallCount() === 2) break;
    await delay(100);
  }

  assert(evolved, "a later observation must produce a new routeable revision of the existing Experience Procedure");
  assert.equal(evolved.id, firstProcedureId, "iteration must version the same scenario Procedure instead of creating a parallel artifact");
  assert(Number(evolved.version) > firstProcedureVersion, "the current Procedure version must advance after successful Canary");
  assert.equal(evolvedEvidenceCount, 8, "the second iteration must persist its own four ordered Evidence records");
  assert.equal(evolvedRunCount, 7, "the second iteration must execute three candidate runs plus one current Canary baseline run");
  const canaryMetadata = evolvedEvidence!.metadata as JsonObject;
  assert.equal(canaryMetadata.baseline_version, firstProcedureVersion, "Canary must compare against the prior released revision");
  assert.equal((canaryMetadata.baseline_workflow_run_ids as string[]).length, 1);
  assert.equal((canaryMetadata.workflow_run_ids as string[]).length, 1);
  assert.deepEqual(evolvedTraceCalls, expectedCalls, "both iterations and their Knowledge sync calls must remain observable");
  assert.equal(await providerCallCount(), 2, "the Worker must request a new model proposal for the later iteration");
  const latest = await new CraftStore(paths).open();
  try {
    assert.equal(latest.find("experience_release", firstProcedureId)?.record_version, evolved.version,
      "only a passing second Canary may move the current Experience release pointer");
  } finally { latest.close(); }

  child.stdin.end();
  const exit = await childClosed;
  assert.equal(exit.code, 0, childError);
  assert.equal(childOutput, "", "background Worker output must not leak into the MCP protocol stream");
  const standaloneKnowledgeProject = await mkdtemp(join(tmpdir(), "craft-standalone-knowledge-project-"));
  const standaloneKnowledgeProbe: ContextWorkerProbe = {
    seed: async standaloneRoot => {
      await mkdir(standaloneKnowledgeProject, { recursive: true });
      const sourceRoots = ["source-a", "source-b"].map(name => join(standaloneKnowledgeProject, name));
      for (const sourceRoot of sourceRoots) {
        await mkdir(sourceRoot, { recursive: true });
        await writeFile(join(sourceRoot, "README.md"), "# Standalone verified rule\nRun focused checks before delivery.\n");
      }
      const standalonePaths = craftPaths(standaloneRoot);
      const store = await new CraftStore(standalonePaths).open();
      try {
        const project = projectIdentityFromRoot(standaloneKnowledgeProject).canonical_scope as JsonObject;
        const service = new CraftService(store);
        service.scopeAliasBind({ scope_kind: "project", scope_id: project.id, alias_kind: "path", alias: standaloneKnowledgeProject });
        for (const [index, sourceRoot] of sourceRoots.entries()) service.knowledgeSourceRegister({ source_id: `standalone-knowledge-${index}`,
          kind: "readme", label: `Standalone verified source ${index}`, scope_kind: "project", scope_id: project.id, locator: sourceRoot,
          content_digest: `standalone-fixture:${index}`, trust: "verified", access: "read_only" });
      } finally { store.close(); }
    },
    verifyArtifact: async standaloneRoot => {
      const standalonePaths = craftPaths(standaloneRoot);
      let promoted: JsonObject | undefined;
      let calls = new Set<string>();
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const store = await new CraftStore(standalonePaths).open();
        try {
          promoted = store.list("knowledge_claim", 100, claim => claim.status === "reviewed").find(claim =>
            store.list("knowledge_claim_support", 1_000, support => support.claim_id === claim.id).length >= 2);
          calls = new Set(store.list("trace_event", 10_000, event => ["craft_knowledge_source_list", "craft_knowledge_source_ingest"].includes(String(event.operation_id)))
            .map(event => String(event.operation_id)));
        } finally { store.close(); }
        if (promoted && calls.size === 2) break;
        await delay(100);
      }
      assert(promoted, "Context Knowledge worker must generate and auto-promote a Claim from two independent verified Sources");
      assert.deepEqual(calls, new Set(["craft_knowledge_source_list", "craft_knowledge_source_ingest"]), "Context Knowledge reads and ingests must be traced");
      assert(existsSync(standalonePaths.knowledgeDatabaseFile), "Context Knowledge records must persist under the configured .craft_data root");
      assert(isUnder(join(standaloneKnowledgeProject, ".craft_data", "knowledge", "md"), (promoted!.content_ref as JsonObject | undefined)?.path),
        "Project-scoped Context Knowledge content must remain under the project's .craft_data/knowledge/md directory");
    },
    cleanup: async () => { await rm(standaloneKnowledgeProject, { recursive: true, force: true }); },
  };
  await verifyContextWorker("knowledge", ["craft_evaluation_model_ticket_list", "craft_experience_learning_evaluation_dispatch_list",
    "craft_knowledge_source_list", "craft_knowledge_source_ingest"], [], standaloneKnowledgeProbe);

  const standaloneExperienceProject = await mkdtemp(join(tmpdir(), "craft-standalone-experience-project-"));
  const standaloneExperienceState = join(tmpdir(), `craft-standalone-experience-provider-${process.pid}-${Date.now()}.json`);
  const standaloneExperienceProbe: ContextWorkerProbe = {
    seed: async standaloneRoot => {
      await mkdir(standaloneExperienceProject, { recursive: true });
      await writeFile(join(standaloneExperienceProject, "sentinel.txt"), "standalone candidate marker");
      await writeFile(join(standaloneExperienceProject, "held-out-sentinel.txt"), "standalone held-out marker");
      await writeFile(standaloneExperienceState, JSON.stringify({ calls: 0 }));
      const standalonePaths = craftPaths(standaloneRoot);
      const settings = defaultSettings(standalonePaths);
      settings.models = [{ id: "local-e2e", name: "local-e2e", protocol: "openai-compatible", baseUrl: "http://craft-e2e.invalid/v1",
        model: "local-e2e-model", apiKeyEnv: "CRAFT_LEARNING_E2E_API_KEY", supportsTools: false }];
      await writeFile(standalonePaths.settingsFile, JSON.stringify(settings));
      const store = await new CraftStore(standalonePaths).open();
      try {
        const service = new CraftService(store);
        const context = await service.contextOpen({ project_root: standaloneExperienceProject, query: "verified standalone scenario", include_codebase: false });
        const receiptId = String((context.receipt as JsonObject).id);
        const project = projectIdentityFromRoot(standaloneExperienceProject).canonical_scope as JsonObject;
        for (const [index, taskId] of ["standalone-task-one", "standalone-task-two"].entries()) {
          const result = service.learningCycleFinalize({ host: "mcp_host", session_id: `standalone-session-${index + 1}`, task_id: taskId,
            turn_id: `turn-${taskId}`, context_receipt_id: receiptId,
            verified: true, verification_outcome: "passed", verification_ref: `standalone:${taskId}`, scenario_key: "standalone-auto" });
          assert.equal(result.status, taskId.endsWith("two") ? "candidate_request" : "observed");
        }
        const scenarioDirectory = join(standaloneExperienceProject, ".craft_data", "experience");
        await mkdir(scenarioDirectory, { recursive: true });
        await writeFile(join(scenarioDirectory, "experience-scenarios.json"),
          JSON.stringify(scenarioCatalog(standaloneExperienceProject, "held-out-sentinel.txt", "standalone-auto")));
      } finally { store.close(); }
    },
    environment: { CRAFT_LEARNING_E2E_PROVIDER_STATE: standaloneExperienceState, CRAFT_LEARNING_E2E_WORKFLOWS: JSON.stringify([generatedWorkflow]) },
    verifyArtifact: async standaloneRoot => {
      const standalonePaths = craftPaths(standaloneRoot);
      let procedure: JsonObject | undefined;
      let stages = new Set<string>();
      let runCount = 0;
      let calls = new Set<string>();
      const expected = ["craft_evaluation_model_ticket_list", "craft_experience_learning_request_get", "craft_experience_procedure_submit",
        "craft_experience_learning_evaluation_dispatch", "craft_experience_learning_evaluation_dispatch_list", "craft_experience_learning_evaluation_run"];
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const store = await new CraftStore(standalonePaths).open();
        try {
          procedure = store.list("experience_procedure", 100, item => item.title === generatedWorkflow.name && item.lifecycle === "routeable" && item.routeable === true)[0];
          const evidence = store.list("evidence", 100, item => typeof (item.metadata as JsonObject | undefined)?.experience_evaluation_dispatch_id === "string");
          stages = new Set(evidence.map(item => String((item.metadata as JsonObject).stage)));
          runCount = store.list("workflow_run", 100, item => typeof item.evaluator_dispatch_id === "string").length;
          calls = new Set(store.list("trace_event", 10_000, event => expected.includes(String(event.operation_id))).map(event => String(event.operation_id)));
        } finally { store.close(); }
        if (procedure && stages.size === 4 && runCount === 3 && calls.size === expected.length) break;
        await delay(100);
      }
      assert(procedure, "Context Experience worker must submit and promote a generated Workflow");
      assert.deepEqual(stages, new Set(["shadow", "held_out", "signoff", "canary"]), "Context Experience must pass the four ordered gates");
      assert.equal(runCount, 3, "Context Experience must run Shadow, Held-out and Canary evaluators");
      assert.deepEqual(calls, new Set(expected), "Context Experience ticket, distillation, submission and evaluation calls must be traced");
      assert.equal(Number((JSON.parse(await readFile(standaloneExperienceState, "utf8")) as JsonObject).calls), 1,
        "Context Experience must send one bounded provider request to the local model fixture");
      assert(isUnder(standalonePaths.experienceContentDir, (procedure!.content_ref as JsonObject | undefined)?.path),
        "Context Experience review content must remain under .craft_data/experience");
      assert(isUnder(join(standalonePaths.experienceDir, "graph"), (procedure!.definition_ref as JsonObject | undefined)?.path),
        "Context Experience executable definition must remain under .craft_data/experience/graph");
      const releaseStore = await new CraftStore(standalonePaths).open();
      try { assert.equal(releaseStore.find("experience_release", String(procedure!.id))?.record_version, procedure!.version,
        "only the passing Canary may publish the current Experience release"); }
      finally { releaseStore.close(); }
    },
    cleanup: async () => { await Promise.all([rm(standaloneExperienceProject, { recursive: true, force: true }), rm(standaloneExperienceState, { force: true })]); },
  };
  await verifyContextWorker("experience", ["craft_evaluation_model_ticket_list", "craft_experience_learning_request_get", "craft_experience_procedure_submit",
    "craft_experience_learning_evaluation_dispatch", "craft_experience_learning_evaluation_dispatch_list", "craft_experience_learning_evaluation_run",
    "craft_knowledge_source_list"], [], standaloneExperienceProbe);
  process.stdout.write("Context Hook promoted Memory across tiers; the complete Context worker generated and promoted a reviewed Knowledge Claim and an Experience Workflow; a later Canary evolved the same Procedure against its released baseline.\n");
} finally {
  if (child && child.exitCode === null) {
    child.stdin.end();
    const stopped = await Promise.race([childClosed!.then(() => true), delay(5_000).then(() => false)]);
    if (!stopped) { child.kill("SIGKILL"); await childClosed; }
  }
  if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = previousNodeOptions;
  if (previousLearningApiKey === undefined) delete process.env.CRAFT_LEARNING_E2E_API_KEY;
  else process.env.CRAFT_LEARNING_E2E_API_KEY = previousLearningApiKey;
  await Promise.all([rm(dataRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
}
