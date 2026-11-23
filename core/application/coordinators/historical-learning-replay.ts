import { extractDurableStatements } from "../../domains/durable-statements.ts";
import { codexSessionTaskBatch, readCodexSessionTaskExcerpt } from "../../codex-session-archive.ts";
import { stableDigest } from "../../digest.ts";
import type { CraftService } from "../craft-service.ts";
import type { HistoricalReplayOwner } from "../../historical-learning-replay.ts";
import type { JsonObject } from "../../infrastructure/store.ts";

function ownerService(service: CraftService, name: string): CraftService {
  const owner = service.ownerServices.get(name);
  if (!owner) throw new Error(`Historical replay owner ${name} is unavailable`);
  return owner;
}

function candidateIds(results: readonly JsonObject[]): string[] {
  return results.flatMap(result => {
    const candidate = result.candidate && typeof result.candidate === "object" && !Array.isArray(result.candidate)
      ? result.candidate as JsonObject : null;
    const id = candidate?.id ?? result.id;
    return typeof id === "string" ? [id] : [];
  });
}

function candidateSummary(results: readonly JsonObject[]): JsonObject {
  const ids = candidateIds(results);
  return { status: ids.length ? "candidate" : "skipped", candidate_count: ids.length, candidate_ids: ids,
    auto_committed: results.some(result => result.auto_committed === true),
    ...(ids.length ? {} : { reason: "no_durable_statement" }) };
}

function sourceEvidence(service: CraftService, evidenceId: string, evidenceVersion: number): { owner: string; record: JsonObject; semanticDigest: string } {
  const records = [[service.storageOwner ?? "context", service.store] as const,
    ...[...service.ownerServices.entries()].map(([owner, target]) => [owner, target.store] as const)]
    .flatMap(([owner, store]) => {
      const record = store.find("evidence", evidenceId, undefined, false);
      if (!record || record.source_type === "historical_replay_projection") return [];
      return [{ owner, record, semanticDigest: stableDigest({ id: record.id, version: record.version,
        source_type: record.source_type, claim: record.claim, confidence: record.confidence, record_origin: record.record_origin ?? null,
        artifact_id: record.artifact_id ?? null, locator: record.locator ?? null, metadata: record.metadata ?? {} }) }];
    });
  const exact = records.filter(item => Number(item.record.version) === evidenceVersion);
  if (!exact.length || records.some(item => Number(item.record.version) !== evidenceVersion)
    || new Set(exact.map(item => item.semanticDigest)).size !== 1
    || exact.some(item => item.record.record_origin === "caller_asserted")) {
    throw new Error("historical replay source Evidence is missing, changed, conflicting, or caller asserted");
  }
  return { owner: exact[0]!.owner, record: exact[0]!.record, semanticDigest: exact[0]!.semanticDigest };
}

function projectReplayEvidence(service: CraftService, target: CraftService,
  sourceLineage: HistoricalReplayOwnerCaptureInput["source_lineage"]): HistoricalReplayOwnerCaptureInput["source_lineage"] {
  if (!service.capabilityOwned) return sourceLineage;
  return sourceLineage.map(lineage => ({ ...lineage, evidence_refs: lineage.evidence_refs.map(reference => {
    const source = sourceEvidence(service, reference.id, reference.version);
    const projectionId = `evidence_historical_replay_projection_${stableDigest({ replay_run_id: lineage.replay_run_id, source_evidence_id: reference.id }).slice(-32)}`;
    const metadata = { replay_run_id: lineage.replay_run_id, source_owner: source.owner, source_evidence_id: reference.id,
      source_evidence_version: reference.version, semantic_digest: source.semanticDigest, projection_status: "active" };
    const projection = target.store.transaction(() => {
      const existing = target.store.find("evidence", projectionId);
      if (existing) {
        if (existing.source_type !== "historical_replay_projection" || stableDigest(existing.metadata) !== stableDigest(metadata)
          || existing.confidence !== "unverified" || existing.claim !== "Historical replay Evidence reference projection.") {
          throw new Error("historical replay Evidence projection identity conflicts");
        }
        return existing;
      }
      return target.evidenceRecord({ evidence_id: projectionId, source_type: "historical_replay_projection", confidence: "unverified",
        claim: "Historical replay Evidence reference projection.", locator: `evidence-ref:${reference.id}@${reference.version}`, metadata });
    });
    return { kind: "evidence", id: String(projection.id), version: Number(projection.version) };
  }) }));
}

type HistoricalReplayOwnerCaptureInput = Parameters<HistoricalReplayOwner["capture"]>[0];

