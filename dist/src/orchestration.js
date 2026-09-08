import { randomUUID } from "node:crypto";
import { SIDE_EFFECTS } from "./workflow.js";
export const PROVENANCE = new Set(["agent_reported", "model_judged", "program_verified", "human_approved", "human_rejected"]);
export function addCosts(current, addition) {
    const result = new Map();
    for (const [name, value] of [...Object.entries(current), ...Object.entries(addition)]) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new Error(`Cost ${name} must be a non-negative finite number`);
        }
        result.set(name, (result.get(name) ?? 0) + value);
    }
    return Object.fromEntries(result);
}
export function orchestrationOutcome(nodes, budgetExceeded = false) {
    const counts = (status) => nodes.filter((node) => node.status === status).length;
    const failed = counts("failed");
    const blocked = counts("blocked");
    const passed = counts("passed");
    return {
        verdict: failed || blocked ? "failed" : "passed",
        failure_type: budgetExceeded ? "budget_exceeded" : failed ? "node_failed" : blocked ? "node_blocked" : null,
        scores: { passed_nodes: passed, failed_nodes: failed, blocked_nodes: blocked,
            total_nodes: nodes.length, route_retries: nodes.reduce((total, node) => total + Number(node.route_index), 0) },
    };
}
export function normalizeNodes(input) {
    if (!input.length)
        throw new Error("At least one orchestration node is required");
    const seen = new Set();
    const nodes = input.map((original, position) => {
        if (!original || typeof original !== "object" || Array.isArray(original))
            throw new Error(`Orchestration node at index ${position} must be an object`);
        const node = original;
        const nodeId = String(node.id ?? "").trim();
        const role = String(node.role ?? "").trim();
        const objective = String(node.objective ?? "").trim();
        if (!nodeId || !role || !objective)
            throw new Error(`Orchestration node at index ${position} requires id, role, and objective`);
        if (seen.has(nodeId))
            throw new Error(`Duplicate orchestration node id: ${nodeId}`);
        seen.add(nodeId);
        const dependencies = node.depends_on ?? [];
        const profiles = node.profile_ids ?? [];
        if (!Array.isArray(dependencies) || !dependencies.every((item) => typeof item === "string"))
            throw new Error(`Node ${nodeId} depends_on must contain strings`);
        if (!Array.isArray(profiles) || !profiles.length || !profiles.every((item) => typeof item === "string" && item))
            throw new Error(`Node ${nodeId} profile_ids must contain at least one profile ID`);
        if (new Set(profiles).size !== profiles.length)
            throw new Error(`Node ${nodeId} profile_ids must be unique`);
        const effect = String(node.side_effect ?? "read_only");
        if (!SIDE_EFFECTS.has(effect))
            throw new Error(`Unsupported side effect for ${nodeId}: ${effect}`);
        return { ...node, id: nodeId, role, objective, depends_on: dependencies, profile_ids: profiles,
            side_effect: effect, status: "pending", route_index: 0 };
    });
    for (const node of nodes)
        for (const dependency of node.depends_on) {
            if (dependency === node.id)
                throw new Error(`Node ${node.id} cannot depend on itself`);
            if (!seen.has(dependency))
                throw new Error(`Node ${node.id} has unknown dependency: ${dependency}`);
        }
    const visiting = new Set();
    const visited = new Set();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visit = (nodeId) => {
        if (visiting.has(nodeId))
            throw new Error(`Orchestration plan contains a dependency cycle at: ${nodeId}`);
        if (visited.has(nodeId))
            return;
        visiting.add(nodeId);
        for (const dependency of byId.get(nodeId).depends_on)
            visit(dependency);
        visiting.delete(nodeId);
        visited.add(nodeId);
    };
    for (const node of nodes)
        visit(node.id);
    return nodes;
}
export function planStatus(nodes) {
    if (nodes.every((node) => node.status === "passed"))
        return "completed";
    if (nodes.some((node) => node.status === "pending" || node.status === "leased"))
        return "running";
    return "failed";
}
export function dispatchNodes(nodes, capacity, owner, leaseTtlSeconds = 300, now = Date.now()) {
    if (!Number.isInteger(capacity) || capacity < 0)
        throw new Error("capacity must be a non-negative integer");
    if (!Number.isInteger(leaseTtlSeconds) || leaseTtlSeconds < 1 || leaseTtlSeconds > 3_600) {
        throw new Error("lease_ttl_seconds must be an integer between 1 and 3600");
    }
    const passed = new Set(nodes.filter((node) => node.status === "passed").map((node) => node.id));
    const active = nodes.filter((node) => node.status === "leased").length;
    const available = Math.max(0, capacity - active);
    const leases = [];
    const updated = nodes.map((node) => {
        if (leases.length >= available || node.status !== "pending" || !node.depends_on.every((dep) => passed.has(dep)))
            return node;
        const routeIndex = Number(node.route_index);
        if (!Number.isInteger(routeIndex) || routeIndex < 0 || routeIndex >= node.profile_ids.length) {
            throw new Error(`Node ${node.id} has an invalid route_index`);
        }
        const leaseId = `lease_${randomUUID().replaceAll("-", "")}`;
        const leased = { ...node, status: "leased", lease_id: leaseId, claimed_by: owner,
            lease_expires_at: new Date(now + leaseTtlSeconds * 1_000).toISOString() };
        leases.push({ lease_id: leaseId, node_id: node.id, profile_id: node.profile_ids[routeIndex],
            profile_version: node.profile_versions?.[routeIndex] ?? null,
            role: node.role, objective: node.objective, side_effect: node.side_effect });
        return leased;
    });
    return { nodes: updated, leases };
}
export function recoverExpiredLeases(nodes, now = Date.now()) {
    const recovered = [];
    const updated = nodes.map((node) => {
        const expiresAt = Date.parse(String(node.lease_expires_at ?? ""));
        if (node.status !== "leased" || !Number.isFinite(expiresAt) || expiresAt > now)
            return node;
        recovered.push(String(node.id));
        return { ...node, status: "pending", lease_id: null, claimed_by: null, lease_expires_at: null,
            last_provenance: "lease_expired" };
    });
    return { nodes: updated, recovered };
}
export function submitNode(nodes, leaseId, verdict, provenance) {
    if (!PROVENANCE.has(provenance))
        throw new Error(`Unsupported provenance: ${provenance}`);
    if (!new Set(["passed", "failed", "blocked"]).has(verdict))
        throw new Error(`Unsupported verdict: ${verdict}`);
    let found = false;
    const updated = nodes.map((node) => {
        if (node.lease_id !== leaseId)
            return node;
        found = true;
        if (node.status !== "leased")
            throw new Error(`Lease is not active: ${leaseId}`);
        if (verdict === "failed" && Number(node.route_index) + 1 < node.profile_ids.length) {
            return { ...node, status: "pending", route_index: Number(node.route_index) + 1,
                lease_id: null, claimed_by: null, lease_expires_at: null, last_provenance: provenance };
        }
        return { ...node, status: verdict, lease_id: null, claimed_by: null, lease_expires_at: null,
            last_provenance: provenance };
    });
    if (!found)
        throw new Error(`Unknown lease: ${leaseId}`);
    const propagated = updated.map((node) => ({ ...node }));
    const failed = new Set(propagated.filter((node) => node.status === "failed" || node.status === "blocked").map((node) => node.id));
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of propagated) {
            if (node.status === "pending" && node.depends_on.some((dependency) => failed.has(dependency))) {
                node.status = "blocked";
                failed.add(node.id);
                changed = true;
            }
        }
    }
    return propagated;
}
//# sourceMappingURL=orchestration.js.map