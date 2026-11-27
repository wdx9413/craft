#!/usr/bin/env node
import { serveMcpStdio } from "../core/mcp-stdio.ts";
import { CODEBASE_LSP_WORKER_FLAG, runCodebaseLspWorker } from '@craft/capability-codebase/lsp-worker';
import { startContextSupervisor } from "../core/interfaces/context-supervisor.ts";

if (process.argv[2] === CODEBASE_LSP_WORKER_FLAG && process.argv.length === 3) {
  runCodebaseLspWorker(process.stdin, line => process.stdout.write(line)).catch(() => { process.stderr.write("Craft Codebase language analysis failed.\n"); process.exitCode = 1; });
} else serveMcpStdio({ mode: "full", input: process.stdin, write: (line) => process.stdout.write(line), afterStart: async server => {
  if (!server.service) throw new Error("Craft MCP service is unavailable after startup");
  return await startContextSupervisor(server.service);
} }).catch(() => { process.stderr.write("Craft full MCP failed to start.\n"); process.exitCode = 1; });
