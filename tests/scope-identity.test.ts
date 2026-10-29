import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ScopeIdentityKernel, projectIdentityFromRoot } from "../core/scope-identity.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { sessionStorageScopeId } from "../common/craft-common-store-local/src/paths.ts";

test("project identity binds real roots and does not merge identical remotes", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-identity-"));
  try {
    const local = projectIdentityFromRoot(root);
    assert.equal(local.project_kind, "local_fingerprint");
    assert.throws(() => projectIdentityFromRoot(root, "named"), /project_id conflicts/u);
    assert.deepEqual(projectIdentityFromRoot(root, String((local.canonical_scope as JsonObject).id)).canonical_scope, local.canonical_scope);
    assert.throws(() => projectIdentityFromRoot(join(root, "missing"), "named"));
    await writeFile(join(root, "file"), "x");
    assert.throws(() => projectIdentityFromRoot(join(root, "file")), /directory/u);
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "remote.origin.url", "git@Example.com:Team/Repo.git"]);
    const ssh = projectIdentityFromRoot(root);
    assert.equal(ssh.project_kind, "local_fingerprint");
    assert.equal(typeof ssh.remote_digest, "string");
    execFileSync("git", ["-C", root, "config", "remote.origin.url", "https://example.com/team/repo.git"]);
    assert.deepEqual(projectIdentityFromRoot(root).canonical_scope, ssh.canonical_scope);
    execFileSync("git", ["-C", root, "config", "remote.origin.url", "MIRROR"]);
    assert.equal(projectIdentityFromRoot(root).project_kind, "local_fingerprint");
    execFileSync("git", ["-C", root, "config", "remote.origin.url", ""]);
    assert.equal(projectIdentityFromRoot(root).project_kind, "local_fingerprint");
    const sibling = join(root, "other"); await mkdir(sibling); execFileSync("git", ["-C", sibling, "init", "-q"]);
    execFileSync("git", ["-C", sibling, "config", "remote.origin.url", "https://example.com/team/repo.git"]);
    assert.notDeepEqual(projectIdentityFromRoot(sibling).canonical_scope, ssh.canonical_scope);
    await mkdir(join(root, "subdir"));
    assert.deepEqual(projectIdentityFromRoot(join(root, "subdir")).canonical_scope, ssh.canonical_scope);
    await symlink(root, join(sibling, "link"));
    assert.deepEqual(projectIdentityFromRoot(join(sibling, "link")).canonical_scope, ssh.canonical_scope);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project identity fails closed when Git discovery fails unexpectedly", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-git-discovery-"));
  const originalPath = process.env.PATH;
  try {
    const fakeGit = join(root, "git");
    await writeFile(fakeGit, "#!/bin/sh\necho 'permission denied' >&2\nexit 128\n"); await chmod(fakeGit, 0o700);
    process.env.PATH = root;
    assert.throws(() => projectIdentityFromRoot(root), /PROJECT_ROOT_DISCOVERY_FAILED/u);
    await writeFile(fakeGit, '#!/bin/sh\nif [ "$3" = "rev-parse" ]; then echo "$2"; exit 0; fi\nexit 2\n');
    assert.throws(() => projectIdentityFromRoot(root), /PROJECT_REMOTE_DISCOVERY_FAILED/u);
    await writeFile(fakeGit, '#!/bin/sh\nexec /bin/sleep 3\n');
    assert.throws(() => projectIdentityFromRoot(root), /PROJECT_ROOT_DISCOVERY_FAILED/u);
    await rm(fakeGit);
    assert.throws(() => projectIdentityFromRoot(root), /PROJECT_ROOT_DISCOVERY_FAILED/u);
  } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; await rm(root, { recursive: true, force: true }); }
});

