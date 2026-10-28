import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { atomicPrivateJson } from "../../common/craft-common-store-local/src/paths.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import { stableDigest } from "../../core/digest.ts";

const SCHEMA = "craft.experience-classification-attempts.v1";
const ENTRY_SCHEMA = "craft.experience-classification-attempt.v2";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;
const MAX_ENTRIES = 500;
function validCursor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 65_536 && !value.includes("\0");
}

function validFailure(value: unknown): value is ExperienceClassificationFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as JsonObject;
  return DIGEST.test(String(item.attempt_digest)) && typeof item.classifier_version === "string" && Boolean(item.classifier_version.trim())
    && typeof item.failure_stage === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(item.failure_stage)
    && typeof item.failure_code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(item.failure_code)
    && typeof item.failed_at === "string" && Number.isFinite(Date.parse(item.failed_at))
    && (item.trace_id === undefined || typeof item.trace_id === "string" && IDENTIFIER.test(item.trace_id));
}

export interface ExperienceClassificationFailure {
  attempt_digest: string;
  classifier_version: string;
  failure_stage: string;
  failure_code: string;
  failed_at: string;
  trace_id?: string;
  reconciliation?: { ticket_id: string; request_id: string; scope: string; target_version: number; request_version: number;
    request_status: string; result_digest: string };
}

interface AttemptState { schema: string; attempts: Record<string, ExperienceClassificationFailure>; last_ticket_id?: string }

function readAttempts(path: string): AttemptState {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Experience classification state must be a regular file");
    const state = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    if (state.schema !== SCHEMA || !state.attempts || typeof state.attempts !== "object" || Array.isArray(state.attempts)
      || (state.last_ticket_id !== undefined && !validCursor(state.last_ticket_id))) {
      throw new Error("Experience classification state is invalid");
    }
    const entries = Object.entries(state.attempts);
    if (entries.length > MAX_ENTRIES || entries.some(([ticketId, value]) => !IDENTIFIER.test(ticketId) || !validFailure(value))) {
      throw new Error("Experience classification state is invalid");
    }
    return { schema: SCHEMA, attempts: Object.fromEntries(entries) as Record<string, ExperienceClassificationFailure>,
      ...(state.last_ticket_id === undefined ? {} : { last_ticket_id: state.last_ticket_id as string }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: SCHEMA, attempts: {} };
    throw error;
  }
}

function checkStateDirectory(path: string): void {
  try { if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("Experience classification state directory must not be a symbolic link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function attemptFile(path: string, ticketId: string): { path: string; ticket_digest: string } {
  const hash = createHash("sha256").update(ticketId).digest("hex");
  return { path: join(dirname(path), `${basename(path)}.entries`, `${hash}.json`), ticket_digest: `sha256:${hash}` };
}

function readAttempt(path: string, ticketId: string): ExperienceClassificationFailure | undefined {
  const entry = attemptFile(path, ticketId);
  checkStateDirectory(entry.path);
  try {
    const stat = lstatSync(entry.path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Experience classification attempt must be a regular file");
    const stored = JSON.parse(readFileSync(entry.path, "utf8")) as JsonObject;
    if (stored.schema !== ENTRY_SCHEMA || stored.ticket_digest !== entry.ticket_digest || !validFailure(stored.failure)) {
      throw new Error("Experience classification attempt is invalid");
    }
    const failure = stored.failure as ExperienceClassificationFailure;
    if (failure.classifier_version === "reconciliation-v1" && (failure.failure_stage !== "reconciliation" || failure.failure_code !== "model_result_unknown")) {
      throw new Error("Experience reconciliation checkpoint has an invalid status");
    }
    if (failure.failure_code === "model_result_unknown" && !failure.reconciliation) {
      throw new Error("Experience reconciliation checkpoint is missing its identity");
    }
    if (failure.reconciliation && (failure.reconciliation.ticket_id !== ticketId || stableDigest(failure.reconciliation) !== failure.attempt_digest)) {
      throw new Error("Experience reconciliation checkpoint conflicts with its identity");
    }
    return failure;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function experienceClassificationSuppression(path: string, ticketId: string, attemptDigest: string, classifierVersion: string): { reason: "model_result_unknown" | "unchanged_failure"; trace_id?: string } | null {
  if (!IDENTIFIER.test(ticketId) || !DIGEST.test(attemptDigest) || typeof classifierVersion !== "string" || !classifierVersion.trim()) {
    throw new Error("Experience classification attempt identity is invalid");
  }
  checkStateDirectory(path);
  const failure = readAttempt(path, ticketId) ?? readAttempts(path).attempts[ticketId];
  if (failure?.failure_code === "model_dispatch_unknown") return { reason: "model_result_unknown", ...(failure.trace_id ? { trace_id: failure.trace_id } : {}) };
  return failure?.attempt_digest === attemptDigest && failure.classifier_version === classifierVersion ? { reason: "unchanged_failure" } : null;
}

export function shouldSuppressExperienceClassification(path: string, ticketId: string, attemptDigest: string, classifierVersion: string): boolean {
  return experienceClassificationSuppression(path, ticketId, attemptDigest, classifierVersion) !== null;
}

export async function recordExperienceClassificationFailure(path: string, ticketId: string, failure: ExperienceClassificationFailure): Promise<void> {
  if (!IDENTIFIER.test(ticketId) || !validFailure(failure)) throw new Error("Experience classification attempt identity is invalid");
  checkStateDirectory(path);
  const entry = attemptFile(path, ticketId);
  checkStateDirectory(entry.path);
  await atomicPrivateJson(entry.path, { schema: ENTRY_SCHEMA, ticket_digest: entry.ticket_digest, failure });
}

export function readExperienceClassificationCursor(path: string): string {
  checkStateDirectory(path);
  return readAttempts(path).last_ticket_id ?? "";
}

export async function recordExperienceClassificationCursor(path: string, ticketId: string): Promise<void> {
  if (!validCursor(ticketId)) throw new Error("Experience classification cursor identity is invalid");
  checkStateDirectory(path);
  const state = readAttempts(path);
  if ((state.last_ticket_id ?? "") !== ticketId) await atomicPrivateJson(path, { ...state, last_ticket_id: ticketId });
}
