import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicPrivateJson } from "../../common/craft-common-store-local/src/paths.ts";

const SCHEMA = "craft.knowledge-session-adjudication-cursor.v2";
const ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const MAX_RETRIES = 10_000;
const MAX_STATE_BYTES = 4_194_304;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 3_600_000;

export type KnowledgeAdjudicationRetry = { attempts: number; last_failure_at: string; next_attempt_at: string; failure_kind: string; failure_code?: string };
type KnowledgeAdjudicationState = { after_id: string | null; retries: Record<string, KnowledgeAdjudicationRetry> };

function checkCursorDirectory(path: string): void {
  try {
    const parent = lstatSync(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("Knowledge adjudication cursor directory is invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readState(path: string): KnowledgeAdjudicationState {
  checkCursorDirectory(path);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error("Knowledge adjudication cursor file is invalid");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Knowledge adjudication cursor is invalid");
    const state = value as { schema?: unknown; after_id?: unknown; retries?: unknown };
    if (state.schema !== SCHEMA || state.after_id !== null && (typeof state.after_id !== "string" || !ID.test(state.after_id))) {
      throw new Error("Knowledge adjudication cursor is invalid");
    }
    const retries = state.retries === undefined ? {} : state.retries;
    if (!retries || typeof retries !== "object" || Array.isArray(retries) || Object.keys(retries).length > MAX_RETRIES) {
      throw new Error("Knowledge adjudication retry state is invalid");
    }
    for (const [id, raw] of Object.entries(retries)) {
      const item = raw as Partial<KnowledgeAdjudicationRetry>;
      if (!ID.test(id) || !item || typeof item !== "object" || !Number.isSafeInteger(item.attempts) || Number(item.attempts) < 1
        || typeof item.last_failure_at !== "string" || !Number.isFinite(Date.parse(item.last_failure_at))
        || typeof item.next_attempt_at !== "string" || !Number.isFinite(Date.parse(item.next_attempt_at))
        || typeof item.failure_kind !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(item.failure_kind)
        || item.failure_code !== undefined && (typeof item.failure_code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(item.failure_code))) {
        throw new Error("Knowledge adjudication retry state is invalid");
      }
    }
    return { after_id: state.after_id as string | null, retries: retries as Record<string, KnowledgeAdjudicationRetry> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { after_id: null, retries: {} };
    throw error;
  }
}

async function writeState(path: string, state: KnowledgeAdjudicationState): Promise<void> {
  checkCursorDirectory(path);
  await atomicPrivateJson(path, { schema: SCHEMA, ...state, updated_at: new Date().toISOString() });
}

export function readKnowledgeAdjudicationCursor(path: string): string | null {
  return readState(path).after_id;
}

export function readKnowledgeAdjudicationRetries(path: string): Record<string, KnowledgeAdjudicationRetry> {
  return readState(path).retries;
}

export async function writeKnowledgeAdjudicationCursor(path: string, afterId: string | null): Promise<void> {
  if (afterId !== null && (typeof afterId !== "string" || !ID.test(afterId))) throw new Error("Knowledge adjudication cursor is invalid");
  const state = readState(path);
  await writeState(path, { ...state, after_id: afterId });
}

export async function recordKnowledgeAdjudicationFailure(path: string, caseId: string, failureKind: string, now: string, failureCode?: string): Promise<KnowledgeAdjudicationRetry> {
  if (!ID.test(caseId) || !/^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(failureKind)) throw new Error("Knowledge adjudication retry input is invalid");
  if (failureCode !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/u.test(failureCode)) throw new Error("Knowledge adjudication failure code is invalid");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Knowledge adjudication retry time is invalid");
  const state = readState(path), prior = state.retries[caseId];
  if (!prior && Object.keys(state.retries).length >= MAX_RETRIES) throw new Error("Knowledge adjudication retry capacity reached");
  const attempts = Math.min(Number(prior?.attempts ?? 0) + 1, 31);
  const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 16), RETRY_MAX_MS);
  const retry = { attempts, last_failure_at: new Date(nowMs).toISOString(), next_attempt_at: new Date(nowMs + delay).toISOString(), failure_kind: failureKind,
    ...(failureCode ? { failure_code: failureCode } : {}) };
  await writeState(path, { ...state, retries: { ...state.retries, [caseId]: retry } });
  return retry;
}

export async function clearKnowledgeAdjudicationFailure(path: string, caseId: string): Promise<void> {
  const state = readState(path);
  if (!Object.hasOwn(state.retries, caseId)) return;
  const retries = { ...state.retries };
  delete retries[caseId];
  await writeState(path, { ...state, retries });
}
