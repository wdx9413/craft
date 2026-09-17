import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
    await assert.rejects(Promise.resolve().then(() => service.legacyKnowledgeMigrationDiscover({ source_root: legacy })), /offline-only/);
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
    await assert.rejects(Promise.resolve().then(() => service.legacyKnowledgeMigrationCandidateImport({ migration_id: "migration", candidate_ids: ["data/pages/workflows/eligible.md"] })), /offline-only/);
    const aliasImport = await service.knowledgeCandidateImport({ migration_id: "migration", candidate_ids: ["data/pages/workflows/eligible.md"], offline: true }); assert.ok(aliasImport);
    assert.equal((imported.failures as JsonObject[]).length, 2); assert.equal((await service.legacyKnowledgeMigrationDiscover({ migration_id: "migration", source_root: legacy, offline: true })).idempotent, true); assert.equal(((await service.legacyKnowledgeMigrationCandidateImport({ migration_id: "migration", candidate_ids: ["data/pages/workflows/eligible.md"], offline: true })).candidates as JsonObject[])[0].idempotent, true);
    await assert.rejects(service.legacyKnowledgeMigrationPublish({ candidate_id: candidate.id, reviewer: "reviewer" }), /reviewed/); store.save("evidence", String(candidate.evidence_id), { ...store.get("evidence", String(candidate.evidence_id)), confidence: "bounded" }); service.knowledgeCandidateReview({ candidate_id: candidate.id, status: "reviewed", reviewer: "reviewer", reason: "evidence checked" });
    await assert.rejects(Promise.resolve().then(() => service.legacyKnowledgeMigrationPublish({ candidate_id: candidate.id, reviewer: "" })), /reviewer/);
    const originalWikiSave = service.wikiPageSave; service.wikiPageSave = (async () => { throw new Error("publish failure"); }) as typeof service.wikiPageSave;
    await assert.rejects(service.legacyKnowledgeMigrationPublish({ candidate_id: candidate.id, reviewer: "reviewer" }), /publish failure/); service.wikiPageSave = originalWikiSave;
    const published = await service.legacyKnowledgeMigrationPublish({ candidate_id: candidate.id, reviewer: "reviewer" }); assert.equal((published.candidate as JsonObject).status, "published"); const memory = store.get("memory_ledger", String((published.candidate as JsonObject).memory_id)); assert.equal(memory.confidence, "bounded"); assert.equal(memory.status, "active");
    assert.equal((await service.knowledgeCandidatePublish({ candidate_id: candidate.id, reviewer: "reviewer" })).idempotent, true);
    await assert.rejects(service.legacyKnowledgeMigrationRetract({ candidate_id: candidate.id, reviewer: "", reason: "source withdrawn" }), /reviewer/);
    const originalClaimReview = service.knowledgeClaimReview; service.knowledgeClaimReview = (() => { throw new Error("retract failure"); }) as typeof service.knowledgeClaimReview;
    await assert.rejects(service.legacyKnowledgeMigrationRetract({ candidate_id: candidate.id, reviewer: "reviewer", reason: "source withdrawn" }), /retract failure/); service.knowledgeClaimReview = originalClaimReview;
    const retracted = await service.legacyKnowledgeMigrationRetract({ candidate_id: candidate.id, reviewer: "reviewer", reason: "source withdrawn" }); assert.equal((retracted.candidate as JsonObject).status, "retracted"); assert.equal(store.get("memory_ledger", String((retracted.candidate as JsonObject).memory_id)).status, "revoked"); assert.equal(store.get("knowledge_claim", String(candidate.claim_id)).status, "disputed"); assert.equal((service.legacyKnowledgeMigrationFailureReport({ migration_id: "migration" }).reports as JsonObject[]).length, 4);
    assert.equal((await service.knowledgeCandidateRetract({ candidate_id: candidate.id, reviewer: "reviewer", reason: "already withdrawn" })).idempotent, true);
    assert.equal((service.knowledgeMigrationFailureReport({ migration_id: "migration" }).reports as JsonObject[]).length, 4);
    await writeFile(join(pages, "eligible.md"), `${eligible}\nchanged`); const drift = await service.legacyKnowledgeMigrationDiscover({ migration_id: "drift", source_root: legacy, offline: true }); const drifted = await service.legacyKnowledgeMigrationCandidateImport({ migration_id: String((drift.migration as JsonObject).id), candidate_ids: ["data/pages/workflows/eligible.md"], offline: true }); assert.equal((drifted.failures as JsonObject[]).length, 0); await writeFile(join(pages, "eligible.md"), eligible); const sourceDrift = await service.legacyKnowledgeMigrationCandidateImport({ migration_id: String((drift.migration as JsonObject).id), candidate_ids: ["data/pages/workflows/eligible.md"], offline: true }); assert.equal((sourceDrift.failures as JsonObject[])[0].code, "source_digest_drift");
    const diff = await service.knowledgeSourceDiff({ migration_id: "migration", source_root: legacy }); assert.equal(diff.changed, false);
    const mcp = new McpServer(service, "component-knowledge"); const listed = await mcp.handle({ id: "tools", method: "tools/list", params: {} }); assert.equal(((listed?.result as JsonObject).tools as JsonObject[]).some((item) => String(item.name).includes("legacy_knowledge")), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); }
});

