#!/usr/bin/env node
import type { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { HookSignalSanitizer } from "../core/interfaces/codex-hook-signal-sanitizer.ts";
import { randomUUID } from "node:crypto";
import { beginHookRuntimeDiagnostic } from "../core/interfaces/codex-hook-runtime-diagnostics.ts";
import { operationErrorCode } from "../common/craft-common-log/src/index.ts";

type CodexHookMember = "context" | "knowledge" | "memory" | "experience";

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
  const inputReadStarted = performance.now();
  for await (const chunk of process.stdin) raw += String(chunk);
  const inputReadMs = performance.now() - inputReadStarted;
  const inputParseStarted = performance.now();
  const input = JSON.parse(raw);
  const inputParseMs = performance.now() - inputParseStarted;
  const component = member(process.argv.slice(2));
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  let diagnostic: ReturnType<typeof beginHookRuntimeDiagnostic> | undefined;
  try {
    if (["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"].includes(event))
      diagnostic = beginHookRuntimeDiagnostic({ data_root: craftPaths().root, request_id: requestId, member: component,
        event: event as "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "SessionEnd",
        ...(typeof input.session_id === "string" ? { session_id: input.session_id } : {}) });
  } catch { /* Diagnostics must never delay or prevent the Host Hook. */ }
  // Context has no SessionStart work: its bridge deliberately returns an empty
  // result for this event. Keep the content-free runtime receipt, but avoid
  // opening SQLite and constructing the full service for a pure no-op.
  if (component === "context" && event === "SessionStart") {
    process.stdout.write("{}\n");
    diagnostic?.finish({ process_elapsed_ms: process.uptime() * 1_000, input_read_ms: inputReadMs,
      input_parse_ms: inputParseMs, store_open_ms: 0, handler_ms: 0, outcome: "skipped" });
    return;
  }
  // Codex sends every matching Bash call here, including commands that cannot
  // produce a learning signal. Classify these before opening SQLite so the
  // common no-op path pays only process startup and a content-free receipt.
  if (event === "PostToolUse" && !new HookSignalSanitizer().signal(input)) {
    process.stdout.write("{}\n");
    diagnostic?.finish({ process_elapsed_ms: process.uptime() * 1_000, input_read_ms: inputReadMs,
      input_parse_ms: inputParseMs, store_open_ms: 0, handler_ms: 0, outcome: "skipped" });
    return;
  }
  const moduleLoadStarted = performance.now();
  const [{ CraftStore: Store }, { CraftService }, { CodexHookBridge }] = await Promise.all([
    import("../core/infrastructure/store.ts"), import("../core/service.ts"), import("../core/codex-hook-bridge.ts"),
  ]);
  const runtimeImportMs = performance.now() - moduleLoadStarted;
  // Migrations and content-index repair belong to long-lived CLI/MCP startup.
  // A short-lived Host Hook only needs the current schema and normal reads/writes.
  const storeOpenStarted = performance.now();
  let store: CraftStore;
  try { store = await new Store().open({ skipLegacyPartitionMigration: true }); }
  catch (error) {
    diagnostic?.finish({ process_elapsed_ms: process.uptime() * 1_000, input_read_ms: inputReadMs, input_parse_ms: inputParseMs,
      runtime_import_ms: runtimeImportMs, store_open_ms: performance.now() - storeOpenStarted, outcome: "failed", error_code: operationErrorCode(error),
      error_type: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
  const storeOpenMs = performance.now() - storeOpenStarted;
  let handlerMs = 0;
  let serviceOpenMs = 0;
  let outputWriteMs = 0;
  let storeCloseMs = 0;
  let errorType: string | undefined;
  let errorCode: string | undefined;
  let outcome: "completed" | "failed" | undefined = event === "PostToolUse" ? "completed" : undefined;
  let serviceOpenStarted = 0;
  try {
    serviceOpenStarted = performance.now();
    const service = await CraftService.open(store);
    serviceOpenMs = performance.now() - serviceOpenStarted;
    const handlerStarted = performance.now();
    const output = await new CodexHookBridge(service).handle(component, input);
    handlerMs = performance.now() - handlerStarted;
    const outputStarted = performance.now();
    process.stdout.write(`${JSON.stringify(output)}\n`);
    outputWriteMs = performance.now() - outputStarted;
  } catch (error) {
    if (serviceOpenStarted && serviceOpenMs === 0) serviceOpenMs = performance.now() - serviceOpenStarted;
    outcome = "failed";
    errorType = error instanceof Error ? error.name : "unknown";
    errorCode = operationErrorCode(error);
    throw error;
  } finally {
    const closeStarted = performance.now();
    store.close();
    storeCloseMs = performance.now() - closeStarted;
    diagnostic?.finish({ process_elapsed_ms: process.uptime() * 1_000, input_read_ms: inputReadMs, input_parse_ms: inputParseMs,
      runtime_import_ms: runtimeImportMs, store_open_ms: storeOpenMs, service_open_ms: serviceOpenMs,
      handler_ms: handlerMs, output_write_ms: outputWriteMs, store_close_ms: storeCloseMs,
      ...(outcome ? { outcome } : {}),
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(errorType ? { error_type: errorType } : {}) });
  }
}

main().catch(() => { process.stdout.write("{}\n"); process.exitCode = 0; });
