import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { digestJson } from "craft-common-base/digest";
import { sessionStorageScopeId } from "craft-common-store-local/paths";
import type { JsonObject } from "craft-common-store-local/store";
import type { MemoryCapture } from "@craft/capability-memory/memory-capture";

/** Seed the session records produced by an older runtime for migration and archive tests. */
export function seedLegacySession(capture: MemoryCapture, args: JsonObject): JsonObject {
  const store = capture.memory.store;
  const sessionId = String(args.session_id), projectId = typeof args.project_scope_id === "string" ? args.project_scope_id : "";
  const scopeId = typeof args.session_host === "string" ? sessionStorageScopeId(args.session_host, sessionId) : sessionId;
  if (typeof args.session_host === "string") store.bindSessionStorageHost(sessionId, args.session_host);
  if (capture.memory.ledger.files.isSessionArchived(scopeId)) return { status: "archived", next_action: "session_archive_is_terminal", promotions: [] };
  const content = String(args.content), kind = String(args.kind ?? "preference"), topic = typeof args.topic === "string" ? args.topic : null;
  const identity = { kind, scope_kind: "session", scope_id: scopeId, project_scope_id: projectId || null, topic, content_digest: digestJson(content) };
  const captureDigest = digestJson(identity), suffix = captureDigest.slice(-20);
  const evidenceId = String(args.evidence_id ?? `evidence_memory_statement_${suffix}`);
  const candidateId = String(args.candidate_id ?? `memory_candidate_statement_${suffix}`);
  const intentId = `memory_observation_intent_${suffix}`;
  capture.bootstrap();
  let evidence = store.find("evidence", evidenceId);
  if (evidence && (evidence.confidence !== "bounded" || (evidence.metadata as JsonObject | undefined)?.capture_digest !== captureDigest)) throw new Error("Memory capture evidence idempotency conflict");
  if (!evidence) evidence = capture.evidenceRecord({ evidence_id: evidenceId, source_type: "host_observed_fact", confidence: "bounded",
    claim: "Host-classified stable fact captured for governed Memory.", locator: `memory-capture:session:${scopeId}`,
    metadata: { capture_digest: captureDigest, user_authored: false, capture_mode: "host-observed-stable-fact" } });
  const previous = store.find("memory_observation_intent", intentId);
  if (previous && previous.candidate_id !== candidateId) throw new Error("Memory observation intent idempotency conflict");
  if (previous && previous.evidence_version === undefined) {
    const history = store.history("memory_observation_intent", intentId, Number(previous.version) + 1, 100);
    if (history.some(item => item.evidence_version !== undefined)) throw new Error("Memory observation intent evidence version was removed");
  }
  let candidate = store.find("memory_candidate", candidateId);
  const alreadyRetained = candidate !== null;
  let memory: JsonObject;
  const scope = { kind: "session", id: scopeId };
  const lineage = projectId ? [{ origin: "live_hook", session_id: sessionId, ...(args.turn_id === undefined ? {} : { turn_id: args.turn_id }),
    ...(args.task_id === undefined ? {} : { task_id: args.task_id }), project_scope_id: projectId.startsWith("project:") ? projectId : `project:${projectId}`,
    source_ref: { kind: args.task_id === undefined ? "codex_session" : "codex_session_task", id: args.task_id ?? sessionId },
    evidence_refs: [{ kind: "evidence", id: evidence.id, version: evidence.version }] }] : [];
  if (!candidate) {
    const memoryId = `memory_ledger_candidate_${digestJson(candidateId).slice(-32)}`;
    memory = store.create("memory_ledger", memoryId, { scope, source_id: "builtin.evidence-wiki", kind, topic: topic ?? "", content,
      content_digest: identity.content_digest, sensitivity: args.sensitivity ?? "internal", confidence: "bounded", evidence_ids: [evidence.id],
      valid_until: args.valid_until ?? null, status: "active", source_lineage: lineage });
    candidate = store.create("memory_candidate", candidateId, { scope, source_id: "builtin.evidence-wiki", kind, topic: topic ?? "", content,
      content_digest: identity.content_digest, sensitivity: args.sensitivity ?? "internal", confidence: "bounded", evidence_ids: [evidence.id],
      valid_until: args.valid_until ?? null, status: "approved", ledger_memory_id: memoryId, source_lineage: lineage });
  } else memory = store.get("memory_ledger", String(candidate.ledger_memory_id));
  if (projectId && !previous) store.create("memory_observation_intent", intentId, { scope, project_id: projectId, capture_digest: captureDigest,
    candidate_id: candidateId, content_digest: identity.content_digest, kind, topic: topic ?? "", capture_topic: topic,
    evidence_id: evidence.id, evidence_version: evidence.version, content_free: true, promotion_status: "pending" });
  const jobId = `memory_observation_promotion_${digestJson(intentId).slice(-32)}`;
  if (projectId && !store.find("memory_observation_promotion", jobId)) store.create("memory_observation_promotion", jobId, {
    intent_id: intentId, candidate_id: candidateId, project_id: projectId, session_scope_id: scopeId,
    capture_digest: captureDigest, status: "pending", content_free: true });
  store.sessionStorageRoot(scopeId, true);
  const projection = capture.memory.ledger.files.pathFor(scope)!;
  mkdirSync(dirname(projection), { recursive: true });
  writeFileSync(projection, `# Memory\n\n<!-- scope: session:${scopeId}; generated by Craft -->\n\n${content}\n`);
  return { candidate, memory, evidence, auto_committed: true, ...(alreadyRetained ? { already_retained: true } : {}), promotions: [],
    next_action: projectId ? "memory_promotion_queued" : "available_for_scoped_context" };
}
