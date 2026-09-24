#!/usr/bin/env node
import { CraftStore } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { CodexHookBridge, type CodexHookMember } from "../core/codex-hook-bridge.ts";

function member(argv: readonly string[]): CodexHookMember {
  const index = argv.indexOf("--member"); const value = index < 0 ? null : argv[index + 1];
  if (value === "knowledge" || value === "memory" || value === "experience") return value;
  throw new Error("--member must be knowledge, memory, or experience");
}

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
  const input = JSON.parse(raw);
  const store = await new CraftStore().open();
  try { process.stdout.write(`${JSON.stringify(await new CodexHookBridge(await CraftService.open(store)).handle(member(process.argv.slice(2)), input))}\n`); }
  finally { store.close(); }
}

main().catch(() => { process.stdout.write("{}\n"); process.exitCode = 0; });
