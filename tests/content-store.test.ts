import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths, projectStorageDirectory, sessionStorageDirectory } from "../core/infrastructure/paths.ts";
import { contentReference, contentTitle, MarkdownContentStore } from "../core/infrastructure/content-store.ts";
import { CraftService } from "../core/application/craft-service.ts";
import { ContentMigrationKernel } from "../core/content-migration.ts";
import { projectKnowledgeContentDirectory } from "../core/project-knowledge-content.ts";
import { projectExperienceContentDirectory } from "../core/project-experience-directory.ts";
import { MemoryConsolidationKernel } from "../core/memory-consolidation.ts";
import { McpServer } from "../core/mcp.ts";
import { stableDigest } from "../core/digest.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-content-store-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  return { root, paths, store, service: new CraftService(store) };
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`; }

test("MarkdownContentStore writes self-describing content and verifies its digest", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const ref = await content.write({ kind: "knowledge", record_id: "claim-1", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "Hello knowledge" });
  assert.match(ref.path, /knowledge[\\/]md[\\/]Hello-knowledge--[a-f0-9]{12}\.v1\.md$/);
  assert.equal(ref.title, "Hello knowledge");
  assert.equal((await content.read(ref)).body, "Hello knowledge");
  assert.equal((await content.verify(ref)).status, "verified");
  assert.equal(content.verifySync(ref).status, "verified");
  assert.throws(() => content.rewriteSync({ kind: "knowledge", record_id: "claim-1", version: 0, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "invalid version" }), /positive integer/);
  const rewritten = content.rewriteSync({ kind: "knowledge", record_id: "claim-1", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "Rewritten knowledge" });
  assert.equal(content.readSync(rewritten).body, "Rewritten knowledge");
  const rewrittenRaw = readFileSync(rewritten.path, "utf8");
  writeFileSync(rewritten.path, rewrittenRaw.replace('record_id: "claim-1"', 'record_id: "other"'));
  assert.throws(() => content.rewriteSync({ kind: "knowledge", record_id: "claim-1", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "wrong identity" }), /identity conflict/);
  writeFileSync(rewritten.path, rewrittenRaw);
  assert.equal(content.verifySync({ ...ref, path: join(f.root, "missing.md") }).status, "drifted");
  const missing = await content.write({ kind: "knowledge", record_id: "missing", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "to remove" });
  await unlink(missing.path);
  assert.equal((await content.verify(missing)).status, "missing");
  assert.equal(content.verifySync(missing).status, "missing");
  const raw = await readFile(ref.path, "utf8");
  assert.match(raw, /^---\nschema_version: "craft\.content\.v1"/m);
  assert.match(raw, /record_version: 1/);
  // A POSIX mode is not expressible on Windows, so the private-by-default check is POSIX-only.
  if (process.platform !== "win32") assert.equal((await stat(ref.path)).mode & 0o777, 0o600);
  const legacyPath = content.legacyPathFor("knowledge", "claim-1", 1);
  await mkdir(dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, raw, "utf8");
  assert.equal(content.readCompatSync({ ...rewritten, path: legacyPath }).body, "Rewritten knowledge");
  assert.throws(() => content.readCompatSync({ ...ref, path: join(f.root, "outside.md") }), /outside/);
  await f.store.close();
});

test("project Knowledge bodies stay inside the registered checkout and reject cross-project reads", async () => {
  const f = await fixture();
  try {
    const other = await mkdtemp(join(tmpdir(), "craft-content-other-project-"));
    f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: f.root });
    f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:other", alias_kind: "path", alias: other });
    const ref = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "project-claim", version: 1, scope: "project:demo",
      status: "candidate", sensitivity: "internal", source_id: "project-source", body: "Project-only Knowledge." });
    assert.ok(ref.path.startsWith(join(projectStorageDirectory(f.paths, f.root), "knowledge", "md")));
    const legacyKnowledgePath = join(f.root, ".craft_data", "knowledge", "md", "legacy-claim.v1.md");
    await mkdir(dirname(legacyKnowledgePath), { recursive: true });
    await writeFile(legacyKnowledgePath, await readFile(ref.path, "utf8"), "utf8");
    assert.equal(fs.realpathSync((f.store.contentStore as any).directory("knowledge", undefined, "project:demo", undefined, legacyKnowledgePath, false)),
      fs.realpathSync(dirname(legacyKnowledgePath)));
    assert.equal(f.store.contentStore.readCompatSync({ ...ref, path: legacyKnowledgePath }, "project:demo").body, "Project-only Knowledge.");
    const experienceRef = f.store.contentStore.writeSync({ kind: "experience", record_id: "project-procedure", version: 1, scope: "project:demo",
      status: "candidate", sensitivity: "internal", source_id: "project-source", body: "Project-only procedure." });
    const legacyExperiencePath = join(f.root, ".craft_data", "experience", "md", "legacy-procedure.v1.md");
    await mkdir(dirname(legacyExperiencePath), { recursive: true });
    await writeFile(legacyExperiencePath, await readFile(experienceRef.path, "utf8"), "utf8");
    assert.equal(fs.realpathSync((f.store.contentStore as any).directory("experience", undefined, "project:demo", undefined, legacyExperiencePath, false)),
      fs.realpathSync(dirname(legacyExperiencePath)));
    assert.equal(f.store.contentStore.readCompatSync({ ...experienceRef, path: legacyExperiencePath }, "project:demo").body, "Project-only procedure.");
    const projectMemory = f.store.contentStore.writeSync({ kind: "memory", record_id: "project-memory-explicit-root", version: 1,
      scope: "project:demo", project_root: f.root, status: "active", sensitivity: "internal", source_id: "project-source", body: "Project memory." });
    assert.ok(projectMemory.path.startsWith(join(projectStorageDirectory(f.paths, f.root), "memory", "md")));
    assert.ok(f.store.contentStore.pathFor("memory", "project-memory-explicit-path", undefined, undefined, "project:demo", f.root)
      .startsWith(join(projectStorageDirectory(f.paths, f.root), "memory", "md")));
    const legacyMemoryDirectory = join(f.root, ".craft_data", "memory", "md");
    await mkdir(legacyMemoryDirectory, { recursive: true });
    const legacyMemoryPath = join(legacyMemoryDirectory, "project-memory-explicit-root.v1.md");
    await writeFile(legacyMemoryPath, await readFile(projectMemory.path, "utf8"));
    assert.equal(f.store.contentStore.readCompatSync({ ...projectMemory, path: legacyMemoryPath }, "project:demo").body, "Project memory.");
    assert.equal(f.store.contentStore.readCompatSync(ref).body, "Project-only Knowledge.");
    const { scope: _scope, ...legacyRef } = ref;
    assert.equal(f.store.contentStore.readCompatSync(legacyRef, "project:demo").body, "Project-only Knowledge.");
    assert.throws(() => f.store.contentStore.readCompatSync(legacyRef, "project:other"), /outside the canonical directory/u);
    assert.throws(() => f.store.contentStore.readCompatSync({ ...legacyRef, scope: "project:other" }), /outside the canonical directory/u);
    const clone = await mkdtemp(join(tmpdir(), "craft-content-project-clone-"));
    f.service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: clone });
    assert.throws(() => f.store.contentStore.writeSync({ kind: "knowledge", record_id: "ambiguous-project-claim", version: 1,
      scope: "project:demo", status: "candidate", sensitivity: "internal", source_id: "project-source", body: "Ambiguous project." }), /ambiguous/u);
    assert.throws(() => f.store.contentStore.writeSync({ kind: "knowledge", record_id: "clone-project-claim", version: 1, scope: "project:demo", project_root: clone,
      status: "candidate", sensitivity: "internal", source_id: "project-source", body: "Clone-scoped Knowledge." }), /ambiguous/u);
    await rm(other, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  } finally { await f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("project Knowledge and Experience writes fail closed when no project root is registered", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.store.contentStore.writeSync({ kind: "knowledge", record_id: "unbound-knowledge", version: 1,
      scope: "project:unbound", status: "candidate", sensitivity: "internal", source_id: "source", body: "Unbound." }), /no registered project root/u);
    assert.throws(() => f.store.contentStore.writeSync({ kind: "experience", record_id: "unbound-experience", version: 1,
      scope: "project:unbound", status: "candidate", sensitivity: "internal", source_id: "source", body: "Unbound." }), /no registered project root/u);
  } finally { await f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("session Memory reads only the two exact legacy temp layouts during migration", async () => {
  const f = await fixture();
  const sessionId = `coverage-${randomUUID()}`;
  const standalone = new MarkdownContentStore(f.paths);
  const fallbackSessionPath = standalone.pathFor("memory", "fallback-session", 1, undefined, "session:fallback-session");
  assert.ok(fallbackSessionPath
    .startsWith(join(sessionStorageDirectory(f.paths, "craft-mcp", "fallback-session"), "memory", "md")));
  assert.equal(standalone.isCanonicalRef({ kind: "memory", record_id: "fallback-session", version: 1, path: fallbackSessionPath, scope: "session:fallback-session" }), true);
  const legacyRoot = join("/tmp", ".craft_data", "memory");
  const sessionDirectory = join(legacyRoot, sessionId);
  const hashedDirectory = join(legacyRoot, createHash("sha256").update(sessionId).digest("hex").slice(0, 32));
  try {
    const current = f.store.contentStore.writeSync({ kind: "memory", record_id: "legacy-session", version: 1,
      scope: `session:${sessionId}`, status: "active", sensitivity: "internal", source_id: "legacy", body: "legacy session body" });
    for (const directory of [sessionDirectory, hashedDirectory]) {
      const md = join(directory, "md"), oldPath = join(md, "legacy-session.v1.md");
      await mkdir(md, { recursive: true });
      await writeFile(oldPath, await readFile(current.path, "utf8"), "utf8");
      assert.equal(f.store.contentStore.readCompatSync({ ...current, path: oldPath }, `session:${sessionId}`).body, "legacy session body");
    }
    assert.throws(() => f.store.contentStore.readCompatSync({ ...current, path: join(f.root, "outside.md") }, `session:${sessionId}`), /outside the canonical directory/u);
    f.store.closeMemoryScope({ kind: "session", id: sessionId });
  } finally {
    await Promise.all([rm(sessionDirectory, { recursive: true, force: true }), rm(hashedDirectory, { recursive: true, force: true })]);
    await f.store.close();
  }
});

test("legacy project Experience reads traverse nested folders and reject missing or linked paths", async () => {
  const f = await fixture();
  try {
    const projectRoot = join(f.root, "legacy-experience-project");
    await mkdir(projectRoot);
    const scope = "project:legacy-experience-project";
    f.store.create("scope_alias", "legacy-experience-project", { status: "active", alias_kind: "path", alias: projectRoot,
      alias_digest: stableDigest(projectRoot), scope: { kind: "project", id: scope } });
    const current = f.store.contentStore.writeSync({ kind: "experience", record_id: "legacy-nested-flow", version: 1,
      scope, status: "candidate", sensitivity: "internal", source_id: "legacy", body: "legacy procedure", folder: "workflows" });
    const legacyDirectory = join(projectRoot, ".craft_data", "experience", "md", "workflows", "deep", "nested");
    await mkdir(legacyDirectory, { recursive: true });
    const oldPath = join(legacyDirectory, "legacy-nested-flow.v1.md");
    await writeFile(oldPath, await readFile(current.path, "utf8"), "utf8");
    const storeInternals = f.store as any;
    assert.equal(storeInternals.legacyProjectContentDirectory(projectRoot, "experience", oldPath, false)?.endsWith(join(".craft_data", "experience", "md")), true);
    assert.equal(fs.realpathSync((f.store.contentStore as any).directory("experience", undefined, scope, undefined, oldPath, false)), fs.realpathSync(join(projectRoot, ".craft_data", "experience", "md")));
    assert.equal(storeInternals.legacyProjectContentDirectory(projectRoot, "experience", join(legacyDirectory, "missing.v1.md"), false), null);
    assert.equal(storeInternals.legacyProjectContentDirectory(projectRoot, "experience", join(projectRoot, "outside.v1.md"), false), null);
    assert.equal(storeInternals.legacyProjectContentDirectory(projectRoot, "experience", oldPath, true), null);
    assert.equal(projectExperienceContentDirectory(f.store, scope, { reference_path: oldPath })?.endsWith(join(".craft_data", "experience", "md")), true);
    assert.equal(projectExperienceContentDirectory(f.store, scope, { reference_path: join(legacyDirectory, "missing.v1.md") })?.endsWith(join(".craft_data", "experience", "md")), true);
    assert.equal(f.store.contentStore.readCompatSync({ ...current, path: oldPath }, scope).body, "legacy procedure");
    assert.throws(() => f.store.contentStore.readCompatSync({ ...current, path: join(legacyDirectory, "missing.v1.md") }, scope), /ENOENT|no such file/u);
    const linked = join(legacyDirectory, "linked.v1.md");
    await symlink(oldPath, linked);
    assert.throws(() => storeInternals.legacyProjectContentDirectory(projectRoot, "experience", linked, false), /regular files and directories/u);
    assert.throws(() => projectExperienceContentDirectory(f.store, scope, { reference_path: linked }), /regular files and directories/u);
    f.store.contentStore.setProjectExperienceDirectoryResolver((_scope, options) => options.reference_path
      ? join(projectRoot, ".craft_data", "experience", "md")
      : join(projectStorageDirectory(f.paths, projectRoot), "experience", "md"));
    assert.throws(() => f.store.contentStore.readCompatSync({ ...current, path: linked }, scope), /regular files and directories/u);
    const parentPath = join(projectRoot, ".craft_data"), originalLstat = fs.lstatSync;
    fs.lstatSync = ((path: Parameters<typeof fs.lstatSync>[0], ...args: Parameters<typeof fs.lstatSync>[1][]) => {
      if (String(path) === parentPath) throw Object.assign(new Error("legacy path stat failed"), { code: "EIO" });
      return originalLstat(path, ...args);
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => storeInternals.legacyProjectContentDirectory(projectRoot, "experience", oldPath, false), /legacy path stat failed/u);
    } finally { fs.lstatSync = originalLstat; syncBuiltinESMExports(); }
  } finally { await f.store.close(); }
});

test("legacy project Knowledge references resolve from their exact former content directory", async () => {
  const f = await fixture();
  try {
    const projectRoot = join(f.root, "legacy-knowledge-project");
    await mkdir(projectRoot);
    const scope = "project:legacy-knowledge-project";
    f.store.create("scope_alias", "legacy-knowledge-project", { status: "active", alias_kind: "path", alias: projectRoot,
      alias_digest: stableDigest(projectRoot), scope: { kind: "project", id: scope } });
    const legacyDirectory = join(projectRoot, ".craft_data", "knowledge", "md");
    await mkdir(legacyDirectory, { recursive: true });
    const reference = join(legacyDirectory, "legacy-fact.v1.md");
    await writeFile(reference, "legacy knowledge body\n", "utf8");
    const internals = f.store as any;
    assert.equal(internals.legacyProjectContentDirectory(projectRoot, "knowledge", reference, false), legacyDirectory);
    assert.deepEqual(internals.projectRoots("legacy-knowledge-project"), [fs.realpathSync(projectRoot)]);
    assert.equal(fs.realpathSync((f.store.contentStore as any).directory("knowledge", undefined, scope, undefined, reference, false)), fs.realpathSync(legacyDirectory));
    assert.equal(projectKnowledgeContentDirectory(f.store, scope, { reference_path: reference })?.endsWith(join(".craft_data", "knowledge", "md")), true);
    const current = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "legacy-knowledge-read", version: 1,
      scope, status: "candidate", sensitivity: "internal", source_id: "legacy", body: "legacy knowledge body" });
    await writeFile(reference, await readFile(current.path, "utf8"), "utf8");
    assert.equal(f.store.contentStore.readCompatSync({ ...current, path: reference }, scope).body, "legacy knowledge body");
  } finally { await f.store.close(); }
});

test("content drift and unsafe identifiers fail closed", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const ref = await content.write({ kind: "memory", record_id: "memory-1", version: 1, scope: "user:local", status: "active", sensitivity: "restricted", source_id: "source-1", body: "Private memory" });
  await assert.rejects(content.read({ ...ref, record_id: "other" }), /outside|metadata/);
  await writeFile(ref.path, (await readFile(ref.path, "utf8")).replace(/Private memory$/u, "Changed memory"), "utf8");
  await assert.rejects(content.read(ref), /digest/);
  await assert.rejects(content.read({ ...ref, path: join(f.root, "outside.md") }), /outside/);
  assert.equal((await content.verify(ref)).status, "drifted");
  assert.equal(content.verifySync(ref).status, "drifted");
  await content.writeSync({ kind: "memory", record_id: "memory-2", version: 1, scope: "user:local", status: "active", sensitivity: "restricted", source_id: "source-1", body: "Private memory" });
  await writeFile(ref.path, "tampered", "utf8");
  await assert.rejects(content.read(ref), /frontmatter|digest/);
  await assert.rejects(content.write({ kind: "memory", record_id: "../escape", version: 1, scope: "user:local", status: "active", sensitivity: "restricted", source_id: "source-1", body: "x" }), /identifier/);
  await f.store.close();
});

test("content store rejects malformed documents and conflicting versions", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const ref = await content.write({ kind: "knowledge", record_id: "friendly id", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "body" });
  assert.equal((await content.write({ kind: "knowledge", record_id: "friendly id", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "body" })).digest, ref.digest);
  await assert.rejects(content.write({ kind: "knowledge", record_id: "friendly id", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "other" }), /different body/);
  assert.throws(() => content.writeSync({ kind: "knowledge", record_id: "friendly id", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "other" }), /different body/);
  await writeFile(ref.path, "---\nschema_version: \"wrong\"\n---\nbody", "utf8");
  await assert.rejects(content.read(ref), /incomplete/);
  await writeFile(join(f.root, "unclosed.md"), "---\nschema_version: \"craft.content.v1\"", "utf8");
  assert.throws(() => content.readUncheckedSync(join(f.root, "unclosed.md")), /not closed/);
  await writeFile(join(f.root, "invalid-line.md"), "---\nnot-a-field\n---\nbody", "utf8");
  assert.throws(() => content.readUncheckedSync(join(f.root, "invalid-line.md")), /frontmatter is invalid/);
  const conflict = await content.write({ kind: "knowledge", record_id: "identity", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "identity" });
  await writeFile(conflict.path, (await readFile(conflict.path, "utf8")).replace('record_id: "identity"', 'record_id: "other"'), "utf8");
  await assert.rejects(content.write({ kind: "knowledge", record_id: "identity", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "identity" }), /identity conflict/);
  const syncConflict = content.writeSync({ kind: "knowledge", record_id: "sync-identity", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "sync" });
  writeFileSync(syncConflict.path, readFileSync(syncConflict.path, "utf8").replace('record_id: "sync-identity"', 'record_id: "other"'), "utf8");
  assert.throws(() => content.writeSync({ kind: "knowledge", record_id: "sync-identity", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "sync" }), /identity conflict/);
  assert.throws(() => content.writeSync({ kind: "knowledge", record_id: "bad-sync-version", version: 0, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "x" }), /positive integer/);
  assert.match(content.pathFor("knowledge", "no-version"), /no-version\.md$/);
  assert.match(content.legacyPathFor("memory", "no-version"), /no-version\.md$/);
  await assert.rejects(content.write({ kind: "knowledge", record_id: "bad-version", version: 0, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "x" }), /positive integer/);
  await assert.rejects(content.write({ kind: "knowledge", record_id: "empty", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: " " }), /empty/);
  await assert.rejects(content.write({ kind: "knowledge", record_id: "secret", version: 1, scope: "global", status: "candidate", sensitivity: "internal", source_id: "source-1", body: "password: 12345678" }), /credentials/);
  await f.store.close();
});

test("semantic filename lookup fails closed on mismatched and malformed siblings", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const mismatch = await content.write({ kind: "memory", record_id: "mismatch", version: 1, title: "Other kind", scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "other body" });
  const mismatchInKnowledge = content.namedPathFor("knowledge", "mismatch", 1, "Other kind");
  await mkdir(dirname(mismatchInKnowledge), { recursive: true });
  await writeFile(mismatchInKnowledge, (await readFile(mismatch.path, "utf8")).replace('record_kind: "memory"', 'record_kind: "memory"'), "utf8");
  await assert.rejects(content.write({ kind: "knowledge", record_id: "mismatch", version: 1, title: "New title", scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "new body" }), /identity conflict/);
  const malformedPath = content.namedPathFor("knowledge", "malformed-sibling", 1, "Broken");
  await writeFile(malformedPath, "not frontmatter", "utf8");
  assert.throws(() => content.writeSync({ kind: "knowledge", record_id: "malformed-sibling", version: 1, title: "Different", scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body" }), /frontmatter/);
  const missing = new MarkdownContentStore({ ...f.paths, knowledgeContentDir: join(f.root, "not-created") });
  assert.throws(() => missing.rewriteSync({ kind: "knowledge", record_id: "missing-dir", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body" }), /ENOENT|no such file/);
  await f.store.close();
});

test("content titles provide readable Unicode filenames without changing identity", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  assert.equal(contentTitle("", undefined, "Fallback title"), "Fallback title");
  assert.throws(() => contentTitle("", undefined, ""), /title/);
  assert.throws(() => contentTitle("body", "token: 12345678", "fallback"), /credentials|secrets/);
  assert.match(content.namedPathFor("knowledge", "named", undefined, "!!!"), /untitled--[a-f0-9]{12}\.md$/);
  const longTitle = "不要在未满足以下条件时" + "背景说明 ".repeat(100);
  const longTitlePath = content.namedPathFor("memory", "long-title", 1, longTitle, undefined, "global");
  assert(Buffer.byteLength(longTitlePath.split(/[\\/]/u).at(-1)!, "utf8") < 180);
  assert.match(content.pathFor("memory", "memory-path"), /memory-path\.md$/);
  const ref = await content.write({ kind: "knowledge", record_id: "metadata-title", version: 1, title: "可读名称 / API", scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body" });
  const withoutTitle = (await readFile(ref.path, "utf8")).replace(/title: .*\n/u, "");
  await writeFile(ref.path, withoutTitle, "utf8");
  assert.equal((await content.write({ kind: "knowledge", record_id: "metadata-title", version: 1, title: "可读名称 / API", scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body" })).title, "可读名称 / API");
  await writeFile(ref.path, withoutTitle, "utf8");
  assert.equal(content.writeSync({ kind: "knowledge", record_id: "metadata-title", version: 1, title: "可读名称 / API", scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body" }).title, "可读名称 / API");
  await f.store.close();
});

test("bound project Knowledge writes fail closed when the project path is not registered", async () => {
  const f = await fixture();
  const content = f.store.contentStore;
  const { bindProjectKnowledgeContentDirectory } = await import("../core/project-knowledge-content.ts");
  bindProjectKnowledgeContentDirectory(f.store);
  assert.throws(() => content.writeSync({ kind: "knowledge", record_id: "unbound", version: 1, scope: "project:unbound",
    status: "candidate", sensitivity: "internal", source_id: "source", body: "Project fact" }), /no registered project root/u);
  await assert.rejects(content.write({ kind: "knowledge", record_id: "unbound-async", version: 1, scope: "project:unbound",
    status: "candidate", sensitivity: "internal", source_id: "source", body: "Project fact" }), /no registered project root/u);
  await f.store.close();
});

test("Experience Markdown is stored by Procedure format while preserving one canonical content root", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  try {
    const graph = content.writeSync({ kind: "experience", folder: "graphs", record_id: "procedure-graph", version: 1, title: "恢复分支", scope: "project:craft", status: "candidate", sensitivity: "internal", source_id: "fixture", body: "# 恢复分支" });
    assert.match(graph.path, /experience[\\/]md[\\/]graphs[\\/]恢复分支--[a-f0-9]{12}\.v1\.md$/u);
    assert.equal(content.readSync(graph).body, "# 恢复分支");
    const rewritten = content.rewriteSync({ kind: "experience", record_id: "procedure-graph", version: 1, current_path: graph.path, title: "恢复分支新版", scope: "project:craft", status: "routeable", sensitivity: "internal", source_id: "fixture", body: "# 恢复分支新版" });
    assert.match(rewritten.path, /experience[\\/]md[\\/]graphs[\\/]恢复分支新版--[a-f0-9]{12}\.v1\.md$/u);
    assert.equal(content.readSync(rewritten).body, "# 恢复分支新版");
    const prompt = content.writeSync({ kind: "experience", folder: "prompts", record_id: "procedure-prompt", version: 1, title: "提示词", scope: "project:craft", status: "candidate", sensitivity: "internal", source_id: "fixture", body: "# 提示词" });
    const rewrittenPrompt = content.rewriteSync({ kind: "experience", record_id: "procedure-prompt", version: 1, current_path: prompt.path, title: "提示词新版", scope: "project:craft", status: "candidate", sensitivity: "internal", source_id: "fixture", body: "# 提示词新版" });
    assert.match(rewrittenPrompt.path, /experience[\\/]md[\\/]prompts[\\/]提示词新版--[a-f0-9]{12}\.v1\.md$/u);
    const plain = content.writeSync({ kind: "experience", record_id: "procedure-plain", version: 1, title: "普通流程", scope: "project:craft", status: "candidate", sensitivity: "internal", source_id: "fixture", body: "# 普通流程" });
    const rewrittenPlain = content.rewriteSync({ kind: "experience", record_id: "procedure-plain", version: 1, current_path: plain.path, title: "普通流程新版", scope: "project:craft", status: "candidate", sensitivity: "internal", source_id: "fixture", body: "# 普通流程新版" });
    assert.match(rewrittenPlain.path, /experience[\\/]md[\\/]普通流程新版--[a-f0-9]{12}\.v1\.md$/u);
    assert.equal(contentReference(graph), true);
    assert.equal(contentReference({ ...graph, kind: "memory" }), true);
    assert.throws(() => content.pathFor("experience", "bad", 1, "other" as never), /folder is unsupported/u);
    assert.throws(() => content.writeSync({ kind: "knowledge", folder: "graphs", record_id: "bad", version: 1, scope: "project:craft", status: "candidate", sensitivity: "internal", source_id: "fixture", body: "bad" }), /Experience content supports folders/u);
  } finally { await f.store.close(); }
});

test("bound project Experience content stays in the project tree and old shared refs remain readable", async () => {
  const f = await fixture();
  try {
    f.store.create("scope_alias", "experience-project", { status: "active", alias_kind: "path", alias: f.root, alias_digest: stableDigest(f.root),
      scope: { kind: "project", id: "project:craft" } });
    const content = f.store.contentStore;
    const project = content.writeSync({ kind: "experience", folder: "workflows", record_id: "project-flow", version: 1,
      scope: "project:craft", project_root: f.root, status: "candidate", sensitivity: "internal", source_id: "fixture", body: "# Project flow" });
    assert.equal(dirname(project.path), join(projectStorageDirectory(f.paths, f.root), "experience", "md", "workflows"));
    assert.equal(content.readSync(project).body, "# Project flow");
    const rewritten = content.rewriteSync({ kind: "experience", record_id: "project-flow", version: 1, current_path: project.path,
      scope: "project:craft", status: "routeable", sensitivity: "internal", source_id: "fixture", title: "Project flow updated", body: "# Project flow updated" });
    assert.equal(dirname(rewritten.path), dirname(project.path));
    assert.equal(content.readSync(rewritten).body, "# Project flow updated");
    assert.throws(() => content.writeSync({ kind: "experience", record_id: "unbound-flow", version: 1, scope: "project:unbound",
      status: "candidate", sensitivity: "internal", source_id: "fixture", body: "# Unbound flow" }), /no registered project root/u);
    const legacyStore = new MarkdownContentStore(f.paths);
    const legacy = legacyStore.writeSync({ kind: "experience", folder: "workflows", record_id: "legacy-project-flow", version: 1,
      scope: "project:craft", status: "candidate", sensitivity: "internal", source_id: "fixture", body: "# Legacy project flow" });
    assert.equal(legacy.path.startsWith(f.paths.experienceContentDir), true);
    assert.equal(content.readCompatSync(legacy, "project:craft").body, "# Legacy project flow");
    const legacyPath = join(f.paths.experienceContentDir, "legacy-project-flow.md");
    writeFileSync(legacyPath, readFileSync(legacy.path, "utf8"));
    assert.equal(content.readCompatSync({ ...legacy, path: legacyPath }, "project:craft").body, "# Legacy project flow");
    const memory = content.writeSync({ kind: "memory", record_id: "project-memory", version: 1, scope: "project:craft",
      project_root: f.root, status: "active", sensitivity: "internal", source_id: "fixture", body: "Project memory" });
    assert.equal(dirname(memory.path), join(projectStorageDirectory(f.paths, f.root), "memory", "md"));
    assert.equal(content.readSync(memory).body, "Project memory");
    assert.throws(() => content.writeSync({ kind: "memory", record_id: "unbound-memory", version: 1, scope: "project:unbound",
      status: "active", sensitivity: "internal", source_id: "fixture", body: "Unbound memory" }), /no registered project root/u);
    assert.equal(content.pathFor("memory", "session-memory", undefined, undefined, "session:session-123"),
      join(sessionStorageDirectory(f.paths, "craft-mcp", "session-123"), "memory", "md", "session-memory.md"));
    assert.equal(content.pathFor("memory", "hashed-session", undefined, undefined, "session:../escape"),
      join(sessionStorageDirectory(f.paths, "craft-mcp", "../escape"), "memory", "md", "hashed-session.md"));
    assert.throws(() => content.pathFor("memory", "empty-session", undefined, undefined, "session:"), /session_id/u);
    assert.throws(() => content.pathFor("memory", "oversized-session", undefined, undefined, `session:${"x".repeat(65_537)}`), /session_id/u);
    const global = content.writeSync({ kind: "experience", record_id: "global-flow", version: 1, scope: "global",
      status: "candidate", sensitivity: "internal", source_id: "fixture", body: "# Global flow" });
    assert.equal(global.path.startsWith(f.paths.experienceContentDir), true);
  } finally { await f.store.close(); }
});

test("content verification reports primitive adapter failures without assuming Error objects", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const ref = await content.write({ kind: "knowledge", record_id: "primitive", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body" });
  const asyncRead = content.read.bind(content);
  const syncRead = content.readSync.bind(content);
  content.read = (async () => { throw "primitive"; }) as typeof content.read;
  content.readSync = (() => { throw "primitive"; }) as typeof content.readSync;
  assert.equal((await content.verify(ref)).status, "drifted");
  assert.equal(content.verifySync(ref).status, "drifted");
  content.read = asyncRead;
  content.readSync = syncRead;
  await f.store.close();
});

test("content frontmatter validates every required field and accepts plain scalars", async () => {
  const f = await fixture();
  const content = new MarkdownContentStore(f.paths);
  const fields: Record<string, string> = {
    schema_version: "craft.content.v1", record_kind: "knowledge", record_id: "plain", record_version: "1",
    scope: "global", status: "active", sensitivity: "internal", source_id: "source", body_digest: "sha256:x", updated_at: "now",
  };
  const valid = join(f.root, "plain.md");
  await writeFile(valid, `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\nbody`, "utf8");
  assert.equal(content.readUncheckedSync(valid).manifest.record_id, "plain");
  for (const key of Object.keys(fields)) {
    const altered = { ...fields }; delete altered[key];
    const path = join(f.root, `missing-${key}.md`);
    await writeFile(path, `---\n${Object.entries(altered).map(([name, value]) => `${name}: ${value}`).join("\n")}\n---\nbody`, "utf8");
    assert.throws(() => content.readUncheckedSync(path), /incomplete/);
  }
  const invalidKind = { ...fields, record_kind: "other" };
  await writeFile(join(f.root, "invalid-kind.md"), `---\n${Object.entries(invalidKind).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\nbody`, "utf8");
  assert.throws(() => content.readUncheckedSync(join(f.root, "invalid-kind.md")), /incomplete/);
  const withMetadata = content.writeSync({ kind: "knowledge", record_id: "metadata", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body", frontmatter: { topic: "release", score: 1 } });
  assert.equal(content.readUncheckedSync(withMetadata.path).manifest.topic, "release");
  assert.throws(() => content.writeSync({ kind: "knowledge", record_id: "reserved", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body", frontmatter: { status: "other" } }), /invalid or reserved/);
  assert.throws(() => content.writeSync({ kind: "knowledge", record_id: "secret-meta", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body", frontmatter: { topic: "password: 12345678" } }), /credentials/);
  for (const [name, extra] of [["unsafe-key", "Bad: value"], ["unsafe-value", 'note: "password: 12345678"'], ["nonscalar", "note: {}"]]) {
    const path = join(f.root, `${name}.md`);
    await writeFile(path, `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n${extra}\n---\nbody`, "utf8");
    assert.throws(() => content.readUncheckedSync(path), /unsafe metadata/);
  }
  await f.store.close();
});

test("knowledge and memory writes persist body in Markdown and only a reference in SQLite", async () => {
  const f = await fixture();
  const evidence = f.store.create("evidence", "evidence-1", { source_type: "test", confidence: "confirmed", claim: "fixture" });
  const claim = f.service.knowledgeClaimSave({ kind: "fact", content: "A durable fact", evidence_ids: [evidence.id] }).claim as Record<string, unknown>;
  assert.equal("content" in claim, false);
  assert.equal((claim.content_ref as Record<string, unknown>).format, "markdown");
  const claimPath = String((claim.content_ref as Record<string, unknown>).path);
  assert.equal((await readFile(claimPath, "utf8")).includes("A durable fact"), true);
  const source = f.service.knowledgeSourceRegister({ source_id: "source-1", kind: "custom", label: "test", scope_kind: "user", scope_id: "local", locator: "test://source", content_digest: "source:v1" }).source as Record<string, unknown>;
  const memory = f.service.memoryLedgerRemember({ source_id: source.id, kind: "episodic", scope_kind: "user", scope_id: "local", content: "A durable memory" }).memory as Record<string, unknown>;
  assert.equal("content" in memory, false);
  assert.equal((memory.content_ref as Record<string, unknown>).format, "markdown");
  const memoryPath = String((memory.content_ref as Record<string, unknown>).path);
  assert.equal((await readFile(memoryPath, "utf8")).includes("A durable memory"), true);
  await f.store.close();
  const reopened = await new CraftStore(f.paths).open();
  const knowledgeIndex = new DatabaseSync(f.paths.knowledgeDatabaseFile);
  const memoryIndex = new DatabaseSync(f.paths.memoryDatabaseFile);
  assert.equal(Number((knowledgeIndex.prepare("SELECT COUNT(*) count FROM content_index WHERE id=?").get(String(claim.id)) as { count: number }).count), 1);
  assert.equal(Number((memoryIndex.prepare("SELECT COUNT(*) count FROM content_index WHERE id=?").get(String(memory.id)) as { count: number }).count), 1);
  knowledgeIndex.close(); memoryIndex.close(); reopened.close();
});

test("startup content indexes stream every content-bearing record family", async () => {
  const f = await fixture();
  const records = [
    ["knowledge_fragment", "knowledge", "fragment"],
    ["wiki_page", "knowledge", "wiki"],
    ["episodic_memory", "memory", "episode"],
    ["semantic_memory", "memory", "semantic"],
    ["experience_procedure", "experience", "procedure"],
  ] as const;
  for (const [recordKind, contentKind, id] of records) {
    const ref = f.store.contentStore.writeSync({ kind: contentKind, record_id: id, version: 1,
      scope: "global", status: "candidate", sensitivity: "internal", source_id: "source:test", body: `Body ${id}` });
    f.store.create(recordKind, id, { content_ref: ref });
  }
  f.store.create("knowledge_claim", "claim-without-reference", { content_ref: null });
  f.store.create("knowledge_claim", "claim-with-string-reference", { content_ref: "invalid" });
  f.store.create("knowledge_claim", "claim-with-array-reference", { content_ref: [] });
  f.store.create("knowledge_claim", "claim-with-unknown-reference-kind", { content_ref: { kind: "unknown" } });

  await f.store.close();
  const reopened = await new CraftStore(f.paths).open();
  const databaseByContentKind = {
    knowledge: new DatabaseSync(f.paths.knowledgeDatabaseFile),
    memory: new DatabaseSync(f.paths.memoryDatabaseFile),
    experience: new DatabaseSync(f.paths.experienceDatabaseFile),
  };
  try {
    for (const [recordKind, contentKind, id] of records) {
      const count = databaseByContentKind[contentKind].prepare("SELECT COUNT(*) count FROM content_index WHERE kind=? AND id=?")
        .get(recordKind, id) as { count: number };
      assert.equal(Number(count.count), 1, `${contentKind}/${recordKind}/${id} should be indexed`);
    }
    const missing = databaseByContentKind.knowledge.prepare("SELECT COUNT(*) count FROM content_index WHERE id=?")
      .get("claim-without-reference") as { count: number };
    assert.equal(Number(missing.count), 0);
    for (const id of ["claim-with-string-reference", "claim-with-array-reference", "claim-with-unknown-reference-kind"]) {
      const count = databaseByContentKind.knowledge.prepare("SELECT COUNT(*) count FROM content_index WHERE id=?").get(id) as { count: number };
      assert.equal(Number(count.count), 0);
    }
  } finally {
    for (const database of Object.values(databaseByContentKind)) database.close();
    reopened.close();
  }
  // A further start exercises the already-current index path, including the
  // non-empty equality scan that must not take a writer lock or rebuild data.
  const stable = await new CraftStore(f.paths).open();
  stable.close();
});

test("startup fails closed when an existing content index has an incompatible schema", async () => {
  const f = await fixture();
  await f.store.close();
  const index = new DatabaseSync(f.paths.knowledgeDatabaseFile);
  index.exec("DROP TABLE content_index; CREATE TABLE content_index (malformed TEXT)");
  index.close();
  try { await assert.rejects(new CraftStore(f.paths).open(), /no such column/u); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test("layout exposes flat content directories without forcing records on installation", async () => {
  const f = await fixture();
  assert.deepEqual(await readdir(f.paths.knowledgeContentDir), []);
  assert.deepEqual(await readdir(f.paths.memoryContentDir), []);
  assert.equal(existsSync(f.paths.knowledgeDatabaseFile), true);
  assert.equal(existsSync(f.paths.memoryDatabaseFile), true);
  await f.store.close();
});

test("content migration moves legacy inline bodies to Markdown idempotently", async () => {
  const f = await fixture();
  f.store.create("evidence", "unmanaged", { claim: "not content" });
  const legacy = f.store.create("memory_ledger", "legacy-memory", {
    scope_kind: "user", scope_id: "local", kind: "episodic", content: "legacy body", source_id: "legacy",
  });
  const migration = new ContentMigrationKernel(f.store);
  assert.deepEqual(migration.status(), { scanned: 1, inline: 1, referenced: 0, pending: 1 });
  assert.equal((migration.verify() as { failed: number }).failed, 1);
  assert.equal((migration.verify({ kind: "memory_ledger" }) as { failed: number }).failed, 1);
  const dry = migration.migrate({ dry_run: true });
  assert.equal(dry.migrated, 1);
  assert.equal((f.store.rawRecords("memory_ledger")[0]!.payload).content, "legacy body");
  const result = migration.migrate();
  assert.equal(result.migrated, 1);
  assert.equal(result.skipped, 0);
  const raw = f.store.rawRecords("memory_ledger")[0]!;
  assert.equal("content" in raw.payload, false);
  assert.equal((raw.payload.content_ref as Record<string, unknown>).format, "markdown");
  assert.equal(f.store.get("memory_ledger", String(legacy.id)).content, "legacy body");
  assert.deepEqual(migration.status(), { scanned: 1, inline: 0, referenced: 1, pending: 0 });
  assert.equal((migration.verify() as { verified: number }).verified, 1);
  assert.equal(migration.migrate().migrated, 0);
  assert.equal(migration.migrate().skipped, 1);
  await f.store.close();
});

test("legacy source rehydration restores the full digest-pinned page body", async () => {
  const f = await fixture();
  const sourceRoot = join(f.root, "source");
  const locator = "data/pages/projects/full-page.md";
  const sourcePath = join(sourceRoot, locator);
  await mkdir(dirname(sourcePath), { recursive: true });
  const source = "---\ntitle: Full page\nstatus: confirmed\n---\n# Full page\n\nThis is the complete source body.\n";
  await writeFile(sourcePath, source, "utf8");
  f.store.create("legacy_knowledge_migration", "rehydrate-migration", { source_root: sourceRoot, source_digest: "snapshot" });
  f.store.create("knowledge_claim", "rehydrate-claim", { kind: "fact", scope: "legacy:shared:shared", status: "candidate", source_id: "legacy-import", content: "Full page\n\nShort summary" });
  new ContentMigrationKernel(f.store).migrate();
  f.store.create("legacy_knowledge_migration_candidate", "rehydrate-candidate", {
    migration_id: "rehydrate-migration", claim_id: "rehydrate-claim", source_locator: locator,
    source_digest: `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`, status: "candidate",
  });
  const migration = new ContentMigrationKernel(f.store);
  assert.throws(() => migration.rehydrateLegacy({}), /migration_id/);
  assert.equal(migration.rehydrateLegacy({ migration_id: "rehydrate-migration", dry_run: true }).migrated, 1);
  const replaceBatch = f.store.replacePayloadBatch.bind(f.store);
  f.store.replacePayloadBatch = (() => { throw "rehydrate failure"; }) as typeof f.store.replacePayloadBatch;
  assert.throws(() => migration.rehydrateLegacy({ migration_id: "rehydrate-migration" }), /rolled back; database backup: .*; rehydrate failure/);
  f.store.replacePayloadBatch = replaceBatch;
  const result = migration.rehydrateLegacy({ migration_id: "rehydrate-migration" });
  assert.equal(result.migrated, 1);
  assert.match(String(f.store.get("knowledge_claim", "rehydrate-claim").content), /complete source body/);
  assert.equal((migration.verify({ kind: "knowledge_claim" }) as { failed: number }).failed, 0);
  assert.equal(migration.rehydrateLegacy({ migration_id: "rehydrate-migration" }).skipped, 1);
  await writeFile(sourcePath, `${source}changed`, "utf8");
  const candidate = f.store.rawRecords("legacy_knowledge_migration_candidate").find((row) => row.id === "rehydrate-candidate")!;
  f.store.replacePayload("legacy_knowledge_migration_candidate", candidate.id, candidate.version, { ...candidate.payload, source_digest: `sha256:${createHash("sha256").update(`${source}changed`, "utf8").digest("hex")}` });
  const originalBatch = f.store.replacePayloadBatch.bind(f.store);
  f.store.replacePayloadBatch = (() => { throw new Error("rehydrate error"); }) as typeof f.store.replacePayloadBatch;
  assert.throws(() => migration.rehydrateLegacy({ migration_id: "rehydrate-migration" }), /rolled back; database backup: .*; rehydrate error/);
  f.store.replacePayloadBatch = originalBatch;
  f.store.replacePayload("legacy_knowledge_migration_candidate", candidate.id, candidate.version, { ...candidate.payload, source_digest: `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}` });
  assert.throws(() => migration.rehydrateLegacy({ migration_id: "rehydrate-migration" }), /digest drifted/);
  await f.store.close();
});

test("legacy source rehydration rejects missing, unsafe, stale, and malformed sources", async () => {
  const f = await fixture();
  const migration = new ContentMigrationKernel(f.store);
  const rawDigest = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
  async function candidate(migrationId: string, candidateId: string, claimId: string | null, locator: string | undefined, source: string | undefined, sourceDigest: string | undefined): Promise<void> {
    const sourceRoot = join(f.root, migrationId);
    await mkdir(join(sourceRoot, "data/pages"), { recursive: true });
    if (source !== undefined && locator !== undefined && !locator.startsWith("../")) {
      const path = join(sourceRoot, locator);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source, "utf8");
    }
    f.store.create("legacy_knowledge_migration", migrationId, { source_root: sourceRoot });
    if (claimId) {
      f.store.create("knowledge_claim", claimId, { kind: "fact", scope: "global", status: "candidate", source_id: "legacy", content: "summary" });
      migration.migrate();
    }
    f.store.create("legacy_knowledge_migration_candidate", candidateId, {
      migration_id: migrationId, claim_id: claimId, source_locator: locator, source_digest: sourceDigest, status: "candidate",
    });
  }
  const missingClaimRoot = join(f.root, "missing-claim"); await mkdir(join(missingClaimRoot, "data/pages"), { recursive: true });
  f.store.create("legacy_knowledge_migration", "missing-claim", { source_root: missingClaimRoot });
  f.store.create("legacy_knowledge_migration_candidate", "missing-claim-candidate", { migration_id: "missing-claim", claim_id: "unknown-claim", source_locator: "data/pages/missing.md", source_digest: rawDigest("body"), status: "candidate" });
  assert.throws(() => migration.rehydrateLegacy({ migration_id: "missing-claim" }), /claim reference is missing/);
  await candidate("missing-ref", "missing-ref-candidate", "missing-ref-claim", "data/pages/missing.md", "body", rawDigest("body"));
  const missingRef = f.store.rawRecords("knowledge_claim").find((row) => row.id === "missing-ref-claim")!;
  f.store.replacePayload("knowledge_claim", missingRef.id, missingRef.version, { content: "summary" });
  assert.throws(() => migration.rehydrateLegacy({ migration_id: "missing-ref" }), /claim reference is missing/);
  await candidate("missing-locator", "missing-locator-candidate", "missing-locator-claim", undefined, undefined, undefined);
  assert.throws(() => migration.rehydrateLegacy({ migration_id: "missing-locator" }), /source locator is missing/);
  await candidate("escaping-locator", "escaping-locator-candidate", "escaping-locator-claim", "../outside.md", "body", rawDigest("body"));
  assert.throws(() => migration.rehydrateLegacy({ migration_id: "escaping-locator" }), /escapes source root/);
  await candidate("empty-digest", "empty-digest-candidate", "empty-digest-claim", "data/pages/empty.md", "body", undefined);
  assert.throws(() => migration.rehydrateLegacy({ migration_id: "empty-digest" }), /digest drifted/);
  await candidate("malformed-source", "malformed-source-candidate", "malformed-source-claim", "data/pages/malformed.md", "---\nunclosed", rawDigest("---\nunclosed"));
  assert.throws(() => migration.rehydrateLegacy({ migration_id: "malformed-source" }), /frontmatter is not closed/);
  const symlinkRoot = join(f.root, "symlink-source"); const outside = join(f.root, "outside-directory");
  await mkdir(join(symlinkRoot, "data/pages"), { recursive: true }); await mkdir(outside, { recursive: true }); await symlink(outside, join(symlinkRoot, "data/pages/link.md"), "junction");
  f.store.create("legacy_knowledge_migration", "symlink-source", { source_root: symlinkRoot });
  f.store.create("knowledge_claim", "symlink-claim", { kind: "fact", scope: "global", status: "candidate", source_id: "legacy", content: "summary" }); migration.migrate();
  f.store.create("legacy_knowledge_migration_candidate", "symlink-candidate", { migration_id: "symlink-source", claim_id: "symlink-claim", source_locator: "data/pages/link.md", source_digest: rawDigest("outside"), status: "candidate" });
  assert.throws(() => migration.rehydrateLegacy({ migration_id: "symlink-source" }), /path escapes source root/);
  await candidate("plain-source", "plain-source-candidate", "plain-source-claim", "data/pages/plain.md", "plain source body", rawDigest("plain source body"));
  assert.equal(migration.rehydrateLegacy({ migration_id: "plain-source" }).migrated, 1);
  const versionRoot = join(f.root, "versioned-source"); const versionLocator = "data/pages/versioned.md"; const versionBody = "version two source";
  await mkdir(join(versionRoot, "data/pages"), { recursive: true }); await writeFile(join(versionRoot, versionLocator), versionBody, "utf8");
  f.store.create("legacy_knowledge_migration", "versioned-source", { source_root: versionRoot });
  f.store.create("knowledge_claim", "versioned-claim", { kind: "fact", scope: "global", status: "candidate", source_id: "legacy", content: "version one" });
  f.store.save("knowledge_claim", "versioned-claim", { kind: "fact", scope: "global", status: "candidate", source_id: "legacy", content: "version two" });
  migration.migrate();
  f.store.create("legacy_knowledge_migration_candidate", "versioned-candidate", { migration_id: "versioned-source", claim_id: "versioned-claim", source_locator: versionLocator, source_digest: rawDigest(versionBody), status: "candidate" });
  assert.equal(migration.rehydrateLegacy({ migration_id: "versioned-source" }).migrated, 1);
  await f.store.close();
});

test("content migration relocates old content references into the domain directory", async () => {
  const f = await fixture();
  const content = f.store.contentStore;
  const current = content.writeSync({ kind: "memory", record_id: "old-ref", version: 1, scope: "task", status: "active", sensitivity: "internal", source_id: "legacy", body: "old reference" });
  const oldPath = content.legacyPathFor("memory", "old-ref", 1);
  await mkdir(dirname(oldPath), { recursive: true });
  await writeFile(oldPath, await readFile(current.path, "utf8"), "utf8");
  f.store.create("memory_ledger", "old-ref", { scope: "task", content_ref: { ...current, path: oldPath } });
  const result = new ContentMigrationKernel(f.store).migrate();
  assert.equal(result.migrated, 1);
  assert.match(String((f.store.rawRecords("memory_ledger")[0]!.payload.content_ref as Record<string, unknown>).path), /memory[\\/]md[\\/]old-reference--[a-f0-9]{12}\.v1\.md$/);
  await f.store.close();
});

test("legacy project Knowledge paths are compatibility-only and migrate from an exact project identity", async () => {
  const f = await fixture();
  try {
    const projectRoot = join(f.root, "legacy-project");
    await mkdir(projectRoot);
    const scope = "project:legacy-project-identity";
    const canonicalScope = { kind: "project", id: scope };
    const identity = { canonical_scope: canonicalScope, project_kind: "local_fingerprint", remote_digest: null };
    f.store.create("project_identity", scope, { ...identity, local_path_alias: projectRoot,
      identity_digest: stableDigest({ canonical: canonicalScope, project_kind: identity.project_kind, remote_digest: identity.remote_digest }) });
    assert.equal(f.store.find("project_identity", scope)?.identity_digest,
      stableDigest({ canonical: canonicalScope, project_kind: identity.project_kind, remote_digest: identity.remote_digest }));
    f.store.create("scope_alias", "legacy-project-path", { scope: canonicalScope, alias_kind: "path", alias: projectRoot,
      alias_digest: stableDigest(projectRoot), identity_digest: "fixture", status: "active" });
    const current = f.store.contentStore.writeSync({ kind: "knowledge", record_id: "legacy-project-claim", version: 1,
      scope, status: "candidate", sensitivity: "internal", source_id: "legacy", body: "Verified legacy body" });
    const legacyPath = join(projectRoot, ".craft_data", "knowledge", "md", "legacy-project-claim.v1.md");
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, await readFile(current.path, "utf8"), "utf8");
    const { scope: _scope, ...legacyReferenceWithoutScope } = current;
    const claim = f.store.create("knowledge_claim", "legacy-project-claim", {
      scope, status: "candidate", source_id: "legacy", content_ref: { ...legacyReferenceWithoutScope, path: legacyPath },
    });
    f.store.remove("scope_alias", "legacy-project-path");
    assert.equal(f.store.list("scope_alias", 10, item => item.status === "active"
      && (item.scope as Record<string, unknown> | undefined)?.id === scope).length, 0);
    assert.equal(f.store.contentStore.isCanonicalRef(claim.content_ref as any), false);
    assert.equal((claim.content_ref as Record<string, unknown>).scope, undefined);
    assert.equal(projectKnowledgeContentDirectory(f.store, scope, { reference_path: legacyPath }), fs.realpathSync(dirname(legacyPath)));
    assert.equal(f.store.contentStore.readCompatSync(claim.content_ref as any, scope).body, "Verified legacy body");

    const migration = new ContentMigrationKernel(f.store);
    const record_refs = [{ kind: "knowledge_claim", id: "legacy-project-claim", version: 1 }];
    assert.equal(migration.migrate({ dry_run: true, record_refs }).migrated, 1);
    assert.equal(migration.migrate({ record_refs }).migrated, 1);

    const moved = f.store.get("knowledge_claim", "legacy-project-claim").content_ref as Record<string, unknown>;
    assert.ok(String(moved.path).startsWith(join(projectStorageDirectory(f.paths, projectRoot), "knowledge", "md")));
    assert.equal(f.store.contentStore.verifySync(moved as any).status, "verified");
    assert.equal(existsSync(legacyPath), true, "migration keeps the old file for rollback and audit");
    assert.throws(() => f.store.contentStore.readCompatSync({ ...current, path: join(projectRoot, "outside.md"), scope }), /outside the canonical directory/u);
  } finally { await f.store.close(); }
});

test("content migration preserves old wiki files and fails closed on secrets", async () => {
  const f = await fixture();
  const oldPath = join(f.root, "legacy-page.md");
  await writeFile(oldPath, "legacy wiki", "utf8");
  f.store.create("wiki_page", "legacy-page", { title: "Legacy", scope: "global", file_path: oldPath, body_digest: "sha256:old" });
  const migration = new ContentMigrationKernel(f.store);
  assert.equal(migration.migrate().migrated, 1);
  const page = f.store.get("wiki_page", "legacy-page");
  assert.match(String(page.file_path), /knowledge[\\/]md[\\/]Legacy--[a-f0-9]{12}\.v1\.md$/);
  assert.equal(f.store.contentStore.readSync(page.content_ref as never).body, "legacy wiki");

  f.store.create("knowledge_claim", "secret-claim", { kind: "fact", content: "api_key: abcdefgh", evidence_ids: [] });
  assert.throws(() => migration.migrate(), /credentials|secrets/);
  assert.equal(f.store.rawRecords("knowledge_claim").find((item) => item.id === "secret-claim")!.payload.content, "api_key: abcdefgh");
  await f.store.close();
});

test("content migration resolves wiki defaults, legacy source fields, and primitive rollback errors", async () => {
  const f = await fixture();
  const migration = new ContentMigrationKernel(f.store);
  f.store.create("wiki_page", "wiki-default", { title: "Wiki", file_path: join(f.root, "wiki-default.md") });
  await writeFile(join(f.root, "wiki-default.md"), "wiki body", "utf8");
  f.store.create("memory_ledger", "source-only", { content: "memory body", source: "legacy-source", status: "active" });
  f.store.create("memory_ledger", "fallback-source", { content: "fallback body" });
  assert.equal(migration.migrate({ dry_run: true }).migrated, 3);
  const original = f.store.replacePayloadBatch.bind(f.store);
  f.store.replacePayloadBatch = (() => { throw "primitive failure"; }) as typeof f.store.replacePayloadBatch;
  assert.throws(() => migration.migrate(), /rolled back; database backup: .*; primitive failure/);
  f.store.replacePayloadBatch = original;
  await f.store.close();
});

test("content references reject metadata drift in canonical and legacy files", async () => {
  const f = await fixture();
  const content = f.store.contentStore;
  const canonical = await content.write({ kind: "knowledge", record_id: "metadata", version: 1, scope: "global", status: "active", sensitivity: "internal", source_id: "source", body: "body" });
  const canonicalRaw = await readFile(canonical.path, "utf8");
  await writeFile(canonical.path, canonicalRaw.replace("record_version: 1", "record_version: 2"), "utf8");
  await assert.rejects(content.read(canonical), /metadata drifted/);
  assert.throws(() => content.readSync(canonical), /metadata drifted/);

  const legacy = content.legacyPathFor("memory", "legacy-metadata", 1);
  await mkdir(dirname(legacy), { recursive: true });
  const legacyRef = content.writeSync({ kind: "memory", record_id: "legacy-metadata", version: 1, scope: "task", status: "active", sensitivity: "internal", source_id: "source", body: "legacy" });
  const legacyRaw = readFileSync(legacyRef.path, "utf8");
  await writeFile(legacy, legacyRaw.replace('record_id: "legacy-metadata"', 'record_id: "wrong"'), "utf8");
  assert.throws(() => content.readCompatSync({ ...legacyRef, path: legacy }), /metadata drifted/);
  await writeFile(legacy, legacyRaw.replace('body_digest: "sha256:', 'body_digest: "sha256:wrong'), "utf8");
  assert.throws(() => content.readCompatSync({ ...legacyRef, path: legacy }), /digest drifted/);
  await f.store.close();
});

test("content migration rejects missing legacy bodies and reports database rollback", async () => {
  const f = await fixture();
  f.store.create("wiki_page", "missing-page", { title: "Missing", file_path: join(f.root, "does-not-exist.md") });
  assert.throws(() => new ContentMigrationKernel(f.store).migrate(), /ENOENT|no such file/);
  f.store.remove("wiki_page", "missing-page");
  f.store.create("memory_ledger", "rollback-memory", { content: "will not be attached" });
  const migration = new ContentMigrationKernel(f.store);
  const original = f.store.replacePayloadBatch.bind(f.store);
  f.store.replacePayloadBatch = (() => { throw new Error("simulated database failure"); }) as typeof f.store.replacePayloadBatch;
  assert.throws(() => migration.migrate(), /rolled back; database backup/);
  f.store.replacePayloadBatch = original;
  f.store.create("memory_ledger", "empty-memory", { scope: "task" });
  assert.throws(() => migration.migrate(), /no readable content body/);
  await f.store.close();
});

test("legacy consolidation memories also use Markdown references", async () => {
  const f = await fixture();
  const consolidation = new MemoryConsolidationKernel(f.store);
  const remembered = consolidation.remember({ memory_id: "episodic-1", scope: "task", content: "Observed a stable workflow", source: "test" });
  assert.equal(f.store.get("episodic_memory", "episodic-1").content, "Observed a stable workflow");
  const raw = f.store.rawRecords("episodic_memory")[0]!;
  assert.equal("content" in raw.payload, false);
  const consolidated = consolidation.consolidate({ memory_ids: ["episodic-1"], content: "Stable workflow summary" });
  assert.equal(f.store.get("semantic_memory", String((consolidated.memory as Record<string, unknown>).id)).content, "Stable workflow summary");
  assert.equal("content" in f.store.rawRecords("semantic_memory")[0]!.payload, false);
  await f.store.close();
});

test("knowledge memory runtime fails closed when a referenced body disappears", async () => {
  const f = await fixture();
  const source = f.service.knowledgeSourceRegister({ source_id: "source-runtime", kind: "custom", label: "runtime", scope_kind: "user", scope_id: "local", locator: "test://runtime", content_digest: "v1" }).source as Record<string, unknown>;
  const memory = f.service.memoryLedgerRemember({ memory_id: "runtime-memory", source_id: source.id, kind: "episodic", scope_kind: "user", scope_id: "local", content: "body" }).memory as Record<string, unknown>;
  await unlink(String((memory.content_ref as Record<string, unknown>).path));
  assert.throws(() => f.service.memoryLedger.get({ memory_id: "runtime-memory" }), /ENOENT|no such file|body/);
  f.store.create("memory_ledger", "missing-ref", { scope: { kind: "user", id: "local" }, source_id: source.id, status: "active" });
  assert.throws(() => f.service.memoryLedger.get({ memory_id: "missing-ref" }), /reference is missing/);
  await f.store.close();
});

test("migration-only store payload replacement is transactional", async () => {
  const f = await fixture();
  f.store.create("legacy", "one", { content: "before" });
  f.store.replacePayload("legacy", "one", 1, { content: "after", version: 99 });
  assert.equal(f.store.get("legacy", "one").content, "after");
  f.store.replacePayloadBatch([]);
  assert.throws(() => f.store.replacePayload("legacy", "missing", 1, { value: true }), /Unknown record/);
  assert.throws(() => f.store.replacePayloadBatch([{ kind: "legacy", id: "one", version: 99, payload: { value: false } }]), /Unknown record/);
  assert.equal(f.store.get("legacy", "one").content, "after");
  await f.store.close();
});

test("content diagnostics are exposed through full and syscall MCP surfaces", async () => {
  const f = await fixture();
  const server = new McpServer(f.service, "full");
  const response = await server.handle({ id: 1, method: "tools/call", params: { name: "craft_content_status", arguments: {} } });
  assert.equal((response?.result as Record<string, unknown>).isError, false);
  const verify = await server.handle({ id: 3, method: "tools/call", params: { name: "craft_content_verify", arguments: {} } });
  assert.equal((verify?.result as Record<string, unknown>).isError, false);
  const migrate = await server.handle({ id: 4, method: "tools/call", params: { name: "craft_content_migrate", arguments: { dry_run: true } } });
  assert.equal((migrate?.result as Record<string, unknown>).isError, false);
  const syscall = new McpServer(f.service, "syscall");
  const listed = await syscall.handle({ id: 2, method: "tools/call", params: { name: "craft_list", arguments: { resource: "knowledge_claim" } } });
  assert.equal((listed?.result as Record<string, unknown>).isError, false);
  await f.store.close();
});

test("Wiki compatibility reads and refreshes cover canonical, legacy, and drifted files", async () => {
  const f = await fixture();
  const created = await f.service.wikiPageSave({ page_id: "wiki-compat", title: "Compat", body: "first", scope: "global" });
  const page = created.page as Record<string, unknown>;
  await f.service.wikiPageSave({ page_id: "wiki-compat", title: "Compat", body: "second", scope: "global" });
  assert.equal((f.service.wikiPageGet({ page_id: "wiki-compat" }) as Record<string, unknown>).body, "second");
  const saved = f.store.get("wiki_page", "wiki-compat");
  f.store.save("wiki_page", "wiki-compat", { ...saved, body_digest: "sha256:wrong", identity_digest: null });
  await assert.rejects(f.service.wikiPageSave({ page_id: "wiki-compat", title: "Compat", body: "third", scope: "global" }), /unrecorded changes/);

  const fallbackPath = join(f.root, "wiki-fallback.md");
  await writeFile(fallbackPath, "plain fallback", "utf8");
  f.store.save("wiki_page", "wiki-compat", { ...f.store.get("wiki_page", "wiki-compat"), file_path: fallbackPath,
    content_ref: { kind: "knowledge", record_id: "wiki-compat", version: 2, path: join(f.root, "missing-ref.md"), digest: "sha256:missing", bytes: 1, format: "markdown" }, body_digest: "sha256:plain" });
  assert.equal((f.service.wikiPageGet({ page_id: "wiki-compat" }) as Record<string, unknown>).body, "plain fallback");
  assert.equal((f.service.wikiPageRefresh({ page_id: "wiki-compat" }) as Record<string, unknown>).changed, true);

  const noFilePath = f.store.create("wiki_page", "wiki-no-file", { title: "No file", scope: "global", content_ref: { ...(page.content_ref as Record<string, unknown>), path: join(f.root, "missing-no-file.md") }, body_digest: page.body_digest });
  assert.throws(() => f.service.wikiPageRefresh({ page_id: "wiki-no-file" }), /ENOENT|no such file|frontmatter/);

  const legacyPath = join(f.root, "legacy-save.md");
  await writeFile(legacyPath, "legacy old", "utf8");
  f.store.create("wiki_page", "legacy-save", { title: "Legacy", file_path: legacyPath, body_digest: digest("legacy old"), identity_digest: null, scope: "global" });
  assert.equal((f.service.wikiPageGet({ page_id: "legacy-save" }) as Record<string, unknown>).body, "legacy old");
  await f.service.wikiPageSave({ page_id: "legacy-save", title: "Legacy", body: "legacy new", scope: "global" });
  const missingLegacy = join(f.root, "missing-legacy-save.md");
  f.store.create("wiki_page", "missing-legacy-save", { title: "Missing", file_path: missingLegacy, body_digest: digest("old"), identity_digest: null, scope: "global" });
  await assert.rejects(f.service.wikiPageSave({ page_id: "missing-legacy-save", title: "Missing", body: "new", scope: "global" }), /unrecorded changes/);
  const refreshPath = join(f.root, "refresh-legacy.md");
  await writeFile(refreshPath, "refresh body", "utf8");
  f.store.create("wiki_page", "refresh-legacy", { title: "Refresh", file_path: refreshPath, body_digest: digest("old"), identity_digest: null });
  assert.equal((f.service.wikiPageRefresh({ page_id: "refresh-legacy" }) as Record<string, unknown>).changed, true);
  await f.store.close();
});


test("content relocation is idempotent and refuses scope drift and destination collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-relocate-content-"));
  try {
    const paths = craftPaths(join(root, "data"));
    const legacy = new MarkdownContentStore(paths);
    const original = legacy.writeSync({ kind: "experience", record_id: "relocate", version: 1, scope: "project:demo",
      status: "candidate", sensitivity: "internal", source_id: "task", body: "# 已验证流程", folder: "graphs" });
    const content = new MarkdownContentStore(paths);
    const targetDir = join(root, "project", ".craft_data", "experience", "md");
    await mkdir(join(targetDir, "graphs"), { recursive: true });
    content.setProjectExperienceDirectoryResolver(() => targetDir);
    assert.throws(() => content.relocateSync(original, "project:other"), /scope drifted/);
    const migrated = content.relocateSync(original, "project:demo");
    assert.deepEqual(content.relocateSync(original, "project:demo"), migrated);
    assert.deepEqual(content.relocateSync(migrated, "project:demo"), migrated);
    await writeFile(migrated.path, "conflicting bytes");
    assert.throws(() => content.relocateSync(original, "project:demo"), /destination conflicts/);
    await unlink(migrated.path);
    await symlink(original.path, migrated.path);
    assert.throws(() => content.relocateSync(original, "project:demo"), /regular file/);
    assert.equal((await readdir(dirname(migrated.path))).some(name => name.endsWith(".tmp")), false);
    assert.equal(legacy.readSync(original).body, "# 已验证流程");
    await unlink(migrated.path);
    const link = fs.linkSync;
    try {
      fs.linkSync = () => { throw Object.assign(new Error("link I/O failure"), { code: "EIO" }); };
      syncBuiltinESMExports();
      assert.throws(() => content.relocateSync(original, "project:demo"), /link I\/O failure/);
    } finally { fs.linkSync = link; syncBuiltinESMExports(); }
    assert.equal((await readdir(dirname(migrated.path))).some(name => name.endsWith(".tmp")), false);
    await rm(dirname(migrated.path), { recursive: true });
    const outside = join(root, "outside"); await mkdir(outside);
    await symlink(outside, dirname(migrated.path));
    assert.throws(() => content.relocateSync(original, "project:demo"), /directory must be regular/);
    await unlink(dirname(migrated.path));
    await writeFile(original.path, (await readFile(original.path, "utf8")).replace(/^title:.*\n/m, ""));
    const withoutTitle = content.relocateSync(original, "project:demo");
    assert.equal(content.readSync(withoutTitle).body, "# 已验证流程");
  } finally { await rm(root, { recursive: true, force: true }); }
});