test("legacy migration compatibility defaults and non-Error failures remain explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-compat-")); const legacy = await mkdtemp(join(tmpdir(), "legacy-compat-"));
  const pages = join(legacy, "data", "pages", "facts"); await mkdir(pages, { recursive: true });
  const page = (title: string, type: string) => `---\ntitle: ${title}\nstatus: confirmed\ncategory: workflows\nknowledge_type: ${type}\nevidence_type: test\nevidence_ref: tests/x\nreuse_reason: reusable\nscope: project\n---\n# ${title}\n`;
  await writeFile(join(pages, "working.md"), page("Working fact", "stable_project_fact"));
  await writeFile(join(pages, "missing-meta.md"), "---\nstatus: confirmed\nevidence_type: test\nevidence_ref: tests/x\nreuse_reason: reusable\n---\n# Missing metadata\n");
  await writeFile(join(pages, "summary-secret.md"), "---\ntitle: Summary secret\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: tests/x\nreuse_reason: token=supersecretvalue\n---\n# Summary secret\n");
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  try {
    const discovered = await service.legacyKnowledgeMigrationDiscover({ migration_id: "compat", source_root: legacy, offline: true });
    const entries = (discovered.migration as JsonObject).entries as JsonObject[];
    assert.equal(entries.find((item) => String(item.rel_path).endsWith("missing-meta.md"))?.reason, "unsupported_metadata");
    assert.equal(entries.find((item) => String(item.rel_path).endsWith("summary-secret.md"))?.reason, "sensitive_or_disallowed");
    await writeFile(join(legacy, "data", "pages", "facts", "body-secret.md"), "---\ntitle: Body secret\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: tests/x\nreuse_reason: reusable\n---\npassword: supersecret\n");
    const bodySecret = await service.legacyKnowledgeMigrationDiscover({ migration_id: "compat-body-secret", source_root: legacy, offline: true });
    assert.equal(((bodySecret.migration as JsonObject).entries as JsonObject[]).find((item) => String(item.rel_path).endsWith("body-secret.md"))?.reason, "sensitive_or_disallowed");
    const imported = await service.legacyKnowledgeMigrationCandidateImport({ migration_id: "compat", candidate_ids: ["data/pages/facts/working.md"], offline: true });
    const candidate = (imported.candidates as JsonObject[])[0]!;
    store.save("evidence", String(candidate.evidence_id), { ...store.get("evidence", String(candidate.evidence_id)), confidence: "bounded" });
    service.knowledgeCandidateReview({ candidate_id: candidate.id, status: "reviewed", reviewer: "reviewer", reason: "checked" });
    await assert.rejects(Promise.resolve().then(() => service.legacyKnowledgeMigrationPublish({ candidate_id: candidate.id })), /reviewer/);
    const originalWikiSave = service.wikiPageSave;
    service.wikiPageSave = (async () => { throw "publish string failure"; }) as typeof service.wikiPageSave;
    await assert.rejects(service.legacyKnowledgeMigrationPublish({ candidate_id: candidate.id, reviewer: "reviewer" }), /publish string failure/);
    service.wikiPageSave = originalWikiSave;
    const published = await service.legacyKnowledgeMigrationPublish({ candidate_id: candidate.id, reviewer: "reviewer" });
    assert.equal((published.candidate as JsonObject).status, "published");
    assert.equal(store.get("memory_ledger", String((published.candidate as JsonObject).memory_id)).kind, "working");
    const originalClaimReview = service.knowledgeClaimReview;
    service.knowledgeClaimReview = (() => { throw "retract string failure"; }) as typeof service.knowledgeClaimReview;
    await assert.rejects(service.legacyKnowledgeMigrationRetract({ candidate_id: candidate.id, reviewer: "reviewer", reason: "withdrawn" }), /retract string failure/);
    service.knowledgeClaimReview = originalClaimReview;
    await assert.rejects(service.legacyKnowledgeMigrationRetract({ candidate_id: candidate.id, reviewer: "reviewer" }), /reviewer and reason/);
    await assert.rejects(service.legacyKnowledgeMigrationRetract({ candidate_id: candidate.id, reviewer: "", reason: "withdrawn" }), /reviewer and reason/);
    await assert.rejects(service.legacyKnowledgeMigrationRetract({ candidate_id: candidate.id, reviewer: null, reason: "withdrawn" }), /reviewer and reason/);
    await service.legacyKnowledgeMigrationRetract({ candidate_id: candidate.id, reviewer: "reviewer", reason: "withdrawn" });
    assert.equal((discovered.migration as JsonObject).id, "compat");
    const direct = new LegacyKnowledgeMigrationKernel(store);
    await direct.discover({ migration_id: "compat-failure", source_root: legacy });
    const failedImport = await direct.importCandidates({ migration_id: "compat-failure", candidate_ids: ["data/pages/facts/working.md"] }, "source", () => { throw "candidate import string failure"; });
    assert.equal((failedImport.failures as JsonObject[]).length, 1);
    await direct.discover({ migration_id: "compat-error-failure", source_root: legacy });
    const failedErrorImport = await direct.importCandidates({ migration_id: "compat-error-failure", candidate_ids: ["data/pages/facts/working.md"] }, "source", () => { throw new Error("candidate import error failure"); });
    assert.equal((failedErrorImport.failures as JsonObject[])[0]?.code, "candidate import error failure");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); }
});

