import { CraftStore, type JsonObject } from "./store.ts";
/** Read-only bridge for Serena's project-local Markdown memories. It never writes .serena. */
export declare class ProjectKnowledgeKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    discover(args: JsonObject): JsonObject;
    resolve(args: JsonObject): JsonObject;
    proposeUpdate(args: JsonObject): JsonObject;
}
