import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";

export type RepositoryFile = { path: string; digest: string; content: string; language: string };
export type RepositoryFiles = { root: string; state: "ready" | "disabled" | "not_repository"; files: RepositoryFile[]; omitted: number };
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs", ".c", ".h", ".cpp", ".cs", ".rb", ".php"]);
const GENERATED = /(^|\/)(?:node_modules|vendor|dist|build|target|\.git|\.next|\.venv|__pycache__)(\/|$)/u;
const git = (root: string, args: string[], input?: string) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] });

/** Only the current repository is discovered. No parent-directory or home scan. */
export function repositoryRoot(path: unknown): { root: string; isRepository: boolean } {
  if (typeof path !== "string" || !path.trim()) throw new Error("project_root is required");
  const current = realpathSync(path);
  if (!lstatSync(current).isDirectory()) throw new Error("project_root must be a directory");
  try { return { root: realpathSync(git(current, ["rev-parse", "--show-toplevel"]).trim()), isRepository: true }; }
  catch { return { root: current, isRepository: false }; }
}

/** Git ignore rules, local opt-out and bounded source selection precede all content reads. */
export function repositoryFiles(root: string): RepositoryFiles {
  root = realpathSync(root);
  const configPath = join(root, ".craft-codebase.json");
  if (existsSync(configPath) && lstatSync(configPath).isSymbolicLink()) throw new Error("Repository config must be a regular file");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid .craft-codebase.json");
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error("enabled must be boolean");
  const excludes: unknown = config.exclude_paths ?? [];
  if (!Array.isArray(excludes) || excludes.some(p => typeof p !== "string" || !p || isAbsolute(p) || p.includes("\\") || p.split("/").includes(".."))) throw new Error("exclude_paths must contain repository-relative paths");
  if (config.enabled === false || process.env.CRAFT_CODEBASE_AUTO_INDEX === "0") return { root, state: "disabled", files: [], omitted: 0 };
  const paths = [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))].sort();
  // --exclude-standard applies only to untracked paths in ls-files. Recheck
  // tracked paths too, before reading bodies; NUL input preserves legal names.
  let ignored = "";
  try { ignored = git(root, ["check-ignore", "--no-index", "-z", "--stdin"], paths.map(path => `${path}\0`).join("")); }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  const ignoredPaths = new Set(ignored.split("\0"));
  const files: RepositoryFile[] = []; let omitted = 0; let bytes = 0;
  for (const path of paths) {
    if (ignoredPaths.has(path) || !EXTENSIONS.has(extname(path).toLowerCase()) || GENERATED.test(path) || excludes.some(p => path === p || path.startsWith(`${String(p).replace(/\/$/u, "")}/`))) continue;
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    // Reject links, including a symlinked ancestor, before reading source bodies.
    if (!stat.isFile() || realpathSync(absolute) !== absolute || isAbsolute(relative(root, absolute)) || relative(root, absolute).startsWith("..")) { omitted++; continue; }
    if (files.length >= 500 || stat.size > 512 * 1024 || bytes + stat.size > 8 * 1024 * 1024) { omitted++; continue; }
    const content = readFileSync(absolute, "utf8");
    if (content.includes("\0")) { omitted++; continue; }
    bytes += stat.size;
    files.push({ path, content, digest: createHash("sha256").update(content).digest("hex"), language: extname(path).slice(1) });
  }
  return { root, state: "ready", files, omitted };
}