test("legacy migration discovery and import cover metadata, drift and failure branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-edge-"));
  const legacy = await mkdtemp(join(tmpdir(), "legacy-edge-"));
  const pages = join(legacy, "data", "pages", "workflows"); await mkdir(pages, { recursive: true });
  const valid = (title: string) => `---\ntitle: ${title}\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: tests/x\nreuse_reason: reusable rule\n---\n# ${title}\n`;
  await writeFile(join(pages, "valid.md"), valid("Valid"));
  await writeFile(join(pages, "derived.md"), `---\ntitle: Derived\nstatus: confirmed\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: tests/x\nreuse_reason: reusable\n---\n# Derived\n`);
  await writeFile(join(pages, "plain.md"), "plain body");
  await writeFile(join(pages, "unsupported.md"), "---\nstatus: confirmed\ncategory: unknown\nknowledge_type: unknown\nevidence_type: test\nevidence_ref: x\nreuse_reason: reusable\n---\n");
  await writeFile(join(pages, "missing-evidence.md"), "---\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\n---\n");
  await writeFile(join(pages, "forbidden.md"), "---\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: x\nreuse_reason: 会议纪要\n---\n");
  await writeFile(join(pages, "large.md"), "x".repeat(256 * 1024 + 1));
  const store = await new CraftStore(craftPaths(root)).open(); const kernel = new LegacyKnowledgeMigrationKernel(store);
  try {
    const discovered = await kernel.discover({ migration_id: "edge-discovery", source_root: legacy });
    const generated = await kernel.discover({ source_root: legacy });
    assert.match(String((generated.migration as JsonObject).id), /^legacy_knowledge_migration_/);
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
    await assert.rejects(kernel.importCandidates({ migration_id: "edge-import", candidate_ids: "bad" }, "source", () => ({ evidence_id: "e", claim_id: "c" })), /non-empty/);
    assert.equal(kernel.recordFailure("edge-import", "import", "x", "token=secret-value").startsWith("legacy_knowledge_migration_report_"), true);
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
    const tampered = await kernel.discover({ migration_id: "tampered", source_root: legacy });
    const tamperedMigration = tampered.migration as JsonObject;
    const tamperedEntries = (tamperedMigration.entries as JsonObject[]).map((item) => item.rel_path === "data/pages/workflows/valid.md" ? { ...item, rel_path: "data/pages/workflows/does-not-exist.md", eligibility: "eligible" } : item);
    store.save("legacy_knowledge_migration", "tampered", { ...tamperedMigration, entries: tamperedEntries });
    const unavailable = await kernel.importCandidates({ migration_id: "tampered", candidate_ids: ["data/pages/workflows/does-not-exist.md"] }, "source", () => ({ evidence_id: "e", claim_id: "c" }));
    assert.equal((unavailable.failures as JsonObject[])[0]?.code, "source_unavailable");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); }
});

