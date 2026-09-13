#!/usr/bin/env node
import { serveMcpStdio } from "../src/mcp-stdio.js";
// Default stays "core". `--surface <name>` (or CRAFT_MCP_SURFACE) mounts one
// bounded domain slice instead of the whole 485-tool list; an unknown surface
// fails closed inside McpServer rather than silently widening to full.
const flag = process.argv.indexOf("--surface");
const requested = flag === -1 ? process.env.CRAFT_MCP_SURFACE : process.argv[flag + 1];
const mode = requested && requested.length > 0 ? requested : "core";
serveMcpStdio({ mode, input: process.stdin, write: (line) => process.stdout.write(line) }).catch(() => {
    process.stderr.write("Craft MCP failed to start.\n");
    process.exitCode = 1;
});
//# sourceMappingURL=craft-mcp.js.map