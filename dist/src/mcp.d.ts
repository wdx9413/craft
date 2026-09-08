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
export declare class McpServer {
    readonly service: CraftService;
    readonly handlers: Record<string, (args: JsonObject) => JsonObject | Promise<JsonObject>>;
    readonly tools: Tool[];
    readonly mode: "core" | "full";
    constructor(service: CraftService, mode?: "core" | "full");
    handle(message: unknown): Promise<JsonObject | undefined>;
    private ok;
    private error;
}
export {};
