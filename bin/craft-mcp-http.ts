#!/usr/bin/env node
import { serveMcpHttp } from "../src/mcp-http.ts";

const flag = process.argv.indexOf("--surface");
const mode = flag === -1 ? process.env.CRAFT_MCP_SURFACE : process.argv[flag + 1];
const port = Number(process.env.CRAFT_MCP_PORT ?? 8787);
serveMcpHttp({ mode: mode && mode.length > 0 ? mode : "syscall", port }).then(({ server }) => {
  process.stderr.write(`Craft MCP HTTP listening on http://127.0.0.1:${(server.address() as { port: number }).port}/mcp\n`);
}).catch((error) => { process.stderr.write(`Craft MCP HTTP failed to start: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
