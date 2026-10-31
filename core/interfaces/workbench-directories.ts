import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", ".codex", ".craft_data", ".pnpm-store", "coverage", "dist", "node_modules"]);

/** List folders for the local, authenticated Workbench project picker. */
export async function listWorkbenchDirectories(requested?: string | null) {
  const input = requested || homedir();
  if (!isAbsolute(input) || input.includes("\0") || input.length > 4096) throw new Error("directory path is invalid");
  const path = await realpath(input);
  if (!(await stat(path)).isDirectory()) throw new Error("directory is not a folder");
  const entries = await readdir(path, { withFileTypes: true });
  const names = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => entry.name).sort((a, b) => a.localeCompare(b));
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, directories: names.slice(0, 500).map(name => ({ name, path: join(path, name) })), truncated: names.length > 500 };
}

/**
 * Bounded file search for the composer's `@` menu. Links and heavy/generated
 * directories are skipped so a large checkout cannot turn a keystroke into an
 * unbounded crawl.
 */
export async function listWorkbenchFiles(requested: string, query = "", limit = 200) {
  if (!isAbsolute(requested) || requested.includes("\0") || requested.length > 4096) throw new Error("workspace path is invalid");
  if (typeof query !== "string" || query.length > 256 || query.includes("\0")) throw new Error("file query is invalid");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("file limit must be an integer between 1 and 500");
  const root = await realpath(requested);
  if (!(await stat(root)).isDirectory()) throw new Error("workspace is not a folder");
  const needle = query.trim().toLowerCase();
  const files: Array<{ path: string; name: string }> = [];
  let visited = 0, truncated = false;
  async function walk(directory: string): Promise<void> {
    if (truncated || files.length >= limit || visited >= 20_000) { truncated = true; return; }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated || files.length >= limit || visited >= 20_000) { truncated = true; return; }
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        visited += 1;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const path = relative(root, absolute).split(sep).join("/");
      if (needle && !path.toLowerCase().includes(needle)) continue;
      files.push({ path, name: entry.name });
    }
  }
  await walk(root);
  return { workspace: root, files, truncated: truncated || files.length >= limit };
}
