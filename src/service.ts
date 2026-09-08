import { createHash, randomUUID } from "node:crypto";
import { Catalog } from "./catalog.ts";
import { CraftStore, type JsonObject } from "./store.ts";
import { approvedEffects, executeSteps, normalizeSteps, resolveInputs, substitute } from "./workflow.ts";
import { addCosts, dispatchNodes, normalizeNodes, orchestrationOutcome, planStatus, submitNode,
  type PlanNode } from "./orchestration.ts";
import { aggregateEvaluation, compareEvaluationAggregates, type EvaluationAggregate } from "./evaluation.ts";
import { publishSkill, rollbackSkillPublication } from "./skill-publisher.ts";

export const VERSION = "0.7.0";
const CONFIDENCE = new Set(["confirmed", "bounded", "unverified", "rejected"]);
const TASK_STATUS = new Set(["active", "paused", "completed", "cancelled"]);
const VERSIONED_LIFECYCLE = new Set(["draft", "candidate", "verified", "deprecated"]);
const TRIAL_VERDICTS = new Set(["passed", "failed", "blocked", "cancelled"]);
const EVAL_SPLITS = new Set(["search", "development", "held_out"]);
const HARNESS_DIMENSIONS = new Set(["context", "tools", "generation", "orchestration", "memory", "output"]);
const GRADER_TYPES = new Set(["program", "model", "human", "operational"]);
const GRADE_VERDICTS = new Set(["passed", "failed", "inconclusive"]);

function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function document(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}
function finiteInteger(value: unknown, name: string, fallback: number, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}
function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}
function optionalScore(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`${name} must be between 0 and 1`);
  return score;
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}
function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function recordPayload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
  return payload;
}
function uniqueTextArray(value: unknown, name: string, minimum = 1): string[] {
  const values = array(value, name).map((item) => text(item, name));
  if (values.length < minimum || new Set(values).size !== values.length) {
    throw new Error(`${name} must contain at least ${minimum} unique values`);
  }
  return values;
}

export class CraftService {
  readonly store: CraftStore;
  readonly catalog: Catalog;
  constructor(store: CraftStore) { this.store = store; this.catalog = new Catalog(store); }

  info(): JsonObject {
    const kinds = ["source", "capability", "task", "checkpoint", "feedback", "artifact",
      "evidence", "workflow", "workflow_run", "evaluation_suite", "evaluation_run",
      "evaluation_comparison",
      "agent_profile", "orchestration_plan", "harness_configuration", "trial", "outcome",
      "grader", "grade", "signoff_policy", "signoff", "experience_pattern", "skill_proposal",
      "skill_publication", "budget", "model_provider", "agent_session"];
    return { version: VERSION, data_root: this.store.paths.root,
      counts: Object.fromEntries(kinds.map((kind) => [kind, this.store.count(kind)])) };
  }

  sourceAdd(args: JsonObject): Promise<JsonObject> {
    const label = args.label === undefined ? undefined : text(args.label, "label");
    return this.catalog.addSource(text(args.path, "path"), label,
      optionalBoolean(args.scan, "scan") ?? true);
  }
  sourceList(): JsonObject { return { sources: this.catalog.listSources() }; }
  sourceUpdate(args: JsonObject): JsonObject {
    return this.catalog.updateSource(text(args.source_id, "source_id"),
      optionalBoolean(args.enabled, "enabled"), args.label === undefined ? undefined : text(args.label, "label"));
  }
  sourceRemove(args: JsonObject): JsonObject {
    return this.catalog.removeSource(text(args.source_id, "source_id"));
  }
  sourceScan(args: JsonObject): Promise<JsonObject> {
    return this.catalog.scan(args.source_id === undefined ? undefined : text(args.source_id, "source_id"));
  }
  capabilitySearch(args: JsonObject): JsonObject {
    return { capabilities: this.catalog.search(text(args.query, "query"), finiteInteger(args.limit, "limit", 6, 1, 20)) };
  }
  capabilityGet(args: JsonObject): JsonObject {
    return this.catalog.get(text(args.asset_id, "asset_id"));
  }

  taskOpen(args: JsonObject): JsonObject {
    if (args.task_id) return this.taskPack(String(args.task_id));
    const taskId = id("task");
    this.store.save("task", taskId, { title: text(args.title, "title"), goal: text(args.goal, "goal"),
      project_id: args.project_id ?? null, status: "active" });
    return this.taskPack(taskId);
  }
  taskList(args: JsonObject): JsonObject {
    const status = args.status as string | undefined;
    if (status !== undefined && !TASK_STATUS.has(status)) throw new Error(`Unsupported task status: ${status}`);
    return { tasks: this.store.list("task", Number(args.limit ?? 10), (item) =>
      (status === undefined || item.status === status) &&
      (args.project_id === undefined || item.project_id === args.project_id)) };
  }
  taskCheckpoint(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    const task = this.store.get("task", taskId);
    const status = String(args.status ?? task.status);
    if (!TASK_STATUS.has(status)) throw new Error(`Unsupported task status: ${status}`);
    const checkpointId = id("checkpoint");
    const completed = array(args.completed ?? [], "completed");
    const pending = array(args.pending ?? [], "pending");
    const decisions = array(args.decisions ?? [], "decisions");
    const artifacts = array(args.artifacts ?? [], "artifacts");
    this.store.saveBatch([{ kind: "checkpoint", id: checkpointId, payload: {
      task_id: taskId, summary: text(args.summary, "summary"), completed, pending, decisions, artifacts,
      source: args.source ?? "agent_reported" } }, { kind: "task", id: taskId,
      payload: { ...task, status, latest_checkpoint_id: checkpointId } }]);
    return this.taskPack(taskId);
  }
  private taskPack(taskId: string): JsonObject {
    return { task: this.store.get("task", taskId), checkpoints: this.store.list("checkpoint", 100,
      (item) => item.task_id === taskId), feedback: this.store.list("feedback", 100,
      (item) => item.task_id === taskId) };
  }

