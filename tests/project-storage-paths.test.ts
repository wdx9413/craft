import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalCandidatePath, craftPaths, ensureProjectStorageDirectory, ensureSessionStorageDirectory, existingProjectStorageDirectory,
  isLegacySafeSessionId, parseSessionStorageScopeId, projectStorageDirectory, projectStorageIdentity, sessionStorageDirectory,
  sessionStorageDirectoryForScopeId, sessionStorageScopeId } from "../common/craft-common-store-local/src/paths.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";
import { sqliteBusyTimeoutMs, sqliteTraceBusyTimeoutMs } from "../common/craft-common-store-local/src/sqlite-busy-timeout.ts";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";

test("SQLite contention timeout is short only inside Craft Hook subprocesses", () => {
  assert.equal(sqliteBusyTimeoutMs(), process.env.CRAFT_HOOK_MODE === "1" ? 100 : 15_000);
  assert.equal(sqliteBusyTimeoutMs({} as NodeJS.ProcessEnv), 15_000);
  assert.equal(sqliteBusyTimeoutMs({ CRAFT_HOOK_MODE: "1" } as NodeJS.ProcessEnv), 100);
  assert.equal(sqliteBusyTimeoutMs({ CRAFT_HOOK_MODE: "0" } as NodeJS.ProcessEnv), 15_000);
  assert.equal(sqliteTraceBusyTimeoutMs({} as NodeJS.ProcessEnv), 15_000);
  assert.equal(sqliteTraceBusyTimeoutMs({ CRAFT_HOOK_MODE: "1" } as NodeJS.ProcessEnv), 100);
  assert.equal(sqliteTraceBusyTimeoutMs({ CRAFT_HOOK_MODE: "0" } as NodeJS.ProcessEnv), 15_000);
});

