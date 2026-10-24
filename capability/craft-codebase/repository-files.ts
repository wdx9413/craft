import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export type RepositoryFile = { path: string; digest: string; content: string; language: string; file_version?: string };
export type RepositoryContextFile = { path: string; digest: string; content: string; file_version?: string };
export type RepositoryFiles = { root: string; state: "ready" | "disabled" | "not_repository"; files: RepositoryFile[]; context_files: RepositoryContextFile[]; context_files_omitted: number; omitted: number; omitted_by_language: Record<string, number> };
const LANGUAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "typescript-javascript": [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  python: [".py"], java: [".java"], go: [".go"], rust: [".rs"], "c-cpp": [".c", ".h", ".cc", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".cpp", ".mm", ".m"],
  csharp: [".cs"], ruby: [".rb"], php: [".php"], jvm: [".kt", ".kts", ".scala", ".sc", ".groovy"],
  swift: [".swift"], dart: [".dart"], lua: [".lua"], shell: [".sh", ".bash"], elixir: [".ex", ".exs"],
  haskell: [".hs", ".lhs"], ocaml: [".ml", ".mli"], clojure: [".clj", ".cljs", ".cljc", ".edn"], perl: [".pl", ".pm"],
  r: [".r"], julia: [".jl"], zig: [".zig"], elm: [".elm"], erlang: [".erl", ".hrl"], fsharp: [".fs", ".fsi", ".fsx"],
  solidity: [".sol"], terraform: [".tf", ".tfvars", ".hcl"], nix: [".nix"], web: [".vue", ".svelte", ".astro", ".html", ".css", ".scss", ".sass", ".less"],
  sql: [".sql"], powershell: [".ps1", ".psm1"], protobuf: [".proto"], config: [".toml", ".yaml", ".yml"],
});
const LANGUAGE_GROUPS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  Object.entries(LANGUAGE_EXTENSIONS).flatMap(([group, extensions]) => extensions.map(extension => [extension, group])),
));
const EXTENSIONS = new Set(Object.keys(LANGUAGE_GROUPS));
const GENERATED = /(^|\/)(?:node_modules|vendor|dist|build|target|\.git|\.craft_data|\.next|venv|\.venv|virtualenv|__pycache__)(\/|$)/u;
const MAX_FILES = 1200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const GO_CONTEXT_FILES = new Set(["go.mod", "go.sum", "go.work", "go.work.sum"]);
const MAX_CONTEXT_FILE_BYTES = 512 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 1024 * 1024;
const git = (root: string, args: string[], input?: string) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] });
const fileVersion = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

/** Digest only repository selection policy, without reading source bodies. */
export function repositoryPolicyDigest(root: string): string {
  root = realpathSync(root);
  const configPath = join(root, ".craft-codebase.json");
  let config = "missing";
  if (existsSync(configPath)) {
    const stat = lstatSync(configPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Repository config must be a regular file");
    config = createHash("sha256").update(readFileSync(configPath)).digest("hex");
  }
  const paths = [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))].sort();
  const policyFiles = paths.filter(path => path === ".gitignore" || path.endsWith("/.gitignore"));
  const infoExclude = resolve(root, git(root, ["rev-parse", "--git-path", "info/exclude"]).trim());
  const configured = (() => {
    try { return git(root, ["config", "--path", "--get-all", "core.excludesfile"]).split(/\r?\n/u).filter(Boolean); }
    catch (error) { if ((error as { status?: number }).status === 1) return []; throw error; }
  })();
  const defaultExclude = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "ignore");
  const fileDigest = (path: string): string => {
    try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  };
  const ignores = [...new Set([...policyFiles.map(path => join(root, path)), infoExclude, ...configured.map(path => resolve(root, path)), defaultExclude])]
    .sort().map(path => [path, fileDigest(path)]);
  return createHash("sha256").update(JSON.stringify({ config, ignores, auto_index: process.env.CRAFT_CODEBASE_AUTO_INDEX ?? null })).digest("hex");
}

function hasSymlinkPath(root: string, path: string): boolean {
  let current = root;
  for (const component of path.split("/")) {
    current = join(current, component);
    try { if (lstatSync(current).isSymbolicLink()) return true; }
    catch { return false; }
  }
  return false;
}

/** Only the current repository is discovered. No parent-directory or home scan. */
export function repositoryRoot(path: unknown): { root: string; isRepository: boolean } {
  if (typeof path !== "string" || !path.trim()) throw new Error("project_root is required");
  const current = realpathSync(path);
  if (!lstatSync(current).isDirectory()) throw new Error("project_root must be a directory");
  try { return { root: realpathSync(git(current, ["rev-parse", "--show-toplevel"]).trim()), isRepository: true }; }
  catch { return { root: current, isRepository: false }; }
}

