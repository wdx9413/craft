import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRepositoryState, sameRepositoryState, type GitCommandRunner } from "../core/workspace-repository-state.ts";

function commandError(status: number): Error & { status: number } {
  return Object.assign(new Error(`git exited ${status}`), { status });
}

test("default repository-state reader captures a real Git checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-workspace-git-state-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
    git("add", "source.ts");
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base"], { stdio: "ignore" });
    const state = readRepositoryState(root)!;
    assert.equal(state.root, realpathSync(root));
    assert.notEqual(state.branch, "(detached)");
    assert.match(state.revision, /^[a-f0-9]{40,64}$/u);
    assert.match(state.working_tree_digest, /^[a-f0-9]{64}$/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repository state captures branch, revision and a digest of working-tree status", () => {
  const run: GitCommandRunner = (_root, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return "/repo";
    if (command === "rev-parse --verify HEAD") return "abc123";
    if (command === "symbolic-ref --short HEAD") return "main";
    if (command === "status --porcelain=v1 --untracked-files=all") return " M src/index.ts";
    throw new Error(`unexpected git command: ${command}`);
  };
  const state = readRepositoryState("/repo", run)!;
  assert.deepEqual({ root: state.root, branch: state.branch, revision: state.revision }, { root: "/repo", branch: "main", revision: "abc123" });
  assert.match(state.working_tree_digest, /^[a-f0-9]{64}$/u);
  assert.equal(sameRepositoryState(state, state), true);
  assert.equal(sameRepositoryState(undefined, undefined), true);
  assert.equal(sameRepositoryState(undefined, null), true);
  assert.equal(sameRepositoryState(undefined, state), false);
  assert.equal(sameRepositoryState(state, null), false);
  assert.equal(sameRepositoryState(state, []), false);
  assert.equal(sameRepositoryState(state, { ...state, root: "/other" }), false);
  assert.equal(sameRepositoryState(state, { ...state, branch: "other" }), false);
  assert.equal(sameRepositoryState(state, { ...state, revision: "other" }), false);
  assert.equal(sameRepositoryState(state, { ...state, working_tree_digest: "other" }), false);
});

test("repository state handles non-Git folders, unborn branches and detached HEAD", () => {
  assert.equal(readRepositoryState("/not-a-repository", () => { throw commandError(128); }), undefined);

  const unborn: GitCommandRunner = (_root, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return "/empty-repo";
    if (command === "rev-parse --verify HEAD") throw commandError(128);
    if (command === "symbolic-ref --short HEAD") return "main";
    if (command === "status --porcelain=v1 --untracked-files=all") return "";
    throw new Error(`unexpected git command: ${command}`);
  };
  assert.equal(readRepositoryState("/empty-repo", unborn)?.revision, "(unborn)");

  const detached: GitCommandRunner = (_root, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return "/detached-repo";
    if (command === "rev-parse --verify HEAD") return "abc123";
    if (command === "symbolic-ref --short HEAD") throw commandError(128);
    if (command === "status --porcelain=v1 --untracked-files=all") return "";
    throw new Error(`unexpected git command: ${command}`);
  };
  assert.equal(readRepositoryState("/detached-repo", detached)?.branch, "(detached)");
});

test("repository metadata prevents Git probe failures from falling back to content-only state", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-workspace-invalid-git-"));
  try {
    mkdirSync(join(root, ".git"));
    assert.throws(() => readRepositoryState(root, () => { throw commandError(128); }), /git exited 128/u);
    assert.throws(() => readRepositoryState(root, () => { throw commandError(1); }), /git exited 1/u);
    assert.throws(() => readRepositoryState(root, () => { throw Object.assign(new Error("git unavailable"), { code: "ENOENT" }); }), /git unavailable/u);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const inaccessibleRoot = mkdtempSync(join(tmpdir(), "craft-workspace-inaccessible-git-"));
  try {
    chmodSync(inaccessibleRoot, 0);
    assert.throws(() => readRepositoryState(inaccessibleRoot, () => { throw commandError(128); }),
      error => (error as NodeJS.ErrnoException).code === "EACCES");
  } finally {
    chmodSync(inaccessibleRoot, 0o700);
    rmSync(inaccessibleRoot, { recursive: true, force: true });
  }
});

test("repository state propagates unexpected Git failures and rejects invalid unborn branch state", () => {
  const runner = (revisionError?: Error, branchError?: Error): GitCommandRunner => (_root, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return "/repo";
    if (command === "rev-parse --verify HEAD") { if (revisionError) throw revisionError; return "abc123"; }
    if (command === "symbolic-ref --short HEAD") { if (branchError) throw branchError; return "main"; }
    if (command === "status --porcelain=v1 --untracked-files=all") return "";
    throw new Error(`unexpected git command: ${command}`);
  };
  assert.throws(() => readRepositoryState("/repo", runner(commandError(1))), /git exited 1/u);
  assert.throws(() => readRepositoryState("/repo", runner(commandError(128), commandError(128))), /git exited 128/u);
  assert.equal(readRepositoryState("/repo", runner(undefined, commandError(1)))?.branch, "(detached)");
  assert.throws(() => readRepositoryState("/repo", runner(undefined, commandError(2))), /git exited 2/u);
});
