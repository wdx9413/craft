import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { normalizeSteps } from "./workflow.js";
/**
 * Deterministic workflows are the carrier Craft hands work to, so they live as
 * files first and as records second. A workflow file is the editable source of
 * truth; the registry only discovers, validates, diffs, and advises.
 *
 * Nothing here executes a workflow, and nothing here deletes one: retirement is
 * a recommendation a human confirms, because an unused workflow is not
 * automatically a bad one.
 */
export const WORKFLOW_FILE_SUFFIX = ".workflow.json";
const WORKFLOW_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const STATUSES = ["active", "deprecated", "retired"];
const MAX_FILES = 500;
export const DEFAULT_RETIREMENT_POLICY = { min_uses: 5, stale_days: 90, min_success_rate: 0.5 };
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function recordDigest(value) {
    return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function optionalText(value, name) {
    return value === undefined || value === null ? null : text(value, name);
}
/**
 * Validate one workflow document. Steps go through the same `normalizeSteps`
 * used at execution time, so a registry-accepted workflow can never be rejected
 * later for a shape reason.
 */
export function normalizeWorkflowDefinition(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Workflow definition must be an object");
    const input = raw;
    const id = text(input.id, "workflow id");
    if (!WORKFLOW_ID.test(id))
        throw new Error(`Unsupported workflow id: ${id}`);
    const version = input.version === undefined ? 1 : Number(input.version);
    if (!Number.isInteger(version) || version < 1)
        throw new Error("Workflow version must be a positive integer");
    const status = optionalText(input.status, "workflow status") ?? "active";
    if (!STATUSES.includes(status))
        throw new Error(`Unsupported workflow status: ${status}`);
    const rawInputs = input.inputs ?? [];
    if (!Array.isArray(rawInputs))
        throw new Error("Workflow inputs must be an array");
    const inputs = rawInputs.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw new Error(`Workflow input at index ${index} must be an object`);
        const name = text(entry.name, `workflow input name at index ${index}`);
        return { ...entry, name };
    });
    const rawSteps = input.steps ?? [];
    if (input.steps !== undefined && !Array.isArray(rawSteps))
        throw new Error("Workflow steps must be an array");
    if (!Array.isArray(rawSteps) || !rawSteps.length)
        throw new Error("Workflow requires at least one step");
    const steps = normalizeSteps(rawSteps);
    return { id, version, title: text(input.title, "workflow title"), domain: optionalText(input.domain, "workflow domain"),
        status, inputs, steps };
}
/** A content-addressed descriptor. The digest is what makes catalog drift visible. */
export function describeWorkflow(path, definition) {
    const steps = definition.steps;
    return { workflow_id: String(definition.id), version: Number(definition.version), title: String(definition.title),
        domain: definition.domain === null || definition.domain === undefined ? null : String(definition.domain),
        status: String(definition.status), step_count: steps.length,
        side_effects: [...new Set(steps.map((step) => String(step.side_effect)))].sort(),
        digest: recordDigest(definition), path: path.replaceAll("\\", "/") };
}
function walk(root, current, found, limit) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = join(current, entry.name);
        const stat = lstatSync(absolute);
        // A symlinked directory could point anywhere, and the registry never follows links.
        if (stat.isSymbolicLink())
            continue;
        if (stat.isDirectory()) {
            walk(root, absolute, found, limit);
            continue;
        }
        if (!entry.name.endsWith(WORKFLOW_FILE_SUFFIX))
            continue;
        found.push(relative(root, absolute).replaceAll("\\", "/"));
        if (found.length > limit)
            throw new Error(`Workflow registry exceeds ${limit} files`);
    }
}
/** Pure filter that decides whether a path is a workflow file (and not a symlink or directory). */
export function isWorkflowFile(name, stat) {
    if (stat.isSymbolicLink())
        return false;
    if (stat.isDirectory())
        return false;
    return name.endsWith(WORKFLOW_FILE_SUFFIX);
}
/**
 * A JSON parse throws a real Error in practice; the non-Error arm exists only so a
 * host that throws a string cannot crash the registry scan. It is exported as a
 * pure function precisely so both arms stay testable without faking JSON.parse.
 */
export function describeJsonFailure(path, error) {
    return `Workflow file is not valid JSON: ${path} (${error instanceof Error ? error.message : String(error)})`;
}
/**
 * Discover every workflow file under one root. A missing root is an error rather
 * than an empty catalog, because "no workflows" and "wrong path" must not look
 * the same to a caller about to plan work.
 */