test("legacy path bindings require explicit migration before creating a new project identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-legacy-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    kernel.bindAlias({ scope_kind: "project", scope_id: "project:legacy", alias_kind: "path", alias: realpathSync(root) });
    assert.throws(() => kernel.resolveProject({ project_root: root }), /PROJECT_IDENTITY_MIGRATION_REQUIRED/u);
    const id = (projectIdentityFromRoot(root).canonical_scope as JsonObject).id;
    assert.equal(store.find("project_identity", String(id)), null);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("existing new project identities do not bypass a later legacy binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-coexist-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    kernel.resolveProject({ project_root: root });
    assert.equal(store.readSnapshot(() => kernel.resolveProject({ project_root: root })).idempotent, true);
    kernel.bindAlias({ scope_kind: "project", scope_id: "project:legacy", alias_kind: "path", alias: realpathSync(root) });
    assert.throws(() => kernel.resolveProject({ project_root: root }), /PROJECT_IDENTITY_MIGRATION_REQUIRED/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("existing project identity must retain its canonical scope, root and digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-corrupt-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    const identity = kernel.resolveProject({ project_root: root }).identity as JsonObject;
    const id = String(identity.id);
    const row = store.database.prepare("SELECT payload_json FROM records WHERE kind='project_identity' AND id=? ORDER BY version DESC LIMIT 1").get(id) as { payload_json: string };
    const original = JSON.parse(row.payload_json) as JsonObject;
    const update = store.database.prepare("UPDATE records SET payload_json=? WHERE kind='project_identity' AND id=?");
    for (const value of [
      { ...original, identity_digest: "invalid" },
      { ...original, canonical_scope: { kind: "project", id: "project:other" } },
      { ...original, local_path_alias: join(root, "missing") },
      { ...original, local_path_alias: null },
      { ...original, local_path_alias: join(root, "data") },
    ]) {
      update.run(JSON.stringify(value), id);
      assert.throws(() => kernel.resolveProject({ project_root: root }), /PROJECT_IDENTITY_INVALID/u);
    }
    update.run(row.payload_json, id);
    assert.equal(kernel.resolveProject({ project_root: root }).idempotent, true);
    const aliasRow = store.database.prepare("SELECT id,payload_json FROM records WHERE kind='scope_alias' LIMIT 1").get() as { id: string; payload_json: string };
    const updateAlias = store.database.prepare("UPDATE records SET payload_json=? WHERE kind='scope_alias' AND id=?");
    for (const change of [{ status: "retired" }, { identity_digest: "invalid" }]) {
      updateAlias.run(JSON.stringify({ ...JSON.parse(aliasRow.payload_json), ...change }), aliasRow.id);
      assert.throws(() => kernel.resolveProject({ project_root: root }), /PROJECT_IDENTITY_INVALID/u);
    }
    updateAlias.run(aliasRow.payload_json, aliasRow.id);
    assert.equal(kernel.resolveProject({ project_root: root }).idempotent, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("project identity is rechecked under the writer transaction before restoring a missing alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-existing-race-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const originalTransaction = store.transaction.bind(store);
  try {
    const kernel = new ScopeIdentityKernel(store);
    const resolved = kernel.resolveProject({ project_root: root });
    const identity = resolved.identity as JsonObject, alias = resolved.alias as JsonObject;
    store.database.prepare("DELETE FROM records WHERE kind='scope_alias' AND id=?").run(String(alias.id));
    let injected = false;
    store.transaction = ((fn: Parameters<typeof store.transaction>[0]) => {
      if (!injected) {
        injected = true;
        const row = store.database.prepare("SELECT payload_json FROM records WHERE kind='project_identity' AND id=? ORDER BY version DESC LIMIT 1").get(String(identity.id)) as { payload_json: string };
        store.database.prepare("UPDATE records SET payload_json=? WHERE kind='project_identity' AND id=?")
          .run(JSON.stringify({ ...JSON.parse(row.payload_json), identity_digest: "corrupt" }), String(identity.id));
      }
      return originalTransaction(fn);
    }) as typeof store.transaction;
    assert.throws(() => kernel.resolveProject({ project_root: root }), /PROJECT_IDENTITY_INVALID/u);
    assert.equal(injected, true);
    assert.equal(store.find("scope_alias", String(alias.id)), null);
  } finally { store.transaction = originalTransaction; store.close(); await rm(root, { recursive: true, force: true }); }
});

test("new project identity is retried outside an existing read snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-read-create-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    assert.throws(() => store.readSnapshot(() => kernel.resolveProject({ project_root: root })),
      error => (error as NodeJS.ErrnoException).code === "CRAFT_READ_SNAPSHOT_WRITE_CONFLICT");
    assert.equal(store.count("project_identity"), 0);
    assert.ok(kernel.resolveProject({ project_root: root }).identity);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("read-only identity snapshot permits an unrelated concurrent database commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-read-race-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const originalFind = store.find.bind(store);
  const writer = new DatabaseSync(store.paths.databaseFile);
  try {
    const kernel = new ScopeIdentityKernel(store);
    kernel.resolveProject({ project_root: root });
    let injected = false;
    store.find = ((kind: string, id: string, ...args: Parameters<typeof store.find> extends [string, string, ...infer Rest] ? Rest : never) => {
      if (!injected && kind === "scope_alias") {
        injected = true;
        writer.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES('race','one',1,'{}','now','now')").run();
      }
      return originalFind(kind, id, ...args);
    }) as typeof store.find;
    assert.equal(kernel.resolveProject({ project_root: root }).idempotent, true);
    assert.equal(injected, true);
    store.find = originalFind;
    assert.equal(kernel.resolveProject({ project_root: root }).idempotent, true);
  } finally { store.find = originalFind; writer.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("read-only identity resolution sees one snapshot when its alias changes concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-alias-snapshot-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const originalFind = store.find.bind(store), writer = new DatabaseSync(store.paths.databaseFile);
  try {
    const kernel = new ScopeIdentityKernel(store), created = kernel.resolveProject({ project_root: root });
    const aliasId = String((created.alias as JsonObject).id);
    let changed = false;
    store.find = ((kind: string, id: string, ...args: Parameters<typeof store.find> extends [string, string, ...infer Rest] ? Rest : never) => {
      if (!changed && kind === "scope_alias" && id === aliasId) {
        changed = true;
        const row = writer.prepare("SELECT payload_json FROM records WHERE kind='scope_alias' AND id=? ORDER BY version DESC LIMIT 1").get(id) as { payload_json: string };
        writer.prepare("UPDATE records SET payload_json=? WHERE kind='scope_alias' AND id=?")
          .run(JSON.stringify({ ...JSON.parse(row.payload_json), status: "retired" }), id);
      }
      return originalFind(kind, id, ...args);
    }) as typeof store.find;
    const snapshot = kernel.resolveProject({ project_root: root });
    assert.equal((snapshot.alias as JsonObject).status, "active");
    assert.equal(changed, true);
    store.find = originalFind;
    assert.throws(() => kernel.resolveProject({ project_root: root }), /PROJECT_IDENTITY_INVALID/u);
  } finally { store.find = originalFind; writer.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a legacy project identity without a path alias still blocks a new identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-identity-legacy-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    store.create("project_identity", "project:legacy", { canonical_scope: { kind: "project", id: "project:legacy" }, local_path_alias: root });
    assert.throws(() => new ScopeIdentityKernel(store).resolveProject({ project_root: root }), /PROJECT_IDENTITY_MIGRATION_REQUIRED/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("project identity ignores missing historic paths and rechecks bindings at publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-binding-race-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const originalList = store.list.bind(store);
  try {
    const missing = join(root, "missing");
    store.create("scope_alias", "missing-alias", { status: "active", alias_kind: "path", alias: missing, scope: { kind: "project", id: "project:old" } });
    store.create("project_identity", "project:old", { local_path_alias: missing });
    const kernel = new ScopeIdentityKernel(store);
    let scans = 0;
    store.list = ((kind: string, ...args: Parameters<typeof store.list> extends [string, ...infer Rest] ? Rest : never) => {
      if (kind === "scope_alias" && ++scans === 2) return [{ status: "active", alias_kind: "path", alias: realpathSync(root), scope: { kind: "project", id: "project:other" } }];
      return originalList(kind, ...args);
    }) as typeof store.list;
    assert.throws(() => kernel.resolveProject({ project_root: root }), /PROJECT_IDENTITY_MIGRATION_REQUIRED/u);
    store.list = originalList;
    assert(kernel.resolveProject({ project_root: root }).identity);
  } finally { store.list = originalList; store.close(); await rm(root, { recursive: true, force: true }); }
});

test("ambiguous project aliases cannot select a project by insertion order", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-ambiguous-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    for (const id of ["project:first", "project:second"]) kernel.bindAlias({ scope_kind: "project", scope_id: id, alias_kind: "legacy", alias: "shared" });
    assert.throws(() => kernel.resolveStack({ kind: "project", id: "shared" }), /PROJECT_SCOPE_AMBIGUOUS/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("project root and explicit project scopes must agree across task and project requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-conflict-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    const id = String((projectIdentityFromRoot(root).canonical_scope as JsonObject).id);
    assert(kernel.resolveStack({ kind: "task", id: "task" }, { project_root: root, project_scope_id: id }).attempted_scopes.some(scope => scope.id === id));
    assert.throws(() => kernel.resolveStack({ kind: "task", id: "task" }, { project_root: root, project_scope_id: "project:other" }), /PROJECT_SCOPE_CONFLICT/u);
    assert.throws(() => kernel.resolveStack({ kind: "project", id }, { project_root: root, project_scope_id: "project:other" }), /PROJECT_SCOPE_CONFLICT/u);
    assert.throws(() => kernel.resolveStack({ kind: "project", id: "project:other" }, { project_root: root }), /PROJECT_SCOPE_CONFLICT/u);
    assert.throws(() => kernel.resolveStack({ kind: "task", id: "task" }, { project_root: join(root, "missing"), project_scope_id: id }));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("identity and aliases are idempotent and scope stacks remain explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-kernel-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    assert.throws(() => kernel.resolveProject({}), /project_root or cwd/);
    const canonicalId = String((projectIdentityFromRoot(root).canonical_scope as JsonObject).id);
    const created = kernel.resolveProject({ cwd: root, project_id: canonicalId });
    const scope = (created.identity as JsonObject).canonical_scope as { kind: "project"; id: string };
    assert.equal(kernel.resolveProject({ project_root: root, project_id: canonicalId }).idempotent, true);
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
    assert.equal(kernel.migrateAlias({ project_root: root, project_id: canonicalId, legacy_scope_id: "older" }).legacy_records_preserved, true);
    const project = kernel.resolveStack(scope, { session_scope_id: "session", team_scope_id: "team", organization_scope_id: "org", user_scope_id: "user", include_global: true });
    assert(project.attempted_scopes.some(item => item.kind === "global"));
    assert(project.excluded_scopes.some(item => item.reason === "session_scope_requires_task_request"));
    const ownSession = kernel.resolveStack(scope, { session_scope_id: "session", session_id: "session" });
    assert(ownSession.attempted_scopes.some(item => item.kind === "session" && item.id === "session"));
    const hostSession = kernel.resolveStack(scope, { session_scope_id: "session", session_id: "session", session_host: "codex" });
    assert(hostSession.attempted_scopes.some(item => item.kind === "session" && item.id === sessionStorageScopeId("codex", "session")));
    const directHostSession = kernel.resolveStack({ kind: "session", id: "session" }, { session_host: "claude" });
    assert.equal(directHostSession.canonical_scope.id, sessionStorageScopeId("claude", "session"));
    assert.throws(() => kernel.resolveStack(scope, { session_scope_id: "session", session_id: "session", session_host: "Invalid Host" }), /host is invalid/u);
    const otherSession = kernel.resolveStack(scope, { session_scope_id: "session", session_id: "other-session" });
    assert(otherSession.excluded_scopes.some(item => item.reason === "session_scope_requires_task_request"));
    const inherited = kernel.resolveStack({ kind: "task", id: "task" }, { project_scope_id: scope.id, session_scope_id: "session" });
    assert(inherited.attempted_scopes.some(item => item.kind === "session"));
    assert(kernel.resolveStack({ kind: "workspace", id: "workspace" }, { project_root: root, project_id: canonicalId }).attempted_scopes.some(item => item.id === scope.id));
    assert(kernel.resolveStack({ kind: "workspace", id: "other-workspace" }, { project_root: root }).attempted_scopes.some(item => item.kind === "project"));
    assert.equal(kernel.resolveStack({ kind: "workspace", id: "workspace" }).canonical_scope.kind, "workspace");
    assert(kernel.resolveStack({ kind: "project", id: "old-id" }).matched_aliases.length > 0);
    assert.equal(kernel.resolveStack({ kind: "project", id: "unknown" }).canonical_scope.id, "unknown");
    store.create("project_identity", "empty-canonical", { canonical_scope: null });
    assert(kernel.resolveStack({ kind: "project", id: "empty-canonical" }).attempted_scopes.some(item => item.id === "empty-canonical"));
    for (const kind of ["session", "team", "organization", "user", "global"] as const) {
      const result = kernel.resolveStack({ kind, id: kind }, { session_scope_id: "session", team_scope_id: "team", organization_scope_id: "org", user_scope_id: "user", include_global: true });
      assert.equal(result.canonical_scope.kind, kind);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Scope Alias creation rechecks a concurrent insert inside its transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-scope-alias-race-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const kernel = new ScopeIdentityKernel(store);
    const canonicalId = String((projectIdentityFromRoot(root).canonical_scope as JsonObject).id);
    const identity = kernel.resolveProject({ project_root: root, project_id: canonicalId }).identity as JsonObject;
    const scope = (identity.canonical_scope as JsonObject).id;
    const insertDuringTransaction = (kind: string, id: string, row: JsonObject): void => {
      const find = store.find.bind(store), transaction = store.transaction.bind(store);
      let missed = false, inserted = false;
      store.find = ((queryKind: string, recordId: string, version?: number, hydrate?: boolean) => {
        if (!missed && queryKind === kind && recordId === id) { missed = true; return null; }
        return find(queryKind, recordId, version, hydrate);
      }) as typeof store.find;
      store.transaction = ((operation: Parameters<typeof store.transaction>[0]) => {
        if (!inserted) {
          inserted = true;
          store.database.prepare("INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
            .run(kind, id, 1, JSON.stringify(row), new Date().toISOString(), new Date().toISOString());
          store.find = find as typeof store.find;
        }
        store.transaction = transaction as typeof store.transaction;
        return transaction(operation);
      }) as typeof store.transaction;
    };
    const identityId = String(identity.id);
    const identityRow = store.database.prepare("SELECT payload_json FROM records WHERE kind='project_identity' AND id=?")
      .get(identityId) as { payload_json: string };
    store.database.prepare("DELETE FROM records WHERE kind='project_identity' AND id=?").run(identityId);
    insertDuringTransaction("project_identity", identityId, JSON.parse(identityRow.payload_json) as JsonObject);
    assert.equal(kernel.resolveProject({ project_root: root, project_id: canonicalId }).idempotent, true);

    const args = { scope_kind: "project", scope_id: scope, alias_kind: "legacy", alias: "racing-alias" };
    const original = kernel.bindAlias(args).alias as JsonObject;
    const id = String(original.id);
    store.database.prepare("DELETE FROM records WHERE kind='scope_alias' AND id=?").run(id);
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...row } = original;
    insertDuringTransaction("scope_alias", id, row);
    const raced = kernel.bindAlias(args);
    assert.equal(raced.idempotent, true);
    assert.equal((raced.alias as JsonObject).id, id);

    const conflictArgs = { ...args, alias: "racing-alias-conflict" };
    const conflictAlias = kernel.bindAlias(conflictArgs).alias as JsonObject;
    const conflictId = String(conflictAlias.id);
    store.database.prepare("DELETE FROM records WHERE kind='scope_alias' AND id=?").run(conflictId);
    const { id: _conflictId, version: _conflictVersion, created_at: _conflictCreated, updated_at: _conflictUpdated, ...conflictRow } = conflictAlias;
    insertDuringTransaction("scope_alias", conflictId, { ...conflictRow, identity_digest: "raced-conflict" });
    assert.throws(() => kernel.bindAlias(conflictArgs), /idempotency conflict/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
