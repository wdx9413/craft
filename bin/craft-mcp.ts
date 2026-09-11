#!/usr/bin/env node
import { serveMcpStdio } from "../src/mcp-stdio.ts";

serveMcpStdio({ mode: "core", input: process.stdin, write: (line) => process.stdout.write(line) }).catch(() => {
  process.stderr.write("Craft MCP failed to start.\n");
  process.exitCode = 1;
});
