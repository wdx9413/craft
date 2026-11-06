import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

type GitRunner = (args: string[], options: { encoding: "utf8"; stdio?: "ignore" }) => string;

function existingExcludeContent(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Git exclude file is unsafe");
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Keep generated project Craft data out of Git without editing project source files. */
export function ensureProjectDataGitExcluded(repositoryRoot: string, runGit: GitRunner = (args, options) => execFileSync("git", args, options)): void {
  const root = resolve(repositoryRoot);
  const gitDirectory = resolve(root, runGit(["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
  const excludePath = resolve(root, runGit(["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim());
  if (relative(gitDirectory, excludePath) !== join("info", "exclude")) throw new Error("Git exclude path is outside the repository metadata directory");
  const existingContent = existingExcludeContent(excludePath);
  try {
    runGit(["-C", root, "check-ignore", "--no-index", "-q", "--", ".craft_data/"], { encoding: "utf8", stdio: "ignore" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { status?: number }).status !== 1) throw error;
  }

  if (!existsSync(dirname(excludePath))) mkdirSync(dirname(excludePath), { recursive: true, mode: 0o700 });
  if (existingContent !== null) {
    appendFileSync(excludePath, `${existingContent.length && !existingContent.endsWith("\n") ? "\n" : ""}.craft_data/\n`, { encoding: "utf8", mode: 0o600 });
    return;
  }
  appendFileSync(excludePath, ".craft_data/\n", { encoding: "utf8", mode: 0o600 });
}
