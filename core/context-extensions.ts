import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bm25Index } from "../common/craft-common-base/src/bm25.ts";
import { retrievalExcerpt } from "../common/craft-common-base/src/retrieval-excerpt.ts";
import { sessionStorageScopeId } from "../common/craft-common-store-local/src/paths.ts";
import { codebaseUsageWeights, recordCodebaseSymbolUsage } from "../capability/craft-codebase/usage-signals.ts";
import { payload, stableDigest } from "./digest.ts";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";

const EPHEMERAL_KIND = "context_ephemeral_index";
const RESUME_KIND = "context_resume_snapshot";
const DEFAULT_TTL_SECONDS = 3_600;
const MAX_TTL_SECONDS = 86_400;
const MAX_EPHEMERAL_ITEMS = 500;
const MAX_EPHEMERAL_CHARS = 400_000;
const MAX_CODE_CHARS = 200_000;
const MAX_COMPUTE_TIMEOUT_MS = 30_000;
const MAX_COMPUTE_OUTPUT = 65_536;
const COMPUTE_LANGUAGES = new Set(["javascript", "python", "shell"]);
const SCAN_LIMIT = 100_000;

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function stringList(value: unknown, name: string, limit: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > limit) throw new Error(`${name} exceeds the item limit`);
  const items = value.map((item) => nonEmpty(item, name));
  if (items.some(item => item.length > 2_000) || items.reduce((total, item) => total + item.length, 0) > 8_000) {
    throw new Error(`${name} exceeds the character limit`);
  }
  return items;
}

function isoNow(value: unknown): string {
  const now = value === undefined ? new Date().toISOString() : nonEmpty(value, "now");
  if (Number.isNaN(Date.parse(now))) throw new Error("now must be an ISO timestamp");
  return now;
}

function ephemeralId(sessionId: string, host: string, source: string): string {
  return `context_ephemeral_${stableDigest({ session_scope_id: sessionStorageScopeId(host, sessionId), source }).slice(-32)}`;
}

function resumeId(sessionId: string, host: string): string {
  return `context_resume_${stableDigest({ session_scope_id: sessionStorageScopeId(host, sessionId) }).slice(-32)}`;
}

function assertEphemeralOwner(record: JsonObject, sessionId: string, host: string, source: string): void {
  if (record.session_id !== sessionId || record.session_host !== host || record.session_scope_id !== sessionStorageScopeId(host, sessionId) || record.source !== source) throw new Error("ephemeral index scope mismatch");
}

function assertSessionActive(store: CraftStore, scopeId: string): void {
  const digest = createHash("sha256").update(scopeId).digest("hex");
  if (store.find("memory_session_archive", `memory_session_archive_${digest.slice(-32)}`, undefined, false)) throw new Error("SESSION_ARCHIVED: session Context is unavailable");
}

export function computeEnv(cwd: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: cwd, USERPROFILE: cwd, TEMP: cwd, TMP: cwd, TMPDIR: cwd };
  if (source.PATH) env.PATH = source.PATH;
  if (source.SystemRoot) env.SystemRoot = source.SystemRoot;
  if (source.PATHEXT) env.PATHEXT = source.PATHEXT;
  return env;
}

/** Choose the runner for one language/platform pair. Exported so both platform branches stay testable. */
export function computeCommand(language: string, platform: NodeJS.Platform, cwd: string, nodePath: string): { command: string; argv: string[]; file: string } {
  if (language === "javascript") {
    const file = join(cwd, "main.mjs");
    return { command: nodePath, argv: [file], file };
  }
  if (language === "python") {
    const file = join(cwd, "main.py");
    return { command: platform === "win32" ? "python" : "python3", argv: [file], file };
  }
  if (platform === "win32") {
    const file = join(cwd, "main.ps1");
    return { command: "powershell", argv: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], file };
  }
  const file = join(cwd, "main.sh");
  return { command: "/bin/sh", argv: [file], file };
}

