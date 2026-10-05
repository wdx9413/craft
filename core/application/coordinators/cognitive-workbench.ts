import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { digestJson } from "../../digest.ts";
import { CRAFT_RELEASE_VERSION } from "../../version.ts";

type Command = (args: JsonObject) => JsonObject;
export interface CognitiveWorkbenchPorts {
  store: CraftStore;
  resourceCatalog: Command;
  registerSource: Command;
  proposeMemory: Command;
  recordEvidence: Command;
  saveClaim: Command;
}

/** UI inputs are translated here; domain commands retain all write gates. */
export class CognitiveWorkbenchCoordinator {
  readonly ports: CognitiveWorkbenchPorts;
  constructor(ports: CognitiveWorkbenchPorts) { this.ports = ports; }
  resources(args: JsonObject = {}): JsonObject {
    if (args.kind !== undefined) return this.ports.resourceCatalog(args);
    const limit = Number(args.limit ?? 50);
    return { version: CRAFT_RELEASE_VERSION, resources: {
      claims: this.ports.store.list("knowledge_claim", limit), wiki: this.ports.store.list("wiki_page", limit),
      memory_candidates: this.ports.store.list("memory_candidate", limit), memories: this.ports.store.list("memory_ledger", limit),
      workflows: this.ports.store.list("workflow_dag", limit), task_states: this.ports.store.list("task_state_projection", limit),
    } };
  }
  saveMemory(args: JsonObject): JsonObject {
    const sourceId = String(args.source_id ?? "studio-local-source");
    if (!this.ports.store.find("knowledge_source", sourceId)) this.ports.registerSource({ source_id: sourceId, kind: "custom", label: "Studio local memory", scope_kind: "user", scope_id: "local", locator: "studio://memory", content_digest: digestJson(sourceId), trust: "bounded", access: "proposal_only" });
    const kind = ["working", "episodic", "preference", "procedural"].includes(String(args.kind)) ? args.kind : "episodic";
    return this.ports.proposeMemory({ ...args, kind, source_id: sourceId, scope_kind: args.scope_kind ?? args.scope ?? "user", scope_id: args.scope_id ?? "local" });
  }
  saveClaim(args: JsonObject): JsonObject {
    const evidence = args.evidence_ids === undefined ? this.ports.recordEvidence({ source_type: "human", confidence: "bounded", claim: "Studio-authored candidate.", locator: "studio://knowledge" }) : null;
    return this.ports.saveClaim({ ...args, evidence_ids: args.evidence_ids ?? [evidence?.id], scope: args.scope ?? "global" });
  }
}
