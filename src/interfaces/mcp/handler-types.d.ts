import type { CraftService } from "../../service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";

export type McpHandler = (args: JsonObject) => JsonObject | Promise<JsonObject>;
export type McpHandlerGroup = Record<string, McpHandler>;
export type McpHandlerService = CraftService;
