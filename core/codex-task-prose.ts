import { createHash } from "node:crypto";

const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

/** Shared, content-free identity for one sanitized Host task goal. */
export function sanitizeCodexTaskGoal(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 8_000 || SECRET.test(value)) return null;
  const goal = value.split(/\r?\n/u, 1)[0]!
    .replace(/```[\s\S]*?```/gu, " ").replace(/`[^`]*`/gu, " ")
    .replace(/\[[^\]]{1,200}\]\(https?:\/\/[^)]+\)/gu, " ").replace(/https?:\/\/\S+/giu, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, " ")
    .replace(/(?:\/[\w.-]+){2,}|[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, " ")
    .replace(/\b[a-f0-9]{32,}\b/giu, " ").replace(/\s+/gu, " ").replace(/^\s*[#>*-]+\s*/u, "").trim().slice(0, 320).trim();
  return goal.length >= 8 ? goal : null;
}

/** Store only a digest; callers must never persist or log the returned task text. */
export function codexTaskGoalDigest(value: unknown): string | null {
  const goal = sanitizeCodexTaskGoal(value);
  return goal ? `sha256:${createHash("sha256").update(goal).digest("hex")}` : null;
}
