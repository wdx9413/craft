import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { productSurfaceOf } from "../core/interfaces/mcp/product-launch.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { CognitiveSearchCoordinator } from "../core/application/coordinators/cognitive-search.ts";
import { stableDigest } from "../core/digest.ts";
import { projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";
import { attachVerifiedPromotionFixture } from "./helpers/knowledge-promotion-proof.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-memory-operability-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  const result = { root, store, service };
  await bindProject(result, "p");
  return result;
}

async function bindProject(f: { root: string; service: CraftService }, scopeId: string): Promise<string> {
  const projectRoot = join(f.root, "projects", scopeId);
  await mkdir(projectRoot, { recursive: true });
  f.service.scopeAliasBind({ scope_kind: "project", scope_id: `project:${scopeId}`, alias_kind: "path", alias: projectRoot });
  return projectRoot;
}

async function close(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

function sourceAndEvidence(service: CraftService): JsonObject {
  service.knowledgeSourceRegister({ source_id: "notes", kind: "project_note", label: "Notes", trust: "verified",
    scope_kind: "project", scope_id: "p", locator: "notes.md", content_digest: "sha256:" + "a".repeat(64) });
  return service.evidenceRecord({ claim: "Observed in fixture", source_type: "observation", confidence: "confirmed",
    metadata: { source_session_id: "knowledge-operability-session-one", task_id: "knowledge-operability-task-one" } });
}

test("reviewed knowledge contributes to a scoped Context receipt while candidates remain diagnostic only", async () => {
  const f = await fixture();
  try {
    const evidence = sourceAndEvidence(f.service);
    const reviewed = f.service.knowledgeClaimSave({ claim_id: "reviewed-routing", kind: "fact", content: "Use focused tests before a full suite.",
      scope: "project:p", source_id: "notes", evidence_ids: [evidence.id] }).claim as JsonObject;
    attachVerifiedPromotionFixture(f.store, reviewed);
    const classified = f.service.knowledgeClaimSave({ claim_id: "reviewed-routing", kind: "fact", content: "Use focused tests before a full suite.",
      scope: "project:p", source_id: "notes", evidence_ids: [evidence.id], scenario_key: "testing.focused-suite" }).claim as JsonObject;
    assert.equal(classified.status, "reviewed", "adding scenario metadata must preserve the independent review decision");
    assert.equal(classified.scenario_key, "testing.focused-suite");
    f.service.knowledgeClaimSave({ claim_id: "draft-routing", kind: "fact", content: "Use experimental tests only.",
      scope: "project:p", source_id: "notes", evidence_ids: [evidence.id] });

    const resolved = await f.service.contextResolutionResolve({ query: "focused tests", scope_kind: "project", scope_id: "p", receipt_id: "ctx" });
    const knowledge = ((resolved.contributions as JsonObject[]).find((item) => item.member === "knowledge") as JsonObject).items as JsonObject[];
    assert.equal(knowledge.length, 1);
    assert.equal(knowledge[0]!.claim_id, "reviewed-routing");
    assert.match(String(knowledge[0]!.content), /focused tests/u);

    const search = f.service.knowledgeSearch({ query: "experimental", scope: "project:p" });
    const hit = (search.hits as JsonObject[])[0]!;
    assert.equal(hit.claim_id, "draft-routing");
    assert.equal(hit.status, "candidate");
    assert.equal(search.queried_governed_claims, true);

    // Review alone is not authority: a revoked/untrusted source must disappear from
    // execution Context while remaining visible to a human diagnostic search.
    f.service.knowledgeSourceTransition({ source_id: "notes", status: "revoked", reason: "fixture trust revoked" });
    const blocked = await f.service.contextResolutionResolve({ query: "focused tests", scope_kind: "project", scope_id: "p", receipt_id: "ctx-blocked" });
    const blockedKnowledge = ((blocked.contributions as JsonObject[]).find((item) => item.member === "knowledge") as JsonObject).items as JsonObject[];
    assert.deepEqual(blockedKnowledge, []);
    assert.equal((f.service.knowledgeSearch({ query: "focused", scope: "project:p" }).hits as JsonObject[])[0]!.claim_id, "reviewed-routing");
  } finally { await close(f); }
});

test("Knowledge coordinator handles missing scope and keeps scenario administration explicit", async (t) => {
  const f = await fixture();
  try {
    assert.equal((f.service.knowledgeSearch({ query: "nothing" }).hits as JsonObject[]).length, 0);
    assert.equal((f.service.knowledgeSearch({ query: "nothing", scope_kind: "project", scope_id: "p" }).hits as JsonObject[]).length, 0);
    assert.throws(() => f.service.knowledgeSearch({ query: "nothing", scenario_key: "testing.focused" }), /explicit Knowledge scope/);
    assert.throws(() => f.service.knowledgeSearch({ query: "nothing", scope: "project:p", scenario_key: "Invalid Key" }), /bounded stable identifier/);
    assert.equal((f.service.knowledgeSearch({ query: "nothing", scope: "tenant:other", scenario_key: "testing.focused" }).scenario_filter as JsonObject).status,
      "inactive_or_unclassified");

    assert.equal(f.service.knowledgeScenarioList({ scope: "global" }).scope, "global");
    assert.equal(f.service.knowledgeScenarioList({ scope: "project:p", project_root: join(f.root, "projects", "p") }).scope, "project:p");
    assert.throws(() => f.service.knowledgeScenarioList({ scope: "tenant:other" }), /explicit project or global scope/);
    assert.throws(() => f.service.knowledgeScenarioRetire({ scope: "tenant:other" }), /explicit project or global scope/);
    assert.throws(() => f.service.knowledgeScenarioRetire({ scope: "global", scenario_key: "missing.scene", expected_catalog_version: 0,
      request_id: "missing-retire", reason: "not present" }));
    assert.throws(() => f.service.knowledgeScenarioMigrationPropose({ scope: "tenant:other", source_keys: [], targets: [] }), /explicit project or global scope/);
    assert.throws(() => f.service.knowledgeScenarioMigrationPropose({ scope: "global", source_keys: "bad", targets: [] }), /must be arrays/);
    assert.throws(() => f.service.knowledgeScenarioMigrationPropose({ scope: "global", mode: "merge", source_keys: [], targets: [],
      expected_catalog_version: 0, request_id: "empty-migration", reason: "no source scenarios" }));
    assert.throws(() => f.service.knowledgeScenarioRetire({ scope: "project:p", project_root: join(f.root, "projects", "p"),
      scenario_key: "missing.scene", expected_catalog_version: 0, request_id: "missing-project-retire", reason: "not present" }));
    assert.throws(() => f.service.knowledgeScenarioMigrationPropose({ scope: "project:p", project_root: join(f.root, "projects", "p"),
      mode: "merge", source_keys: [], targets: [], expected_catalog_version: 0, request_id: "empty-project-migration", reason: "no source scenarios" }));
    assert.throws(() => f.service.knowledgeScenarioRetire({ scope_kind: "global", scope_id: "global", scenario_key: "missing.fallback",
      expected_catalog_version: 0, request_id: "fallback-retire", reason: "not present" }));
    assert.throws(() => f.service.knowledgeScenarioMigrationPropose({ scope_kind: "global", scope_id: "global", mode: "merge",
      source_keys: [], targets: [], expected_catalog_version: 0, request_id: "fallback-migration", reason: "no source scenarios" }));
    assert.deepEqual((f.service.knowledgeSearch({ query: "nothing", scope: "project:p", project_root: join(f.root, "projects", "p"),
      scenario_key: "testing.focused" }).hits as JsonObject[]), []);
    const originalList = f.store.list.bind(f.store);
    t.mock.method(f.store, "list", (kind: string, limit = 20, predicate?: (record: JsonObject) => boolean,
      hydrate = true, dependencies?: { source_ids: string[]; document_ids: string[] }) => kind === "knowledge_claim"
      ? [
        { id: "corrupt-scope", status: "candidate", scope: "malformed", scenario_key: "testing.focused", content: "nothing" },
        { id: "legacy-missing-scope", status: "candidate", scenario_key: "testing.focused", content: "nothing" },
      ]
      : originalList(kind, limit, predicate, hydrate, dependencies));
    assert.deepEqual((f.service.knowledgeSearch({ query: "nothing", scope: "global", scenario_key: "testing.focused" }).hits as JsonObject[]), []);
    assert.deepEqual((await f.service.memorySearch({ query: "nothing", scope_kind: "project", scope_id: "p" })).memories, []);
    const isolated = new CognitiveSearchCoordinator(f.store,
      { resolve: async () => ({ items: undefined, receipt: null }) } as never,
      { neighbors: () => ({ relations: [] }) } as never);
    assert.deepEqual(await isolated.memorySearch({ query: "x", scope_kind: "project", scope_id: "p" }), {
      memories: [], count: 0, omitted_count: 0, receipt_id: null, content_free_receipt: true,
    });
  } finally { await close(f); }
});

test("diagnostic Knowledge search filters claim scope, sensitivity, expiry and content references", async () => {
  const f = await fixture();
  try {
    await bindProject(f, "other");
    const claim = (id: string, extra: JsonObject = {}) => f.store.create("knowledge_claim", id, {
      id, version: 1, kind: "fact", status: "candidate", scope: "global", content: "alpha migration rule",
      tags: ["alpha"], sensitivity: "internal", evidence_ids: [], ...extra,
    });
    claim("search-public");
    claim("search-restricted", { sensitivity: "restricted" });
    claim("search-other-scope", { scope: "project:other" });
    claim("search-invalid-status", { status: "retired" });
    claim("search-expired", { valid_until: "2000-01-01T00:00:00Z" });
    claim("search-malformed-expiry", { valid_until: "not-a-date" });
    claim("search-not-expiring", { valid_until: null });
    claim("search-string-tags", { content: "beta body", tags: "alpha tag" });
    claim("search-empty-content", { content: undefined, tags: ["alpha"] });
    const source = f.service.knowledgeSourceRegister({ source_id: "diagnostic-global-source", kind: "project_note", label: "Diagnostic source",
      trust: "verified", scope_kind: "global", scope_id: "global", locator: "diagnostic.md", content_digest: `sha256:${"f".repeat(64)}` });
    const evidence = f.service.evidenceRecord({ claim: "Independent diagnostic search evidence", source_type: "observation", confidence: "confirmed" });
    let reviewed = f.service.knowledgeClaimSave({ claim_id: "search-reviewed", kind: "fact", content: "alpha reviewed rule", scope: "global",
      source_id: source.id, evidence_ids: [evidence.id] }).claim as JsonObject;
    attachVerifiedPromotionFixture(f.store, reviewed);
    reviewed = f.service.knowledgeClaimSave({ claim_id: "search-reviewed", kind: "fact", content: "alpha reviewed rule", scope: "global",
      source_id: source.id, evidence_ids: [evidence.id] }).claim as JsonObject;
    claim("search-unproven-reviewed", { status: "reviewed", content: "alpha old reviewed label" });
    const contentRef = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "search-body", version: 1,
      scope: "global", status: "candidate", sensitivity: "internal", source_id: "diagnostic-test", body: "alpha body reference" });
    claim("search-content-ref", { content: undefined, content_ref: contentRef });
    claim("search-object-scope-ref", { scope: { kind: "global", id: "global" }, content: undefined, content_ref: contentRef });
    assert.deepEqual((f.service.knowledgeSearch({ query: "alpha", scope: "global" }).hits as JsonObject[]).map(hit => hit.claim_id),
      ["search-content-ref", "search-empty-content", "search-not-expiring", "search-public", "search-reviewed", "search-unproven-reviewed"]);
    assert.ok((f.service.knowledgeSearch({ query: "alpha", scope: "global", allow_restricted: true }).hits as JsonObject[])
      .some(hit => hit.claim_id === "search-restricted"));
    assert.ok((f.service.knowledgeSearch({ query: "alpha" }).hits as JsonObject[]).some(hit => hit.claim_id === "search-object-scope-ref"));
    const formalOnly = f.service.knowledgeSearch({ query: "alpha", scope_kind: "global", scope_id: "global", include_candidates: false });
    assert.deepEqual((formalOnly.hits as JsonObject[]).map(hit => hit.claim_id), ["search-reviewed"]);
    assert.equal((formalOnly.hits as JsonObject[])[0]?.status, "reviewed");
    assert.equal((f.service.knowledgeSearch({ query: "alpha", scope: "global", limit: 1 }).hits as JsonObject[]).length, 1);
    assert.equal((f.service.knowledgeSearch({ query: "unmatched", scope: "global" }).hits as JsonObject[]).length, 0);
    assert.equal((f.service.knowledgeSearch({ query: "!!!", scope: "global", scenario_key: "test.scene" }).hits as JsonObject[]).length, 0);
    claim("search-invalid-ref", { content_ref: "not-a-content-reference" });
    assert.throws(() => f.service.knowledgeSearch({ query: "alpha", scope: "global", allow_restricted: true }), /invalid/u);
  } finally { await close(f); }
});

