import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { ScopeIdentityKernel } from "../core/scope-identity.ts";
import { KnowledgeClaimGovernance } from "../../craft-capability/capability/craft-knowledge/claim-governance.ts";
import { KnowledgeAutoReviewKernel } from "../../craft-capability/capability/craft-knowledge/knowledge-auto-review.ts";
import { KnowledgeSourceRegistry } from "../../craft-capability/capability/craft-knowledge/knowledge-source-registry.ts";
import { projectRootForKnowledgeSource } from "../../craft-capability/capability/craft-knowledge/project-knowledge-content.ts";
import { stableDigest } from "../core/digest.ts";
import { scopeEnvelope } from "craft-common-base/scope-policy";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-knowledge-source-governance-"));
  const projectRoot = join(root, "project"); mkdirSync(projectRoot);
  execFileSync("git", ["-C", projectRoot, "init", "-q"]);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const identity = new ScopeIdentityKernel(store).resolveProject({ project_root: projectRoot }).identity as JsonObject;
  const claims = new KnowledgeClaimGovernance(store);
  const sources = new KnowledgeSourceRegistry(store);
  const autoReview = new KnowledgeAutoReviewKernel(store);
  const scope = identity.canonical_scope as JsonObject;
  const write = (path: string, body: string) => {
    const full = join(projectRoot, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, body);
  };
  return { root, projectRoot, store, claims, sources, autoReview, scope, write,
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("project Knowledge discovery ingests only allowlisted engineering sources", async () => {
  const f = await fixture();
  try {
    f.write("package.json", JSON.stringify({ scripts: { test: "pnpm test" }, dependencies: { typescript: "5.8.0" } }));
    f.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    f.write("jsconfig.json", JSON.stringify({ compilerOptions: { checkJs: true } }));
    f.write("docs/architecture/overview.md", "# Architecture\nThe service layer owns the runtime boundary.\n");
    f.write("docs/development/testing.md", "# Development\nRun the focused test before the suite.\n");
    f.write(".github/workflows/check.yml", "name: checks\non: [push]\n");
    f.write(".env", "API_KEY=must-not-be-read\n");
    f.write("notes/private.md", "Not an automatically discovered Knowledge source.\n");
    f.write("docs/architecture/leaked.md", "Must be excluded through a symlink.\n");
    const outside = join(f.root, "outside.md"); writeFileSync(outside, "External document must not cross the source root.\n");
    rmSync(join(f.projectRoot, "docs/architecture/leaked.md"));
    symlinkSync(outside, join(f.projectRoot, "docs/architecture/leaked.md"));
    mkdirSync(join(f.projectRoot, "tsconfig.json"));

    const result = f.sources.discoverProjectSources({ project_root: f.projectRoot,
      scope_kind: "project", scope_id: f.scope.id });
    assert.equal(result.status, "ready");
    const sources = f.store.list("knowledge_source", 100, item =>
      (item.scope as JsonObject | undefined)?.kind === "project" && (item.scope as JsonObject).id === f.scope.id);
    const locators = new Set(sources.map(item => item.locator));
    for (const path of ["package.json", "pnpm-lock.yaml", "jsconfig.json", "docs/architecture", "docs/development", ".github/workflows"]) {
      assert(locators.has(realpathSync(join(f.projectRoot, path))), `${path} should be a registered source`);
    }
    assert(![...locators].some(path => String(path).endsWith("/.env") || String(path).endsWith("/notes/private.md")));
    assert(sources.every(source => source.trust === "bounded" && source.access === "read_only"));
    const candidates = f.store.list("knowledge_ingest_candidate", 100);
    assert(candidates.length >= 6);
    assert(!locators.has(realpathSync(join(f.projectRoot, "tsconfig.json"))), "a directory at a file-only source path must be skipped");
    assert(candidates.every(candidate => candidate.status === "candidate" && candidate.publication_allowed === false
      && candidate.scope === `project:${f.scope.id}`));
    assert(!f.store.list("knowledge_document", 100, item => typeof item.source_id === "string" && String(f.store.get("knowledge_source", item.source_id).locator).endsWith("leaked.md")).length,
      "directory ingestion must not follow a symlink outside its registered root");
    const repeated = f.sources.discoverProjectSources({ project_root: f.projectRoot, scope_kind: "project", scope_id: f.scope.id });
    assert.equal(repeated.sources_registered, 0);
  } finally { f.close(); }
});

test("project directory sources are disabled when missing and safely reactivated when restored", async () => {
  const f = await fixture();
  try {
    f.write("docs/architecture/overview.md", "# Architecture\nBounded architecture source.\n");
    const first = f.sources.discoverProjectSources({ project_root: f.projectRoot, scope_kind: "project", scope_id: f.scope.id });
    const id = (first.source_refs as string[]).find(sourceId => String(f.store.get("knowledge_source", sourceId).locator).endsWith("docs/architecture"))!;
    rmSync(join(f.projectRoot, "docs/architecture"), { recursive: true });
    const missing = f.sources.discoverProjectSources({ project_root: f.projectRoot, scope_kind: "project", scope_id: f.scope.id });
    assert.equal(missing.sources_disabled, 1);
    assert.equal(f.store.get("knowledge_source", id).status, "disabled");
    const staleClaims = f.store.list("knowledge_claim", 100, item => item.source_id === id);
    assert(staleClaims.length > 0);
    assert(staleClaims.every(claim => claim.status === "stale" && claim.revalidation_required === true));

    f.write("docs/architecture/overview.md", "# Architecture\nRestored bounded architecture source.\n");
    const restored = f.sources.discoverProjectSources({ project_root: f.projectRoot, scope_kind: "project", scope_id: f.scope.id });
    assert.equal(restored.sources_reactivated, 1);
    assert.equal(f.store.get("knowledge_source", id).status, "active");
  } finally { f.close(); }
});

test("discovered project source descriptors migrate once to an explicit canonical project root", async () => {
  const f = await fixture();
  try {
    f.write("README.md", "# Project source\nA root-level source.\n");
    const source = { source_id: "project_autodiscovered_legacy", kind: "readme", label: "Project README",
      scope_kind: "project", scope_id: f.scope.id, locator: realpathSync(join(f.projectRoot, "README.md")),
      content_digest: "stable-project-source", trust: "bounded", access: "read_only" };
    f.sources.sourceRegister(source);
    const migrated = f.sources.sourceRegister({ ...source, project_root: realpathSync(f.projectRoot) });
    assert.equal(migrated.migrated_project_root, true);
    assert.equal((migrated.source as JsonObject).project_root, realpathSync(f.projectRoot));
    assert.equal(f.sources.sourceRegister({ ...source, project_root: realpathSync(f.projectRoot) }).idempotent, true);
  } finally { f.close(); }
});

test("Knowledge project-root bindings reject escaping locators and preserve legacy file-root inference", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside.md"); writeFileSync(outside, "outside");
    assert.equal(projectRootForKnowledgeSource({ project_root: f.projectRoot, locator: outside }), null);
    assert.equal(projectRootForKnowledgeSource({ kind: "project_note", locator: join(f.projectRoot, "AGENTS.md") }), null);
    f.write("AGENTS.md", "# Project instructions\n");
    assert.equal(projectRootForKnowledgeSource({ kind: "project_note", locator: join(f.projectRoot, "AGENTS.md") }), f.projectRoot);
    assert.throws(() => f.sources.sourceRegister({ source_id: "outside-locator", kind: "project_note", label: "Outside",
      scope_kind: "project", scope_id: f.scope.id, project_root: f.projectRoot, locator: outside, content_digest: "outside", trust: "bounded" }), /project_root must contain/u);
    assert.throws(() => f.sources.sourceRegister({ source_id: "global-project-root", kind: "custom", label: "Invalid root",
      scope_kind: "global", scope_id: "global", project_root: f.projectRoot, locator: outside, content_digest: "outside", trust: "verified" }), /requires project scope/u);
  } finally { f.close(); }
});

