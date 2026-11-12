import { KnowledgeClaimGovernance } from '@craft/capability-knowledge/claim-governance';
import { MemoryCapture } from '@craft/capability-memory/memory-capture';
import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import type { KnowledgeSourceRegistry } from '@craft/capability-knowledge/knowledge-source-registry';
import type { MemoryGovernanceKernel } from "../../memory-governance.ts";
import { text } from "../../validation.ts";

type Command = (args: JsonObject) => JsonObject;

/** Owns the capture/revalidation sequence; existing kernels retain their gates. */
export class CognitiveWriteCoordinator {
  readonly store: CraftStore;
  readonly sources: KnowledgeSourceRegistry;
  readonly memory: MemoryGovernanceKernel;
  readonly evidenceRecord: Command;
  readonly reviewClaim: Command;
  readonly resolveProject: Command;
  constructor(store: CraftStore, sources: KnowledgeSourceRegistry, memory: MemoryGovernanceKernel, evidenceRecord: Command, reviewClaim: Command, resolveProject: Command) {
    this.store = store; this.sources = sources; this.memory = memory; this.evidenceRecord = evidenceRecord; this.reviewClaim = reviewClaim; this.resolveProject = resolveProject;
  }

  captureUserStatement(args: JsonObject): JsonObject {
    return new MemoryCapture(this.memory, () => this.sources.installBuiltins(), this.evidenceRecord).captureUserStatement(args);
  }

  captureProjectCorrection(args: JsonObject): JsonObject {
    const projectRoot = text(args.project_root, "project_root");
    const resolved = this.resolveProject({ project_root: projectRoot });
    const identity = resolved.identity as JsonObject | undefined;
    const canonical = identity?.canonical_scope as JsonObject | undefined;
    if (canonical?.kind !== "project" || typeof canonical.id !== "string" || !canonical.id.startsWith("project:")) {
      throw new Error("project correction requires a canonical project identity");
    }
    for (const field of ["scope_id", "project_scope_id"] as const) {
      if (args[field] !== undefined && text(args[field], field) !== canonical.id) throw new Error(`${field} does not match project_root identity`);
    }
    return this.captureUserStatement({ ...args, scope_kind: "project", scope_id: canonical.id,
      project_scope_id: canonical.id, project_root: projectRoot, proposed_by: "explicit-user-correction" });
  }

  captureObservedFact(args: JsonObject): JsonObject {
    return new MemoryCapture(this.memory, () => this.sources.installBuiltins(), this.evidenceRecord).captureObservedFact(args);
  }

  sweepExpiredClaims(args: JsonObject = {}): JsonObject {
    const synchronized = new KnowledgeClaimGovernance(this.store).synchronize(args);
    const expired = (synchronized.affected as JsonObject[]).filter(claim => claim.status === "expired");
    return { ...synchronized, expired, count: expired.length, synchronized_count: synchronized.count };
  }

  resolveClaimConflict(args: JsonObject): JsonObject {
    const claim = this.store.get("knowledge_claim", text(args.claim_id, "claim_id"));
    const decision = text(args.decision, "decision");
    if (!new Set(["reviewed", "disputed", "superseded"]).has(decision)) throw new Error("knowledge conflict decision is unsupported");
    if (decision === "reviewed") {
      const ids = Array.isArray(claim.evidence_ids) ? claim.evidence_ids as unknown[] : [];
      if (!ids.some((e) => ["bounded", "confirmed"].includes(String(this.store.get("evidence", String(e)).confidence)))) throw new Error("Conflict resolution requires bounded or confirmed Evidence");
      throw new Error("Formal Knowledge promotion requires managed Host review and independent effectiveness evaluation");
    }
    return this.reviewClaim({ claim_id: claim.id, status: decision, reviewer: args.reviewer, reason: args.reason });
  }
}
