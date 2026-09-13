import { createHash, randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
function id(prefix) { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function entries(value, name) { if (value === undefined)
    return []; if (!Array.isArray(value))
    throw new Error(`${name} must be an array`); return value.map((item) => { if (!item || typeof item !== "object" || Array.isArray(item))
    throw new Error(`${name} must contain objects`); return item; }); }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function noSecret(value, name) { if (/(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*[^\s]+/iu.test(value))
    throw new Error(`${name} must not contain sensitive assignments`); return value; }
/** A user-readable goal/material/decision state; it never starts a Host itself. */
export class GuidedWorkKernel {
    store;
    constructor(store) { this.store = store; }
    create(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const materials = entries(args.materials, "materials").map((item) => ({ kind: text(item.kind, "materials.kind"), label: noSecret(text(item.label, "materials.label"), "materials.label"), reference: noSecret(text(item.reference, "materials.reference"), "materials.reference") }));
        const decisions = entries(args.decisions, "decisions").map((item) => ({ id: text(item.id, "decisions.id"), question: noSecret(text(item.question, "decisions.question"), "decisions.question"), required: item.required === undefined ? true : item.required, answer: null }));
        if (materials.some((item) => !new Set(["file", "url", "note", "artifact"]).has(String(item.kind))) || decisions.some((item) => typeof item.required !== "boolean") || new Set(decisions.map((item) => String(item.id))).size !== decisions.length)
            throw new Error("Guided work materials or decisions are unsupported");
        const briefId = String(args.brief_id ?? id("guided_work"));
        const identity = { task_id: task.id, materials, decisions: decisions.map(({ answer: _answer, ...item }) => item) };
        const existing = this.store.find("guided_work_brief", briefId);
        if (existing) {
            if (existing.identity_digest !== digest(identity))
                throw new Error("Guided work brief idempotency conflict");
            return { brief: existing, task, idempotent: true };
        }
        const status = decisions.some((item) => item.required) ? "awaiting_decisions" : "ready_to_launch";
        const brief = this.store.create("guided_work_brief", briefId, { ...identity, identity_digest: digest(identity), status, launch_id: null, execution_authority: false });
        return { brief, task, idempotent: false };
    }
    decide(args) {
        const brief = this.store.get("guided_work_brief", text(args.brief_id, "brief_id"));
        if (brief.status !== "awaiting_decisions")
            throw new Error("Guided work brief is not awaiting decisions");
        const decisionId = text(args.decision_id, "decision_id");
        const answer = noSecret(text(args.answer, "answer"), "answer");
        const actor = text(args.actor, "actor");
        const decisions = entries(brief.decisions, "brief.decisions").map((item) => ({ ...item }));
        const decision = decisions.find((item) => item.id === decisionId);
        if (!decision)
            throw new Error("Guided work decision is unknown");
        if (decision.answer !== null && decision.answer !== undefined)
            throw new Error("Guided work decision is already answered");
        decision.answer = { actor, answer_digest: digest(answer), decided_at: new Date().toISOString() };
        const status = decisions.some((item) => item.required && (item.answer === null || item.answer === undefined)) ? "awaiting_decisions" : "ready_to_launch";
        return { brief: this.store.save("guided_work_brief", String(brief.id), { ...payload(brief), decisions, status }) };
    }
    bindLaunch(args) {
        const brief = this.store.get("guided_work_brief", text(args.brief_id, "brief_id"));
        const launch = this.store.get("work_launch", text(args.launch_id, "launch_id"));
        if (launch.task_id !== brief.task_id)
            throw new Error("Guided work launch does not belong to the brief task");
        if (brief.launch_id !== null && brief.launch_id !== undefined && brief.launch_id !== launch.id)
            throw new Error("Guided work brief is already bound to another launch");
        if (brief.launch_id === launch.id)
            return { brief, launch, idempotent: true };
        if (brief.status !== "ready_to_launch")
            throw new Error("Guided work brief requires all decisions before launch");
        return { brief: this.store.save("guided_work_brief", String(brief.id), { ...payload(brief), status: "launched", launch_id: launch.id }), launch, idempotent: false };
    }
    get(args) { const brief = this.store.get("guided_work_brief", text(args.brief_id, "brief_id"), args.version === undefined ? undefined : Number(args.version)); return { brief, task: this.store.get("task", String(brief.task_id)), launch: brief.launch_id === null || brief.launch_id === undefined ? null : this.store.get("work_launch", String(brief.launch_id)) }; }
}
//# sourceMappingURL=guided-work.js.map