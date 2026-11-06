import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { workbenchCliPath } from "./cli-path.ts";
import { craftPaths } from "./paths.ts";

/** Locate a directly executable Windows binary, including the official npm package. */
function usableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read the explicit Codex path from the environment or ~/.craft_data/settings.json. */
export function configuredCodexExecutable(settingsFile = craftPaths().settingsFile): string | null {
  const fromEnvironment = process.env.CRAFT_CODEX_EXECUTABLE?.trim();
  if (fromEnvironment) {
    if (!isAbsolute(fromEnvironment)) throw new Error("CRAFT_CODEX_EXECUTABLE must be an absolute path");
    return resolve(fromEnvironment);
  }
  try {
    const value = JSON.parse(readFileSync(settingsFile, "utf8").replace(/^\uFEFF/u, "")) as { workbench?: { codexExecutable?: unknown } };
    const candidate = value?.workbench?.codexExecutable;
    if (typeof candidate === "string" && candidate.trim() && isAbsolute(candidate.trim())) return resolve(candidate.trim());
  } catch { /* A missing or malformed settings file falls back to PATH discovery. */ }
  return null;
}

/** Prefer the configured executable; fall back to the PATH/npm-package search. */
export function resolveCodexExecutable(
  pathValue = workbenchCliPath(), platform = process.platform, arch = process.arch,
  settingsFile = craftPaths().settingsFile,
): string {
  const configured = configuredCodexExecutable(settingsFile);
  if (configured !== null) {
    if (!usableFile(configured)) throw Object.assign(new Error(`Configured Codex executable is not usable: ${configured}`), { code: "ENOENT" });
    return configured;
  }
  return findCodexExecutable(pathValue, platform, arch);
}

export function findCodexExecutable(pathValue = workbenchCliPath(), platform = process.platform, arch = process.arch): string {
  if (platform !== "win32") return "codex";
  const triple = arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const direct = join(directory, "codex.exe");
    if (usableFile(direct)) return direct;
    if (!triple) continue;
    const packageRoot = join(directory, "node_modules", "@openai", "codex");
    const req = createRequire(join(packageRoot, "package.json"));
    let vendor: string;
    try { vendor = join(req.resolve(`@openai/codex-win32-${arch}/package.json`), "..", "vendor"); }
    catch { vendor = join(packageRoot, "vendor"); }
    const binary = join(vendor, triple, "bin", "codex.exe");
    if (usableFile(binary)) return binary;
  }
  throw Object.assign(new Error("Codex executable was not found in the service PATH"), { code: "ENOENT" });
}
