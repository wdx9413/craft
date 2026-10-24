import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { blankResult, FAILURE, handleHook, hidden, type Event, type HookInput, type Host } from "../capability/craft-datasec/hook.ts";
import { DEFAULT_RULES, type Rule } from "../capability/craft-datasec/rules.ts";

export interface HookCliResult { exitCode: number; stdout?: string; stderr?: string }

export function runDataSecHookCli(args: string[], raw: string, env: NodeJS.ProcessEnv = process.env): HookCliResult {
  const [host, event] = args as [Host, Event];
  if (!(["claude", "codex"] as string[]).includes(host) || !(["PreToolUse", "PostToolUse", "UserPromptSubmit"] as string[]).includes(event)) {
    return { exitCode: 2, stderr: "craft-datasec: expected <claude|codex> <PreToolUse|PostToolUse|UserPromptSubmit>\n" };
  }
  let input: HookInput = {};
  try {
    input = JSON.parse(raw) as HookInput;
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid event");
    const config = env.CRAFT_DATASEC_RULES;
    const rules = config ? JSON.parse(readFileSync(config, "utf8")) as Rule[] : DEFAULT_RULES;
    const root = env.CRAFT_DATASEC_DIR ?? join(homedir(), ".craft-datasec");
    return { exitCode: 0, stdout: `${JSON.stringify(handleHook(host, event, input, root, rules))}\n` };
  } catch {
    const fallback = event === "PostToolUse" ? hidden(host, FAILURE, blankResult(input?.tool_response ?? null))
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

const result = runIfInvoked(process.argv[1], fileURLToPath(import.meta.url), () =>
  runDataSecHookCli(process.argv.slice(2), readFileSync(0, "utf8")));
writeCliResult(result, process.stdout, process.stderr);
