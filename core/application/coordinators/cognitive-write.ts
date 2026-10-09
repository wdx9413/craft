import { KnowledgeClaimGovernance } from "../../../capability/craft-knowledge/claim-governance.ts";
import { MemoryCapture } from "../../../capability/craft-memory/memory-capture.ts";
import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import type { KnowledgeSourceRegistry } from "../../../capability/craft-knowledge/knowledge-source-registry.ts";
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
  constructor(store: CraftStore, sources: KnowledgeSourceRegistry, memory: MemoryGovernanceKernel, evidenceRecord: Command, reviewClaim: Command) {
    this.store = store; this.sources = sources; this.memory = memory; this.evidenceRecord = evidenceRecord; this.reviewClaim = reviewClaim;
  }

  captureUserStatement(args: JsonObject): JsonObject {
    return new MemoryCapture(this.memory, () => this.sources.installBuiltins(), this.evidenceRecord).captureUserStatement(args);
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
    }
    return this.reviewClaim({ claim_id: claim.id, status: decision, reviewer: args.reviewer, reason: args.reason });
  }
}
