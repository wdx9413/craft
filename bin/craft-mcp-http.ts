#!/usr/bin/env node
import { serveMcpHttp } from "../core/mcp-http.ts";
import { resolveMcpProductMode } from "../core/interfaces/mcp/product-launch.ts";

const port = Number(process.env.CRAFT_MCP_PORT ?? 8787);
let mode: string;
try { mode = resolveMcpProductMode(process.argv.slice(2), process.env); }
catch (error) {
  process.stderr.write(`Craft MCP HTTP failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  mode = "";
}
if (mode) serveMcpHttp({ mode, port }).then(({ server }) => {
  process.stderr.write(`Craft MCP HTTP listening on http://127.0.0.1:${(server.address() as { port: number }).port}/mcp\n`);
}).catch((error) => { process.stderr.write(`Craft MCP HTTP failed to start: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
