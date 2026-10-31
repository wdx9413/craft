import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ScopeIdentityKernel } from "../core/scope-identity.ts";
import { projectDataMigration } from "../core/project-data-migration.ts";
import { stableDigest } from "../core/digest.ts";
import { KnowledgeSourceRegistry } from "../capability/craft-knowledge/knowledge-source-registry.ts";
import { KnowledgeClaimGovernance } from "../capability/craft-knowledge/claim-governance.ts";
import { MemoryLedgerKernel } from "../capability/craft-memory/memory-ledger.ts";
import { MemoryGovernanceKernel } from "../capability/craft-memory/memory-governance.ts";
import { ExperienceLedgerKernel } from "../capability/craft-experience/experience-ledger.ts";
import { TOOLS } from "../core/mcp/tool-catalog.ts";
import type { ContentRef } from "../common/craft-common-store-local/src/content-store.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";

type Ref = { kind: string; id: string; version: number };
type Mapping = { source: Ref; target: Ref };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "craft-data-migration-")));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(), kernel = new ScopeIdentityKernel(store);
  const old = { kind: "project", id: "legacy" };
  kernel.bindAlias({ scope_kind: "project", scope_id: "legacy", alias_kind: "path", alias: root });
  store.create("project_identity", "legacy", { canonical_scope: old, local_path_alias: root });
  await writeFile(join(root, "README.md"), "Synthetic project source");
  const source = new KnowledgeSourceRegistry(store).sourceRegister({ source_id: "old-source", kind: "project_note", label: "Synthetic source", scope_kind: "project", scope_id: "legacy", locator: join(root, "README.md"), content_digest: "source-descriptor", trust: "verified", access: "read_only" }).source as JsonObject;
  const revision = store.create("knowledge_source_revision", "revision", { source_id: source.id, status: "current", source_revision_digest: "revision-digest", immutable: true });
  const doc = store.create("knowledge_document", "document", { source_id: source.id, source_revision_id: revision.id, path: "README.md", content_digest: "document-digest", status: "current" });
  const ref = store.contentStore.writeSync({ kind: "knowledge", record_id: "fragment", version: 1, scope: "project:legacy", status: "reviewed", sensitivity: "internal", source_id: String(source.id), body: "Keep the literal project:legacy and old-source text unchanged." });
  const fragment = store.create("knowledge_fragment", "fragment", { source_id: source.id, source_revision_id: revision.id, document_id: doc.id, content_ref: ref, content_digest: ref.digest, status: "current" });
  const evidence = store.create("evidence", "evidence", { source_type: "knowledge_fragment", source_id: source.id, source_revision_id: revision.id, fragment_id: fragment.id, confidence: "confirmed", claim: "Synthetic evidence", metadata: { review_id: "old-host-review", host_session_id: "old-session" } });
  const claim = store.create("knowledge_claim", "claim", { source_id: source.id, source_revision_id: revision.id, document_id: doc.id, fragment_id: fragment.id, scope: "project:legacy", kind: "fact", content_ref: ref, evidence_ids: [evidence.id], status: "reviewed", review: { reviewer: "old-host" }, semantic_review_id: "old-review", publication_allowed: true });
  const memoryRef = store.contentStore.writeSync({ kind: "memory", record_id: "memory", version: 1, scope: "project:legacy", status: "active", sensitivity: "internal", source_id: String(source.id), body: "Prefer the old-source convention, project:legacy stays literal." });
  const memory = store.create("memory_ledger", "memory", { source_id: source.id, scope: old, kind: "preference", topic: "convention", content_ref: memoryRef, evidence_ids: [evidence.id], status: "active", confidence: "confirmed", promotion_support_refs: [{ id: "old-authority" }], scope_envelope: { applicability: old, custody: old, audience: { mode: "private", principal_ids: ["local-owner"] }, tenant_id: "tenant" } });
  const observation = store.create("experience_observation", "observation", { scope: "project:legacy", source: { kind: "outcome", id: "old-outcome", version: 1 }, kind: "success", scenario_key: "synthetic", finding_digest: "finding-digest", evidence_ids: [evidence.id], status: "recorded", content_free: true });
  const plan = kernel.resolveProject({ project_root: root, action: "plan_registry_migration" });
  const applied = kernel.resolveProject({ project_root: root, action: "apply_registry_migration", expected_digest: plan.plan_digest, legacy_scope_id: "legacy" });
  const identity = applied.identity as JsonObject;
  const args = { project_root: root, migration_id: (applied.migration as JsonObject).id };
  const refs = [claim, memory, observation].map((record, index) => ({ kind: ["knowledge_claim", "memory_ledger", "experience_observation"][index]!, id: String(record.id), version: Number(record.version) }));
  const preflight = (record_refs: unknown = refs) => kernel.resolveProject({ ...args, action: "plan_data_migration", record_refs });
  const apply = (plan: JsonObject, extra: JsonObject = {}) => kernel.resolveProject({ ...args, action: "apply_data_migration", record_refs: plan.record_refs, expected_digest: plan.plan_digest, ...extra });
  function raw(kind: string, id: string, value: JsonObject, version = 1) {
    const now = new Date().toISOString();
    store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(kind, id, version, JSON.stringify(value), now, now);
  }
  return { root, store, kernel, identity, args, refs, preflight, apply, raw, source, claim, memory, observation,
    restore: (plan: JsonObject, extra: JsonObject = {}) => kernel.resolveProject({ ...args, action: "restore_data_migration", expected_digest: plan.plan_digest, ...extra }),
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("typed project migration freezes full bodies without a writer and imports candidates with remapped provenance", async () => {
  const f = await fixture(), peer = new DatabaseSync(f.store.paths.databaseFile);
  try {
    const changes = f.store.database.prepare("SELECT total_changes() value").get();
    peer.exec("BEGIN IMMEDIATE");
    const plan = f.preflight();
    assert.deepEqual(f.store.database.prepare("SELECT total_changes() value").get(), changes);
    assert.doesNotMatch(JSON.stringify(plan), /literal project:legacy|Prefer the old-source|old-host-review|\.db/);
    assert.equal(plan.review_execution_authority_transferred, false);
    assert.equal((plan.records as Mapping[]).length, 8);
    assert.equal(f.preflight([...f.refs].reverse()).plan_digest, plan.plan_digest);
    peer.exec("ROLLBACK");
    const result = f.apply(plan), migration = result.migration as JsonObject;
    const mapped = (kind: string, id: string) => { const ref = (plan.records as Mapping[]).find(x => x.source.kind === kind && x.source.id === id)!.target; return f.store.get(ref.kind, ref.id); };
    const source = mapped("knowledge_source", "old-source"), claim = mapped("knowledge_claim", "claim"), evidence = mapped("evidence", "evidence"), memory = mapped("memory_ledger", "memory"), observation = mapped("experience_observation", "observation");
    assert.equal(source.trust, "bounded"); assert.equal(source.status, "active");
    const registered = new KnowledgeSourceRegistry(f.store).sourceRegister({ source_id: source.id, ...source, scope_kind: "project", scope_id: (f.identity.canonical_scope as JsonObject).id });
    assert.equal(registered.idempotent, true);
    assert.equal(claim.source_id, source.id); assert.deepEqual(claim.evidence_ids, [evidence.id]); assert.equal(claim.status, "candidate"); assert.equal(claim.review, null);
    assert.equal(claim.semantic_review_id, undefined); assert.equal(claim.publication_allowed, false);
    assert.equal(claim.content, "Keep the literal project:legacy and old-source text unchanged.");
    assert.notEqual((claim.content_ref as JsonObject).record_id, "fragment");
    assert.equal(evidence.confidence, "unverified"); assert.deepEqual(evidence.metadata, { capability_owner: "knowledge" });
    assert.equal(memory.status, "candidate"); assert.equal(memory.confidence, "unverified"); assert.equal(memory.review, null); assert.equal(memory.promotion_support_refs, undefined);
    assert.equal(memory.content, "Prefer the old-source convention, project:legacy stays literal.");
    assert.deepEqual((memory.scope_envelope as JsonObject).audience, { mode: "private", principal_ids: ["local-owner"] }); assert.equal((memory.scope_envelope as JsonObject).tenant_id, "tenant");
    assert.equal(observation.status, "revalidation_required"); assert.equal(observation.source, undefined);
    assert.throws(() => new MemoryGovernanceKernel(f.store, new MemoryLedgerKernel(f.store)).review({ candidate_id: memory.id, decision: "approve", reviewer: "test", reason: "Old Evidence is not new approval" }), /bounded or confirmed Evidence/);
    assert.throws(() => new KnowledgeClaimGovernance(f.store).knowledgeClaimReview({ claim_id: claim.id, status: "reviewed" }), /managed Host review/);
    assert.throws(() => new ExperienceLedgerKernel(f.store).compile({ scenario_key: "synthetic", observation_ids: [observation.id, "observation"] }), /do not match the scenario/);
    assert.equal(f.apply(plan).idempotent, true);
    assert.deepEqual(f.store.get("knowledge_claim", "claim"), f.store.get("knowledge_claim", "claim", 1));
    assert.equal(f.store.get("memory_ledger", "memory").status, "active");
    const files = (migration.after as Ref[]).map(ref => f.store.get(ref.kind, ref.id).content_ref).filter(Boolean) as ContentRef[];
    assert.ok(files.length > 0);
    const restored = f.restore(plan); assert.equal((restored.migration as JsonObject).state, "restored");
    for (const ref of migration.after as Ref[]) assert.equal(f.store.find(ref.kind, ref.id), null);
    for (const ref of files) assert.equal(f.store.contentStore.readSync(ref).body.includes("literal"), true);
    assert.equal(f.restore(plan).idempotent, true);
    assert.throws(() => f.apply(plan), /was restored/);
    assert.equal(f.store.get("knowledge_claim", "claim").status, "reviewed");
    assert.equal(f.store.list("task_message", 10).length, 0);
    const registry = f.kernel.resolveProject({ ...f.args, action: "restore_registry" });
    assert.equal(registry.registry_restored, true);
    assert.equal(f.store.get("memory_ledger", "memory").status, "active");
    assert.throws(() => f.kernel.resolveProject({ project_root: f.root }), /MIGRATION_REQUIRED/);
  } finally { if (peer.isTransaction) peer.exec("ROLLBACK"); peer.close(); await f.close(); }
});

test("migration rejects malformed legacy records, foreign parents and unsafe content without partial writes", async () => {
  const f = await fixture();
  try {
    let serial = 0;
    const check = (kind: string, value: JsonObject, error: RegExp) => {
      const id = `invalid-${++serial}`; f.raw(kind, id, value);
      assert.throws(() => f.preflight([{ kind, id, version: 1 }]), error);
    };
    const base = { scope: "project:legacy", kind: "preference", source_id: "old-source", content: "Synthetic candidate" };
    for (const value of [[], 1, "project", { kind: "unknown", id: "x" }, { kind: "project" }]) check("memory_candidate", { ...base, scope: value }, /scope.*malformed/);
    check("memory_candidate", { ...base, scope: { kind: "project", id: "other" } }, /another scope/);
    check("memory_candidate", { ...base, scope: "session:legacy" }, /another scope/);
    check("memory_candidate", { ...base, kind: {} }, /scalar field/);
    check("memory_candidate", { ...base, source_id: 1 }, /reference is malformed/);
    check("memory_candidate", { ...base, source_id: "" }, /reference is malformed/);
    check("memory_candidate", { ...base, source_id: null }, /migration source_id/);
    for (const evidence_ids of [{}, [1], [""], ["evidence", "evidence"]]) check("memory_candidate", { ...base, evidence_ids }, /references are malformed/);
    check("memory_candidate", { ...base, content: undefined }, /body is missing/);
    check("memory_candidate", { ...base, content_ref: null }, /invalid reference/);
    check("memory_candidate", { ...base, content_ref: {} }, /invalid reference/);
    check("memory_candidate", { ...base, content: "x".repeat(1048577) }, /record exceeds/);
    check("experience_observation", { scope: "project:legacy", kind: "success", content: "Unsupported body" }, /No typed content recipe/);
    for (const parentScope of ["project:foreign", "global"]) {
      const id = `foreign-revision-${serial}`;
      f.raw("knowledge_source_revision", id, { scope: parentScope, source_id: "old-source" });
      check("knowledge_document", { scope: "project:legacy", source_id: "old-source", source_revision_id: id }, /another scope/);
    }
    f.raw("knowledge_source", "foreign-source", { scope: "project:foreign" });
    check("memory_candidate", { ...base, source_id: "foreign-source" }, /another scope/);
    const hugePath = join(f.root, "large-content.md"); await writeFile(hugePath, "x".repeat(1048577));
    check("memory_candidate", { ...base, content_ref: { path: hugePath } }, /content exceeds/);
    assert.throws(() => projectDataMigration(f.store, f.identity, { action: "other" }), /Unknown data migration action/);
    assert.equal(f.store.list("project_data_migration", 100).length, 0);
  } finally { await f.close(); }
});

test("neutral Sources stay pinned, neutral Evidence loses confidence, and independent source ACLs stay narrow", async () => {
  const f = await fixture();
  try {
    const source = new KnowledgeSourceRegistry(f.store).sourceRegister({ source_id: "neutral-source", kind: "custom", label: "Neutral source", scope_kind: "global", scope_id: "global", locator: f.root, content_digest: "neutral", trust: "verified" }).source as JsonObject;
    f.store.save("knowledge_source", "neutral-source", { ...source, label: "Updated neutral source" });
    f.raw("evidence", "neutral-evidence", { scope: "global", source_id: "neutral-source", source_type: "synthetic", claim: "neutral proof", confidence: "confirmed" });
    for (const id of ["one", "two"]) f.raw("memory_candidate", id, { scope: "project:legacy", source_id: "neutral-source", kind: "preference", content: "Synthetic neutral candidate", evidence_ids: ["neutral-evidence"], valid_until: null, scope_envelope: { applicability: { kind: "project", id: "legacy" }, custody: { kind: "user", id: "owner" }, audience: { mode: "public", principal_ids: [] } } });
    const refs = ["one", "two"].map(id => ({ kind: "memory_candidate", id, version: 1 }));
    const plan = f.preflight(refs);
    assert.equal((plan.external_refs as Ref[])[0].version, 2);
    assert.throws(() => f.preflight([...refs, { kind: "knowledge_source", id: "neutral-source", version: 2 }]), /another scope/);
    const applied = f.apply(plan).migration as JsonObject;
    assert.equal((applied.after as Ref[]).length, 3);
    for (const ref of applied.after as Ref[]) {
      const record = f.store.get(ref.kind, ref.id);
      if (ref.kind === "memory_candidate") {
        assert.equal(record.source_id, "neutral-source"); assert.equal(record.source_version, 2);
        assert.deepEqual((record.scope_envelope as JsonObject).custody, { kind: "user", id: "owner" });
        assert.deepEqual((record.scope_envelope as JsonObject).audience, { mode: "scoped", principal_ids: [] });
      } else assert.equal(record.confidence, "unverified");
    }
    f.restore(plan);
    assert.equal(f.store.get("knowledge_source", "neutral-source").trust, "verified");
  } finally { await f.close(); }
});

test("migration binds shard bodies and refuses ambiguous Evidence ownership", async () => {
  const f = await fixture();
  try {
    const row = f.store.database.prepare("SELECT payload_json FROM records WHERE kind='memory_ledger' AND id='memory'").get()!;
    const header = JSON.parse(String(row.payload_json));
    const shard = new DatabaseSync(header._memory_partition.file);
    const original = String(shard.prepare("SELECT payload_json FROM records WHERE kind='memory_ledger' AND id='memory'").get()!.payload_json);
    try {
      const before = f.preflight();
      shard.prepare("UPDATE records SET payload_json=? WHERE kind='memory_ledger' AND id='memory'").run(JSON.stringify({ ...JSON.parse(original), topic: "same-version changed body" }));
      assert.throws(() => f.apply(before), /plan changed/);
      shard.prepare("UPDATE records SET payload_json=? WHERE kind='memory_ledger' AND id='memory'").run(JSON.stringify({ ...JSON.parse(original), scope: { kind: "project", id: "foreign" } }));
      assert.throws(() => f.preflight(), /body and published owner disagree/);
    } finally { shard.prepare("UPDATE records SET payload_json=? WHERE kind='memory_ledger' AND id='memory'").run(original); shard.close(); }
    const evidenceHeader = f.store.database.prepare("SELECT payload_json FROM records WHERE kind='evidence' AND id='evidence'").get()!;
    const value = JSON.parse(String(evidenceHeader.payload_json)); value._memory_partition = value._knowledge_partition;
    f.store.database.prepare("UPDATE records SET payload_json=? WHERE kind='evidence' AND id='evidence'").run(JSON.stringify(value));
    assert.throws(() => f.preflight(), /capability owner is ambiguous/);
  } finally { await f.close(); }
});

test("full-body and registry drift invalidate preflight while failed publication rolls back all records", async () => {
  const f = await fixture();
  try {
    const plan = f.preflight();
    const memory = f.store.get("memory_ledger", "memory");
    f.store.save("memory_ledger", "memory", { ...memory, topic: "changed" });
    assert.throws(() => f.apply(plan), /version changed/);
    const updated = f.preflight(f.refs.map(ref => ref.id === "memory" ? { ...ref, version: 2 } : ref));
    f.store.database.exec("CREATE TEMP TRIGGER fail_migration BEFORE INSERT ON main.records WHEN NEW.kind='project_data_migration' BEGIN SELECT RAISE(ABORT,'receipt failure'); END;");
    assert.throws(() => f.apply(updated), /receipt failure/);
    for (const row of updated.records as Mapping[]) assert.equal(f.store.find(row.target.kind, row.target.id), null);
    assert.equal(f.store.list("project_data_migration", 10).length, 0);
    f.store.database.exec("DROP TRIGGER fail_migration");
    const result = f.apply(updated); assert.equal(result.idempotent, false);
    const target = (updated.records as Mapping[]).find(row => row.source.id === "memory")!.target;
    f.store.save(target.kind, target.id, { ...f.store.get(target.kind, target.id), status: "approved" });
    assert.throws(() => f.restore(updated), /target changed/);
    assert.throws(() => f.apply(updated), /target changed/);
  } finally { await f.close(); }
});

test("migration refuses later publications, foreign receipts and changed content files", async () => {
  const f = await fixture(), other = await fixture();
  try {
    const plan = f.preflight(); f.apply(plan);
    const ref = (plan.records as Mapping[]).find(row => row.source.kind === "knowledge_claim")!.target;
    const content = f.store.get(ref.kind, ref.id).content_ref as ContentRef;
    const original = await readFile(content.path, "utf8");
    await writeFile(content.path, original + "tampered");
    assert.throws(() => f.restore(plan), /digest drifted/);
    await writeFile(content.path, original);
    assert.throws(() => projectDataMigration(f.store, other.identity, { ...f.args, action: "restore_data_migration", expected_digest: plan.plan_digest }), /another project/);
    f.store.create("unrelated_publication", "subsequent", { content: "A hidden shard reference could exist; require dependency review." });
    assert.throws(() => f.restore(plan), /Subsequent publication/);
    f.store.remove("unrelated_publication", "subsequent");
    assert.equal((f.restore(plan).migration as JsonObject).state, "restored");
  } finally { await f.close(); await other.close(); }
});

test("migration validates roots, dependency boundaries, recipes and the advertised schema", async () => {
  const f = await fixture();
  try {
    assert.throws(() => projectDataMigration(f.store, f.identity, { ...f.args, action: "plan_data_migration" }), /record_refs/);
    for (const record_refs of [[], Array(51).fill(f.refs[0]), [null], [{ kind: "", id: "x", version: 1 }], [{ kind: "x", id: "y", version: 0 }], [f.refs[0], f.refs[0]]]) assert.throws(() => f.preflight(record_refs), /record_refs/);
    assert.throws(() => f.preflight([{ kind: "experience_release", id: "old-release", version: 1 }]), /No typed migration recipe/);
    assert.throws(() => f.preflight([{ kind: "knowledge_claim", id: "missing", version: 1 }]), /missing or version changed/);
    const plan = f.preflight();
    assert.throws(() => f.apply(plan, { expected_digest: "bad" }), /expected_digest/);
    assert.throws(() => f.apply(plan, { expected_digest: "sha256:" + "0".repeat(64) }), /plan changed/);
    assert.throws(() => projectDataMigration(f.store, f.identity, { action: "plan_data_migration", record_refs: f.refs }), /migration_id/);
    const migration = f.store.get("project_registry_migration", String(f.args.migration_id));
    f.store.save("project_registry_migration", String(migration.id), { ...migration, state: "restored" });
    assert.throws(() => f.preflight(), /applied registry/);
    const tool = TOOLS.find(item => item.name === "craft_scope_identity_resolve_project")!;
    assert.equal(((tool.inputSchema.properties as JsonObject).record_refs as JsonObject).type, "array");
    assert.match(tool.description, /plan_data_migration/);
  } finally { await f.close(); }
});

test("bounded migration rejects oversized dependency graphs, metadata totals and content totals", async () => {
  const f = await fixture();
  try {
    const refs: Ref[] = [];
    for (let index = 0; index < 50; index++) {
      const id = `budget-root-${index}`; refs.push({ kind: "experience_observation", id, version: 1 });
      f.raw("experience_observation", id, { scope: "project:legacy", evidence_ids: index ? [] : Array.from({ length: 51 }, (_, i) => `budget-evidence-${i}`) });
    }
    for (let index = 0; index < 51; index++) f.raw("evidence", `budget-evidence-${index}`, { scope: "project:legacy", source_type: "synthetic" });
    assert.throws(() => f.preflight(refs), /dependency budget/);
    const large: Ref[] = [];
    for (let index = 0; index < 10; index++) {
      const id = `large-${index}`; large.push({ kind: "evidence", id, version: 1 });
      f.raw("evidence", id, { scope: "project:legacy", source_type: "synthetic", claim: "x".repeat(960000) });
    }
    assert.throws(() => f.preflight(large), /input exceeds 8 MiB/);
    const bodies: Ref[] = [];
    for (let index = 0; index < 5; index++) {
      const id = `body-${index}`; bodies.push({ kind: "memory_candidate", id, version: 1 });
      f.raw("memory_candidate", id, { scope: "project:legacy", source_id: "old-source", kind: "preference", content: "x".repeat(900000) });
    }
    assert.throws(() => f.preflight(bodies), /content budget/);
    assert.equal(f.store.list("project_data_migration", 100).length, 0);
  } finally { await f.close(); }
});

test("legacy ownership declarations are parsed as pairs and unavailable Sources never acquire trust", async () => {
  const f = await fixture();
  try {
    const refs: Ref[] = [];
    for (const [index, owner] of [{ scope_kind: "project", scope_id: "legacy" }, { project_scope_id: "legacy" }, { project_id: "legacy" }].entries()) {
      const id = `legacy-shape-${index}`; refs.push({ kind: "memory_candidate", id, version: 1 });
      f.raw("memory_candidate", id, { ...owner, source_id: "old-source", kind: "preference", content: "Synthetic legacy declaration" });
    }
    for (const [index, locator] of [join(f.root, "does-not-exist"), tmpdir(), join(f.root, "README.md")].entries()) {
      const id = `untrusted-source-${index}`; refs.push({ kind: "knowledge_source", id, version: 1 });
      f.raw("knowledge_source", id, { scope: "project:legacy", kind: "custom", label: "Synthetic descriptor", locator, content_digest: "descriptor", trust: "verified", status: index === 2 ? "revoked" : "active" });
    }
    const plan = f.preflight(refs); f.apply(plan);
    for (const row of plan.records as Mapping[]) if (row.source.id.startsWith("untrusted-source")) {
      const record = f.store.get(row.target.kind, row.target.id);
      assert.equal(record.trust, "untrusted"); assert.equal(record.status, row.source.id.endsWith("2") ? "revoked" : "active");
    }
    f.restore(plan);
    for (const [index, owner] of [{ scope: { kind: "project" }, project_id: "legacy" }, { scope_kind: "project", project_id: "legacy" }].entries()) {
      const id = `invalid-owner-${index}`; f.raw("memory_candidate", id, owner);
      assert.throws(() => f.preflight([{ kind: "memory_candidate", id, version: 1 }]), /scope.*malformed/);
    }
    f.raw("memory_candidate", "wrong-domain", { scope: "project:legacy", _knowledge_partition: {} });
    assert.throws(() => f.preflight([{ kind: "memory_candidate", id: "wrong-domain", version: 1 }]), /owner does not match recipe/);
    f.raw("evidence", "wrong-evidence-domain", { scope: "project:legacy", _context_partition: {} });
    assert.throws(() => f.preflight([{ kind: "evidence", id: "wrong-evidence-domain", version: 1 }]), /owner does not match recipe/);
  } finally { await f.close(); }
});

test("migration refuses staged metadata conflicts and preexisting targets without a matching receipt", async () => {
  const f = await fixture();
  try {
    const plan = f.preflight();
    const source = (plan.records as Mapping[]).find(row => row.source.kind === "knowledge_source")!.target;
    const fragment = (plan.records as Mapping[]).find(row => row.source.kind === "knowledge_fragment")!.target;
    const old = f.store.get("knowledge_fragment", "fragment").content_ref as ContentRef;
    const body = f.store.contentStore.readCompatSync(old).body;
    for (const fields of [{ status: "reviewed" }, { source_id: "different-source" }, { sensitivity: "restricted" }]) {
      const staged = f.store.contentStore.writeSync({ kind: "knowledge", record_id: fragment.id, version: 1, scope: `project:${(f.identity.canonical_scope as JsonObject).id}`, status: "candidate", sensitivity: "internal", source_id: source.id, body, ...fields });
      assert.throws(() => f.apply(plan), /Staged migration content metadata conflicts/);
      await rm(staged.path);
    }
    f.store.create(source.kind, source.id, { scope: f.identity.canonical_scope, kind: "custom", label: "Do not overwrite", locator: f.root, content_digest: "existing", trust: "untrusted", status: "active" });
    assert.throws(() => f.apply(plan), /target already exists without this receipt/);
    assert.equal(f.store.get(source.kind, source.id).label, "Do not overwrite");
    assert.equal(f.store.list("project_data_migration", 100).length, 0);
  } finally { await f.close(); }
});

test("another process can change or finish migration between staging and publication without duplicate imports", async () => {
  const f = await fixture();
  const original = f.store.contentStore.writeSync.bind(f.store.contentStore);
  const storeUrl = pathToFileURL(join(import.meta.dirname, "../core/infrastructure/store.ts")).href;
  const pathsUrl = pathToFileURL(join(import.meta.dirname, "../core/infrastructure/paths.ts")).href;
  const kernelUrl = pathToFileURL(join(import.meta.dirname, "../core/scope-identity.ts")).href;
  const runChild = (plan: JsonObject, mode: string) => execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const [root, storeUrl, pathsUrl, kernelUrl, argsJson, mode] = process.argv.slice(1);
    const {CraftStore}=await import(storeUrl), {craftPaths}=await import(pathsUrl), {ScopeIdentityKernel}=await import(kernelUrl);
    const store=await new CraftStore(craftPaths(root+'/data')).open(), kernel=new ScopeIdentityKernel(store), args=JSON.parse(argsJson);
    try {
      if(mode==='change') store.save('knowledge_source','old-source',{...store.get('knowledge_source','old-source'),label:'Concurrent source update'});
      else { kernel.resolveProject({...args,action:'apply_data_migration'}); if(mode==='restore') kernel.resolveProject({...args,action:'restore_data_migration'}); }
    } finally {store.close();}
  `, f.root, storeUrl, pathsUrl, kernelUrl, JSON.stringify({ ...f.args, expected_digest: plan.plan_digest, record_refs: plan.record_refs }), mode], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    for (const mode of ["change", "restore", "apply"]) {
      const plan = f.preflight(); let called = false;
      f.store.contentStore.writeSync = input => {
        const ref = original(input);
        if (!called) { called = true; runChild(plan, mode); }
        return ref;
      };
      if (mode === "apply") {
        const result = f.apply(plan); assert.equal(result.idempotent, true);
        const migration = result.migration as JsonObject;
        assert.equal((migration.after as Ref[]).length, 8);
        f.restore(plan);
      } else assert.throws(() => f.apply(plan), mode === "change" ? /changed before publication/ : /Concurrent migration receipt conflict/);
      assert.equal(called, true);
      f.store.contentStore.writeSync = original;
      // The next source revision produces independent target ids after a restored batch.
      const source = f.store.get("knowledge_source", "old-source");
      f.store.save("knowledge_source", "old-source", { ...source, label: "Next isolated phase " + mode });
    }
  } finally { f.store.contentStore.writeSync = original; await f.close(); }
});

test("migration receipts cannot be altered, reused under another binding or restored after registry drift", async () => {
  const f = await fixture();
  try {
    const plan = f.preflight(), applied = f.apply(plan).migration as JsonObject;
    const row = f.store.database.prepare("SELECT payload_json FROM records WHERE kind='project_data_migration' AND id=?").get(String(applied.id))!;
    const original = String(row.payload_json);
    for (const update of [{ schema: "forged" }, { state: "prepared" }, { publication_fence: -1 }, { after: null }, { after: [] }]) {
      f.store.database.prepare("UPDATE records SET payload_json=? WHERE kind='project_data_migration' AND id=?").run(JSON.stringify({ ...JSON.parse(original), ...update }), String(applied.id));
      assert.throws(() => f.restore(plan), /receipt changed/);
    }
    f.store.database.prepare("UPDATE records SET payload_json=? WHERE kind='project_data_migration' AND id=?").run(original, String(applied.id));
    assert.throws(() => f.apply(plan, { migration_id: "foreign" }), /receipt binding/);
    assert.throws(() => f.apply(plan, { record_refs: [f.refs[0]] }), /receipt binding/);
    const registry = f.store.get("project_registry_migration", String(f.args.migration_id));
    f.store.save("project_registry_migration", String(registry.id), { ...registry, note: "changed after publication" });
    assert.throws(() => f.apply(plan), /Registry changed/);
    assert.throws(() => f.restore(plan), /Registry changed/);
  } finally { await f.close(); }
});

test("an existing unscoped reference prevents automatic removal of migrated identities", async () => {
  const f = await fixture();
  try {
    const plan = f.preflight();
    const target = (plan.records as Mapping[])[0].target;
    f.store.create("legacy_link", "existing-reference", { target: target.id });
    f.apply(plan);
    assert.throws(() => f.restore(plan), /acquired a reference/);
    assert.ok(f.store.find(target.kind, target.id));
    f.store.remove("legacy_link", "existing-reference");
    f.restore(plan);
  } finally { await f.close(); }
});

test("negative governance states are retained and revocation never becomes an active candidate", async () => {
  const f = await fixture();
  try {
    const refs: Ref[] = [];
    for (const [index, status] of ["rejected", "expired", "superseded", "revoked", "disputed", "conflict_pending", "stale"].entries()) {
      const id = `inactive-memory-${index}`; refs.push({ kind: "memory_candidate", id, version: 1 });
      f.raw("memory_candidate", id, { scope: "project:legacy", source_id: "old-source", kind: "preference", content: "Synthetic inactive memory", status });
    }
    f.raw("knowledge_claim", "stale-claim", { scope: "project:legacy", source_id: "old-source", kind: "fact", content: "Synthetic stale claim", status: "stale", sensitivity: "restricted" });
    refs.push({ kind: "knowledge_claim", id: "stale-claim", version: 1 });
    f.raw("knowledge_source", "disabled-source", { scope: "project:legacy", kind: "custom", label: "Disabled source", locator: f.root, content_digest: "descriptor", trust: "verified", status: "disabled" });
    refs.push({ kind: "knowledge_source", id: "disabled-source", version: 1 });
    const plan = f.preflight(refs); f.apply(plan);
    for (const row of plan.records as Mapping[]) {
      if (row.source.id === "old-source") continue;
      const old = f.store.get(row.source.kind, row.source.id), current = f.store.get(row.target.kind, row.target.id);
      const blocked = old.status === "revoked" ? "rejected" : ["disputed", "conflict_pending"].includes(String(old.status)) ? "conflict_pending" : old.status === "stale" && row.source.kind === "memory_candidate" ? "expired" : old.status;
      assert.equal(current.status, blocked);
      if (row.source.id === "disabled-source") assert.equal(current.trust, "untrusted");
    }
    f.restore(plan);
    f.raw("knowledge_source", "invalid-version-source", { scope: "project:legacy" }, 0);
    f.raw("memory_candidate", "invalid-parent-version", { scope: "project:legacy", kind: "preference", content: "Synthetic", source_id: "invalid-version-source" });
    assert.throws(() => f.preflight([{ kind: "memory_candidate", id: "invalid-parent-version", version: 1 }]), /version changed/);
  } finally { await f.close(); }
});

test("a forged after-digest cannot conceal mutation of the frozen candidate payload or content manifest", async () => {
  const f = await fixture();
  try {
    const plan = f.preflight(), applied = f.apply(plan).migration as JsonObject;
    const receipt = f.store.database.prepare("SELECT payload_json FROM records WHERE kind='project_data_migration' AND id=?").get(String(applied.id))!;
    const receiptText = String(receipt.payload_json);
    const target = (plan.records as Mapping[]).find(row => row.source.kind === "memory_ledger")!.target;
    const header = JSON.parse(String(f.store.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=?").get(target.kind, target.id)!.payload_json));
    const shard = new DatabaseSync(header._memory_partition.file);
    const text = String(shard.prepare("SELECT payload_json FROM records WHERE kind=? AND id=?").get(target.kind, target.id)!.payload_json);
    try {
      shard.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=?").run(JSON.stringify({ ...JSON.parse(text), status: "approved" }), target.kind, target.id);
      const changed = JSON.parse(receiptText);
      changed.after.find((ref: Ref) => ref.id === target.id).digest = stableDigest(f.store.find(target.kind, target.id, undefined, false));
      f.store.database.prepare("UPDATE records SET payload_json=? WHERE kind='project_data_migration' AND id=?").run(JSON.stringify(changed), String(applied.id));
      assert.throws(() => f.restore(plan), /no longer matches frozen payload/);
    } finally {
      shard.prepare("UPDATE records SET payload_json=? WHERE kind=? AND id=?").run(text, target.kind, target.id); shard.close();
      f.store.database.prepare("UPDATE records SET payload_json=? WHERE kind='project_data_migration' AND id=?").run(receiptText, String(applied.id));
    }
    const claim = (plan.records as Mapping[]).find(row => row.source.kind === "knowledge_claim")!.target;
    const content = f.store.get(claim.kind, claim.id).content_ref as ContentRef;
    const original = await readFile(content.path, "utf8");
    await writeFile(content.path, original.replace('status: "candidate"', 'status: "reviewed"'));
    assert.throws(() => f.apply(plan), /content does not match frozen input/);
    await writeFile(content.path, original);
    f.restore(plan);
  } finally { await f.close(); }
});

test("the Context MCP surface executes the migration contract and reconciles a lost response", async () => {
  const f = await fixture();
  try {
    const server = new McpServer(new CraftService(f.store), "component-context-daily");
    const oldContent = f.store.get("knowledge_fragment", "fragment").content_ref as ContentRef;
    assert.throws(() => f.store.contentStore.readCompatSync(oldContent), /outside the canonical directory/);
    const call = async (args: JsonObject) => {
      const response = await server.handle({ jsonrpc: "2.0", id: "migration", method: "tools/call", params: { name: "craft_scope_identity_resolve_project", arguments: { ...f.args, ...args } } });
      const result = response!.result as JsonObject;
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.structuredContent as JsonObject;
    };
    const plan = await call({ action: "plan_data_migration", record_refs: f.refs });
    assert.throws(() => f.store.contentStore.readCompatSync(oldContent), /outside the canonical directory/);
    const args = { expected_digest: plan.plan_digest, record_refs: plan.record_refs };
    await call({ ...args, action: "apply_data_migration" });
    assert.equal((await call({ ...args, action: "apply_data_migration" })).idempotent, true);
    assert.equal(f.store.list("project_data_migration", 100).length, 1);
    const restored = await call({ ...args, action: "restore_data_migration" });
    assert.equal((restored.migration as JsonObject).state, "restored");
    assert.equal((await call({ action: "restore_registry" })).registry_restored, true);
  } finally { await f.close(); }
});

test("registry rollback refuses normalized canonical pointers and unverified migration receipts", async () => {
  const f = await fixture();
  try {
    const canonical = f.identity.canonical_scope as { kind: string; id: string }, normalized = canonical.id.replace(/^project:/u, "");
    f.store.create("knowledge_source", "new-canonical-source", { scope: canonical, kind: "custom", label: "New business use", locator: f.root, content_digest: "test", trust: "untrusted", status: "active" });
    assert.throws(() => f.kernel.resolveProject({ ...f.args, action: "restore_registry" }), /has been used/);
    f.store.remove("knowledge_source", "new-canonical-source");
    for (const [index, declaration] of [{ scope_kind: "project", scope_id: normalized }, { project_scope_id: normalized }, { project_id: normalized }].entries()) {
      f.store.create("canonical_note", `note-${index}`, declaration);
      assert.throws(() => f.kernel.resolveProject({ ...f.args, action: "restore_registry" }), /has been used/);
      f.store.remove("canonical_note", `note-${index}`);
    }
    f.raw("project_data_migration", "fake-applied", { canonical_scope: canonical, state: "applied" });
    assert.throws(() => f.kernel.resolveProject({ ...f.args, action: "restore_registry" }), /has been used/);
    f.store.remove("project_data_migration", "fake-applied");
    f.raw("project_data_migration", "fake-restored", { canonical_scope: canonical, state: "restored" });
    assert.throws(() => f.kernel.resolveProject({ ...f.args, action: "restore_registry" }), /expected_digest/);
    assert.ok(f.store.find("project_identity", canonical.id));
    f.store.remove("project_data_migration", "fake-restored");
    assert.equal(f.kernel.resolveProject({ ...f.args, action: "restore_registry" }).registry_restored, true);
  } finally { await f.close(); }
});

test("a process crash after a shard stage leaves no published half-migration and an exact retry adopts it", async () => {
  const f = await fixture();
  try {
    const plan = f.preflight();
    const storeUrl = pathToFileURL(join(import.meta.dirname, "../core/infrastructure/store.ts")).href;
    const pathsUrl = pathToFileURL(join(import.meta.dirname, "../core/infrastructure/paths.ts")).href;
    const kernelUrl = pathToFileURL(join(import.meta.dirname, "../core/scope-identity.ts")).href;
    let killed = false;
    try {
      execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
        const [root,storeUrl,pathsUrl,kernelUrl,argsJson]=process.argv.slice(1);
        const {CraftStore}=await import(storeUrl),{craftPaths}=await import(pathsUrl),{ScopeIdentityKernel}=await import(kernelUrl);
        const store=await new CraftStore(craftPaths(root+'/data')).open(),create=store.create.bind(store);
        store.create=(kind,id,payload)=>{const record=create(kind,id,payload);if(id.includes('_import_')) process.kill(process.pid,'SIGKILL');return record;};
        new ScopeIdentityKernel(store).resolveProject(JSON.parse(argsJson));
      `, f.root, storeUrl, pathsUrl, kernelUrl, JSON.stringify({ ...f.args, action: "apply_data_migration", expected_digest: plan.plan_digest, record_refs: plan.record_refs })], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { assert.equal((error as { signal: string }).signal, "SIGKILL"); killed = true; }
    assert.equal(killed, true);
    for (const row of plan.records as Mapping[]) assert.equal(f.store.find(row.target.kind, row.target.id), null);
    assert.equal(f.store.list("project_data_migration", 100).length, 0);
    assert.equal(f.store.get("knowledge_claim", "claim").status, "reviewed");
    assert.equal(f.apply(plan).idempotent, false);
    assert.equal(f.apply(plan).idempotent, true);
    f.restore(plan);
  } finally { await f.close(); }
});

