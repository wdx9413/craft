import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { atomicPrivateJson, craftPaths, dataRoot } from "../common/craft-common-store-local/src/paths.ts";
import { projectIdentityFromRoot } from "./scope-identity.ts";
import { codexTaskGoalDigest } from "./codex-task-prose.ts";
import { stableDigest } from "./digest.ts";
import { extractCodexSessionVerificationArtifacts, type CodexTaskTranscriptRecord } from "./codex-session-verification.ts";
import type { JsonObject } from "./infrastructure/store.ts";

const STATE_SCHEMA = "craft.codex-session-collection.v1";
const DEFAULT_MAX_FILES = 25;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_TASK_EXCERPT_BYTES = 8 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export interface CodexSessionCollectionOptions {
  readonly sessions_root?: string;
  readonly archived_sessions_root?: string;
  readonly state_file?: string;
  readonly max_files?: number;
  readonly max_bytes?: number;
  readonly now?: string;
}

export interface CodexSessionTaskIndex {
  readonly task_id: string;
  readonly turn_id: string;
  readonly session_id: string;
  readonly project_scope_id: string | null;
  readonly dataset_partition: "candidate_generation" | "held_out";
  readonly dataset_split_version: "codex-session-split-v1";
  readonly status: "running" | "completed" | "aborted";
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly user_input_seen: boolean;
  readonly assistant_final_seen: boolean;
  readonly tool_call_count: number;
  readonly tool_output_count: number;
  readonly source_ref: string;
  readonly source_path: string;
  readonly source_root?: "archived_sessions";
  readonly source_start_byte: number;
  readonly source_end_byte: number;
  readonly task_goal_digest?: string;
  readonly verification_status: "unverified" | "verified";
  readonly raw_content_stored: false;
  readonly verification_evidence_ids?: readonly string[];
  readonly verification_artifact_digest?: string;
  readonly verification_artifact_count?: number;
  readonly verification_outcome?: "passed" | "failed";
  readonly context_receipt_id?: string;
  readonly verification_ref_digest?: string;
  readonly terminal_identity_digest?: string;
}

export interface CodexSessionTaskExcerptOptions extends CodexSessionCollectionOptions {
  readonly expected_partition: "candidate_generation" | "held_out";
}

export type CodexSessionTaskRangeReader = (path: string, target: Buffer, start: number) => Promise<number>;

interface ActiveTurn {
  turn_id: string;
  project_scope_id: string | null;
  status: "running" | "completed" | "aborted";
  started_at: string | null;
  completed_at: string | null;
  user_input_seen: boolean;
  assistant_final_seen: boolean;
  tool_call_count: number;
  tool_output_count: number;
  task_goal_digest?: string | null;
  source_start_byte: number;
  source_end_byte: number;
  rolling_digest: string;
  verification_artifacts: JsonObject[];
}

interface SourceState {
  size: number;
  mtime_ms: number;
  processed_bytes: number;
  session_id: string | null;
  project_scope_id: string | null;
  active_turn: ActiveTurn | null;
  task_ids: string[];
  task_goal_digest_version?: 0 | 1;
  verification_artifact_index_version?: 0 | 1;
}

interface CollectionState {
  schema: typeof STATE_SCHEMA;
  sources: Record<string, SourceState>;
  tasks: Record<string, CodexSessionTaskIndex>;
  evidence_cursor_session_id?: string;
  updated_at: string;
}

type ParsedRecord = { type?: unknown; payload?: unknown };
type RecordPayload = Record<string, unknown>;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown): RecordPayload | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordPayload : null;
}

function validLimit(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return result;
}

function taskKey(sessionId: string, turnId: string): string {
  return `codex_task_${hash(`${sessionId}\0${turnId}`).slice(0, 32)}`;
}

function datasetPartition(sessionId: string): "candidate_generation" | "held_out" {
  return Number.parseInt(hash(sessionId).slice(0, 8), 16) % 5 === 0 ? "held_out" : "candidate_generation";
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap(item => {
    const part = object(item);
    return part && (part.type === "input_text" || part.type === "output_text") && typeof part.text === "string" ? [part.text] : [];
  }).join("\n");
}

