import { lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { payload, stableDigest } from "./digest.ts";
import { scopeEnvelope } from "../common/craft-common-base/src/scope-policy.ts";
import { text, type ScopeRef } from "./validation.ts";
import { MarkdownContentStore, validateContentBody, type ContentRef } from "../common/craft-common-store-local/src/content-store.ts";
import { projectKnowledgeContentDirectory } from "./project-knowledge-content.ts";

type Ref = { kind: string; id: string; version: number };
type Recipe = { fields: string[]; refs: Record<string, string>; arrays?: Record<string, string> };
const RECIPES: Record<string, Recipe> = {
  knowledge_source: { fields: ["kind", "label", "locator", "content_digest", "access"], refs: {} },
  knowledge_source_revision: { fields: ["source_revision_digest", "locator_digest", "file_count", "immutable"], refs: { source_id: "knowledge_source" } },
  knowledge_document: { fields: ["root_digest", "path", "locator", "content_digest", "bytes", "title"], refs: { source_id: "knowledge_source", source_revision_id: "knowledge_source_revision" } },
  knowledge_fragment: { fields: ["document_digest", "path", "locator", "content_digest", "immutable"], refs: { source_id: "knowledge_source", source_revision_id: "knowledge_source_revision", document_id: "knowledge_document" } },
  evidence: { fields: ["source_type", "locator", "claim", "content_digest", "observed_at"], refs: { source_id: "knowledge_source", source_revision_id: "knowledge_source_revision", fragment_id: "knowledge_fragment" } },
  knowledge_claim: { fields: ["kind", "title", "content_digest", "valid_until", "sensitivity"], refs: { source_id: "knowledge_source", source_revision_id: "knowledge_source_revision", document_id: "knowledge_document", fragment_id: "knowledge_fragment" }, arrays: { evidence_ids: "evidence" } },
  memory_ledger: { fields: ["kind", "topic", "sensitivity", "valid_until", "observed_at", "effective_from"], refs: { source_id: "knowledge_source" }, arrays: { evidence_ids: "evidence" } },
  memory_candidate: { fields: ["kind", "topic", "sensitivity", "valid_until", "observed_at", "effective_from"], refs: { source_id: "knowledge_source" }, arrays: { evidence_ids: "evidence" } },
  experience_observation: { fields: ["kind", "scenario_key", "finding_digest", "content_free"], refs: {}, arrays: { evidence_ids: "evidence" } },
};
const MEMORY_BLOCKED_STATES = new Map([["rejected", "rejected"], ["revoked", "rejected"], ["expired", "expired"], ["stale", "expired"], ["superseded", "superseded"], ["disputed", "conflict_pending"], ["conflict_pending", "conflict_pending"]]);
type Item = { ref: Ref; digest: string; body?: string; target: Ref; next: JsonObject };
type Built = { plan: JsonObject; items: Item[] };
const key = (ref: Pick<Ref, "kind" | "id">) => JSON.stringify([ref.kind, ref.id]);
const sameScope = (a: ScopeRef, b: ScopeRef) => a.kind === b.kind && (a.kind === "project" ? a.id.replace(/^project:/u, "") === b.id.replace(/^project:/u, "") : a.id === b.id);

function scope(value: unknown): ScopeRef {
  if (typeof value === "string") {
    if (value === "global") return { kind: "global", id: "global" };
    const index = value.indexOf(":");
    if (index > 0) return scope({ kind: value.slice(0, index), id: value.slice(index + 1) });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as JsonObject;
    if (typeof item.kind === "string" && typeof item.id === "string" && item.id.trim()
      && ["project", "global", "user", "session", "task", "workspace", "team", "organization", "legacy"].includes(item.kind)) return { kind: item.kind as ScopeRef["kind"], id: item.id };
  }
  throw new Error("Migration record scope is unavailable or malformed");
}

function roots(value: unknown): Ref[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new Error("record_refs must contain 1..50 pinned records");
  const refs = value.map(raw => {
    const item = raw as Partial<Ref> | null;
    if (!item || typeof item.kind !== "string" || typeof item.id !== "string" || !item.kind || !item.id || item.kind.length > 128 || item.id.length > 1024
      || !Number.isSafeInteger(item.version) || Number(item.version) < 1) throw new Error("record_refs require kind, id and positive version");
    return item as Ref;
  });
  if (new Set(refs.map(key)).size !== refs.length) throw new Error("record_refs must be unique");
  return refs.sort((a, b) => key(a).localeCompare(key(b)));
}

function build(store: CraftStore, identity: JsonObject, args: JsonObject): Built {
  const selected = roots(args.record_refs);
  return store.readSnapshot(database => {
    if (typeof args.migration_id !== "string" || !args.migration_id) throw new Error("registry migration_id is required");
    const migration = store.get("project_registry_migration", args.migration_id);
    if (migration.state !== "applied" || migration.project_root !== identity.local_path_alias || stableDigest(migration.canonical_scope) !== stableDigest(identity.canonical_scope)) throw new Error("Data migration requires an applied registry migration for this exact project");
    const canonical = identity.canonical_scope as ScopeRef, legacy = { kind: "project", id: String(migration.legacy_scope_id) } as ScopeRef;
    // Only this explicit migration reader maps old content ownership to the
    // already verified root. Normal service retrieval keeps its strict resolver.
    const knowledgeReader = new MarkdownContentStore(store.paths);
    knowledgeReader.setProjectKnowledgeDirectoryResolver((_requested, options) => {
      return projectKnowledgeContentDirectory(store, `project:${canonical.id}`, { ...options, project_root: String(identity.local_path_alias), create: false });
    });
    const items = new Map<string, Item>(), external = new Map<string, Ref & { digest: string }>(), visiting = new Set<string>();
    let bytes = 0;
    function visit(kind: string, id: string, expected?: number, root = false): Ref {
      const recipe = Object.hasOwn(RECIPES, kind) ? RECIPES[kind]! : null;
      if (!recipe) throw new Error(`No typed migration recipe for ${kind}; indexes and execution/review receipts must be rebuilt or revalidated`);
      const k = key({ kind, id });
      const row = database.prepare("SELECT payload_json,version FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id) as { payload_json: string; version: number } | undefined;
      if (!row || !Number.isSafeInteger(row.version) || row.version < 1 || expected !== undefined && row.version !== expected) throw new Error(`Migration record missing or version changed: ${kind}/${id}`);
      const header = JSON.parse(row.payload_json) as JsonObject;
      const domains = ["memory", "knowledge", "experience", "context", "evolution"].filter(domain => header[`_${domain}_partition`] !== undefined);
      if (domains.length > 1) throw new Error("Migration capability owner is ambiguous");
      const expectedDomain = kind.startsWith("memory_") ? "memory" : kind === "experience_observation" ? "experience" : "knowledge";
      if (domains.length && (kind === "evidence" ? !["memory", "knowledge", "experience"].includes(domains[0]!) : domains[0] !== expectedDomain)) throw new Error("Migration capability owner does not match recipe");
      const owner = scope(header.scope ?? (typeof header.scope_kind === "string" ? { kind: header.scope_kind, id: header.scope_id } : header.project_scope_id ? { kind: "project", id: header.project_scope_id } : { kind: "project", id: header.project_id }));
      if (!sameScope(owner, legacy) && (root || !["knowledge_source", "evidence"].includes(kind) || !["global", "user"].includes(owner.kind))) throw new Error("Migration dependency belongs to another scope");
      if (items.has(k)) return items.get(k)!.target;
      if (external.has(k)) return external.get(k)!;
      if (items.size + external.size + visiting.size >= 100) throw new Error("Migration dependency budget exceeds 100 records");
      const record = store.find(kind, id, row.version, false)!;
      if (Buffer.byteLength(JSON.stringify(record)) > 1048576) throw new Error("Migration record exceeds 1 MiB");
      if (record.scope !== undefined && !sameScope(scope(record.scope), owner)) throw new Error("Migration body and published owner disagree");
      const ref = { kind, id, version: row.version }, digest = stableDigest(record);
      bytes += Buffer.byteLength(JSON.stringify(record));
      if (bytes > 8 * 1048576) throw new Error("Migration input exceeds 8 MiB");
      if (!sameScope(owner, legacy) && kind === "knowledge_source") { external.set(k, { ...ref, digest }); return ref; }
      visiting.add(k);
      const next: JsonObject = {};
      for (const field of recipe.fields) {
        const value = record[field];
        if (value === undefined) continue;
        if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error(`Migration scalar field is malformed: ${field}`);
        next[field] = value;
      }
      for (const [field, parentKind] of Object.entries(recipe.refs)) {
        const value = record[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== "string" || !value) throw new Error(`Migration reference is malformed: ${field}`);
        const parent = visit(parentKind, value);
        next[field] = parent.id;
        if (field === "source_id") next.source_version = parent.version;
      }
      for (const [field, parentKind] of Object.entries(recipe.arrays ?? {})) {
        const value = record[field] ?? [];
        if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id) || new Set(value).size !== value.length) throw new Error(`Migration references are malformed: ${field}`);
        next[field] = value.map(id => visit(parentKind, id as string).id);
      }
      if (["knowledge_source_revision", "knowledge_document", "knowledge_fragment", "knowledge_claim", "memory_ledger", "memory_candidate"].includes(kind)) text(next.source_id, "migration source_id");
      const targetKind = kind === "memory_ledger" ? "memory_candidate" : kind;
      const previousEnvelope = scopeEnvelope(record.scope_envelope, record.scope === undefined ? owner : scope(record.scope));
      next.scope = targetKind === "memory_candidate" || targetKind === "knowledge_source" ? canonical : `project:${canonical.id}`;
      next.scope_envelope = { ...previousEnvelope, applicability: canonical, custody: sameScope(previousEnvelope.custody, owner) ? canonical : previousEnvelope.custody,
        audience: previousEnvelope.audience.mode === "public" ? { mode: "scoped", principal_ids: [] } : previousEnvelope.audience };
      next.migration_origin = { ...ref, digest, registry_migration_id: migration.id, previous_status: record.status ?? null };
      next.revalidation_required = true; next.publication_allowed = false; next.execution_authority = false;
      next.status = kind === "knowledge_source" ? (record.status === "active" ? "active" : record.status === "revoked" ? "revoked" : "disabled") : kind === "knowledge_claim" || targetKind === "memory_candidate" ? "candidate" : "revalidation_required";
      if (targetKind === "memory_candidate" && MEMORY_BLOCKED_STATES.has(String(record.status))) next.status = MEMORY_BLOCKED_STATES.get(String(record.status));
      if (kind === "knowledge_claim" && ["rejected", "disputed", "stale", "expired", "superseded", "revoked"].includes(String(record.status))) next.status = record.status;
      if (kind === "knowledge_source") {
        for (const field of ["kind", "label", "locator", "content_digest"]) text(next[field], `migration source ${field}`);
        let contained = false;
        try { const path = realpathSync(resolve(String(identity.local_path_alias), String(record.locator))), part = relative(String(identity.local_path_alias), path); contained = part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); } catch { /* Missing/external source descriptors do not acquire trust. */ }
        next.trust = contained && record.status === "active" && ["bounded", "verified"].includes(String(record.trust)) ? "bounded" : "untrusted";
        next.access = "read_only";
      }
      if (kind === "evidence" || targetKind === "memory_candidate") next.confidence = "unverified";
      if (kind === "evidence") {
        if (domains.length) next.metadata = { capability_owner: domains[0] };
      }
      if (kind === "knowledge_claim" || targetKind === "memory_candidate") next.review = null;
      let body: string | undefined;
      let materialSensitivity = next.sensitivity ?? "internal";
      if ((record.content_ref !== undefined || typeof record.content === "string") && !["memory_candidate", "knowledge_claim", "knowledge_fragment"].includes(targetKind)) throw new Error("No typed content recipe for this record");
      if (record.content_ref !== undefined) {
        const content = record.content_ref as ContentRef;
        if (!content || typeof content.path !== "string" || lstatSync(content.path).size > 1048576) throw new Error("Migration content exceeds 1 MiB or has an invalid reference");
        const expectedKind = kind.startsWith("memory_") ? "memory" : "knowledge";
        if (content.kind !== expectedKind) throw new Error("Migration content capability owner does not match recipe");
        if (content.record_id !== id && !(kind === "knowledge_claim" && content.record_id === record.fragment_id)) throw new Error("Migration content record identity does not match");
        if (content.scope !== undefined && !sameScope(scope(content.scope), owner)) throw new Error("Migration content scope disagrees with the source owner");
        const declared = scope(record.scope ?? store.find("knowledge_source", String(record.source_id), undefined, false)!.scope ?? owner);
        const expected = sameScope(declared, owner) ? declared : owner;
        const reader = content.kind === "knowledge" ? knowledgeReader : store.contentStore;
        const material = reader.readCompatSync(content, `${expected.kind}:${expected.id}`);
        if (material.manifest.source_id !== record.source_id) throw new Error("Migration content Source does not match the record");
        (next.migration_origin as JsonObject).content_manifest_digest = stableDigest(material.manifest);
        if (next.status === "candidate" && ["revoked", "expired", "superseded", "disputed"].includes(material.manifest.status)) next.status = targetKind === "memory_candidate" ? "rejected" : "stale";
        materialSensitivity = material.manifest.sensitivity;
        body = material.body;
      } else if (typeof record.content === "string") body = record.content;
      if (body !== undefined) {
        validateContentBody(body);
        const levels = ["public", "internal", "restricted"], declaredRank = levels.indexOf(String(next.sensitivity ?? materialSensitivity)), materialRank = levels.indexOf(String(materialSensitivity));
        if (declaredRank < 0 || materialRank < 0) throw new Error("Migration content sensitivity is unsupported");
        next.sensitivity = levels[Math.max(declaredRank, materialRank)];
        bytes += Buffer.byteLength(body);
        if (bytes > 8 * 1048576) throw new Error("Migration content budget exceeded");
        if (targetKind === "memory_candidate") { next.content = body; next.content_digest = stableDigest(body); }
        else next.content_digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
      }
      if ((targetKind === "memory_candidate" || kind === "knowledge_claim" || kind === "knowledge_fragment") && body === undefined) throw new Error("Migration content body is missing");
      // Review/effect bindings, executable releases and derived caches are never copied.
      if (targetKind === "memory_candidate") { next.conflict_ids = []; next.conflicting_memory_ids = []; next.proposed_by = "project-data-migration"; }
      next.identity_digest = kind === "knowledge_source" ? stableDigest(Object.fromEntries(["kind", "label", "scope", "scope_envelope", "locator", "content_digest", "trust", "access"].map(field => [field, next[field]]))) : stableDigest(next);
      const target = { kind: targetKind, id: `${targetKind}_import_${stableDigest({ schema: "craft.project-data-migration.v1", registry: migration.id, ref, source_digest: digest, bindings: next }).slice(-40)}`, version: 1 };
      const item = { ref, digest, body, target, next };
      items.set(k, item); visiting.delete(k);
      return target;
    }
    for (const ref of selected) visit(ref.kind, ref.id, ref.version, true);
    const ordered = [...items.values()];
    const plan: JsonObject = { schema: "craft.project-data-migration.v1", registry_migration_id: migration.id, registry_digest: stableDigest(migration), project_root: identity.local_path_alias,
      canonical_scope: canonical, record_refs: selected, records: ordered.map(item => ({ source: item.ref, source_digest: item.digest, target: item.target, payload_digest: stableDigest(item.next), body_digest: item.body === undefined ? null : stableDigest(item.body) })),
      external_refs: [...external.values()], input_bytes: bytes, source_retained: true, raw_content_stored: false, review_execution_authority_transferred: false, coverage: "selected_roots_and_typed_dependencies" };
    return { plan: { ...plan, plan_digest: stableDigest(plan) }, items: ordered };
  });
}

