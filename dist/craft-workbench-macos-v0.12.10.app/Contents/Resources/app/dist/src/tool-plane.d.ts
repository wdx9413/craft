import type { JsonObject } from "./store.ts";
/**
 * The tool plane.
 *
 * Craft used to expose one MCP tool per operation, which meant the host paid for
 * 485 tool schemas on every turn before the model had read a single message. The
 * industry measurement is that this fixed cost is the dominant tax on an agent
 * harness, and that it does not scale down by writing shorter descriptions.
 *
 * The fix is structural: expose a handful of *verbs* and make the capability
 * itself data. A resource/operation pair is a registry row, not a tool. New
 * capabilities therefore add zero tools, and the default surface stays O(1).
 *
 * Nothing here duplicates a handler: every registry row points at the legacy
 * `craft_*` tool name that already implements it, so the syscall surface is a
 * re-index of the same code rather than a second implementation.
 */
/** The verbs a host learns once. Everything else is addressed by (resource, operation). */
export declare const SYSCALL_VERBS: readonly string[];
/**
 * Tools the routing Skill calls by name. They stay verbatim on the minimal
 * surface because `craft-route` is a published contract: rewriting the Skill and
 * every host adapter at the same moment as the surface change would be two
 * migrations in one step.
 */
export declare const SYSCALL_PASSTHROUGH: readonly string[];
export type ToolEffect = "read_only" | "local_write" | "external_write" | "destructive";
export type ToolRisk = "low" | "medium" | "high";
export type AuditPolicy = "always" | "on_write" | "never";
export interface ToolLike {
    name: string;
    description: string;
    inputSchema: JsonObject;
    annotations?: JsonObject;
}
/** The governed metadata a registry row carries, modelled on the tool-registry fields production harnesses converge on. */
export interface RegistryEntry {
    tool: string;
    resource: string;
    operation: string;
    description: string;
    effect: ToolEffect;
    risk: ToolRisk;
    approval_required: boolean;
    idempotent: boolean;
    timeout_ms: number;
    audit_policy: AuditPolicy;
    roles: string[];
    required: string[];
    optional: string[];
}
/** Split a legacy tool name into the resource/operation pair that addresses it. */
export declare function parseToolName(name: string): {
    resource: string;
    operation: string;
};
/**
 * Build the registry from the legacy tool list.
 *
 * The (resource, operation) pair must be unique, because that pair is the only
 * way the syscall surface can address a tool. A collision is a programming
 * error rather than a runtime condition, so it throws here instead of silently
 * shadowing an operation.
 */
export declare function buildRegistry(tools: readonly ToolLike[]): RegistryEntry[];
/** The one operation the (resource, operation) pair addresses, or null when it does not exist. */
export declare function findEntry(entries: readonly RegistryEntry[], resource: string, operation: string): RegistryEntry | null;
/**
 * Resolve a syscall request. When the caller omits the operation the tool's own
 * default is used, and when the resource has exactly one operation that is used
 * instead — so `craft_get({resource:"info"})` works without the model having to
 * learn that `info` is also its own operation name.
 */
export declare function resolveEntry(entries: readonly RegistryEntry[], resource: string, operation: string | undefined, fallback: string): RegistryEntry | null;
/** Compact catalog for `craft_describe` with no arguments: what exists, without any schema body. */
export declare function catalogOf(entries: readonly RegistryEntry[]): {
    resources: number;
    operations: number;
    catalog: Array<{
        resource: string;
        operations: string[];
        effect: ToolEffect;
    }>;
};
/** Arg contract for one (resource, operation), plus the governance metadata the caller must respect. */
export declare function describeEntry(entry: RegistryEntry): JsonObject;
/**
 * Token-economy report for a surface, so the claim "the default surface is small"
 * is a measurement rather than an assertion.
 */
export declare function measureSurface(tools: readonly ToolLike[]): {
    tools: number;
    characters: number;
    estimated_tokens: number;
};
