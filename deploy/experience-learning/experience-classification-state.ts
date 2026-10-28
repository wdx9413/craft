import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicPrivateJson } from "../../common/craft-common-store-local/src/paths.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";

const SCHEMA = "craft.experience-classification-attempts.v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;
const MAX_ENTRIES = 500;

export interface ExperienceClassificationFailure {
  attempt_digest: string;
  classifier_version: string;
  failure_stage: string;
  failure_code: string;
  failed_at: string;
}

interface AttemptState { schema: string; attempts: Record<string, ExperienceClassificationFailure> }

function readAttempts(path: string): AttemptState {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Experience classification state must be a regular file");
    const state = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    if (state.schema !== SCHEMA || !state.attempts || typeof state.attempts !== "object" || Array.isArray(state.attempts)) {
      throw new Error("Experience classification state is invalid");
    }
    const entries = Object.entries(state.attempts);
    if (entries.length > MAX_ENTRIES || entries.some(([ticketId, value]) => !IDENTIFIER.test(ticketId)
      || !value || typeof value !== "object" || Array.isArray(value)
      || !DIGEST.test(String((value as JsonObject).attempt_digest))
      || typeof (value as JsonObject).classifier_version !== "string" || !(value as JsonObject).classifier_version
      || typeof (value as JsonObject).failure_stage !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(String((value as JsonObject).failure_stage))
      || typeof (value as JsonObject).failure_code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(String((value as JsonObject).failure_code))
      || typeof (value as JsonObject).failed_at !== "string"
      || !Number.isFinite(Date.parse(String((value as JsonObject).failed_at))))) {
      throw new Error("Experience classification state is invalid");
    }
    return { schema: SCHEMA, attempts: Object.fromEntries(entries) as Record<string, ExperienceClassificationFailure> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: SCHEMA, attempts: {} };
    throw error;
  }
}

function checkStateDirectory(path: string): void {
  try { if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("Experience classification state directory must not be a symbolic link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function shouldSuppressExperienceClassification(path: string, ticketId: string, attemptDigest: string, classifierVersion: string): boolean {
  if (!IDENTIFIER.test(ticketId) || !DIGEST.test(attemptDigest) || typeof classifierVersion !== "string" || !classifierVersion.trim()) {
    throw new Error("Experience classification attempt identity is invalid");
  }
  checkStateDirectory(path);
  const failure = readAttempts(path).attempts[ticketId];
  return failure?.attempt_digest === attemptDigest && failure.classifier_version === classifierVersion;
}

export async function recordExperienceClassificationFailure(path: string, ticketId: string, failure: ExperienceClassificationFailure): Promise<void> {
  if (!IDENTIFIER.test(ticketId) || !DIGEST.test(failure.attempt_digest) || typeof failure.classifier_version !== "string" || !failure.classifier_version.trim()
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(failure.failure_stage) || !/^[a-z][a-z0-9_]{0,63}$/u.test(failure.failure_code)
    || !Number.isFinite(Date.parse(failure.failed_at))) throw new Error("Experience classification attempt identity is invalid");
  checkStateDirectory(path);
  const current = readAttempts(path).attempts;
  const attempts = Object.fromEntries(Object.entries({ ...current, [ticketId]: failure })
    .sort(([, left], [, right]) => left.failed_at.localeCompare(right.failed_at)).slice(-MAX_ENTRIES));
  await atomicPrivateJson(path, { schema: SCHEMA, attempts });
}
