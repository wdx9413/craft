import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { digestJson } from "../../common/craft-common-base/src/digest.ts";
import { text } from "../../common/craft-common-base/src/validation.ts";
import type { MemoryGovernanceKernel } from "./memory-governance.ts";

/** The host supplies Evidence/source ports; this package never imports a harness. */
export class MemoryCapture {
  readonly memory: MemoryGovernanceKernel;
  readonly bootstrap: () => unknown;
  readonly evidenceRecord: (args: JsonObject) => JsonObject;
  constructor(memory: MemoryGovernanceKernel, bootstrap: () => unknown, evidenceRecord: (args: JsonObject) => JsonObject) { this.memory = memory; this.bootstrap = bootstrap; this.evidenceRecord = evidenceRecord; }
  captureUserStatement(args: JsonObject): JsonObject { return this.capture(args, "explicit-user-statement"); }

  /** Host-classified facts enter the session tier and promote through the governed repeat thresholds. */
  captureObservedFact(args: JsonObject): JsonObject {
    const sessionId = text(args.session_id, "session_id");
    const projectScopeId = text(args.project_scope_id, "project_scope_id");
    if (args.scope_kind !== undefined && args.scope_kind !== "session") throw new Error("observed Memory facts must start in session scope");
    if (args.scope_id !== undefined && text(args.scope_id, "scope_id") !== sessionId) throw new Error("scope_id must match session_id");
    return this.capture({ ...args, scope_kind: "session", scope_id: sessionId, project_scope_id: projectScopeId }, "host-observed-stable-fact");
  }

