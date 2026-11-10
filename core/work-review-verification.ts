import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { digestJson, payload } from "./digest.ts";
import { object, text } from "./validation.ts";
import { DockerSandboxAdapter, dockerContainerName, dockerRequestDigest } from "./docker-sandbox.ts";
import { assertCurrentWorkReviewCandidate, getWorkReview } from "./work-review.ts";

export const FROZEN_VERIFICATION_CRITERION = "frozen_verification";
const CONTROLLER = randomUUID();
const EXECUTIONS = new Map<string, Set<string>>();
function executionSet(store: CraftStore): Set<string> {
  const key = realpathSync(store.paths.root);
  let set = EXECUTIONS.get(key); if (!set) { set = new Set(); EXECUTIONS.set(key, set); }
  return set;
}
function scratchDirectory(store: CraftStore, name: unknown): string {
  const value = text(name, "scratch_name");
  if (!/^review-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new Error("Invalid frozen verification scratch identity");
  return resolve(store.paths.runtimeDir, value);
}
const ACTIVE = new Set(["prepared", "staging", "running", "stopping", "unknown"]);
export function reviewVerificationConfiguration(value: unknown): JsonObject | null {
  if (value === undefined || value === null) return null;
  const input = object(value, "review_verification");
  if (Object.keys(input).some(key => !["profile_id", "profile_version", "image", "argv", "allow_simulated"].includes(key))) throw new Error("Unsupported frozen verification configuration field");
  const image = text(input.image, "image"), profileId = text(input.profile_id, "profile_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Verification image must be pinned by sha256 digest");
  if (typeof input.profile_version !== "number" || !Number.isSafeInteger(input.profile_version) || input.profile_version < 1) throw new Error("profile_version must be a positive integer");
  if (!Array.isArray(input.argv) || !input.argv.length || input.argv.length > 32) throw new Error("Verification argv must contain 1 to 32 strings");
  const argv = input.argv.map(value => text(value, "argv"));
  if (argv.some(value => value.length > 4096 || value.includes("\0")) || argv.join("").length > 16384) throw new Error("Verification argv exceeds its size limit");
  if (input.allow_simulated !== undefined && typeof input.allow_simulated !== "boolean") throw new Error("allow_simulated must be a boolean");
  return { profile_id: profileId, profile_version: input.profile_version, image, argv, allow_simulated: input.allow_simulated === true };
}
export function taskReviewVerification(store: CraftStore, taskId: string): JsonObject | null {
  const configurations = store.list("task_control_contract", Number.MAX_SAFE_INTEGER, item => item.task_id === taskId && item.review_verification != null).map(item => reviewVerificationConfiguration(item.review_verification)!);
  if (!configurations.length) return null;
  if (configurations.some(config => digestJson(config) !== digestJson(configurations[0]))) throw new Error("Task has conflicting frozen verification contracts");
  return configurations[0]!;
}
export function verificationCriteria(value: unknown, config: JsonObject | null): unknown {
  if (!config) return value;
  if (value !== undefined && !Array.isArray(value)) throw new Error("Verification acceptance criteria must be an array");
  const criteria = (value ?? []) as JsonObject[];
  const matches = criteria.filter(item => item?.id === FROZEN_VERIFICATION_CRITERION);
  if (matches.length > 1 || matches.some(item => item.method !== "program" || item.required === false)) throw new Error("Frozen verification criterion cannot be downgraded");
  return matches.length ? criteria : [...criteria, { id: FROZEN_VERIFICATION_CRITERION, name: "冻结副本沙箱复验", method: "program", required: true }];
}
export function assertReviewVerificationsStopped(store: CraftStore, taskId: string): void {
  if (store.list("work_review_verification", 1, item => item.task_id === taskId && ACTIVE.has(String(item.status))).length) throw new Error("Stop or reconcile the active frozen verification before continuing");
}
export function verifiedReviewProfile(store: CraftStore, config: JsonObject): JsonObject {
  const profile = store.get("sandbox_profile", String(config.profile_id));
  if (profile.version !== config.profile_version || profile.lifecycle !== "verified" || profile.backend !== "container" || profile.adapter_id !== "docker") throw new Error("Frozen verification requires its current verified Docker profile");
  const assessment = store.get("sandbox_assessment", String(profile.assessment_id));
  const evidence = (profile.evidence_ids as string[]).map(id => store.get("evidence", id));
  const proof = evidence.some(item => {
    if (item.source_type !== "program" || item.record_origin === "caller_asserted" || !item.artifact_id || (item.metadata as JsonObject | undefined)?.revoked === true || (item.metadata as JsonObject | undefined)?.retracted === true || !["bounded", "confirmed"].includes(String(item.confidence))) return false;
    const artifact = store.get("artifact", String(item.artifact_id)), metadata = artifact.metadata as JsonObject;
    return artifact.kind === "docker_sandbox_conformance" && artifact.producer_type === "sandbox_adapter" && artifact.producer_id === "docker" && (metadata.evidence_basis === "docker_runtime" || (config.allow_simulated === true && metadata.evidence_basis === "simulated_container")) && metadata.image === config.image && metadata.profile_id === profile.id && metadata.profile_version === Number(profile.version) - 1 && Array.isArray(metadata.checks) && ["baseline", "root_read_only", "workspace_write", "network_denied", "secret_absent", "timeout_cancel", "no_residual_container"].every(check => (metadata.checks as JsonObject[]).some(item => item.check === check && item.passed === true));
  });
  if (assessment.verifier !== "docker-conformance-v1" || assessment.status !== "passed" || !proof) throw new Error("Frozen verification requires Docker conformance for its pinned image");
  return profile;
}
function independent(store: CraftStore, candidate: JsonObject, actor: string): void {
  const owner = store.find("task_assignment", `task_assignment_${candidate.task_id}`);
  if (actor === candidate.actor || (owner?.status === "active" && owner.owner === actor)) throw new Error("Frozen verification requires an independent reviewer");
}
export function prepareReviewVerification(store: CraftStore, args: JsonObject): JsonObject {
  const actor = text(args.actor, "actor");
  return store.transaction(() => {
    const candidate = store.get("work_review_candidate", text(args.candidate_id, "candidate_id"));
    if (candidate.version !== args.candidate_version) throw new Error("Review candidate version changed");
    independent(store, candidate, actor);
    const id = `review_verification_${digestJson(candidate.id).slice(7)}`, existing = store.find("work_review_verification", id);
    if (existing) { if (existing.actor !== actor) throw new Error("Verification is already assigned to another reviewer"); return { verification: existing, idempotent: true }; }
    assertCurrentWorkReviewCandidate(store, candidate);
    const launch = store.get("work_launch", String(candidate.launch_id));
    const configuration = reviewVerificationConfiguration(launch.review_verification);
    if (!configuration) throw new Error("Frozen verification was not declared in the execution contract");
    verifiedReviewProfile(store, configuration);
    const verification = store.create("work_review_verification", id, { candidate_id: candidate.id, candidate_version: candidate.version, task_id: candidate.task_id, plan_id: candidate.plan_id, plan_version: candidate.plan_version, manifest_digest: candidate.manifest_digest, configuration, actor, scratch_name: `review-${randomUUID()}`, status: "prepared" });
    store.appendEvent(`task:${candidate.task_id}`, "work.verification_prepared", { verification_id: id, candidate_id: candidate.id, actor });
    return { verification, idempotent: false };
  });
}
async function cleanup(adapter: DockerSandboxAdapter, name: string): Promise<JsonObject> {
  const removed = await adapter.runner(["rm", "-f", dockerContainerName(name)], 10000, 4096);
  const residual = await adapter.runner(["ps", "-a", "--filter", `name=^/${dockerContainerName(name)}$`, "--format", "{{.Names}}"], 10000, 4096);
  return { remove_code: removed.code, passed: residual.code === 0 && !residual.timed_out && !residual.output_limited && !residual.stdout.trim(), residual_check_code: residual.code };
}
export async function stopReviewVerification(store: CraftStore, adapter: DockerSandboxAdapter, args: JsonObject): Promise<JsonObject> {
  const actor = text(args.actor, "actor"), id = text(args.verification_id, "verification_id");
  const current = store.get("work_review_verification", id);
  if (current.version !== args.verification_version) throw new Error("Verification version changed");
  if (!ACTIVE.has(String(current.status))) return { verification: current, idempotent: true };
  const workspace = scratchDirectory(store, current.scratch_name);
  const stopping = store.updateIfVersion("work_review_verification", id, Number(current.version), { ...payload(current), status: "stopping", stopped_by: actor });
  let proof: JsonObject;
  try { proof = await cleanup(adapter, String(current.scratch_name)); } catch { proof = { passed: false }; }
  const observed = store.get("work_review_verification", id);
  if (observed.version !== stopping.version) return { verification: observed, idempotent: true };
  const unsettled = executionSet(store).has(id);
  const confirmationRequired = current.status === "unknown" || (current.execution_owner !== undefined && current.execution_owner !== CONTROLLER);
  const confirmed = !confirmationRequired || args.confirmed_execution_stopped === true;
  proof = { ...proof, controller_settled: !unsettled && confirmed, confirmation_basis: confirmationRequired && confirmed ? "operator_declaration" : "runtime_observation" };
  const status = proof.passed === true && !unsettled && confirmed ? "cancelled" : unsettled ? "stopping" : "unknown";
  const saved = store.updateIfVersion("work_review_verification", id, Number(stopping.version), { ...payload(stopping), status, cleanup: proof });
  store.appendEvent(`task:${current.task_id}`, "work.verification_stopped", { verification_id: id, actor, cleanup_confirmed: status === "cancelled", confirmation_basis: proof.confirmation_basis });
  if (status === "cancelled") await rm(workspace, { recursive: true, force: true });
  return { verification: saved, idempotent: false };
}
export function assertReviewVerificationCheck(store: CraftStore, args: JsonObject, launch: JsonObject): void {
  if (!launch.review_verification || args.criterion_id !== FROZEN_VERIFICATION_CRITERION) return;
  const verification = args.verification_id ? store.find("work_review_verification", String(args.verification_id)) : null;
  if (!verification || verification.status !== "completed" || verification.plan_id !== args.plan_id || verification.plan_version !== args.plan_version || verification.result !== args.result || args.evaluator_id !== `frozen:${verification.id}` || digestJson(args.evidence_ids) !== digestJson(verification.evidence_ids)) throw new Error("This criterion requires a current frozen sandbox verification receipt");
  assertCurrentWorkReviewCandidate(store, store.get("work_review_candidate", String(verification.candidate_id)));
  verifiedReviewProfile(store, verification.configuration as JsonObject);
  for (const id of verification.evidence_ids as string[]) {
    const evidence = store.get("evidence", id), metadata = evidence.metadata as JsonObject;
    if (metadata.revoked === true || metadata.retracted === true) throw new Error("Frozen verification evidence was revoked");
  }
}
export async function executeReviewVerification(store: CraftStore, adapter: DockerSandboxAdapter, args: JsonObject, record: (job: JsonObject, result: string, receipt: JsonObject) => JsonObject): Promise<JsonObject> {
  const id = text(args.verification_id, "verification_id"), active = executionSet(store);
  if (active.has(id)) return { verification: store.get("work_review_verification", id), idempotent: true };
  active.add(id);
  try { return await executeReviewVerificationOwned(store, adapter, args, record); } finally { active.delete(id); }
}
async function executeReviewVerificationOwned(store: CraftStore, adapter: DockerSandboxAdapter, args: JsonObject, record: (job: JsonObject, result: string, receipt: JsonObject) => JsonObject): Promise<JsonObject> {
  const id = text(args.verification_id, "verification_id"), actor = text(args.actor, "actor");
  let job = store.get("work_review_verification", id);
  if (job.actor !== actor) throw new Error("Verification belongs to another reviewer");
  if (job.status !== "prepared") return { verification: job, idempotent: true };
  if (job.version !== args.verification_version || args.confirmed_command !== true) throw new Error("Verification requires its exact version and explicit command confirmation");
  const candidate = store.get("work_review_candidate", String(job.candidate_id)); independent(store, candidate, actor); assertCurrentWorkReviewCandidate(store, candidate);
  const config = job.configuration as JsonObject, profile = verifiedReviewProfile(store, config);
  if (adapter.evidenceMode === "simulation" && config.allow_simulated !== true) throw new Error("This contract does not permit simulated verification");
  const workspace = scratchDirectory(store, job.scratch_name);
  job = store.updateIfVersion("work_review_verification", id, Number(job.version), { ...payload(job), status: "staging", execution_owner: CONTROLLER, basis: adapter.evidenceMode === "simulation" ? "simulated_container" : "docker_runtime" });
  let result: JsonObject = {}, failure: unknown, failed = false, dispatched = false;
  try {
    await mkdir(workspace, { recursive: false, mode: 0o700 });
    const seen = new Set<string>();
    for (const file of candidate.files as JsonObject[]) {
      const path = String(file.path), target = resolve(workspace, path), rel = relative(workspace, target);
      if (!rel || isAbsolute(path) || isAbsolute(rel) || rel.split(/[\\/]+/).includes("..") || seen.has(target)) throw new Error("Frozen verification path escapes or aliases its copy");
      seen.add(target); const stored = getWorkReview(store, { candidate_id: candidate.id, relative_path: path }).file as JsonObject;
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.from(String(stored.content_base64), "base64"), { flag: "wx", mode: 0o600 });
    }
    const staged = store.get("work_review_verification", id);
    if (staged.status !== "staging") throw new Error("Verification stopped during copy staging");
    job = store.updateIfVersion("work_review_verification", id, Number(staged.version), { ...payload(staged), status: "running" });
    result = await adapter.execute({ ticket_id: job.scratch_name, runtime_root: store.paths.runtimeDir, image: config.image, command: config.argv, request_digest: dockerRequestDigest(String(config.image), config.argv as string[]), capabilities: profile.capabilities }, () => {
      if (store.get("work_review_verification", id).status !== "running") throw new Error("Verification stopped before container start");
      dispatched = true;
    });
  } catch (error) { failure = error; failed = true; }
  let proof: JsonObject;
  try { proof = await cleanup(adapter, String(job.scratch_name)); } catch { proof = { passed: false }; }
  const observed = store.get("work_review_verification", id);
  const ambiguous = dispatched && (failed || result.status === "timed_out" || result.output_limited === true);
  if (!["staging", "running", "stopping", "unknown"].includes(String(observed.status))) return { verification: observed, idempotent: true };
  if (observed.status === "stopping" || observed.stopped_by !== undefined) {
    const stopped = store.updateIfVersion("work_review_verification", id, Number(observed.version), { ...payload(observed), status: proof.passed === true && !ambiguous ? "cancelled" : "unknown", cleanup: { ...proof, controller_settled: true, confirmation_basis: "runtime_observation" } });
    store.appendEvent(`task:${job.task_id}`, "work.verification_stopped", { verification_id: id, cleanup_confirmed: stopped.status === "cancelled", confirmation_basis: "runtime_observation" });
    if (stopped.status === "cancelled") await rm(workspace, { recursive: true, force: true });
    return { verification: stopped, idempotent: false };
  }
  if (proof.passed !== true || ambiguous) {
    const unknown = store.updateIfVersion("work_review_verification", id, Number(observed.version), { ...payload(observed), status: "unknown", cleanup: proof });
    store.appendEvent(`task:${job.task_id}`, "work.verification_unknown", { verification_id: id, cleanup_confirmed: false });
    return { verification: unknown, idempotent: false };
  }
  let verdict = failed ? "blocked" : result.status === "passed" ? "passed" : "failed";
  let stale = false;
  try { assertCurrentWorkReviewCandidate(store, candidate); verifiedReviewProfile(store, config); } catch { verdict = "blocked"; stale = true; }
  const receipt = { stale_candidate: stale, basis: job.basis, manifest_digest: candidate.manifest_digest, image: config.image, command_digest: dockerRequestDigest(String(config.image), config.argv as string[]), exit_code: result.exit_code ?? null, timed_out: result.status === "timed_out", output_limited: result.output_limited ?? false, error_class: failure instanceof Error ? failure.name : failed ? "NonErrorThrow" : null, cleanup: proof };
  const saved = store.transaction(() => {
    const current = store.get("work_review_verification", id);
    const completed = store.updateIfVersion("work_review_verification", id, Number(current.version), { ...payload(current), status: "completed", result: verdict, receipt });
    // A stale candidate retains its failure evidence but cannot update current acceptance.
    return record(completed, verdict, receipt);
  });
  await rm(workspace, { recursive: true, force: true });
  return { ...saved, idempotent: false };
}

export function reviewVerificationProjection(store: CraftStore, job: JsonObject): JsonObject {
  let current: boolean | null = null;
  if (job.status === "completed") {
    try {
      const candidate = store.get("work_review_candidate", String(job.candidate_id)), launch = store.get("work_launch", String(candidate.launch_id));
      assertReviewVerificationCheck(store, { verification_id: job.id, plan_id: job.plan_id, plan_version: job.plan_version, criterion_id: FROZEN_VERIFICATION_CRITERION, evaluator_id: `frozen:${job.id}`, result: job.result, evidence_ids: job.evidence_ids }, launch);
      current = true;
    } catch { current = false; }
  }
  return { ...job, current };
}