  feedbackRecord(args: JsonObject): JsonObject {
    const scope = String(args.scope ?? "task");
    if (!new Set(["task", "project", "user"]).has(scope)) throw new Error(`Unsupported feedback scope: ${scope}`);
    if (scope === "task" && !args.task_id) throw new Error("task_id is required for task feedback");
    return this.store.save("feedback", id("feedback"), { corrected: text(args.corrected, "corrected"),
      original: args.original ?? null, kind: args.kind ?? "correction", scope,
      task_id: args.task_id ?? null, applies_to: args.applies_to ?? null,
      source: args.source ?? "user_explicit" });
  }

  artifactRegister(args: JsonObject): JsonObject {
    return this.store.save("artifact", String(args.artifact_id ?? id("artifact")), {
      kind: text(args.kind, "kind"), name: text(args.name, "name"), uri: text(args.uri, "uri"),
      media_type: args.media_type ?? null, digest: args.digest ?? null, size_bytes: args.size_bytes ?? null,
      producer_type: args.producer_type ?? null, producer_id: args.producer_id ?? null,
      metadata: args.metadata ?? {} });
  }
  evidenceRecord(args: JsonObject): JsonObject {
    const confidence = String(args.confidence ?? "unverified");
    if (!CONFIDENCE.has(confidence)) throw new Error(`Unsupported confidence: ${confidence}`);
    if (args.artifact_id) this.store.get("artifact", String(args.artifact_id));
    return this.store.save("evidence", String(args.evidence_id ?? id("evidence")), {
      source_type: text(args.source_type, "source_type"), claim: text(args.claim, "claim"), confidence,
      artifact_id: args.artifact_id ?? null, locator: args.locator ?? null,
      observed_at: args.observed_at ?? new Date().toISOString(), metadata: args.metadata ?? {} });
  }

  saveVersioned(kind: string, prefix: string, args: JsonObject, required: string[]): JsonObject {
    for (const key of required) text(args[key], key);
    const recordId = String(args[`${prefix}_id`] ?? id(prefix));
    const payload = { ...args };
    delete payload[`${prefix}_id`];
    return this.store.save(kind, recordId, payload);
  }
  list(kind: string, key: string, args: JsonObject): JsonObject {
    const query = String(args.query ?? "").toLowerCase();
    return { [key]: this.store.list(kind, finiteInteger(args.limit, "limit", 20, 1, 1_000), (item) =>
      !query || JSON.stringify(item).toLowerCase().includes(query)) };
  }
  get(kind: string, idKey: string, args: JsonObject): JsonObject {
    const version = args.version === undefined ? undefined : finiteInteger(args.version, "version", 1);
    return this.store.get(kind, text(args[idKey], idKey), version);
  }

  harnessConfigurationSave(args: JsonObject): JsonObject {
    const dimensions = object(args.dimensions, "dimensions");
    for (const key of Object.keys(dimensions)) {
      if (!HARNESS_DIMENSIONS.has(key)) throw new Error(`Unsupported harness dimension: ${key}`);
      object(dimensions[key], `dimensions.${key}`);
    }
    return this.saveVersioned("harness_configuration", "configuration", {
      ...args, name: text(args.name, "name"), dimensions,
    }, ["name"]);
  }

  evaluationSuiteSave(args: JsonObject): JsonObject {
    const cases = array(args.cases ?? [], "cases").map((value, index) => {
      const item = object(value, `cases[${index}]`);
      const caseId = text(item.case_id, `cases[${index}].case_id`);
      const split = String(item.split ?? "development");
      if (!EVAL_SPLITS.has(split)) throw new Error(`Unsupported evaluation split: ${split}`);
      return { ...item, case_id: caseId, split };
    });
    if (new Set(cases.map((item) => item.case_id)).size !== cases.length) {
      throw new Error("Evaluation case_id values must be unique");
    }
    return this.saveVersioned("evaluation_suite", "suite", { ...args, cases }, ["name"]);
  }

  graderSave(args: JsonObject): JsonObject {
    const graderType = text(args.grader_type, "grader_type");
    if (!GRADER_TYPES.has(graderType)) throw new Error(`Unsupported grader type: ${graderType}`);
    return this.saveVersioned("grader", "grader", { ...args, grader_type: graderType,
      configuration: object(args.configuration ?? {}, "configuration") }, ["name", "grader_type"]);
  }