/** Keep only bounded task prose; never return code, paths, credentials, or opaque identifiers. */
function sanitizedTaskProse(value: string, maximum: number): string | null {
  const result = value.replace(/\bbearer\s+[^\s,，;；。！？]+/giu, "[已脱敏]")
    .replace(/(?:api[_ -]?key|authorization|cookie|password|secret|access[_ -]?token|token|ticket|账号|账户|帐号|密钥|密码|口令|令牌|凭证|票据)\s*(?::|=|：|＝|\bis\b|\bare\b|是|为)\s*["'“‘]?[^\s,，;；。！？]+/giu, "[已脱敏]")
    .replace(/```[\s\S]*?```/gu, " ").replace(/`[^`]*`/gu, " ")
    .replace(/https?:\/\/\S+/giu, " ").replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, " ")
    .replace(/(?:\/[\w.-]+){2,}|[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, " ")
    .replace(/\b(?:[a-f0-9]{32,}|[A-Za-z0-9_-]{40,})\b/giu, " ")
    .replace(/\b(?:\+?\d[\d ()-]{7,}\d)\b/gu, "[号码已脱敏]")
    .replace(/\s+/gu, " ").trim().slice(0, maximum).trim();
  return result.length >= 8 ? result : null;
}

function projectScope(cwd: unknown, cache: Map<string, string>): string | null {
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  const root = resolve(cwd);
  if (cache.has(root)) return cache.get(root)!;
  const identity = projectIdentityFromRoot(root).canonical_scope as { id: string };
  const scope = identity.id;
  cache.set(root, scope);
  return scope;
}

function emptyState(now: string): CollectionState {
  return { schema: STATE_SCHEMA, sources: {}, tasks: {}, updated_at: now };
}

function recordFromLine(line: Buffer): ParsedRecord | null {
  if (!line.length) return null;
  try { return object(JSON.parse(line.toString("utf8"))) as ParsedRecord | null; }
  catch { return null; }
}

function activeTurn(state: SourceState, turnId: string, offset: number): ActiveTurn {
  if (state.active_turn?.turn_id === turnId) return { ...state.active_turn, verification_artifacts: state.active_turn.verification_artifacts ?? [] };
  return {
    turn_id: turnId,
    project_scope_id: state.project_scope_id,
    status: "running",
    started_at: null,
    completed_at: null,
    user_input_seen: false,
    assistant_final_seen: false,
    tool_call_count: 0,
    tool_output_count: 0,
    task_goal_digest: null,
    source_start_byte: offset,
    source_end_byte: offset,
    rolling_digest: hash(`${state.session_id ?? "unknown"}\0${turnId}`),
    verification_artifacts: [],
  };
}

function retainTask(state: SourceState, task: CodexSessionTaskIndex): void {
  if (!state.task_ids.includes(task.task_id)) state.task_ids.push(task.task_id);
}

function finalizeTurn(sourcePath: string, state: SourceState, tasks: Record<string, CodexSessionTaskIndex>, turn: ActiveTurn,
  archived: boolean): void {
  const sessionId = state.session_id;
  if (!sessionId || !turn.user_input_seen) return;
  const taskId = taskKey(sessionId, turn.turn_id);
  const task: CodexSessionTaskIndex = {
    task_id: taskId,
    turn_id: turn.turn_id,
    session_id: sessionId,
    project_scope_id: turn.project_scope_id,
    dataset_partition: datasetPartition(sessionId),
    dataset_split_version: "codex-session-split-v1",
    status: turn.status,
    started_at: turn.started_at,
    completed_at: turn.completed_at,
    user_input_seen: turn.user_input_seen,
    assistant_final_seen: turn.assistant_final_seen,
    tool_call_count: turn.tool_call_count,
    tool_output_count: turn.tool_output_count,
    source_ref: `sha256:${turn.rolling_digest}`,
    source_path: sourcePath,
    ...(archived ? { source_root: "archived_sessions" as const } : {}),
    source_start_byte: turn.source_start_byte,
    source_end_byte: turn.source_end_byte,
    ...(turn.task_goal_digest ? { task_goal_digest: turn.task_goal_digest } : {}),
    verification_status: "unverified",
    raw_content_stored: false,
    ...(turn.verification_artifacts.length ? { verification_artifact_digest: `sha256:${hash(JSON.stringify(turn.verification_artifacts))}`,
      verification_artifact_count: turn.verification_artifacts.length } : {}),
  };
  const previous = tasks[taskId];
  // Archiving relocates identical bytes; it must not discard independently
  // verified Evidence. Rewritten content or scope must qualify again.
  tasks[taskId] = previous?.verification_status === "verified" && previous.source_ref === task.source_ref
    && previous.project_scope_id === task.project_scope_id ? { ...task,
      verification_status: previous.verification_status, verification_evidence_ids: previous.verification_evidence_ids,
      verification_outcome: previous.verification_outcome, context_receipt_id: previous.context_receipt_id,
      verification_ref_digest: previous.verification_ref_digest, terminal_identity_digest: previous.terminal_identity_digest,
      ...(task.verification_artifact_digest ? { verification_artifact_digest: task.verification_artifact_digest,
        verification_artifact_count: task.verification_artifact_count } : {}) } : task;
  retainTask(state, task);
}

function updateTurn(record: ParsedRecord | null, line: Buffer, offset: number, sourcePath: string,
  state: SourceState, tasks: Record<string, CodexSessionTaskIndex>, scopeCache: Map<string, string>, archived: boolean): void {
  if (!record || !record.type) return;
  const payload = object(record.payload);
  if (!payload) return;
  const recordType = String(record.type);
  const payloadType = typeof payload.type === "string" ? payload.type : "";

  if (recordType === "session_meta") {
    const sessionId = payload.session_id ?? payload.id;
    if (typeof sessionId === "string" && sessionId.trim()) state.session_id = sessionId.trim();
    if (typeof payload.cwd === "string") {
      state.project_scope_id = projectScope(payload.cwd, scopeCache);
      if (state.active_turn) state.active_turn.project_scope_id = state.project_scope_id;
    }
    return;
  }

  if (recordType === "turn_context") {
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
    if (typeof payload.cwd === "string") state.project_scope_id = projectScope(payload.cwd, scopeCache);
    if (turnId) {
      state.active_turn = activeTurn(state, turnId, offset);
      state.active_turn.project_scope_id = state.project_scope_id;
    }
    return;
  }

  if (recordType === "event_msg" && payloadType === "task_started") {
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
    if (!turnId) return;
    if (state.active_turn) finalizeTurn(sourcePath, state, tasks, state.active_turn, archived);
    state.active_turn = activeTurn(state, turnId, offset);
    state.active_turn.started_at = typeof payload.started_at === "string" ? payload.started_at : null;
    return;
  }

  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : state.active_turn?.turn_id;
  if (!turnId) return;
  const turn = activeTurn(state, turnId, offset);
  turn.project_scope_id = state.project_scope_id;
  turn.source_end_byte = offset + line.byteLength;
  turn.rolling_digest = hash(`${turn.rolling_digest}\0${hash(line)}`);

  if (recordType === "event_msg" && payloadType === "task_complete") {
    turn.status = "completed";
    turn.completed_at = typeof payload.completed_at === "string" ? payload.completed_at : null;
    finalizeTurn(sourcePath, state, tasks, turn, archived);
    state.active_turn = null;
  } else if (recordType === "event_msg" && payloadType === "turn_aborted") {
    turn.status = "aborted";
    finalizeTurn(sourcePath, state, tasks, turn, archived);
    state.active_turn = null;
  } else if (recordType === "response_item") {
    if (payloadType === "message" && payload.role === "user") {
      turn.user_input_seen = true;
      if (!turn.task_goal_digest) turn.task_goal_digest = codexTaskGoalDigest(messageText(payload.content));
    }
    if (payloadType === "message" && payload.role === "assistant" && payload.phase === "final_answer") turn.assistant_final_seen = true;
    if (payloadType === "function_call" || payloadType === "custom_tool_call") turn.tool_call_count++;
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") turn.tool_output_count++;
  }

  if (recordType === "event_msg" && payloadType === "item_completed") {
    const artifacts = extractCodexSessionVerificationArtifacts([{ record_type: "event_msg", payload: payload as JsonObject }]);
    for (const artifact of artifacts) {
      if (turn.verification_artifacts.length >= 8) break;
      if (!turn.verification_artifacts.some(existing => existing.call_digest === artifact.call_digest)) turn.verification_artifacts.push(artifact);
    }
  }

  if (state.active_turn?.turn_id === turn.turn_id) state.active_turn = turn;
}

function validateState(value: unknown, now: string): CollectionState {
  const input = object(value);
  if (!input || input.schema !== STATE_SCHEMA || !object(input.sources) || !object(input.tasks)) throw new Error("Codex session collection state is invalid");
  const sources: Record<string, SourceState> = {};
  for (const [path, raw] of Object.entries(input.sources as Record<string, unknown>)) {
    const source = object(raw);
    if (!source || typeof source.size !== "number" || !Number.isSafeInteger(source.size) || source.size < 0
      || typeof source.mtime_ms !== "number" || !Number.isFinite(source.mtime_ms)
      || typeof source.processed_bytes !== "number" || !Number.isSafeInteger(source.processed_bytes) || source.processed_bytes < 0 || source.processed_bytes > source.size
      || source.session_id !== null && typeof source.session_id !== "string"
      || source.project_scope_id !== null && typeof source.project_scope_id !== "string"
      || source.active_turn !== null && !object(source.active_turn)
      || source.task_goal_digest_version !== undefined && source.task_goal_digest_version !== 0 && source.task_goal_digest_version !== 1
      || source.verification_artifact_index_version !== undefined && source.verification_artifact_index_version !== 0 && source.verification_artifact_index_version !== 1
      || !Array.isArray(source.task_ids) || source.task_ids.some(id => typeof id !== "string")) throw new Error("Codex session collection source state is invalid");
    sources[path] = source as unknown as SourceState;
  }
  const tasks: Record<string, CodexSessionTaskIndex> = {};
  for (const [id, raw] of Object.entries(input.tasks as Record<string, unknown>)) {
    const task = object(raw);
    if (!task || task.task_id !== id || typeof task.session_id !== "string" || typeof task.turn_id !== "string"
      || !["running", "completed", "aborted"].includes(String(task.status)) || typeof task.source_path !== "string"
      || typeof task.source_ref !== "string" || task.raw_content_stored !== false
      || task.source_root !== undefined && task.source_root !== "archived_sessions"
      || task.verification_status !== "unverified" && task.verification_status !== "verified"
      || task.task_goal_digest !== undefined && (typeof task.task_goal_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(task.task_goal_digest))
      || task.verification_artifact_digest !== undefined && (typeof task.verification_artifact_digest !== "string" || !SHA256.test(task.verification_artifact_digest))
      || task.verification_artifact_count !== undefined && (!Number.isSafeInteger(task.verification_artifact_count) || Number(task.verification_artifact_count) < 1 || Number(task.verification_artifact_count) > 8)
      || (task.verification_artifact_digest === undefined) !== (task.verification_artifact_count === undefined)
      || task.verification_evidence_ids !== undefined && (!Array.isArray(task.verification_evidence_ids) || task.verification_evidence_ids.some(id => typeof id !== "string"))) throw new Error("Codex session task index is invalid");
    const normalized = task as unknown as CodexSessionTaskIndex;
    tasks[id] = { ...normalized,
      dataset_partition: normalized.dataset_partition === "held_out" ? "held_out" : normalized.dataset_partition === "candidate_generation" ? "candidate_generation" : datasetPartition(normalized.session_id),
      dataset_split_version: "codex-session-split-v1" };
  }
  const cursor = input.evidence_cursor_session_id;
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor.trim() || cursor.length > 256 || /[\r\n\0]/u.test(cursor))) {
    throw new Error("Codex session collection evidence cursor is invalid");
  }
  return { schema: STATE_SCHEMA, sources, tasks, ...(typeof cursor === "string" ? { evidence_cursor_session_id: cursor } : {}),
    updated_at: typeof input.updated_at === "string" ? input.updated_at : now };
}

async function readState(path: string, now: string): Promise<CollectionState> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 128 * 1024 * 1024) throw new Error("Codex session collection state file is invalid");
    return validateState(JSON.parse(await readFile(path, "utf8")), now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(now);
    throw error;
  }
}

async function listSessionFiles(root: string): Promise<string[]> {
  let rootInfo;
  try { rootInfo = await lstat(root); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      let parent = dirname(root);
      while (parent !== dirname(parent)) {
        try {
          const parentInfo = await lstat(parent);
          if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error("Codex sessions root must be a regular directory");
          break;
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
          parent = dirname(parent);
        }
      }
      return [];
    }
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Codex sessions root must be a regular directory");
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  await visit(root);
  return files;
}

export async function readCodexSessionChunk(path: string, start: number, fileSize: number, budget: number): Promise<{ bytes: Buffer; nextOffset: number }> {
  if (start >= fileSize) return { bytes: Buffer.alloc(0), nextOffset: start };
  let length = Math.min(fileSize - start, budget);
  const handle = await open(path, "r");
  try {
    while (true) {
      const bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, start);
      const content = bytes.subarray(0, result.bytesRead);
      const newline = content.lastIndexOf(0x0a);
      if (newline >= 0) return { bytes: content.subarray(0, newline + 1), nextOffset: start + newline + 1 };
      if (result.bytesRead === 0) return { bytes: Buffer.alloc(0), nextOffset: start };
      if (length >= MAX_LINE_BYTES) throw new Error("Codex session record exceeds the configured size limit");
      if (start + result.bytesRead >= fileSize) return { bytes: Buffer.alloc(0), nextOffset: start };
      length = Math.min(fileSize - start, Math.min(MAX_LINE_BYTES, length * 2));
    }
  } finally { await handle.close(); }
}

function sourceRoot(options: CodexSessionCollectionOptions, env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return resolve(options.sessions_root ?? join(codexHome, "sessions"));
}

function archiveRoot(options: CodexSessionCollectionOptions, env: NodeJS.ProcessEnv): string | null {
  if (options.archived_sessions_root !== undefined) return resolve(options.archived_sessions_root);
  // An explicitly scoped source must not silently authorize a sibling directory.
  if (options.sessions_root !== undefined) return null;
  return join(dirname(sourceRoot(options, env)), "archived_sessions");
}

function sourceKey(path: string, archived: boolean): string {
  // NUL cannot occur in filenames, so archive and legacy active keys cannot collide.
  return archived ? `archived_sessions\0${path}` : path;
}

function statePath(options: CodexSessionCollectionOptions, env: NodeJS.ProcessEnv): string {
  return resolve(options.state_file ?? join(craftPaths(dataRoot(env)).runtimeDir, "codex-session-collection.json"));
}

function removeSourceTasks(state: CollectionState, sourcePath: string, source: SourceState, archived: boolean): void {
  for (const id of source.task_ids) if (state.tasks[id]?.source_path === sourcePath
    && (state.tasks[id]?.source_root === "archived_sessions") === archived) delete state.tasks[id];
  source.task_ids = [];
}

function updateFile(bytes: Buffer, start: number, sourcePath: string, source: SourceState, state: CollectionState,
  scopeCache: Map<string, string>, archived: boolean): { next_offset: number; malformed_lines: number } {
  let lineStart = 0;
  let malformedLines = 0;
  while (lineStart < bytes.length) {
    const lineEnd = bytes.indexOf(0x0a, lineStart);
    let line = bytes.subarray(lineStart, lineEnd);
    if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.length > MAX_LINE_BYTES) throw new Error("Codex session record exceeds the configured size limit");
    const absoluteOffset = start + lineStart;
    const parsed = recordFromLine(line);
    if (line.length > 0 && parsed === null) malformedLines++;
    updateTurn(parsed, line, absoluteOffset, sourcePath, source, state.tasks, scopeCache, archived);
    lineStart = lineEnd + 1;
  }
  return { next_offset: start + lineStart, malformed_lines: malformedLines };
}

/**
 * Incrementally index Codex session/turn provenance. It stores only IDs, scope
 * fingerprints, event digests and counters; source conversation text is never
 * copied into Craft data.
 */
export async function runCodexSessionCollectionOnce(options: CodexSessionCollectionOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<JsonObject> {
  const maxFiles = validLimit(options.max_files, DEFAULT_MAX_FILES, 1, 500, "max_files");
  const maxBytes = validLimit(options.max_bytes, DEFAULT_MAX_BYTES, 1_024, 128 * 1024 * 1024, "max_bytes");
  const now = options.now ?? new Date().toISOString();
  const outputPath = statePath(options, env);
  const state = await readState(outputPath, now);
  const roots = [{ root: sourceRoot(options, env), archived: false }];
  const archive = archiveRoot(options, env);
  if (archive !== null) roots.push({ root: archive, archived: true });
  const files: Array<{ path: string; root: string; archived: boolean }> = [];
  for (const source of roots) for (const path of await listSessionFiles(source.root)) files.push({ ...source, path });
  const availableSources = new Set(files.map(source => sourceKey(relative(source.root, source.path).split(sep).join("/"), source.archived)));
  const candidates: Array<{ path: string; relativePath: string; key: string; archived: boolean; relocated: boolean; size: number; mtimeMs: number; prior: SourceState | null }> = [];
  for (const { path, root, archived } of files) {
    const info = await stat(path);
    const relativePath = relative(root, path).split(sep).join("/");
    const key = sourceKey(relativePath, archived);
    const prior = state.sources[key] ?? null;
    const relocated = prior !== null && prior.task_ids.some(id => {
      const task = state.tasks[id];
      return task !== undefined && !availableSources.has(sourceKey(task.source_path, task.source_root === "archived_sessions"));
    });
    if (prior && !relocated && prior.size === info.size && prior.mtime_ms === info.mtimeMs && prior.processed_bytes >= info.size
      && prior.task_goal_digest_version === 1 && prior.verification_artifact_index_version === 1) continue;
    candidates.push({ path, relativePath, key, archived, relocated, size: info.size, mtimeMs: info.mtimeMs, prior });
  }
  // Oldest sources first ensure a stream of newly-created sessions cannot
  // starve the historical archive. A growing source resumes from its offset.
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.key.localeCompare(right.key));

  let bytesLeft = maxBytes, processedFiles = 0, processedBytes = 0, malformedLines = 0;
  const scopeCache = new Map<string, string>();
  for (const candidate of candidates.slice(0, maxFiles)) {
    if (bytesLeft <= 0) break;
    const previous = candidate.prior;
    const sourceChanged = previous !== null && (candidate.size < previous.size
      || candidate.size === previous.size && candidate.mtimeMs !== previous.mtime_ms);
    const backfillTaskGoalDigests = previous !== null && previous.task_goal_digest_version === undefined && !sourceChanged;
    const backfillVerificationArtifacts = previous !== null && previous.verification_artifact_index_version !== 1 && !sourceChanged;
    const restartVerificationBackfill = backfillVerificationArtifacts && previous.processed_bytes >= previous.size;
    const shouldRestart = sourceChanged || backfillTaskGoalDigests || restartVerificationBackfill || candidate.relocated;
    const current: SourceState = shouldRestart || !previous
      ? { size: candidate.size, mtime_ms: candidate.mtimeMs, processed_bytes: 0, session_id: null, project_scope_id: null, active_turn: null, task_ids: [],
        task_goal_digest_version: backfillTaskGoalDigests ? 0 : 1,
        verification_artifact_index_version: backfillVerificationArtifacts ? 0 : 1 }
      : { ...previous, size: candidate.size, mtime_ms: candidate.mtimeMs,
        ...(backfillVerificationArtifacts ? { verification_artifact_index_version: 0 as const } : {}) };
    if (sourceChanged && previous) removeSourceTasks(state, candidate.relativePath, previous, candidate.archived);
    const amount = Math.min(bytesLeft, Math.max(1, candidate.size - current.processed_bytes));
    const chunk = await readCodexSessionChunk(candidate.path, current.processed_bytes, candidate.size, amount);
    const oldOffset = current.processed_bytes;
    const update = updateFile(chunk.bytes, oldOffset, candidate.relativePath, current, state, scopeCache, candidate.archived);
    const nextOffset = update.next_offset;
    malformedLines += update.malformed_lines;
    current.processed_bytes = nextOffset;
    if (current.processed_bytes >= candidate.size) current.task_goal_digest_version = 1;
    if (current.processed_bytes >= candidate.size) current.verification_artifact_index_version = 1;
    if (chunk.bytes.length === 0 && nextOffset === oldOffset && oldOffset < candidate.size) {
      // A final non-newline JSONL record is reread next pass so a later append
      // cannot split or lose an event.
      current.processed_bytes = oldOffset;
    }
    state.sources[candidate.key] = current;
    processedFiles++;
    processedBytes += Math.max(0, current.processed_bytes - oldOffset);
    bytesLeft -= Math.max(1, chunk.bytes.length);
  }

  state.updated_at = now;
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await atomicPrivateJson(outputPath, state);
  const indexed = Object.values(state.tasks);
  const remaining = candidates.filter(candidate => {
    const source = state.sources[candidate.key];
    return !source || source.size !== candidate.size || source.mtime_ms !== candidate.mtimeMs
      || source.processed_bytes < candidate.size;
  }).length;
  return {
    status: files.length === 0 ? "source_unavailable" : remaining > 0 ? "partial" : "completed",
    sessions_seen: files.length,
    sessions_pending: remaining,
    sessions_processed: processedFiles,
    bytes_processed: processedBytes,
    tasks_indexed: indexed.length,
    tasks_completed: indexed.filter(task => task.status === "completed").length,
    tasks_aborted: indexed.filter(task => task.status === "aborted").length,
    tasks_candidate_generation: indexed.filter(task => task.dataset_partition === "candidate_generation").length,
    tasks_held_out: indexed.filter(task => task.dataset_partition === "held_out").length,
    tasks_with_user_input: indexed.filter(task => task.user_input_seen).length,
    tasks_verified: indexed.filter(task => task.verification_status === "verified").length,
    tasks_with_test_evidence: indexed.filter(task => task.verification_artifact_count !== undefined).length,
    malformed_lines: malformedLines,
    raw_content_stored: false,
    state_file: outputPath,
  };
}

/** Return a bounded list of source sessions that still need verification lookup. */
export async function codexSessionEvidenceBatch(options: CodexSessionCollectionOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<JsonObject> {
  const state = await readState(statePath(options, env), options.now ?? new Date().toISOString());
  const tasks = Object.values(state.tasks);
  const pendingSessionIds = new Set(tasks.filter(task => task.verification_status === "unverified").map(task => task.session_id));
  const allSessionIds = [...new Set(tasks.map(task => task.session_id))];
  const cursorIndex = state.evidence_cursor_session_id ? allSessionIds.indexOf(state.evidence_cursor_session_id) : -1;
  const rotated = cursorIndex < 0 ? allSessionIds : [...allSessionIds.slice(cursorIndex + 1), ...allSessionIds.slice(0, cursorIndex + 1)];
  const sessionIds = rotated.filter(sessionId => pendingSessionIds.has(sessionId)).slice(0, 100);
  return { session_ids: sessionIds, tasks_pending: tasks.filter(task => task.verification_status === "unverified").length,
    sessions_pending: pendingSessionIds.size, next_evidence_cursor_session_id: sessionIds.at(-1) ?? null };
}

/** List bounded task provenance for one dataset partition; conversation text is never returned. */
export async function codexSessionTaskBatch(partition: "candidate_generation" | "held_out",
  options: CodexSessionCollectionOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<JsonObject> {
  if (partition !== "candidate_generation" && partition !== "held_out") throw new Error("partition is unsupported");
  const state = await readState(statePath(options, env), options.now ?? new Date().toISOString());
  const allTasks = Object.values(state.tasks);
  const eligibleTasks = allTasks.filter(task => {
    const contextVerified = task.verification_status === "verified" && Boolean(task.verification_evidence_ids?.length);
    const transcriptVerified = typeof task.verification_artifact_digest === "string"
      && typeof task.verification_artifact_count === "number" && task.verification_artifact_count > 0;
    // A passing intermediate test cannot override a verified failed terminal task.
    const outcomePassed = task.verification_outcome !== "failed" && (task.verification_outcome === "passed" || transcriptVerified);
    return task.dataset_partition === partition && task.status === "completed" && task.assistant_final_seen
      && (contextVerified || transcriptVerified) && (partition !== "candidate_generation" || outcomePassed);
  });
  const overlappingTasks = eligibleTasks.filter(task => task.task_goal_digest && task.project_scope_id
    && allTasks.some(other => other.task_id !== task.task_id && other.project_scope_id === task.project_scope_id
      && other.task_goal_digest === task.task_goal_digest && other.dataset_partition !== task.dataset_partition));
  const tasks = eligibleTasks.filter(task => !overlappingTasks.includes(task))
    .sort((left, right) => String(left.completed_at ?? "").localeCompare(String(right.completed_at ?? "")) || left.task_id.localeCompare(right.task_id));
  return { tasks: tasks.map(task => ({ task_id: task.task_id, session_id: task.session_id, turn_id: task.turn_id,
    project_scope_id: task.project_scope_id, dataset_partition: task.dataset_partition, dataset_split_version: task.dataset_split_version,
    task_goal_digest: task.task_goal_digest ?? null,
    verification_evidence_ids: task.verification_evidence_ids ?? [], verification_outcome: task.verification_outcome ?? null,
    verification_source: task.verification_status === "verified" && task.verification_evidence_ids?.length ? "context_receipt" : "session_test_log",
    verification_artifact_digest: task.verification_artifact_digest ?? null,
    verification_artifact_count: task.verification_artifact_count ?? 0,
    context_receipt_id: task.context_receipt_id ?? null, verification_ref_digest: task.verification_ref_digest ?? null,
    terminal_identity_digest: task.terminal_identity_digest ?? null, source_ref: task.source_ref, completed_at: task.completed_at,
    content_stored: false, raw_content_stored: false })),
    excluded_cross_partition_task_goal_overlap: overlappingTasks.length,
    content_stored: false, raw_content_stored: false };
}

/** Persist the last successfully queried session so newer Host Evidence cannot starve behind old archives. */
export async function commitCodexSessionEvidenceBatch(sessionIdsValue: unknown,
  options: CodexSessionCollectionOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<JsonObject> {
  if (!Array.isArray(sessionIdsValue) || sessionIdsValue.length < 1 || sessionIdsValue.length > 100
    || sessionIdsValue.some(sessionId => typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 256 || /[\r\n\0]/u.test(sessionId))) {
    throw new Error("session_ids must contain 1 to 100 bounded Host session identifiers");
  }
  const sessionIds = sessionIdsValue as string[];
  if (new Set(sessionIds).size !== sessionIds.length) throw new Error("session_ids must be unique");
  const path = statePath(options, env), state = await readState(path, options.now ?? new Date().toISOString());
  const indexedSessions = new Set(Object.values(state.tasks).map(task => task.session_id));
  if (sessionIds.some(sessionId => !indexedSessions.has(sessionId))) throw new Error("session_ids must refer to indexed Host sessions");
  state.evidence_cursor_session_id = sessionIds.at(-1)!;
  state.updated_at = options.now ?? new Date().toISOString();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicPrivateJson(path, state);
  return { status: "advanced", sessions_queried: sessionIds.length, cursor_stored: true, raw_content_stored: false };
}

/** Bind only exact, content-free Host completion Evidence to the archived session and turn. */
export async function reconcileCodexSessionTaskEvidence(evidenceValue: unknown,
  options: CodexSessionCollectionOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<JsonObject> {
  const evidence = Array.isArray(evidenceValue) ? evidenceValue.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
  const byTurn = new Map<string, JsonObject[]>(), evidenceByTaskGoal = new Map<string, JsonObject[]>();
  for (const item of evidence) {
    if (item.verified !== true || item.content_stored !== false || typeof item.session_id !== "string" || typeof item.turn_id !== "string"
      || typeof item.evidence_id !== "string" || typeof item.context_receipt_id !== "string"
      || typeof item.verification_ref_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item.verification_ref_digest)
      || typeof item.terminal_identity_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item.terminal_identity_digest)
      || item.verification_outcome !== "passed" && item.verification_outcome !== "failed") continue;
    const key = `${item.session_id}\0${item.turn_id}`;
    byTurn.set(key, [...(byTurn.get(key) ?? []), item]);
    if (typeof item.task_goal_digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(item.task_goal_digest)
      && typeof item.project_scope_id === "string" && /^project:[A-Za-z0-9_-]{1,96}$/u.test(item.project_scope_id)) {
      const goalKey = `${item.session_id}\0${item.project_scope_id}\0${item.task_goal_digest}`;
      evidenceByTaskGoal.set(goalKey, [...(evidenceByTaskGoal.get(goalKey) ?? []), item]);
    }
  }
  const path = statePath(options, env);
  const state = await readState(path, options.now ?? new Date().toISOString());
  let verified = 0;
  for (const task of Object.values(state.tasks)) {
    if (task.verification_status === "verified") continue;
    let matches = byTurn.get(`${task.session_id}\0${task.turn_id}`) ?? [];
    if (!matches.length && task.task_goal_digest && task.project_scope_id) {
      const sameGoalTasks = Object.values(state.tasks).filter(candidate => candidate.session_id === task.session_id
        && candidate.project_scope_id === task.project_scope_id && candidate.task_goal_digest === task.task_goal_digest
        && candidate.status === "completed" && candidate.user_input_seen && candidate.assistant_final_seen);
      const goalEvidence = evidenceByTaskGoal.get(`${task.session_id}\0${task.project_scope_id}\0${task.task_goal_digest}`) ?? [];
      if (sameGoalTasks.length === 1 && goalEvidence.length === 1) matches = goalEvidence;
    }
    // A matching turn is not enough when the Host also supplied a conflicting
    // project, goal, or terminal identity. Preserve legacy records without
    // optional scope fields, but never attach a known mismatch to this task.
    if (matches.some(item => (item.host !== undefined && item.host !== "codex" && item.host !== "codex-cli")
      || (item.project_scope_id !== undefined && item.project_scope_id !== task.project_scope_id)
      || (item.task_goal_digest !== undefined && item.task_goal_digest !== task.task_goal_digest))) continue;
    const outcomes = new Set(matches.map(item => item.verification_outcome));
    const terminals = new Set(matches.map(item => item.terminal_identity_digest));
    if (matches.length === 0 || outcomes.size !== 1 || terminals.size !== 1) continue;
    const selected = matches[0]!;
    state.tasks[task.task_id] = { ...task, verification_status: "verified", verification_evidence_ids: matches.map(item => String(item.evidence_id)).sort(),
      verification_outcome: selected.verification_outcome as "passed" | "failed", context_receipt_id: String(selected.context_receipt_id),
      verification_ref_digest: String(selected.verification_ref_digest), terminal_identity_digest: String(selected.terminal_identity_digest) };
    verified++;
  }
  if (verified > 0) {
    state.updated_at = options.now ?? new Date().toISOString();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicPrivateJson(path, state);
  }
  return { status: verified > 0 ? "reconciled" : "no_match", tasks_verified: verified, evidence_received: evidence.length,
    raw_content_stored: false, state_file: path };
}

/**
 * Read one exact, verified task span for a downstream candidate or held-out evaluator.
 * The original bytes exist only in this call's memory and are never written to Craft data.
 */
export async function readCodexSessionTaskExcerpt(taskIdValue: unknown, options: CodexSessionTaskExcerptOptions,
  env: NodeJS.ProcessEnv = process.env, rangeReader?: CodexSessionTaskRangeReader): Promise<JsonObject> {
  if (typeof taskIdValue !== "string" || !taskIdValue.trim() || taskIdValue.length > 160) throw new Error("task_id must be a bounded string");
  if (options.expected_partition !== "candidate_generation" && options.expected_partition !== "held_out") throw new Error("expected_partition is unsupported");
  const state = await readState(statePath(options, env), options.now ?? new Date().toISOString());
  const task = state.tasks[taskIdValue.trim()];
  const contextVerified = task?.verification_status === "verified" && Boolean(task.verification_evidence_ids?.length);
  const transcriptVerified = typeof task?.verification_artifact_digest === "string"
    && typeof task.verification_artifact_count === "number" && task.verification_artifact_count > 0;
  if (!task || task.status !== "completed" || (!contextVerified && !transcriptVerified) || !task.assistant_final_seen
    || task.dataset_partition !== options.expected_partition) {
    return { status: "ineligible", reason: "task_not_verified_or_partition_mismatch", raw_content_stored: false };
  }
  if (options.expected_partition === "candidate_generation" && task.verification_outcome === "failed")
    return { status: "ineligible", reason: "task_terminal_outcome_failed", raw_content_stored: false };
  if (task.task_goal_digest && task.project_scope_id && Object.values(state.tasks).some(other => other.task_id !== task.task_id
    && other.project_scope_id === task.project_scope_id && other.task_goal_digest === task.task_goal_digest
    && other.dataset_partition !== task.dataset_partition)) {
    return { status: "ineligible", reason: "cross_partition_task_goal_overlap", raw_content_stored: false };
  }
  const root = task.source_root === "archived_sessions" ? archiveRoot(options, env) : sourceRoot(options, env);
  if (root === null) return { status: "ineligible", reason: "task_source_root_unavailable", raw_content_stored: false };
  const canonicalRoot = await realpath(root);
  if (task.source_path.startsWith("/") || task.source_path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Codex task source reference is invalid");
  }
  const sourcePath = resolve(root, ...task.source_path.split("/"));
  const canonicalSource = await realpath(sourcePath);
  if (!canonicalSource.startsWith(`${canonicalRoot}${sep}`)) throw new Error("Codex task source escaped the sessions root");
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink() || !info.isFile() || task.source_end_byte <= task.source_start_byte
    || task.source_end_byte > info.size || task.source_end_byte - task.source_start_byte > MAX_TASK_EXCERPT_BYTES) {
    return { status: "ineligible", reason: "task_source_span_invalid_or_oversized", raw_content_stored: false };
  }
  const buffer = Buffer.alloc(task.source_end_byte - task.source_start_byte);
  const readRange = rangeReader ?? (async (path: string, target: Buffer, start: number) => {
    const handle = await open(path, "r");
    try { return (await handle.read(target, 0, target.length, start)).bytesRead; }
    finally { await handle.close(); }
  });
  if (await readRange(sourcePath, buffer, task.source_start_byte) !== buffer.length) {
    return { status: "ineligible", reason: "task_source_changed_during_read", raw_content_stored: false };
  }
  const lines = buffer.toString("utf8").split(/\r?\n/u);
  let rollingDigest = hash(`${task.session_id}\0${task.turn_id}`);
  let taskGoal: string | null = null, taskResult: string | null = null;
  const verificationRecords: CodexTaskTranscriptRecord[] = [];
  for (const line of lines) {
    if (!line) continue;
    const lineBytes = Buffer.from(line);
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const record = object(parsed), payload = object(record?.payload);
    const recordType = typeof record?.type === "string" ? record.type : "";
    const payloadType = typeof payload?.type === "string" ? payload.type : "";
    const recordTurnId = typeof payload?.turn_id === "string" ? payload.turn_id : task.turn_id;
    if (recordType === "response_item" && payload
      && (payloadType === "custom_tool_call" || payloadType === "custom_tool_call_output")) {
      verificationRecords.push({ record_type: "response_item", payload });
    } else if (recordType === "event_msg" && payload && recordTurnId === task.turn_id && payloadType === "item_completed") {
      verificationRecords.push({ record_type: "event_msg", payload });
    }
    if (recordType && payload && recordTurnId === task.turn_id && recordType !== "session_meta" && recordType !== "turn_context"
      && !(recordType === "event_msg" && payloadType === "task_started")) {
      rollingDigest = hash(`${rollingDigest}\0${hash(lineBytes)}`);
    }
    if (record?.type !== "response_item" || !payload || payload.type !== "message") continue;
    const content = messageText(payload.content);
    if (payload.role === "user" && !taskGoal) taskGoal = sanitizedTaskProse(content, 1_000);
    if (payload.role === "assistant" && payload.phase === "final_answer") taskResult = sanitizedTaskProse(content, 1_000);
  }
  if (`sha256:${rollingDigest}` !== task.source_ref) return { status: "ineligible", reason: "task_source_digest_mismatch", raw_content_stored: false };
  if (!taskGoal || !taskResult) return { status: "ineligible", reason: "sanitized_task_summary_unavailable", raw_content_stored: false };
  const verificationArtifacts = extractCodexSessionVerificationArtifacts(verificationRecords);
  if (transcriptVerified && (verificationArtifacts.length !== task.verification_artifact_count
    || `sha256:${hash(JSON.stringify(verificationArtifacts))}` !== task.verification_artifact_digest)) {
    return { status: "ineligible", reason: "transcript_test_evidence_digest_mismatch", raw_content_stored: false };
  }
  return { status: "ready", task_id: task.task_id, session_id: task.session_id, turn_id: task.turn_id,
    project_scope_id: task.project_scope_id, dataset_partition: task.dataset_partition, dataset_split_version: task.dataset_split_version,
    source_ref: task.source_ref, evidence_ids: task.verification_evidence_ids ?? [],
    verification_outcome: task.verification_outcome ?? (transcriptVerified ? null : undefined),
    verification_source: contextVerified ? "context_receipt" : "session_test_log",
    task_goal: taskGoal, task_result: taskResult, verification_artifacts: verificationArtifacts,
    sanitized: true, content_stored: false, raw_content_stored: false };
}

/** Compare a caller's proposed test Evidence to the indexed, sanitized Host task.
 * A matching test transcript is not proof of the terminal task outcome or benefit. */
export async function verifyCodexSessionEvidenceInput(input: JsonObject, options: CodexSessionTaskExcerptOptions,
  env: NodeJS.ProcessEnv = process.env): Promise<JsonObject> {
  if (typeof input.task_id !== "string" || !input.task_id.trim()) return { status: "unverified", reason: "task_id_missing" };
  const excerpt = await readCodexSessionTaskExcerpt(input.task_id, options, env);
  if (excerpt.status !== "ready") return { status: "unverified", reason: "task_excerpt_unavailable" };
  if (input.scope !== excerpt.project_scope_id || input.source_session_id !== excerpt.session_id || input.turn_id !== excerpt.turn_id
    || input.source_ref !== excerpt.source_ref || input.task_goal !== excerpt.task_goal || input.task_result !== excerpt.task_result
    || input.sanitized !== true || !Array.isArray(input.verification_artifacts)
    || input.verification_artifacts.length === 0 || stableDigest(input.verification_artifacts) !== stableDigest(excerpt.verification_artifacts)) {
    return { status: "unverified", reason: "task_evidence_mismatch" };
  }
  return { status: "transcript_matched", verification_outcome: excerpt.verification_outcome ?? null,
    task_result_verified: false, claim_effect_proven: false, raw_content_stored: false };
}
