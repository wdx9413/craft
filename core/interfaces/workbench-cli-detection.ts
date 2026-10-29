import { execFile } from "node:child_process";
import { findClaudeExecutable } from "./claude-executable.ts";
import { findCodexExecutable } from "./codex-executable.ts";
import { workbenchCliEnvironment } from "./workbench-cli-path.ts";

type Probe = (command: string) => Promise<string>;
const providers = [
  { id: "codex", name: "Codex CLI", command: "codex", install_url: "https://developers.openai.com/codex/cli/" },
  { id: "claude", name: "Claude Code", command: "claude", install_url: "https://code.claude.com/docs/en/setup" },
] as const;

function probe(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = command === "claude" ? findClaudeExecutable() : findCodexExecutable();
    execFile(executable, ["--version"], { timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true, shell: false, env: workbenchCliEnvironment() }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

/** Probe the same PATH and no-shell execution environment used by the runtime. */
export async function detectWorkbenchClis(run: Probe = probe) {
  return { providers: await Promise.all(providers.map(async provider => {
    try {
      const version = (await run(provider.command)).trim().slice(0, 256);
      if (!version) return { ...provider, status: "error", version: null };
      return { ...provider, status: "available", version };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      return { ...provider, status: code === "ENOENT" ? "not_found" : "error", version: null };
    }
  })) };
}
