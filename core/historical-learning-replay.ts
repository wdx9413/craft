import { stableDigest } from "./digest.ts";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";

export const APPROVED_HISTORICAL_REPLAY_SESSIONS = [
  "01a20640-e1a2-78f3-8740-e5354135c5b8",
  "01a20646-b18b-7ad1-8a76-6285be98231a",
  "01a20752-2594-7902-b606-7d8427765f63",
] as const;

export interface HistoricalReplayEvidenceReference {
  readonly id: string;
  readonly version: number;
}

export interface HistoricalReplaySourceLineage {
  readonly origin: "historical_replay";
  readonly replay_run_id: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly task_id: string;
  readonly project_scope_id: string;
  readonly source_ref: { readonly kind: "codex_session_task"; readonly id: string; readonly digest: string };
  readonly evidence_refs: readonly { readonly kind: "evidence"; readonly id: string; readonly version: number }[];
}

export interface HistoricalReplayOwner {
  readonly owner: "memory" | "knowledge" | "experience" | "notes";
  capture(input: { readonly task: JsonObject; readonly excerpt: JsonObject; readonly source_lineage: HistoricalReplaySourceLineage[] }): JsonObject;
  cleanupPreview(replayRunId: string): JsonObject;
  cleanupApply(replayRunId: string, expectedManifestDigest: string): JsonObject;
}

export interface HistoricalReplayDependencies {
  readonly store: Pick<CraftStore, "find" | "create" | "save">;
  readonly listTasks: () => Promise<JsonObject>;
  readonly readExcerpt: (taskId: string) => Promise<JsonObject>;
  readonly resolveEvidence: (id: string) => HistoricalReplayEvidenceReference | null;
  readonly owners: readonly HistoricalReplayOwner[];
}

const SOURCE_DIGEST = /^sha256:[a-f0-9]{64}$/u;

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

/** Bind one replay lineage only after the archive has re-read the exact verified task span. */
export function createHistoricalSourceLineage(replayRunIdValue: unknown, taskValue: JsonObject,
  excerptValue: JsonObject, resolveEvidence: (id: string) => HistoricalReplayEvidenceReference | null): HistoricalReplaySourceLineage[] {
  const replayRunId = requiredText(replayRunIdValue, "replay_run_id");
  const taskId = requiredText(taskValue.task_id, "task_id");
  const taskSessionId = requiredText(taskValue.session_id, "session_id");
  if (!APPROVED_HISTORICAL_REPLAY_SESSIONS.includes(taskSessionId as typeof APPROVED_HISTORICAL_REPLAY_SESSIONS[number]))
    throw new Error("Historical replay session is not approved");
  if (taskValue.dataset_partition !== "candidate_generation" || excerptValue.dataset_partition !== "candidate_generation")
    throw new Error("Historical replay requires candidate_generation partition");
  if (excerptValue.status !== "ready") throw new Error("Historical replay task excerpt is not ready");
  const turnId = requiredText(taskValue.turn_id, "turn_id");
  const scopeId = requiredText(taskValue.project_scope_id, "project_scope_id");
  const sourceDigest = requiredText(taskValue.source_ref, "source_ref");
  const excerptDigest = requiredText(excerptValue.source_ref, "excerpt source_ref");
  if (!SOURCE_DIGEST.test(sourceDigest) || !SOURCE_DIGEST.test(excerptDigest)) throw new Error("Historical replay source_ref digest is invalid");
  if (excerptValue.task_id !== taskId || excerptValue.session_id !== taskSessionId || excerptValue.turn_id !== turnId
    || excerptValue.project_scope_id !== scopeId || excerptValue.source_ref !== sourceDigest) {
    throw new Error("Historical replay task identity mismatch");
  }
  if (!Array.isArray(excerptValue.evidence_ids) || excerptValue.evidence_ids.length === 0)
    throw new Error("Historical replay requires verified Evidence references");
  const evidenceIds = excerptValue.evidence_ids.map(value => requiredText(value, "evidence_id"));
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("Historical replay Evidence references must be unique");
  const evidenceRefs = evidenceIds.map(id => {
    const reference = resolveEvidence(id);
    if (!reference || reference.id !== id) throw new Error("Historical replay Evidence reference is unavailable");
    if (!Number.isSafeInteger(reference.version) || reference.version < 1)
      throw new Error("Historical replay Evidence reference version is invalid");
    return { kind: "evidence" as const, id, version: reference.version };
  });
  return [{ origin: "historical_replay", replay_run_id: replayRunId, session_id: taskSessionId, turn_id: turnId,
    task_id: taskId, project_scope_id: scopeId,
    source_ref: { kind: "codex_session_task", id: taskId, digest: sourceDigest }, evidence_refs: evidenceRefs }];
}

