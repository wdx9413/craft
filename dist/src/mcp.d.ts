import { CraftService } from "./service.ts";
import { type JsonObject } from "./store.ts";
type Tool = {
    name: string;
    description: string;
    inputSchema: JsonObject;
    annotations?: JsonObject;
};
export declare const TOOLS: Tool[];
export declare const CORE_TOOLS: Tool[];
export declare const SYSCALL_TOOLS: Tool[];
export declare const TOOL_REGISTRY: import("./tool-plane.ts").RegistryEntry[];
/**
 * Default operation for each syscall verb, so a caller that omits it still lands
 * on the obvious tool. Exported so a test can assert it stays exhaustive over
 * SYSCALL_VERBS — that is what lets `dispatchSyscall` index it without a
 * defensive fallback that could never be reached or tested.
 */
export declare const VERB_DEFAULT_OPERATION: Readonly<Record<string, string>>;
/**
 * Every mountable surface name, in the order they are declared. `syscall` is a
 * deliberate exception to the partition below: it re-exposes a small, chosen
 * subset by name (the routing Skill's tools) alongside the generic verbs, so it
 * is not part of the domain partition and is excluded from that coverage check.
 */
export declare const SURFACE_NAMES: readonly string[];
/** Domain surfaces only: these partition every non-core tool exactly once. */
export declare const DOMAIN_SURFACE_NAMES: readonly string[];
/** The single domain surface a non-core tool belongs to. The first matching rule wins, so a tool can never land in two surfaces. */
export declare function domainSurfaceOf(toolName: string): string;
/** Tool names a surface exposes. Unknown surfaces fail closed instead of silently widening to the full list. */
export declare function surfaceToolNames(surface: string): string[];
export declare class McpServer {
    readonly service: CraftService;
    readonly handlers: Record<string, (args: JsonObject) => JsonObject | Promise<JsonObject>>;
    readonly tools: Tool[];
    readonly mode: string;
    constructor(service: CraftService, mode?: string);
    handle(message: unknown): Promise<JsonObject | undefined>;
    private dispatchTool;
    /**
     * Resolve one syscall verb against the registry, then run the legacy handler it
     * points at. The syscall surface therefore never re-implements an operation and
     * can never drift from the named one.
     */
    private dispatchSyscall;
    private ok;
    private error;
}
export {};
