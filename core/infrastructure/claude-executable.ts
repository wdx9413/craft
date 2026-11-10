import { accessSync, closeSync, constants, openSync, readFileSync, readSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { workbenchCliPath } from "./cli-path.ts";
import { craftPaths } from "./paths.ts";

function usableFile(file: string): boolean {
  try { return statSync(file).isFile() && Boolean(accessSync(file, constants.X_OK) ?? true); }
  catch { return false; }
}

/** Read the explicit Claude path from the environment or ~/.craft_data/settings.json. */
export function configuredClaudeExecutable(settingsFile = craftPaths().settingsFile): string | null {
  const fromEnvironment = process.env.CRAFT_CLAUDE_EXECUTABLE?.trim();
  if (fromEnvironment) {
    if (!isAbsolute(fromEnvironment)) throw new Error("CRAFT_CLAUDE_EXECUTABLE must be an absolute path");
    return resolve(fromEnvironment);
  }
  try {
    const value = JSON.parse(readFileSync(settingsFile, "utf8").replace(/^\uFEFF/u, "")) as { workbench?: { claudeExecutable?: unknown } };
    const candidate = value?.workbench?.claudeExecutable;
    if (typeof candidate === "string" && candidate.trim() && isAbsolute(candidate.trim())) return resolve(candidate.trim());
  } catch { /* A missing or malformed settings file falls back to PATH discovery. */ }
  return null;
}

/** Prefer a real CLI binary over shell wrappers such as terminal integration shims. */
export function findClaudeExecutable(pathValue = workbenchCliPath(), platform = process.platform, settingsFile = craftPaths().settingsFile): string {
  const configured = configuredClaudeExecutable(settingsFile);
  if (configured !== null) {
    if (!usableFile(configured)) throw Object.assign(new Error(`Configured Claude executable is not usable: ${configured}`), { code: "ENOENT" });
    return configured;
  }
  let wrapper: string | undefined;
  // npm installs a .cmd shim on Windows; the native installer uses claude.exe.
  // Search the real binary first and keep the shim as a fallback.
  const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude.bat", "claude"] : ["claude"];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    if (platform === "win32") {
      // The npm package ships a real binary; it is spawnable, unlike the .cmd shim.
      const packaged = join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (usableFile(packaged)) return packaged;
    }
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        if (platform === "win32" && /\.(?:cmd|bat)$/iu.test(candidate)) { wrapper ??= candidate; continue; }
        const fd = openSync(candidate, "r"); let count: number; const prefix = Buffer.alloc(2);
        try { count = readSync(fd, prefix, 0, 2, 0); } finally { closeSync(fd); }
        if (count === 2 && prefix.toString("ascii") === "#!") { wrapper ??= candidate; continue; }
        return candidate;
      } catch { /* Ignore PATH entries that are absent or inaccessible. */ }
    }
  }
  if (wrapper) return wrapper;
  throw Object.assign(new Error("Claude Code executable was not found in the service PATH"), { code: "ENOENT" });
}
