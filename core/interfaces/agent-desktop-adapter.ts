import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { CraftStore, JsonObject } from "../infrastructure/store.ts";
import { V01226Runtime } from "../generic-adapter-runtime.ts";
import { workbenchCliEnvironment } from "./workbench-cli-path.ts";

export const AGENT_DESKTOP_ADAPTER_ID = "agent-desktop";
const INSTALL_URL = "https://github.com/vercel-labs/agent-desktop";

export type AgentDesktopStatus = {
  id: "agent-desktop";
  name: "Agent Desktop";
  status: "available" | "not_found" | "error";
  version: string | null;
  executable: string | null;
  install_url: string | null;
  detail: string | null;
};

function executableOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const path = env.PATH ?? env.Path ?? "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`);
      try {
        if (statSync(candidate).isFile()) {
          accessSync(candidate, constants.X_OK);
          return resolve(candidate);
        }
      } catch {
        // Keep looking; PATH entries can be stale.
      }
    }
  }
  return null;
}

export function detectAgentDesktop(env: NodeJS.ProcessEnv = workbenchCliEnvironment()): AgentDesktopStatus {
  try {
    const executable = executableOnPath("agent-desktop", env);
    if (!executable) return { id: AGENT_DESKTOP_ADAPTER_ID, name: "Agent Desktop", status: "not_found",
      version: null, executable: null, install_url: INSTALL_URL, detail: null };
    return { id: AGENT_DESKTOP_ADAPTER_ID, name: "Agent Desktop", status: "available",
      version: null, executable, install_url: null, detail: "command" };
  } catch (error) {
    return { id: AGENT_DESKTOP_ADAPTER_ID, name: "Agent Desktop", status: "error",
      version: null, executable: null, install_url: INSTALL_URL,
      detail: error instanceof Error ? error.message : String(error) };
  }
}

export function registerAgentDesktopAdapter(store: CraftStore, env: NodeJS.ProcessEnv = workbenchCliEnvironment()): JsonObject {
  const status = detectAgentDesktop(env);
  if (status.status !== "available" || !status.executable) return { status, registered: false };
  const manifest = {
    adapter_id: AGENT_DESKTOP_ADAPTER_ID,
    version: "1.0.0",
    kind: "command" as const,
    platforms: ["win32", "darwin", "linux"],
    entry: status.executable,
    transport: "local",
    capabilities: ["snapshot", "find", "click", "type", "scroll", "clipboard", "app", "window"],
    permissions: ["desktop_accessibility"],
    effects: ["read_only", "local_write"],
    metadata: { source: "vercel-labs/agent-desktop", install_url: INSTALL_URL },
  };
  const result = new V01226Runtime(store).adapterRegister(manifest);
  return { status, registered: true, ...result };
}