test("reviewed Knowledge classification accepts canonical project identity and writes its catalog under the normalized id", async () => {
  const f = await fixture();
  try {
    const projectRoot = await bindProject(f, "canonical");
    f.service.knowledgeSourceRegister({ source_id: "canonical-notes", kind: "project_note", label: "Canonical project notes", trust: "verified",
      scope_kind: "project", scope_id: "project:canonical", locator: "notes.md", content_digest: `sha256:${"c".repeat(64)}` });
    const evidence = f.service.evidenceRecord({ claim: "Verified canonical project fact", source_type: "observation", confidence: "confirmed" });
    const scope = "project:project:canonical";
    const initial = f.service.knowledgeClaimSave({ claim_id: "canonical-reviewed", kind: "fact", content: "The project uses pnpm.",
      scope, source_id: "canonical-notes", evidence_ids: [evidence.id] }).claim as JsonObject;
    attachVerifiedPromotionFixture(f.store, initial);
    const classified = f.service.knowledgeClaimSave({ claim_id: initial.id, kind: "fact", content: "The project uses pnpm.",
      scope, source_id: "canonical-notes", evidence_ids: [evidence.id], scenario_key: "project.build.tooling" }).claim as JsonObject;
    assert.equal(classified.status, "reviewed");
    assert.equal(classified.scenario_key, "project.build.tooling");
    assert.equal(f.service.knowledgeScenarioList({ scope }).catalog_version, 1);
    const catalog = JSON.parse(await readFile(join(projectStorageDirectory(f.store.paths, projectRoot), "knowledge", "projects", "canonical", "knowledge-scenarios.json"), "utf8")) as JsonObject;
    assert.equal((catalog.scenarios as JsonObject[])[0]?.scenario_key, "project.build.tooling");
  } finally { await close(f); }
});

