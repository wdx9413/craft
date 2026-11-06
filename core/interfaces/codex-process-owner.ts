import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type JsonObject } from "../infrastructure/store.ts";

type WindowsCodexProcess = { pid: number; started: string; executable: string; command: string };

function threadLockPath(threadId: string): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "thread-writer-locks", `${threadId}.lock`);
}

export function isCraftCodexCommand(command: unknown): boolean {
  return typeof command === "string" && /\bapp-server\b/u.test(command)
    && /--listen/u.test(command) && /(?:stdio|unix|pipe):\/\//iu.test(command);
}

/** Existing Workbench app-servers that must not be mistaken for another CLI window. */
export function workbenchCodexProcesses(excludePid = process.pid): JsonObject[] {
  if (process.platform !== "win32") return [];
  return windowsCodexProcesses().filter(item => item.pid !== excludePid && isCraftCodexCommand(item.command))
    .map(item => ({ pid: item.pid, started: item.started, command: item.command }));
}

/** Resolve the PID still holding a lock when Windows cannot report it. */
export function windowsLockOwner(threadId: unknown, claimedPid?: unknown, excludePid = process.pid): number | null {
  if (!validThreadId(threadId)) return null;
  if (process.platform !== "win32" || !existsSync(threadLockPath(threadId))) return null;
  if (typeof claimedPid === "number" && claimedPid !== excludePid && processAlive(claimedPid)) return claimedPid;
  const processes = windowsCodexProcesses();
  const candidates = processes.filter(item => item.pid !== excludePid && isCraftCodexCommand(item.command));
  return candidates.length === 1 ? candidates[0].pid : null;
}

function windowsLockCount(): number {
  try {
    const directory = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "thread-writer-locks");
    return Math.max(1, readdirSync(directory).filter(name => name.endsWith(".lock") && name !== ".coordination.lock").length);
  } catch { return 1; }
}

function validThreadId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}

function systemProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

export function processAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1) return false;
  return systemProcessAlive(Number(pid));
}

/** Read codex.exe app-server processes without assuming a POSIX lsof/ps toolchain. */
export function windowsCodexProcesses(): WindowsCodexProcess[] {
  if (process.platform !== "win32") return [];
  try {
    const script = "$p = @(Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; started=if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }; executable=[string]$_.ExecutablePath; command=[string]$_.CommandLine } }); ConvertTo-Json -InputObject $p -Compress";
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 3000, windowsHide: true,
    }).trim();
    if (!output) return [];
    const parsed: unknown = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const value = row as Record<string, unknown>;
      const pid = Number(value.pid), started = String(value.started ?? ""), executable = String(value.executable ?? ""), command = String(value.command ?? "");
      return Number.isSafeInteger(pid) && pid > 1 && command ? [{ pid, started, executable, command }] : [];
    });
  } catch { return []; }
}

/** Capture the leader of a process group created by this Workbench. */
export function codexProcessIdentity(pid: unknown): JsonObject | null {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1) return null;
  if (process.platform === "win32") {
    const candidate = windowsCodexProcesses().find(item => item.pid === Number(pid) && /\bapp-server\b/u.test(item.command));
    return candidate ? { pid: candidate.pid, started: candidate.started, command: candidate.command } : null;
  }
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
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
  if (!validThreadId(threadId) || typeof saved.pid !== "number") return false;
  if (process.platform === "win32") return processAlive(saved.pid) && existsSync(threadLockPath(threadId));
  try {
    const path = threadLockPath(threadId);
    const pids = execFileSync("lsof", ["-t", "--", path], { encoding: "utf8", timeout: 2000 }).trim().split(/\s+/u);
    return pids.some(value => {
      if (!/^\d+$/u.test(value)) return false;
      try { return Number(execFileSync("ps", ["-p", value, "-o", "pgid="], { encoding: "utf8", timeout: 2000 }).trim()) === saved.pid; }
      catch { return false; }
    });
  } catch { return false; }
}

/** Identify a single Codex process holding the selected session file. */
export function externalCodexOwner(threadId: unknown, craftPids: ReadonlySet<number> = new Set([process.pid])): JsonObject | null {
  if (!validThreadId(threadId)) return null;
  if (process.platform === "win32") {
    if (!existsSync(threadLockPath(threadId))) return null;
    const candidates = windowsCodexProcesses().filter(item => !craftPids.has(item.pid) && isCraftCodexCommand(item.command));
    if (candidates.length !== 1) return null;
    const candidate = candidates[0]!;
    return { pid: candidate.pid, started: candidate.started, executable: candidate.executable, session_count: windowsLockCount() };
  }
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  const locks = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "thread-writer-locks");
  try {
    const pids = [...new Set(execFileSync("lsof", ["-t", "--", join(locks, `${threadId}.lock`)], { encoding: "utf8", timeout: 2000 }).trim().split(/\s+/u))];
    if (pids.length !== 1 || !/^\d+$/u.test(pids[0])) return null;
    const pid = Number(pids[0]);
    if (pid <= 1 || craftPids.has(pid)) return null;
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 2000 }).trim();
    const match = /^(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)(?:\s|$)/u.exec(output);
    if (!match || !/(?:^|\/)codex$/u.test(match[2])) return null;
    const files = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).split("\n");
    const count = new Set(files.filter(line => line.startsWith(`n${locks}/`) && line.endsWith(".lock"))).size;
    if (!count) return null;
    return { pid, started: match[1], executable: match[2], session_count: count };
  } catch { return null; }
}