  private capture(args: JsonObject, proposedBy: string): JsonObject {
    if (typeof args.content !== "string" || !args.content.trim()) throw new Error("content must not be empty");
    const content = args.content;
    if (/(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*[^\s]+/iu.test(content)) throw new Error("content must not contain sensitive assignments");
    const kind = String(args.kind ?? "preference");
    if (!new Set(["working", "episodic", "preference", "procedural"]).has(kind)) throw new Error("Memory capture kind is unsupported");
    const scopeKind = text(args.scope_kind ?? (args.session_id ? "session" : "user"), "scope_kind");
    const scopeId = text(args.scope_id ?? (scopeKind === "session" ? args.session_id : scopeKind === "global" ? "global" : "local"), "scope_id");
    if (scopeKind === "session" && this.memory.ledger.files.isSessionArchived(scopeId)) {
      return { candidate: null, conflicts: [], auto_committed: false, status: "archived", next_action: "session_archive_is_terminal" };
    }
    const topic = args.topic === undefined ? undefined : text(args.topic, "topic");
    const policy = this.memory.policyGet().policy as JsonObject;
    // Disabled capture is a read-only decision, not a partial source/Evidence write.
    if (policy.mode === "off") return { candidate: null, conflicts: [], auto_committed: false, status: "disabled", policy, next_action: "memory_disabled" };
    const hints = topic === undefined && kind === "preference" ? (this.memory.topicSuggestions({ ...args, content, scope_kind: scopeKind, scope_id: scopeId }).suggestions as JsonObject[]).filter(hint => hint.content_digest !== digestJson(content)) : [];
    this.bootstrap();
    const captureIdentity = { kind, scope_kind: scopeKind, scope_id: scopeId, project_scope_id: args.project_scope_id ?? null, topic: topic ?? null, content_digest: digestJson(content) };
    const suffix = digestJson(captureIdentity).slice(-20);
    const explicit = proposedBy === "explicit-user-statement";
    const evidence = this.evidenceRecord({ evidence_id: String(args.evidence_id ?? `evidence_memory_statement_${suffix}`), source_type: explicit ? "human" : "host_observed_fact", confidence: "bounded",
      claim: explicit ? "User-authored statement captured for governed Memory." : "Host-classified stable fact captured for governed Memory.",
      locator: `memory-capture:${scopeKind}:${scopeId}`, metadata: { capture_digest: digestJson(captureIdentity), user_authored: explicit, capture_mode: proposedBy } });
    const proposed = this.memory.propose({ candidate_id: String(args.candidate_id ?? `memory_candidate_statement_${suffix}`), source_id: "builtin.evidence-wiki", kind,
      scope_kind: scopeKind, scope_id: scopeId, ...(args.scope_envelope === undefined ? {} : { scope_envelope: args.scope_envelope }), ...(topic === undefined ? {} : { topic }), content, sensitivity: args.sensitivity ?? "internal", confidence: "bounded",
      proposal_only: hints.length > 0, evidence_ids: [evidence.id], proposed_by: proposedBy, valid_until: args.valid_until,
      ...(args.memory_id === undefined ? {} : { memory_id: args.memory_id }) });
    const retainedCandidate = proposed.candidate as JsonObject;
    if (proposed.idempotent === true && retainedCandidate.ledger_memory_id) {
      const retained = this.memory.ledger.get({ ...args, scope_kind: scopeKind, scope_id: scopeId, memory_id: retainedCandidate.ledger_memory_id }).memory as JsonObject;
      if (retained.status === "active") return { ...proposed, memory: retained, evidence, already_retained: true, auto_committed: false, next_action: "available_for_scoped_context" };
    }
    if (hints.length > 0) return { ...proposed, evidence, topic_suggestions: hints, auto_committed: false, next_action: "confirm_topic_or_explicit_replacement" };
    // Governed policy can already approve and commit; neither deny that fact nor commit twice.
    if (proposed.auto_committed === true) {
      const promotions = scopeKind === "session" && args.project_scope_id
        ? this.promoteRepeatedFact({ sessionId: scopeId, projectId: text(args.project_scope_id, "project_scope_id"), projectRoot: typeof args.project_root === "string" ? args.project_root : undefined, candidate: proposed.candidate as JsonObject })
        : [];
      const memoryFile = this.memory.ledger.files.sync({ kind: scopeKind, id: scopeId }, typeof args.project_root === "string" ? args.project_root : undefined);
      return { ...proposed, evidence, memory_file: memoryFile, promotions, next_action: "available_for_scoped_context" };
    }
    const candidate = proposed.candidate as JsonObject;
    return { ...proposed, evidence, auto_committed: false,
      next_action: candidate.status === "conflict_pending" ? "resolve_conflict" : "review_or_accept" };
  }

  private promoteRepeatedFact(input: { sessionId: string; projectId: string; projectRoot?: string; candidate: JsonObject }): JsonObject[] {
    const candidate = input.candidate;
    const contentDigest = String(candidate.content_digest ?? "");
    if (!contentDigest || candidate.scope && (candidate.scope as JsonObject).kind !== "session") return [];
    const projectId = input.projectId;
    const observationIdentity = { content_digest: contentDigest, project_id: projectId, session_digest: digestJson(input.sessionId), kind: candidate.kind, topic: candidate.topic ?? "" };
    const observationId = `memory_observation_${digestJson(observationIdentity).slice(-32)}`;
    if (!this.memory.store.find("memory_observation", observationId)) this.memory.store.create("memory_observation", observationId, {
      ...observationIdentity, evidence_ids: candidate.evidence_ids ?? [], observed_at: candidate.observed_at,
      ...(typeof candidate.valid_until === "string" ? { valid_until: candidate.valid_until } : {}), content_free: true, status: "active",
    });
    const observations = this.memory.store.list("memory_observation", 10_000, row => row.status === "active"
      && (!row.valid_until || Date.parse(String(row.valid_until)) >= Date.now())
      && row.content_digest === contentDigest && row.project_id === projectId && row.kind === candidate.kind && row.topic === (candidate.topic ?? ""));
    const sessions = new Set(observations.map(row => String(row.session_digest)));
    if (sessions.size < 2) return [];

    const results: JsonObject[] = [];
    const evidenceIds = [...new Set(observations.flatMap(row => Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : []))];
    // A promotion cannot outlive the shortest-lived supporting observation.
    const validUntil = observations.map(row => typeof row.valid_until === "string" ? row.valid_until : null)
      .filter((value): value is string => value !== null).sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
    const now = Date.now();
    const projectExisting = this.memory.store.list("memory_ledger", 10_000, row => row.status === "active" && (!row.valid_until || Date.parse(String(row.valid_until)) >= now) && row.content_digest === contentDigest
      && (row.scope as JsonObject | undefined)?.kind === "project" && (row.scope as JsonObject | undefined)?.id === projectId);
    if (!projectExisting.length) {
      const projectCandidateId = `memory_candidate_project_${digestJson({ contentDigest, projectId, kind: candidate.kind, topic: candidate.topic ?? "" }).slice(-32)}`;
      const promoted = this.memory.propose({ candidate_id: projectCandidateId, source_id: candidate.source_id, kind: candidate.kind,
        scope_kind: "project", scope_id: projectId, content: candidate.content, topic: candidate.topic || undefined,
        sensitivity: candidate.sensitivity, confidence: "bounded", evidence_ids: evidenceIds, proposed_by: "automatic-memory-promotion", valid_until: validUntil });
      const governedPromotion = this.resolveRepeatedConflict(promoted, evidenceIds);
      results.push({ tier: "project", repetition_count: sessions.size, ...governedPromotion,
        ...(governedPromotion.auto_committed === true ? { memory_file: this.memory.ledger.files.sync({ kind: "project", id: projectId }, input.projectRoot) } : {}) });
    }

    const projectMemories = this.memory.store.list("memory_ledger", 10_000, row => row.status === "active" && row.content_digest === contentDigest
      && (!row.valid_until || Date.parse(String(row.valid_until)) >= now)
      && (row.scope as JsonObject | undefined)?.kind === "project" && row.kind === candidate.kind && (row.topic ?? "") === (candidate.topic ?? ""));
    const projects = new Set(projectMemories.map(row => String((row.scope as JsonObject).id)));
    if (projects.size >= 3) {
      const globalExisting = this.memory.store.list("memory_ledger", 10_000, row => row.status === "active" && row.content_digest === contentDigest
        && (row.scope as JsonObject | undefined)?.kind === "global");
      if (!globalExisting.length) {
        const globalEvidenceIds = [...new Set(projectMemories.flatMap(row => Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : []))];
        const globalCandidateId = `memory_candidate_global_${digestJson({ contentDigest, kind: candidate.kind, topic: candidate.topic ?? "" }).slice(-32)}`;
        const globalValidUntil = projectMemories.map(row => typeof row.valid_until === "string" ? row.valid_until : null)
          .filter((value): value is string => value !== null).sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
        const promoted = this.memory.propose({ candidate_id: globalCandidateId, source_id: candidate.source_id, kind: candidate.kind,
          scope_kind: "global", scope_id: "global", content: candidate.content, topic: candidate.topic || undefined,
          sensitivity: candidate.sensitivity, confidence: "bounded", evidence_ids: globalEvidenceIds, proposed_by: "automatic-memory-promotion", valid_until: globalValidUntil });
        const governedPromotion = this.resolveRepeatedConflict(promoted, globalEvidenceIds);
        results.push({ tier: "global", repetition_count: projects.size, ...governedPromotion,
          ...(governedPromotion.auto_committed === true ? { memory_file: this.memory.ledger.files.sync({ kind: "global", id: "global" }) } : {}) });
      }
    }
    return results;
  }

  /** Repeated independent observations may resolve only a policy-qualified same-topic conflict. */
  private resolveRepeatedConflict(promoted: JsonObject, evidenceIds: string[]): JsonObject {
    const candidate = promoted.candidate as JsonObject | undefined;
    if (candidate?.status !== "conflict_pending") return promoted;
    const policy = this.memory.policyGet().policy as JsonObject;
    if (policy.mode !== "governed" || evidenceIds.length === 0) return promoted;
    const evidenceIsQualified = evidenceIds.every(evidenceId => {
      const evidence = this.memory.store.find("evidence", evidenceId);
      if (!evidence) return false;
      const confidence = String(evidence.confidence);
      return policy.min_confidence === "bounded" ? ["bounded", "confirmed"].includes(confidence) : confidence === "confirmed";
    });
    if (!evidenceIsQualified) return promoted;
    const resolved = this.memory.resolveConflict({ candidate_id: candidate.id, actor: "automatic-repeat-evidence", resolution: "supersede",
      reason: "Independent repeated observations met the configured Memory promotion threshold and Evidence policy." });
    return { ...promoted, ...resolved };
  }

}