function contentFreeOwnerResult(owner: string, result: JsonObject): JsonObject {
  const candidateValue = result.candidate;
  const candidate = candidateValue && typeof candidateValue === "object" && !Array.isArray(candidateValue) ? candidateValue as JsonObject : null;
  const allowed = ["status", "reason", "auto_committed", "routeable", "idempotent", "next_action", "blocked_reason", "candidate_count"];
  const summary: JsonObject = { owner };
  for (const key of allowed) {
    const value = result[key] ?? candidate?.[key];
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") summary[key] = value;
  }
  if (candidate) {
    if (typeof candidate.id === "string") summary.candidate_id = candidate.id;
    if (Number.isSafeInteger(candidate.version)) summary.candidate_version = candidate.version;
  }
  if (Array.isArray(result.candidate_ids)) summary.candidate_ids = result.candidate_ids.filter((id): id is string => typeof id === "string");
  return summary;
}

function taskIdentity(task: JsonObject): JsonObject {
  return { task_id: task.task_id, session_id: task.session_id, turn_id: task.turn_id,
    project_scope_id: task.project_scope_id, source_ref: task.source_ref, dataset_partition: task.dataset_partition };
}

function replayRunId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value)) throw new Error("replay_run_id must be a bounded identifier");
  return value;
}

/** Replay only indexed task spans from the fixed allowlist; transcript prose never enters the durable receipt. */
export async function captureHistoricalReplayBatch(replayRunIdValue: unknown, deps: HistoricalReplayDependencies): Promise<JsonObject> {
  const runId = replayRunId(replayRunIdValue);
  if (new Set(deps.owners.map(owner => owner.owner)).size !== deps.owners.length) throw new Error("historical replay owners must be unique");
  const batch = await deps.listTasks();
  const indexed = Array.isArray(batch.tasks) ? batch.tasks.filter((value): value is JsonObject => Boolean(value && typeof value === "object" && !Array.isArray(value))) : [];
  const selected = indexed.filter(task => task.dataset_partition === "candidate_generation"
    && APPROVED_HISTORICAL_REPLAY_SESSIONS.includes(String(task.session_id) as typeof APPROVED_HISTORICAL_REPLAY_SESSIONS[number]))
    .sort((left, right) => String(left.task_id).localeCompare(String(right.task_id)));
  const sourceBatchDigest = stableDigest(selected.map(taskIdentity));
  const runKey = `historical_replay_${runId}`;
  const existing = deps.store.find("historical_learning_replay_run", runKey);
  if (existing && (existing.source_batch_digest !== sourceBatchDigest || existing.replay_run_id !== runId))
    throw new Error("Historical replay run identity conflicts with its stored source batch");
  if (existing?.status === "completed") return { replay_run_id: runId, status: "completed", idempotent: true,
    source_batch_digest: sourceBatchDigest, task_receipts: existing.task_receipts ?? [] };
  let run = existing ?? deps.store.create("historical_learning_replay_run", runKey, { replay_run_id: runId,
    source_batch_digest: sourceBatchDigest, source_session_ids: APPROVED_HISTORICAL_REPLAY_SESSIONS,
    status: "running", task_receipts: [], content_free: true });
  const completedTasks = new Set((Array.isArray(run.task_receipts) ? run.task_receipts as JsonObject[] : []).map(item => String(item.task_id)));
  const receipts = Array.isArray(run.task_receipts) ? [...run.task_receipts as JsonObject[]] : [];
  for (const task of selected) {
    const taskId = requiredText(task.task_id, "task_id");
    if (completedTasks.has(taskId)) continue;
    const excerpt = await deps.readExcerpt(taskId);
    let ownerResults: JsonObject[] = [];
    let taskStatus = "ready";
    let skipReason: string | undefined;
    let sourceLineage: HistoricalReplaySourceLineage[] = [];
    try { sourceLineage = createHistoricalSourceLineage(runId, task, excerpt, deps.resolveEvidence); }
    catch (error) {
      taskStatus = "skipped";
      skipReason = error instanceof Error && /not approved|partition/u.test(error.message) ? "source_not_authorized"
        : error instanceof Error && /ready/u.test(error.message) ? "task_excerpt_unavailable" : "source_lineage_unavailable";
    }
    if (taskStatus === "ready") {
      ownerResults = deps.owners.map(owner => {
        try { return contentFreeOwnerResult(owner.owner, owner.capture({ task, excerpt, source_lineage: sourceLineage })); }
        catch (error) { return { owner: owner.owner, status: "failed", error_type: error instanceof Error ? error.name : "unknown" }; }
      });
    }
    receipts.push({ task_id: taskId, session_id: task.session_id, turn_id: task.turn_id, project_scope_id: task.project_scope_id,
      source_digest: typeof task.source_ref === "string" ? task.source_ref : null,
      source_lineage_digest: sourceLineage.length ? stableDigest(sourceLineage) : null,
      status: taskStatus, ...(skipReason ? { reason: skipReason } : {}), owner_results: ownerResults });
    run = deps.store.save("historical_learning_replay_run", runKey, { ...run, status: "running", task_receipts: receipts,
      updated_at: new Date().toISOString(), content_free: true });
    completedTasks.add(taskId);
  }
  run = deps.store.save("historical_learning_replay_run", runKey, { ...run, status: "completed", task_receipts: receipts,
    completed_at: new Date().toISOString(), content_free: true });
  return { replay_run_id: runId, status: "completed", idempotent: false, source_batch_digest: sourceBatchDigest, task_receipts: receipts };
}