test("project storage isolates equal names and canonicalizes symlink aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-storage-"));
  try {
    const data = join(root, "data");
    mkdirSync(data);
    const first = join(root, "a", "same");
    const second = join(root, "b", "same");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const alias = join(root, "alias");
    symlinkSync(first, alias);
    const paths = craftPaths(data);
    assert.equal(existingProjectStorageDirectory(paths, first), null);
    const firstDirectory = ensureProjectStorageDirectory(paths, first);
    const secondDirectory = ensureProjectStorageDirectory(paths, second);
    assert.notEqual(firstDirectory, secondDirectory);
    assert.equal(projectStorageDirectory(paths, alias), firstDirectory);
    assert.equal(canonicalCandidatePath(join(alias, "missing", "content.md")), join(realpathSync(first), "missing", "content.md"));
    assert.equal(ensureProjectStorageDirectory(paths, alias), firstDirectory);
    assert.equal(existingProjectStorageDirectory(paths, alias), firstDirectory);
    const mapping = JSON.parse(readFileSync(join(firstDirectory, "project.json"), "utf8"));
    assert.deepEqual(mapping, { schema_version: 1, ...projectStorageIdentity(first) });
    assert.equal(mapping.path_sha256.length, 64);
    assert.match(mapping.directory_name, /^same--[a-f0-9]{64}$/u);
    assert.equal(firstDirectory.startsWith(join(data, "projects")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project storage refuses unsafe directories and changed identity mappings", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-storage-"));
  try {
    const data = join(root, "data");
    const project = join(root, "project");
    mkdirSync(data);
    mkdirSync(project);
    const paths = craftPaths(data);
    const directory = ensureProjectStorageDirectory(paths, project);
    const mappingPath = join(directory, "project.json"), identity = projectStorageIdentity(project);
    writeFileSync(mappingPath, "{}\n");
    assert.throws(() => ensureProjectStorageDirectory(paths, project), /mapping does not match/);
    assert.throws(() => existingProjectStorageDirectory(paths, project), /mapping does not match/);
    for (const altered of [
      { schema_version: 2, ...identity },
      { schema_version: 1, ...identity, canonical_root: join(root, "elsewhere") },
      { schema_version: 1, ...identity, path_sha256: "0".repeat(64) },
      { schema_version: 1, ...identity, directory_name: "different-project" },
    ]) {
      writeFileSync(mappingPath, `${JSON.stringify(altered)}\n`);
      assert.throws(() => existingProjectStorageDirectory(paths, project), /mapping does not match/);
    }
    rmSync(join(data, "projects"), { recursive: true });
    symlinkSync(project, join(data, "projects"));
    assert.throws(() => ensureProjectStorageDirectory(paths, project), /regular directories/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project identity rejects files and handles a filesystem root without a basename", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-storage-"));
  try {
    const file = join(root, "file"); writeFileSync(file, "x");
    assert.throws(() => projectStorageIdentity(file), /must be a directory/);
    assert.match(projectStorageIdentity("/").directory_name, /^root--[a-f0-9]{64}$/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("session storage includes the Host and exact session identity without raw path injection", () => {
  const paths = craftPaths("/private/tmp/craft-session-layout-test");
  const codex = sessionStorageDirectory(paths, "codex", "session-123");
  const key = sessionStorageScopeId("codex", "session-123");
  assert.match(codex, /\/sessions\/codex--[a-f0-9]{64}$/u);
  assert.equal(sessionStorageScopeId("codex", key), key);
  assert.throws(() => sessionStorageScopeId("claude", key), /does not match/u);
  assert.equal(isLegacySafeSessionId("session-123"), true);
  assert.equal(isLegacySafeSessionId("../unsafe"), false);
  assert.notEqual(codex, sessionStorageDirectory(paths, "claude", "session-123"));
  assert.notEqual(codex, sessionStorageDirectory(paths, "codex", "session-124"));
  for (const host of ["", "Codex", "../codex", "a".repeat(33)]) assert.throws(() => sessionStorageDirectory(paths, host, "session-123"), /host is invalid/u);
  for (const sessionId of ["", " "]) assert.throws(() => sessionStorageDirectory(paths, "codex", sessionId), /session_id/u);
  for (const sessionId of ["..", "../escape", "a/b", "a\\b", "a\ncontrol", "a".repeat(256), "😀".repeat(64)]) {
    const path = sessionStorageDirectory(paths, "codex", sessionId);
    assert.match(path, /\/sessions\/codex--[a-f0-9]{64}$/u);
    assert.equal(path.includes(sessionId), false, "unsafe or long session identifiers never become path segments");
  }
  for (const sessionId of ["", "x".repeat(65_537)]) assert.throws(() => sessionStorageDirectory(paths, "codex", sessionId), /session_id/u);
});

test("project mapping and read paths reject malformed files and links", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-storage-"));
  try {
    const data = join(root, "data"), project = join(root, "project");
    mkdirSync(data); mkdirSync(project);
    const paths = craftPaths(data), directory = ensureProjectStorageDirectory(paths, project);
    const mapping = join(directory, "project.json");
    rmSync(mapping); writeFileSync(mapping, "{");
    assert.throws(() => existingProjectStorageDirectory(paths, project), /mapping is malformed/);
    rmSync(mapping); mkdirSync(mapping);
    assert.throws(() => ensureProjectStorageDirectory(paths, project), /mapping must be a regular file/);
    rmSync(mapping, { recursive: true }); symlinkSync(project, mapping);
    assert.throws(() => existingProjectStorageDirectory(paths, project), /mapping must be a regular file/);
    rmSync(join(data, "projects"), { recursive: true }); symlinkSync(project, join(data, "projects"));
    assert.throws(() => existingProjectStorageDirectory(paths, project), /regular directories/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project storage rejects an unsafe data root", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-storage-"));
  try {
    const project = join(root, "project"), target = join(root, "target"), link = join(root, "link"), file = join(root, "file");
    mkdirSync(project); mkdirSync(target); symlinkSync(target, link); writeFileSync(file, "x");
    assert.throws(() => ensureProjectStorageDirectory(craftPaths(link), project), /data root must be a regular directory/);
    assert.throws(() => ensureProjectStorageDirectory(craftPaths(file), project), /data root must be a regular directory/);
    assert.throws(() => ensureSessionStorageDirectory(craftPaths(link), "codex", "session"), /data root must be a regular directory/);
    assert.throws(() => ensureSessionStorageDirectory(craftPaths(file), "codex", "session"), /data root must be a regular directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project storage propagates unexpected creation and publication errors", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-storage-"));
  const originalMkdir = fs.mkdirSync, originalLink = fs.linkSync;
  try {
    const data = join(root, "data"), project = join(root, "project");
    mkdirSync(data); mkdirSync(project);
    const paths = craftPaths(data), projects = join(data, "projects");
    fs.mkdirSync = ((path: Parameters<typeof fs.mkdirSync>[0], options?: Parameters<typeof fs.mkdirSync>[1]) => {
      if (String(path) === projects) throw Object.assign(new Error("injected mkdir error"), { code: "EIO" });
      return originalMkdir(path, options);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    assert.throws(() => ensureProjectStorageDirectory(paths, project), /injected mkdir error/);
    fs.mkdirSync = originalMkdir; syncBuiltinESMExports();
    fs.linkSync = (() => { throw Object.assign(new Error("injected link error"), { code: "EIO" }); }) as typeof fs.linkSync;
    syncBuiltinESMExports();
    assert.throws(() => ensureProjectStorageDirectory(paths, project), /injected link error/);
    const directory = projectStorageDirectory(paths, project);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.mkdirSync = originalMkdir; fs.linkSync = originalLink; syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("project mapping publication accepts an identical concurrent creator", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-storage-race-"));
  const originalLink = fs.linkSync;
  try {
    const data = join(root, "data"), project = join(root, "project");
    mkdirSync(data); mkdirSync(project);
    const paths = craftPaths(data), identity = projectStorageIdentity(project);
    fs.linkSync = ((source: Parameters<typeof fs.linkSync>[0], target: Parameters<typeof fs.linkSync>[1]) => {
      writeFileSync(String(target), `${JSON.stringify({ schema_version: 1, ...identity })}\n`);
      throw Object.assign(new Error("concurrent mapping publication"), { code: "EEXIST" });
    }) as typeof fs.linkSync;
    syncBuiltinESMExports();
    assert.equal(ensureProjectStorageDirectory(paths, project), projectStorageDirectory(paths, project));
  } finally { fs.linkSync = originalLink; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test("project capability records write only below the shared Craft data root", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-storage-"));
  const project = join(root, "project");
  mkdirSync(project);
  const paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "project", { scope: { kind: "project", id: "project:demo" }, alias_kind: "path", alias: project,
      alias_digest: stableDigest(project), status: "active" });
    store.create("knowledge_claim", "knowledge", { scope: "project:demo", status: "candidate", content: "project-only knowledge" });
    store.create("memory_ledger", "memory", { scope: { kind: "project", id: "project:demo" }, status: "active", content: "project-only memory" });
    store.create("experience_observation", "experience", { scope: { kind: "project", id: "project:demo" }, status: "recorded" });
    store.create("project_identity", "project:demo", { canonical_scope: { kind: "project", id: "project:demo" },
      identity_digest: `sha256:${"a".repeat(64)}`, local_path_alias: project });
    store.create("project_identity", "project:invalid-identity", { canonical_scope: { kind: "project", id: "project:demo" },
      identity_digest: "invalid", local_path_alias: project });
    store.create("project_identity", "project:relative-identity", { canonical_scope: { kind: "project", id: "project:demo" },
      identity_digest: `sha256:${"b".repeat(64)}`, local_path_alias: "relative/project" });
    const fileAlias = join(root, "project-file"); writeFileSync(fileAlias, "file");
    store.create("project_identity", "project:file-identity", { canonical_scope: { kind: "project", id: "project:demo" },
      identity_digest: `sha256:${"c".repeat(64)}`, local_path_alias: fileAlias });
    store.create("project_identity", "project:missing-identity", { canonical_scope: { kind: "project", id: "project:demo" },
      identity_digest: `sha256:${"d".repeat(64)}`, local_path_alias: join(root, "missing-project") });
    assert.deepEqual((store as any).projectRoots("project:demo"), [realpathSync(project)]);
    const projectDirectory = projectStorageDirectory(paths, project);
    for (const capability of ["knowledge", "memory", "experience"]) assert.equal(existsSync(join(projectDirectory, capability, `${capability}.db`)), true);
    assert.equal(existsSync(join(project, ".craft_data")), false);
    assert.equal(store.get("knowledge_claim", "knowledge").content, "project-only knowledge");
    assert.equal(store.get("memory_ledger", "memory").content, "project-only memory");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a forged project path alias cannot redirect partition writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-storage-"));
  const project = join(root, "project"); mkdirSync(project);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    store.create("scope_alias", "forged", { status: "active", alias_kind: "path", alias: project,
      alias_digest: `sha256:${"0".repeat(64)}`, scope: { kind: "project", id: "project:forged" } });
    assert.throws(() => store.create("knowledge_claim", "forged-claim", { scope: "project:forged", status: "candidate" }), /not registered/u);
    assert.equal(existsSync(join(store.paths.root, "projects")), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session identity is the Host and session ID pair and survives store reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-session-storage-"));
  const paths = craftPaths(join(root, "data"));
  let store = await new CraftStore(paths).open();
  try {
    const codex = store.bindSessionStorageHost("session-1", "codex");
    assert.equal(codex, sessionStorageDirectory(paths, "codex", "session-1"));
    assert.equal(store.bindSessionStorageHost("session-1", "codex"), codex);
    const claude = store.bindSessionStorageHost("session-1", "claude");
    assert.notEqual(claude, codex);
    assert.equal(parseSessionStorageScopeId(sessionStorageScopeId("codex", "session-1"))?.host, "codex");
    assert.equal(parseSessionStorageScopeId(sessionStorageScopeId("claude", "session-1"))?.host, "claude");
    store.create("memory_candidate", "candidate", { scope: { kind: "session", id: "session-2" }, status: "candidate" });
    const generic = store.sessionStorageRoot("session-2");
    assert.equal(generic, sessionStorageDirectory(paths, "craft-mcp", "session-2"));
    assert.notEqual(store.bindSessionStorageHost("session-2", "codex"), generic);
    assert.throws(() => store.sessionStorageRoot("session-2"), /ambiguous/u);
    store.close();
    store = await new CraftStore(paths).open();
    assert.equal(store.sessionStorageRoot(sessionStorageScopeId("codex", "session-1")), codex);
    assert.equal(store.sessionStorageRoot(sessionStorageScopeId("claude", "session-1")), claude);
    assert.throws(() => store.sessionStorageRoot("session-1"), /ambiguous/u);
    assert.throws(() => store.sessionStorageRoot("session-2"), /ambiguous/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session storage creation records explicit and encoded Host scopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-session-storage-create-"));
  const paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  try {
    const explicit = sessionStorageScopeId("codex", "encoded-session");
    assert.equal(store.sessionStorageRoot(explicit, true), sessionStorageDirectory(paths, "codex", "encoded-session"));
    assert.equal(store.bindSessionStorageHost("encoded-session", "codex"), sessionStorageDirectory(paths, "codex", "encoded-session"));
    assert.equal(store.sessionStorageRoot("requested-session", true, "claude"), sessionStorageDirectory(paths, "claude", "requested-session"));
    assert.equal(store.resolveSessionStorageScopeId("requested-session"), sessionStorageScopeId("claude", "requested-session"));
    assert.equal(store.resolveSessionStorageScopeId("requested-session", "claude"), sessionStorageScopeId("claude", "requested-session"));
    assert.equal(store.sessionStorageRoot("requested-session", false, "claude"), sessionStorageDirectory(paths, "claude", "requested-session"));
    assert.throws(() => sessionStorageDirectoryForScopeId(paths, "not-a-scope"), /malformed/u);
    assert.throws(() => store.resolveSessionStorageScopeId(explicit, "claude"), /does not match/u);
    assert.equal(store.sessionStorageRoot("unbound-session"), sessionStorageDirectory(paths, "craft-mcp", "unbound-session"));

    const missingScopeId = "session-without-scope-field";
    store.create("session_storage_identity", "malformed-session-identity", { host: "codex", session_id: missingScopeId,
      session_digest: createHash("sha256").update(missingScopeId).digest("hex") });
    assert.equal(store.resolveSessionStorageScopeId(missingScopeId), missingScopeId);

    store.bindSessionStorageHost("multi-host-session", "codex");
    store.bindSessionStorageHost("multi-host-session", "claude");
    assert.throws(() => store.resolveSessionStorageScopeId("multi-host-session"), /ambiguous/u);

    const legacyId = "legacy-identity-session";
    const digest = createHash("sha256").update(legacyId).digest("hex");
    store.create("session_storage_identity", `session_storage_${digest}`, { host: "codex", observed_host: "claude",
      session_id: legacyId, session_digest: "old-digest", scope_id: legacyId, content_free: true });
    assert.equal(store.resolveSessionStorageScopeId(legacyId), sessionStorageScopeId("claude", legacyId));
    assert.equal(store.sessionStorageRoot(legacyId), sessionStorageDirectory(paths, "claude", legacyId));
    const legacyHostFallbackId = "legacy-host-fallback-session";
    const legacyHostFallbackDigest = createHash("sha256").update(legacyHostFallbackId).digest("hex");
    store.create("session_storage_identity", `session_storage_${legacyHostFallbackDigest}`, { host: "codex",
      session_id: legacyHostFallbackId, session_digest: "old-digest", scope_id: legacyHostFallbackId, content_free: true });
    assert.equal(store.resolveSessionStorageScopeId(legacyHostFallbackId), sessionStorageScopeId("codex", legacyHostFallbackId));
    assert.equal(store.sessionStorageRoot(legacyHostFallbackId), sessionStorageDirectory(paths, "codex", legacyHostFallbackId));

    const conflictedScope = sessionStorageScopeId("codex", "conflicted-scope");
    const conflictedDigest = createHash("sha256").update(conflictedScope).digest("hex");
    store.create("session_storage_identity", `session_storage_${conflictedDigest}`, { host: "claude", session_id: null,
      session_digest: conflictedDigest, scope_id: sessionStorageScopeId("claude", "other-session"), content_free: true });
    assert.throws(() => store.sessionStorageRoot(conflictedScope), /conflicts with its scope ID/u);

    const conflictSession = "conflicting-identity-session";
    const conflictScope = sessionStorageScopeId("codex", conflictSession);
    const conflictIdentityId = `session_storage_${createHash("sha256").update(conflictScope).digest("hex")}`;
    store.create("session_storage_identity", conflictIdentityId, { host: "codex", session_id: "other-session",
      session_digest: createHash("sha256").update(conflictSession).digest("hex"), scope_id: conflictScope, content_free: true });
    assert.throws(() => store.bindSessionStorageHost(conflictSession, "codex"), /conflicts with an existing session/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session Host binding resolves identical create races and rejects conflicting races", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-session-storage-race-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const create = store.create.bind(store);
  try {
    const sameSession = "session-identical-race";
    store.create = ((kind: string, id: string, payload: Record<string, unknown>) => {
      if (kind === "session_storage_identity") {
        create(kind, id, payload);
        throw new Error("raced identical create");
      }
      return create(kind, id, payload);
    }) as typeof store.create;
    assert.equal(store.bindSessionStorageHost(sameSession, "codex"), sessionStorageDirectory(store.paths, "codex", sameSession));

    const conflictSession = "session-conflicting-race";
    store.create = ((kind: string, id: string, payload: Record<string, unknown>) => {
      if (kind === "session_storage_identity") {
        create(kind, id, { ...payload, host: "claude" });
        throw new Error("raced conflicting create");
      }
      return create(kind, id, payload);
    }) as typeof store.create;
    assert.throws(() => store.bindSessionStorageHost(conflictSession, "codex"), /raced conflicting create/u);
  } finally {
    store.create = create as typeof store.create;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
