import { homedir } from "node:os";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { findClaudeExecutable } from "./claude-executable.ts";
import { workbenchCliEnvironment } from "./workbench-cli-path.ts";

/** Ask the installed CLI for its commands without starting a conversation. */
export async function claudeWorkbenchCommands(workspace: string | null, launch = query, executable = findClaudeExecutable, timeoutMs = 10_000) {
  const directory = workspace || homedir();
  if (!isAbsolute(directory) || !statSync(realpathSync(directory)).isDirectory()) throw new Error("workspace must be an existing absolute directory");
  const controller = new AbortController();
  async function* input() { if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true })); }
  const running = launch({ prompt: input(), options: { cwd: realpathSync(directory), pathToClaudeCodeExecutable: executable(), abortController: controller, persistSession: false, settingSources: ["user", "project", "local"], env: workbenchCliEnvironment(), stderr: () => {} } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([running.supportedCommands(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude command discovery timed out")), timeoutMs); })]);
    if (!Array.isArray(result)) throw new Error("Invalid Claude command list");
    const commands = result.slice(0, 200).filter(item => typeof item?.name === "string" && /^[\w:.-]{1,128}$/u.test(item.name)).map(item => ({ name: item.name, description: typeof item.description === "string" ? item.description.slice(0, 512) : "", builtin: item.builtin === true }));
    return { commands, truncated: result.length > 200 };
  } finally { if (timer) clearTimeout(timer); controller.abort(); running.close(); }
}