function cleanupOwnerManifest(owner: HistoricalReplayOwner, replayRunId: string): JsonObject {
  const manifest = owner.cleanupPreview(replayRunId);
  if (manifest.owner !== owner.owner || manifest.replay_run_id !== replayRunId || typeof manifest.manifest_digest !== "string" || !Array.isArray(manifest.items))
    throw new Error(`${owner.owner} returned an invalid historical cleanup manifest`);
  for (const item of manifest.items as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${owner.owner} cleanup item is invalid`);
    const value = item as JsonObject;
    if (Object.keys(value).some(key => !["kind", "id", "version", "lineage_digest", "action"].includes(key))
      || typeof value.kind !== "string" || typeof value.id !== "string" || !Number.isSafeInteger(value.version)
      || typeof value.lineage_digest !== "string" || value.action !== "revoke" && value.action !== "remove_replay_lineage")
      throw new Error(`${owner.owner} cleanup item is malformed or contains content`);
  }
  return { owner: owner.owner, manifest_digest: manifest.manifest_digest, items: manifest.items };
}

export function previewHistoricalReplayCleanup(replayRunIdValue: unknown, owners: readonly HistoricalReplayOwner[]): JsonObject {
  const runId = replayRunId(replayRunIdValue);
  if (new Set(owners.map(owner => owner.owner)).size !== owners.length) throw new Error("historical replay owners must be unique");
  const ownerManifests = [...owners].sort((left, right) => left.owner.localeCompare(right.owner)).map(owner => cleanupOwnerManifest(owner, runId));
  const manifestDigest = stableDigest({ replay_run_id: runId, owners: ownerManifests });
  return { replay_run_id: runId, manifest_digest: manifestDigest, owners: ownerManifests,
    item_count: ownerManifests.reduce((count, owner) => count + (owner.items as unknown[]).length, 0), content_free: true };
}

export function applyHistoricalReplayCleanup(replayRunIdValue: unknown, expectedDigestValue: unknown,
  deps: Pick<HistoricalReplayDependencies, "store" | "owners">): JsonObject {
  const runId = replayRunId(replayRunIdValue);
  const expectedDigest = requiredText(expectedDigestValue, "expected_manifest_digest");
  const receiptId = `historical_cleanup_${runId}`;
  let receipt = deps.store.find("historical_learning_cleanup_run", receiptId);
  if (receipt && receipt.manifest_digest !== expectedDigest) throw new Error("Historical cleanup run already has a different manifest digest");
  if (receipt?.status === "completed") return { replay_run_id: runId, manifest_digest: expectedDigest, status: "cleaned", idempotent: true,
    owners: receipt.owners ?? [], content_free: true };
  if (!receipt) {
    const preview = previewHistoricalReplayCleanup(runId, deps.owners);
    if (preview.manifest_digest !== expectedDigest) throw new Error("Historical cleanup manifest changed; preview again");
    receipt = deps.store.create("historical_learning_cleanup_run", receiptId, { replay_run_id: runId, manifest_digest: expectedDigest,
      owners: preview.owners, completed_owners: [], status: "applying", content_free: true });
  }
  const completed = new Set(Array.isArray(receipt.completed_owners) ? receipt.completed_owners.map(String) : []);
  const ownerReceipts = Array.isArray(receipt.owners) ? receipt.owners as JsonObject[] : [];
  for (const manifest of ownerReceipts) {
    const ownerName = String(manifest.owner) as HistoricalReplayOwner["owner"];
    if (completed.has(ownerName)) continue;
    const owner = deps.owners.find(item => item.owner === ownerName);
    if (!owner) throw new Error(`Historical cleanup owner ${ownerName} is unavailable; retry after restoring it`);
    const result = owner.cleanupApply(runId, String(manifest.manifest_digest));
    if (result.status !== "cleaned") throw new Error(`${ownerName} did not confirm historical cleanup`);
    const readback = cleanupOwnerManifest(owner, runId);
    if ((readback.items as unknown[]).length > 0) throw new Error(`${ownerName} cleanup readback still contains replay lineage`);
    completed.add(ownerName);
    receipt = deps.store.save("historical_learning_cleanup_run", receiptId, { ...receipt, completed_owners: [...completed],
      updated_at: new Date().toISOString(), status: "applying", content_free: true });
  }
  receipt = deps.store.save("historical_learning_cleanup_run", receiptId, { ...receipt, completed_owners: [...completed],
    status: "completed", completed_at: new Date().toISOString(), content_free: true });
  return { replay_run_id: runId, manifest_digest: expectedDigest, status: "cleaned", idempotent: false,
    owners: receipt.owners ?? [], content_free: true };
}
