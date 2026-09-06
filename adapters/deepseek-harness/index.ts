import { spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "craft-adapter";
export const inject = ["tools"];
type AdapterConfig = { npxCommand?: string; packageSpec?: string; dataDir?: string };
type ToolArgs = { tool: string; arguments_json?: string };
type Context = { tools: { register(tool: unknown): void } };

function callCraft(command: string, packageSpec: string, args: ToolArgs, dataDir?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ...(dataDir ? { CRAFT_DATA_DIR: dataDir } : {}) };
    const child = spawn(command, ["-y", packageSpec, "craft-mcp"], {
      env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !stdout) { reject(new Error(stderr || `craft-mcp exited ${code}`)); return; }
      const response = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        .find((item) => item.id === 2);
      if (!response) { reject(new Error(stderr || "Craft returned no tool response")); return; }
      if (response.error) { reject(new Error(response.error.message)); return; }
      resolve(response.result?.structuredContent ?? response.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dsh-craft-adapter", version: "0.2.0" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: args.tool, arguments: JSON.parse(args.arguments_json || "{}") } })}\n`);
    child.stdin.end();
  });
}

export function apply(ctx: Context, config: AdapterConfig = {}): void {
  ctx.tools.register(defineTool({
    name: "craft_call",
    description: "Call a Craft MCP tool for capabilities, durable tasks, workflows, evaluations, or evidence.",
    parameters: {
      tool: { type: "string", required: true, description: "Craft MCP tool name." },
      arguments_json: { type: "string", required: false, description: "JSON object containing tool arguments." },
    },
    output: { schema: { type: "object" }, render: (_args: unknown, value: unknown) =>
      [{ type: "text", text: JSON.stringify(value, null, 2) }] },
    execute: (args: ToolArgs) => callCraft(config.npxCommand || "npx",
      config.packageSpec || "craft-agent-harness@0.2.0", args, config.dataDir),
  }));
}