  gradeRecord(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id");
    this.store.get("trial", trialId);
    const grader = this.store.get("grader", text(args.grader_id, "grader_id"),
      finiteInteger(args.grader_version, "grader_version", 1));
    const verdict = text(args.verdict, "verdict");
    if (!GRADE_VERDICTS.has(verdict)) throw new Error(`Unsupported grade verdict: ${verdict}`);
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const gradeId = `grade_${createHash("sha256").update(JSON.stringify(
      [trialId, grader.id, grader.version])).digest("hex")}`;
    return this.store.create("grade", gradeId, { trial_id: trialId, grader_id: grader.id,
      grader_version: grader.version, grader_type: grader.grader_type, verdict,
      score: optionalScore(args.score, "score"), summary: text(args.summary, "summary"), evidence_ids: evidenceIds,
      metadata: object(args.metadata ?? {}, "metadata") });
  }

  signoffPolicySave(args: JsonObject): JsonObject {
    const requirements = array(args.requirements ?? [], "requirements").map((value, index) => {
      const requirement = object(value, `requirements[${index}]`);
      const graderType = text(requirement.grader_type, `requirements[${index}].grader_type`);
      if (!GRADER_TYPES.has(graderType)) throw new Error(`Unsupported grader type: ${graderType}`);
      return { grader_type: graderType, minimum_score: optionalScore(requirement.minimum_score,
        `requirements[${index}].minimum_score`) };
    });
    if (new Set(requirements.map((item) => item.grader_type)).size !== requirements.length) {
      throw new Error("Signoff grader_type requirements must be unique");
    }
    return this.saveVersioned("signoff_policy", "policy", { ...args, requirements,
      require_held_out: optionalBoolean(args.require_held_out, "require_held_out") ?? true,
      require_outcome_passed: optionalBoolean(args.require_outcome_passed, "require_outcome_passed") ?? true,
    }, ["name"]);
  }

  signoffEvaluate(args: JsonObject): JsonObject {
    const policy = this.store.get("signoff_policy", text(args.policy_id, "policy_id"),
      args.policy_version === undefined ? undefined : finiteInteger(args.policy_version, "policy_version", 1));
    const evaluation = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    const gradeIds = array(args.grade_ids ?? [], "grade_ids").map((value) => text(value, "grade_id"));
    if (new Set(gradeIds).size !== gradeIds.length) throw new Error("grade_ids must be unique");
    const trialIds = evaluation.trial_ids as string[];
    const grades = gradeIds.map((gradeId) => {
      const grade = this.store.get("grade", gradeId);
      if (!trialIds.includes(String(grade.trial_id))) throw new Error(`Grade is outside the evaluation run: ${gradeId}`);
      return grade;
    });
    const checks: JsonObject[] = [];
    if (policy.require_held_out) checks.push({ check: "held_out", passed: evaluation.split === "held_out" });
    if (policy.require_outcome_passed) checks.push({ check: "outcome", passed: evaluation.verdict === "passed" });
    for (const requirement of policy.requirements as JsonObject[]) {
      const graderType = String(requirement.grader_type);
      const minimumScore = requirement.minimum_score as number | null;
      for (const trialId of trialIds) {
        const matching = grades.filter((grade) => grade.trial_id === trialId && grade.grader_type === graderType);
        checks.push({ check: "grader", trial_id: trialId, grader_type: graderType,
          passed: matching.some((grade) => grade.verdict === "passed" &&
            (minimumScore === null || (grade.score !== null && Number(grade.score) >= minimumScore))),
          grade_ids: matching.map((grade) => grade.id), minimum_score: minimumScore });
      }
    }
    const decision = checks.every((check) => check.passed) ? "passed" : "failed";
    return this.store.create("signoff", String(args.signoff_id ?? id("signoff")), {
      policy_id: policy.id, policy_version: policy.version, evaluation_run_id: evaluation.id,
      subject_type: evaluation.subject_type, subject_id: evaluation.subject_id,
      subject_version: evaluation.subject_version, grade_ids: gradeIds, checks, decision,
    });
  }

  trialStart(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const subjectType = text(args.subject_type, "subject_type");
    const subjectId = text(args.subject_id, "subject_id");
    const subjectVersion = finiteInteger(args.subject_version, "subject_version", 1);
    this.store.get(subjectType, subjectId, subjectVersion);
    let harness: JsonObject | undefined;
    if (args.harness_configuration_id !== undefined) {
      harness = this.store.get("harness_configuration", text(args.harness_configuration_id,
        "harness_configuration_id"), args.harness_configuration_version === undefined ? undefined
          : finiteInteger(args.harness_configuration_version, "harness_configuration_version", 1));
    }
    return this.store.create("trial", String(args.trial_id ?? id("trial")), {
      task_id: taskId, case_id: args.case_id === undefined ? null : text(args.case_id, "case_id"),
      subject_type: subjectType, subject_id: subjectId, subject_version: subjectVersion,
      harness_configuration_id: harness?.id ?? null,
      harness_configuration_version: harness?.version ?? null,
      environment: object(args.environment ?? {}, "environment"),
      budget: object(args.budget ?? {}, "budget"), status: "started",
    });
  }

