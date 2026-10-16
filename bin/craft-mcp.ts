#!/usr/bin/env node
import { serveMcpStdio } from "../core/mcp-stdio.ts";
import { resolveMcpProductMode } from "../core/interfaces/mcp/product-launch.ts";
import { startContextLearningWorker } from "../core/interfaces/learning-worker-supervisor.ts";
import { CODEBASE_LSP_WORKER_FLAG, runCodebaseLspWorker } from "../capability/craft-codebase/lsp-worker.ts";

if (process.argv[2] === CODEBASE_LSP_WORKER_FLAG && process.argv.length === 3) {
  runCodebaseLspWorker(process.stdin, line => process.stdout.write(line)).catch(() => {
    process.stderr.write("Craft Codebase language analysis failed.\n");
    process.exitCode = 1;
  });
} else {

// `--product` is the stable public entry point. `--surface` remains an
// intentionally explicit compatibility seam for existing integrations.
let mode: string;
try { mode = resolveMcpProductMode(process.argv.slice(2), process.env); }
catch (error) {
  process.stderr.write(`Craft MCP failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  mode = "";
}

if (mode) serveMcpStdio({ mode, input: process.stdin, write: (line) => process.stdout.write(line), afterStart: () => {
  return startContextLearningWorker({ mode, server_entrypoint: process.argv[1], env: process.env,
    on_failure: reason => process.stderr.write(`Craft ${mode} learning worker stopped (${reason}).\n`) });
} }).catch(() => {
  process.stderr.write("Craft MCP failed to start.\n");
  process.exitCode = 1;
});
}
