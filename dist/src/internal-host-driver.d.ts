import type { HostDriver, HostOutputObserver } from "./host-driver.ts";
import { type ChatToolDefinition, type ModelProviderSpec, type ModelTransport } from "./model-gateway.ts";
import { TraceKernel } from "./trace-kernel.ts";
import { CraftStore, type JsonObject } from "./store.ts";
/**
 * The internal host: Craft running the loop itself.
 *
 * This is deliberately a *third* HostDriver rather than a new execution model.
 * Codex, Claude and the internal host all produce the same dispatch, receipt and
 * evidence records, so "Craft works on its own" and "Craft governs someone
 * else's agent" stay the same shape and can be compared with the same harness.
 *
 * The driver owns nothing about the wire: a ModelTransport can be injected for a
 * host proxy or deterministic tests. The default is Craft's fetch-based transport.
 */
export interface InternalHostOptions {
    providers: readonly ModelProviderSpec[];
    transport?: ModelTransport;
    /** Executes one proposed action; omitted means the model may only answer, not act. */
    invokeAction?: (action: string, args: JsonObject) => JsonObject | Promise<JsonObject>;
    env?: NodeJS.ProcessEnv;
    tools?: readonly ChatToolDefinition[];
}
/**
 * A model reply is only treated as an action when it is a single JSON object with
 * `action` and optional `args`.
 *
 * The cast on the parsed value is deliberate rather than defensive: a text that
 * starts with `{` and ends with `}` can only parse to an object, so an
 * `Array.isArray` / null guard here would be unreachable code that still counts
 * against the coverage gate. Every other shape returns null before this point.
 */
export declare function parseAction(text: string): {
    action: string;
    args: JsonObject;
} | null;
export declare class InternalHostDriver implements HostDriver {
    readonly host = "internal";
    readonly dispatchKind = "internal_dispatch";
    readonly store: CraftStore;
    readonly providers: readonly ModelProviderSpec[];
    readonly transport: ModelTransport;
    readonly invokeAction: InternalHostOptions["invokeAction"];
    readonly env: NodeJS.ProcessEnv;
    readonly tools: readonly ChatToolDefinition[];
    readonly trace: TraceKernel;
    constructor(store: CraftStore, options: InternalHostOptions);
    private receiptKind;
    private provider;
    prepare(args: JsonObject): JsonObject;
    execute(args: JsonObject, options?: {
        signal?: AbortSignal;
        observe?: HostOutputObserver;
    }): Promise<JsonObject>;
}
