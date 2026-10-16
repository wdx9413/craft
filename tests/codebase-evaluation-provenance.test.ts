import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointManifestDigest, digestEvaluationMaterial, readGitEvaluationState } from "../scripts/eval/codebase-evaluation-provenance.ts";

test("evaluation provenance hashes suite material and a path-sorted checkpoint manifest", () => {
  assert.equal(digestEvaluationMaterial("suite"), "f8ebd43dbef1f029bf4930c65c9b7c5cc76af476927cee861ff18fcc73bfc4ab");
  const first = checkpointManifestDigest([{ path: "b.ts", digest: "b", size_bytes: 2 }, { path: "a.ts", digest: "a", size_bytes: 1 }]);
  const reordered = checkpointManifestDigest([{ path: "a.ts", digest: "a", size_bytes: 1 }, { path: "b.ts", digest: "b", size_bytes: 2 }]);
  assert.equal(first, reordered);
  assert.notEqual(first, checkpointManifestDigest([{ path: "a.ts", digest: "changed", size_bytes: 1 }, { path: "b.ts", digest: "b", size_bytes: 2 }]));
});

test("evaluation provenance records clean and dirty Git states and marks non-Git roots unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-evaluation-provenance-"));
  const repository = join(root, "repo");
  mkdirSync(repository);
  try {
    execFileSync("git", ["init", "-q", repository]);
    writeFileSync(join(repository, "tracked.ts"), "export const baseline = true;\n");
    execFileSync("git", ["-C", repository, "add", "tracked.ts"]);
    execFileSync("git", ["-C", repository, "-c", "user.name=Craft Test", "-c", "user.email=craft-test@example.invalid", "commit", "--allow-empty", "-qm", "baseline"]);
    const clean = readGitEvaluationState(repository);
    assert.match(clean.revision ?? "", /^[0-9a-f]{40,64}$/u);
    assert.equal(clean.dirty, false);
    assert.equal(clean.change_digest, null);
    writeFileSync(join(repository, "changed.ts"), "export const changed = true;\n");
    const dirty = readGitEvaluationState(repository);
    assert.equal(dirty.revision, clean.revision);
    assert.equal(dirty.dirty, true);
    assert.match(dirty.change_digest ?? "", /^[0-9a-f]{64}$/u);
    writeFileSync(join(repository, "changed.ts"), "export const changed = false;\n");
    assert.notEqual(readGitEvaluationState(repository).change_digest, dirty.change_digest);
    writeFileSync(join(root, "outside.txt"), "outside repository content");
    symlinkSync("../outside.txt", join(repository, "link.ts"));
    assert.notEqual(readGitEvaluationState(repository).change_digest, dirty.change_digest);
    const beforeLargeDiff = readGitEvaluationState(repository).change_digest;
    writeFileSync(join(repository, "tracked.ts"), Buffer.alloc(2 * 1024 * 1024, 0x61));
    const largeDiff = readGitEvaluationState(repository);
    assert.equal(largeDiff.revision, clean.revision);
    assert.equal(largeDiff.dirty, true);
    assert.match(largeDiff.change_digest ?? "", /^[0-9a-f]{64}$/u);
    assert.notEqual(largeDiff.change_digest, beforeLargeDiff);
    assert.deepEqual(readGitEvaluationState(join(root, "not-a-repository")), { revision: null, dirty: null, change_digest: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
