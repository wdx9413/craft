import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
test("knowledge context compilation uses only reviewed, current, scoped claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-context-wiki-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const evidence = service.evidenceRecord({ source_type: "program", claim: "Observed." });
    const claim = (name: string, content: string, scope = "global", valid_until?: string) => service.knowledgeClaimSave({ claim_id: name, kind: "fact", content, scope, evidence_ids: [evidence.id], valid_until }).claim as JsonObject;
    const good = claim("good", "Use stable route alpha."); const local = claim("local", "Use alpha with local data.", "project:a"); const stale = claim("stale", "Use alpha before migration.", "global", "2000-01-01T00:00:00.000Z"); const unreviewed = claim("candidate", "Use alpha experiment."); const other = claim("other", "Use alpha elsewhere.", "project:b"); const noMatch = claim("no-match", "Use gamma.");
    for (const item of [good, local, stale, other, noMatch]) service.knowledgeClaimReview({ claim_id: item.id, status: "reviewed", reviewer: "human", reason: "checked" });
    const compiled = service.wikiContextCompile({ bundle_id: "bundle", query: "alpha", scope: "project:a", max_items: 2, max_chars: 500, now: "2027-01-01T00:00:00.000Z" }); const included = compiled.included as JsonObject[]; const excluded = compiled.excluded as JsonObject[];
    assert.deepEqual(included.map((item) => item.claim_id), ["good", "local"]); assert.deepEqual(excluded.map((item) => item.reason).sort(), ["expired", "not_matched", "not_reviewed", "out_of_scope"]); assert.match(String(compiled.context), /Evidence:/); assert.equal(((compiled.bundle as JsonObject).semantic_retrieval), "disabled_by_default");
    assert.equal((service.wikiContextCompile({ bundle_id: "bundle", query: "alpha", scope: "project:a", max_items: 2, max_chars: 500, now: "2027-01-01T00:00:00.000Z" }) as JsonObject).idempotent, true); await assert.rejects(Promise.resolve().then(() => service.wikiContextCompile({ bundle_id: "bundle", query: "gamma" })), /idempotency/);
    const empty = service.wikiContextCompile({ query: "???" }); assert.equal((empty.included as JsonObject[]).length, 0); assert.equal(((empty.bundle as JsonObject).used_chars), 0);
    const bounded = service.wikiContextCompile({ query: "alpha", scope: "project:a", max_items: 1, max_chars: 100 }); assert.equal((bounded.included as JsonObject[]).length, 1); assert.equal((bounded.excluded as JsonObject[]).some((item) => item.reason === "budget"), true);
    const receipt = service.wikiContextBundleGet({ bundle_id: "bundle", version: 1 }).bundle as JsonObject; assert.equal(receipt.claim_refs instanceof Array, true); assert.equal((service.wikiContextBundleList({ query: "bundle" }).bundles as JsonObject[]).some((item) => item.id === "bundle"), true);
    const mcp = new McpServer(service, "full"); for (const [name, arguments_] of [["craft_wiki_context_compile", { query: "alpha" }], ["craft_wiki_context_bundle_get", { bundle_id: "bundle" }], ["craft_wiki_context_bundle_list", {}]] as [string, JsonObject][]) { const result = await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } }); assert.equal((result?.result as JsonObject).isError, false); }
    assert.equal(VERSION, "0.11.35");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
