#!/usr/bin/env node
import { serveMcpStdio } from "../src/mcp-stdio.ts";
import { resolveMcpProductMode } from "../src/interfaces/mcp/product-launch.ts";

// `--product` is the stable public entry point. `--surface` remains an
// intentionally explicit compatibility seam for existing integrations.
let mode: string;
try { mode = resolveMcpProductMode(process.argv.slice(2), process.env); }
catch (error) {
  process.stderr.write(`Craft MCP failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  mode = "";
}

if (mode) serveMcpStdio({ mode, input: process.stdin, write: (line) => process.stdout.write(line) }).catch(() => {
  process.stderr.write("Craft MCP failed to start.\n");
  process.exitCode = 1;
});