  trialTraceAppend(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id");
    this.store.get("trial", trialId);
    const artifactIds = array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id"));
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId);
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    return this.store.appendEvent(`trial:${trialId}`, text(args.event_type, "event_type"), {
      trial_id: trialId, source: args.source ?? "agent_reported",
      data: object(args.data ?? {}, "data"), artifact_ids: artifactIds, evidence_ids: evidenceIds,
    });
  }

  outcomeRecord(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id");
    this.store.get("trial", trialId);
    const verdict = String(args.verdict);
    if (!TRIAL_VERDICTS.has(verdict)) throw new Error(`Unsupported trial verdict: ${verdict}`);
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const failureType = args.failure_type === undefined ? (verdict === "passed" ? null : "unspecified")
      : text(args.failure_type, "failure_type");
    return this.store.create("outcome", `outcome_${trialId}`, {
      trial_id: trialId, verdict, summary: text(args.summary, "summary"),
      failure_type: failureType,
      scores: object(args.scores ?? {}, "scores"), costs: object(args.costs ?? {}, "costs"),
      evidence_ids: evidenceIds, source: args.source ?? "program_verified",
    });
  }

  trialGet(args: JsonObject): JsonObject {
    const trialId = text(args.trial_id, "trial_id");
    const trial = this.store.get("trial", trialId);
    const outcome = this.store.find("outcome", `outcome_${trialId}`);
    return { trial, trace: this.store.events(`trial:${trialId}`), outcome };
  }

  evaluationRunRecord(args: JsonObject): JsonObject {
    const suite = this.store.get("evaluation_suite", text(args.suite_id, "suite_id"),
      args.suite_version === undefined ? undefined : finiteInteger(args.suite_version, "suite_version", 1));
    const split = String(args.split);
    if (!EVAL_SPLITS.has(split)) throw new Error(`Unsupported evaluation split: ${split}`);
    const subjectType = text(args.subject_type, "subject_type");
    const subjectId = text(args.subject_id, "subject_id");
    const subjectVersion = finiteInteger(args.subject_version, "subject_version", 1);
    this.store.get(subjectType, subjectId, subjectVersion);
    const trialIds = array(args.trial_ids, "trial_ids").map((value) => text(value, "trial_id"));
    if (!trialIds.length || new Set(trialIds).size !== trialIds.length) {
      throw new Error("trial_ids must contain unique trials");
    }
    const cases = array(suite.cases ?? [], "suite cases") as JsonObject[];
    const allowedCases = new Set(cases.filter((item) => item.split === split).map((item) => String(item.case_id)));
    const outcomes = trialIds.map((trialId) => {
      const trial = this.store.get("trial", trialId);
      if (trial.subject_type !== subjectType || trial.subject_id !== subjectId ||
          Number(trial.subject_version) !== subjectVersion) throw new Error(`Trial subject mismatch: ${trialId}`);
      if (!trial.case_id || !allowedCases.has(String(trial.case_id))) {
        throw new Error(`Trial case is not in the ${split} suite partition: ${trialId}`);
      }
      const outcome = this.store.find("outcome", `outcome_${trialId}`);
      if (!outcome) throw new Error(`Trial has no outcome: ${trialId}`);
      return outcome;
    });
    const verdict = outcomes.every((outcome) => outcome.verdict === "passed") ? "passed" : "failed";
    return this.store.create("evaluation_run", String(args.run_id ?? id("evalrun")), {
      suite_id: suite.id, suite_version: suite.version, split, subject_type: subjectType,
      subject_id: subjectId, subject_version: subjectVersion, trial_ids: trialIds, verdict,
      metrics: object(args.metrics ?? {}, "metrics"),
    });
  }

  evaluationRunAggregate(args: JsonObject): JsonObject {
    const run = this.store.get("evaluation_run", text(args.run_id, "run_id"));
    const trials = (run.trial_ids as string[]).map((trialId) => this.store.get("trial", trialId));
    const outcomes = trials.map((trial) => this.store.get("outcome", `outcome_${trial.id}`));
    return aggregateEvaluation(run, trials, outcomes);
  }

  evaluationCompare(args: JsonObject): JsonObject {
    const baselineId = text(args.baseline_run_id, "baseline_run_id");
    const candidateId = text(args.candidate_run_id, "candidate_run_id");
    if (baselineId === candidateId) throw new Error("Evaluation comparison requires two different runs");
    const baseline = this.evaluationRunAggregate({ run_id: baselineId }) as EvaluationAggregate;
    const candidate = this.evaluationRunAggregate({ run_id: candidateId }) as EvaluationAggregate;
    for (const field of ["suite_id", "suite_version", "split", "subject_type"] as const) {
      if (baseline[field] !== candidate[field]) throw new Error(`Evaluation runs are not comparable: ${field} differs`);
    }
    if (JSON.stringify(baseline.case_ids) !== JSON.stringify(candidate.case_ids)) {
      throw new Error("Evaluation runs are not comparable: case_ids differ");
    }
    return this.store.create("evaluation_comparison", String(args.comparison_id ?? id("comparison")), {
      baseline_run_id: baselineId, candidate_run_id: candidateId,
      suite_id: baseline.suite_id, suite_version: baseline.suite_version, split: baseline.split,
      subject_type: baseline.subject_type, case_ids: baseline.case_ids,
      baseline, candidate, comparison: compareEvaluationAggregates(baseline, candidate),
    });
  }

  workflowSave(args: JsonObject): JsonObject {
    return this.saveVersioned("workflow", "workflow", { ...args, lifecycle: "draft" }, ["name"]);
  }

  workflowTransition(args: JsonObject): JsonObject {
    return this.transitionVersionedSubject("workflow", "workflow_id", "workflow", args);
  }

  private verificationGate(subjectType: string, subject: JsonObject, args: JsonObject): JsonObject {
    if (args.signoff_id !== undefined) {
      const signoff = this.store.get("signoff", text(args.signoff_id, "signoff_id"));
      const run = this.store.get("evaluation_run", String(signoff.evaluation_run_id));
      if (signoff.decision !== "passed" || signoff.subject_type !== subjectType ||
          signoff.subject_id !== subject.id || Number(signoff.subject_version) !== Number(subject.version) ||
          run.verdict !== "passed" || run.split !== "held_out") {
        throw new Error(`Verification requires a passed signoff for this exact ${subjectType} version`);
      }
      return { evaluation_run_id: run.id, signoff_id: signoff.id };
    }
    const run = this.store.get("evaluation_run", text(args.evaluation_run_id, "evaluation_run_id"));
    if (run.verdict !== "passed" || run.split !== "held_out" || run.subject_type !== subjectType ||
        run.subject_id !== subject.id || Number(run.subject_version) !== Number(subject.version)) {
      throw new Error(`Verification requires a passed held-out evaluation for this exact ${subjectType} version`);
    }
    return { evaluation_run_id: run.id, signoff_id: null };
  }

  private transitionVersionedSubject(kind: string, idKey: string, subjectType: string, args: JsonObject): JsonObject {
    const subject = this.store.get(kind, text(args[idKey], idKey));
    const current = String(subject.lifecycle ?? "draft");
    const target = text(args.target, "target");
    if (!VERSIONED_LIFECYCLE.has(target)) throw new Error(`Unsupported ${subjectType} lifecycle: ${target}`);
    const allowed: Record<string, string[]> = {
      draft: ["candidate", "deprecated"], candidate: ["verified", "deprecated"],
      verified: ["deprecated"], deprecated: [],
    };
    if (!allowed[current]?.includes(target)) throw new Error(`Invalid ${subjectType} transition: ${current} -> ${target}`);
    const verification = target === "verified" ? this.verificationGate(subjectType, subject, args)
      : { evaluation_run_id: null, signoff_id: null };
    return this.store.save(kind, String(subject.id), { ...recordPayload(subject), lifecycle: target,
      previous_version: subject.version, transition_reason: text(args.reason, "reason"), ...verification });
  }

  workflowRollback(args: JsonObject): JsonObject {
    return this.rollbackVersionedSubject("workflow", "workflow_id", "workflow", args);
  }

  private rollbackVersionedSubject(kind: string, idKey: string, subjectType: string, args: JsonObject): JsonObject {
    const subjectId = text(args[idKey], idKey);
    const current = this.store.get(kind, subjectId);
    const target = this.store.get(kind, subjectId, finiteInteger(args.target_version, "target_version", 1));
    if (target.lifecycle !== "verified") throw new Error(`Rollback target must be a verified ${subjectType} version`);
    return this.store.save(kind, subjectId, { ...recordPayload(target), lifecycle: "verified",
      rollback_from_version: current.version, rollback_to_version: target.version,
      rollback_reason: text(args.reason, "reason") });
  }

  experiencePatternCreate(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const trialIds = uniqueTextArray(args.trial_ids, "trial_ids", 2);
    const evidenceIds = uniqueTextArray(args.evidence_ids, "evidence_ids");
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const outcomes = trialIds.map((trialId) => {
      this.store.get("trial", trialId);
      const outcome = this.store.get("outcome", `outcome_${trialId}`);
      return { trial_id: trialId, verdict: outcome.verdict, failure_type: outcome.failure_type };
    });
    return this.saveVersioned("experience_pattern", "pattern", { ...args, task_id: taskId, trial_ids: trialIds,
      evidence_ids: evidenceIds, outcomes, success_strategy: text(args.success_strategy, "success_strategy"),
      failure_modes: array(args.failure_modes, "failure_modes").map((item) => text(item, "failure_mode")),
      applicability: text(args.applicability, "applicability") }, ["summary"]);
  }

  skillProposalCreate(args: JsonObject): JsonObject {
    const patternIds = uniqueTextArray(args.pattern_ids, "pattern_ids");
    for (const patternId of patternIds) this.store.get("experience_pattern", patternId);
    return this.saveVersioned("skill_proposal", "proposal", { ...args, lifecycle: "draft", pattern_ids: patternIds,
      skill_markdown: document(args.skill_markdown, "skill_markdown") }, ["name", "summary"]);
  }

  skillProposalTransition(args: JsonObject): JsonObject {
    return this.transitionVersionedSubject("skill_proposal", "proposal_id", "skill_proposal", args);
  }

  skillProposalRollback(args: JsonObject): JsonObject {
    return this.rollbackVersionedSubject("skill_proposal", "proposal_id", "skill_proposal", args);
  }

  async skillProposalPublish(args: JsonObject): Promise<JsonObject> {
    const proposal = this.store.get("skill_proposal", text(args.proposal_id, "proposal_id"));
    if (proposal.lifecycle !== "verified") throw new Error("Skill proposal must be verified before publication");
    const source = this.catalog.getSource(text(args.source_id, "source_id"));
    const publication = await publishSkill({ sourceRoot: String(source.real_path), targetPath: text(args.target_path, "target_path"),
      expectedDigest: text(args.expected_digest, "expected_digest"), content: String(proposal.skill_markdown),
      backupsDir: this.store.paths.backupsDir, proposalId: String(proposal.id), allowExternalWrite: args.allow_external_write });
    const record = this.store.create("skill_publication", String(args.publication_id ?? id("publication")), {
      proposal_id: proposal.id, proposal_version: proposal.version, source_id: source.id, status: "published", ...publication,
    });
    await this.catalog.scanSource(String(source.id));
    return record;
  }

  async skillPublicationRollback(args: JsonObject): Promise<JsonObject> {
    const publication = this.store.get("skill_publication", text(args.publication_id, "publication_id"));
    if (publication.status !== "published") throw new Error("Only a published Skill publication can be rolled back");
    await rollbackSkillPublication({ targetPath: String(publication.target_path), expectedDigest: text(args.expected_digest, "expected_digest"),
      publishedDigest: String(publication.published_digest), backupPath: String(publication.backup_path),
      allowExternalWrite: args.allow_external_write });
    const restored = this.store.save("skill_publication", String(publication.id), { ...recordPayload(publication), status: "rolled_back" });
    await this.catalog.scanSource(String(publication.source_id));
    return restored;
  }

  workflowPlan(args: JsonObject): JsonObject {
    const workflow = this.get("workflow", "workflow_id", args);
    const definitions = array(workflow.inputs ?? [], "workflow inputs") as JsonObject[];
    if (typeof (args.inputs ?? {}) !== "object" || Array.isArray(args.inputs)) {
      throw new Error("inputs must be an object");
    }
    const inputs = resolveInputs(definitions, (args.inputs ?? {}) as JsonObject);
    const stepDefinitions = array(workflow.steps ?? [], "workflow steps");
    const steps = normalizeSteps(substitute(stepDefinitions, inputs) as unknown[]);
    const allowExecution = optionalBoolean(args.allow_execution, "allow_execution") ?? false;
    const sideEffects = array(args.approved_side_effects ?? [], "approved_side_effects");
    const approved = approvedEffects(allowExecution, sideEffects);
    return { workflow_id: workflow.id, workflow_version: workflow.version, inputs, steps,
      approved_side_effects: [...approved], executable: steps.every((step) => approved.has(String(step.side_effect))) };
  }
  workflowRun(args: JsonObject): JsonObject {
    const plan = this.workflowPlan(args);
    const root = text(args.project_root, "project_root");
    const results = executeSteps(plan.steps as JsonObject[], root,
      new Set(plan.approved_side_effects as string[]));
    const passed = results.length === (plan.steps as unknown[]).length && results.every((item) => item.passed);
    return this.store.save("workflow_run", id("run"), { workflow_id: plan.workflow_id,
      workflow_version: plan.workflow_version, project_root: root, inputs: plan.inputs, results,
      status: passed ? "passed" : "failed" });
  }

  workflowTrialRun(args: JsonObject): JsonObject {
    const plan = this.workflowPlan(args);
    const trial = this.trialStart({
      trial_id: args.trial_id,
      task_id: args.task_id,
      case_id: args.case_id,
      subject_type: "workflow",
      subject_id: plan.workflow_id,
      subject_version: plan.workflow_version,
      harness_configuration_id: args.harness_configuration_id,
      harness_configuration_version: args.harness_configuration_version,
      environment: args.environment ?? {},
      budget: args.budget ?? {},
    });
    const trialId = String(trial.id);
    this.trialTraceAppend({ trial_id: trialId, event_type: "workflow.started", source: "program_verified",
      data: { workflow_id: plan.workflow_id, workflow_version: plan.workflow_version } });

    const startedAt = Date.now();
    let run: JsonObject;
    try {
      run = this.workflowRun({ ...args, version: plan.workflow_version });
    } catch {
      const evidence = this.evidenceRecord({ source_type: "program", confidence: "confirmed",
        claim: "Workflow execution crashed before a durable run receipt was produced.",
        locator: { workflow_id: plan.workflow_id, workflow_version: plan.workflow_version } });
      this.trialTraceAppend({ trial_id: trialId, event_type: "workflow.crashed", source: "program_verified",
        data: { error_type: "ExecutionError" }, evidence_ids: [evidence.id] });
      this.outcomeRecord({ trial_id: trialId, verdict: "failed",
        summary: "Workflow execution crashed before completion.", failure_type: "execution_error",
        scores: {}, costs: { duration_ms: Date.now() - startedAt },
        evidence_ids: [evidence.id], source: "program_verified" });
      return { workflow_run: null, artifact: null, evidence, ...this.trialGet({ trial_id: trialId }) };
    }
    const artifact = this.artifactRegister({ kind: "workflow_receipt", name: `Workflow run ${run.id}`,
      uri: `craft://workflow-runs/${run.id}`, media_type: "application/json",
      producer_type: "workflow_run", producer_id: run.id,
      metadata: { workflow_id: plan.workflow_id, workflow_version: plan.workflow_version } });
    const passed = run.status === "passed";
    const evidence = this.evidenceRecord({ source_type: "program", confidence: "confirmed",
      claim: `Workflow run ${run.id} ${passed ? "passed" : "failed"} deterministic checks.`,
      artifact_id: artifact.id, locator: { workflow_run_id: run.id } });
    this.trialTraceAppend({ trial_id: trialId, event_type: "workflow.completed", source: "program_verified",
      data: { status: run.status, workflow_run_id: run.id }, artifact_ids: [artifact.id],
      evidence_ids: [evidence.id] });
    const results = run.results as JsonObject[];
    this.outcomeRecord({ trial_id: trialId, verdict: passed ? "passed" : "failed",
      summary: passed ? "Workflow passed deterministic checks." : "Workflow failed deterministic checks.",
      ...(passed ? {} : { failure_type: "deterministic_check_failed" }),
      scores: { passed_steps: results.filter((item) => item.passed).length, total_steps: results.length },
      costs: { duration_ms: Date.now() - startedAt }, evidence_ids: [evidence.id], source: "program_verified" });
    return { workflow_run: run, artifact, evidence, ...this.trialGet({ trial_id: trialId }) };
  }

  orchestrationCreate(args: JsonObject): JsonObject {
    const nodes = normalizeNodes((args.nodes ?? []) as unknown[]).map((node) => ({ ...node,
      profile_versions: node.profile_ids.map((profileId) => Number(this.store.get("agent_profile", profileId).version)),
    }));
    const max = Number(args.max_concurrency ?? 4);
    if (!Number.isInteger(max) || max < 1 || max > 32) throw new Error("max_concurrency must be between 1 and 32");
    const planId = args.plan_id === undefined ? id("plan") : text(args.plan_id, "plan_id");
    return this.store.create("orchestration_plan", planId, { goal: text(args.goal, "goal"),
      task_id: args.task_id ?? null, trial_id: args.trial_id ?? null,
      trial_started_at: args.trial_started_at ?? null, accumulated_costs: {},
      max_concurrency: max, status: "running", nodes, policy: object(args.policy ?? {}, "policy") });
  }
  orchestrationTrialStart(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id");
    this.store.get("task", taskId);
    const trialId = args.trial_id === undefined ? id("trial") : text(args.trial_id, "trial_id");
    if (this.store.find("trial", trialId)) throw new Error(`Trial already exists: ${trialId}`);
    const caseId = args.case_id === undefined ? undefined : text(args.case_id, "case_id");
    const environment = object(args.environment ?? {}, "environment");
    const budget = object(args.budget ?? {}, "budget");
    if (args.harness_configuration_id !== undefined) {
      this.store.get("harness_configuration", text(args.harness_configuration_id, "harness_configuration_id"),
        args.harness_configuration_version === undefined ? undefined
          : finiteInteger(args.harness_configuration_version, "harness_configuration_version", 1));
    }
    const plan = this.orchestrationCreate({ ...args, task_id: taskId, trial_id: trialId,
      trial_started_at: new Date().toISOString() });
    const trial = this.trialStart({ trial_id: trialId, task_id: taskId, case_id: caseId,
      subject_type: "orchestration_plan", subject_id: plan.id, subject_version: plan.version,
      harness_configuration_id: args.harness_configuration_id,
      harness_configuration_version: args.harness_configuration_version,
      environment, budget });
    this.trialTraceAppend({ trial_id: trial.id, event_type: "orchestration.started", source: "program_verified",
      data: { plan_id: plan.id, plan_version: plan.version } });
    return { plan, ...this.trialGet({ trial_id: trial.id }) };
  }
  orchestrationDispatch(args: JsonObject): JsonObject {
    const plan = this.get("orchestration_plan", "plan_id", args);
    if (plan.status !== "running") throw new Error(`Plan is not running: ${plan.status}`);
    const owner = text(args.claimed_by, "claimed_by");
    const maximum = finiteInteger(plan.max_concurrency, "plan max_concurrency", 4, 1, 32);
    const requested = finiteInteger(args.capacity, "capacity", maximum, 1);
    const capacity = Math.min(requested, maximum);
    const result = dispatchNodes(plan.nodes as PlanNode[], capacity, owner);
    const saved = this.store.updateIfVersion("orchestration_plan", String(plan.id), Number(plan.version), { ...plan, nodes: result.nodes,
      status: planStatus(result.nodes) });
    if (plan.trial_id && result.leases.length) {
      this.trialTraceAppend({ trial_id: plan.trial_id, event_type: "orchestration.dispatched",
        source: "program_verified", data: { leases: result.leases } });
    }
    return { plan: saved, leases: result.leases };
  }
  orchestrationSubmit(args: JsonObject): JsonObject {
    const plan = this.get("orchestration_plan", "plan_id", args);
    const leaseId = text(args.lease_id, "lease_id");
    const leased = (plan.nodes as PlanNode[]).find((node) => node.lease_id === leaseId);
    if (!leased) throw new Error(`Unknown lease: ${leaseId}`);
    if (args.claimed_by !== undefined) {
      if (leased.claimed_by !== text(args.claimed_by, "claimed_by")) throw new Error("Lease owner does not match");
    }
    const provenance = String(args.provenance ?? "agent_reported");
    const verdict = text(args.verdict, "verdict");
    const costs = object(args.costs ?? {}, "costs");
    const accumulatedCosts = addCosts(object(plan.accumulated_costs ?? {}, "accumulated costs"), costs);
    const artifactIds = array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id"));
    const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
    for (const artifactId of artifactIds) this.store.get("artifact", artifactId);
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const summary = args.summary === undefined ? null : text(args.summary, "summary");
    const nodes = submitNode(plan.nodes as PlanNode[], leaseId, verdict, provenance);
    const status = planStatus(nodes);
    const saved = this.store.updateIfVersion("orchestration_plan", String(plan.id), Number(plan.version),
      { ...plan, nodes, status, accumulated_costs: accumulatedCosts });
    if (plan.trial_id) {
      this.trialTraceAppend({ trial_id: plan.trial_id, event_type: "orchestration.node_submitted",
        source: provenance, data: { node_id: leased.id,
          profile_id: leased.profile_ids[Number(leased.route_index)],
          profile_version: leased.profile_versions![Number(leased.route_index)],
          verdict, summary, costs }, artifact_ids: artifactIds, evidence_ids: evidenceIds });
      if (status !== "running") this.orchestrationTrialFinalize({ plan_id: saved.id });
    }
    return saved;
  }
  orchestrationTrialFinalize(args: JsonObject): JsonObject {
    const plan = this.get("orchestration_plan", "plan_id", args);
    if (!plan.trial_id) throw new Error("Orchestration plan is not linked to a Trial");
    if (plan.status === "running") throw new Error("Orchestration plan is still running");
    const trialId = String(plan.trial_id);
    if (this.store.find("outcome", `outcome_${trialId}`)) {
      return { plan, ...this.trialGet({ trial_id: trialId }) };
    }
    const result = orchestrationOutcome(plan.nodes as PlanNode[]);
    const stableKey = createHash("sha256").update(`${plan.id}:${trialId}`).digest("hex");
    const artifactId = `artifact_${stableKey}`;
    const artifact = this.store.find("artifact", artifactId) ?? this.artifactRegister({ artifact_id: artifactId,
      kind: "orchestration_receipt",
      name: `Orchestration plan ${plan.id}`, uri: `craft://orchestration-plans/${plan.id}/versions/${plan.version}`,
      media_type: "application/json", producer_type: "orchestration_plan", producer_id: plan.id,
      metadata: { plan_version: plan.version } });
    const evidenceId = `evidence_${stableKey}`;
    const evidence = this.store.find("evidence", evidenceId) ?? this.evidenceRecord({ evidence_id: evidenceId,
      source_type: "orchestration", confidence: "confirmed",
      claim: `Orchestration plan ${plan.id} reached ${plan.status} from recorded node submissions.`,
      artifact_id: artifact.id, locator: { plan_id: plan.id, plan_version: plan.version } });
    const events = this.store.events(`trial:${trialId}`);
    if (!events.some((event) => event.event_type === "orchestration.completed")) {
      this.trialTraceAppend({ trial_id: trialId, event_type: "orchestration.completed", source: "program_verified",
        data: { status: plan.status, plan_version: plan.version }, artifact_ids: [artifact.id],
        evidence_ids: [evidence.id] });
    }
    const traceEvidence = this.store.events(`trial:${trialId}`).flatMap((event) =>
      (((event.payload as JsonObject).evidence_ids as string[] | undefined) ?? []));
    const startedAt = Date.parse(String(plan.trial_started_at));
    this.outcomeRecord({ trial_id: trialId, verdict: result.verdict, failure_type: result.failure_type ?? undefined,
      summary: result.verdict === "passed" ? "Orchestration completed all nodes." : "Orchestration did not complete all nodes.",
      scores: result.scores, costs: { ...(plan.accumulated_costs as JsonObject),
        wall_duration_ms: Math.max(0, Date.now() - startedAt) },
      evidence_ids: [...new Set(traceEvidence)], source: "orchestration_aggregated" });
    return { plan, ...this.trialGet({ trial_id: trialId }) };
  }
}
