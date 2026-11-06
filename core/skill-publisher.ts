import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export type SkillPublication = {
  target_path: string;
  previous_digest: string;
  published_digest: string;
  backup_path: string;
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function targetInsideSource(sourceRoot: string, targetPath: string): void {
  if (basename(targetPath).toLowerCase() !== "skill.md") throw new Error("target_path must name SKILL.md");
  if (!targetPath.startsWith(`${resolve(sourceRoot)}${sep}`)) {
    throw new Error("target_path must be inside the selected capability source");
  }
}

function requireExternalWrite(value: unknown): void {
  if (value !== true) throw new Error("allow_external_write must be true for Skill publication");
}

async function replaceAtomically(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  await rename(temporary, path);
}

export async function publishSkill(args: {
  sourceRoot: string; targetPath: string; expectedDigest: string; content: string;
  backupsDir: string; proposalId: string; allowExternalWrite: unknown; onBeforeFinalCheck?: () => Promise<void>;
}): Promise<SkillPublication> {
  requireExternalWrite(args.allowExternalWrite);
  const targetPath = await realpath(args.targetPath);
  targetInsideSource(args.sourceRoot, targetPath);
  const previous = await readFile(targetPath, "utf8");
  const previousDigest = digest(previous);
  if (previousDigest !== args.expectedDigest) throw new Error("target digest mismatch; file changed since it was reviewed");
  const backupPath = join(args.backupsDir, "skill-publications", args.proposalId, `${previousDigest}.SKILL.md`);
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(backupPath, previous, { encoding: "utf8", mode: 0o600 });
  if (args.onBeforeFinalCheck) await args.onBeforeFinalCheck();
  const current = await readFile(targetPath, "utf8");
  if (digest(current) !== args.expectedDigest) throw new Error("target digest mismatch; file changed during publication");
  const mode = (await stat(targetPath)).mode;
  await replaceAtomically(targetPath, args.content, mode);
  return { target_path: targetPath, previous_digest: previousDigest, published_digest: digest(args.content), backup_path: backupPath };
}

export async function rollbackSkillPublication(args: {
  targetPath: string; expectedDigest: string; publishedDigest: string; backupPath: string; allowExternalWrite: unknown;
}): Promise<void> {
  requireExternalWrite(args.allowExternalWrite);
  const targetPath = await realpath(args.targetPath);
  const current = await readFile(targetPath, "utf8");
  if (digest(current) !== args.expectedDigest) {
    throw new Error("target digest mismatch; refusing to overwrite a changed Skill");
  }
  if (args.expectedDigest !== args.publishedDigest) {
    throw new Error("target digest mismatch; refusing to overwrite a changed Skill");
  }
  const backup = await readFile(args.backupPath, "utf8");
  await replaceAtomically(targetPath, backup, (await stat(targetPath)).mode);
}
