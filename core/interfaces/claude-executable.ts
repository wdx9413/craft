import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { workbenchCliPath } from "./workbench-cli-path.ts";

/** Prefer a real CLI binary over shell wrappers such as terminal integration shims. */
export function findClaudeExecutable(pathValue = workbenchCliPath(), platform = process.platform): string {
  let wrapper: string | undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, platform === "win32" ? "claude.exe" : "claude");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      const fd = openSync(candidate, "r"); let count: number; const prefix = Buffer.alloc(2);
      try { count = readSync(fd, prefix, 0, 2, 0); } finally { closeSync(fd); }
      if (count === 2 && prefix.toString("ascii") === "#!") { wrapper ??= candidate; continue; }
      return candidate;
    } catch { /* Ignore PATH entries that are absent or inaccessible. */ }
  }
  if (wrapper) return wrapper;
  throw Object.assign(new Error("Claude Code executable was not found in the service PATH"), { code: "ENOENT" });
}
