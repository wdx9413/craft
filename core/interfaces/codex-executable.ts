import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join } from "node:path";
import { workbenchCliPath } from "./workbench-cli-path.ts";

/** Locate a directly executable Windows binary, including the official npm package. */
export function findCodexExecutable(pathValue = workbenchCliPath(), platform = process.platform, arch = process.arch): string {
  if (platform !== "win32") return "codex";
  const triple = arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : "";
  const usable = (file: string) => { try { if (!statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true; } catch { return false; } };
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const direct = join(directory, "codex.exe");
    if (usable(direct)) return direct;
    if (!triple) continue;
    const packageRoot = join(directory, "node_modules", "@openai", "codex");
    const req = createRequire(join(packageRoot, "package.json"));
    let vendor: string;
    try { vendor = join(req.resolve(`@openai/codex-win32-${arch}/package.json`), "..", "vendor"); }
    catch { vendor = join(packageRoot, "vendor"); }
    const binary = join(vendor, triple, "bin", "codex.exe");
    if (usable(binary)) return binary;
  }
  throw Object.assign(new Error("Codex executable was not found in the service PATH"), { code: "ENOENT" });
}