/** Explicit copy migration. Originals stay immutable; receipts contain no business text. */
export function projectDataMigration(store: CraftStore, identity: JsonObject, args: JsonObject): JsonObject {
  if (!["plan_data_migration", "apply_data_migration", "restore_data_migration"].includes(String(args.action))) throw new Error("Unknown data migration action");
  if (args.action === "plan_data_migration") return build(store, identity, args).plan;
  if (typeof args.expected_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(args.expected_digest)) throw new Error("expected_digest from plan_data_migration is required");
  const id = `project_data_migration_${args.expected_digest.slice(-40)}`;
  if (args.action === "restore_data_migration") return restore(store, identity, args, id);
  const previous = store.find("project_data_migration", id);
  if (previous) {
    assertReceipt(previous, args.expected_digest);
    if (previous.project_root !== identity.local_path_alias || previous.registry_migration_id !== args.migration_id || stableDigest(previous.record_refs) !== stableDigest(roots(args.record_refs)) || previous.state !== "applied") throw new Error("Data migration receipt binding changed or was restored");
    if (stableDigest(store.get("project_registry_migration", String(args.migration_id))) !== previous.registry_digest) throw new Error("Registry changed after data migration");
    assertTargets(store, previous);
    return { migration: previous, idempotent: true };
  }
  const built = build(store, identity, args);
  if (built.plan.plan_digest !== args.expected_digest) throw new Error("Data migration plan changed; run preflight again");
  // Content files are immutable and staged before acquiring the publication writer.
  for (const item of built.items) if (item.body !== undefined && item.target.kind !== "memory_candidate") {
    item.next.content_ref = store.contentStore.writeSync({ kind: "knowledge", record_id: item.target.id, version: 1, scope: `project:${(identity.canonical_scope as ScopeRef).id}`, status: "candidate", sensitivity: String(item.next.sensitivity), source_id: String(item.next.source_id), body: item.body, project_root: String(identity.local_path_alias) });
    const staged = store.contentStore.readSync(item.next.content_ref as ContentRef).manifest;
    if (staged.status !== "candidate" || staged.source_id !== String(item.next.source_id) || staged.sensitivity !== String(item.next.sensitivity)) throw new Error("Staged migration content metadata conflicts");
    item.next.content_digest = (item.next.content_ref as ContentRef).digest;
  }
  return store.transaction(() => {
    const raced = store.find("project_data_migration", id);
    if (raced) { assertReceipt(raced, args.expected_digest as string); if (raced.state !== "applied") throw new Error("Concurrent migration receipt conflict"); assertTargets(store, raced); return { migration: raced, idempotent: true }; }
    const checked = build(store, identity, args);
    if (checked.plan.plan_digest !== args.expected_digest) throw new Error("Data migration changed before publication; run preflight again");
    const after: JsonObject[] = [];
    for (const item of built.items) {
      if (store.find(item.target.kind, item.target.id)) throw new Error("Migration target already exists without this receipt");
      const saved = store.create(item.target.kind, item.target.id, item.next);
      after.push({ ...item.target, digest: stableDigest(saved) });
    }
    const fence = store.database.prepare("SELECT COALESCE(MAX(rowid),0) value FROM records").get()!.value;
    const migration = store.create("project_data_migration", id, { ...built.plan, state: "applied", after, publication_fence: Number(fence) });
    return { migration, idempotent: false };
  });
}

