import { randomUUID } from "node:crypto";
import { Catalog } from "./catalog.js";
import { CraftStore } from "./store.js";
import { approvedEffects, executeSteps, normalizeSteps, resolveInputs, substitute } from "./workflow.js";
import { dispatchNodes, normalizeNodes, planStatus, submitNode } from "./orchestration.js";
export const VERSION = "0.3.1";
const CONFIDENCE = new Set(["confirmed", "bounded", "unverified", "rejected"]);
const TASK_STATUS = new Set(["active", "paused", "completed", "cancelled"]);
const WORKFLOW_LIFECYCLE = new Set(["draft", "candidate", "verified", "deprecated"]);
const TRIAL_VERDICTS = new Set(["passed", "failed", "blocked", "cancelled"]);
const EVAL_SPLITS = new Set(["search", "development", "held_out"]);
const HARNESS_DIMENSIONS = new Set(["context", "tools", "generation", "orchestration", "memory", "output"]);
function id(prefix) { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function finiteInteger(value, name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return number;
}
function optionalBoolean(value, name) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "boolean")
        throw new Error(`${name} must be a boolean`);
    return value;
}
function array(value, name) {
    if (!Array.isArray(value))
        throw new Error(`${name} must be an array`);
    return value;
}
function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    return value;
}
function recordPayload(record) {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
    return payload;
}
export class CraftService {
    store;
    catalog;
    constructor(store) { this.store = store; this.catalog = new Catalog(store); }
    info() {
        const kinds = ["source", "capability", "task", "checkpoint", "feedback", "artifact",
            "evidence", "workflow", "workflow_run", "evaluation_suite", "evaluation_run",
            "agent_profile", "orchestration_plan", "harness_configuration", "trial", "outcome",
            "budget", "model_provider", "agent_session"];
        return { version: VERSION, data_root: this.store.paths.root,
            counts: Object.fromEntries(kinds.map((kind) => [kind, this.store.count(kind)])) };
    }
    sourceAdd(args) {
        const label = args.label === undefined ? undefined : text(args.label, "label");
        return this.catalog.addSource(text(args.path, "path"), label, optionalBoolean(args.scan, "scan") ?? true);
    }
    sourceList() { return { sources: this.catalog.listSources() }; }
    sourceUpdate(args) {
        return this.catalog.updateSource(text(args.source_id, "source_id"), optionalBoolean(args.enabled, "enabled"), args.label === undefined ? undefined : text(args.label, "label"));
    }
    sourceRemove(args) {
        return this.catalog.removeSource(text(args.source_id, "source_id"));
    }
    sourceScan(args) {
        return this.catalog.scan(args.source_id === undefined ? undefined : text(args.source_id, "source_id"));
    }
    capabilitySearch(args) {
        return { capabilities: this.catalog.search(text(args.query, "query"), finiteInteger(args.limit, "limit", 6, 1, 20)) };
    }
    capabilityGet(args) {
        return this.catalog.get(text(args.asset_id, "asset_id"));
    }
    taskOpen(args) {
        if (args.task_id)
            return this.taskPack(String(args.task_id));
        const taskId = id("task");
        this.store.save("task", taskId, { title: text(args.title, "title"), goal: text(args.goal, "goal"),
            project_id: args.project_id ?? null, status: "active" });
        return this.taskPack(taskId);
    }
    taskList(args) {
        const status = args.status;
        if (status !== undefined && !TASK_STATUS.has(status))
            throw new Error(`Unsupported task status: ${status}`);
        return { tasks: this.store.list("task", Number(args.limit ?? 10), (item) => (status === undefined || item.status === status) &&
                (args.project_id === undefined || item.project_id === args.project_id)) };
    }
    taskCheckpoint(args) {
        const taskId = text(args.task_id, "task_id");
        const task = this.store.get("task", taskId);
        const status = String(args.status ?? task.status);
        if (!TASK_STATUS.has(status))
            throw new Error(`Unsupported task status: ${status}`);
        const checkpointId = id("checkpoint");
        const completed = array(args.completed ?? [], "completed");
        const pending = array(args.pending ?? [], "pending");
        const decisions = array(args.decisions ?? [], "decisions");
        const artifacts = array(args.artifacts ?? [], "artifacts");
        this.store.saveBatch([{ kind: "checkpoint", id: checkpointId, payload: {
                    task_id: taskId, summary: text(args.summary, "summary"), completed, pending, decisions, artifacts,
                    source: args.source ?? "agent_reported"
                } }, { kind: "task", id: taskId,
                payload: { ...task, status, latest_checkpoint_id: checkpointId } }]);
        return this.taskPack(taskId);
    }
    taskPack(taskId) {
        return { task: this.store.get("task", taskId), checkpoints: this.store.list("checkpoint", 100, (item) => item.task_id === taskId), feedback: this.store.list("feedback", 100, (item) => item.task_id === taskId) };
    }
    feedbackRecord(args) {
        const scope = String(args.scope ?? "task");
        if (!new Set(["task", "project", "user"]).has(scope))
            throw new Error(`Unsupported feedback scope: ${scope}`);
        if (scope === "task" && !args.task_id)
            throw new Error("task_id is required for task feedback");
        return this.store.save("feedback", id("feedback"), { corrected: text(args.corrected, "corrected"),
            original: args.original ?? null, kind: args.kind ?? "correction", scope,
            task_id: args.task_id ?? null, applies_to: args.applies_to ?? null,
            source: args.source ?? "user_explicit" });
    }
    artifactRegister(args) {
        return this.store.save("artifact", String(args.artifact_id ?? id("artifact")), {
            kind: text(args.kind, "kind"), name: text(args.name, "name"), uri: text(args.uri, "uri"),
            media_type: args.media_type ?? null, digest: args.digest ?? null, size_bytes: args.size_bytes ?? null,
            producer_type: args.producer_type ?? null, producer_id: args.producer_id ?? null,
            metadata: args.metadata ?? {}
        });
    }
    evidenceRecord(args) {
        const confidence = String(args.confidence ?? "unverified");
        if (!CONFIDENCE.has(confidence))
            throw new Error(`Unsupported confidence: ${confidence}`);
        if (args.artifact_id)
            this.store.get("artifact", String(args.artifact_id));
        return this.store.save("evidence", String(args.evidence_id ?? id("evidence")), {
            source_type: text(args.source_type, "source_type"), claim: text(args.claim, "claim"), confidence,
            artifact_id: args.artifact_id ?? null, locator: args.locator ?? null,
            observed_at: args.observed_at ?? new Date().toISOString(), metadata: args.metadata ?? {}
        });
    }
    saveVersioned(kind, prefix, args, required) {
        for (const key of required)
            text(args[key], key);
        const recordId = String(args[`${prefix}_id`] ?? id(prefix));
        const payload = { ...args };
        delete payload[`${prefix}_id`];
        return this.store.save(kind, recordId, payload);
    }
    list(kind, key, args) {
        const query = String(args.query ?? "").toLowerCase();
        return { [key]: this.store.list(kind, finiteInteger(args.limit, "limit", 20, 1, 1_000), (item) => !query || JSON.stringify(item).toLowerCase().includes(query)) };
    }
    get(kind, idKey, args) {
        const version = args.version === undefined ? undefined : finiteInteger(args.version, "version", 1);
        return this.store.get(kind, text(args[idKey], idKey), version);
    }
    harnessConfigurationSave(args) {
        const dimensions = object(args.dimensions, "dimensions");
        for (const key of Object.keys(dimensions)) {
            if (!HARNESS_DIMENSIONS.has(key))
                throw new Error(`Unsupported harness dimension: ${key}`);
            object(dimensions[key], `dimensions.${key}`);
        }
        return this.saveVersioned("harness_configuration", "configuration", {
            ...args, name: text(args.name, "name"), dimensions,
        }, ["name"]);
    }
    evaluationSuiteSave(args) {
        const cases = array(args.cases ?? [], "cases").map((value, index) => {
            const item = object(value, `cases[${index}]`);
            const caseId = text(item.case_id, `cases[${index}].case_id`);
            const split = String(item.split ?? "development");
            if (!EVAL_SPLITS.has(split))
                throw new Error(`Unsupported evaluation split: ${split}`);
            return { ...item, case_id: caseId, split };
        });
        if (new Set(cases.map((item) => item.case_id)).size !== cases.length) {
            throw new Error("Evaluation case_id values must be unique");
        }
        return this.saveVersioned("evaluation_suite", "suite", { ...args, cases }, ["name"]);
    }
    trialStart(args) {
        const taskId = text(args.task_id, "task_id");
        this.store.get("task", taskId);
        const subjectType = text(args.subject_type, "subject_type");
        const subjectId = text(args.subject_id, "subject_id");
        const subjectVersion = finiteInteger(args.subject_version, "subject_version", 1);
        this.store.get(subjectType, subjectId, subjectVersion);
        let harness;
        if (args.harness_configuration_id !== undefined) {
            harness = this.store.get("harness_configuration", text(args.harness_configuration_id, "harness_configuration_id"), args.harness_configuration_version === undefined ? undefined
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
    trialTraceAppend(args) {
        const trialId = text(args.trial_id, "trial_id");
        this.store.get("trial", trialId);
        const artifactIds = array(args.artifact_ids ?? [], "artifact_ids").map((value) => text(value, "artifact_id"));
        const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
        for (const artifactId of artifactIds)
            this.store.get("artifact", artifactId);
        for (const evidenceId of evidenceIds)
            this.store.get("evidence", evidenceId);
        return this.store.appendEvent(`trial:${trialId}`, text(args.event_type, "event_type"), {
            trial_id: trialId, source: args.source ?? "agent_reported",
            data: object(args.data ?? {}, "data"), artifact_ids: artifactIds, evidence_ids: evidenceIds,
        });
    }
    outcomeRecord(args) {
        const trialId = text(args.trial_id, "trial_id");
        this.store.get("trial", trialId);
        const verdict = String(args.verdict);
        if (!TRIAL_VERDICTS.has(verdict))
            throw new Error(`Unsupported trial verdict: ${verdict}`);
        const evidenceIds = array(args.evidence_ids ?? [], "evidence_ids").map((value) => text(value, "evidence_id"));
        for (const evidenceId of evidenceIds)
            this.store.get("evidence", evidenceId);
        return this.store.create("outcome", `outcome_${trialId}`, {
            trial_id: trialId, verdict, summary: text(args.summary, "summary"),
            scores: object(args.scores ?? {}, "scores"), costs: object(args.costs ?? {}, "costs"),
            evidence_ids: evidenceIds, source: args.source ?? "program_verified",
        });
    }
    trialGet(args) {
        const trialId = text(args.trial_id, "trial_id");
        const trial = this.store.get("trial", trialId);
        const outcome = this.store.find("outcome", `outcome_${trialId}`);
        return { trial, trace: this.store.events(`trial:${trialId}`), outcome };
    }
    evaluationRunRecord(args) {
        const suite = this.store.get("evaluation_suite", text(args.suite_id, "suite_id"), args.suite_version === undefined ? undefined : finiteInteger(args.suite_version, "suite_version", 1));
        const split = String(args.split);
        if (!EVAL_SPLITS.has(split))
            throw new Error(`Unsupported evaluation split: ${split}`);
        const subjectType = text(args.subject_type, "subject_type");
        const subjectId = text(args.subject_id, "subject_id");
        const subjectVersion = finiteInteger(args.subject_version, "subject_version", 1);
        this.store.get(subjectType, subjectId, subjectVersion);
        const trialIds = array(args.trial_ids, "trial_ids").map((value) => text(value, "trial_id"));
        if (!trialIds.length || new Set(trialIds).size !== trialIds.length) {
            throw new Error("trial_ids must contain unique trials");
        }
        const cases = array(suite.cases ?? [], "suite cases");
        const allowedCases = new Set(cases.filter((item) => item.split === split).map((item) => String(item.case_id)));
        const outcomes = trialIds.map((trialId) => {
            const trial = this.store.get("trial", trialId);
            if (trial.subject_type !== subjectType || trial.subject_id !== subjectId ||
                Number(trial.subject_version) !== subjectVersion)
                throw new Error(`Trial subject mismatch: ${trialId}`);
            if (!trial.case_id || !allowedCases.has(String(trial.case_id))) {
                throw new Error(`Trial case is not in the ${split} suite partition: ${trialId}`);
            }
            const outcome = this.store.find("outcome", `outcome_${trialId}`);
            if (!outcome)
                throw new Error(`Trial has no outcome: ${trialId}`);
            return outcome;
        });
        const verdict = outcomes.every((outcome) => outcome.verdict === "passed") ? "passed" : "failed";
        return this.store.create("evaluation_run", String(args.run_id ?? id("evalrun")), {
            suite_id: suite.id, suite_version: suite.version, split, subject_type: subjectType,
            subject_id: subjectId, subject_version: subjectVersion, trial_ids: trialIds, verdict,
            metrics: object(args.metrics ?? {}, "metrics"),
        });
    }
    workflowSave(args) {
        return this.saveVersioned("workflow", "workflow", { ...args, lifecycle: "draft" }, ["name"]);
    }
    workflowTransition(args) {
        const workflow = this.store.get("workflow", text(args.workflow_id, "workflow_id"));
        const current = String(workflow.lifecycle ?? "draft");
        const target = text(args.target, "target");
        if (!WORKFLOW_LIFECYCLE.has(target))
            throw new Error(`Unsupported workflow lifecycle: ${target}`);
        const allowed = {
            draft: ["candidate", "deprecated"], candidate: ["verified", "deprecated"],
            verified: ["deprecated"], deprecated: [],
        };
        if (!allowed[current]?.includes(target))
            throw new Error(`Invalid workflow transition: ${current} -> ${target}`);
        let evaluationRunId = null;
        if (target === "verified") {
            evaluationRunId = text(args.evaluation_run_id, "evaluation_run_id");
            const run = this.store.get("evaluation_run", evaluationRunId);
            if (run.verdict !== "passed" || run.split !== "held_out" || run.subject_type !== "workflow" ||
                run.subject_id !== workflow.id || Number(run.subject_version) !== Number(workflow.version)) {
                throw new Error("Verification requires a passed held-out evaluation for this exact workflow version");
            }
        }
        return this.store.save("workflow", String(workflow.id), { ...recordPayload(workflow), lifecycle: target,
            previous_version: workflow.version, transition_reason: text(args.reason, "reason"),
            evaluation_run_id: evaluationRunId });
    }
    workflowRollback(args) {
        const workflowId = text(args.workflow_id, "workflow_id");
        const current = this.store.get("workflow", workflowId);
        const target = this.store.get("workflow", workflowId, finiteInteger(args.target_version, "target_version", 1));
        if (target.lifecycle !== "verified")
            throw new Error("Rollback target must be a verified workflow version");
        return this.store.save("workflow", workflowId, { ...recordPayload(target), lifecycle: "verified",
            rollback_from_version: current.version, rollback_to_version: target.version,
            rollback_reason: text(args.reason, "reason") });
    }
    workflowPlan(args) {
        const workflow = this.get("workflow", "workflow_id", args);
        const definitions = array(workflow.inputs ?? [], "workflow inputs");
        if (typeof (args.inputs ?? {}) !== "object" || Array.isArray(args.inputs)) {
            throw new Error("inputs must be an object");
        }
        const inputs = resolveInputs(definitions, (args.inputs ?? {}));
        const stepDefinitions = array(workflow.steps ?? [], "workflow steps");
        const steps = normalizeSteps(substitute(stepDefinitions, inputs));
        const allowExecution = optionalBoolean(args.allow_execution, "allow_execution") ?? false;
        const sideEffects = array(args.approved_side_effects ?? [], "approved_side_effects");
        const approved = approvedEffects(allowExecution, sideEffects);
        return { workflow_id: workflow.id, workflow_version: workflow.version, inputs, steps,
            approved_side_effects: [...approved], executable: steps.every((step) => approved.has(String(step.side_effect))) };
    }
    workflowRun(args) {
        const plan = this.workflowPlan(args);
        const root = text(args.project_root, "project_root");
        const results = executeSteps(plan.steps, root, new Set(plan.approved_side_effects));
        const passed = results.length === plan.steps.length && results.every((item) => item.passed);
        return this.store.save("workflow_run", id("run"), { workflow_id: plan.workflow_id,
            workflow_version: plan.workflow_version, project_root: root, inputs: plan.inputs, results,
            status: passed ? "passed" : "failed" });
    }
    workflowTrialRun(args) {
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
        let run;
        try {
            run = this.workflowRun({ ...args, version: plan.workflow_version });
        }
        catch {
            const evidence = this.evidenceRecord({ source_type: "program", confidence: "confirmed",
                claim: "Workflow execution crashed before a durable run receipt was produced.",
                locator: { workflow_id: plan.workflow_id, workflow_version: plan.workflow_version } });
            this.trialTraceAppend({ trial_id: trialId, event_type: "workflow.crashed", source: "program_verified",
                data: { error_type: "ExecutionError" }, evidence_ids: [evidence.id] });
            this.outcomeRecord({ trial_id: trialId, verdict: "failed",
                summary: "Workflow execution crashed before completion.", scores: {}, costs: {},
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
        const results = run.results;
        this.outcomeRecord({ trial_id: trialId, verdict: passed ? "passed" : "failed",
            summary: passed ? "Workflow passed deterministic checks." : "Workflow failed deterministic checks.",
            scores: { passed_steps: results.filter((item) => item.passed).length, total_steps: results.length },
            costs: {}, evidence_ids: [evidence.id], source: "program_verified" });
        return { workflow_run: run, artifact, evidence, ...this.trialGet({ trial_id: trialId }) };
    }
    orchestrationCreate(args) {
        const nodes = normalizeNodes((args.nodes ?? []));
        const max = Number(args.max_concurrency ?? 4);
        if (!Number.isInteger(max) || max < 1 || max > 32)
            throw new Error("max_concurrency must be between 1 and 32");
        return this.store.save("orchestration_plan", id("plan"), { goal: text(args.goal, "goal"),
            task_id: args.task_id ?? null, max_concurrency: max, status: "running", nodes, policy: args.policy ?? {} });
    }
    orchestrationDispatch(args) {
        const plan = this.get("orchestration_plan", "plan_id", args);
        if (plan.status !== "running")
            throw new Error(`Plan is not running: ${plan.status}`);
        const owner = text(args.claimed_by, "claimed_by");
        const maximum = finiteInteger(plan.max_concurrency, "plan max_concurrency", 4, 1, 32);
        const requested = finiteInteger(args.capacity, "capacity", maximum, 1);
        const capacity = Math.min(requested, maximum);
        const result = dispatchNodes(plan.nodes, capacity, owner);
        const saved = this.store.updateIfVersion("orchestration_plan", String(plan.id), Number(plan.version), { ...plan, nodes: result.nodes,
            status: planStatus(result.nodes) });
        return { plan: saved, leases: result.leases };
    }
    orchestrationSubmit(args) {
        const plan = this.get("orchestration_plan", "plan_id", args);
        if (args.claimed_by !== undefined) {
            const leased = plan.nodes.find((node) => node.lease_id === args.lease_id);
            if (leased && leased.claimed_by !== text(args.claimed_by, "claimed_by"))
                throw new Error("Lease owner does not match");
        }
        const nodes = submitNode(plan.nodes, text(args.lease_id, "lease_id"), text(args.verdict, "verdict"), String(args.provenance ?? "agent_reported"));
        return this.store.updateIfVersion("orchestration_plan", String(plan.id), Number(plan.version), { ...plan, nodes, status: planStatus(nodes) });
    }
}
//# sourceMappingURL=service.js.map