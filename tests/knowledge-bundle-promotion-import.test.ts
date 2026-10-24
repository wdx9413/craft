import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeMemoryBundleKernel } from "../core/knowledge-memory-bundle.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { stableDigest } from "../core/digest.ts";

test("portable Knowledge import preserves source review as history but removes local promotion authority", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "craft-bundle-promotion-source-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "craft-bundle-promotion-target-"));
  const source = await new CraftStore(craftPaths(sourceRoot)).open();
  const target = await new CraftStore(craftPaths(targetRoot)).open();
  try {
    source.create("scope_alias", "source-root", { status: "active", scope: { kind: "project", id: "project:bundle" }, alias_kind: "path", alias: sourceRoot, alias_digest: stableDigest(sourceRoot) });
    target.create("scope_alias", "target-root", { status: "active", scope: { kind: "project", id: "project:bundle" }, alias_kind: "path", alias: targetRoot, alias_digest: stableDigest(targetRoot) });
    source.create("knowledge_source", "source", { status: "active", trust: "verified", content_digest: "source-v1" });
    source.create("evidence", "evidence", { confidence: "confirmed", source_type: "receipt", claim: "Verified locally." });
    const content_ref = source.contentStore.writeSync({ kind: "knowledge", record_id: "reviewed", version: 1, scope: "project:bundle",
      status: "reviewed", sensitivity: "internal", source_id: "source", body: "portable reviewed claim" });
    source.create("knowledge_claim", "reviewed", { status: "reviewed", scope: "project:bundle", source_id: "source", content: "portable reviewed claim",
      content_digest: "claim-v1", content_ref, evidence_ids: ["evidence"], review: { reviewer: "automated-promotion-policy", policy_id: "local-only" } });
    const bundle = new KnowledgeMemoryBundleKernel(source).export({ scope_kind: "project", scope_id: "bundle" }).bundle;
    const receiver = new KnowledgeMemoryBundleKernel(target);
    receiver.importApply({ bundle, approved: true });
    const imported = target.get("knowledge_claim", "reviewed");
    assert.equal(imported.status, "candidate");
    assert.equal(imported.review, null);
    assert.deepEqual(imported.imported_review, { reviewer: "automated-promotion-policy", policy_id: "local-only" });
    assert.equal(imported.qualification_status, "revalidation_required_after_import");
    assert.equal(target.contentStore.readCompatSync(imported.content_ref as never, "project:bundle").body, "portable reviewed claim");
  } finally { source.close(); target.close(); await rm(sourceRoot, { recursive: true, force: true }); await rm(targetRoot, { recursive: true, force: true }); }
});
