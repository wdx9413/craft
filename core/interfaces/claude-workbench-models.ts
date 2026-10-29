import { homedir } from "node:os";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { findClaudeExecutable } from "./claude-executable.ts";
import { workbenchCliEnvironment } from "./workbench-cli-path.ts";

/** Discover the CLI's own catalog without sending a prompt or creating a persisted session. */
export async function claudeWorkbenchModels(workspace: string | null, launch = query, executable = findClaudeExecutable, timeoutMs = 10_000) {
  const directory = workspace || homedir();
  if (!isAbsolute(directory) || !statSync(realpathSync(directory)).isDirectory()) throw new Error("workspace must be an existing absolute directory");
  const controller = new AbortController();
  async function* input() { if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true })); }
  const running = launch({ prompt: input(), options: { cwd: realpathSync(directory), pathToClaudeCodeExecutable: executable(), abortController: controller, persistSession: false, settingSources: ["user", "project", "local"], env: workbenchCliEnvironment(), stderr: () => {} } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([running.supportedModels(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude model discovery timed out")), timeoutMs); })]);
    if (!Array.isArray(result)) throw new Error("Invalid Claude model list");
    const models = result.slice(0, 100).filter(item => typeof item?.value === "string" && item.value.length > 0 && item.value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(item.value)).map(item => ({ id: item.value, name: typeof item.displayName === "string" ? item.displayName.slice(0, 256) : item.value, description: typeof item.description === "string" ? item.description.slice(0, 512) : "", is_default: item.value === "default" }));
    return { models, truncated: result.length > 100 };
  } finally { if (timer) clearTimeout(timer); controller.abort(); running.close(); }
}