test("source revision drift stales existing project Knowledge candidates", async () => {
  const f = await fixture();
  try {
    f.write("README.md", "# Project\nUse the focused test before the full suite.\n");
    const result = f.sources.discoverProjectSources({ project_root: f.projectRoot,
      scope_kind: "project", scope_id: f.scope.id });
    const sourceId = (result.source_refs as string[]).find(id => f.store.get("knowledge_source", id).kind === "readme")!;
    const claims = f.store.list("knowledge_claim", 100, item => item.source_id === sourceId);
    assert(claims.length > 0);
    assert(claims.every(claim => claim.status === "candidate"));

    f.write("README.md", "# Project\nUse the focused test and verify the changed branch.\n");
    f.sources.sourceIngest({ source_id: sourceId });

    const stale = claims.map(claim => f.store.get("knowledge_claim", String(claim.id)));
    assert(stale.some(claim => claim.status === "stale"));
    assert(stale.filter(claim => claim.status === "stale").every(claim => claim.revalidation_required === true));
    const currentClaims = f.store.list("knowledge_claim", 100, item => item.source_id === sourceId && item.status === "candidate");
    assert(currentClaims.length > 0);
    rmSync(join(f.projectRoot, "README.md"));
    f.sources.sourceIngest({ source_id: sourceId });
    assert(currentClaims.every(claim => f.store.get("knowledge_claim", String(claim.id)).status === "stale"),
      JSON.stringify(currentClaims.map(claim => ({ id: claim.id, document_id: claim.document_id,
        source_revision_id: claim.source_revision_id, after: f.store.get("knowledge_claim", String(claim.id)).status }))));
  } finally { f.close(); }
});

