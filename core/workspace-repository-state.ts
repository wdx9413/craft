import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type RepositoryState = { root: string; branch: string; revision: string; working_tree_digest: string };
export type GitCommandRunner = (root: string, args: string[]) => string;

function hasGitMetadata(root: string): boolean {
  let current = resolve(root);
  while (true) {
    try { lstatSync(join(current, ".git")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function runGit(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Capture identity that the file snapshot alone cannot distinguish, such as a same-tree branch switch. */
export function readRepositoryState(root: string, run: GitCommandRunner = runGit): RepositoryState | undefined {
  let repositoryRoot: string;
  try { repositoryRoot = run(root, ["rev-parse", "--show-toplevel"]); }
  catch (error) {
    if ((error as { status?: number }).status === 128 && !hasGitMetadata(root)) return undefined;
    throw error;
  }
  let revision = "(unborn)";
  let hasRevision = false;
  try { revision = run(root, ["rev-parse", "--verify", "HEAD"]); hasRevision = true; }
  catch (error) {
    if ((error as { status?: number }).status !== 128) throw error;
  }
  let branch = "(detached)";
  try { branch = run(root, ["symbolic-ref", "--short", "HEAD"]); }
  catch (error) {
    const status = (error as { status?: number }).status;
    if (!hasRevision || (status !== 1 && status !== 128)) throw error;
  }
  const workingTree = run(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { root: repositoryRoot, branch, revision, working_tree_digest: createHash("sha256").update(workingTree).digest("hex") };
}

export function sameRepositoryState(left: RepositoryState | undefined, right: unknown): boolean {
  if (!left) return right === undefined || right === null;
  if (!right || typeof right !== "object" || Array.isArray(right)) return false;
  const value = right as Partial<RepositoryState>;
  return value.root === left.root && value.branch === left.branch && value.revision === left.revision
    && value.working_tree_digest === left.working_tree_digest;
}