test("scenario metadata can be added to a reviewed source-ingested Claim without breaking its provenance identity", async t => {
  const f = await fixture();
  try {
    await bindProject(f, "canonical");
    const scope = "project:project:canonical";
    const scopeEnvelope = { applicability: { kind: "project", id: "project:canonical" }, custody: { kind: "project", id: "project:canonical" },
      audience: { mode: "scoped", principal_ids: [] }, purpose: "fact", retention: "long_term", tenant_id: null };
    f.service.knowledgeSourceRegister({ source_id: "ingested-notes", kind: "project_note", label: "Ingested notes", trust: "verified",
      scope_kind: "project", scope_id: "project:canonical", locator: "notes.md", content_digest: `sha256:${"d".repeat(64)}`, scope_envelope: scopeEnvelope });
    f.store.create("knowledge_document", "document-1", { scope, source_id: "ingested-notes", status: "current", content_digest: `sha256:${"e".repeat(64)}` });
    const evidence = f.service.evidenceRecord({ claim: "Retained ingest evidence", source_type: "observation", confidence: "confirmed" });
    const content = "Use pnpm for project scripts.";
    const identity = { source_id: "ingested-notes", source_revision_id: "revision-1", document_id: "document-1", document_digest: `sha256:${"e".repeat(64)}`,
      fragment_id: "fragment-1", scope, scope_envelope: scopeEnvelope, kind: "fact",
      content_digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, evidence_ids: [String(evidence.id)], valid_until: null };
    const contentRef = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "ingested-reviewed", version: 1, scope, status: "candidate",
      sensitivity: "internal", source_id: "ingested-notes", body: content });
    let bodyReads = 0;
    const readContent = f.store.contentStore.readCompatSync.bind(f.store.contentStore);
    t.mock.method(f.store.contentStore, "readCompatSync", function (ref: Parameters<typeof f.store.contentStore.readCompatSync>[0], expectedScope?: string) {
      bodyReads += 1; return readContent(ref, expectedScope);
    });
    f.store.create("knowledge_claim", "ingested-reviewed", { ...identity, scope, identity_digest: stableDigest(identity), status: "candidate", review: null,
      content_ref: contentRef, ingest_generated: true, publication_allowed: false });
    attachVerifiedPromotionFixture(f.store, f.store.get("knowledge_claim", "ingested-reviewed"));
    const classified = f.service.knowledgeClaimSave({ claim_id: "ingested-reviewed", kind: "fact", content, scope, scope_envelope: scopeEnvelope,
      source_id: "ingested-notes", evidence_ids: [String(evidence.id)], scenario_key: "project.scripts.package-manager" }).claim as JsonObject;
    assert.equal(classified.status, "reviewed");
    assert.equal(classified.ingest_generated, true);
    assert.equal(classified.source_revision_id, "revision-1");
    assert.equal(classified.scenario_key, "project.scripts.package-manager");
    const replay = f.service.knowledgeClaimSave({ claim_id: "ingested-reviewed", kind: "fact", content, scope, scope_envelope: scopeEnvelope,
      source_id: "ingested-notes", evidence_ids: [String(evidence.id)], scenario_key: "project.scripts.package-manager" }).claim as JsonObject;
    assert.equal(replay.version, classified.version, "replaying an unchanged scene must not rewrite the Claim");
    assert.throws(() => f.service.knowledgeClaimSave({ claim_id: "ingested-reviewed", kind: "fact", content: "Changed body must not reuse ingest identity.", scope, scope_envelope: scopeEnvelope,
      source_id: "ingested-notes", evidence_ids: [String(evidence.id)], scenario_key: "project.scripts.package-manager" }), /idempotency conflict/u);
    const legacyBody = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "legacy-ingested-object-scope", version: 1, scope, status: "candidate",
      sensitivity: "internal", source_id: "ingested-notes", body: content });
    f.store.create("knowledge_claim", "legacy-ingested-object-scope", { kind: "fact", content_digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      scope: { kind: "project", id: "project:canonical" }, scope_envelope: scopeEnvelope, source_id: "ingested-notes", evidence_ids: [String(evidence.id)], tags: [],
      valid_until: null, status: "candidate", identity_digest: "sha256:legacy", ingest_generated: true, content_ref: legacyBody });
    assert.throws(() => f.service.knowledgeClaimSave({ claim_id: "legacy-ingested-object-scope", kind: "fact", content, scope, scope_envelope: scopeEnvelope,
      source_id: "ingested-notes", evidence_ids: [String(evidence.id)], scenario_key: "project.scripts.package-manager" }), /idempotency conflict/u);
    assert(bodyReads >= 4, "each ingested replay must validate the retained protected body");
  } finally { await close(f); }
});

