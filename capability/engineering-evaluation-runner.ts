/**
 * Controlled local adapter for the opt-in Engineering Quality Profile.
 *
 * This module deliberately accepts fixture-declared Node argv arrays only.  It
 * does not read a caller supplied shell command, create Git worktrees, or grant
 * any network/Forge authority.  The CLI wrapper is the only production caller.
 */
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodexHostKernel, type CodexExecutor } from "../core/codex-driver.ts";
import { digestJson } from "../core/digest.ts";
import type { CraftService } from "../core/service.ts";
import type { CraftStore, JsonObject } from "../core/infrastructure/store.ts";
import { executeHostProcess, type HostExecutor } from "../core/host-driver.ts";
import { VERIFIED_EVALUATION_RECEIPT_KIND, type ProgramCheck } from "./verified-evaluation-receipt.ts";

export type EvaluationCommand = readonly ["node", ...string[]];

export interface EngineeringEvaluationCase {
  id: string;
  task: string;
  workspace: string;
  allowed_paths: readonly string[];
  acceptance: EvaluationCommand;
  siblings: readonly [EvaluationCommand, EvaluationCommand];
}

function command(value: unknown, name: string): EvaluationCommand {
  if (!Array.isArray(value) || value.length < 2 || value.some((part) => typeof part !== "string" || !part.trim())) {
    throw new Error(`${name} must be a non-empty Node argv array`);
  }
  const result = value.map((part) => String(part)) as [string, ...string[]];
  validateEvaluationCommand(result);
  return result as EvaluationCommand;
}

