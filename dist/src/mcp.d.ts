import { CraftService } from "./service.ts";
import { type JsonObject } from "./store.ts";
type Tool = {
    name: string;
    description: string;
    inputSchema: JsonObject;
    annotations?: JsonObject;
};
export declare const TOOLS: Tool[];
export declare class McpServer {
    readonly service: CraftService;
    readonly handlers: Record<string, (args: JsonObject) => JsonObject | Promise<JsonObject>>;
    constructor(service: CraftService);
    handle(message: unknown): Promise<JsonObject | undefined>;
    private ok;
    private error;
}
export {};
