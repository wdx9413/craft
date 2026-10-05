import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { resolve } from "node:path";
import { ensureRepository, openContext } from "./repository-context.ts";

/**
 * Application seam for the optional read-only Codebase capability.
 *
 * The capability owns parsing, checkpoint pinning and structural facts. This
 * facade is the only route from an external interface to that kernel, so MCP
 * does not reach through the application layer into a service field. It adds
 * no default activation, Context injection, or effects.
 */
declare module "../craft-service.ts" {
  interface CraftService {
    codebaseRepositoryEnsure(args: JsonObject): JsonObject;
    contextOpen(args: JsonObject): Promise<JsonObject>;
    codebaseWorkspaceOpen(args: JsonObject): JsonObject;
    codebaseRefresh(args: JsonObject): JsonObject;
    codebaseActivate(args: JsonObject): JsonObject;
    codebaseDeactivate(args: JsonObject): JsonObject;
    codebaseStatus(args: JsonObject): JsonObject;
    codebaseAnalysisImport(args: JsonObject): JsonObject;
    codebaseIndexBuild(args: JsonObject): JsonObject;
    codebaseSymbolFind(args: JsonObject): JsonObject;
    codebaseCallersFind(args: JsonObject): JsonObject;
    codebaseImpactQuery(args: JsonObject): JsonObject;
    codebaseContextSlice(args: JsonObject): JsonObject;
  }
}

export function installCodebaseMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.codebaseRepositoryEnsure = function (args) { return ensureRepository(this, args); };
  serviceClass.prototype.contextOpen = function (args) { return openContext(this, args); };
  serviceClass.prototype.codebaseWorkspaceOpen = function (args) {
    const existing = this.store.find("workspace", String(args.workspace_id));
    if (existing) {
      if (existing.root_path !== resolve(String(args.root_path)) || JSON.stringify(existing.include_paths) !== JSON.stringify([...args.include_paths as string[]].sort())) throw new Error("Codebase workspace declaration conflict");
      if (!existing.latest_checkpoint_id) return { ...this.workspaceCheckpoint({ workspace_id: args.workspace_id, label: "codebase recovered initial snapshot" }), idempotent: false };
      return { workspace: existing, idempotent: true };
    }
    this.workspaceOpen({ ...args, name: args.name ?? args.workspace_id });
    return { ...this.workspaceCheckpoint({ workspace_id: args.workspace_id, label: "codebase initial snapshot" }), idempotent: false };
  };
  serviceClass.prototype.codebaseRefresh = function (args) {
    const status = this.codebase.status(args);
    if (status.enabled !== true) throw new Error("Codebase is not explicitly active for this workspace");
    const freshness = this.workspace.freshness(args);
    if (freshness.status !== "current") this.workspaceCheckpoint({ workspace_id: args.workspace_id, label: "codebase changed paths" });
    return { ...this.codebase.build(args), freshness };
  };
  serviceClass.prototype.codebaseActivate = function (args) { return this.codebase.activate(args); };
  serviceClass.prototype.codebaseDeactivate = function (args) { return this.codebase.deactivate(args); };
  serviceClass.prototype.codebaseStatus = function (args) { return { ...this.codebase.status(args), working_tree: this.workspace.freshness(args) }; };
  serviceClass.prototype.codebaseAnalysisImport = function (args) { return this.codebase.importAnalysis(args); };
  serviceClass.prototype.codebaseIndexBuild = function (args) { return this.codebase.build(args); };
  serviceClass.prototype.codebaseSymbolFind = function (args) { return this.codebase.findSymbol(args); };
  serviceClass.prototype.codebaseCallersFind = function (args) { return this.codebase.findCallers(args); };
  serviceClass.prototype.codebaseImpactQuery = function (args) { return this.codebase.impact(args); };
  serviceClass.prototype.codebaseContextSlice = function (args) { return this.codebase.contextSlice(args); };
}
