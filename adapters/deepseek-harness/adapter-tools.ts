import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exchange, type Launch } from "./mcp-client.ts";

export type AdapterConfig = { product?: string; npxCommand?: string; packageSpec?: string; dataDir?: string; bundlePath?: string };
type ToolArgs = { tool: string; arguments_json?: string };

export function adapterTools(config: AdapterConfig = {}, moduleUrl = import.meta.url) {
  const adapterVersion = process.env.npm_package_version;
  const product = config.product ?? "context";
  if (!["context", "knowledge", "memory", "experience", "codebase", "full"].includes(product)) throw new Error("Unknown Craft product");
  const bundled = fileURLToPath(new URL("../runtime/craft-mcp.cjs", moduleUrl));
  const bundle = config.bundlePath ?? (existsSync(bundled) ? bundled : null);
  const launch: Launch = {
    command: bundle ? process.execPath : config.npxCommand ?? "npx",
    args: bundle ? [bundle, "--product", product] : ["-y", config.packageSpec ?? (adapterVersion ? `craft-agent-harness@${adapterVersion}` : "craft-agent-harness"), "craft-mcp", "--product", product],
    env: { ...process.env, ...(config.dataDir ? { CRAFT_DATA_DIR: config.dataDir } : {}) },
  };
  const render = (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }];
  return [
    { name: `craft_${product}_tools`, description: `Discover the actual ${product} MCP tools and JSON schemas before calling them.`, parameters: {}, output: { schema: { type: "object" }, render }, execute: async () => {
      const result = await exchange(launch, "tools/list");
      const skillPath = fileURLToPath(new URL(`../skills/craft-${product}/SKILL.md`, moduleUrl));
      return { ...result, skill: existsSync(skillPath) ? readFileSync(skillPath, "utf8") : null };
    } },
    { name: `craft_${product}_call`, description: `Call one discovered ${product} tool with its exact JSON arguments. Follow the bundled craft-${product} Skill.`,
      parameters: { tool: { type: "string", required: true, description: "Discovered MCP tool name" }, arguments_json: { type: "string", required: false, description: "JSON object matching the discovered inputSchema" } },
      output: { schema: { type: "object" }, render }, execute: (args: ToolArgs) => {
        if (!args.tool?.trim()) throw new Error("tool must not be empty");
        const input = JSON.parse(args.arguments_json ?? "{}");
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("arguments_json must contain a JSON object");
        return exchange(launch, "tools/call", { name: args.tool, arguments: input });
      } },
  ];
}
