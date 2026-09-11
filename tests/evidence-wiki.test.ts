import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
test("editable Wiki material remains separate from evidence-backed claim review", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-wiki-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const evidence = service.evidenceRecord({ evidence_id: "e1", source_type: "program", claim: "Observed stable result.", confidence: "confirmed" });
    const claim = service.knowledgeClaimSave({ claim_id: "claim-1", kind: "rule", content: "Use the stable result.", scope: "project:a", tags: ["safe"], evidence_ids: [evidence.id], valid_until: "2030-01-01T00:00:00.000Z" }).claim as JsonObject;
    assert.equal(claim.status, "candidate"); assert.equal((service.knowledgeClaimSave({ claim_id: "claim-1", kind: "rule", content: "Use the stable result.", scope: "project:a", tags: ["safe"], evidence_ids: [evidence.id], valid_until: "2030-01-01T00:00:00.000Z" }) as JsonObject).idempotent, true);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeClaimSave({ claim_id: "claim-1", kind: "fact", content: "Different.", evidence_ids: [evidence.id] })), /idempotency/);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeClaimSave({ kind: "bad", content: "x", evidence_ids: [evidence.id] })), /unsupported/);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeClaimSave({ kind: "fact", content: "token=leak", evidence_ids: [evidence.id] })), /sensitive/);
    const reviewed = service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "human", reason: "Checked source." }).claim as JsonObject; assert.equal(reviewed.status, "reviewed"); assert.equal((service.knowledgeClaimGet({ claim_id: claim.id, version: 1 }).claim as JsonObject).status, "candidate");
    await assert.rejects(Promise.resolve().then(() => service.knowledgeClaimReview({ claim_id: claim.id, status: "candidate", reviewer: "human", reason: "no" })), /unsupported/);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeClaimReview({ claim_id: claim.id, status: "bad", reviewer: "human", reason: "no" })), /unsupported/);
    const page = (await service.wikiPageSave({ page_id: "page", title: "Playbook", body: "Editable explanation.", scope: "project:a", claim_ids: [claim.id], author: "agent" })).page as JsonObject;
    assert.equal(((await service.wikiPageSave({ page_id: "page", title: "Playbook", body: "Editable explanation.", scope: "project:a", claim_ids: [claim.id], author: "agent" })) as JsonObject).idempotent, true);
    const revised = (await service.wikiPageSave({ page_id: "page", title: "Playbook", body: "Revised explanation.", claim_ids: [] })).page as JsonObject; assert.equal(revised.version, 2); assert.equal((await service.wikiPageGet({ page_id: page.id, version: 1 })).body, "Editable explanation.");
    await writeFile(String(revised.file_path), "Human revision.", "utf8"); assert.equal((await service.wikiPageGet({ page_id: page.id })).body, "Human revision."); await assert.rejects(service.wikiPageSave({ page_id: page.id, title: "Playbook", body: "Overwrite.", claim_ids: [] }), /unrecorded/); assert.equal(((await service.wikiPageRefresh({ page_id: page.id })) as JsonObject).changed, true); assert.equal(((await service.wikiPageRefresh({ page_id: page.id })) as JsonObject).changed, false);
    await assert.rejects(service.wikiPageSave({ title: "x", body: "password=leak" }), /sensitive/);
    const relation = service.knowledgeRelationSave({ relation_id: "r", from_claim_id: claim.id, to_claim_id: (service.knowledgeClaimSave({ kind: "fact", content: "Another observed result.", evidence_ids: [evidence.id] }).claim as JsonObject).id, relation: "supports" }).relation as JsonObject; assert.equal(relation.relation, "supports");
    assert.equal((service.knowledgeRelationSave({ relation_id: "r", from_claim_id: relation.from_claim_id, to_claim_id: relation.to_claim_id, relation: "supports" }) as JsonObject).idempotent, true);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeRelationSave({ relation_id: "r", from_claim_id: relation.from_claim_id, to_claim_id: relation.to_claim_id, relation: "contradicts" })), /idempotency/);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeRelationSave({ from_claim_id: claim.id, to_claim_id: claim.id, relation: "supports" })), /differ/);
    await assert.rejects(Promise.resolve().then(() => service.knowledgeRelationSave({ from_claim_id: claim.id, to_claim_id: relation.to_claim_id, relation: "bad" })), /unsupported/);
    const mcp = new McpServer(service, "full");
    for (const [name, arguments_] of [["craft_knowledge_claim_get", { claim_id: claim.id }], ["craft_knowledge_claim_list", {}], ["craft_knowledge_claim_review", { claim_id: claim.id, status: "disputed", reviewer: "human", reason: "newer source" }], ["craft_wiki_page_get", { page_id: page.id }], ["craft_wiki_page_list", {}], ["craft_wiki_page_refresh", { page_id: page.id }], ["craft_knowledge_relation_save", { from_claim_id: claim.id, to_claim_id: relation.to_claim_id, relation: "contradicts" }], ["craft_knowledge_claim_save", { kind: "term", content: "A named concept.", evidence_ids: [evidence.id] }], ["craft_wiki_page_save", { title: "MCP", body: "A page." }]] as [string, JsonObject][]) {
      const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } }); assert.equal((result?.result as JsonObject).isError, false);
    }
    assert.equal(VERSION, "0.11.55");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
