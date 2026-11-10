import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { projectIdentityFromRoot, ScopeIdentityKernel } from "../core/scope-identity.ts";

test("registry migration is preflight-bound, preserves legacy data and restores unused registration", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "craft-registry-migration-")));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    const canonicalId = String((projectIdentityFromRoot(root).canonical_scope as JsonObject).id);
    kernel.resolveProject({ project_root: root });
    kernel.bindAlias({ scope_kind: "project", scope_id: canonicalId, alias_kind: "legacy", alias: "legacy" });
    kernel.bindAlias({ scope_kind: "project", scope_id: "legacy", alias_kind: "path", alias: root });
    store.create("project_identity", "legacy", { canonical_scope: { kind: "project", id: "legacy" }, local_path_alias: root });
    const note = store.create("legacy_project_note", "note", { scope: "project:legacy", content: "retain original content" });
    const plan = kernel.resolveProject({ project_root: root, action: "plan_registry_migration" });
    assert.equal(plan.status, "migration_required");
    const args = { project_root: root, action: "apply_registry_migration", expected_digest: plan.plan_digest, legacy_scope_id: "legacy" };
    assert.throws(() => kernel.resolveProject({ ...args, expected_digest: "wrong" }), /plan changed/);
    assert.throws(() => kernel.resolveProject({ ...args, legacy_scope_id: "other" }), /single preflight/);
    const result = kernel.resolveProject(args), migration = result.migration as JsonObject;
    assert.equal(kernel.resolveProject(args).idempotent, true);
    assert.throws(() => kernel.resolveProject({ project_root: join(root, "data"), action: "restore_registry", migration_id: migration.id }), /different project/);
    assert.equal(result.registry_migrated, true); assert.equal(result.data_migrated, false);
    assert.equal(kernel.resolveProject({ project_root: root }).idempotent, true);
    assert.deepEqual(store.get("legacy_project_note", "note"), note);
    const scope = (result.identity as JsonObject).canonical_scope as { kind: "project"; id: string };
    assert.ok(kernel.resolveStack(scope, { project_root: root }).excluded_scopes.some(row => (row.scope as JsonObject).id === "legacy"));
    const restored = kernel.resolveProject({ project_root: root, action: "restore_registry", migration_id: migration.id });
    assert.equal(restored.registry_restored, true);
    assert.equal(kernel.resolveProject({ project_root: root, action: "restore_registry", migration_id: migration.id }).idempotent, true);
    assert.throws(() => kernel.resolveProject({ project_root: root }), /MIGRATION_REQUIRED/);
    assert.equal(store.get("project_identity", "legacy").local_path_alias, root);
    assert.deepEqual(store.get("legacy_project_note", "note"), note);

    const nextPlan = kernel.resolveProject({ project_root: root, action: "plan_registry_migration" });
    const next = kernel.resolveProject({ ...args, expected_digest: nextPlan.plan_digest });
    store.create("canonical_project_note", "used", { scope: scope.id });
    assert.throws(() => kernel.resolveProject({ project_root: root, action: "restore_registry", migration_id: (next.migration as JsonObject).id }), /has been used/);
    store.remove("canonical_project_note", "used");
    const changedRef = ((next.migration as JsonObject).after as JsonObject[])[0];
    store.save(String(changedRef.kind), String(changedRef.id), { ...store.get(String(changedRef.kind), String(changedRef.id)), changed: true });
    assert.throws(() => kernel.resolveProject({ project_root: root, action: "restore_registry", migration_id: (next.migration as JsonObject).id }), /registry changed/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("registry migration rejects missing digests, stale receipts and unapplied restore receipts", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "craft-registry-migration-guards-")));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    kernel.bindAlias({ scope_kind: "project", scope_id: "legacy", alias_kind: "path", alias: root });
    store.create("project_identity", "legacy", { canonical_scope: { kind: "project", id: "legacy" }, local_path_alias: root });
    const plan = kernel.resolveProject({ project_root: root, action: "plan_registry_migration" });
    assert.throws(() => kernel.resolveProject({ project_root: root, action: "apply_registry_migration" }), /expected_digest/u);
    const args = { project_root: root, action: "apply_registry_migration", expected_digest: plan.plan_digest, legacy_scope_id: "legacy" };
    const applied = kernel.resolveProject(args).migration as JsonObject;
    assert.throws(() => kernel.resolveProject({ ...args, legacy_scope_id: "other" }), /not reusable/u);
    const first = (applied.after as JsonObject[])[0]!;
    store.save(String(first.kind), String(first.id), { ...store.get(String(first.kind), String(first.id)), changed: true });
    assert.throws(() => kernel.resolveProject(args), /registry changed/u);
    assert.throws(() => kernel.resolveProject({ project_root: root, action: "restore_registry" }), /migration_id is required/u);
    store.create("project_registry_migration", "prepared", { project_root: root, state: "prepared" });
    assert.throws(() => kernel.resolveProject({ project_root: root, action: "restore_registry", migration_id: "prepared" }), /not applied/u);
    assert.throws(() => kernel.resolveProject({ project_root: root, action: "unsupported" }), /Unknown project identity action/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("diagnosis reports bounded conflicting aliases without assuming every stored alias is well formed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "craft-registry-diagnosis-bounds-")));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    kernel.bindAlias({ scope_kind: "project", scope_id: "legacy", alias_kind: "path", alias: root });
    for (let index = 0; index < 101; index += 1) {
      kernel.bindAlias({ scope_kind: "project", scope_id: "legacy", alias_kind: "path", alias: join(root, `unavailable-${index}`) });
    }
    store.create("scope_alias", "matching-legacy-alias", { status: "active", alias_kind: "path", alias: root, scope: { kind: "project", id: "legacy" } });
    store.create("scope_alias", "malformed-scope", { status: "active", alias_kind: "path", alias: root, scope: null });
    store.create("scope_alias", "missing-scope", { status: "active", alias_kind: "path", alias: join(root, "missing-scope") });
    store.create("scope_alias", "malformed-alias", { status: "active", alias_kind: "path", alias: 42, scope: { kind: "project", id: "legacy" } });
    store.create("scope_alias", "unrelated-alias", { status: "active", alias_kind: "path", alias: join(root, "unrelated"), scope: { kind: "project", id: "other" } });
    store.create("scope_alias", "inactive-alias", { status: "inactive", alias_kind: "path", alias: join(root, "inactive"), scope: { kind: "project", id: "legacy" } });
    assert.equal(store.get("scope_alias", "malformed-scope").scope, null);
    assert.equal(store.get("scope_alias", "missing-scope").scope, undefined);
    const result = kernel.resolveProject({ project_root: root, action: "plan_registry_migration" });
    assert.equal(result.status, "inventory_incomplete");
    assert.equal(result.truncated, true);
    assert.equal((result.conflicting_alias_refs as JsonObject[]).length, 100);
    assert.equal((result.legacy_scope_ids as string[]).includes(""), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
