import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureProjectDataGitExcluded } from "../capability/craft-codebase/project-data-git-exclude.ts";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "craft-project-ignore-"));
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

test("generated Codebase data is locally excluded without changing project source files", () => {
  const root = repository();
  try {
    const exclude = join(root, ".git", "info", "exclude");
    writeFileSync(exclude, "existing-local-rule", "utf8");
    ensureProjectDataGitExcluded(root);
    assert.equal(readFileSync(exclude, "utf8"), "existing-local-rule\n.craft_data/\n");
    assert.equal(execFileSync("git", ["-C", root, "check-ignore", "--no-index", ".craft_data/codebase/index.json"], { encoding: "utf8" }).trim(), ".craft_data/codebase/index.json");
    assert.equal(existsSync(join(root, ".gitignore")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("existing project ignore rules are reused and missing Git exclude files are created", () => {
  const ignoredRoot = repository();
  const newExcludeRoot = repository();
  try {
    const ignore = join(ignoredRoot, ".gitignore");
    const exclude = join(ignoredRoot, ".git", "info", "exclude");
    writeFileSync(ignore, ".craft_data/\n", "utf8");
    const before = readFileSync(exclude, "utf8");
    ensureProjectDataGitExcluded(ignoredRoot);
    assert.equal(readFileSync(exclude, "utf8"), before);

    const info = join(newExcludeRoot, ".git", "info");
    rmSync(info, { recursive: true, force: true });
    ensureProjectDataGitExcluded(newExcludeRoot);
    assert.equal(readFileSync(join(info, "exclude"), "utf8"), ".craft_data/\n");

    const newlineRoot = repository();
    try {
      const newlineExclude = join(newlineRoot, ".git", "info", "exclude");
      writeFileSync(newlineExclude, "existing rule\n", "utf8");
      ensureProjectDataGitExcluded(newlineRoot);
      assert.equal(readFileSync(newlineExclude, "utf8"), "existing rule\n.craft_data/\n");
      writeFileSync(newlineExclude, "", "utf8");
      ensureProjectDataGitExcluded(newlineRoot);
      assert.equal(readFileSync(newlineExclude, "utf8"), ".craft_data/\n");
    } finally { rmSync(newlineRoot, { recursive: true, force: true }); }
  } finally {
    rmSync(ignoredRoot, { recursive: true, force: true });
    rmSync(newExcludeRoot, { recursive: true, force: true });
  }
});

test("invalid Git metadata paths and Git command failures fail closed", () => {
  const root = repository();
  try {
    const outsidePath = (args: string[]) => args.includes("--git-common-dir") ? ".git\n" : args.includes("--git-path") ? "../outside\n" : "";
    assert.throws(() => ensureProjectDataGitExcluded(root, args => outsidePath(args)), /outside the repository metadata/u);

    const failedCommand = (args: string[]) => {
      if (args.includes("--git-common-dir")) return ".git\n";
      if (args.includes("--git-path")) return ".git/info/exclude\n";
      throw new Error("Command failed");
    };
    assert.throws(() => ensureProjectDataGitExcluded(root, failedCommand), /Command failed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsafe Git exclude paths fail closed", () => {
  const root = repository();
  try {
    const info = join(root, ".git", "info");
    const exclude = join(info, "exclude");
    const outside = join(root, "outside");
    writeFileSync(outside, "", "utf8");
    unlinkSync(exclude);
    symlinkSync(outside, exclude);
    assert.throws(() => ensureProjectDataGitExcluded(root), /Git exclude file is unsafe/u);
    unlinkSync(exclude);
    symlinkSync(join(info, "missing-target"), exclude);
    assert.throws(() => ensureProjectDataGitExcluded(root), /Git exclude file is unsafe/u);
    unlinkSync(exclude);
    mkdirSync(exclude);
    assert.throws(() => ensureProjectDataGitExcluded(root), /Git exclude file is unsafe/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
