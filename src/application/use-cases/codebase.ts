import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";

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
    codebaseActivate(args: JsonObject): JsonObject;
    codebaseDeactivate(args: JsonObject): JsonObject;
    codebaseStatus(args: JsonObject): JsonObject;
    codebaseIndexBuild(args: JsonObject): JsonObject;
    codebaseSymbolFind(args: JsonObject): JsonObject;
    codebaseCallersFind(args: JsonObject): JsonObject;
    codebaseImpactQuery(args: JsonObject): JsonObject;
    codebaseContextSlice(args: JsonObject): JsonObject;
  }
}

export function installCodebaseMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.codebaseActivate = function (args) { return this.codebase.activate(args); };
  serviceClass.prototype.codebaseDeactivate = function (args) { return this.codebase.deactivate(args); };
  serviceClass.prototype.codebaseStatus = function (args) { return this.codebase.status(args); };
  serviceClass.prototype.codebaseIndexBuild = function (args) { return this.codebase.build(args); };
  serviceClass.prototype.codebaseSymbolFind = function (args) { return this.codebase.findSymbol(args); };
  serviceClass.prototype.codebaseCallersFind = function (args) { return this.codebase.findCallers(args); };
  serviceClass.prototype.codebaseImpactQuery = function (args) { return this.codebase.impact(args); };
  serviceClass.prototype.codebaseContextSlice = function (args) { return this.codebase.contextSlice(args); };
}