function assertTargets(store: CraftStore, migration: JsonObject): void {
  for (const ref of migration.after as Array<Ref & { digest: string }>) {
    const record = store.find(ref.kind, ref.id, undefined, false);
    if (!record || record.version !== ref.version || stableDigest(record) !== ref.digest) throw new Error("Migration target changed or is missing; automatic restore/reuse refused");
    const frozen = (migration.records as Array<{ target: Ref; payload_digest: string; body_digest: string | null }>).find(item => key(item.target) === key(ref))!;
    const normalized = payload(record);
    if (["knowledge_claim", "knowledge_fragment"].includes(ref.kind) && frozen.body_digest !== null) {
      const content = record.content_ref as ContentRef;
      const material = store.contentStore.readSync(content);
      if (content.kind !== "knowledge" || content.record_id !== ref.id || content.version !== 1 || content.scope !== `project:${(migration.canonical_scope as ScopeRef).id}`
        || stableDigest(material.body) !== frozen.body_digest || material.manifest.status !== "candidate" || material.manifest.source_id !== String(record.source_id)
        || material.manifest.sensitivity !== String(record.sensitivity)) throw new Error("Migration target content does not match frozen input");
      delete normalized.content_ref;
    }
    if (stableDigest(normalized) !== frozen.payload_digest) throw new Error("Migration target no longer matches frozen payload");
  }
}