test("a project source cannot be used to create a global Knowledge claim", async () => {
  const f = await fixture();
  try {
    f.sources.sourceRegister({ source_id: "project-only", kind: "project_note", label: "Project source",
      trust: "verified", scope_kind: "project", scope_id: f.scope.id, locator: "README.md", content_digest: "project-source" });
    f.store.create("evidence", "project-evidence", { scope: "project:demo", source_type: "observation", claim: "Project evidence", confidence: "confirmed" });
    assert.throws(() => f.claims.knowledgeClaimSave({ kind: "fact", content: "Project-specific rule", scope: "global",
      source_id: "project-only", evidence_ids: ["project-evidence"] }), /Project Knowledge Source cannot create a global Claim/u);
  } finally { f.close(); }
});

test("global Knowledge promotion needs a Runtime-pinned source identity and still needs evaluation", async () => {
  const previous = process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES;
  const f = await fixture();
  try {
    const scope = { kind: "global", id: "global" };
    const identityDigest = stableDigest({ kind: "custom", label: "Organization standard", scope,
      scope_envelope: scopeEnvelope(undefined, scope), locator: "org://engineering/standard", content_digest: "org-standard-v1", trust: "verified", access: "read_only" });
    delete process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES;
    assert.throws(() => f.sources.sourceRegister({ source_id: "organization-standard", kind: "custom", label: "Organization standard",
      trust: "verified", scope_kind: "global", scope_id: "global", locator: "org://engineering/standard", content_digest: "org-standard-v1" }), /Runtime-pinned source identity allowlist/u);
    process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES = JSON.stringify([{ id: "organization-standard", identity_digest: identityDigest }]);
    const source = f.sources.sourceRegister({ source_id: "organization-standard", kind: "custom", label: "Organization standard",
      trust: "verified", scope_kind: "global", scope_id: "global", locator: "org://engineering/standard", content_digest: "org-standard-v1" }).source as JsonObject;
    f.store.create("evidence", "organization-evidence", { scope: "global", source_type: "organization_standard", source_id: source.id,
      claim: "Organization standard evidence", confidence: "confirmed" });
    const claim = f.claims.knowledgeClaimSave({ kind: "rule", content: "Use the approved test workflow.", scope: "global",
      source_id: source.id, evidence_ids: ["organization-evidence"] }).claim as JsonObject;

    delete process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES;
    const blocked = (f.autoReview.assess({ scope_kind: "global", scope_id: "global", claim_ids: [claim.id], auto_promote: false })
      .assessments as JsonObject[])[0]!;
    assert((blocked.reasons as string[]).includes("global_source_not_in_trusted_allowlist"));
    assert.equal(blocked.promoted, false);

    process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES = String(source.id);
    const idOnly = (f.autoReview.assess({ scope_kind: "global", scope_id: "global", claim_ids: [claim.id], auto_promote: false })
      .assessments as JsonObject[])[0]!;
    assert((idOnly.reasons as string[]).includes("global_source_not_in_trusted_allowlist"), "an ID alone is not a trust proof");

    for (const invalidRegistry of ["{}", JSON.stringify([
      { id: source.id, identity_digest: source.identity_digest }, { id: source.id, identity_digest: source.identity_digest },
    ])]) {
      process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES = invalidRegistry;
      const invalid = (f.autoReview.assess({ scope_kind: "global", scope_id: "global", claim_ids: [claim.id], auto_promote: false })
        .assessments as JsonObject[])[0]!;
      assert((invalid.reasons as string[]).includes("global_source_not_in_trusted_allowlist"));
    }

    process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES = JSON.stringify([{ id: source.id, identity_digest: source.identity_digest }]);
    const admitted = (f.autoReview.assess({ scope_kind: "global", scope_id: "global", claim_ids: [claim.id], auto_promote: false })
      .assessments as JsonObject[])[0]!;
    assert(!(admitted.reasons as string[]).includes("global_source_not_in_trusted_allowlist"));
    assert((admitted.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
    assert.equal(admitted.promoted, false);

    const mismatchedSource = f.sources.sourceRegister({ source_id: "organization-unverified", kind: "custom", label: "Unverified organization source",
      trust: "bounded", scope_kind: "global", scope_id: "global", locator: "org://engineering/unverified", content_digest: "org-unverified-v1" }).source as JsonObject;
    f.store.create("evidence", "organization-unverified-evidence", { scope: "global", source_type: "organization_standard", source_id: mismatchedSource.id,
      claim: "Unverified source evidence", confidence: "confirmed" });
    const unverifiedClaim = f.claims.knowledgeClaimSave({ kind: "rule", content: "Another workflow rule.", scope: "global",
      source_id: mismatchedSource.id, evidence_ids: ["organization-unverified-evidence"] }).claim as JsonObject;
    process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES = JSON.stringify([{ id: mismatchedSource.id, identity_digest: mismatchedSource.identity_digest }]);
    const unverified = (f.autoReview.assess({ scope_kind: "global", scope_id: "global", claim_ids: [unverifiedClaim.id], auto_promote: false })
      .assessments as JsonObject[])[0]!;
    assert((unverified.reasons as string[]).includes("global_source_must_be_verified"));
    assert.equal(unverified.promoted, false);

    f.store.save("knowledge_source", String(source.id), { ...source, identity_digest: `sha256:${"0".repeat(64)}` });
    const spoofed = (f.autoReview.assess({ scope_kind: "global", scope_id: "global", claim_ids: [claim.id], auto_promote: false })
      .assessments as JsonObject[])[0]!;
    assert((spoofed.reasons as string[]).includes("global_source_not_in_trusted_allowlist"), "the exact Runtime-pinned identity must remain unchanged");
  } finally {
    if (previous === undefined) delete process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES;
    else process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES = previous;
    f.close();
  }
});
