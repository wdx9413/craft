import { createHash, randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
const RESULTS = new Set(["succeeded", "failed", "indeterminate"]);
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    return value;
}
function strings(value, name) {
    if (!Array.isArray(value) || !value.length)
        throw new Error(`${name} must be a non-empty array`);
    const result = value.map((item) => text(item, name));
    if (new Set(result).size !== result.length)
        throw new Error(`${name} must contain unique values`);
    return result;
}
function statusCodes(value, name) {
    if (!Array.isArray(value) || !value.length)
        throw new Error(`${name} must be a non-empty array`);
    const result = value.map((item) => Number(item));
    if (result.some((item) => !Number.isInteger(item) || item < 100 || item > 599))
        throw new Error(`${name} must contain HTTP status codes`);
    if (new Set(result).size !== result.length)
        throw new Error(`${name} must contain unique values`);
    return result;
}
function payload(record) {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
    return rest;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function generated(prefix) { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
export class ExternalEffectKernel {
    store;
    constructor(store) { this.store = store; }
    prepare(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const effect = text(args.effect, "effect");
        if (!new Set(["external_write", "destructive"]).has(effect))
            throw new Error("External effect must be external_write or destructive");
        const idempotencyKey = text(args.idempotency_key, "idempotency_key");
        if (!/^[a-zA-Z0-9._:-]{8,200}$/u.test(idempotencyKey))
            throw new Error("idempotency_key must be stable and 8-200 safe characters");
        const compensation = args.compensation === undefined ? null : object(args.compensation, "compensation");
        if (compensation && (!compensation.action || !compensation.request_digest))
            throw new Error("compensation requires action and request_digest");
        const operation = this.store.create("external_effect", String(args.effect_id ?? generated("effect")), {
            task_id: task.id, trial_id: args.trial_id ?? null, provider: text(args.provider, "provider"),
            action: text(args.action, "action"), target: text(args.target, "target"), effect,
            request_digest: text(args.request_digest, "request_digest"), idempotency_key: idempotencyKey,
            approval_ref: text(args.approval_ref, "approval_ref"), compensation, status: "prepared",
            remote_operation_id: null, evidence_ids: [], attempt: 0
        });
        return { effect: operation };
    }
    start(args) {
        const plan = this.startPlan(args);
        if (plan.idempotent)
            return { effect: plan.operation, idempotent: true };
        const started = this.store.updateIfVersion("external_effect", String(plan.operation.id), Number(plan.operation.version), plan.payload);
        return { effect: started, dispatch: plan.dispatch, idempotent: false };
    }
    startPlan(args) {
        const operation = this.store.get("external_effect", text(args.effect_id, "effect_id"));
        if (operation.status === "executing")
            return { operation, payload: payload(operation), dispatch: {}, idempotent: true };
        if (operation.status !== "prepared")
            throw new Error("Only a prepared external effect can start");
        if (text(args.approval_ref, "approval_ref") !== operation.approval_ref)
            throw new Error("External effect approval does not match");
        const next = {
            ...payload(operation), status: "executing", attempt: Number(operation.attempt) + 1,
            started_at: new Date().toISOString()
        };
        return { operation, payload: next, dispatch: { provider: operation.provider, action: operation.action, target: operation.target,
                request_digest: operation.request_digest, idempotency_key: operation.idempotency_key }, idempotent: false };
    }
    report(args) {
        const operation = this.store.get("external_effect", text(args.effect_id, "effect_id"));
        const receiptId = text(args.receipt_id, "receipt_id");
        const status = text(args.status, "status");
        if (!RESULTS.has(status))
            throw new Error("External effect result is unsupported");
        const evidenceIds = strings(args.evidence_ids, "evidence_ids");
        for (const evidenceId of evidenceIds)
            this.store.get("evidence", evidenceId);
        const fingerprint = digest({ effect_id: operation.id, status, remote_operation_id: args.remote_operation_id ?? null,
            evidence_ids: evidenceIds, response_digest: args.response_digest ?? null });
        const existing = this.store.find("external_effect_receipt", receiptId);
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw new Error("External effect receipt idempotency conflict");
            return { effect: operation, receipt: existing, idempotent: true };
        }
        if (operation.status !== "executing")
            throw new Error("External effect is not executing");
        if (status === "succeeded" && !args.remote_operation_id)
            throw new Error("Successful external effects require a remote_operation_id");
        const receipt = this.store.create("external_effect_receipt", receiptId, { effect_id: operation.id, task_id: operation.task_id,
            status, remote_operation_id: args.remote_operation_id ?? null, response_digest: args.response_digest ?? null,
            evidence_ids: evidenceIds, fingerprint });
        const updated = this.store.updateIfVersion("external_effect", String(operation.id), Number(operation.version), {
            ...payload(operation), status, remote_operation_id: receipt.remote_operation_id,
            response_digest: receipt.response_digest, evidence_ids: evidenceIds, receipt_id: receipt.id,
            finished_at: new Date().toISOString()
        });
        return { effect: updated, receipt, idempotent: false };
    }
    resolve(args) {
        const operation = this.store.get("external_effect", text(args.effect_id, "effect_id"));
        if (operation.status !== "indeterminate")
            throw new Error("Only an indeterminate external effect can be resolved");
        if (args.resolver_type !== "human")
            throw new Error("Indeterminate external effects require a human resolver");
        const resolution = text(args.resolution, "resolution");
        if (!new Set(["succeeded", "failed"]).has(resolution))
            throw new Error("resolution must be succeeded or failed");
        const evidenceIds = strings(args.evidence_ids, "evidence_ids");
        for (const evidenceId of evidenceIds)
            this.store.get("evidence", evidenceId);
        if (resolution === "succeeded" && !args.remote_operation_id && !operation.remote_operation_id) {
            throw new Error("A successful resolution requires a remote_operation_id");
        }
        const updated = this.store.updateIfVersion("external_effect", String(operation.id), Number(operation.version), {
            ...payload(operation), status: resolution, remote_operation_id: args.remote_operation_id ?? operation.remote_operation_id,
            evidence_ids: [...new Set([...operation.evidence_ids, ...evidenceIds])],
            resolution_approval_ref: text(args.approval_ref, "approval_ref"), resolver_type: "human",
            resolved_at: new Date().toISOString()
        });
        return { effect: updated };
    }
    reconcileIssue(args) {
        const operation = this.store.get("external_effect", text(args.effect_id, "effect_id"));
        const authorization = this.store.get("egress_authorization", text(args.authorization_id, "authorization_id"));
        const succeeded = statusCodes(args.succeeded_http_statuses, "succeeded_http_statuses");
        const failed = statusCodes(args.failed_http_statuses, "failed_http_statuses");
        if (succeeded.some((code) => failed.includes(code)))
            throw new Error("Reconciliation HTTP status mappings must not overlap");
        const reconciliationId = String(args.reconciliation_id ?? generated("reconciliation"));
        const fingerprint = digest({ effect_id: operation.id, authorization_id: authorization.id,
            succeeded_http_statuses: succeeded, failed_http_statuses: failed });
        const existing = this.store.find("effect_reconciliation", reconciliationId);
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw new Error("Effect reconciliation idempotency conflict");
            return { effect: operation, reconciliation: existing, idempotent: true };
        }
        if (operation.status !== "indeterminate")
            throw new Error("Only an indeterminate external effect can be reconciled");
        if (authorization.task_id !== operation.task_id || authorization.status !== "authorized") {
            throw new Error("Reconciliation requires an executable same-task egress authorization");
        }
        const reconciliation = this.store.create("effect_reconciliation", reconciliationId, {
            effect_id: operation.id, task_id: operation.task_id, authorization_id: authorization.id,
            method: "GET", succeeded_http_statuses: succeeded, failed_http_statuses: failed, fingerprint, status: "executing"
        });
        return { effect: operation, reconciliation, idempotent: false };
    }
    reconcileReport(args) {
        const reconciliation = this.store.get("effect_reconciliation", text(args.reconciliation_id, "reconciliation_id"));
        if (reconciliation.status !== "executing")
            throw new Error("Reconciliation is not executing");
        const execution = this.store.get("egress_execution", text(args.execution_id, "execution_id"));
        if (execution.authorization_id !== reconciliation.authorization_id || execution.status !== "completed" || !execution.evidence_id) {
            throw new Error("Reconciliation requires the completed authorized egress execution");
        }
        const httpStatus = Number(execution.http_status);
        const result = reconciliation.succeeded_http_statuses.includes(httpStatus) ? "succeeded"
            : reconciliation.failed_http_statuses.includes(httpStatus) ? "failed" : "indeterminate";
        const finished = this.store.updateIfVersion("effect_reconciliation", String(reconciliation.id), Number(reconciliation.version), {
            ...payload(reconciliation), status: result, execution_id: execution.id, evidence_id: execution.evidence_id,
            observed_http_status: httpStatus, finished_at: new Date().toISOString()
        });
        const operation = this.store.get("external_effect", String(reconciliation.effect_id));
        if (result === "indeterminate")
            return { effect: operation, reconciliation: finished };
        const updated = this.store.updateIfVersion("external_effect", String(operation.id), Number(operation.version), {
            ...payload(operation), status: result,
            evidence_ids: [...new Set([...operation.evidence_ids, String(execution.evidence_id)])],
            reconciled_by: reconciliation.id, reconciled_at: new Date().toISOString()
        });
        return { effect: updated, reconciliation: finished };
    }
    reconcileFail(args) {
        const reconciliation = this.store.get("effect_reconciliation", text(args.reconciliation_id, "reconciliation_id"));
        if (reconciliation.status !== "executing")
            return { reconciliation };
        return { reconciliation: this.store.updateIfVersion("effect_reconciliation", String(reconciliation.id), Number(reconciliation.version), {
                ...payload(reconciliation), status: "indeterminate", error_class: text(args.error_class, "error_class"),
                finished_at: new Date().toISOString()
            }) };
    }
    compensateIssue(args) {
        const operation = this.store.get("external_effect", text(args.effect_id, "effect_id"));
        const compensation = operation.compensation;
        const compensationId = String(args.compensation_id ?? generated("compensation"));
        const authorization = args.authorization_id === undefined ? null
            : this.store.get("egress_authorization", text(args.authorization_id, "authorization_id"));
        const succeeded = authorization ? statusCodes(args.succeeded_http_statuses, "succeeded_http_statuses") : [];
        const failed = authorization ? statusCodes(args.failed_http_statuses, "failed_http_statuses") : [];
        if (succeeded.some((code) => failed.includes(code)))
            throw new Error("Compensation HTTP status mappings must not overlap");
        const approvalRef = text(args.approval_ref, "approval_ref");
        const fingerprint = digest({ effect_id: operation.id, authorization_id: authorization?.id ?? null, approval_ref: approvalRef,
            succeeded_http_statuses: succeeded, failed_http_statuses: failed });
        const existing = this.store.find("effect_compensation", compensationId);
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw new Error("Effect compensation idempotency conflict");
            return { effect: operation, compensation: existing, idempotent: true };
        }
        if (operation.status !== "succeeded" || !operation.compensation)
            throw new Error("Only a succeeded compensatable effect can be compensated");
        if (authorization && (authorization.task_id !== operation.task_id || authorization.status !== "authorized" ||
            authorization.action !== compensation.action || authorization.request_digest !== compensation.request_digest)) {
            throw new Error("Compensation requires an exact executable same-task egress authorization");
        }
        const issued = this.store.create("effect_compensation", compensationId, {
            effect_id: operation.id, task_id: operation.task_id, remote_operation_id: operation.remote_operation_id,
            action: text(compensation.action, "compensation.action"), request_digest: text(compensation.request_digest, "compensation.request_digest"),
            idempotency_key: `${operation.idempotency_key}:compensate`, approval_ref: approvalRef,
            authorization_id: authorization?.id ?? null, succeeded_http_statuses: succeeded, failed_http_statuses: failed,
            fingerprint, status: "executing"
        });
        const updated = this.store.updateIfVersion("external_effect", String(operation.id), Number(operation.version), {
            ...payload(operation), status: "compensating", compensation_id: issued.id
        });
        return { effect: updated, compensation: issued, dispatch: { action: issued.action, request_digest: issued.request_digest,
                idempotency_key: issued.idempotency_key, remote_operation_id: issued.remote_operation_id }, idempotent: false };
    }
    compensateFromExecution(args) {
        const compensation = this.store.get("effect_compensation", text(args.compensation_id, "compensation_id"));
        const execution = this.store.get("egress_execution", text(args.execution_id, "execution_id"));
        if (!compensation.authorization_id || execution.authorization_id !== compensation.authorization_id ||
            execution.status !== "completed" || !execution.evidence_id)
            throw new Error("Compensation requires its completed authorized egress execution");
        const succeeded = compensation.succeeded_http_statuses;
        const failed = compensation.failed_http_statuses;
        const httpStatus = Number(execution.http_status);
        const status = succeeded.includes(httpStatus) ? "succeeded"
            : failed.includes(httpStatus) ? "failed" : "indeterminate";
        return this.compensateReport({ compensation_id: compensation.id, status, evidence_ids: [execution.evidence_id],
            response_digest: execution.response_digest });
    }
    compensateCancel(args) {
        const compensation = this.store.get("effect_compensation", text(args.compensation_id, "compensation_id"));
        if (compensation.status !== "executing")
            return { compensation };
        const cancelled = this.store.updateIfVersion("effect_compensation", String(compensation.id), Number(compensation.version), {
            ...payload(compensation), status: "cancelled", error_class: text(args.error_class, "error_class"),
            finished_at: new Date().toISOString()
        });
        const operation = this.store.get("external_effect", String(compensation.effect_id));
        const effect = this.store.updateIfVersion("external_effect", String(operation.id), Number(operation.version), {
            ...payload(operation), status: "succeeded", compensation_id: null
        });
        return { effect, compensation: cancelled };
    }
    compensateReport(args) {
        const compensation = this.store.get("effect_compensation", text(args.compensation_id, "compensation_id"));
        if (compensation.status !== "executing")
            throw new Error("Compensation is not executing");
        const status = text(args.status, "status");
        if (!RESULTS.has(status))
            throw new Error("Compensation result is unsupported");
        const evidenceIds = strings(args.evidence_ids, "evidence_ids");
        for (const evidenceId of evidenceIds)
            this.store.get("evidence", evidenceId);
        const updatedCompensation = this.store.updateIfVersion("effect_compensation", String(compensation.id), Number(compensation.version), {
            ...payload(compensation), status, evidence_ids: evidenceIds, response_digest: args.response_digest ?? null,
            finished_at: new Date().toISOString()
        });
        const operation = this.store.get("external_effect", String(compensation.effect_id));
        const effectStatus = status === "succeeded" ? "compensated" : status === "failed" ? "compensation_failed" : "compensation_indeterminate";
        const updatedEffect = this.store.updateIfVersion("external_effect", String(operation.id), Number(operation.version), {
            ...payload(operation), status: effectStatus, compensation_evidence_ids: evidenceIds
        });
        return { effect: updatedEffect, compensation: updatedCompensation };
    }
    sagaCreate(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const effectIds = strings(args.effect_ids, "effect_ids");
        const effects = effectIds.map((effectId) => this.store.get("external_effect", effectId));
        if (effects.some((effect) => effect.task_id !== task.id))
            throw new Error("Every Saga effect must belong to the same task");
        const saga = this.store.create("effect_saga", String(args.saga_id ?? generated("saga")), {
            task_id: task.id, trial_id: args.trial_id ?? null, effect_ids: effectIds, status: "active"
        });
        return { saga, ...this.sagaState(saga, effects) };
    }
    sagaGet(args) {
        const saga = this.store.get("effect_saga", text(args.saga_id, "saga_id"));
        return { saga, ...this.sagaState(saga, saga.effect_ids.map((id) => this.store.get("external_effect", id))) };
    }
    sagaState(saga, effects) {
        const failure = effects.find((effect) => ["failed", "indeterminate", "compensation_failed", "compensation_indeterminate"].includes(String(effect.status)));
        const compensationRequired = failure ? effects.filter((effect) => effect.status === "succeeded" && effect.compensation).reverse().map((effect) => effect.id) : [];
        const next = failure ? compensationRequired.length ? { kind: "compensate", effect_id: compensationRequired[0] }
            : { kind: "resolve_or_stop", effect_id: failure.id } : effects.find((effect) => effect.status === "prepared")
            ? { kind: "execute", effect_id: effects.find((effect) => effect.status === "prepared")?.id }
            : effects.every((effect) => ["succeeded", "compensated"].includes(String(effect.status))) ? { kind: "complete" }
                : { kind: "wait" };
        return { effects, next_action: next, compensation_order: compensationRequired,
            derived_status: next.kind === "complete" ? "completed" : failure ? "recovering" : "active", saga_id: saga.id };
    }
}
//# sourceMappingURL=effects.js.map