test("legacy discovery rejects unclosed frontmatter without reading a second source", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-malformed-")); const legacy = await mkdtemp(join(tmpdir(), "legacy-malformed-"));
  const pages = join(legacy, "data", "pages"); await mkdir(pages, { recursive: true }); await writeFile(join(pages, "broken.md"), "---\ntitle: broken\nstatus: confirmed\n");
  const store = await new CraftStore(craftPaths(root)).open();
  try { await assert.rejects(new LegacyKnowledgeMigrationKernel(store).discover({ source_root: legacy }), /frontmatter is not closed/); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); }
});

test("legacy discovery enforces the bounded source file count", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-file-limit-")); const legacy = await mkdtemp(join(tmpdir(), "legacy-file-limit-"));
  const pages = join(legacy, "data", "pages"); await mkdir(pages, { recursive: true });
  await Promise.all(Array.from({ length: 10_001 }, (_, index) => writeFile(join(pages, `page-${index}.md`), "plain")));
  const store = await new CraftStore(craftPaths(root)).open();
  try { await assert.rejects(new LegacyKnowledgeMigrationKernel(store).discover({ source_root: legacy }), /file limit/); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); }
});

test("legacy migration handles duplicate candidates, symlinks, tombstone additions and source locator defenses", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-defenses-")); const legacy = await mkdtemp(join(tmpdir(), "legacy-defenses-"));
  const pages = join(legacy, "data", "pages", "workflows"); await mkdir(pages, { recursive: true });
  const body = `---\ntitle: Same\nstatus: confirmed\ncategory: workflows\nknowledge_type: workflow\nevidence_type: test\nevidence_ref: x\nreuse_reason: reusable\n---\n# Same\n`;
  await writeFile(join(pages, "one.md"), body); await writeFile(join(pages, "two.txt"), "ignored"); await mkdir(join(pages, "nested"), { recursive: true });
  try { await symlink(join(pages, "one.md"), join(pages, "link.md")); } catch { /* platform without symlink support */ }
  const store = await new CraftStore(craftPaths(root)).open(); const kernel = new LegacyKnowledgeMigrationKernel(store);
  try {
    const first = await kernel.discover({ migration_id: "first", source_root: legacy });
    const entry = ((first.migration as JsonObject).entries as JsonObject[]).find((x) => String(x.rel_path).endsWith("one.md"))!;
    const imported = await kernel.importCandidates({ migration_id: "first", candidate_ids: [String(entry.rel_path)] }, "source", () => ({ evidence_id: "e", claim_id: "c" }));
    const second = await kernel.discover({ migration_id: "second", source_root: legacy });
    const secondEntry = ((second.migration as JsonObject).entries as JsonObject[]).find((x) => String(x.rel_path).endsWith("one.md"))!;
    const duplicate = await kernel.importCandidates({ migration_id: "second", candidate_ids: [String(secondEntry.rel_path)] }, "source", () => ({ evidence_id: "e2", claim_id: "c2" }));
    assert.equal((duplicate.candidates as JsonObject[])[0]?.status, "duplicate"); assert.equal((imported.candidates as JsonObject[])[0]?.status, "candidate");
    await writeFile(join(pages, "new.md"), body);
    const diff = await kernel.sourceDiff({ migration_id: "first", source_root: legacy });
    assert.equal((diff.entries as JsonObject[]).some((x) => String(x.rel_path).endsWith("new.md")), true);
    const changed = store.get("legacy_knowledge_migration", "first");
    const originalEntries = changed.entries as JsonObject[];
    const entries = originalEntries.map((x) => String(x.rel_path).endsWith("one.md") ? { ...x, rel_path: "../escape.md", eligibility: "eligible", reason: null } : x);
    store.save("legacy_knowledge_migration", "first", { ...changed, entries });
    const escaped = await kernel.importCandidates({ migration_id: "first", candidate_ids: ["../escape.md"] }, "source", () => ({ evidence_id: "e", claim_id: "c" }));
    assert.equal((escaped.failures as JsonObject[])[0]?.code, "invalid_source_locator");
    const dirEntries = originalEntries.map((x) => String(x.rel_path).endsWith("one.md") ? { ...x, rel_path: "data/pages/nested", eligibility: "eligible" } : x);
    store.save("legacy_knowledge_migration", "first", { ...changed, entries: dirEntries });
    const unavailable = await kernel.importCandidates({ migration_id: "first", candidate_ids: ["data/pages/nested"] }, "source", () => ({ evidence_id: "e", claim_id: "c" }));
    assert.equal((unavailable.failures as JsonObject[])[0]?.code, "source_unavailable");
    void second;
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); }
});

