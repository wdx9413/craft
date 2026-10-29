import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, dirname } from "node:path";

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
