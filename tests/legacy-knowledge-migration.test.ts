import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { LegacyKnowledgeMigrationKernel } from "../src/legacy-knowledge-migration.ts";

const eligible = `---\ntitle: Reusable workflow\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: tests/reusable.test.ts\nreuse_reason: Apply the checked workflow after review.\nscope: project\nproject: demo\ntags: demo, workflow\n---\n\n# Reusable workflow\n\nRaw body is never retained.\n`;
const sensitive = `---\ntitle: Sensitive note\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: x\nreuse_reason: token=supersecretvalue\nscope: project\n---\n\nsecret body\n`;

test("legacy formal knowledge migration is read-only, candidate-first, deduplicated, auditable and retractable", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-migration-")); const legacy = await mkdtemp(join(tmpdir(), "legacy-knowledge-")); const pages = join(legacy, "data", "pages", "workflows"); await mkdir(pages, { recursive: true }); await writeFile(join(pages, "eligible.md"), eligible); await writeFile(join(pages, "sensitive.md"), sensitive); await writeFile(join(pages, "heading.md"), `---\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: x\nreuse_reason: heading fallback\n---\n# Heading fallback\n`);
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    await assert.rejects(service.legacyKnowledgeMigrationDiscover({ source_root: join(legacy, "missing"), offline: true }), /ENOENT/);
    const discovered = await service.legacyKnowledgeMigrationDiscover({ migration_id: "migration", source_root: legacy, offline: true }); const migration = discovered.migration as JsonObject; const entries = migration.entries as JsonObject[];
    const kernel = new LegacyKnowledgeMigrationKernel(store);
    await assert.rejects(kernel.discover({ source_root: join(legacy, "missing") }), /ENOENT/);
    const emptyLegacy = await mkdtemp(join(tmpdir(), "legacy-empty-"));
    await assert.rejects(kernel.discover({ source_root: emptyLegacy }), /source_root must contain data\/pages/);
    assert.equal(kernel.recordFailure("migration", "test", "missing.md", "synthetic").startsWith("legacy_knowledge_migration_report_"), true);
    assert.equal((service.knowledgeSourceSnapshot({ migration_id: "migration" }).content_free), true);
    assert.equal((await service.knowledgeSourceDiff({ migration_id: "migration" })).migration_id, "migration");
    assert.equal((service.knowledgeSourceSnapshot({ migration_id: migration.id }).migration as JsonObject).id, migration.id);
    assert.equal(entries.filter((item) => item.eligibility === "eligible").length, 2); assert.equal(entries.find((item) => item.rel_path === "data/pages/workflows/heading.md")?.title, "Heading fallback"); assert.equal(entries.find((item) => item.rel_path === "data/pages/workflows/sensitive.md")?.reason, "sensitive_or_disallowed"); assert.doesNotMatch(JSON.stringify(migration), /supersecretvalue|Raw body/);
    const imported = await service.legacyKnowledgeMigrationCandidateImport({ migration_id: "migration", candidate_ids: ["data/pages/workflows/eligible.md", "data/pages/workflows/sensitive.md", "unknown.md"], offline: true }); const candidate = (imported.candidates as JsonObject[]).find((item) => item.status === "candidate")!;
    const aliasImport = await service.knowledgeCandidateImport({ migration_id: "migration", candidate_ids: ["data/pages/workflows/eligible.md"], offline: true }); assert.ok(aliasImport);
    assert.equal((imported.failures as JsonObject[]).length, 2); assert.equal((await service.legacyKnowledgeMigrationDiscover({ migration_id: "migration", source_root: legacy, offline: true })).idempotent, true); assert.equal(((await service.legacyKnowledgeMigrationCandidateImport({ migration_id: "migration", candidate_ids: ["data/pages/workflows/eligible.md"], offline: true })).candidates as JsonObject[])[0].idempotent, true);
    await assert.rejects(service.legacyKnowledgeMigrationPublish({ candidate_id: candidate.id, reviewer: "reviewer" }), /reviewed/); store.save("evidence", String(candidate.evidence_id), { ...store.get("evidence", String(candidate.evidence_id)), confidence: "bounded" }); service.knowledgeCandidateReview({ candidate_id: candidate.id, status: "reviewed", reviewer: "reviewer", reason: "evidence checked" });
    const published = await service.legacyKnowledgeMigrationPublish({ candidate_id: candidate.id, reviewer: "reviewer" }); assert.equal((published.candidate as JsonObject).status, "published"); const memory = store.get("memory_ledger", String((published.candidate as JsonObject).memory_id)); assert.equal(memory.confidence, "bounded"); assert.equal(memory.status, "active");
    assert.equal((await service.knowledgeCandidatePublish({ candidate_id: candidate.id, reviewer: "reviewer" })).idempotent, true);
    const retracted = await service.legacyKnowledgeMigrationRetract({ candidate_id: candidate.id, reviewer: "reviewer", reason: "source withdrawn" }); assert.equal((retracted.candidate as JsonObject).status, "retracted"); assert.equal(store.get("memory_ledger", String((retracted.candidate as JsonObject).memory_id)).status, "revoked"); assert.equal(store.get("knowledge_claim", String(candidate.claim_id)).status, "disputed"); assert.equal((service.legacyKnowledgeMigrationFailureReport({ migration_id: "migration" }).reports as JsonObject[]).length, 2);
    assert.equal((await service.knowledgeCandidateRetract({ candidate_id: candidate.id, reviewer: "reviewer", reason: "already withdrawn" })).idempotent, true);
    assert.equal((service.knowledgeMigrationFailureReport({ migration_id: "migration" }).reports as JsonObject[]).length, 2);
    await writeFile(join(pages, "eligible.md"), `${eligible}\nchanged`); const drift = await service.legacyKnowledgeMigrationDiscover({ migration_id: "drift", source_root: legacy, offline: true }); const drifted = await service.legacyKnowledgeMigrationCandidateImport({ migration_id: String((drift.migration as JsonObject).id), candidate_ids: ["data/pages/workflows/eligible.md"], offline: true }); assert.equal((drifted.failures as JsonObject[]).length, 0); await writeFile(join(pages, "eligible.md"), eligible); const sourceDrift = await service.legacyKnowledgeMigrationCandidateImport({ migration_id: String((drift.migration as JsonObject).id), candidate_ids: ["data/pages/workflows/eligible.md"], offline: true }); assert.equal((sourceDrift.failures as JsonObject[])[0].code, "source_digest_drift");
    const diff = await service.knowledgeSourceDiff({ migration_id: "migration", source_root: legacy }); assert.equal(diff.changed, false);
    const mcp = new McpServer(service, "component-knowledge"); const listed = await mcp.handle({ id: "tools", method: "tools/list", params: {} }); assert.equal(((listed?.result as JsonObject).tools as JsonObject[]).some((item) => String(item.name).includes("legacy_knowledge")), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); }
});

