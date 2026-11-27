#!/usr/bin/env node
import { serveMcpStdio } from "../core/mcp-stdio.ts";
import { resolveMcpProductMode } from "../core/interfaces/mcp/product-launch.ts";
import { startContextLearningWorker } from "../core/interfaces/learning-worker-supervisor.ts";
import { startExperienceAssetWorker } from "../core/interfaces/experience-asset-worker.ts";
import { TRACE_RETENTION_WORKER_FLAG, runTraceRetentionMaintenance, startConfiguredTraceRetentionWorker } from "../core/interfaces/trace-retention-worker.ts";
import { CODEBASE_LSP_WORKER_FLAG, runCodebaseLspWorkerSafely } from '@craft/capability-codebase/lsp-worker';
import { startContextSupervisor } from "../core/interfaces/context-supervisor.ts";

if (process.argv[2] === CODEBASE_LSP_WORKER_FLAG && process.argv.length === 3) {
  runCodebaseLspWorkerSafely(process.stdin, line => process.stdout.write(line));
} else if (process.argv[2] === TRACE_RETENTION_WORKER_FLAG && process.argv.length === 3) {
  runTraceRetentionMaintenance().catch(() => { process.stderr.write("Craft Trace retention worker failed.\n"); process.exitCode = 1; });
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

if (mode) serveMcpStdio({ mode, input: process.stdin, write: (line) => process.stdout.write(line), afterStart: async server => {
  const service = server.service;
  if (!service) throw new Error("Craft MCP service is unavailable after startup");
  let stopSupervisor: (() => Promise<void>) | undefined;
  if (mode === "syscall" || mode === "full" || mode.startsWith("component-context-")) {
    stopSupervisor = await startContextSupervisor(service);
  }
  try {
    const stopLearning = await startContextLearningWorker({ mode, server_entrypoint: process.argv[1], env: process.env,
      on_failure: reason => process.stderr.write(`Craft ${mode} learning worker stopped (${reason}).\n`) });
    const owned = service.capabilityOwned === true;
    const ownerServices = service.ownerServices;
    const runtimeService = owned ? ownerServices.get("runtime") ?? (service.storageOwner === "runtime" ? service : undefined) : service;
    const experienceService = owned ? ownerServices.get("experience") ?? (service.storageOwner === "experience" ? service : undefined) : service;
    const stopTraceRetention = startConfiguredTraceRetentionWorker(runtimeService,
      process.env, () => process.stderr.write(`Craft ${mode} Trace retention maintenance failed.\n`));
    try {
      const stopAssetMigration = await startExperienceAssetWorker(experienceService, { enabled: process.env.CRAFT_EXPERIENCE_ASSET_MIGRATION !== "0",
        on_failure: () => process.stderr.write(`Craft ${mode} Experience asset migration failed.\n`) });
      return async () => { await stopAssetMigration(); stopTraceRetention(); await stopLearning?.(); await stopSupervisor?.(); };
    } catch (error) { stopTraceRetention(); await stopLearning?.(); throw error; }
  } catch (error) { await stopSupervisor?.(); throw error; }
} }).catch(() => {
  process.stderr.write("Craft MCP failed to start.\n");
  process.exitCode = 1;
});
}
