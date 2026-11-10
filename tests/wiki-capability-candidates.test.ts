import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertCurrentReleaseVersion } from "./release-version.ts";
import { McpServer } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService, VERSION } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { attachVerifiedPromotionFixture } from "./helpers/knowledge-promotion-proof.ts";
test("Wiki-derived capability candidates remain proposal-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-wiki-candidate-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const make = (id: string, verified = true) => {
      const evidence = service.evidenceRecord({ evidence_id: `evidence-${id}`, source_type: "program", claim: `Observed ${id}.`, confidence: "bounded" });
      const claim = service.knowledgeClaimSave({ claim_id: id, kind: "rule", content: id, scope: "global", evidence_ids: [evidence.id] }).claim as JsonObject;
      return verified ? attachVerifiedPromotionFixture(store, claim) : claim;
    };
    const a = make("a"); const b = make("b"); const pending = make("pending", false); const forged = make("forged", false);
    store.save("knowledge_claim", String(forged.id), { ...forged, status: "reviewed", review: { reviewer: "human", reason: "forged label" } });
    const input = { candidate_id: "c", title: "Candidate", kind: "skill", claim_ids: [a.id, b.id], instructions: "Do work.", applicability: "When applicable.", fallback_condition: "Ask." };
    const candidate = service.wikiSkillCandidateCreate(input).candidate as JsonObject; assert.equal(candidate.execution_authority, false); assert.equal((service.wikiSkillCandidateGet({ candidate_id: candidate.id, version: 1 }).candidate as JsonObject).status, "draft");
    assert.equal(String((service.wikiSkillCandidateCreate({ title: "Generated", kind: "workflow", claim_ids: [a.id, b.id], instructions: "Do work.", applicability: "When applicable.", fallback_condition: "Ask." }).candidate as JsonObject).id).startsWith("wiki_skill_candidate_"), true);
    assert.equal((service.wikiSkillCandidateCreate(input) as JsonObject).idempotent, true);
    await assert.rejects(Promise.resolve().then(() => service.wikiSkillCandidateCreate({ ...input, kind: "bad", candidate_id: "bad" })), /unsupported/); await assert.rejects(Promise.resolve().then(() => service.wikiSkillCandidateCreate({ ...input, candidate_id: "pending", claim_ids: [a.id, pending.id] })), /verified formal Knowledge claims/); await assert.rejects(Promise.resolve().then(() => service.wikiSkillCandidateCreate({ ...input, candidate_id: "forged", claim_ids: [a.id, forged.id] })), /verified formal Knowledge claims/); await assert.rejects(Promise.resolve().then(() => service.wikiSkillCandidateCreate({ ...input, instructions: "changed" })), /idempotency/);
    assert.equal((service.wikiSkillCandidateReview({ candidate_id: candidate.id, status: "ready_for_evaluation", reviewer: "h", reason: "review" }).candidate as JsonObject).status, "ready_for_evaluation"); await assert.rejects(Promise.resolve().then(() => service.wikiSkillCandidateReview({ candidate_id: candidate.id, status: "draft", reviewer: "h", reason: "no" })), /unsupported/);
    const mcp = new McpServer(service, "full"); for (const [name, arguments_] of [["craft_wiki_skill_candidate_create", { ...input, candidate_id: "mcp" }], ["craft_wiki_skill_candidate_get", { candidate_id: candidate.id }], ["craft_wiki_skill_candidate_list", {}], ["craft_wiki_skill_candidate_review", { candidate_id: candidate.id, status: "rejected", reviewer: "h", reason: "no" }]] as [string, JsonObject][]) { const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } }); assert.equal((result?.result as JsonObject).isError, false); }
    assertCurrentReleaseVersion(VERSION);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