export function discoverWorkflows(root, options = {}) {
    const base = resolve(root);
    if (!existsSync(base))
        throw new Error("Workflow registry root does not exist");
    const limit = options.limit ?? MAX_FILES;
    if (!Number.isInteger(limit) || limit < 1)
        throw new Error("Workflow registry limit must be a positive integer");
    const found = [];
    walk(base, base, found, limit);
    const descriptors = found.map((path) => {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(join(base, path), "utf8"));
        }
        catch (error) {
            throw new Error(describeJsonFailure(path, error));
        }
        return describeWorkflow(path, normalizeWorkflowDefinition(parsed));
    });
    const keys = descriptors.map((item) => `${item.workflow_id}@${item.version}`);
    if (new Set(keys).size !== keys.length)
        throw new Error("Workflow registry contains a duplicate workflow id and version");
    return descriptors;
}
/** Catalog drift: what is new, what changed, and what disappeared since the last scan. */
export function diffWorkflowCatalog(previous, current) {
    const key = (item) => `${item.workflow_id}@${item.version}`;
    const before = new Map(previous.map((item) => [key(item), item]));
    const after = new Map(current.map((item) => [key(item), item]));
    const added = current.filter((item) => !before.has(key(item)));
    const removed = previous.filter((item) => !after.has(key(item)));
    const changed = current.filter((item) => { const prior = before.get(key(item)); return prior !== undefined && prior.digest !== item.digest; });
    return { added, changed, removed, unchanged: current.length - added.length - changed.length };
}
function resolvePolicy(options) {
    const policy = { ...DEFAULT_RETIREMENT_POLICY, ...(options.policy ?? {}) };
    if (!Number.isInteger(policy.min_uses) || policy.min_uses < 0)
        throw new Error("Retirement min_uses must be a non-negative integer");
    if (!Number.isInteger(policy.stale_days) || policy.stale_days < 1)
        throw new Error("Retirement stale_days must be a positive integer");
    if (!Number.isFinite(policy.min_success_rate) || policy.min_success_rate < 0 || policy.min_success_rate > 1) {
        throw new Error("Retirement min_success_rate must be between 0 and 1");
    }
    return policy;
}
/**
 * Deterministic retirement advice. Craft proposes; a human disposes. Every
 * decision carries its reasons so the recommendation can be argued with.
 */
export function planWorkflowRetirement(usage, options) {
    const policy = resolvePolicy(options);
    const now = Date.parse(text(options.now, "now"));
    if (!Number.isFinite(now))
        throw new Error("Retirement planning requires an ISO now timestamp");
    const windowMs = policy.stale_days * 86_400_000;
    return usage.map((item) => {
        const workflowId = text(item.workflow_id, "workflow_id");
        const uses = Number(item.uses);
        if (!Number.isInteger(uses) || uses < 0)
            throw new Error(`Workflow usage must be a non-negative integer: ${workflowId}`);
        const successes = Number(item.successes);
        if (!Number.isInteger(successes) || successes < 0 || successes > uses)
            throw new Error(`Workflow successes must be between 0 and uses: ${workflowId}`);
        let lastUsed = null;
        if (item.last_used_at !== null) {
            lastUsed = Date.parse(text(item.last_used_at, "last_used_at"));
            if (!Number.isFinite(lastUsed))
                throw new Error(`Workflow last_used_at is not a timestamp: ${workflowId}`);
        }
        const stale = lastUsed === null || now - lastUsed > windowMs;
        const successRate = uses === 0 ? null : successes / uses;
        const reasons = [];
        let recommendation;
        if (uses >= policy.min_uses && successRate !== null && successRate < policy.min_success_rate) {
            recommendation = "retire";
            reasons.push("low_success_rate");
        }
        else if (stale && uses < policy.min_uses) {
            recommendation = "retire";
            reasons.push("never_proven_and_stale");
        }
        else if (stale) {
            recommendation = "deprecate";
            reasons.push("stale");
        }
        else {
            recommendation = "keep";
            reasons.push("in_use");
        }
        return { workflow_id: workflowId, recommendation, reasons, uses, success_rate: successRate, stale };
    }).sort((a, b) => a.workflow_id.localeCompare(b.workflow_id));
}
//# sourceMappingURL=workflow-registry.js.map