test("legacy discovery and import fail closed on escaped roots, stale identities and non-candidate states", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-legacy-extra-")); const legacy = await mkdtemp(join(tmpdir(), "legacy-extra-")); const outside = await mkdtemp(join(tmpdir(), "legacy-outside-"));
  const pages = join(legacy, "data", "pages"); await mkdir(pages, { recursive: true }); await writeFile(join(outside, "outside.md"), eligible);
  try { await symlink(outside, join(pages, "escape")); } catch { /* symlink unsupported */ }
  await writeFile(join(pages, "secret.md"), sensitive);
  const store = await new CraftStore(craftPaths(root)).open(); const kernel = new LegacyKnowledgeMigrationKernel(store);
  try {
    void fileExists;
    const migration = await kernel.discover({ migration_id: "extra", source_root: legacy });
    const saved = migration.migration as JsonObject;
    store.save("legacy_knowledge_migration", "extra", { ...saved, identity_digest: "sha256:changed" });
    await assert.rejects(kernel.discover({ migration_id: "extra", source_root: legacy }), /idempotency conflict/);
    const entries = (saved.entries as JsonObject[]).map((x) => String(x.rel_path).endsWith("secret.md") ? { ...x, eligibility: "excluded", reason: null } : x);
    store.save("legacy_knowledge_migration", "extra", { ...saved, entries });
    const excluded = await kernel.importCandidates({ migration_id: "extra", candidate_ids: ["data/pages/secret.md"] }, "source", () => ({ evidence_id: "e", claim_id: "c" }));
    assert.equal((excluded.failures as JsonObject[])[0]?.code, "excluded_policy");
    const fake = store.create("legacy_knowledge_migration_candidate", "fake", { status: "duplicate" });
    assert.throws(() => kernel.publishReady({ candidate_id: fake.id }), /non-duplicate/);
    assert.throws(() => kernel.retractReady({ candidate_id: fake.id }), /published/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(legacy, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

async function fileExists(path: string): Promise<boolean> { try { await import("node:fs/promises").then((fs) => fs.lstat(path)); return true; } catch { return false; } }
