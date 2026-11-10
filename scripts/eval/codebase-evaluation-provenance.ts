import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export type GitEvaluationState = { revision: string | null; dirty: boolean | null; change_digest: string | null };

export function assertEvaluationStateStable(label: string, before: GitEvaluationState, after: GitEvaluationState): GitEvaluationState {
  if (before.revision !== after.revision || before.dirty !== after.dirty || before.change_digest !== after.change_digest)
    throw new Error(`${label} source state changed during evaluation; rerun against a stable snapshot`);
  return before;
}

export function digestEvaluationMaterial(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function checkpointManifestDigest(entries: readonly JsonObject[]): string {
  const manifest = entries.map(entry => ({ path: String(entry.path), digest: String(entry.digest), size_bytes: Number(entry.size_bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return stableDigest(manifest);
}

export function readGitEvaluationState(root: string): GitEvaluationState {
  try {
    const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: GIT_MAX_BUFFER_BYTES }).trim();
    const status = execFileSync("git", ["-C", root, "status", "--porcelain", "-z", "--untracked-files=all"],
      { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: GIT_MAX_BUFFER_BYTES }).toString("utf8");
    const relevantStatus = status.split("\0").filter(Boolean).filter(entry =>
      !(entry.startsWith("?? ") && isProjectCraftDataPath(entry.slice(3))));
    if (!relevantStatus.length) return { revision, dirty: false, change_digest: null };
    const patch = execFileSync("git", ["-C", root, "diff", "--binary", "HEAD"], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: GIT_MAX_BUFFER_BYTES });
    const untracked = execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"],
      { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: GIT_MAX_BUFFER_BYTES }).toString("utf8").split("\0")
      .filter(path => path && !isProjectCraftDataPath(path)).sort();
    const untrackedFingerprints = untracked.map(path => {
      const fullPath = join(root, path), metadata = lstatSync(fullPath);
      const contentDigest = metadata.isSymbolicLink() ? digestEvaluationMaterial(readlinkSync(fullPath)) : digestEvaluationMaterial(readFileSync(fullPath));
      return `${path}\0${contentDigest}\0`;
    }).join("");
    const changeDigest = digestEvaluationMaterial(Buffer.concat([patch, Buffer.from("\0untracked\0"), Buffer.from(untrackedFingerprints)]));
    return { revision, dirty: true, change_digest: changeDigest };
  } catch {
    return { revision: null, dirty: null, change_digest: null };
  }
}

function isProjectCraftDataPath(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").includes(".craft_data");
}
