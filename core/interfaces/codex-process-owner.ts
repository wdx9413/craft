import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { type JsonObject } from "../infrastructure/store.ts";

/** Capture the leader of a process group created by this Workbench. */
export function codexProcessIdentity(pid: unknown): JsonObject | null {
  if ((process.platform !== "darwin" && process.platform !== "linux") || !Number.isSafeInteger(pid) || Number(pid) <= 1) return null;
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "pgid=", "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 2000 }).trim();
    const match = /^(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/u.exec(output);
    if (!match || Number(match[1]) !== pid || !/\bcodex\b/u.test(match[3]) || !/\bapp-server\b/u.test(match[3])) return null;
    return { pid, started: match[2], command: match[3] };
  } catch { return null; }
}

export function sameCodexProcess(saved: JsonObject): boolean {
  const current = codexProcessIdentity(saved.pid);
  return !!current && current.started === saved.started && current.command === saved.command;
}

/** Verify the recorded group still has the exact session lock file open. */
export function codexGroupHasSessionFile(saved: JsonObject, threadId: unknown): boolean {
  if (typeof threadId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(threadId) || typeof saved.pid !== "number") return false;
  try {
    const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "thread-writer-locks", `${threadId}.lock`);
    const pids = execFileSync("lsof", ["-t", "--", path], { encoding: "utf8", timeout: 2000 }).trim().split(/\s+/u);
    return pids.some(value => {
      if (!/^\d+$/u.test(value)) return false;
      try { return Number(execFileSync("ps", ["-p", value, "-o", "pgid="], { encoding: "utf8", timeout: 2000 }).trim()) === saved.pid; }
      catch { return false; }
    });
  } catch { return false; }
}

/** Identify a single Codex process holding the selected session file. */
export function externalCodexOwner(threadId: unknown): JsonObject | null {
  if ((process.platform !== "darwin" && process.platform !== "linux") || typeof threadId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(threadId)) return null;
  const locks = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "thread-writer-locks");
  try {
    const pids = [...new Set(execFileSync("lsof", ["-t", "--", join(locks, `${threadId}.lock`)], { encoding: "utf8", timeout: 2000 }).trim().split(/\s+/u))];
    if (pids.length !== 1 || !/^\d+$/u.test(pids[0])) return null;
    const pid = Number(pids[0]);
    if (pid <= 1 || pid === process.pid) return null;
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 2000 }).trim();
    const match = /^(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)(?:\s|$)/u.exec(output);
    if (!match || !/(?:^|\/)codex$/u.test(match[2])) return null;
    const files = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).split("\n");
    const count = new Set(files.filter(line => line.startsWith(`n${locks}/`) && line.endsWith(".lock"))).size;
    if (!count) return null;
    return { pid, started: match[1], executable: match[2], session_count: count };
  } catch { return null; }
}
