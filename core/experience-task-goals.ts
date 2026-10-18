import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stableDigest } from "./digest.ts";

const SCHEMA = "craft.experience-pending-task-goal.v1";
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

export interface ExperienceTaskGoalArgs {
  experience_dir: string;
  scope: string;
  session_id: string;
  turn_id: string;
  task_goal?: string;
}

function goalIdentity(args: ExperienceTaskGoalArgs): { scope: string; session_id: string; turn_id: string } {
  if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(args.scope) || !args.session_id.trim() || args.session_id.length > 200
    || !args.turn_id.trim() || args.turn_id.length > 200) throw new Error("Experience task-goal identity is invalid");
  return { scope: args.scope, session_id: args.session_id, turn_id: args.turn_id };
}

function directory(path: string, create: boolean): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Experience task-goal path must contain regular directories");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return false;
    mkdirSync(path, { mode: 0o700 });
    return true;
  }
}

function pendingPath(args: ExperienceTaskGoalArgs, create: boolean): string | null {
  const identity = goalIdentity(args);
  const queueDir = join(args.experience_dir, "scenario-classification");
  const pendingDir = join(queueDir, "pending");
  if (!directory(args.experience_dir, false)) return null;
  if (!directory(queueDir, create)) return null;
  if (!directory(pendingDir, create)) return null;
  const key = stableDigest(identity).slice(-32);
  return join(pendingDir, `${key}.json`);
}

function readPendingFile(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2_048) throw new Error("Experience task-goal file is linked, non-regular, or oversized");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Experience task-goal file is invalid");
  return value as Record<string, unknown>;
}

export function storeExperienceTaskGoal(args: ExperienceTaskGoalArgs): void {
  if (typeof args.task_goal !== "string" || !args.task_goal.trim() || args.task_goal.length > 320 || SECRET.test(args.task_goal)) {
    throw new Error("Experience task goal is not sanitized");
  }
  const path = pendingPath(args, true);
  if (!path) throw new Error("Experience task-goal directory is unavailable");
  const identity = { schema: SCHEMA, scope: args.scope, task_goal: args.task_goal, sanitized: true, content_stored: false,
    task_identity_digest: stableDigest(goalIdentity(args)) };
  const identityDigest = stableDigest(identity);
  if (existsSync(path)) {
    const prior = readPendingFile(path);
    if (prior.identity_digest !== identityDigest) throw new Error("Experience task-goal idempotency conflict");
    return;
  }
  const tempPath = `${path}.${randomUUID().replaceAll("-", "")}.tmp`;
  const fd = openSync(tempPath, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ ...identity, identity_digest: identityDigest })); }
  finally { closeSync(fd); }
  try { linkSync(tempPath, path); }
  finally { unlinkSync(tempPath); }
}

export function readExperienceTaskGoal(args: ExperienceTaskGoalArgs): string | null {
  const path = pendingPath(args, false);
  if (!path || !existsSync(path)) return null;
  const value = readPendingFile(path);
  const identity = { schema: value.schema, scope: value.scope, task_goal: value.task_goal, sanitized: value.sanitized,
    content_stored: value.content_stored, task_identity_digest: value.task_identity_digest };
  if (value.schema !== SCHEMA || value.scope !== args.scope || value.sanitized !== true || value.content_stored !== false
    || typeof value.task_goal !== "string" || value.task_goal.length < 8 || value.task_goal.length > 320 || SECRET.test(value.task_goal)
    || value.task_identity_digest !== stableDigest(goalIdentity(args))
    || value.identity_digest !== stableDigest(identity)) throw new Error("Experience task-goal file is invalid");
  return value.task_goal;
}

export function deleteExperienceTaskGoal(args: ExperienceTaskGoalArgs): void {
  const path = pendingPath(args, false);
  if (!path || !existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Experience task-goal file is not a regular file");
  unlinkSync(path);
}
