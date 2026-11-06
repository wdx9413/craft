import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicPrivateJson, craftPaths, dataRoot } from "../../common/craft-common-store-local/src/paths.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import { operationErrorCode } from "../../common/craft-common-log/src/index.ts";

export interface KnowledgeLearningClient { call(name: string, args?: JsonObject): Promise<JsonObject> }
export interface KnowledgeSyncOptions {
  state_file?: string;
  max_sources?: number;
  max_files_per_page?: number;
  max_pages_per_source?: number;
}

const LEGACY_STATE_SCHEMA = "craft.knowledge-learning-worker-state.v1";
const STATE_SCHEMA = "craft.knowledge-learning-worker-state.v2";
const SOURCE_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,4096}$/u;
const DEFAULT_MAX_SOURCES = 5;
const DEFAULT_FILES_PER_PAGE = 500;
const DEFAULT_MAX_PAGES = 20;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return result;
}

function statePath(options: KnowledgeSyncOptions): string {
  return resolve(options.state_file ?? join(craftPaths(dataRoot()).knowledgeDir, "learning-worker-state.json"));
}

function sourceRef(sourceId: string): string { return `sha256:${createHash("sha256").update(sourceId).digest("hex")}`; }

interface KnowledgeWorkerState { last_source_ref: string | null; source_cursors: Record<string, string> }