/**
 * Governed context extensions: bounded local computation, session-scoped
 * ephemeral indexing, output capture, resume snapshots, savings accounting and
 * a per-client routing block.
 *
 * Deliberately *not* a security sandbox: `compute` runs a bounded subprocess
 * with a timeout, output cap and a fresh temp working directory, but it cannot
 * deny network on the host. Strong isolation stays in the existing
 * `craft_docker_sandbox_*` ticket path, which is a `forbidden` tier for the
 * internal loop. This kernel is therefore honest in its receipts instead of
 * claiming isolation it does not provide.
 */
export class ContextExtensionsKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /** P2: generate the routing block that tells a Host where large data should go. */
  renderRouting(args: JsonObject): JsonObject {
    const client = args.client === undefined ? "codex" : nonEmpty(args.client, "client");
    const content = [
      "<context_window_protection>",
      "  Keep raw tool output out of the conversation. Compute runs in a bounded subprocess, not a security sandbox; print only the answer.",
      `  - Compute: craft_context_compute(language, code, allow_execution=true)`,
      `  - Capture a large result: craft_context_output_capture(tool_name, content, session_id, session_host)`,
      `  - Query captured data: craft_context_ephemeral_search(session_id, session_host, source, query)`,
      `  - Resume after compaction: craft_context_resume_resolve(session_id, session_host)`,
      `  - Prove savings: craft_context_stats()`,
      "  Do not paste large raw data into the conversation. Write to a file or capture it, then query it.",
      "</context_window_protection>",
    ].join("\n");
    return { client, content, tool_names: ["craft_context_compute", "craft_context_output_capture",
      "craft_context_ephemeral_record", "craft_context_ephemeral_search", "craft_context_stats"], execution_context: false };
  }

  /** P1-1: store a bounded, session-scoped, purgeable index. Never promoted to Knowledge. */
  recordEphemeral(args: JsonObject): JsonObject {
    const sessionId = nonEmpty(args.session_id, "session_id");
    const host = nonEmpty(args.session_host, "session_host");
    const sessionScopeId = sessionStorageScopeId(host, sessionId);
    const source = args.source === undefined ? "default" : nonEmpty(args.source, "source");
    if (!Array.isArray(args.items) || args.items.length === 0) throw new Error("items must be a non-empty array");
    if (args.items.length > MAX_EPHEMERAL_ITEMS) throw new Error("items exceeds the ephemeral index item limit");
    let totalChars = 0;
    const byId = new Map<string, JsonObject>();
    args.items.forEach((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("each item must be an object");
      const value = raw as JsonObject;
      const body = nonEmpty(value.text ?? value.content, "items.text");
      totalChars += body.length;
      if (totalChars > MAX_EPHEMERAL_CHARS) throw new Error("items exceed the ephemeral index character limit");
      const id = value.id === undefined ? `${source}:${index}` : nonEmpty(value.id, "items.id");
      byId.set(id, { id, text: body, title: value.title === undefined ? null : String(value.title),
        source: value.source === undefined ? source : String(value.source) });
    });
    const items = [...byId.values()];
    const ttlSeconds = boundedInteger(args.ttl_seconds ?? DEFAULT_TTL_SECONDS, "ttl_seconds", 1, MAX_TTL_SECONDS);
    const createdAt = isoNow(args.now);
    const expiresAt = new Date(Date.parse(createdAt) + ttlSeconds * 1_000).toISOString();
    const indexId = String(args.index_id ?? ephemeralId(sessionId, host, source));
    const identityDigest = stableDigest({ session_scope_id: sessionScopeId, source, items });
    const payload = { session_id: sessionId, session_host: host, session_scope_id: sessionScopeId, source, items, item_count: items.length, total_chars: totalChars,
      expires_at: expiresAt, identity_digest: identityDigest, content_free: false, ephemeral: true };
    const record = this.store.transaction(() => {
      assertSessionActive(this.store, sessionScopeId);
      const existing = this.store.find(EPHEMERAL_KIND, indexId, undefined, false);
      if (existing) assertEphemeralOwner(existing, sessionId, host, source);
      return existing ? this.store.save(EPHEMERAL_KIND, indexId, payload) : this.store.create(EPHEMERAL_KIND, indexId, payload);
    });
    return { index_id: record.id, session_id: sessionId, source, item_count: items.length, total_chars: totalChars,
      expires_at: expiresAt, identity_digest: identityDigest, ephemeral: true };
  }

  /** P1-1: BM25 search over an ephemeral index; expired indexes are removed on read. */
  searchEphemeral(args: JsonObject): JsonObject {
    const sessionId = nonEmpty(args.session_id, "session_id");
    const host = nonEmpty(args.session_host, "session_host");
    assertSessionActive(this.store, sessionStorageScopeId(host, sessionId));
    const source = args.source === undefined ? "default" : nonEmpty(args.source, "source");
    const query = nonEmpty(args.query, "query");
    const limit = boundedInteger(args.limit ?? 5, "limit", 1, 50);
    const indexId = String(args.index_id ?? ephemeralId(sessionId, host, source));
    let record = this.store.find(EPHEMERAL_KIND, indexId, undefined, false);
    if (!record) return { hits: [], reason: "index_missing", index_id: indexId, execution_context: false };
    assertEphemeralOwner(record, sessionId, host, source);
    if (Date.parse(String(record.expires_at)) <= Date.parse(isoNow(args.now))) {
      record = this.store.transaction(() => {
        const current = this.store.find(EPHEMERAL_KIND, indexId, undefined, false);
        if (!current) return null;
        assertEphemeralOwner(current, sessionId, host, source);
        if (Date.parse(String(current.expires_at)) > Date.parse(isoNow(args.now))) return current;
        this.store.remove(EPHEMERAL_KIND, indexId);
        return null;
      });
      if (!record) return { hits: [], reason: "index_expired", index_id: indexId, execution_context: false };
    }
    const items = (Array.isArray(record.items) ? record.items : []) as JsonObject[];
    if (args.read_item_id !== undefined) {
      const digest = nonEmpty(args.identity_digest, "identity_digest");
      if (record.identity_digest !== digest) throw new Error("ephemeral index changed; search again");
      const itemId = nonEmpty(args.read_item_id, "read_item_id");
      const item = items.find(candidate => String(candidate.id) === itemId);
      if (!item) throw new Error("ephemeral item not found");
      const body = String(item.text ?? "");
      const excerpt = retrievalExcerpt(body, query, 400);
      const start = boundedInteger(args.read_start, "read_start", 0, body.length);
      const end = boundedInteger(args.read_end, "read_end", start, body.length);
      const maxChars = boundedInteger(args.max_chars ?? 8_000, "max_chars", 1, 8_000);
      if (excerpt.source_start !== start || excerpt.source_end !== end) throw new Error("requested range must match the search excerpt");
      if (end - start > maxChars) throw new Error("required excerpt exceeds max_chars; increase the budget or inspect the source directly");
      return { index_id: indexId, item_id: itemId, content: body.slice(start, end), source_start: start, source_end: end,
        reason: "expanded", execution_context: false };
    }
    const index = new Bm25Index();
    for (const item of items) index.add(String(item.id), `${String(item.title ?? "")} ${String(item.text ?? "")}`.trim());
    const hits = index.score(query).slice(0, limit).map((hit) => {
      const item = items.find((candidate) => String(candidate.id) === hit.id)!;
      const excerpt = retrievalExcerpt(String(item.text ?? ""), query, 400);
      return { id: hit.id, score: hit.score, title: item.title ?? null, source: item.source ?? source,
        preview: excerpt.text, excerpt_reason: excerpt.reason, source_start: excerpt.source_start, source_end: excerpt.source_end };
    });
    return { hits, index_id: indexId, identity_digest: record.identity_digest ?? null, reason: hits.length ? "matched" : "no_match", execution_context: false };
  }

  /** P1-1: permanently remove session-scoped ephemeral content. */
  purgeEphemeral(args: JsonObject): JsonObject {
    const sessionId = nonEmpty(args.session_id, "session_id");
    const host = nonEmpty(args.session_host, "session_host");
    const sessionScopeId = sessionStorageScopeId(host, sessionId);
    const source = args.source === undefined ? null : nonEmpty(args.source, "source");
    const removed = this.store.transaction(() => {
      const ids = source === null
        ? this.store.list(EPHEMERAL_KIND, SCAN_LIMIT, (item) => item.session_id === sessionId && item.session_host === host && item.session_scope_id === sessionScopeId, false).map((item) => String(item.id))
        : [String(args.index_id ?? ephemeralId(sessionId, host, source))];
      let count = 0;
      for (const id of ids) {
        const record = this.store.find(EPHEMERAL_KIND, id, undefined, false);
        if (!record) continue;
        assertEphemeralOwner(record, sessionId, host, source ?? String(record.source));
        count += this.store.remove(EPHEMERAL_KIND, id);
      }
      return count;
    });
    return { removed, session_id: sessionId, source, execution_context: false };
  }

  /** P0-2: keep a large tool result out of context and index it for later queries. */
  captureOutput(args: JsonObject): JsonObject {
    const content = nonEmpty(args.content, "content");
    const limit = boundedInteger(args.max_chars ?? 8_000, "max_chars", 1, 100_000);
    if (content.length <= limit) return { action: "pass", bytes: content.length, execution_context: false };
    const toolName = args.tool_name === undefined ? "tool" : nonEmpty(args.tool_name, "tool_name");
    const sessionId = nonEmpty(args.session_id, "session_id");
    const host = nonEmpty(args.session_host, "session_host");
    const indexed = this.recordEphemeral({ session_id: sessionId, session_host: host, source: toolName,
      items: [{ id: "output", text: content, title: toolName }], ...(args.ttl_seconds === undefined ? {} : { ttl_seconds: args.ttl_seconds }) });
    return { action: "indexed", bytes: content.length, limit, index_id: indexed.index_id, source: toolName,
      preview: "", preview_reason: "requires_search",
      guidance: `Output exceeded ${limit} characters and was indexed. Query it with craft_context_ephemeral_search(source="${toolName}").`,
      execution_context: false };
  }

  /** P0-1: run model-authored analysis code in a bounded subprocess; only stdout enters context. */
  compute(args: JsonObject): JsonObject {
    if (args.allow_execution !== true) throw new Error("craft_context_compute requires allow_execution=true");
    const language = nonEmpty(args.language, "language");
    if (!COMPUTE_LANGUAGES.has(language)) throw new Error("language must be javascript, python or shell");
    const code = nonEmpty(args.code, "code");
    if (code.length > MAX_CODE_CHARS) throw new Error("code exceeds the compute source limit");
    const timeoutMs = boundedInteger(args.timeout_ms ?? 10_000, "timeout_ms", 1, MAX_COMPUTE_TIMEOUT_MS);
    const outputLimit = boundedInteger(args.output_limit ?? MAX_COMPUTE_OUTPUT, "output_limit", 1, MAX_COMPUTE_OUTPUT);
    const cwd = mkdtempSync(join(tmpdir(), "craft-compute-"));
    const started = Date.now();
    try {
      const spec = computeCommand(language, process.platform, cwd, process.execPath);
      writeFileSync(spec.file, code, { mode: 0o600 });
      const result = spawnSync(spec.command, spec.argv, { cwd, env: computeEnv(cwd), timeout: timeoutMs,
        maxBuffer: outputLimit + 4_096, encoding: "utf8", shell: false, windowsHide: true });
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
      return { language, exit_code: result.status, signal: result.signal ?? null,
        stdout: stdout.slice(0, outputLimit), stdout_truncated: stdout.length > outputLimit || errorCode === "ENOBUFS",
        stderr: stderr.slice(0, Math.min(outputLimit, 8_192)), timed_out: errorCode === "ETIMEDOUT",
        duration_ms: Date.now() - started, isolation: "bounded_subprocess", network_restricted: false,
        not_a_security_sandbox: true, execution_context: false };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  /** P1-2: capture a bounded resume snapshot before compaction. */
  checkpointResume(args: JsonObject): JsonObject {
    const sessionId = nonEmpty(args.session_id, "session_id");
    const host = nonEmpty(args.session_host, "session_host");
    const sessionScopeId = sessionStorageScopeId(host, sessionId);
    const scope = args.scope === undefined ? null : nonEmpty(args.scope, "scope");
    const snapshot = { session_id: sessionId, session_host: host, session_scope_id: sessionScopeId, scope, captured_at: isoNow(args.now),
      files_touched: stringList(args.files_touched, "files_touched", 100),
      tasks: stringList(args.tasks, "tasks", 100),
      errors: stringList(args.errors, "errors", 100),
      decisions: stringList(args.decisions, "decisions", 100),
      open_questions: stringList(args.open_questions, "open_questions", 100),
      content_free: false };
    const id = resumeId(sessionId, host);
    const record = this.store.transaction(() => {
      assertSessionActive(this.store, sessionScopeId);
      const existing = this.store.find(RESUME_KIND, id, undefined, false);
      if (existing && (existing.session_id !== sessionId || existing.session_host !== host || existing.session_scope_id !== sessionScopeId)) throw new Error("resume snapshot scope mismatch");
      return existing ? this.store.save(RESUME_KIND, id, snapshot) : this.store.create(RESUME_KIND, id, snapshot);
    });
    return { snapshot: record, resume_id: record.id, content_free: false, execution_context: false };
  }

  /** P1-2: read the latest resume snapshot for one session. */
  getResume(args: JsonObject): JsonObject {
    const sessionId = nonEmpty(args.session_id, "session_id");
    const host = nonEmpty(args.session_host, "session_host");
    assertSessionActive(this.store, sessionStorageScopeId(host, sessionId));
    const id = resumeId(sessionId, host);
    const record = this.store.find(RESUME_KIND, id, undefined, false);
    if (record && (record.session_id !== sessionId || record.session_host !== host || record.session_scope_id !== sessionStorageScopeId(host, sessionId))) throw new Error("resume snapshot scope mismatch");
    return { resume_id: id, snapshot: record ?? null, resume_available: record !== null, execution_context: false };
  }

  /** P1-2: project the resume snapshot into a bounded text block for injection. */
  resolveResume(args: JsonObject): JsonObject {
    const sessionId = nonEmpty(args.session_id, "session_id");
    const host = nonEmpty(args.session_host, "session_host");
    assertSessionActive(this.store, sessionStorageScopeId(host, sessionId));
    const maxChars = boundedInteger(args.max_chars ?? 1_200, "max_chars", 1, 8_000);
    const record = this.store.find(RESUME_KIND, resumeId(sessionId, host), undefined, false);
    if (!record) return { content: "", resume_available: false, truncated: false, execution_context: false };
    if (record.session_id !== sessionId || record.session_host !== host || record.session_scope_id !== sessionStorageScopeId(host, sessionId)) throw new Error("resume snapshot scope mismatch");
    const section = (label: string, key: string): string => {
      const values = Array.isArray(record[key]) ? (record[key] as unknown[]).map(String) : [];
      return values.length ? `${label}: ${values.join(" | ")}` : "";
    };
    const body = [section("Files", "files_touched"), section("Tasks", "tasks"), section("Errors", "errors"),
      section("Decisions", "decisions"), section("Open", "open_questions")].filter(Boolean).join("\n");
    const content = body.length > maxChars ? "" : body;
    return { content, resume_available: true, truncated: body.length > maxChars,
      ...(body.length > maxChars ? { reason: "requires_expansion", resume_id: resumeId(sessionId, host) } : {}),
      captured_at: record.captured_at ?? null, content_free: false, execution_context: false };
  }

  /** P1-3: report bounded Context savings from existing receipts. */
  stats(args: JsonObject): JsonObject {
    const receipts = this.store.list("context_resolution_receipt", SCAN_LIMIT, undefined, false);
    const workingSets = this.store.list("context_working_set_receipt", SCAN_LIMIT, undefined, false);
    const emissions = this.store.list("context_emission", SCAN_LIMIT, undefined, false);
    const feedback = this.store.list("context_feedback", SCAN_LIMIT, undefined, false);
    const ephemeral = this.store.list(EPHEMERAL_KIND, SCAN_LIMIT, undefined, false);
    let usedChars = 0, omitted = 0, deduplicated = 0, items = 0;
    for (const receipt of receipts) {
      usedChars += Number(receipt.total_used_chars ?? 0);
      omitted += Number(receipt.omitted_count ?? 0);
      deduplicated += Number(receipt.deduplicated_count ?? 0);
      items += Number(receipt.total_items ?? 0);
    }
    const outcomes: Record<string, number> = {};
    for (const item of feedback) {
      const key = String(item.outcome ?? "unknown");
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }
    return { receipts: receipts.length, working_sets: workingSets.length, emissions: emissions.length,
      feedback: feedback.length, ephemeral_indexes: ephemeral.length, selected_items: items, used_chars: usedChars,
      omitted_count: omitted, deduplicated_count: deduplicated, estimated_tokens: Math.ceil(usedChars / 3),
      token_provenance: "estimated", feedback_outcomes: outcomes, execution_context: false };
  }

  /** P1-3: read-only readiness check for the Context plane and its extensions. */
  health(args: JsonObject): JsonObject {
    const checks: JsonObject[] = [];
    let storeOk = true;
    try { this.store.database.prepare("SELECT 1 AS ok").get(); } catch { storeOk = false; }
    checks.push({ name: "store", ok: storeOk });
    if (!storeOk) return { ok: false, checks, execution_context: false };
    const adapters = this.store.list("retrieval_adapter", 1_000, undefined, false);
    const eligible = adapters.filter((adapter) => adapter.status === "eligible").length;
    checks.push({ name: "retrieval_adapters", ok: true, count: adapters.length, eligible });
    const receipts = this.store.list("context_resolution_receipt", 1, undefined, false);
    checks.push({ name: "context_receipts", ok: true, present: receipts.length > 0 });
    checks.push({ name: "ephemeral_indexes", ok: true, count: this.store.list(EPHEMERAL_KIND, 1, undefined, false).length });
    checks.push({ name: "resume_snapshots", ok: true, count: this.store.list(RESUME_KIND, 1, undefined, false).length });
    return { ok: checks.every((check) => check.ok === true), checks, execution_context: false };
  }

  /** List unresolved (or one explicit status of) Context correction tasks. */
  listCorrections(args: JsonObject): JsonObject {
    const status = args.status === undefined ? "pending_review" : nonEmpty(args.status, "status");
    if (!["pending_review", "confirmed", "dismissed", "resolved"].includes(status)) throw new Error("status is not a supported correction state");
    const member = args.member === undefined ? null : nonEmpty(args.member, "member");
    const limit = boundedInteger(args.limit ?? 50, "limit", 1, 200);
    const corrections = this.store.list("context_correction_task", limit, (item) => item.status === status
      && (member === null || (item.asset_ref as JsonObject | undefined)?.member === member), false);
    return { corrections, count: corrections.length, status, member, changes_source_status: false, execution_context: false };
  }

  /** Resolve one correction task; a confirmed correction keeps its ranking penalty, a dismissed one removes it. */
  decideCorrection(args: JsonObject): JsonObject {
    const taskId = nonEmpty(args.task_id, "task_id");
    const decision = nonEmpty(args.decision, "decision");
    if (decision !== "confirmed" && decision !== "dismissed") throw new Error("decision must be confirmed or dismissed");
    const task = this.store.get("context_correction_task", taskId);
    if (task.status === decision) return { correction: task, idempotent: true, changes_source_status: false, execution_context: false };
    if (task.status !== "pending_review") throw new Error("Correction task is already resolved differently");
    const reason = args.reason === undefined ? null : nonEmpty(args.reason, "reason");
    const saved = this.store.save("context_correction_task", taskId, { ...payload(task), status: decision,
      resolved_at: isoNow(args.now), ...(reason === null ? {} : { resolution_reason: reason }), changes_source_status: false });
    return { correction: saved, idempotent: false, changes_source_status: false, execution_context: false };
  }

  /** Record one outcome-linked use of a codebase symbol so later retrieval can rank it by observed value. */
  recordCodebaseUsage(args: JsonObject): JsonObject {
    return { ...recordCodebaseSymbolUsage(this.store, args), execution_context: false };
  }

  /** Read the net per-symbol usage weight for one codebase index. */
  getCodebaseUsage(args: JsonObject): JsonObject {
    const indexId = nonEmpty(args.index_id, "index_id");
    return { index_id: indexId, weights: [...codebaseUsageWeights(this.store, indexId).entries()].sort(),
      execution_context: false };
  }
}