function assertReceipt(migration: JsonObject, expected: string): void {
  const fields = ["schema", "registry_migration_id", "registry_digest", "project_root", "canonical_scope", "record_refs", "records", "external_refs", "input_bytes", "source_retained", "raw_content_stored", "review_execution_authority_transferred", "coverage"];
  if (migration.plan_digest !== expected || stableDigest(Object.fromEntries(fields.map(field => [field, migration[field]]))) !== expected
    || !["applied", "restored"].includes(String(migration.state)) || migration.version !== (migration.state === "applied" ? 1 : 2)
    || !Number.isSafeInteger(migration.publication_fence) || Number(migration.publication_fence) < 0
    || !Array.isArray(migration.after) || stableDigest((migration.after as Ref[]).map(ref => ({ kind: ref.kind, id: ref.id, version: ref.version }))) !== stableDigest((migration.records as Array<{ target: Ref }>).map(item => item.target))) throw new Error("Data migration receipt changed; automatic restore/reuse refused");
}

function restore(store: CraftStore, identity: JsonObject, args: JsonObject, id: string): JsonObject {
  return store.transaction(database => {
    const migration = store.get("project_data_migration", id);
    assertReceipt(migration, args.expected_digest as string);
    if (migration.project_root !== identity.local_path_alias || migration.registry_migration_id !== args.migration_id || stableDigest(migration.canonical_scope) !== stableDigest(identity.canonical_scope)) throw new Error("Data migration belongs to another project or registry");
    if (migration.state === "restored") {
      if ((migration.after as Ref[]).some(ref => store.find(ref.kind, ref.id, undefined, false) !== null)) throw new Error("Restored migration target has been recreated; automatic reuse refused");
      return { migration, idempotent: true };
    }
    if (stableDigest(store.get("project_registry_migration", String(args.migration_id))) !== migration.registry_digest) throw new Error("Registry changed after data migration");
    assertTargets(store, migration);
    const own = new Set((migration.after as Ref[]).map(key));
    // Shard headers omit some references. Any later publication outside this batch
    // therefore requires an explicit dependency review before automatic removal.
    const candidates = database.prepare("SELECT kind,id FROM records WHERE rowid>?").iterate(Number(migration.publication_fence));
    for (const raw of candidates) {
      const row = raw as { kind: string; id: string };
      if (row.kind === "project_data_migration" && row.id === id || own.has(key(row))) continue;
      throw new Error("Subsequent publication requires dependency review; automatic restore refused");
    }
    // Also detect unscoped references to new identities, without reading all shard bodies.
    for (const ref of migration.after as Ref[]) {
      const used = database.prepare("SELECT kind,id FROM records WHERE instr(payload_json,?)>0").iterate(ref.id);
      for (const raw of used) {
        const row = raw as { kind: string; id: string };
        if (row.kind === "project_data_migration" && row.id === id || own.has(key(row))) continue;
        throw new Error("Migration target has acquired a reference; automatic restore refused");
      }
    }
    for (const ref of [...migration.after as Ref[]].reverse()) store.remove(ref.kind, ref.id);
    const restored = store.save("project_data_migration", id, { ...payload(migration), state: "restored", content_files_retained_for_audit: true });
    return { migration: restored, idempotent: false };
  });
}
