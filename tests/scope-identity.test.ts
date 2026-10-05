import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScopeIdentityKernel, projectIdentityFromRoot } from "../core/scope-identity.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

test("project identity normalizes local, named and remote repository forms", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-identity-"));
  try {
    const local = projectIdentityFromRoot(root);
    assert.equal(local.project_kind, "local_fingerprint");
    assert.notDeepEqual(projectIdentityFromRoot(root, "named").canonical_scope, local.canonical_scope);
    assert.equal(projectIdentityFromRoot(join(root, "missing"), "named").project_kind, "user_named");
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "remote.origin.url", "git@Example.com:Team/Repo.git"]);
    const ssh = projectIdentityFromRoot(root);
    assert.equal(ssh.project_kind, "git_remote");
    assert.equal(typeof ssh.remote_digest, "string");
    execFileSync("git", ["-C", root, "config", "remote.origin.url", "https://example.com/team/repo.git"]);
    assert.deepEqual(projectIdentityFromRoot(root).canonical_scope, ssh.canonical_scope);
    execFileSync("git", ["-C", root, "config", "remote.origin.url", "MIRROR"]);
    assert.equal(projectIdentityFromRoot(root).project_kind, "git_remote");
    execFileSync("git", ["-C", root, "config", "remote.origin.url", ""]);
    assert.equal(projectIdentityFromRoot(root).project_kind, "local_fingerprint");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identity and aliases are idempotent and scope stacks remain explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-kernel-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    assert.throws(() => kernel.resolveProject({}), /project_root or cwd/);
    const created = kernel.resolveProject({ cwd: root, project_id: "named" });
    const scope = (created.identity as JsonObject).canonical_scope as { kind: "project"; id: string };
    assert.equal(kernel.resolveProject({ project_root: root, project_id: "named" }).idempotent, true);
    for (const invalid of [{}, { scope_kind: "team", scope_id: scope.id, alias_kind: "path", alias: root },
      { scope_kind: "project", scope_id: "", alias_kind: "path", alias: root },
      { scope_kind: "project", scope_id: scope.id, alias_kind: "path", alias: " " },
      { scope_kind: "project", scope_id: scope.id, alias_kind: "invalid", alias: root }]) assert.throws(() => kernel.bindAlias(invalid), /Scope Alias is invalid/);
    const legacy = { scope_kind: "project", scope_id: scope.id, alias_kind: "legacy", alias: "old-id" };
    const bound = kernel.bindAlias(legacy);
    assert.equal(kernel.bindAlias(legacy).idempotent, true);
    const alias = bound.alias as JsonObject;
    store.save("scope_alias", String(alias.id), { ...alias, identity_digest: "wrong" });
    assert.throws(() => kernel.bindAlias(legacy), /idempotency conflict/);
    store.save("scope_alias", String(alias.id), { ...alias, status: "active" });
    assert.throws(() => kernel.migrateAlias({ project_root: root }), /legacy_scope_id/);
    assert.equal(kernel.migrateAlias({ project_root: root, project_id: "named", legacy_scope_id: "older" }).legacy_records_preserved, true);
    const project = kernel.resolveStack(scope, { session_scope_id: "session", team_scope_id: "team", organization_scope_id: "org", user_scope_id: "user", include_global: true });
    assert(project.attempted_scopes.some(item => item.kind === "global"));
    assert(project.excluded_scopes.some(item => item.reason === "session_scope_requires_task_request"));
    const inherited = kernel.resolveStack({ kind: "task", id: "task" }, { project_scope_id: scope.id, session_scope_id: "session" });
    assert(inherited.attempted_scopes.some(item => item.kind === "session"));
    assert(kernel.resolveStack({ kind: "workspace", id: "workspace" }, { project_root: root, project_id: "named" }).attempted_scopes.some(item => item.id === scope.id));
    assert(kernel.resolveStack({ kind: "workspace", id: "other-workspace" }, { project_root: root }).attempted_scopes.some(item => item.kind === "project"));
    assert.equal(kernel.resolveStack({ kind: "workspace", id: "workspace" }).canonical_scope.kind, "workspace");
    assert(kernel.resolveStack({ kind: "project", id: "old-id" }).matched_aliases.length > 0);
    assert.equal(kernel.resolveStack({ kind: "project", id: "unknown" }).canonical_scope.id, "unknown");
    for (const kind of ["session", "team", "organization", "user", "global"] as const) {
      const result = kernel.resolveStack({ kind, id: kind }, { session_scope_id: "session", team_scope_id: "team", organization_scope_id: "org", user_scope_id: "user", include_global: true });
      assert.equal(result.canonical_scope.kind, kind);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