function validSourceCursors(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Knowledge worker source cursors are invalid");
  const entries = Object.entries(value);
  if (entries.length > 1_000 || entries.some(([source, cursor]) => !SOURCE_REF_PATTERN.test(source) || typeof cursor !== "string" || !CURSOR_PATTERN.test(cursor))) {
    throw new Error("Knowledge worker source cursors are invalid");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function readState(path: string): KnowledgeWorkerState {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Knowledge worker state must be a regular file");
    const state = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    if (![LEGACY_STATE_SCHEMA, STATE_SCHEMA].includes(String(state.schema)) || !(state.last_source_ref === null || typeof state.last_source_ref === "string")) {
      throw new Error("Knowledge worker state is invalid");
    }
    return { last_source_ref: state.last_source_ref as string | null, source_cursors: validSourceCursors(state.source_cursors) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { last_source_ref: null, source_cursors: {} };
    throw error;
  }
}

async function writeState(path: string, lastSourceId: string, sourceCursors: Record<string, string>): Promise<void> {
  const parent = dirname(path);
  try {
    if (lstatSync(parent).isSymbolicLink()) throw new Error("Knowledge worker state directory must not be a symbolic link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicPrivateJson(path, { schema: STATE_SCHEMA, last_source_ref: sourceRef(lastSourceId), source_cursors: sourceCursors, updated_at: new Date().toISOString() });
}

function rotateAfter(sources: JsonObject[], lastSourceId: string | null): JsonObject[] {
  if (!sources.length) return [];
  const start = lastSourceId === null ? 0 : (sources.findIndex(source => sourceRef(String(source.id)) === lastSourceId) + 1) % sources.length;
  return [...sources.slice(start), ...sources.slice(0, start)];
}

interface SourceIngestResult { outcome: JsonObject; next_cursor: string | null }

async function ingestSource(client: KnowledgeLearningClient, sourceId: string, filesPerPage: number, maxPages: number, startCursor: string | null): Promise<SourceIngestResult> {
  let cursor = startCursor, pages = 0, processedFiles = 0, candidateCount = 0, reviewedCount = 0;
  let status = "completed", reason: string | null = null, hasMore = false;
  do {
    const args: JsonObject = { source_id: sourceId, max_files: filesPerPage };
    if (cursor !== null) args.cursor = cursor;
    const result = await client.call("craft_knowledge_source_ingest", args);
    pages++;
    processedFiles += Number.isSafeInteger(result.processed_files) ? Number(result.processed_files) : 0;
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    candidateCount += candidates.length;
    const summary = (result.automatic_review as JsonObject | undefined)?.summary;
    if (summary && typeof summary === "object") reviewedCount += Number.isSafeInteger((summary as JsonObject).promoted) ? Number((summary as JsonObject).promoted) : 0;
    status = typeof result.status === "string" ? result.status : "unknown";
    reason = typeof result.reason === "string" ? result.reason : null;
    hasMore = result.has_more === true;
    const nextCursor = typeof result.next_cursor === "string" ? result.next_cursor : null;
    if (hasMore && (nextCursor === null || !CURSOR_PATTERN.test(nextCursor))) throw new Error("Knowledge ingestion returned an invalid next cursor");
    cursor = nextCursor;
    if (hasMore && pages >= maxPages) break;
  } while (hasMore);
  return { outcome: { source_ref: sourceRef(sourceId), status: hasMore ? "partial" : status, reason, pages, processed_files: processedFiles,
    candidates: candidateCount, promoted: reviewedCount, has_more: hasMore }, next_cursor: hasMore ? cursor : null };
}

function staleCursor(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Knowledge cursor is stale or invalid; restart ingestion");
}

/**
 * Re-ingest registered, bounded-or-verified read-only Sources so document changes invalidate
 * stale Claims and current Evidence is assessed by the normal Knowledge policy. Bounded sources
 * can create candidates but cannot provide the confidence required for automatic promotion. The
 * cursor is content-free and rotates a bounded number of Sources on every pass.
 */
export async function runKnowledgeSyncOnce(client: KnowledgeLearningClient, options: KnowledgeSyncOptions = {}): Promise<JsonObject> {
  const maxSources = boundedInteger(options.max_sources, DEFAULT_MAX_SOURCES, 1, 50, "max_sources");
  const filesPerPage = boundedInteger(options.max_files_per_page, DEFAULT_FILES_PER_PAGE, 1, 500, "max_files_per_page");
  const maxPages = boundedInteger(options.max_pages_per_source, DEFAULT_MAX_PAGES, 1, 20, "max_pages_per_source");
  const path = statePath(options), state = readState(path);
  const listed = await client.call("craft_knowledge_source_list", { limit: 1_000 });
  if (!Array.isArray(listed.sources)) throw new Error("Knowledge source list must contain a sources array");
  const sources = (listed.sources as JsonObject[])
    .filter(source => source.status === "active" && source.access === "read_only" && (source.trust === "verified" || source.trust === "bounded") && typeof source.id === "string" && source.id.length > 0)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const eligibleRefs = new Set(sources.map(source => sourceRef(String(source.id))));
  const sourceCursors = Object.fromEntries(Object.entries(state.source_cursors).filter(([ref]) => eligibleRefs.has(ref)));
  const selected = rotateAfter(sources, state.last_source_ref).slice(0, maxSources), outcomes: JsonObject[] = [];
  for (const source of selected) {
    const sourceId = String(source.id);
    const ref = sourceRef(sourceId), savedCursor = sourceCursors[ref] ?? null;
    try {
      let result: SourceIngestResult;
      try { result = await ingestSource(client, sourceId, filesPerPage, maxPages, savedCursor); }
      catch (error) {
        if (!savedCursor || !staleCursor(error)) throw error;
        // Source content changed between passes. Its digest-pinned cursor is no longer valid;
        // restart from page one so the next cycle cannot fail forever on the stale position.
        delete sourceCursors[ref];
        result = await ingestSource(client, sourceId, filesPerPage, maxPages, null);
      }
      if (result.next_cursor) sourceCursors[ref] = result.next_cursor;
      else delete sourceCursors[ref];
      outcomes.push(result.outcome);
    }
    catch (error) { outcomes.push({ source_ref: sourceRef(sourceId), status: "failed", failure_kind: error instanceof Error ? error.name : "Error",
      failure_code: operationErrorCode(error) }); }
    await writeState(path, sourceId, sourceCursors);
  }
  return { sources_seen: sources.length, sources_selected: selected.length, outcomes,
    skipped_sources: (listed.sources as JsonObject[]).length - sources.length };
}