test("Knowledge scenario writes reject legacy identity drift and unavailable ingested bodies", async () => {
  const f = await fixture();
  try {
    const evidence = sourceAndEvidence(f.service);
    f.store.create("knowledge_claim", "missing-evidence-identity", { kind: "fact", content_digest: "sha256:legacy", scope: "project:p",
      source_id: "notes", status: "candidate", identity_digest: "sha256:legacy" });
    assert.throws(() => f.service.knowledgeClaimSave({ claim_id: "missing-evidence-identity", kind: "fact", content: "Old claim body.",
      scope: "project:p", source_id: "notes", evidence_ids: [String(evidence.id)], scenario_key: "testing.legacy" }), /idempotency conflict/u);

    const scopeEnvelope = { applicability: { kind: "project", id: "p" }, custody: { kind: "project", id: "p" },
      audience: { mode: "scoped", principal_ids: [] }, purpose: "fact", retention: "long_term", tenant_id: null };
    f.store.create("knowledge_claim", "missing-ingest-body", { kind: "fact", content_digest: `sha256:${createHash("sha256").update("Old ingested body.").digest("hex")}`,
      scope: "project:p", scope_envelope: scopeEnvelope, source_id: "notes", evidence_ids: [String(evidence.id)], tags: [], valid_until: null,
      status: "candidate", identity_digest: "sha256:ingest", ingest_generated: true, content_ref: {} });
    assert.throws(() => f.service.knowledgeClaimSave({ claim_id: "missing-ingest-body", kind: "fact", content: "Old ingested body.", scope: "project:p",
      scope_envelope: scopeEnvelope, source_id: "notes", evidence_ids: [String(evidence.id)], scenario_key: "testing.legacy" }), /idempotency conflict/u);
  } finally { await close(f); }
});

