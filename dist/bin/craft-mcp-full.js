#!/usr/bin/env node
import { serveMcpStdio } from "../src/mcp-stdio.js";
serveMcpStdio({ mode: "full", input: process.stdin, write: (line) => process.stdout.write(line) }).catch(() => { process.stderr.write("Craft full MCP failed to start.\n"); process.exitCode = 1; });
//# sourceMappingURL=craft-mcp-full.js.map