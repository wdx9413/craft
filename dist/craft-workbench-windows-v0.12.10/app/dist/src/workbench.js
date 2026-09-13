import { randomUUID } from "node:crypto";
import { CraftStore } from "./store.js";
const OBJECT_STATUS = new Set(["draft", "accepted", "needs_review", "archived"]);
const MEMORY_KINDS = new Set(["fact", "preference", "decision", "experience"]);
const MEMORY_STATUS = new Set(["active", "superseded", "expired", "rejected"]);
const TASK_GRAPH_NODE_KINDS = new Set(["explore", "produce", "verify", "review", "deliver"]);
const TASK_GRAPH_NODE_STATUS = new Set(["pending", "active", "done", "skipped", "blocked"]);
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
function profileSelector(value, name, allowed) {
    const values = strings(value, name);
    if (values.some((item) => !allowed.has(item)))
        throw new Error(`${name} contains an unsupported value`);
    return values;
}
function graphNodes(value) {
    if (!Array.isArray(value) || !value.length)
        throw new Error("nodes must contain at least one node");
    const seen = new Set();
    const nodes = value.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error(`nodes[${index}] must be an object`);
        const input = raw;
        const nodeId = id(input.id, `nodes[${index}].id`, "node");
        if (seen.has(nodeId))
            throw new Error(`Duplicate task graph node id: ${nodeId}`);
        seen.add(nodeId);
        const kind = text(input.kind, `nodes[${index}].kind`);
        if (!TASK_GRAPH_NODE_KINDS.has(kind))
            throw new Error(`Unsupported task graph node kind: ${kind}`);
        const dependencies = strings(input.depends_on, `nodes[${index}].depends_on`);
        if (dependencies.includes(nodeId))
            throw new Error(`Task graph node ${nodeId} cannot depend on itself`);
        return { id: nodeId, title: text(input.title, `nodes[${index}].title`), objective: text(input.objective, `nodes[${index}].objective`),
            kind, depends_on: dependencies, context_profile_id: input.context_profile_id === undefined ? null : text(input.context_profile_id, `nodes[${index}].context_profile_id`),
            context_profile_version: input.context_profile_version === undefined ? null : Number(input.context_profile_version), status: "pending" };
    });
    for (const node of nodes)
        for (const dependency of node.depends_on) {
            if (!seen.has(dependency))
                throw new Error(`Task graph node ${node.id} has an unknown dependency: ${dependency}`);
        }
    const byId = new Map(nodes.map((node) => [String(node.id), node]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (nodeId) => {
        if (visiting.has(nodeId))
            throw new Error(`Task graph contains a dependency cycle at: ${nodeId}`);
        if (visited.has(nodeId))
            return;
        visiting.add(nodeId);
        for (const dependency of byId.get(nodeId).depends_on)
            visit(dependency);
        visiting.delete(nodeId);
        visited.add(nodeId);
    };
    for (const node of nodes)
        visit(String(node.id));
    return nodes;
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
    contextProfileSave(args) {
        const profileId = id(args.profile_id, "profile_id", "context_profile");
        const previous = this.store.find("context_profile", profileId);
        const taskId = args.task_id === undefined ? previous?.task_id ?? null : text(args.task_id, "task_id");
        const workspaceId = args.workspace_id === undefined ? previous?.workspace_id ?? null : text(args.workspace_id, "workspace_id");
        if (taskId !== null)
            this.store.get("task", String(taskId));
        if (workspaceId !== null)
            this.store.get("workspace", String(workspaceId));
        const memoryKinds = profileSelector(args.memory_kinds ?? previous?.memory_kinds, "memory_kinds", MEMORY_KINDS);
        const objectTypes = strings(args.object_types ?? previous?.object_types, "object_types");
        const requiredMemoryIds = strings(args.required_memory_ids ?? previous?.required_memory_ids, "required_memory_ids");
        const requiredObjectIds = strings(args.required_object_ids ?? previous?.required_object_ids, "required_object_ids");
        const maxItems = Number(args.max_items ?? previous?.max_items ?? 12);
        const maxChars = Number(args.max_chars ?? previous?.max_chars ?? 12_000);
        if (!Number.isInteger(maxItems) || maxItems < 1 || !Number.isInteger(maxChars) || maxChars < 1)
            throw new Error("Context profile limits must be positive integers");
        for (const memoryId of requiredMemoryIds) {
            const memory = this.store.get("memory_item", memoryId);
            if (!matchesScope(memory, taskId === null ? undefined : String(taskId), workspaceId === null ? undefined : String(workspaceId))) {
                throw new Error("Required memory does not belong to the context profile scope");
            }
        }
        for (const objectId of requiredObjectIds) {
            const workObject = this.store.get("work_object", objectId);
            if (workspaceId === null || workObject.workspace_id !== workspaceId)
                throw new Error("Required work object does not belong to the context profile workspace");
        }
        return { profile: this.store.save("context_profile", profileId, { name: text(args.name ?? previous?.name, "name"), task_id: taskId,
                workspace_id: workspaceId, memory_kinds: memoryKinds, object_types: objectTypes, required_memory_ids: requiredMemoryIds,
                required_object_ids: requiredObjectIds, max_items: maxItems, max_chars: maxChars }) };
    }
    contextProfileAssemble(args) {
        const profile = this.store.get("context_profile", text(args.profile_id, "profile_id"), args.profile_version === undefined ? undefined : Number(args.profile_version));
        if (args.task_id !== undefined && args.task_id !== profile.task_id)
            throw new Error("Task does not match the context profile");
        if (args.workspace_id !== undefined && args.workspace_id !== profile.workspace_id)
            throw new Error("Workspace does not match the context profile");
        const context = this.contextAssemble({ query: text(args.query, "query"), task_id: profile.task_id ?? undefined,
            workspace_id: profile.workspace_id ?? undefined, limit: profile.max_items, max_chars: profile.max_chars,
            memory_kinds: profile.memory_kinds, object_types: profile.object_types, required_memory_ids: profile.required_memory_ids,
            required_object_ids: profile.required_object_ids });
        return { profile, context };
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
        const memoryKinds = profileSelector(args.memory_kinds, "memory_kinds", MEMORY_KINDS);
        const objectTypes = strings(args.object_types, "object_types");
        const requiredMemoryIds = new Set(strings(args.required_memory_ids, "required_memory_ids"));
        const requiredObjectIds = new Set(strings(args.required_object_ids, "required_object_ids"));
        const memories = this.store.list("memory_item", 10_000).filter((item) => item.status === "active" && matchesScope(item, taskId, workspaceId) &&
            (!memoryKinds.length || memoryKinds.includes(String(item.kind))) &&
            (item.valid_until === null || Date.parse(String(item.valid_until)) >= now));
        const objects = workspaceId ? this.store.list("work_object", 10_000, (item) => item.workspace_id === workspaceId && item.status !== "archived" &&
            (!objectTypes.length || objectTypes.includes(String(item.object_type)))) : [];
        for (const memoryId of requiredMemoryIds)
            if (!memories.some((item) => item.id === memoryId))
                throw new Error("Required memory is unavailable in this context");
        for (const objectId of requiredObjectIds)
            if (!objects.some((item) => item.id === objectId))
                throw new Error("Required work object is unavailable in this context");
        const candidates = [...memories.map((item) => ({ source_type: "memory", source_id: item.id, content: item.content, state: item.status, raw: item,
                required: requiredMemoryIds.has(String(item.id)) })), ...objects.map((item) => ({ source_type: "work_object", source_id: item.id,
                content: `${item.name} ${JSON.stringify(item.data)}`, state: item.status, raw: item, required: requiredObjectIds.has(String(item.id)) }))]
            .map((item) => ({ ...item, score: item.required ? Number.MAX_SAFE_INTEGER : tokens.reduce((sum, token) => sum + Number(String(item.content).toLowerCase().includes(token)), 0) }))
            .filter((item) => item.required || item.score > 0).sort((left, right) => Number(right.required) - Number(left.required) || right.score - left.score || String(left.source_id).localeCompare(String(right.source_id)));
        const selected = [];
        let usedChars = 0;
        for (const candidate of candidates) {
            const size = String(candidate.content).length;
            if (selected.length >= maxItems)
                break;
            if (usedChars + size > maxChars) {
                if (candidate.required)
                    throw new Error("Required context exceeds the context budget");
                continue;
            }
            selected.push(candidate);
            usedChars += size;
        }
        return { query, task_id: taskId ?? null, workspace_id: workspaceId ?? null, items: selected.map(({ raw: _raw, ...item }) => item),
            used_chars: usedChars, max_chars: maxChars, omitted_count: candidates.length - selected.length,
            provenance_preserved: true };
    }
    taskGraphCreate(args) {
        const taskId = args.task_id === undefined ? null : text(args.task_id, "task_id");
        const workspaceId = args.workspace_id === undefined ? null : text(args.workspace_id, "workspace_id");
        if (taskId !== null)
            this.store.get("task", taskId);
        if (workspaceId !== null)
            this.store.get("workspace", workspaceId);
        const nodes = graphNodes(args.nodes);
        for (const node of nodes) {
            if (node.context_profile_id === null) {
                if (node.context_profile_version !== null)
                    throw new Error("A context profile version requires a context profile id");
                continue;
            }
            if (!Number.isInteger(node.context_profile_version) || Number(node.context_profile_version) < 1)
                throw new Error("context_profile_version must be a positive integer");
            const profile = this.store.get("context_profile", String(node.context_profile_id), Number(node.context_profile_version));
            if (profile.task_id !== null && profile.task_id !== taskId)
                throw new Error("Task graph node profile does not match the task");
            if (profile.workspace_id !== null && profile.workspace_id !== workspaceId)
                throw new Error("Task graph node profile does not match the workspace");
        }
        const graph = this.store.create("task_graph", id(args.graph_id, "graph_id", "task_graph"), { name: text(args.name, "name"), task_id: taskId,
            workspace_id: workspaceId, nodes, status: "active" });
        return { graph, ready_node_ids: nodes.filter((node) => !node.depends_on.length).map((node) => node.id) };
    }
    taskGraphAdvance(args) {
        const graph = this.store.get("task_graph", text(args.graph_id, "graph_id"));
        const nodeId = text(args.node_id, "node_id");
        const nextStatus = text(args.status, "status");
        if (!TASK_GRAPH_NODE_STATUS.has(nextStatus) || nextStatus === "pending")
            throw new Error("Task graph node status is unsupported");
        const nodes = graph.nodes.map((node) => ({ ...node }));
        const node = nodes.find((item) => item.id === nodeId);
        if (!node)
            throw new Error("Unknown task graph node");
        if (node.status !== "pending" && node.status !== "active")
            throw new Error("Task graph node is already terminal");
        if (nextStatus === "active" && !node.depends_on.every((dependency) => nodes.find((item) => item.id === dependency)?.status === "done" || nodes.find((item) => item.id === dependency)?.status === "skipped")) {
            throw new Error("Task graph dependencies are not complete");
        }
        node.status = nextStatus;
        const blocked = new Set(nodes.filter((item) => item.status === "blocked").map((item) => String(item.id)));
        let changed = true;
        while (changed) {
            changed = false;
            for (const candidate of nodes)
                if (candidate.status === "pending" && candidate.depends_on.some((dependency) => blocked.has(dependency))) {
                    candidate.status = "blocked";
                    blocked.add(String(candidate.id));
                    changed = true;
                }
        }
        const status = nodes.some((item) => item.status === "blocked") ? "blocked" : nodes.every((item) => ["done", "skipped"].includes(String(item.status))) ? "completed" : "active";
        const saved = this.store.updateIfVersion("task_graph", String(graph.id), Number(graph.version), { ...payload(graph), nodes, status });
        return { graph: saved, ready_node_ids: nodes.filter((item) => item.status === "pending" && item.depends_on.every((dependency) => ["done", "skipped"].includes(String(nodes.find((candidate) => candidate.id === dependency)?.status)))).map((item) => item.id) };
    }
}
//# sourceMappingURL=workbench.js.map