test("model classified project Knowledge advances with trusted Source reviews and exits on Source revocation", async () => {
  const f = await fixture();
  try {
    const evidenceA = sourceAndEvidence(f.service);
    f.service.knowledgeSourceRegister({ source_id: "notes-b", kind: "project_note", label: "Independent Notes B", trust: "verified",
      scope_kind: "project", scope_id: "p", locator: "notes-b.md", content_digest: "sha256:" + "b".repeat(64) });
    const evidenceB = f.service.evidenceRecord({ claim: "Independent fixture evidence", source_type: "observation", confidence: "confirmed" });
    const classification = { scenario_key: "engineering.release.checks", coarse_scenario_key: "engineering.release", scope: "project:p",
      scenario_definition: { summary: "发布验证检查", applies_when: "发布前需要运行项目验收集", excludes: "与发布无关的日常开发" },
      coarse_scenario_definition: { summary: "工程发布", applies_when: "变更进入项目发布流程", excludes: "只读咨询" } };
    const initialA = f.service.knowledgeClaimSave({ claim_id: "scenario-claim-a", kind: "rule", content: "Use the release verification set.",
      scope: "project:p", scenario_key: "engineering.release.draft", coarse_scenario_key: "engineering.release", source_id: "notes", evidence_ids: [evidenceA.id] }).claim as JsonObject;
    const corrected = f.service.knowledgeClaimSave({ claim_id: "scenario-claim-a", kind: "rule", content: "Use the release verification set.", ...classification,
      source_id: "notes", evidence_ids: [evidenceA.id] }).claim as JsonObject;
    assert.equal(corrected.version, Number(initialA.version) + 1);
    assert.equal(corrected.scenario_key, classification.scenario_key);
    const taxonomyPath = join(projectStorageDirectory(f.store.paths, join(f.root, "projects", "p")), "knowledge", "projects", "p", "knowledge-scenarios.json");
    const correctedCatalog = JSON.parse(await readFile(taxonomyPath, "utf8")) as JsonObject;
    const retiredName = (correctedCatalog.scenarios as JsonObject[]).find(item => item.scenario_key === "engineering.release.draft")!;
    assert.equal((retiredName.claim_refs as JsonObject[])[0]!.status, "inactive");
    assert.equal((f.service.knowledgeSearch({ query: "release verification", scope: "project:p", scenario_key: "engineering.release.draft" }).hits as JsonObject[]).length, 0);
    const claimA = corrected;
    const candidate = f.service.knowledgeClaimSave({ claim_id: "scenario-claim-b", kind: "rule", content: "Run the release verification set.", ...classification,
      source_id: "notes-b", evidence_ids: [evidenceB.id] });
    assert.equal((candidate.scenario_catalog as JsonObject).status, "candidate");
    assert.equal((f.service.knowledgeClaimList({ scope_kind: "global" }).claims as JsonObject[]).length, 0);

    const firstReview = attachVerifiedPromotionFixture(f.store, claimA);
    assert.equal((firstReview.scenario_catalog as JsonObject).reviewed_source_count, 1);
    const secondReview = attachVerifiedPromotionFixture(f.store, f.store.get("knowledge_claim", "scenario-claim-b"));
    assert.equal((secondReview.scenario_catalog as JsonObject).status, "active");
    const scopedScene = f.service.knowledgeSearch({ query: "release verification", scope: "project:p", scenario_key: "engineering.release.checks" });
    assert.deepEqual((scopedScene.hits as JsonObject[]).map(item => item.claim_id).sort(), ["scenario-claim-a", "scenario-claim-b"]);
    const knowledgeMcp = new McpServer(f.service, "component-knowledge");
    const listed = await knowledgeMcp.handle({ jsonrpc: "2.0", id: "tools", method: "tools/list" });
    const tools = ((listed?.result as JsonObject).tools as JsonObject[]);
    const saveSchema = tools.find(item => item.name === "craft_knowledge_claim_save")!.inputSchema as JsonObject;
    assert(((saveSchema.required as string[] | undefined) ?? []).includes("scope"), "Knowledge writes must declare scope explicitly");
    assert.equal(((saveSchema.properties as JsonObject).scenario_key as JsonObject).type, "string");
    assert.equal(((saveSchema.properties as JsonObject).coarse_scenario_key as JsonObject).type, "string");
    const searchSchema = tools.find(item => item.name === "craft_knowledge_search")!.inputSchema as JsonObject;
    assert.equal(((searchSchema.properties as JsonObject).scenario_key as JsonObject).type, "string");
    assert(tools.some(item => item.name === "craft_knowledge_scenario_list"), "Knowledge MCP must expose the current project taxonomy to model classifiers");
    const taxonomySchema = tools.find(item => item.name === "craft_knowledge_scenario_list")!.inputSchema as JsonObject;
    assert.equal((((taxonomySchema.properties as JsonObject).project_root as JsonObject).type), "string");
    const taxonomyMcp = await knowledgeMcp.handle({ jsonrpc: "2.0", id: "taxonomy", method: "tools/call",
      params: { name: "craft_knowledge_scenario_list", arguments: { scope: "project:p", project_root: join(f.root, "projects", "p") } } });
    const taxonomyResult = taxonomyMcp?.result as JsonObject;
    assert.equal(taxonomyResult.isError, false, JSON.stringify(taxonomyResult));
    const taxonomy = taxonomyResult.structuredContent as JsonObject;
    const taxonomyFine = (taxonomy.scenarios as JsonObject[]).find(item => item.scenario_key === "engineering.release.checks")!;
    assert.equal(taxonomyFine.lifecycle, "active");
    assert.equal(taxonomyFine.reviewed_source_count, 2);
    assert.equal(JSON.stringify(taxonomy).includes("Use the release verification set"), false);
    assert.equal((f.service.knowledgeScenarioList({ scope_kind: "project", scope_id: "p" }).scenarios as JsonObject[]).length, 3,
      "model-facing catalog reads must accept an explicit kind/id project scope");
    assert.throws(() => f.service.knowledgeScenarioList({}), /scope_kind/u);
    const globalTaxonomy = await knowledgeMcp.handle({ jsonrpc: "2.0", id: "global-taxonomy", method: "tools/call",
      params: { name: "craft_knowledge_scenario_list", arguments: { scope: "global" } } });
    assert.equal((globalTaxonomy?.result as JsonObject).isError, false, "global Knowledge must have its own taxonomy");
    assert.equal(((globalTaxonomy?.result as JsonObject).structuredContent as JsonObject).catalog_version, 0);
    const searchMcp = await knowledgeMcp.handle({ jsonrpc: "2.0", id: "search", method: "tools/call",
      params: { name: "craft_knowledge_search", arguments: { query: "release verification", scope: "project:p", scenario_key: "engineering.release.checks" } } });
    const searchResult = searchMcp?.result as JsonObject;
    assert.equal(searchResult.isError, false, JSON.stringify(searchResult));
    const searchContent = searchResult.structuredContent as JsonObject;
    assert.equal((searchContent.hits as JsonObject[]).length, 2, JSON.stringify(searchResult));
    const prematureCoarse = f.service.knowledgeSearch({ query: "release verification", scope: "project:p", scenario_key: "engineering.release" });
    assert.deepEqual(prematureCoarse.hits, []);
    for (const suffix of ["c", "d"]) {
      f.service.knowledgeSourceRegister({ source_id: `notes-${suffix}`, kind: "project_note", label: `Independent Notes ${suffix.toUpperCase()}`, trust: "verified",
        scope_kind: "project", scope_id: "p", locator: `notes-${suffix}.md`, content_digest: "sha256:" + suffix.repeat(64) });
      const evidence = f.service.evidenceRecord({ claim: `Independent release document ${suffix}`, source_type: "observation", confidence: "confirmed" });
      const claim = f.service.knowledgeClaimSave({ claim_id: `scenario-claim-${suffix}`, kind: "rule", content: "Use the release verification set for documentation.",
        scope: "project:p", source_id: `notes-${suffix}`, evidence_ids: [evidence.id], scenario_key: "engineering.release.documents", coarse_scenario_key: "engineering.release" }).claim as JsonObject;
      attachVerifiedPromotionFixture(f.store, claim);
    }
    const activeCoarse = f.service.knowledgeSearch({ query: "release verification", scope: "project:p", scenario_key: "engineering.release" });
    assert.equal((activeCoarse.hits as JsonObject[]).length, 4);
    assert.throws(() => f.service.knowledgeSearch({ query: "release", scope: "project:p", scenario_key: "Bad Key" }), /bounded stable identifier/u);

    const path = taxonomyPath;
    const readCatalog = async () => JSON.parse(await readFile(path, "utf8")) as JsonObject;
    assert.equal(JSON.stringify(await readCatalog()).includes("release verification set"), false);
    f.service.knowledgeSourceTransition({ source_id: "notes-b", status: "revoked", reason: "source withdrawn" });
    const afterRevocation = await readCatalog();
    const scene = (afterRevocation.scenarios as JsonObject[]).find(item => item.scenario_key === "engineering.release.checks")!;
    assert.equal(scene.lifecycle, "candidate");
    assert.equal((scene.claim_refs as JsonObject[]).find(item => item.claim_id === "scenario-claim-b")!.status, "inactive");
    assert.equal((afterRevocation.scenarios as JsonObject[]).find(item => item.scenario_key === "engineering.release")!.lifecycle, "candidate");
    assert.deepEqual(f.service.knowledgeSearch({ query: "release verification", scope: "project:p", scenario_key: "engineering.release" }).hits, []);
    const exitedScene = f.service.knowledgeSearch({ query: "release verification", scope: "project:p", scenario_key: "engineering.release.checks" });
    assert.deepEqual(exitedScene.hits, []);
    assert.equal((exitedScene.scenario_filter as JsonObject).status, "inactive_or_unclassified");
    assert(tools.some(item => item.name === "craft_knowledge_scenario_retire"), "Knowledge MCP must expose scenario retirement");
    assert(tools.some(item => item.name === "craft_knowledge_scenario_migration_propose"), "Knowledge MCP must expose auditable taxonomy migrations");
    const migrationBefore = await readCatalog();
    const migration = await knowledgeMcp.handle({ jsonrpc: "2.0", id: "migration-propose", method: "tools/call", params: {
      name: "craft_knowledge_scenario_migration_propose", arguments: { scope: "project:p", mode: "merge",
        source_keys: ["engineering.release.checks", "engineering.release.documents"],
        targets: [{ scenario_key: "engineering.release.verified", definition: { summary: "已验证的发布规则", applies_when: "对发布规则有独立来源支撑", excludes: "未审核陈述" } }],
        expected_catalog_version: migrationBefore.catalog_version, request_id: "merge-release-taxonomy-v1", reason: "shared release acceptance boundary" } } });
    const migrationResult = migration?.result as JsonObject;
    assert.equal(migrationResult.isError, false, JSON.stringify(migrationResult));
    const proposed = migrationResult.structuredContent as JsonObject;
    assert.equal(proposed.status, "candidate");
    assert.equal((await readCatalog()).catalog_version, Number(migrationBefore.catalog_version) + 1);
    assert(f.store.list("trace_event", 10_000, event => event.operation_id === "craft_knowledge_scenario_migration_propose"
      && event.event_kind === "component.call.completed").length > 0, "taxonomy proposal must have a component Trace");
    const latestCatalog = await readCatalog();
    const retire = await knowledgeMcp.handle({ jsonrpc: "2.0", id: "retire", method: "tools/call", params: {
      name: "craft_knowledge_scenario_retire", arguments: { scope: "project:p", scenario_key: "engineering.release.documents",
        expected_catalog_version: latestCatalog.catalog_version, request_id: "retire-docs-v1", reason: "scenario no longer used" } } });
    const retireResult = retire?.result as JsonObject;
    assert.equal(retireResult.isError, false, JSON.stringify(retireResult));
    assert.equal((retireResult.structuredContent as JsonObject).status, "retired");
    const blockedClaim = await knowledgeMcp.handle({ jsonrpc: "2.0", id: "blocked-claim", method: "tools/call", params: {
      name: "craft_knowledge_claim_save", arguments: { claim_id: "retired-scene-claim", kind: "rule", content: "Must not enter retired scene.",
        scope: "project:p", source_id: "notes-a", evidence_ids: [evidenceA.id], scenario_key: "engineering.release.documents", coarse_scenario_key: "engineering.release" } } });
    assert.equal((blockedClaim?.result as JsonObject).isError, true, "retired Knowledge scenes must not accept new Claims");
  } finally { await close(f); }
});

