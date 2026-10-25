#!/usr/bin/env node
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CodexHookBridge, type CodexHookMember } from "../core/codex-hook-bridge.ts";
import { randomUUID } from "node:crypto";
import { beginHookRuntimeDiagnostic } from "../core/interfaces/codex-hook-runtime-diagnostics.ts";

// Hook subprocesses must return control to the Host quickly during write contention.
process.env.CRAFT_HOOK_MODE = "1";

function member(argv: readonly string[]): CodexHookMember {
  const index = argv.indexOf("--member"); const value = index < 0 ? null : argv[index + 1];
  if (value === "context" || value === "knowledge" || value === "memory" || value === "experience") return value;
  throw new Error("--member must be context, knowledge, memory, or experience");
}

async function main(): Promise<void> {
  const requestId = randomUUID();
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
  const input = JSON.parse(raw);
  const component = member(process.argv.slice(2));
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  let diagnostic: ReturnType<typeof beginHookRuntimeDiagnostic> | undefined;
  try {
    if (["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"].includes(event))
      diagnostic = beginHookRuntimeDiagnostic({ data_root: craftPaths().root, request_id: requestId, member: component,
        event: event as "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "SessionEnd",
        ...(typeof input.session_id === "string" ? { session_id: input.session_id } : {}) });
  } catch { /* Diagnostics must never delay or prevent the Host Hook. */ }
  // Migrations and content-index repair belong to long-lived CLI/MCP startup.
  // A short-lived Host Hook only needs the current schema and normal reads/writes.
  const storeOpenStarted = performance.now();
  let store: CraftStore;
  try { store = await new CraftStore().open({ skipLegacyPartitionMigration: true }); }
  catch (error) {
    diagnostic?.finish({ store_open_ms: performance.now() - storeOpenStarted, error_type: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
  const storeOpenMs = performance.now() - storeOpenStarted;
  let handlerMs = 0;
  let errorType: string | undefined;
  try {
    const handlerStarted = performance.now();
    const output = await new CodexHookBridge(await CraftService.open(store)).handle(component, input);
    handlerMs = performance.now() - handlerStarted;
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    errorType = error instanceof Error ? error.name : "unknown";
    throw error;
  } finally {
    store.close();
    diagnostic?.finish({ store_open_ms: storeOpenMs, handler_ms: handlerMs, ...(errorType ? { error_type: errorType } : {}) });
  }
}

main().catch(() => { process.stdout.write("{}\n"); process.exitCode = 0; });
