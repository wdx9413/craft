import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { stableDigest } from "./digest.ts";

export type EvaluationEngineIdentity = { kind: "codex" | "claude"; executable: string; sha256: string; environment_digest: string };

/** Resolve the same executable lookup used by a no-shell child process. */
export async function evaluationExecutable(binary: string): Promise<string> {
  if (isAbsolute(binary)) return realpath(binary);
  if (binary.includes("/") || binary.includes("\\")) throw new Error("evaluation engine must be absolute or a PATH command");
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const path = join(directory, binary);
    try { await access(path, constants.X_OK); return await realpath(path); } catch { /* Continue PATH lookup. */ }
  }
  throw new Error("evaluation engine executable was not found");
}

/** A local byte identity, not a signature or proof of the model behind a CLI. */
export async function evaluationEngineIdentity(subject: Record<string, unknown>): Promise<EvaluationEngineIdentity | null> {
  const host = subject.host as Record<string, unknown> | undefined;
  if (!host || typeof host !== "object" || !["codex", "claude"].includes(String(host.kind)) || typeof host.binary !== "string") return null;
  const executable = await evaluationExecutable(host.binary), before = await stat(executable);
  if (!before.isFile() || before.size > 256 * 1024 * 1024) throw new Error("evaluation engine exceeds the regular-file identity budget");
  const hash = createHash("sha256"); let size = 0;
  for await (const bytes of createReadStream(executable)) {
    size += bytes.length;
    if (size > 256 * 1024 * 1024) throw new Error("evaluation engine exceeds the identity byte budget");
    hash.update(bytes);
  }
  const after = await stat(executable);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== before.size) throw new Error("evaluation engine changed while fingerprinting");
  return { kind: host.kind as "codex" | "claude", executable, sha256: hash.digest("hex"), environment_digest: stableDigest(process.env) };
}
