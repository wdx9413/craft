import { createHash, randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/iu;
function id(value, name, prefix) {
    const result = value === undefined ? `${prefix}_${randomUUID().replaceAll("-", "")}` : String(value).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(result))
        throw new Error(`${name} must contain only letters, numbers, _ or -`);
    return result;
}
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    if (SECRET.test(value))
        throw new Error(`${name} must not contain sensitive assignments`);
    return value.trim();
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
function render(name, operations) {
    return `export type CraftScriptOperation =\n  | { readonly operation_id: string; readonly kind: "workflow"; readonly workflow_id: string; readonly workflow_version: number; readonly inputs: Record<string, unknown> }\n  | { readonly operation_id: string; readonly kind: "checkpoint"; readonly label: string };\n\nexport const ${name.replace(/[^a-zA-Z0-9_]/g, "_")} = ${JSON.stringify(operations, null, 2)} as const satisfies readonly CraftScriptOperation[];\n`;
}
export class TrajectoryCompiler {
    store;
    constructor(store) { this.store = store; }
    compile(args) {
        const taskId = id(args.task_id, "task_id", "task");
        this.store.get("task", taskId);
        const trialIds = this.trialIds(args.trial_ids, taskId);
        const operations = this.operations(args.operations);
        const name = text(args.name, "name");
        const typescript = render(name, operations);
        const proposal = this.store.create("trajectory_script_proposal", id(args.proposal_id, "proposal_id", "trajectory_script"), {
            task_id: taskId, name, trial_ids: trialIds, operations, typescript,
            source_digest: createHash("sha256").update(JSON.stringify({ trialIds, operations })).digest("hex"),
            static_checks: { deterministic_template: true, imports: false, dynamic_execution: false }, lifecycle: "draft"
        });
        return { proposal };
    }
    authorize(args) {
        const proposal = this.store.get("trajectory_script_proposal", id(args.proposal_id, "proposal_id", "trajectory_script"));
        if (proposal.lifecycle !== "draft")
            throw new Error("trajectory script proposal is not a draft");
        const signoff = this.store.get("signoff", id(args.signoff_id, "signoff_id", "signoff"));
        if (signoff.decision !== "passed" || signoff.subject_type !== "trajectory_script_proposal" || signoff.subject_id !== proposal.id ||
            Number(signoff.subject_version) !== Number(proposal.version))
            throw new Error("trajectory script proposal requires an exact passed Signoff");
        const saved = this.store.save("trajectory_script_proposal", String(proposal.id), { ...recordPayload(proposal), lifecycle: "verified", signoff_id: signoff.id });
        return { proposal: saved };
    }
    trialIds(value, taskId) {
        if (!Array.isArray(value) || !value.length)
            throw new Error("trial_ids must contain at least one passed trial");
        const trialIds = value.map((item) => id(item, "trial_id", "trial"));
        if (new Set(trialIds).size !== trialIds.length)
            throw new Error("trial_ids must be unique");
        for (const trialId of trialIds) {
            const trial = this.store.get("trial", trialId);
            const outcome = this.store.find("outcome", `outcome_${trialId}`);
            if (trial.task_id !== taskId || outcome?.verdict !== "passed")
                throw new Error("trajectory source trial requires a passed Outcome for the same task");
        }
        return trialIds;
    }
    operations(value) {
        if (!Array.isArray(value) || !value.length)
            throw new Error("operations must contain at least one operation");
        const operations = value.map((raw, index) => {
            const operation = object(raw, `operations[${index}]`);
            const operation_id = id(operation.operation_id, `operations[${index}].operation_id`, "operation");
            const kind = text(operation.kind, `operations[${index}].kind`);
            if (kind === "checkpoint")
                return { operation_id, kind, label: text(operation.label, `operations[${index}].label`) };
            if (kind !== "workflow")
                throw new Error("trajectory script operation kind is unsupported");
            const workflow_id = id(operation.workflow_id, `operations[${index}].workflow_id`, "workflow");
            const workflow_version = Number(operation.workflow_version ?? 1);
            if (!Number.isInteger(workflow_version) || workflow_version < 1)
                throw new Error("workflow_version must be a positive integer");
            this.store.get("workflow", workflow_id, workflow_version);
            return { operation_id, kind: "workflow", workflow_id, workflow_version, inputs: object(operation.inputs ?? {}, `operations[${index}].inputs`) };
        });
        if (new Set(operations.map((operation) => operation.operation_id)).size !== operations.length)
            throw new Error("operation_id values must be unique");
        return operations;
    }
}
//# sourceMappingURL=trajectory.js.map