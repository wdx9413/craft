import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicPrivateJson } from "../../common/craft-common-store-local/src/paths.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";

const SCHEMA = "craft.knowledge-classification-attempts.v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_ENTRIES = 500;

export interface KnowledgeClassificationAttempt {
  input_digest: string;
  failure_stage: string;
  failure_code: string;
  failed_at: string;
}

interface AttemptState { schema: string; attempts: Record<string, KnowledgeClassificationAttempt> }

function readAttempts(path: string): AttemptState {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Knowledge classification state must be a regular file");
    const state = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    if (state.schema !== SCHEMA || !state.attempts || typeof state.attempts !== "object" || Array.isArray(state.attempts)) {
      throw new Error("Knowledge classification state is invalid");
    }
    const entries = Object.entries(state.attempts);
    if (entries.length > MAX_ENTRIES || entries.some(([ticketId, value]) => !/^[A-Za-z0-9._:-]{1,200}$/u.test(ticketId)
      || !value || typeof value !== "object" || Array.isArray(value)
      || !DIGEST.test(String((value as JsonObject).input_digest))
      || typeof (value as JsonObject).failure_stage !== "string"
      || typeof (value as JsonObject).failure_code !== "string"
      || typeof (value as JsonObject).failed_at !== "string")) {
      throw new Error("Knowledge classification state is invalid");
    }
    return { schema: SCHEMA, attempts: Object.fromEntries(entries) as Record<string, KnowledgeClassificationAttempt> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: SCHEMA, attempts: {} };
    throw error;
  }
}

export function shouldSuppressKnowledgeClassification(path: string, ticketId: string, inputDigest: string): boolean {
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(ticketId) || !DIGEST.test(inputDigest)) throw new Error("Knowledge classification attempt identity is invalid");
  const parent = dirname(path);
  try { if (lstatSync(parent).isSymbolicLink()) throw new Error("Knowledge classification state directory must not be a symbolic link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return readAttempts(path).attempts[ticketId]?.input_digest === inputDigest;
}

export async function recordKnowledgeClassificationFailure(path: string, ticketId: string, attempt: KnowledgeClassificationAttempt): Promise<void> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(ticketId) || !DIGEST.test(attempt.input_digest)
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(attempt.failure_stage) || !/^[a-z][a-z0-9_]{0,63}$/u.test(attempt.failure_code)
    || !Number.isFinite(Date.parse(attempt.failed_at))) throw new Error("Knowledge classification attempt identity is invalid");
  const parent = dirname(path);
  try { if (lstatSync(parent).isSymbolicLink()) throw new Error("Knowledge classification state directory must not be a symbolic link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const current = readAttempts(path).attempts;
  const attempts = Object.fromEntries(Object.entries({ ...current, [ticketId]: attempt })
    .sort(([, left], [, right]) => left.failed_at.localeCompare(right.failed_at)).slice(-MAX_ENTRIES));
  await atomicPrivateJson(path, { schema: SCHEMA, attempts });
}
