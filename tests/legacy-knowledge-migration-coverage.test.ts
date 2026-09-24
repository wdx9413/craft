import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { LegacyKnowledgeMigrationKernel } from "../core/legacy-knowledge-migration.ts";
import { CraftService } from "../core/service.ts";

const page = `---
title: Coverage page
status: confirmed
category: workflows
knowledge_type: workflow
evidence_type: test
evidence_ref: tests/coverage.test.ts
reuse_reason: Explicitly tested historical procedure.
scope: project
project: demo
---

# Coverage page

Safe historical content.
`;

test("Legacy migration rebind and model review reject every stale or malformed candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-coverage-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "craft-legacy-coverage-source-"));
  const pages = join(sourceRoot, "data", "pages", "workflows");
  await mkdir(pages, { recursive: true }); await writeFile(join(pages, "coverage.md"), page);
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store); const kernel = new LegacyKnowledgeMigrationKernel(store);
  try {
    const discovered = await service.legacyKnowledgeMigrationDiscover({ migration_id: "coverage", source_root: sourceRoot, offline: true });
    const entry = ((discovered.migration as JsonObject).entries as JsonObject[])[0]!;
    const imported = await service.legacyKnowledgeMigrationCandidateImport({ migration_id: "coverage", candidate_ids: [entry.rel_path], offline: true });
    const candidate = (imported.candidates as JsonObject[])[0]!;
    const original = store.get("legacy_knowledge_migration_candidate", String(candidate.id));
    const rebind = () => kernel.rebindProvenance({ migration_id: "coverage" });
    await assert.rejects(() => kernel.rebindProvenance({ migration_id: "coverage", candidate_ids: [] }), /non-empty/u);
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), { ...original, status: "published" });
    assert.equal(((await rebind()).unchanged as JsonObject[])[0]!.reason, "candidate_not_rebindable");
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), { ...original, source_locator: "missing.md" });
    assert.equal(((await rebind()).failures as JsonObject[])[0]!.code, "source_entry_missing");
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), { ...original, source_locator: undefined });
    assert.equal(((await rebind()).failures as JsonObject[])[0]!.source_locator, candidate.id);
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), original);
    await writeFile(join(pages, "coverage.md"), `${page}\nchanged`);
    assert.equal(((await rebind()).failures as JsonObject[])[0]!.code, "source_digest_drift");
    await writeFile(join(pages, "coverage.md"), page);
    const source = store.get("knowledge_source", String(original.source_id));
    store.save("knowledge_source", String(source.id), { ...source, status: "inactive" });
    assert.equal(((await rebind()).failures as JsonObject[])[0]!.code, "source_unavailable");
    store.save("knowledge_source", String(source.id), source);
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), { ...original, claim_id: "missing-claim" });
    assert.equal(((await rebind()).failures as JsonObject[])[0]!.code, "claim_missing");
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), original);

    const review = (assessments: JsonObject[]) => kernel.reviewCandidates({ migration_id: "coverage", reviewer: "reviewer", model_ref: "fixture", assessments });
    await assert.rejects(() => review([]), /non-empty/u);
    await assert.rejects(() => review([{ candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "bad", reason: "bad" }]), /unsupported/u);
    await assert.rejects(() => review([{ candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "revalidate", reason: "one" }, { candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "revalidate", reason: "two" }]), /unique/u);
    assert.equal(((await review([{ candidate_id: "missing", source_digest: "sha256:x", decision: "supported", reason: "missing" }])).failures as JsonObject[])[0]!.code, "candidate_not_reviewable");
    assert.equal(((await review([{ candidate_id: candidate.id, source_digest: "sha256:wrong", decision: "supported", reason: "wrong" }])).failures as JsonObject[])[0]!.code, "assessment_source_digest_mismatch");
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), { ...original, source_locator: "missing.md" });
    assert.equal(((await review([{ candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "supported", reason: "missing entry" }])).failures as JsonObject[])[0]!.code, "source_entry_missing");
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), original);
    await writeFile(join(pages, "coverage.md"), `${page}\nchanged`);
    assert.equal(((await review([{ candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "supported", reason: "drift" }])).failures as JsonObject[])[0]!.code, "source_unavailable_or_drifted");
    await writeFile(join(pages, "coverage.md"), page);
    assert.equal(((await review([{ candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "revalidate", reason: "defer" }])).deferred as JsonObject[]).length, 1);
    assert.equal(((await review([{ candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "supported", reason: "support" }])).reviewed as JsonObject[]).length, 1);
    const claim = store.get("knowledge_claim", String(original.claim_id));
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), { ...original, scope: "shared", project: null });
    assert.equal(((await review([{ candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "supported", reason: "shared" }])).reviewed as JsonObject[]).length, 1);
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), { ...original, scope: "project", project: null });
    assert.equal(((await review([{ candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "supported", reason: "unbound" }])).reviewed as JsonObject[]).length, 1);
    store.save("knowledge_claim", String(claim.id), { ...store.get("knowledge_claim", String(claim.id)), status: "published" });
    assert.equal(((await review([{ candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "supported", reason: "invalid claim" }])).failures as JsonObject[])[0]!.code, "claim_not_candidate");
    store.save("knowledge_claim", String(claim.id), { ...store.get("knowledge_claim", String(claim.id)), status: "candidate", evidence_ids: null });
    assert.equal(((await review([{ candidate_id: candidate.id, source_digest: candidate.source_digest, decision: "supported", reason: "no prior evidence" }])).reviewed as JsonObject[]).length, 1);

    const resolvedSourceRoot = await realpath(sourceRoot);
    const readPage = (kernel as unknown as { readSourcePage(root: string, entry: JsonObject): Promise<unknown> }).readSourcePage.bind(kernel);
    const entryFor = (rel_path: string, content: string): JsonObject => ({ rel_path, page_digest: `sha256:${createHash("sha256").update(content).digest("hex")}` });
    assert.notEqual(await readPage(resolvedSourceRoot, entryFor("data/pages/workflows/coverage.md", page)), null);
    assert.equal(await readPage(resolvedSourceRoot, { rel_path: "", page_digest: "sha256:x" }), null);
    assert.equal(await readPage(resolvedSourceRoot, { rel_path: "missing.md", page_digest: "sha256:x" }), null);
    assert.equal(await readPage(resolvedSourceRoot, { rel_path: "data", page_digest: "sha256:x" }), null);
    const large = "x".repeat(256 * 1024 + 1); await writeFile(join(pages, "large.md"), large);
    assert.equal(await readPage(resolvedSourceRoot, entryFor("data/pages/workflows/large.md", large)), null);
    const invalid = "---\nstatus: confirmed\n---\nbody"; await writeFile(join(pages, "invalid.md"), invalid);
    assert.equal(await readPage(resolvedSourceRoot, entryFor("data/pages/workflows/invalid.md", invalid)), null);
    const emptyBody = "---\nstatus: confirmed\nevidence_ref: tests/coverage.test.ts\n---\n"; await writeFile(join(pages, "empty.md"), emptyBody);
    assert.equal(await readPage(resolvedSourceRoot, entryFor("data/pages/workflows/empty.md", emptyBody)), null);
    const outside = await mkdtemp(join(tmpdir(), "craft-legacy-coverage-outside-")); await writeFile(join(outside, "outside.md"), page);
    try { await symlink(join(outside, "outside.md"), join(pages, "escape.md")); assert.equal(await readPage(resolvedSourceRoot, entryFor("data/pages/workflows/escape.md", page)), null); }
    finally { await rm(outside, { recursive: true, force: true }); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(sourceRoot, { recursive: true, force: true }); }
});