export function validateEvaluationCommand(value: readonly string[]): asserts value is EvaluationCommand {
  if (value[0] !== "node" || value.length < 2) throw new Error("Evaluation commands must be Node argv arrays");
  for (const argument of value.slice(1)) {
    if (!argument || isAbsolute(argument) || argument.split(/[\\/]/u).includes("..") || /[|;&`$<>]/u.test(argument)) {
      throw new Error("Evaluation command arguments must be safe relative paths or literals");
    }
  }
}

function caseObject(value: unknown, index: number): EngineeringEvaluationCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`cases[${index}] must be an object`);
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const task = typeof item.task === "string" ? item.task : "";
  const workspace = typeof item.workspace === "string" ? item.workspace : "";
  if (!/^bug-fix-shared-caller-[a-z0-9-]+$/u.test(id) || !task.trim()) throw new Error(`cases[${index}] has an invalid id or task`);
  if (!workspace || isAbsolute(workspace) || workspace.split(/[\\/]/u).includes("..")) throw new Error(`cases[${index}].workspace must be a safe relative path`);
  if (!Array.isArray(item.allowed_paths) || !item.allowed_paths.length || item.allowed_paths.some((path) => typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/u).includes(".."))) {
    throw new Error(`cases[${index}].allowed_paths must contain safe relative paths`);
  }
  if (!Array.isArray(item.siblings) || item.siblings.length !== 2) throw new Error(`cases[${index}].siblings must contain exactly two commands`);
  return { id, task, workspace, allowed_paths: [...new Set(item.allowed_paths as string[])].sort(), acceptance: command(item.acceptance, `cases[${index}].acceptance`), siblings: [command(item.siblings[0], `cases[${index}].siblings[0]`), command(item.siblings[1], `cases[${index}].siblings[1]`)] };
}

/** Load the versioned, sanitized case declaration without interpreting any code. */
export async function loadEngineeringEvaluationCases(root: string): Promise<readonly EngineeringEvaluationCase[]> {
  const casesPath = resolve(root, "cases.json");
  if ((await lstat(casesPath)).isSymbolicLink()) throw new Error("Evaluation cases file must not be a symbolic link");
  await realpath(root);
  const resolved = await realpath(casesPath);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(resolved, "utf8")); } catch { throw new Error("Engineering evaluation cases.json must contain JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Engineering evaluation cases.json must be an object");
  const payload = parsed as Record<string, unknown>;
  if (payload.version !== 1 || !Array.isArray(payload.cases) || payload.cases.length < 1 || payload.cases.length > 20) throw new Error("Engineering evaluation cases must be version 1 with 1 to 20 Cases");
  const cases = payload.cases.map(caseObject);
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("Engineering evaluation Case ids must be unique");
  return cases;
}

export interface EngineeringEvaluationRunOptions {
  fixture_root: string;
  archive_root: string;
  model: string;
  timeout_ms: number;
  output_limit: number;
  trials_per_pair: number;
  codex_version: string;
  environment_fingerprint: string;
  executor?: CodexExecutor;
  program_executor?: HostExecutor;
}

export interface EngineeringEvaluationRunResult { plan: JsonObject; evaluation: JsonObject; archive: string; }

function digestBytes(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
async function treeEntries(root: string, relativePath = ""): Promise<Array<{ path: string; digest: string }>> {
  // `relativePath` and `entry.name` are produced by `readdir`, never accepted
  // from a caller. User supplied fixture/workspace paths are validated in
  // `caseObject` before this traversal starts.
  const directory = relativePath ? resolve(root, relativePath) : root;
  const entries = await readdir(directory, { withFileTypes: true }); const result: Array<{ path: string; digest: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relativePath ? `${relativePath}/${entry.name}` : entry.name; const location = resolve(directory, entry.name); const status = await lstat(location);
    if (status.isSymbolicLink()) throw new Error("Engineering evaluation fixture/workspace must not contain symbolic links");
    if (status.isFile()) result.push({ path: child, digest: digestBytes(await readFile(location, "utf8")) });
    else result.push(...await treeEntries(root, child));
  }
  return result;
}

export async function workspaceSnapshotDigest(root: string): Promise<string> { return digestJson(await treeEntries(root)); }

type ProgramStatus = "passed" | "failed" | "unobserved";
type ProgramResult = { status: ProgramStatus; digest: string };
function checkedStatus(result: ProgramResult): "passed" | "failed" { return result.status === "passed" ? "passed" : "failed"; }

async function declaredProgram(command: EvaluationCommand, cwd: string, timeoutMs: number, outputLimit: number, executor: HostExecutor): Promise<ProgramResult> {
  validateEvaluationCommand(command);
  let result;
  try { result = await executor({ executable: command[0], argv: [...command.slice(1)], cwd, stdin: "", timeoutMs, outputLimit }); }
  catch (error) { return { status: "unobserved", digest: digestJson({ command, error: error instanceof Error ? error.name : "ProgramExecutionError" }) }; }
  const status = result.exitCode === 0 && !result.timedOut && result.cancelled !== true && !result.outputLimited ? "passed" : "failed";
  return { status, digest: digestJson({ command, exit_code: result.exitCode, signal: result.signal, timed_out: result.timedOut, cancelled: result.cancelled === true, output_limited: result.outputLimited, stdout: digestBytes(result.stdout), stderr: digestBytes(result.stderr) }) };
}

/**
 * A single explicit runner.  Its workspace is always a disposable copy of a
 * fixture and it writes only Craft's local receipt store plus an archive chosen
 * by the operator.  It never shells out to a fixture command.
 */
export class EngineeringEvaluationRunner {
  readonly store: CraftStore;
  readonly service: CraftService;
  readonly options: EngineeringEvaluationRunOptions;
  constructor(store: CraftStore, service: CraftService, options: EngineeringEvaluationRunOptions) { this.store = store; this.service = service; this.options = options; }

  async run(): Promise<EngineeringEvaluationRunResult> {
    if (!this.options.model.trim() || this.options.trials_per_pair !== 5 || this.options.timeout_ms < 1 || this.options.output_limit < 1024) throw new Error("Engineering evaluation requires explicit model, exactly five trials, and positive limits");
    const cases = await loadEngineeringEvaluationCases(this.options.fixture_root);
    if (cases.length !== 12) throw new Error("Engineering evaluation requires exactly 12 versioned Cases");
    const task = this.service.taskOpen({ title: "Engineering Profile evaluation", goal: "Run explicit, disposable Codex paired trials" }).task as JsonObject;
    const kit = this.service.engineeringQualityProfileInstall().kit as JsonObject; this.service.capabilityKitConformance({ kit_id: kit.id });
    const activation = this.service.engineeringQualityProfileActivate({ task_id: task.id }).activation as JsonObject;
    for (const item of cases) this.service.engineeringQualityProfileCaseSave({ case_id: item.id, case_kind: "bug-fix-shared-caller", frozen_input_digest: digestJson(item.task), allowed_workspace_ref: `fixture:${item.id}`, acceptance_command_digest: digestJson(item.acceptance), sibling_caller_assertion_digest: digestJson(item.siblings), sanitized: true });
    const plan = this.service.engineeringQualityProfileEvaluationPlan({ activation_id: activation.id, host_id: "codex-cli", case_ids: cases.map((item) => item.id), model_fingerprint: digestJson({ model: this.options.model, codex: this.options.codex_version }), environment_fingerprint: this.options.environment_fingerprint, budget_fingerprint: digestJson({ timeout_ms: this.options.timeout_ms, output_limit: this.options.output_limit }), trials_per_pair: 5, observer_kind: "program-verifier" }).plan as JsonObject;
    const order = (trial: number): readonly ("baseline" | "profile")[] => trial % 2 ? ["baseline", "profile"] : ["profile", "baseline"];
    for (const item of cases) for (let trial = 1; trial <= 5; trial += 1) for (const arm of order(trial)) await this.runArm(plan, task, activation, item, trial, arm);
    const evaluation = this.service.engineeringQualityProfileEvaluationEvaluate({ plan_id: plan.id }).evaluation as JsonObject;
    await mkdir(this.options.archive_root, { recursive: true }); const archive = join(this.options.archive_root, `engineering-evaluation-${String(plan.id)}.json`);
    const snapshot = this.service.engineeringQualityProfileEvaluationGet({ plan_id: plan.id }); await writeFile(archive, `${JSON.stringify({ plan: snapshot.plan, evaluation: snapshot.evaluation, rejection: snapshot.rejection, records: (snapshot.records as JsonObject[]).map(({ receipt_digest, ...record }) => ({ ...record, receipt_digest })) }, null, 2)}\n`, { mode: 0o600 });
    return { plan, evaluation, archive };
  }

  private async runArm(plan: JsonObject, task: JsonObject, activation: JsonObject, item: EngineeringEvaluationCase, trial: number, arm: "baseline" | "profile"): Promise<void> {
    const fixtureWorkspace = resolve(this.options.fixture_root, item.workspace); await treeEntries(fixtureWorkspace);
    const workspace = await this.disposableWorkspace(fixtureWorkspace); const before = await workspaceSnapshotDigest(workspace); const started = Date.now();
    // A root-cause claim must at least be grounded in a frozen, independently
    // reproduced defect.  "The Host changed a file" is neither a root cause nor
    // a factual check, so it cannot promote an Engineering Profile.
    const reproduction = await declaredProgram(item.acceptance, workspace, this.options.timeout_ms, this.options.output_limit, this.options.program_executor ?? executeHostProcess);
    const afterReproduction = await workspaceSnapshotDigest(workspace);
    const driver = new CodexHostKernel(this.store, this.options.executor); const dispatchId = `engineering_eval_${randomUUID().replaceAll("-", "")}`;
    const profile = arm === "profile" ? this.service.engineeringQualityProfileTrialContext({ activation_id: activation.id }).profile as JsonObject : null;
    const prompt = this.prompt(item, arm, profile); const dispatch = driver.prepare({ dispatch_id: dispatchId, task_id: task.id, workspace, prompt, model: this.options.model, sandbox: "workspace-write", evaluation_mode: true, timeout_ms: this.options.timeout_ms, output_limit: this.options.output_limit }).dispatch as JsonObject;
    const policy = this.service.autonomyPolicySave({ policy_id: `engineering_eval_policy_${dispatch.id}`, task_id: task.id, name: "Explicit disposable evaluation workspace", rules: { sandbox_write: { level: "human_approval" } } }).policy as JsonObject;
    const authorization = this.service.autonomyRequest({ request_id: `engineering_eval_authorization_${dispatch.id}`, policy_id: policy.id, policy_version: policy.version, task_id: task.id, action: "sandbox_write", target: workspace, request_digest: dispatch.request_digest, requested_by: "engineering-eval-cli" }).request as JsonObject;
    this.service.autonomyDecide({ request_id: authorization.id, decision: "approve", actor: "engineering-eval-cli", approval_ref: `explicit-cli:${plan.id}` });
    const result = await driver.execute({ dispatch_id: dispatch.id, prompt, authorization_request_id: authorization.id }); const hostReceipt = result.receipt as JsonObject;
    const after = await workspaceSnapshotDigest(workspace); const executor = this.options.program_executor ?? executeHostProcess;
    const acceptance = await declaredProgram(item.acceptance, workspace, this.options.timeout_ms, this.options.output_limit, executor);
    const siblingA = await declaredProgram(item.siblings[0], workspace, this.options.timeout_ms, this.options.output_limit, executor);
    const siblingB = await declaredProgram(item.siblings[1], workspace, this.options.timeout_ms, this.options.output_limit, executor);
    const changed = await this.changedOnlyAllowed(fixtureWorkspace, workspace, item.allowed_paths); const hostStatus = hostReceipt.status === "completed" && hostReceipt.output_limited !== true && hostReceipt.invalid_jsonl_lines === 0 && hostReceipt.model === this.options.model ? "passed" : "failed";
    const sourceUnchanged = before === await workspaceSnapshotDigest(fixtureWorkspace);
    const rootCauseStatus = reproduction.status === "failed" && before === afterReproduction ? "passed" : "failed";
    const programFactsStatus = acceptance.status === "passed" && siblingA.status === "passed" && siblingB.status === "passed" ? "passed" : "failed";
    const hostCheck = this.check(`host-${dispatch.id}`, hostStatus, digestJson(["codex", "terminal"]), digestJson(hostReceipt)); const acceptanceCheck = this.check(`acceptance-${dispatch.id}`, checkedStatus(acceptance), digestJson(item.acceptance), acceptance.digest); const siblingChecks = [this.check(`sibling-a-${dispatch.id}`, checkedStatus(siblingA), digestJson(item.siblings[0]), siblingA.digest), this.check(`sibling-b-${dispatch.id}`, checkedStatus(siblingB), digestJson(item.siblings[1]), siblingB.digest)] as const;
    const effect = this.check(`effect-${dispatch.id}`, changed ? "passed" : "failed", digestJson(item.allowed_paths), digestJson({ before, after })); const safety = this.check(`safety-${dispatch.id}`, sourceUnchanged ? "passed" : "failed", digestJson(["fixture", "immutable"]), digestJson({ fixture: await workspaceSnapshotDigest(fixtureWorkspace) })); const factual = this.check(`factual-${dispatch.id}`, programFactsStatus, digestJson([item.acceptance, ...item.siblings]), digestJson({ acceptance: acceptance.digest, sibling_a: siblingA.digest, sibling_b: siblingB.digest })); const root = this.check(`root-${dispatch.id}`, rootCauseStatus, digestJson(["frozen-defect-reproduction", item.acceptance]), reproduction.digest);
    const traceId = `engineering_eval_trace_${dispatch.id}`; const sessionId = `engineering_eval_session_${dispatch.id}`; this.store.create("host_session", sessionId, { host_id: "codex-cli", environment_fingerprint: plan.environment_fingerprint, model_fingerprint: plan.model_fingerprint, budget_fingerprint: plan.budget_fingerprint, trace_id: traceId, status: "terminal", host_receipt_id: hostReceipt.id });
    const allPassed = [hostCheck, acceptanceCheck, ...siblingChecks, effect, safety, factual, root].every((check) => check.status === "passed"); const observationId = `engineering_eval_observation_${dispatch.id}`; this.store.create("outcome_observation", observationId, { trace_id: traceId, host_id: "codex-cli", observer_id: "engineering-eval-program-verifier", observer_kind: "program-verifier", verdict: allPassed ? "passed" : "failed" });
    this.service.engineeringQualityProfileVerifiedReceiptImport({ plan_id: plan.id, case_id: item.id, trial_index: trial, arm, host_session_id: sessionId, observation_id: observationId, verified_receipt: { kind: VERIFIED_EVALUATION_RECEIPT_KIND, issued_by: "engineering-eval-cli", host_terminal: hostCheck, frozen_input_digest: digestJson(item.task), workspace_before_digest: before, workspace_after_digest: after, acceptance: acceptanceCheck, siblings: siblingChecks, effect_check: effect, safety_check: safety, factual_check: factual, root_cause_evidence_ids: [root.evidence_id], retry_count: 0, cost_units: this.cost(hostReceipt), latency_ms: Date.now() - started } });
    await rm(dirname(workspace), { recursive: true, force: true });
  }

  private async disposableWorkspace(source: string): Promise<string> { const parent = await mkdtemp(join(tmpdir(), "craft-engineering-eval-")); const workspace = join(parent, "workspace"); await cp(source, workspace, { recursive: true, force: false, errorOnExist: true }); return workspace; }
  private async changedOnlyAllowed(source: string, workspace: string, allowed: readonly string[]): Promise<boolean> { const before = new Map((await treeEntries(source)).map((item) => [item.path, item.digest])); const after = new Map((await treeEntries(workspace)).map((item) => [item.path, item.digest])); const changed = new Set([...before.keys(), ...after.keys()].filter((path) => before.get(path) !== after.get(path))); return changed.size > 0 && [...changed].every((path) => allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))); }
  private check(id: string, status: "passed" | "failed", commandDigest: string, resultDigest: string): ProgramCheck { const evidence = this.service.evidenceRecord({ evidence_id: `engineering_eval_evidence_${id}`, source_type: "program", confidence: "confirmed", claim: `Engineering evaluation ${id} ${status}.`, metadata: { command_digest: commandDigest, result_digest: resultDigest, status } }); return { evidence_id: String(evidence.id), command_digest: commandDigest, result_digest: resultDigest, status }; }
  private cost(receipt: JsonObject): number { const usage = receipt.usage; if (!usage || typeof usage !== "object" || Array.isArray(usage)) return 0; const values = Object.values(usage as JsonObject).filter((value) => typeof value === "number") as number[]; return values.reduce((total, value) => total + value, 0); }
  private prompt(item: EngineeringEvaluationCase, arm: "baseline" | "profile", profile: JsonObject | null): string { return [`Task: ${item.task}`, `Allowed paths: ${item.allowed_paths.join(", ")}`, "Do not access the network. Do not modify files outside the allowed paths. Run the declared local checks before finishing.", arm === "profile" ? `Apply this explicit engineering profile only for this task: ${JSON.stringify(profile)}` : "Use the repository task only; no profile instructions are active."].join("\n"); }
}