test("writer contention and a failed restore never expose partial migration state", async () => {
  const f = await fixture(), peer = new DatabaseSync(f.store.paths.databaseFile);
  try {
    const plan = f.preflight();
    f.store.database.exec("PRAGMA busy_timeout=0");
    peer.exec("BEGIN IMMEDIATE");
    assert.throws(() => f.apply(plan), (error: unknown) => (error as { stage: string }).stage === "storage_lock");
    assert.equal(f.store.list("project_data_migration", 100).length, 0);
    peer.exec("ROLLBACK");
    f.apply(plan);
    f.store.database.exec("CREATE TEMP TRIGGER fail_restore BEFORE DELETE ON main.records WHEN OLD.kind='knowledge_source' AND OLD.id LIKE '%_import_%' BEGIN SELECT RAISE(ABORT,'restore deletion failure'); END;");
    assert.throws(() => f.restore(plan), /restore deletion failure/);
    for (const row of plan.records as Mapping[]) assert.ok(f.store.find(row.target.kind, row.target.id));
    f.store.database.exec("DROP TRIGGER fail_restore");
    f.restore(plan);
    const target = (plan.records as Mapping[])[0].target;
    f.raw(target.kind, target.id, { scope: f.identity.canonical_scope });
    assert.throws(() => f.restore(plan), /has been recreated/);
    assert.throws(() => f.kernel.resolveProject({ ...f.args, action: "restore_registry" }), /has been recreated|has been used/);
  } finally { if (peer.isTransaction) peer.exec("ROLLBACK"); peer.close(); await f.close(); }
});

