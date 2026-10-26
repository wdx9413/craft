import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { beginHookRuntimeDiagnostic, type HookRuntimeTiming } from "../core/interfaces/codex-hook-runtime-diagnostics.ts";
import { blankResult, FAILURE, handleHook, hidden, type Event, type HookInput, type Host } from "../capability/craft-datasec/hook.ts";
import { DEFAULT_RULES, type Rule } from "../capability/craft-datasec/rules.ts";

export interface HookCliResult { exitCode: number; stdout?: string; stderr?: string }

export function runDataSecHookCli(args: string[], raw: string, env: NodeJS.ProcessEnv = process.env,
  onTiming?: (stage: "input_parse_ms" | "rules_load_ms" | "handler_ms", durationMs: number) => void): HookCliResult {
  const [host, event] = args as [Host, Event];
  if (!(["claude", "codex"] as string[]).includes(host) || !(["PreToolUse", "PostToolUse", "UserPromptSubmit"] as string[]).includes(event)) {
    return { exitCode: 2, stderr: "craft-datasec: expected <claude|codex> <PreToolUse|PostToolUse|UserPromptSubmit>\n" };
  }
  let input: HookInput = {};
  try {
    const parseStarted = performance.now();
    input = JSON.parse(raw) as HookInput;
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid event");
    onTiming?.("input_parse_ms", performance.now() - parseStarted);
    const rulesStarted = performance.now();
    const config = env.CRAFT_DATASEC_RULES;
    const rules = event === "UserPromptSubmit" ? [] : config ? JSON.parse(readFileSync(config, "utf8")) as Rule[] : DEFAULT_RULES;
    onTiming?.("rules_load_ms", performance.now() - rulesStarted);
    const root = env.CRAFT_DATASEC_DIR ?? join(homedir(), ".craft-datasec");
    const handlerStarted = performance.now();
    let output: object;
    try { output = handleHook(host, event, input, root, rules); }
    finally { onTiming?.("handler_ms", performance.now() - handlerStarted); }
    return { exitCode: 0, stdout: `${JSON.stringify(output)}\n` };
  } catch {
    const fallback = event === "PostToolUse"
      ? { ...hidden(host, FAILURE, blankResult(input?.tool_response ?? null)), ...(host === "claude" ? { continue: false, stopReason: FAILURE } : {}) }
      : handleHook(host, event, {}, "", []);
    return { exitCode: 0, stdout: `${JSON.stringify(fallback)}\n` };
  }
}

/** Makes the executable entrypoint decision testable without reading a real Host's stdin. */
export function runIfInvoked(argv1: string | undefined, modulePath: string, run: () => HookCliResult): HookCliResult | null {
  return argv1 && resolve(argv1) === resolve(modulePath) ? run() : null;
}

export function writeCliResult(result: HookCliResult | null, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): void {
  if (!result) return;
  if (result.stderr) stderr.write(result.stderr);
  if (result.stdout) stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}

let diagnostic: ReturnType<typeof beginHookRuntimeDiagnostic> | undefined;
let inputReadMs = 0;
let inputBytes = 0;
const timings: { input_parse_ms?: number; rules_load_ms?: number; handler_ms?: number } = {};
const result = runIfInvoked(process.argv[1], fileURLToPath(import.meta.url), () => {
  const args = process.argv.slice(2), [host, event] = args;
  if (!(host === "claude" || host === "codex") || !(event === "PreToolUse" || event === "PostToolUse" || event === "UserPromptSubmit")) {
    return runDataSecHookCli(args, readFileSync(0, "utf8"));
  }
  try { diagnostic = beginHookRuntimeDiagnostic({ data_root: craftPaths().root, request_id: randomUUID(), member: "datasec", event }); }
  catch { /* Diagnostics must never delay or prevent the Host Hook. */ }
  const readStarted = performance.now();
  const raw = readFileSync(0, "utf8");
  inputReadMs = performance.now() - readStarted;
  inputBytes = Buffer.byteLength(raw);
  return runDataSecHookCli(args, raw, process.env, (stage, durationMs) => { timings[stage] = durationMs; });
});
const outputStarted = performance.now();
writeCliResult(result, process.stdout, process.stderr);
diagnostic?.finish({ process_elapsed_ms: process.uptime() * 1_000, input_read_ms: inputReadMs, input_bytes: inputBytes,
  input_parse_ms: timings.input_parse_ms, rules_load_ms: timings.rules_load_ms, handler_ms: timings.handler_ms,
  output_write_ms: performance.now() - outputStarted, outcome: "completed" });
