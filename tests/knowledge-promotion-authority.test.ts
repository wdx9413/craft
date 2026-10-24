import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "craft-knowledge-authority-")), project = join(root, "project"); mkdirSync(project);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const service = new CraftService(store);
  service.scopeAliasBind({ scope_kind: "project", scope_id: "project:probe", alias_kind: "path", alias: project });
  service.knowledgeSourceRegister({ source_id: "source", kind: "custom", label: "隔离来源", scope_kind: "project", scope_id: "probe",
    locator: "fixture://promotion-authority", content_digest: `sha256:${"a".repeat(64)}`, trust: "verified" });
  const evidence = service.evidenceRecord({ evidence_id: "evidence", source_type: "observation", confidence: "confirmed", claim: "调用者提供的观察" });
  service.knowledgeClaimSave({ claim_id: "claim", kind: "fact", content: "晋升越权回归事实", scope: "project:probe", source_id: "source", evidence_ids: [evidence.id] });
  return { service, store, server: new McpServer(service, "full") };
}

test("caller-supplied reviewer and trust labels cannot promote Knowledge through MCP or the SDK", async t => {
  const f = await fixture(t);
  for (const reviewer of ["human", "admin", "automated-promotion-policy", "host:codex"]) {
    const args = { claim_id: "claim", status: "reviewed", reviewer, reason: "调用者自行声明确认", actor: "trusted", trust: "verified", human_confirmed: true };
    assert.throws(() => f.service.knowledgeClaimReview(args), /independent effectiveness evaluation/u);
    const result = await f.server.handle({ id: reviewer, method: "tools/call", params: { name: "craft_knowledge_claim_review", arguments: args } });
    assert.equal((result?.result as JsonObject).isError, true);
  }
  assert.equal(f.store.get("knowledge_claim", "claim").status, "candidate");
  assert.equal(f.store.get("knowledge_claim", "claim").version, 1);
  assert.equal(f.store.count("knowledge_evaluation_run"), 0);
  assert.equal(((await f.service.knowledgeSearchScoped({ query: "晋升越权回归事实", scope_kind: "project", scope_id: "probe" })).hits as unknown[]).length, 0);
});

test("public review retains evidenced negative transitions without granting promotion authority", async t => {
  const f = await fixture(t);
  for (const status of ["disputed", "superseded", "expired", "stale"]) {
    const result = f.service.knowledgeClaimReview({ claim_id: "claim", status, reviewer: "user", reason: "观察到适用范围不再成立" });
    assert.equal((result.claim as JsonObject).status, status);
  }
  assert.throws(() => f.service.knowledgeClaimReview({ claim_id: "claim", status: "candidate", reviewer: "user", reason: "恢复" }), /unsupported/u);
});

test("unproven historical reviewed labels are quarantined before assessment", async t => {
  const f = await fixture(t);
  const claim = f.store.get("knowledge_claim", "claim");
  f.store.save("knowledge_claim", "claim", { ...claim, status: "reviewed", review: { reviewer: "human", source_digest: "caller-asserted" } });
  const compiled = f.service.wikiContextCompile({ query: "晋升越权回归事实", scope: "project:probe" });
  assert.deepEqual(compiled.included, [], "Wiki compilation must reject a reviewed label without a local promotion chain");
  const diagnostic = f.service.knowledgeSearch({ query: "晋升越权回归事实", scope: "project:probe", include_candidates: true });
  assert.equal(((diagnostic.hits as JsonObject[])[0]!).status, "candidate_diagnostic");
  const result = f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "probe", claim_ids: ["claim"], auto_promote: false });
  const assessment = (result.assessments as JsonObject[])[0]!;
  const quarantined = f.store.get("knowledge_claim", "claim");
  assert.equal(quarantined.status, "candidate");
  assert.equal((quarantined.review as JsonObject).qualification_status, "legacy_promotion_quarantined");
  assert.equal(assessment.promoted, false);
  assert((assessment.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
  assert.equal(((await f.service.knowledgeSearchScoped({ query: "晋升越权回归事实", scope_kind: "project", scope_id: "probe" })).hits as unknown[]).length, 0);
});