test("verified content ownership, sensitivity and negative manifest state survive legacy import", async () => {
  const f = await fixture();
  try {
    const oldMemory = f.store.get("memory_ledger", "memory").content_ref as ContentRef;
    const oldKnowledge = f.store.get("knowledge_fragment", "fragment").content_ref as ContentRef;
    const invalid = (id: string, ref: ContentRef, pattern: RegExp) => {
      f.raw("memory_candidate", id, { scope: "project:legacy", source_id: "old-source", kind: "preference", content_ref: ref });
      assert.throws(() => f.preflight([{ kind: "memory_candidate", id, version: 1 }]), pattern);
    };
    invalid("wrong-body-owner", oldKnowledge, /content capability owner/);
    invalid("wrong-body-id", oldMemory, /content record identity/);
    f.raw("memory_ledger", "memory", { scope: "project:legacy", source_id: "old-source", kind: "preference", content_ref: { ...oldMemory, scope: "project:foreign" } }, 2);
    assert.throws(() => f.preflight([{ kind: "memory_ledger", id: "memory", version: 2 }]), /content scope disagrees/);
    f.store.database.prepare("DELETE FROM records WHERE kind='memory_ledger' AND id='memory' AND version=2").run();
    for (const [index, fields] of [{ source_id: "wrong-source" }, { sensitivity: "unknown" }].entries()) {
      const id = `invalid-manifest-${index}`;
      const content = f.store.contentStore.writeSync({ kind: "memory", record_id: id, version: 1, scope: "project:legacy", status: "active", sensitivity: "internal", source_id: "old-source", body: "Synthetic invalid manifest", ...fields });
      invalid(id, content, index ? /sensitivity is unsupported/ : /content Source does not match/);
    }
    const refs: Ref[] = [];
    for (const [index, kind] of ["memory_ledger", "knowledge_claim"].entries()) {
      const id = `negative-manifest-${index}`;
      const content = f.store.contentStore.writeSync({ kind: index ? "knowledge" : "memory", record_id: id, version: 1, scope: "project:legacy", status: "revoked", sensitivity: "restricted", source_id: "old-source", body: "Synthetic revoked body" });
      f.raw(kind, id, { scope: "project:legacy", source_id: "old-source", kind: index ? "fact" : "preference", content_ref: content, status: index ? "reviewed" : "active", sensitivity: "public" });
      refs.push({ kind, id, version: 1 });
    }
    const globalSource = new KnowledgeSourceRegistry(f.store).sourceRegister({ source_id: "global-body-source", kind: "custom", label: "Global descriptor", scope_kind: "global", scope_id: "global", locator: f.root, content_digest: "test", trust: "verified" }).source as JsonObject;
    const globalMemory = f.store.contentStore.writeSync({ kind: "memory", record_id: "global-backed-memory", version: 1, scope: "project:legacy", status: "active", sensitivity: "restricted", source_id: String(globalSource.id), body: "Synthetic restricted global-backed memory" });
    f.raw("memory_ledger", "global-backed-memory", { project_id: "legacy", source_id: globalSource.id, kind: "preference", content_ref: globalMemory, scope_envelope: f.memory.scope_envelope });
    refs.push({ kind: "memory_ledger", id: "global-backed-memory", version: 1 });
    f.raw("knowledge_source", "legacy-source-shape", { project_id: "legacy", kind: "custom", label: "Legacy shape", locator: f.root, content_digest: "test", status: "active", trust: "bounded" });
    const material = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "legacy-fragment-shape", version: 1, scope: "project:legacy", status: "candidate", sensitivity: "internal", source_id: "legacy-source-shape", body: "Synthetic missing scope metadata" });
    const { scope: _scope, ...withoutScope } = material;
    f.raw("knowledge_fragment", "legacy-fragment-shape", { project_id: "legacy", source_id: "legacy-source-shape", content_ref: withoutScope });
    refs.push({ kind: "knowledge_fragment", id: "legacy-fragment-shape", version: 1 });
    f.raw("memory_candidate", "public-inline", { scope: "project:legacy", source_id: "old-source", kind: "preference", content: "Synthetic public inline body", sensitivity: "public" });
    refs.push({ kind: "memory_candidate", id: "public-inline", version: 1 });
    const plan = f.preflight(refs); f.apply(plan);
    for (const row of plan.records as Mapping[]) {
      const current = f.store.get(row.target.kind, row.target.id);
      if (row.source.id.startsWith("negative-manifest")) {
        assert.equal(current.status, row.source.kind === "memory_ledger" ? "rejected" : "stale"); assert.equal(current.sensitivity, "restricted");
      }
      if (row.source.id === "global-backed-memory") { assert.equal(current.sensitivity, "restricted"); assert.equal(current.status, "candidate"); }
      if (row.source.id === "public-inline") assert.equal(current.sensitivity, "public");
    }
    f.restore(plan);
  } finally { await f.close(); }
});
