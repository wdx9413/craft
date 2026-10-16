#!/usr/bin/env node
import { serveMcpHttp } from "../core/mcp-http.ts";
import { resolveMcpProductMode } from "../core/interfaces/mcp/product-launch.ts";
import { CODEBASE_LSP_WORKER_FLAG, runCodebaseLspWorker } from "../capability/craft-codebase/lsp-worker.ts";

if (process.argv[2] === CODEBASE_LSP_WORKER_FLAG && process.argv.length === 3) {
  runCodebaseLspWorker(process.stdin, line => process.stdout.write(line)).catch(() => { process.stderr.write("Craft Codebase language analysis failed.\n"); process.exitCode = 1; });
} else {
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
}
