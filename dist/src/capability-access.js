import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Catalog } from "./catalog.js";
import { CraftStore } from "./store.js";
import { SIDE_EFFECTS } from "./workflow.js";
const ASSET_TYPES = new Set(["skill", "mcp_server", "tool", "workflow", "adapter", "validator", "grader", "eval_suite"]);
const TRUST_LEVELS = new Set(["trusted", "untrusted", "verified"]);
const HEALTH_STATUSES = new Set(["healthy", "stale", "failed", "unknown"]);
const SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*[^\s]+/iu;
function id(prefix) { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
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
function optionalBoolean(value, name) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "boolean")
        throw new Error(`${name} must be a boolean`);
    return value;
}
function finiteInteger(value, name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return number;
}
function optionalTextArray(value, name, fallback = []) {
    if (value === undefined)
        return fallback;
    const values = array(value, name).map((item) => text(item, name));
    if (new Set(values).size !== values.length)
        throw new Error(`${name} must contain unique values`);
    return values;
}
function uniqueTextArray(value, name) {
    const values = optionalTextArray(value, name);
    if (!values.length)
        throw new Error(`${name} must contain at least 1 unique values`);
    return values;
}
function fingerprint(value) {
    const canonical = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`).join(",");
    return createHash("sha256").update(`{${canonical}}`).digest("hex");
}
function recordPayload(record) {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
    return payload;
}
function assertNoSecret(value, name) {
    if (SECRET_ASSIGNMENT.test(value))
        throw new Error(`${name} must not contain sensitive assignments`);
    return value;
}
function validIsoTime(value, name) {
    const parsed = Date.parse(text(value, name));
    if (Number.isNaN(parsed))
        throw new Error(`${name} must be an ISO timestamp`);
    return parsed;
}
/**
 * Bounded capability lifecycle: local source content stays read-only context,
 * while governed assets are selected, version-pinned, and consumed through a
 * short-lived call receipt. It deliberately does not discover or execute a Host.
 */
export class CapabilityAccessKernel {
    store;
    catalog;
    constructor(store, catalog) {
        this.store = store;
        this.catalog = catalog;
    }
    async logicalActivationPlan(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const query = text(args.query, "query");
        const allowedEffects = uniqueTextArray(args.allowed_effects ?? ["read_only"], "allowed_effects");
        if (allowedEffects.some((effect) => effect !== "read_only"))
            throw new Error("Indexed local capabilities may only be activated as read_only context");
        const profileId = args.context_profile_id === undefined ? null : text(args.context_profile_id, "context_profile_id");
        const profileVersion = args.context_profile_version === undefined ? null : finiteInteger(args.context_profile_version, "context_profile_version", 1);
        if ((profileId === null) !== (profileVersion === null))
            throw new Error("Context profile id and version must be supplied together");
        if (profileId !== null) {
            const profile = this.store.get("context_profile", profileId, profileVersion);
            if (profile.task_id !== null && profile.task_id !== task.id)
                throw new Error("Context profile does not belong to the task");
        }
        const candidates = await this.catalog.searchHybrid(query, finiteInteger(args.limit, "limit", 3, 1, 10));
        const selected = candidates.filter((candidate) => candidate.logical_capability_id !== null).map((candidate) => {
            const logical = this.store.get("logical_capability", String(candidate.logical_capability_id));
            return { logical_capability_id: logical.id, content_digest: logical.content_digest, selected_capability_id: logical.selected_capability_id,
                selected_source_id: logical.selected_source_id, declaration_keys: logical.declaration_keys };
        });
        if (!selected.length)
            throw new Error("No logical capabilities match this task");
        const plan = this.store.create("logical_activation_plan", String(args.plan_id ?? id("logical_activation_plan")), { task_id: task.id, query,
            query_fingerprint: fingerprint({ query }), context_profile_id: profileId, context_profile_version: profileVersion,
            allowed_effects: allowedEffects, selected, status: "active" });
        return { plan, candidates: selected };
    }
    logicalActivationAudit(args) {
        const plan = this.store.get("logical_activation_plan", text(args.plan_id, "plan_id"));
        const findings = plan.selected.map((selected) => {
            const current = this.store.find("logical_capability", String(selected.logical_capability_id));
            const replacement = current ? null : this.store.list("logical_capability", Number.MAX_SAFE_INTEGER).find((logical) => logical.declaration_keys.some((key) => selected.declaration_keys.includes(key))) ?? null;
            const observed = current ?? replacement;
            const status = !current ? replacement ? "content_changed" : "missing" :
                current.selected_capability_id !== selected.selected_capability_id ? "reselected" : "unchanged";
            return { logical_capability_id: selected.logical_capability_id, status, current_content_digest: observed?.content_digest ?? null,
                current_selected_capability_id: observed?.selected_capability_id ?? null, current_selected_source_id: observed?.selected_source_id ?? null };
        });
        const status = findings.some((finding) => finding.status === "missing" || finding.status === "content_changed") ? "stale" : "active";
        const savedPlan = plan.status === status ? plan : this.store.save("logical_activation_plan", String(plan.id), { ...recordPayload(plan), status });
        const audit = this.store.create("logical_activation_audit", String(args.audit_id ?? id("logical_activation_audit")), { plan_id: plan.id,
            plan_version: plan.version, status, findings });
        return { plan: savedPlan, audit };
    }
    async logicalActivationResolve(args) {
        const planId = text(args.plan_id, "plan_id");
        const audited = this.logicalActivationAudit({ plan_id: planId, audit_id: args.audit_id ?? id("logical_activation_audit") });
        const plan = audited.plan;
        const audit = audited.audit;
        if (audit.status !== "active")
            throw new Error("Activation plan is stale and cannot load local capability content");
        const maxChars = finiteInteger(args.max_chars, "max_chars", 16_000, 1, 100_000);
        const capabilities = await Promise.all(plan.selected.map(async (selected) => {
            const logical = this.store.get("logical_capability", String(selected.logical_capability_id));
            const capability = this.store.get("capability", String(logical.selected_capability_id));
            const content = await readFile(text(capability.path, "capability.path"), "utf8");
            const digest = createHash("sha256").update(content).digest("hex");
            if (digest !== selected.content_digest)
                throw new Error("Capability file digest drifted; rescan the source before loading it");
            assertNoSecret(content, "capability content");
            if (content.length > maxChars)
                throw new Error("Capability content exceeds the requested context limit");
            return { logical_capability_id: logical.id, content_digest: digest, selected_capability_id: capability.id,
                selected_source_id: logical.selected_source_id, path: capability.path, name: capability.name,
                description: capability.description, metadata: capability.metadata, content };
        }));
        const resolution = this.store.create("logical_activation_resolution", String(args.resolution_id ?? id("logical_activation_resolution")), {
            plan_id: plan.id, plan_version: plan.version, audit_id: audit.id,
            capabilities: capabilities.map(({ content: _content, ...summary }) => summary), max_chars: maxChars,
        });
        return { plan, audit, resolution, capabilities };
    }
    assetSave(args) {
        const assetType = text(args.asset_type, "asset_type");
        const trust = String(args.trust ?? "untrusted");
        const health = String(args.health ?? "unknown");
        const effect = text(args.effect, "effect");
        if (!ASSET_TYPES.has(assetType) || !TRUST_LEVELS.has(trust) || !HEALTH_STATUSES.has(health) || !SIDE_EFFECTS.has(effect)) {
            throw new Error("Capability asset type, trust, health, or effect is unsupported");
        }
        const sourceUri = assertNoSecret(text(args.source_uri, "source_uri"), "source_uri");
        const dependencies = optionalTextArray(args.dependencies, "dependencies");
        const aliases = optionalTextArray(args.aliases, "aliases");
        return this.saveVersioned("capability_asset", "asset", { ...args, asset_type: assetType, trust, health, effect, source_uri: sourceUri,
            dependencies, aliases, requires_credential: optionalBoolean(args.requires_credential, "requires_credential") ?? false,
            cost_hint: object(args.cost_hint ?? {}, "cost_hint"), source_digest: args.source_digest ?? fingerprint({ source_uri: sourceUri, asset_type: assetType }) }, ["name", "asset_type", "source_uri", "effect"]);
    }
    accessPlan(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const goal = text(args.goal, "goal");
        const allowedEffects = uniqueTextArray(args.allowed_effects ?? ["read_only"], "allowed_effects");
        if (allowedEffects.some((effect) => !SIDE_EFFECTS.has(effect)))
            throw new Error("allowed_effects must be supported");
        const tokens = goal.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
        const candidates = this.store.list("capability_asset", 10_000).map((asset) => {
            const searchable = `${String(asset.name)} ${asset.aliases.join(" ")} ${String(asset.source_uri)}`.toLowerCase();
            const matched = tokens.filter((token) => searchable.includes(token)).length;
            const eligible = (asset.trust === "trusted" || asset.trust === "verified") && asset.health === "healthy" && allowedEffects.includes(String(asset.effect)) && !asset.requires_credential;
            const costHint = asset.cost_hint;
            const historical = Number(asset.historical_success_rate);
            const cost = Number(costHint.tokens);
            const latency = Number(costHint.latency_ms);
            return { asset, matched, eligible, verified_workflow: asset.asset_type === "workflow" && asset.trust === "verified" ? 1 : 0,
                historical: Number.isFinite(historical) ? historical : -1, cost: Number.isFinite(cost) ? cost : Number.MAX_SAFE_INTEGER,
                latency: Number.isFinite(latency) ? latency : Number.MAX_SAFE_INTEGER,
                reason: eligible ? "eligible" : asset.requires_credential ? "credential_broker_required" : asset.trust === "untrusted" ? "untrusted" : asset.health !== "healthy" ? `health_${asset.health}` : "effect_not_allowed" };
        }).sort((left, right) => right.matched - left.matched || right.verified_workflow - left.verified_workflow || right.historical - left.historical || left.cost - right.cost || left.latency - right.latency || String(left.asset.id).localeCompare(String(right.asset.id)));
        const selected = candidates.filter((item) => item.eligible && item.matched > 0).slice(0, 3);
        if (!selected.length)
            throw new Error("No eligible capability assets match this task");
        const profile = this.saveVersioned("activation_profile", "profile", { task_id: task.id, goal_fingerprint: fingerprint({ goal }), asset_ids: selected.map((item) => item.asset.id), asset_versions: Object.fromEntries(selected.map((item) => [String(item.asset.id), item.asset.version])), allowed_effects: allowedEffects, activation: "host_mediated", status: "recommended" }, []);
        const receipt = this.store.create("tool_selection_receipt", String(args.receipt_id ?? id("selection_receipt")), { task_id: task.id, profile_id: profile.id, profile_version: profile.version, candidate_asset_ids: candidates.map((item) => item.asset.id), filtered_asset_ids: candidates.filter((item) => !item.eligible).map((item) => ({ id: item.asset.id, reason: item.reason })), selected_asset_ids: selected.map((item) => item.asset.id), order: ["semantic", "effect", "verified_workflow", "history", "cost_latency"] });
        return { profile, receipt, candidates: candidates.map((item) => ({ asset_id: item.asset.id, matched: item.matched, verified_workflow: item.verified_workflow, historical_success_rate: item.historical, cost: item.cost, latency: item.latency, eligible: item.eligible, reason: item.reason })) };
    }
    callIssue(args) {
        const profile = this.store.get("activation_profile", text(args.profile_id, "profile_id"));
        const assetId = text(args.asset_id, "asset_id");
        if (!profile.asset_ids.includes(assetId))
            throw new Error("Capability asset is not in the activation profile");
        const asset = this.store.get("capability_asset", assetId);
        if (asset.connector_id !== undefined)
            throw new Error("Connector capability assets require a Connector ticket");
        const call = this.store.create("capability_call", String(args.call_id ?? id("capability_call")), { profile_id: profile.id, profile_version: profile.version, asset_id: assetId, operation: assertNoSecret(text(args.operation, "operation"), "operation"), status: "issued", expires_at: args.expires_at ?? new Date(Date.now() + 300000).toISOString() });
        return { call_id: call.id, call };
    }
    callConsume(args) {
        const call = this.store.get("capability_call", text(args.call_id, "call_id"));
        if (call.profile_id !== text(args.profile_id, "profile_id"))
            throw new Error("Capability call profile does not match");
        if (call.connector_id !== undefined)
            throw new Error("Connector capability calls require Connector ticket consumption");
        if (call.status !== "issued")
            throw new Error("Capability call was already consumed");
        if (validIsoTime(call.expires_at, "expires_at") < Date.now())
            throw new Error("Capability call has expired");
        return { receipt: this.store.save("capability_call", String(call.id), { ...recordPayload(call), status: "consumed", consumed_at: new Date().toISOString() }) };
    }
    saveVersioned(kind, prefix, args, required) {
        for (const key of required)
            text(args[key], key);
        const recordId = String(args[`${prefix}_id`] ?? id(prefix));
        const payload = { ...args };
        delete payload[`${prefix}_id`];
        return this.store.save(kind, recordId, payload);
    }
}
//# sourceMappingURL=capability-access.js.map