test("legacy migration discovery and import cover metadata, drift and failure branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-edge-"));
  const legacy = await mkdtemp(join(tmpdir(), "legacy-edge-"));
  const pages = join(legacy, "data", "pages", "workflows"); await mkdir(pages, { recursive: true });
  const valid = (title: string) => `---\ntitle: ${title}\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: tests/x\nreuse_reason: reusable rule\n---\n# ${title}\n`;
  await writeFile(join(pages, "valid.md"), valid("Valid"));
  await writeFile(join(pages, "plain.md"), "plain body");
  await writeFile(join(pages, "unsupported.md"), "---\nstatus: confirmed\ncategory: unknown\nknowledge_type: unknown\nevidence_type: test\nevidence_ref: x\nreuse_reason: reusable\n---\n");
  await writeFile(join(pages, "missing-evidence.md"), "---\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\n---\n");
  await writeFile(join(pages, "forbidden.md"), "---\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: x\nreuse_reason: 会议纪要\n---\n");
  await writeFile(join(pages, "large.md"), "x".repeat(256 * 1024 + 1));
  const store = await new CraftStore(craftPaths(root)).open(); const kernel = new LegacyKnowledgeMigrationKernel(store);
  try {
    const discovered = await kernel.discover({ migration_id: "edge-discovery", source_root: legacy });
    const entries = discovered.migration as JsonObject; const list = entries.entries as JsonObject[];
    assert.equal(list.find((item) => String(item.rel_path).endsWith("plain.md"))?.reason, "not_confirmed");
    assert.equal(list.find((item) => String(item.rel_path).endsWith("unsupported.md"))?.reason, "unsupported_metadata");
    assert.equal(list.find((item) => String(item.rel_path).endsWith("missing-evidence.md"))?.reason, "missing_evidence_or_reuse_reason");
    assert.equal(list.find((item) => String(item.rel_path).endsWith("forbidden.md"))?.reason, "sensitive_or_disallowed");
    assert.equal(list.find((item) => String(item.rel_path).endsWith("large.md"))?.reason, "file_too_large");
    const beforeDigest = String((discovered.migration as JsonObject).source_digest);
    await writeFile(join(pages, "valid.md"), valid("Changed")); await rm(join(pages, "unsupported.md"), { force: true });
    const diff = await kernel.sourceDiff({ migration_id: "edge-discovery", source_root: legacy });
    assert.equal(diff.changed, true); assert.ok((diff.tombstones as string[]).some((item) => item.endsWith("unsupported.md"))); assert.notEqual(diff.current_digest, beforeDigest);
    const fresh = await kernel.discover({ migration_id: "edge-import", source_root: legacy });
    const freshMigration = fresh.migration as JsonObject; const eligible = (freshMigration.entries as JsonObject[]).find((item) => String(item.rel_path).endsWith("valid.md"))!;
    const imported = await kernel.importCandidates({ migration_id: "edge-import", candidate_ids: [String(eligible.rel_path), "unknown.md"] }, "source", (entry) => ({ evidence_id: `e:${entry.rel_path}`, claim_id: `c:${entry.rel_path}` }));
    assert.equal((imported.candidates as JsonObject[]).length, 1); assert.equal((imported.failures as JsonObject[])[0]?.code, "unknown_candidate");
    const again = await kernel.importCandidates({ migration_id: "edge-import", candidate_ids: [String(eligible.rel_path)] }, "source", () => { throw new Error("should not be called"); });
    assert.equal((again.candidates as JsonObject[])[0]?.idempotent, true);
    await assert.rejects(kernel.importCandidates({ migration_id: "edge-import", candidate_ids: [] }, "source", () => ({ evidence_id: "e", claim_id: "c" })), /non-empty/);
    const candidate = (imported.candidates as JsonObject[])[0]!;
    await assert.rejects(Promise.resolve().then(() => kernel.publishReady({ candidate_id: candidate.id })), /knowledge_claim/);
    store.create("knowledge_claim", String(candidate.claim_id), { status: "candidate", evidence_ids: [candidate.evidence_id] });
    assert.throws(() => kernel.publishReady({ candidate_id: candidate.id }), /reviewed/);
    store.save("knowledge_claim", String(candidate.claim_id), { ...store.get("knowledge_claim", String(candidate.claim_id)), status: "reviewed" });
    assert.equal(kernel.publishReady({ candidate_id: candidate.id }).idempotent, false);
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), { ...candidate, status: "published" });
    assert.equal(kernel.publishReady({ candidate_id: candidate.id }).idempotent, true);
    assert.equal(kernel.retractReady({ candidate_id: candidate.id }).idempotent, false);
    store.save("legacy_knowledge_migration_candidate", String(candidate.id), { ...store.get("legacy_knowledge_migration_candidate", String(candidate.id)), status: "retracted" });
    assert.equal(kernel.retractReady({ candidate_id: candidate.id }).idempotent, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); }
});
