import { randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
const OBJECT_STATUS = new Set(["draft", "accepted", "needs_review", "archived"]);
const MEMORY_KINDS = new Set(["fact", "preference", "decision", "experience"]);
const MEMORY_STATUS = new Set(["active", "superseded", "expired", "rejected"]);
function id(value, name, prefix) {
    const result = value === undefined ? `${prefix}_${randomUUID().replaceAll("-", "")}` : String(value).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(result))
        throw new Error(`${name} must contain only letters, numbers, _ or -`);
    return result;
}
function text(value, name) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${name} must not be empty`);
    return value.trim();
}
function strings(value, name) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error(`${name} must be an array`);
    const result = value.map((item) => text(item, name));
    if (new Set(result).size !== result.length)
        throw new Error(`${name} must contain unique values`);
    return result;
}
function payload(record) {
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
    return rest;
}
function revision(value, fallback) {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(result) || result < 1)
        throw new Error("expected_state_revision must be a positive integer");
    return result;
}
function matchesScope(memory, taskId, workspaceId) {
    const scope = String(memory.scope);
    if (scope === "user")
        return true;
    if (scope === "task")
        return memory.task_id === taskId;
    if (scope === "workspace")
        return memory.workspace_id === workspaceId;
    return false;
}
export class WorkbenchKernel {
    store;
    constructor(store) { this.store = store; }
    objectPut(args) {
        const workspaceId = id(args.workspace_id, "workspace_id", "workspace");
        const workspace = this.store.get("workspace", workspaceId);
        const expected = revision(args.expected_state_revision, Number(workspace.state_revision));
        if (expected !== Number(workspace.state_revision))
            throw new Error("Workspace state changed; refresh before writing");
        const objectId = id(args.object_id, "object_id", "work_object");
        const previous = this.store.find("work_object", objectId);
        const dependencies = strings(args.depends_on ?? previous?.depends_on, "depends_on");
        if (dependencies.includes(objectId))
            throw new Error("A work object cannot depend on itself");
        for (const dependencyId of dependencies) {
            const dependency = this.store.get("work_object", dependencyId);
            if (dependency.workspace_id !== workspaceId)
                throw new Error("Work object dependencies must belong to the same workspace");
            const pending = [dependency];
            const visited = new Set();
            while (pending.length) {
                const candidate = pending.pop();
                const candidateId = String(candidate.id);
                if (candidateId === objectId)
                    throw new Error("Work object dependencies must not form a cycle");
                if (visited.has(candidateId))
                    continue;
                visited.add(candidateId);
                for (const parentId of candidate.depends_on)
                    pending.push(this.store.get("work_object", parentId));
            }
        }
        if (previous && previous.workspace_id !== workspaceId)
            throw new Error("Work object already belongs to another workspace");
        const status = String(args.status ?? previous?.status ?? "draft");
        if (!OBJECT_STATUS.has(status))
            throw new Error("Work object status is unsupported");
        const acceptedEvidence = status === "accepted" ? strings(args.evidence_ids ?? previous?.accepted_evidence_ids, "evidence_ids") : [];
        if (status === "accepted" && !acceptedEvidence.length)
            throw new Error("Accepted work objects require evidence_ids");
        const data = args.data ?? previous?.data ?? {};
        if (!data || typeof data !== "object" || Array.isArray(data))
            throw new Error("Work object data must be an object");
        const nextRevision = expected + 1;
        const record = { workspace_id: workspaceId, object_type: text(args.object_type ?? previous?.object_type, "object_type"),
            name: text(args.name ?? previous?.name, "name"), data, depends_on: dependencies,
            artifact_ids: strings(args.artifact_ids ?? previous?.artifact_ids, "artifact_ids"),
            source_paths: strings(args.source_paths ?? previous?.source_paths, "source_paths"), status,
            accepted_evidence_ids: acceptedEvidence,
            state_revision: nextRevision };
        const entries = [{ kind: "work_object", id: objectId, payload: record },
            { kind: "workspace", id: workspaceId, payload: { ...payload(workspace), state_revision: nextRevision } }];
        const [object, savedWorkspace] = this.store.saveBatch(entries);
        return { object, workspace: savedWorkspace };
    }
    impact(args) {
        const workspaceId = id(args.workspace_id, "workspace_id", "workspace");
        this.store.get("workspace", workspaceId);
        const roots = new Set(strings(args.object_ids, "object_ids"));
        const paths = strings(args.affected_paths, "affected_paths");
        const objects = this.store.list("work_object", 10_000, (item) => item.workspace_id === workspaceId);
        for (const object of objects) {
            const objectPaths = Array.isArray(object.source_paths) ? object.source_paths.map(String) : [];
            if (paths.some((path) => objectPaths.includes(path)))
                roots.add(String(object.id));
        }
        for (const root of roots) {
            const object = this.store.get("work_object", root);
            if (object.workspace_id !== workspaceId)
                throw new Error("Affected work objects must belong to the workspace");
        }
        const impacted = new Set(roots);
        let changed = true;
        while (changed) {
            changed = false;
            for (const object of objects) {
                if (!impacted.has(String(object.id)) && object.depends_on.some((dependency) => impacted.has(dependency))) {
                    impacted.add(String(object.id));
                    changed = true;
                }
            }
        }
        return { workspace_id: workspaceId, root_object_ids: [...roots].sort(), impacted_object_ids: [...impacted].sort(),
            unaffected_object_ids: objects.map((item) => String(item.id)).filter((item) => !impacted.has(item)).sort() };
    }
    changeApply(args) {
        const workspaceId = id(args.workspace_id, "workspace_id", "workspace");
        const workspace = this.store.get("workspace", workspaceId);
        const expected = revision(args.expected_state_revision, Number(workspace.state_revision));
        if (expected !== Number(workspace.state_revision))
            throw new Error("Workspace state changed; refresh before applying a change");
        const impact = this.impact(args);
        const impactedIds = impact.impacted_object_ids;
        const nextRevision = expected + 1;
        const changeId = id(args.change_id, "change_id", "workspace_change");
        const entries = impactedIds.map((objectId) => {
            const object = this.store.get("work_object", objectId);
            return { kind: "work_object", id: objectId, payload: { ...payload(object), status: "needs_review", accepted_evidence_ids: [], state_revision: nextRevision } };
        });
        entries.push({ kind: "workspace_change", id: changeId, payload: { workspace_id: workspaceId, summary: text(args.summary, "summary"),
                affected_paths: strings(args.affected_paths, "affected_paths"), affected_object_ids: impact.root_object_ids,
                impacted_object_ids: impactedIds, source: args.source ?? "human", previous_checkpoint_id: workspace.latest_checkpoint_id ?? null,
                state_revision: nextRevision } });
        entries.push({ kind: "workspace", id: workspaceId, payload: { ...payload(workspace), state_revision: nextRevision,
                latest_human_change_id: changeId } });
        const saved = this.store.saveBatch(entries);
        return { workspace: saved.at(-1), change: saved.at(-2), impact,
            objects: saved.slice(0, impactedIds.length) };
    }
    objectList(args) {
        const workspaceId = id(args.workspace_id, "workspace_id", "workspace");
        this.store.get("workspace", workspaceId);
        return { objects: this.store.list("work_object", Number(args.limit ?? 100), (item) => item.workspace_id === workspaceId &&
                (args.status === undefined || item.status === args.status)) };
    }
    remember(args) {
        const kind = String(args.kind);
        const scope = String(args.scope);
        if (!MEMORY_KINDS.has(kind))
            throw new Error("Memory kind is unsupported");
        if (!new Set(["user", "workspace", "task"]).has(scope))
            throw new Error("Memory scope is unsupported");
        if (scope === "workspace")
            this.store.get("workspace", text(args.workspace_id, "workspace_id"));
        if (scope === "task")
            this.store.get("task", text(args.task_id, "task_id"));
        const validUntil = args.valid_until === undefined ? null : text(args.valid_until, "valid_until");
        if (validUntil !== null && Number.isNaN(Date.parse(validUntil)))
            throw new Error("valid_until must be an ISO timestamp");
        const superseded = args.supersedes_id === undefined ? null : this.store.get("memory_item", text(args.supersedes_id, "supersedes_id"));
        if (superseded && superseded.status !== "active")
            throw new Error("Only an active memory can be superseded");
        if (superseded && (superseded.scope !== scope || superseded.task_id !== (args.task_id ?? null) || superseded.workspace_id !== (args.workspace_id ?? null))) {
            throw new Error("Replacement memory must keep the same scope target");
        }
        const memory = this.store.create("memory_item", id(args.memory_id, "memory_id", "memory"), { kind, scope,
            content: text(args.content, "content"), source: text(args.source, "source"), task_id: args.task_id ?? null,
            workspace_id: args.workspace_id ?? null, applies_to: strings(args.applies_to, "applies_to"), status: "active",
            valid_until: validUntil, evidence_ids: strings(args.evidence_ids, "evidence_ids"), supersedes_id: superseded?.id ?? null });
        if (superseded)
            this.memoryTransition({ memory_id: superseded.id, status: "superseded", replacement_id: memory.id });
        return { memory };
    }
    memoryTransition(args) {
        const memory = this.store.get("memory_item", text(args.memory_id, "memory_id"));
        const status = String(args.status);
        if (!MEMORY_STATUS.has(status) || status === "active")
            throw new Error("Memory transition status is unsupported");
        return { memory: this.store.save("memory_item", String(memory.id), { ...payload(memory), status,
                replacement_id: args.replacement_id ?? null, transition_reason: args.reason ?? null }) };
    }
    contextAssemble(args) {
        const query = text(args.query, "query");
        const tokens = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
        const taskId = args.task_id === undefined ? undefined : text(args.task_id, "task_id");
        const workspaceId = args.workspace_id === undefined ? undefined : text(args.workspace_id, "workspace_id");
        if (taskId)
            this.store.get("task", taskId);
        if (workspaceId)
            this.store.get("workspace", workspaceId);
        const maxItems = Number(args.limit ?? 12);
        const maxChars = Number(args.max_chars ?? 12_000);
        if (!Number.isInteger(maxItems) || maxItems < 1 || !Number.isInteger(maxChars) || maxChars < 1)
            throw new Error("Context limits must be positive integers");
        const now = Date.now();
        const memories = this.store.list("memory_item", 10_000).filter((item) => item.status === "active" && matchesScope(item, taskId, workspaceId) &&
            (item.valid_until === null || Date.parse(String(item.valid_until)) >= now));
        const objects = workspaceId ? this.store.list("work_object", 10_000, (item) => item.workspace_id === workspaceId && item.status !== "archived") : [];
        const candidates = [...memories.map((item) => ({ source_type: "memory", source_id: item.id, content: item.content, state: item.status, raw: item })),
            ...objects.map((item) => ({ source_type: "work_object", source_id: item.id, content: `${item.name} ${JSON.stringify(item.data)}`, state: item.status, raw: item }))]
            .map((item) => ({ ...item, score: tokens.reduce((sum, token) => sum + Number(String(item.content).toLowerCase().includes(token)), 0) }))
            .filter((item) => item.score > 0).sort((left, right) => right.score - left.score || String(left.source_id).localeCompare(String(right.source_id)));
        const selected = [];
        let usedChars = 0;
        for (const candidate of candidates) {
            const size = String(candidate.content).length;
            if (selected.length >= maxItems)
                break;
            if (usedChars + size > maxChars)
                continue;
            selected.push(candidate);
            usedChars += size;
        }
        return { query, task_id: taskId ?? null, workspace_id: workspaceId ?? null, items: selected.map(({ raw: _raw, ...item }) => item),
            used_chars: usedChars, max_chars: maxChars, omitted_count: candidates.length - selected.length,
            provenance_preserved: true };
    }
}
//# sourceMappingURL=workbench.js.map