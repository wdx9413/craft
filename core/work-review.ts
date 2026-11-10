import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { digestJson } from "./digest.ts";
import { object, text } from "./validation.ts";
import { assertTaskAssignmentOwner } from "./task-assignment.ts";

const MAX_BYTES = 10 * 1024 * 1024;
function safeId(value: unknown): string { const id = text(value, "candidate_id"); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("candidate_id must be a safe identifier"); return id; }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function policyId(planId: unknown, criterionId: unknown): string { return `work_review_policy_${digestJson([planId, criterionId]).slice(7)}`; }
function readArtifact(workspace: string, path: string, limit: number): Buffer {
  const root = resolve(workspace), target = resolve(root, path), rel = relative(root, target);
  if (isAbsolute(path) || !rel || rel.split(/[\\/]+/).includes("..") || isAbsolute(rel)) throw new Error("Review artifact path escapes its workspace");
  let current = root;
  for (const part of ["", ...rel.split(sep)]) {
    current = part ? resolve(current, part) : current;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Review artifact paths cannot contain symbolic links");
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Review artifacts must be regular files within the 10 MiB total limit");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0, count: number;
    while ((count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) { size += count; if (size > limit) throw new Error("Review artifacts grew beyond the size limit"); }
    return buffer.subarray(0, size);
  } finally { closeSync(fd); }
}
export function assertCurrentWorkReviewCandidate(store: CraftStore, candidate: JsonObject): void {
  for (const [kind, idKey, versionKey] of [["task", "task_id", "task_version"], ["task_run", "task_run_id", "task_run_version"], ["task_control_contract", "contract_id", "contract_version"], ["work_launch", "launch_id", "launch_version"], ["host_run", "host_run_id", "host_run_version"], ["acceptance_plan", "plan_id", "plan_version"]]) {
    if (store.get(kind, String(candidate[idKey])).version !== candidate[versionKey]) throw new Error("Frozen candidate is stale; freeze the current version again");
  }
  for (const file of candidate.files as JsonObject[]) {
    getWorkReview(store, { candidate_id: candidate.id, relative_path: file.path });
    if (hash(readArtifact(String(candidate.workspace), String(file.path), MAX_BYTES)) !== file.sha256) throw new Error("Working artifact changed after freezing; create a new candidate");
  }
}
export function freezeWorkReview(store: CraftStore, args: JsonObject, recheck: (plan: JsonObject) => JsonObject): JsonObject {
  const candidateId = safeId(args.candidate_id), actor = text(args.actor, "actor");
  if (!Array.isArray(args.relative_paths) || !args.relative_paths.length || args.relative_paths.length > 100) throw new Error("relative_paths must contain 1 to 100 artifact paths");
  const paths = args.relative_paths.map(value => text(value, "relative_path")).sort();
  if (new Set(paths).size !== paths.length) throw new Error("Review paths must be unique");
  const request = { task_run_id: text(args.task_run_id, "task_run_id"), task_run_version: args.task_run_version, launch_version: args.launch_version, host_run_version: args.host_run_version, plan_version: args.plan_version, criterion_id: text(args.criterion_id, "criterion_id"), actor, relative_paths: paths };
  const requestDigest = digestJson(request);
  return store.transaction(() => {
    const existing = store.find("work_review_candidate", candidateId);
    if (existing) { if (existing.request_digest !== requestDigest) throw new Error("Review candidate idempotency conflict"); return { candidate: existing, idempotent: true }; }
    const run = store.get("task_run", request.task_run_id), launch = store.get("work_launch", String(run.launch_id));
    const task = store.get("task", String(launch.task_id));
    assertTaskAssignmentOwner(store, String(task.id), actor);
    const contract = store.get("task_control_contract", String(run.contract_id));
    if (contract.status !== "active" || contract.version !== run.contract_version) throw new Error("Task Control contract changed before freezing");
    const host = store.get("host_run", String(launch.run_id));
    const plan = store.get("acceptance_plan", String(launch.acceptance_plan_id));
    if (run.version !== args.task_run_version || launch.version !== args.launch_version || host.version !== args.host_run_version || plan.version !== args.plan_version) throw new Error("Review source version changed; refresh before freezing");
    if (run.lifecycle !== "active" || host.status !== "completed" || host.cleanup_unconfirmed === true) throw new Error("Only completed, active and confirmed Host work can be frozen");
    if (!(plan.criteria as JsonObject[]).some(item => item.id === request.criterion_id && item.method === "human")) throw new Error("Frozen review requires a human acceptance criterion");
    let total = 0;
    const files = paths.map((path, index) => {
      const bytes = readArtifact(String(launch.workspace), path, MAX_BYTES - total); total += bytes.length;
      const file = store.create("work_review_file", `review_file_${candidateId}_${index}`, { path, sha256: hash(bytes), size_bytes: bytes.length, content_base64: bytes.toString("base64") });
      return { id: file.id, version: file.version, path, sha256: file.sha256, size_bytes: file.size_bytes };
    });
    const freshPlan = recheck(plan);
    const candidate = store.create("work_review_candidate", candidateId, { ...request, task_id: task.id, task_version: task.version, launch_id: launch.id, host_run_id: host.id, plan_id: plan.id, plan_version: freshPlan.version, workspace: launch.workspace, files, manifest_digest: digestJson(files), contract_id: run.contract_id, contract_version: run.contract_version, environment_digest: run.environment_digest, budget_digest: run.budget_digest, request_digest: requestDigest });
    store.save("work_review_policy", policyId(plan.id, request.criterion_id), { plan_id: plan.id, criterion_id: request.criterion_id, latest_candidate_id: candidate.id });
    store.appendEvent(`task:${task.id}`, "work.review_frozen", { candidate_id: candidate.id, manifest_digest: candidate.manifest_digest, actor });
    return { candidate, idempotent: false };
  });
}
export function getWorkReview(store: CraftStore, args: JsonObject): JsonObject {
  const candidate = store.get("work_review_candidate", safeId(args.candidate_id));
  const report = store.find("work_review_report", `work_review_report_${candidate.id}`);
  if (args.relative_path === undefined) return { candidate, report };
  const entry = (candidate.files as JsonObject[]).find(item => item.path === args.relative_path);
  if (!entry) throw new Error("Path is not part of the frozen candidate");
  const file = store.get("work_review_file", String(entry.id), Number(entry.version));
  const bytes = Buffer.from(String(file.content_base64), "base64");
  if (hash(bytes) !== entry.sha256 || bytes.length !== entry.size_bytes) throw new Error("Frozen artifact integrity check failed");
  return { candidate_id: candidate.id, file };
}
export function inheritWorkReviewPolicy(store: CraftStore, fromPlan: JsonObject, toPlan: JsonObject): void {
  for (const policy of store.list("work_review_policy", Number.MAX_SAFE_INTEGER, item => item.plan_id === fromPlan.id)) requireWorkReviewPolicy(store, toPlan, String(policy.criterion_id));
}
export function assertFrozenReviewCheck(store: CraftStore, args: JsonObject): void {
  const policy = store.find("work_review_policy", policyId(args.plan_id, args.criterion_id));
  if (!policy) return;
  const report = args.review_report_id ? store.find("work_review_report", String(args.review_report_id)) : null;
  if (!report || report.candidate_id !== policy.latest_candidate_id || report.result !== args.result || report.reviewer !== args.evaluator_id || report.summary !== args.summary) throw new Error("This criterion requires a current frozen review report");
  assertCurrentWorkReviewCandidate(store, store.get("work_review_candidate", String(report.candidate_id)));
}
export function reportWorkReview(store: CraftStore, args: JsonObject, record: (args: JsonObject) => JsonObject): JsonObject {
  const candidateId = safeId(args.candidate_id), reviewer = text(args.reviewer, "reviewer"), summary = text(args.summary, "summary");
  const result = text(args.result, "result");
  if (summary.length > 8000) throw new Error("Review summary exceeds 8000 characters");
  if (!["passed", "failed", "blocked"].includes(result)) throw new Error("Review result is unsupported");
  if (!Array.isArray(args.findings) || args.findings.length > 100) throw new Error("findings must be an array of at most 100 findings");
  return store.transaction(() => {
    const candidate = store.get("work_review_candidate", candidateId);
    if (candidate.version !== args.candidate_version) throw new Error("Review candidate version changed");
    if (reviewer === candidate.actor) throw new Error("Producer cannot review its own candidate");
    const assignment = store.find("task_assignment", `task_assignment_${candidate.task_id}`);
    if (assignment?.status === "active" && assignment.owner === reviewer) throw new Error("Current task owner cannot independently review its candidate");
    const findings = (args.findings as JsonObject[]).map(value => {
      const item = object(value, "finding");
      const severity = text(item.severity, "severity"), path = text(item.path, "path"), message = text(item.message, "message");
      if (!["blocker", "suggestion"].includes(severity) || message.length > 4000 || !(candidate.files as JsonObject[]).some(file => file.path === path)) throw new Error("Review findings must classify blockers or suggestions on frozen paths");
      return { severity, path, message };
    });
    const blockers = findings.filter(item => item.severity === "blocker").length;
    if ((result === "passed" && blockers) || (result === "failed" && !blockers)) throw new Error("Review verdict does not match its blocking findings");
    const identity = { candidate_id: candidate.id, candidate_version: candidate.version, reviewer, result, summary, findings };
    const digest = digestJson(identity), reportId = `work_review_report_${candidate.id}`;
    const existing = store.find("work_review_report", reportId);
    if (existing) { if (existing.request_digest !== digest) throw new Error("Frozen review report idempotency conflict"); return { report: existing, idempotent: true }; }
    assertCurrentWorkReviewCandidate(store, candidate);
    const report = store.create("work_review_report", reportId, { ...identity, plan_id: candidate.plan_id, plan_version: candidate.plan_version, manifest_digest: candidate.manifest_digest, request_digest: digest, basis: "operator_reported_independent_review" });
    const acceptance = record({ plan_id: candidate.plan_id, plan_version: candidate.plan_version, criterion_id: candidate.criterion_id, reviewer, result, summary, review_id: `human_${report.id}`, review_report_id: report.id });
    store.appendEvent(`task:${candidate.task_id}`, "work.review_reported", { candidate_id: candidate.id, report_id: report.id, reviewer, result, blockers });
    return { report, ...acceptance, idempotent: false };
  });
}

/** Install the gate before a candidate exists; normal human checks cannot bypass it. */
export function requireWorkReviewPolicy(store: CraftStore, plan: JsonObject, criterionId: string): void {
  const id = policyId(plan.id, criterionId);
  if (!store.find("work_review_policy", id)) store.create("work_review_policy", id, { plan_id: plan.id, criterion_id: criterionId, latest_candidate_id: null });
}