test("Knowledge scenario keys require bounded project or global fine and coarse identities", async () => {
  const f = await fixture();
  try {
    const evidence = sourceAndEvidence(f.service);
    const base = { kind: "fact", content: "A supported project fact.", scope: "project:p", evidence_ids: [evidence.id], source_id: "notes" };
    assert.throws(() => f.service.knowledgeClaimSave({ ...base, coarse_scenario_key: "engineering" }), /requires scenario_key/u);
    assert.throws(() => f.service.knowledgeClaimSave({ ...base, scenario_key: "Bad Key" }), /bounded stable identifiers/u);
    assert.throws(() => f.service.knowledgeClaimSave({ ...base, scenario_key: "engineering", coarse_scenario_key: "engineering" }), /distinct bounded/u);
    assert.throws(() => f.service.knowledgeClaimSave({ ...base, scope: "global", scenario_key: "Bad Key" }), /bounded stable identifiers/u);
    assert.throws(() => f.service.knowledgeClaimSave({ ...base, scope: "session:one", scenario_key: "engineering" }), /requires project or global scope/u);
    assert.throws(() => f.service.knowledgeClaimSave({ ...base, scenario_key: "engineering", coarse_scenario_definition:
      { summary: "x", applies_when: "x", excludes: "x" } }), /requires coarse_scenario_key/u);
  } finally { await close(f); }
});

test("global Knowledge classification and scenario search stay isolated from project taxonomies", async () => {
  const f = await fixture();
  try {
    const createSource = (sourceId: string, scopeKind: "project" | "global", scopeId: string) => f.service.knowledgeSourceRegister({
      source_id: sourceId, kind: "project_note", label: sourceId, trust: "verified", scope_kind: scopeKind, scope_id: scopeId,
      locator: `${sourceId}.md`, content_digest: `sha256:${sourceId.padEnd(64, "a").slice(0, 64)}` });
    const saveReviewed = (id: string, sourceId: string, scope: string, text: string) => {
      const evidence = f.service.evidenceRecord({ claim: `Evidence for ${id}`, source_type: "observation", confidence: "confirmed" });
      const claim = f.service.knowledgeClaimSave({ claim_id: id, kind: "rule", content: text, scope, source_id: sourceId,
        evidence_ids: [evidence.id], scenario_key: "engineering.testing", scenario_definition: {
          summary: "测试工程规则", applies_when: "适用于测试流程", excludes: "不涉及构建规则" } }).claim as JsonObject;
      return attachVerifiedPromotionFixture(f.store, claim);
    };
    createSource("global-notes-a", "global", "global");
    createSource("global-notes-b", "global", "global");
    createSource("project-notes-a", "project", "p");
    createSource("project-notes-b", "project", "p");
    const globalFirst = saveReviewed("global-scene-a", "global-notes-a", "global", "Use stable tests for the global workflow.");
    assert.equal((globalFirst.scenario_catalog as JsonObject).status, "candidate");
    const globalSecond = saveReviewed("global-scene-b", "global-notes-b", "global", "Use stable tests for the global workflow.");
    assert.equal((globalSecond.scenario_catalog as JsonObject).status, "active");
    saveReviewed("project-scene-a", "project-notes-a", "project:p", "Use stable tests for the project workflow.");
    const projectSecond = saveReviewed("project-scene-b", "project-notes-b", "project:p", "Use stable tests for the project workflow.");
    assert.equal((projectSecond.scenario_catalog as JsonObject).status, "active");

    const globalPath = join(f.root, "knowledge", "global", "knowledge-scenarios.json");
    const projectPath = join(projectStorageDirectory(f.store.paths, join(f.root, "projects", "p")), "knowledge", "projects", "p", "knowledge-scenarios.json");
    assert.equal(JSON.parse(await readFile(globalPath, "utf8")).catalog_version, 4);
    assert.equal(JSON.parse(await readFile(projectPath, "utf8")).catalog_version, 4);
    assert.deepEqual((f.service.knowledgeScenarioList({ scope: "global" }).scenarios as JsonObject[]).map(item => item.scenario_key), ["engineering.testing"]);
    assert.deepEqual((f.service.knowledgeSearch({ query: "stable tests", scope: "global", scenario_key: "engineering.testing" }).hits as JsonObject[])
      .map(item => item.claim_id).sort(), ["global-scene-a", "global-scene-b"]);
    assert.deepEqual((f.service.knowledgeSearch({ query: "stable tests", scope: "project:p", scenario_key: "engineering.testing" }).hits as JsonObject[])
      .map(item => item.claim_id).sort(), ["project-scene-a", "project-scene-b"]);
    const migration = f.service.knowledgeScenarioMigrationPropose({ scope: "global", mode: "split", source_keys: ["engineering.testing"],
      targets: ["engineering.testing.unit", "engineering.testing.integration"].map(scenario_key => ({ scenario_key, definition: {
        summary: "全球测试规则细分", applies_when: "规则明确适用于该测试边界", excludes: "与该测试边界无关的内容" } })),
      expected_catalog_version: 4, request_id: "split-global-testing", reason: "global testing has distinct acceptance boundaries" });
    assert.equal(migration.status, "candidate");
    const retired = f.service.knowledgeScenarioRetire({ scope: "global", scenario_key: "engineering.testing", expected_catalog_version: 5,
      request_id: "retire-global-testing", reason: "global taxonomy test" });
    assert.equal(retired.status, "retired");
    assert.deepEqual(f.service.knowledgeSearch({ query: "stable tests", scope: "global", scenario_key: "engineering.testing" }).hits, []);
    assert.equal((f.service.knowledgeSearch({ query: "stable tests", scope: "project:p", scenario_key: "engineering.testing" }).hits as JsonObject[]).length, 2);
  } finally { await close(f); }
});

test("memory without a scope is an explicit safe skip rather than a malformed global search", async () => {
  const f = await fixture();
  try {
    const result = await f.service.memorySearch({ query: "anything" });
    assert.deepEqual(result, { memories: [], count: 0, omitted_count: 0, receipt_id: null, content_free_receipt: true,
      skipped: true, reason: "scope_unavailable" });
  } finally { await close(f); }
});

