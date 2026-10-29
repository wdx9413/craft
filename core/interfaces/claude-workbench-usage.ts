import { homedir } from "node:os";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { findClaudeExecutable } from "./claude-executable.ts";
import { workbenchCliEnvironment } from "./workbench-cli-path.ts";

/** Read plan limits only; a fresh discovery process does not represent session cost. */
export async function claudeWorkbenchUsage(workspace: string | null, launch = query, executable = findClaudeExecutable, timeoutMs = 10_000) {
  const directory = workspace || homedir();
  if (!isAbsolute(directory) || !statSync(realpathSync(directory)).isDirectory()) throw new Error("workspace must be an existing absolute directory");
  const controller = new AbortController();
  async function* input() { if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true })); }
  const running = launch({ prompt: input(), options: { cwd: realpathSync(directory), pathToClaudeCodeExecutable: executable(), abortController: controller, persistSession: false, settingSources: ["user", "project", "local"], env: workbenchCliEnvironment(), stderr: () => {} } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const method = running.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof method !== "function") return { available: false, windows: [] };
    const result = await Promise.race([method.call(running, { skipBehaviors: true }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude usage discovery timed out")), timeoutMs); })]);
    const limits = result.rate_limits;
    const windows = ([['five_hour', limits?.five_hour], ['seven_day', limits?.seven_day], ['seven_day_opus', limits?.seven_day_opus], ['seven_day_sonnet', limits?.seven_day_sonnet]] as const)
      .flatMap(([id, item]) => item && typeof item.utilization === "number" && Number.isFinite(item.utilization) ? [{ id, used_percent: item.utilization, resets_at: item.resets_at }] : []);
    return { available: result.rate_limits_available === true, windows };
  } finally { if (timer) clearTimeout(timer); controller.abort(); running.close(); }
}