function replayOwner(owner: HistoricalReplayOwner["owner"], service: CraftService): HistoricalReplayOwner {
  switch (owner) {
    case "memory": return {
      owner,
      capture: ({ task, excerpt, source_lineage }) => {
        const target = ownerService(service, owner);
        const ownerLineage = projectReplayEvidence(service, target, source_lineage);
        const statements = extractDurableStatements(String(excerpt.task_goal ?? ""));
        const results = statements.map(statement => target.memoryCaptureHistoricalReplayCandidate({
          dataset_partition: "candidate_generation", project_scope_id: String(task.project_scope_id),
          content: statement.statement, kind: statement.kind === "rule" ? "procedural" : statement.kind === "fact" ? "working" : "preference",
          source_lineage: ownerLineage,
        }));
        return candidateSummary(results);
      },
      cleanupPreview: replayRunId => ownerService(service, owner).memoryHistoricalReplayCleanupPreview({ replay_run_id: replayRunId }),
      cleanupApply: (replayRunId, expectedManifestDigest) => ownerService(service, owner).memoryHistoricalReplayCleanupApply({ replay_run_id: replayRunId, expected_manifest_digest: expectedManifestDigest }),
    };
    case "knowledge": return {
      owner,
      capture: ({ task, excerpt, source_lineage }) => {
        const target = ownerService(service, owner);
        const ownerLineage = projectReplayEvidence(service, target, source_lineage);
        const statements = extractDurableStatements(String(excerpt.task_goal ?? "")).filter(statement => statement.kind === "rule");
        const evidenceIds = [...new Set(ownerLineage.flatMap(item => item.evidence_refs.map(reference => reference.id)))];
        const results = statements.map(statement => target.knowledgeCaptureHistoricalReplayCandidate({
          dataset_partition: "candidate_generation", scope: String(task.project_scope_id), kind: "rule",
          content: statement.statement, evidence_ids: evidenceIds, source_lineage: ownerLineage,
        }));
        return candidateSummary(results);
      },
      cleanupPreview: replayRunId => ownerService(service, owner).knowledgeHistoricalReplayCleanupPreview({ replay_run_id: replayRunId }),
      cleanupApply: (replayRunId, expectedManifestDigest) => ownerService(service, owner).knowledgeHistoricalReplayCleanupApply({ replay_run_id: replayRunId, expected_manifest_digest: expectedManifestDigest }),
    };
    case "experience": return {
      owner,
      capture: ({ task, source_lineage }) => {
        const target = ownerService(service, owner);
        const ownerLineage = projectReplayEvidence(service, target, source_lineage);
        return target.experienceCaptureHistoricalReplayCandidate({
        dataset_partition: "candidate_generation", project_scope_id: String(task.project_scope_id), source_lineage: ownerLineage,
        blocked_reason: "insufficient_independent_live_evidence",
      }); },
      cleanupPreview: replayRunId => ownerService(service, owner).experienceHistoricalReplayCleanupPreview({ replay_run_id: replayRunId }),
      cleanupApply: (replayRunId, expectedManifestDigest) => ownerService(service, owner).experienceHistoricalReplayCleanupApply({ replay_run_id: replayRunId, expected_manifest_digest: expectedManifestDigest }),
    };
    case "notes": return {
      owner,
      capture: ({ task, source_lineage }) => {
        const target = ownerService(service, owner);
        const ownerLineage = projectReplayEvidence(service, target, source_lineage);
        return target.notesCaptureHistoricalReplayCandidate({ dataset_partition: "candidate_generation",
          project_scope_id: String(task.project_scope_id), source_lineage: ownerLineage });
      },
      cleanupPreview: replayRunId => ownerService(service, owner).notesHistoricalReplayCleanupPreview({ replay_run_id: replayRunId }),
      cleanupApply: (replayRunId, expectedManifestDigest) => ownerService(service, owner).notesHistoricalReplayCleanupApply({ replay_run_id: replayRunId, expected_manifest_digest: expectedManifestDigest }),
    };
  }
}

export function historicalReplayOwners(service: CraftService): HistoricalReplayOwner[] {
  return ["memory", "knowledge", "experience", "notes"].map(name => replayOwner(name as HistoricalReplayOwner["owner"], service));
}

export function replayEvidenceResolver(service: CraftService): (id: string) => { id: string; version: number } | null {
  return id => {
    const matches = [service.store, ...[...service.ownerServices.values()].map(owner => owner.store)]
      .map(store => store.find("evidence", id, undefined, false)).filter((record): record is JsonObject => record !== null);
    if (!matches.length || new Set(matches.map(record => Number(record.version))).size !== 1) return null;
    return { id, version: Number(matches[0]!.version) };
  };
}

export function createHistoricalReplayArchive(list: (partition: "candidate_generation") => Promise<JsonObject> = codexSessionTaskBatch,
  read: (taskId: string, options: { expected_partition: "candidate_generation" }) => Promise<JsonObject> = readCodexSessionTaskExcerpt) {
  return {
    listTasks: (): Promise<JsonObject> => list("candidate_generation"),
    readExcerpt: (taskId: string): Promise<JsonObject> => read(taskId, { expected_partition: "candidate_generation" }),
  };
}

export const historicalReplayArchive = createHistoricalReplayArchive();