test("automated Knowledge review rejects legacy imports and blocks current Claims without independent effectiveness evidence", async () => {
  const f = await fixture();
  try {
    const legacyEvidence = f.service.evidenceRecord({ evidence_id: "legacy-evidence", claim: "Old importer assertion", source_type: "import", confidence: "unverified" });
    const legacy = f.service.knowledgeClaimSave({ claim_id: "legacy-claim", kind: "fact", content: "An old repository observation.",
      scope: "legacy:project", evidence_ids: [legacyEvidence.id] }).claim as JsonObject;
    // Simulate the pre-provenance records which the migration left in the local
    // database. The reviewer must not recover their trust from Markdown text.
    f.store.save("knowledge_claim", String(legacy.id), { ...legacy, source_id: null, scope: "legacy:project" });
    const currentEvidence = sourceAndEvidence(f.service);
    const secondCurrentEvidence = f.service.evidenceRecord({ evidence_id: "current-evidence-2", claim: "A second independent fixture observation", source_type: "observation", confidence: "confirmed",
      metadata: { source_session_id: "knowledge-operability-session-two", task_id: "knowledge-operability-task-two" } });
    f.service.knowledgeClaimSave({ claim_id: "current-claim", kind: "fact", content: "A current evidenced repository observation.",
      scope: "project:p", source_id: "notes", evidence_ids: [currentEvidence.id] });
    f.service.knowledgeClaimSupportRecord({ claim_id: "current-claim", evidence_id: currentEvidence.id, observation_key: "session:fixture:one" });
    f.service.knowledgeClaimSupportRecord({ claim_id: "current-claim", evidence_id: secondCurrentEvidence.id, observation_key: "session:fixture:two" });

    const legacyAssessment = (f.service.knowledgeAutoReview({ scope_kind: "legacy", scope_id: "project", claim_ids: ["legacy-claim"], auto_promote: true, now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!;
    const currentAssessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "p", claim_ids: ["current-claim"], auto_promote: true, now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!;
    assert.equal(legacyAssessment.verdict, "revalidation_required");
    assert.deepEqual(legacyAssessment.reasons, ["legacy_scope_requires_live_revalidation", "source_missing", "credible_evidence_missing", "independent_effectiveness_evaluation_required", "independent_support_below_threshold"]);
    assert.equal(legacyAssessment.promoted, false);
    assert.equal(f.store.get("knowledge_claim", "legacy-claim").status, "candidate");
    assert.equal(currentAssessment.verdict, "revalidation_required");
    assert((currentAssessment.reasons as string[]).includes("independent_effectiveness_evaluation_required"));
    assert.equal(currentAssessment.promoted, false);
    assert.equal(f.store.get("knowledge_claim", "current-claim").status, "candidate");
    assert.equal((f.service.knowledgeAutoReview({ scope_kind: "legacy", scope_id: "project", claim_ids: ["legacy-claim"], now: "2026-09-20T00:00:00.000Z" }).assessments as JsonObject[])[0]!.idempotent, true);
    assert.throws(() => f.service.knowledgeClaimReview({ claim_id: "legacy-claim", status: "reviewed", reviewer: "human", reason: "trust old import" }), /managed Host review and independent effectiveness evaluation/u);
  } finally { await close(f); }
});

test("explicit user memory is scoped, conflict-aware and retires only the replaced active entry", async () => {
  const f = await fixture();
  try {
    const old = f.service.memoryCaptureUserStatement({ content: "I take sugar in coffee.", kind: "preference", topic: "preference:diet:sugar",
      scope_kind: "user", scope_id: "didi", memory_id: "sugar-old" });
    assert.equal(old.auto_committed, true);
    const replacement = f.service.memoryCaptureUserStatement({ content: "I am now avoiding sugar.", kind: "preference", topic: "preference:diet:sugar",
      scope_kind: "user", scope_id: "didi", candidate_id: "sugar-new" });
    assert.equal((replacement.candidate as JsonObject).status, "conflict_pending");
    const committed = f.service.memoryConflictResolve({ candidate_id: "sugar-new", resolution: "supersede", actor: "user", reason: "newer preference" });
    assert.equal(committed.auto_committed, true);
    assert.equal((committed.memory as JsonObject).status, "active");
    assert.equal(f.store.get("memory_ledger", "sugar-old").status, "superseded");
    const context = await f.service.contextResolutionResolve({ query: "sugar coffee", scope_kind: "user", scope_id: "didi", receipt_id: "diet-context" });
    const memories = context.items as JsonObject[];
    assert.equal(memories.length, 1);
    assert.match(String(memories[0]!.content), /avoiding sugar/u);
    const gate = await f.service.decisionContextGateOpen({ gate_id: "diet-decision", decision_kind: "prepare_order", query: "sugar coffee",
      scope_kind: "user", scope_id: "didi", require_context: true, required_constraint_ids: ["diet-sugar", "scope-user"], recalled_constraint_ids: ["diet-sugar"],
      context_input_tokens: 42, error_injection_count: 0, cost_units: 0.01, latency_ms: 5, cache_observation: "unavailable" });
    assert.equal((gate.gate as JsonObject).status, "ready");
    assert.equal(((gate.gate as JsonObject).decision_metrics as JsonObject).constraint_recall_at_decision, 0.5);
    assert.equal(((gate.gate as JsonObject).decision_metrics as JsonObject).cache_observation, "unavailable");
    await assert.rejects(() => f.service.decisionContextGateOpen({ gate_id: "invalid-recall", decision_kind: "prepare_order", query: "sugar coffee", scope_kind: "user", scope_id: "didi", required_constraint_ids: ["diet-sugar"], recalled_constraint_ids: ["unknown"] }), /subset/);
    const skipped = await f.service.decisionContextGateOpen({ gate_id: "scope-required", decision_kind: "prepare_order", query: "sugar", require_context: true });
    assert.equal((skipped.gate as JsonObject).status, "skipped");
    assert.equal(((await f.service.decisionContextGateGet({ gate_id: "scope-required" })).gate as JsonObject).status, "skipped");
  } finally { await close(f); }
});

test("portable Knowledge/Memory bundles preserve content but merge only additions", async () => {
  const source = await fixture();
  const target = await fixture();
  try {
    const evidence = sourceAndEvidence(source.service);
    const claim = source.service.knowledgeClaimSave({ claim_id: "claim-a", kind: "fact", content: "Run unit tests before publishing.",
      scope: "project:p", source_id: "notes", evidence_ids: [evidence.id] }).claim as JsonObject;
    attachVerifiedPromotionFixture(source.store, claim);
    source.service.memoryLedgerRemember({ memory_id: "memory-a", source_id: "notes", kind: "procedural", scope_kind: "project", scope_id: "p",
      content: "Use the smallest relevant test command first.", confidence: "confirmed", evidence_ids: [evidence.id] });

    const exported = source.service.knowledgeMemoryBundleExport({ scope_kind: "project", scope_id: "p", exported_at: "2026-09-20T00:00:00.000Z" });
    const bundle = exported.bundle as JsonObject;
    assert.equal(source.service.knowledgeMemoryBundleVerify({ bundle }).valid, true);
    const plan = target.service.knowledgeMemoryBundleImportPlan({ bundle });
    assert.equal(plan.additions, 4); // source, Evidence, Claim and Memory
    assert.equal(plan.conflicts, 0);
    assert.throws(() => target.service.knowledgeMemoryBundleImportApply({ bundle, approved: false }), /requires approved/u);
    const applied = target.service.knowledgeMemoryBundleImportApply({ bundle, approved: true, import_id: "import-a" });
    assert.equal((applied.import as JsonObject).conflict_free, true);
    assert.match(String(target.store.get("knowledge_claim", "claim-a").content), /unit tests/u);
    assert.equal(target.store.get("knowledge_claim", "claim-a").status, "candidate", "imported reviewed labels require local independent revalidation");
    assert.match(String(target.store.get("memory_ledger", "memory-a").content), /smallest relevant/u);

    const replay = target.service.knowledgeMemoryBundleImportApply({ bundle, approved: true, import_id: "import-a" });
    assert.equal(replay.idempotent, true);
    const duplicatePlan = target.service.knowledgeMemoryBundleImportPlan({ bundle });
    // The Claim's reviewed label loses source-machine promotion authority on import, so its
    // candidate projection is a conflict with the original reviewed bundle record.
    assert.deepEqual((duplicatePlan.decisions as JsonObject[]).map((item) => `${item.kind}:${item.action}`).sort(), ["evidence:duplicate", "knowledge_claim:conflict", "knowledge_source:duplicate", "memory_ledger:duplicate"]);
    assert.equal(duplicatePlan.duplicates, 3);

    target.store.save("knowledge_claim", "claim-a", { ...target.store.get("knowledge_claim", "claim-a"), status: "revoked" });
    const conflictPlan = target.service.knowledgeMemoryBundleImportPlan({ bundle });
    assert.equal(conflictPlan.conflicts, 1);
  } finally { await close(source); await close(target); }
});

test("component diagnosis distinguishes a reachable MCP process from a stale or incomplete Host surface", async () => {
  const f = await fixture();
  try {
    const stale = f.service.componentDiagnose({ component: "knowledge", observed_tool_names: ["craft_component_readiness_get"] });
    assert.equal(stale.runtime_reachable, true);
    assert.equal(stale.host_attachment, "bundle_or_surface_mismatch");
    assert((stale.missing_tools as string[]).includes("craft_knowledge_search"));
    const legacyExperience = f.service.componentDiagnose({ component: "experience", observed_tool_names: ["craft_component_readiness_get", "craft_context_resolution_resolve", "craft_scope_identity_resolve_project", "craft_experience_observe", "craft_experience_procedure_draft"] });
    assert.equal(legacyExperience.host_attachment, "bundle_or_surface_mismatch");
    assert.deepEqual(legacyExperience.missing_tools, ["craft_procedure_get", "craft_procedure_gate", "craft_procedure_plan", "craft_procedure_invocation_bind", "craft_procedure_invocation_get"]);
    const publishedTools = new McpServer(f.service, productSurfaceOf("experience")).tools.map((tool) => tool.name);
    const planningOnly = f.service.componentDiagnose({ component: "experience", observed_tool_names: publishedTools.filter((name) => !name.startsWith("craft_procedure_invocation_")) });
    assert.equal(planningOnly.host_attachment, "bundle_or_surface_mismatch");
    assert.deepEqual(planningOnly.missing_tools, ["craft_procedure_invocation_bind", "craft_procedure_invocation_get"]);
    const current = f.service.componentDiagnose({ component: "experience", observed_tool_names: publishedTools });
    assert.equal(current.host_attachment, "surface_matches");
    assert.deepEqual(current.missing_tools, []);
    const contextAgent = f.service.componentDiagnose({ component: "memory", observed_tool_names: ["craft_run", "craft_context_tools_discover"] });
    assert.equal(contextAgent.host_attachment, "surface_matches");
    assert.equal(contextAgent.tool_access_mode, "syscall_discovery");
    assert.deepEqual(contextAgent.missing_tools, []);
    const partialRoute = f.service.componentDiagnose({ component: "memory", observed_tool_names: ["craft_run"] });
    assert.equal(partialRoute.host_attachment, "bundle_or_surface_mismatch");
    assert.match(String(f.service.componentDiagnose({ component: "memory" }).host_attachment), /this_mcp_process_replied/u);
    assert.throws(() => f.service.componentDiagnose({ component: "memory", observed_tool_names: [" "] }), /non-empty/u);
  } finally { await close(f); }
});

test("standalone Knowledge and Memory surfaces expose the same portable bundle protocol", async () => {
  const f = await fixture();
  try {
    const knowledge = new McpServer(f.service, productSurfaceOf("knowledge"));
    const memory = new McpServer(f.service, productSurfaceOf("memory"));
    for (const server of [knowledge, memory]) {
      assert(server.tools.some((tool) => tool.name === "craft_knowledge_memory_bundle"));
      const result = await server.handlers.craft_knowledge_memory_bundle({ operation: "export", scope_kind: "project", scope_id: "p", exported_at: "2026-09-20T00:00:00.000Z" });
      assert.equal((result.bundle as JsonObject).format, "craft.knowledge-memory-bundle");
    }
  } finally { await close(f); }
});


test("diagnostic knowledge search applies restricted and invalid-expiry filters before loading bodies", async t => {
  const f = await fixture();
  try {
    const evidence = sourceAndEvidence(f.service);
    const claim = f.service.knowledgeClaimSave({ claim_id: "restricted", kind: "fact", content: "alpha fixture", scope: "project:p", source_id: "notes", evidence_ids: [evidence.id] }).claim as JsonObject;
    f.store.save("knowledge_claim", String(claim.id), { ...claim, sensitivity: "restricted" });
    const mocked = t.mock.method(f.store.contentStore, "readCompatSync", () => { throw new Error("Body must not be loaded"); });
    assert.deepEqual(f.service.knowledgeSearch({ query: "alpha", scope: "project:p" }).hits, []);
    mocked.mock.restore();
    assert.equal((f.service.knowledgeSearch({ query: "alpha", scope: "project:p", allow_restricted: true }).hits as JsonObject[])[0]!.claim_id, claim.id);
    f.store.save("knowledge_claim", String(claim.id), { ...f.store.get("knowledge_claim", String(claim.id)), valid_until: "invalid", sensitivity: "internal" });
    t.mock.method(f.store.contentStore, "readCompatSync", () => { throw new Error("Invalid-expiry body must not be loaded"); });
    assert.deepEqual(f.service.knowledgeSearch({ query: "alpha", scope: "project:p" }).hits, []);
  } finally { await close(f); }
});
