import { defineTool } from "@deepseek-ai/dsh-tools";
import { adapterTools, type AdapterConfig } from "./adapter-tools.ts";
export const name = "craft-adapter";
export const inject = ["tools"];
export function apply(ctx: { tools: { register(tool: unknown): void } }, config: AdapterConfig = {}): void {
  for (const tool of adapterTools(config)) ctx.tools.register(defineTool(tool));
}