/** Git ignore rules, local opt-out and language-balanced bounded source selection precede content reads. */
export function repositoryFiles(root: string, _query = ""): RepositoryFiles {
  root = realpathSync(root);
  const configPath = join(root, ".craft-codebase.json");
  if (existsSync(configPath) && lstatSync(configPath).isSymbolicLink()) throw new Error("Repository config must be a regular file");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid .craft-codebase.json");
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error("enabled must be boolean");
  const excludes: unknown = config.exclude_paths ?? [];
  if (!Array.isArray(excludes) || excludes.some(p => typeof p !== "string" || !p || isAbsolute(p) || p.includes("\\") || p.split("/").includes(".."))) throw new Error("exclude_paths must contain repository-relative paths");
  if (config.enabled === false || process.env.CRAFT_CODEBASE_AUTO_INDEX === "0") return { root, state: "disabled", files: [], context_files: [], context_files_omitted: 0, omitted: 0, omitted_by_language: {} };
  const paths = [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))].sort();
  const symlinkPaths = new Set(paths.filter(path => {
    const extension = extname(path).toLowerCase();
    return EXTENSIONS.has(extension) && !GENERATED.test(path)
      && !excludes.some(p => path === p || path.startsWith(`${String(p).replace(/\/$/u, "")}/`))
      && hasSymlinkPath(root, path);
  }));
  // --exclude-standard applies only to untracked paths in ls-files. Recheck
  // tracked paths too, before reading bodies; NUL input preserves legal names.
  let ignored = "";
  try { ignored = git(root, ["check-ignore", "--no-index", "-z", "--stdin"], paths.filter(path => !symlinkPaths.has(path)).map(path => `${path}\0`).join("")); }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  const ignoredPaths = new Set(ignored.split("\0"));
  const context_files: RepositoryContextFile[] = [];
  let contextFilesBytes = 0, context_files_omitted = 0;
  for (const path of paths) {
    if (!GO_CONTEXT_FILES.has(path.split("/").pop()!) || ignoredPaths.has(path)
      || GENERATED.test(path) || excludes.some(p => path === p || path.startsWith(`${String(p).replace(/\/$/u, "")}/`))) continue;
    const absolute = join(root, path);
    if (!existsSync(absolute) || hasSymlinkPath(root, path)) { context_files_omitted++; continue; }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > MAX_CONTEXT_FILE_BYTES || contextFilesBytes + stat.size > MAX_CONTEXT_TOTAL_BYTES) { context_files_omitted++; continue; }
    const content = readFileSync(absolute, "utf8");
    if (content.includes("\0")) { context_files_omitted++; continue; }
    contextFilesBytes += stat.size;
    context_files.push({ path, content, digest: createHash("sha256").update(content).digest("hex"), file_version: fileVersion(stat) });
  }
  // A task query changes a Context view, never the repository fact snapshot.
  // Keep the bounded source set stable across Hosts and repeated queries.
  const candidates = new Map<string, Array<{ path: string; absolute: string; size: number; extension: string; file_version: string }>>();
  const omitted_by_language: Record<string, number> = {};
  const omit = (extension: string): void => {
    const group = LANGUAGE_GROUPS[extension]!;
    omitted_by_language[group] = (omitted_by_language[group] ?? 0) + 1;
  };
  for (const path of paths) {
    const extension = extname(path).toLowerCase();
    if (ignoredPaths.has(path) || !EXTENSIONS.has(extension) || GENERATED.test(path) || excludes.some(p => path === p || path.startsWith(`${String(p).replace(/\/$/u, "")}/`))) continue;
    const absolute = join(root, path);
    if (!existsSync(absolute)) { if (symlinkPaths.has(path)) omit(extension); continue; }
    const stat = lstatSync(absolute);
    // Reject links, including a symlinked ancestor, before reading source bodies.
    if (!stat.isFile() || hasSymlinkPath(root, path)) { omit(extension); continue; }
    if (stat.size > MAX_FILE_BYTES) { omit(extension); continue; }
    const group = LANGUAGE_GROUPS[extension]!;
    const queue = candidates.get(group) ?? [];
    queue.push({ path, absolute, size: stat.size, extension, file_version: fileVersion(stat) });
    candidates.set(group, queue);
  }
  // Rotate across language families before applying the shared file/byte limits.
  // This keeps a large TypeScript tree from consuming the entire snapshot before
  // later-sorting Java, Go, Rust, Python, or C/C++ sources are considered.
  const groups = [...candidates.keys()].sort();
  const cursors = new Map(groups.map(group => [group, 0]));
  const files: RepositoryFile[] = [];
  let bytes = 0;
  let progressed = true;
  while (files.length < MAX_FILES && bytes < MAX_TOTAL_BYTES && progressed) {
    progressed = false;
    for (const group of groups) {
      if (bytes >= MAX_TOTAL_BYTES) break;
      const queue = candidates.get(group)!;
      const cursor = cursors.get(group)!;
      if (cursor >= queue.length) continue;
      progressed = true;
      const candidate = queue[cursor]!;
      cursors.set(group, cursor + 1);
      if (bytes + candidate.size > MAX_TOTAL_BYTES) { omit(candidate.extension); continue; }
      const content = readFileSync(candidate.absolute, "utf8");
      if (content.includes("\0")) { omit(candidate.extension); continue; }
      bytes += candidate.size;
      files.push({ path: candidate.path, content, digest: createHash("sha256").update(content).digest("hex"), language: candidate.extension.slice(1), file_version: candidate.file_version });
    }
  }
  for (const [group, queue] of candidates) {
    const remaining = queue.length - cursors.get(group)!;
    if (remaining > 0) omitted_by_language[group] = (omitted_by_language[group] ?? 0) + remaining;
  }
  // Git paths are unique here; code-unit comparison is locale-independent
  // across Hosts and produces the same checkpoint set on every machine.
  files.sort((left, right) => left.path < right.path ? -1 : 1);
  const omitted = Object.values(omitted_by_language).reduce((sum, count) => sum + count, 0);
  // context files retain the already sorted Git path order from `paths`.
  return { root, state: "ready", files, context_files, context_files_omitted, omitted, omitted_by_language };
}
