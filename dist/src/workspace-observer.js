import { createHash } from "node:crypto";
import { CraftStore } from "./store.js";
import { StateWorkspaceKernel } from "./state-workspace.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
/** Poll-based, content-free workspace observer. It never guesses whether an
 * uncorrelated edit was made by a person or a model. */
export class WorkspaceObserverKernel {
    store;
    states;
    constructor(store, states) { this.store = store; this.states = states; }
    observe(args) {
        const workspaceId = text(args.workspace_id, "workspace_id");
        this.store.get("workspace", workspaceId);
        const snapshot = this.states.observe({ workspace_id: workspaceId, adapter: args.adapter, paths: args.paths, artifact_ids: args.artifact_ids, snapshot_id: args.snapshot_id }).snapshot;
        const priorId = args.previous_snapshot_id === undefined ? null : text(args.previous_snapshot_id, "previous_snapshot_id");
        const prior = priorId ? this.store.get("state_snapshot", priorId) : null;
        if (prior && prior.workspace_id !== workspaceId)
            throw new Error("Workspace observation snapshots must belong to one Workspace");
        const difference = prior ? this.states.compare({ before_snapshot_id: prior.id, after_snapshot_id: snapshot.id }).difference : { added_paths: [], deleted_paths: [], modified_paths: [], changed: false };
        const source = args.source === undefined ? "unattributed" : text(args.source, "source");
        if (!new Set(["host", "human", "unattributed"]).has(source))
            throw new Error("Workspace observation source is unsupported");
        const changed = difference.changed === true;
        const classification = !changed ? "unchanged" : source === "host" ? "host_observed" : source === "human" ? "human_observed" : "external_unattributed";
        const identity = { workspace_id: workspaceId, previous_snapshot_id: prior?.id ?? null, previous_snapshot_version: prior?.version ?? null, snapshot_id: snapshot.id, snapshot_version: snapshot.version, source, classification, difference };
        const observationId = String(args.observation_id ?? `workspace_observation_${workspaceId}_${digest(identity).slice(-16)}`);
        const existing = this.store.find("workspace_observation", observationId);
        const observationDigest = digest(identity);
        if (existing) {
            if (existing.observation_digest !== observationDigest)
                throw new Error("Workspace observation idempotency conflict");
            return { observation: existing, snapshot, idempotent: true };
        }
        const observation = this.store.create("workspace_observation", observationId, { ...identity, observation_digest: observationDigest });
        this.store.appendEvent(`workspace:${workspaceId}`, "workspace.observed", { observation_id: observation.id, classification, changed, snapshot_id: snapshot.id });
        return { observation, snapshot, idempotent: false };
    }
    get(args) { const observation = this.store.get("workspace_observation", text(args.observation_id, "observation_id")); return { observation, timeline: this.store.events(`workspace:${observation.workspace_id}`) }; }
}
//# sourceMappingURL=workspace-observer.js.map