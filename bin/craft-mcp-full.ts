#!/usr/bin/env node
import { serveMcpStdio } from "../core/mcp-stdio.ts";
import { CODEBASE_LSP_WORKER_FLAG, runCodebaseLspWorker } from "../capability/craft-codebase/lsp-worker.ts";

if (process.argv[2] === CODEBASE_LSP_WORKER_FLAG && process.argv.length === 3) {
  runCodebaseLspWorker(process.stdin, line => process.stdout.write(line)).catch(() => { process.stderr.write("Craft Codebase language analysis failed.\n"); process.exitCode = 1; });
} else serveMcpStdio({ mode: "full", input: process.stdin, write: (line) => process.stdout.write(line) }).catch(() => { process.stderr.write("Craft full MCP failed to start.\n"); process.exitCode = 1; });
