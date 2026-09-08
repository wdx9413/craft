import { spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
export const name = "craft-adapter";
export const inject = ["tools"];
function callCraft(command, packageSpec, args, dataDir) {
    return new Promise((resolve, reject) => {
        if (!args.tool?.trim()) {
            reject(new Error("tool must not be empty"));
            return;
        }
        let toolArguments;
        try {
            toolArguments = JSON.parse(args.arguments_json || "{}");
        }
        catch {
            reject(new Error("arguments_json must be valid JSON"));
            return;
        }
        if (!toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments)) {
            reject(new Error("arguments_json must contain a JSON object"));
            return;
        }
        const environment = { ...process.env, ...(dataDir ? { CRAFT_DATA_DIR: dataDir } : {}) };
        const child = spawn(command, ["-y", packageSpec, "craft-mcp"], {
            env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let outputExceeded = false;
        const timer = setTimeout(() => {
            if (!settled) {
                child.kill();
                settled = true;
                reject(new Error("Craft MCP call timed out after 60 seconds"));
            }
        }, 60_000);
        const rejectOnce = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };
        const resolveOnce = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            if (stdout.length > 5_000_000) {
                outputExceeded = true;
                child.kill();
            }
        });
        child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20_000); });
        child.on("error", (error) => rejectOnce(error));
        child.on("close", (code) => {
            if (outputExceeded) {
                rejectOnce(new Error("Craft MCP output exceeded 5 MB"));
                return;
            }
            if (code !== 0 && !stdout) {
                rejectOnce(new Error(stderr || `craft-mcp exited ${code}`));
                return;
            }
            let response;
            try {
                response = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
                    .find((item) => item.id === 2);
            }
            catch {
                rejectOnce(new Error(stderr || "Craft returned invalid MCP output"));
                return;
            }
            if (!response) {
                rejectOnce(new Error(stderr || "Craft returned no tool response"));
                return;
            }
            if (response.error) {
                rejectOnce(new Error(response.error.message));
                return;
            }
            if (response.result?.isError) {
                rejectOnce(new Error(response.result.content?.[0]?.text || "Craft tool call failed"));
                return;
            }
            resolveOnce(response.result?.structuredContent ?? response.result);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dsh-craft-adapter", version: "0.7.1" } } })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: args.tool, arguments: toolArguments } })}\n`);
        child.stdin.end();
    });
}
export function apply(ctx, config = {}) {
    ctx.tools.register(defineTool({
        name: "craft_call",
        description: "Call a Craft MCP tool for capabilities, durable tasks, workflows, evaluations, or evidence.",
        parameters: {
            tool: { type: "string", required: true, description: "Craft MCP tool name." },
            arguments_json: { type: "string", required: false, description: "JSON object containing tool arguments." },
        },
        output: { schema: { type: "object" }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }] },
        execute: (args) => callCraft(config.npxCommand || "npx", config.packageSpec || "craft-agent-harness@0.7.1", args, config.dataDir),
    }));
}
