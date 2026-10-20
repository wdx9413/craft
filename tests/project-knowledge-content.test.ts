import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/application/craft-service.ts";
import { knowledgeDirectoryForScope, projectKnowledgeContentDirectory, projectRootForKnowledgeSource } from "../core/project-knowledge-content.ts";

test("Knowledge source project-root inference accepts only supported regular source files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "craft-project-source-root-"));
  const readme = join(parent, "README.md"), note = join(parent, "notes.md"), wrongReadme = join(parent, "OTHER.md"), link = join(parent, "linked.md");
  try {
    await writeFile(readme, "readme");
    await writeFile(note, "note");
    await writeFile(wrongReadme, "not the project readme");
    await symlink(note, link);
    assert.equal(projectRootForKnowledgeSource({}), null);
    assert.equal(projectRootForKnowledgeSource({ locator: 4 }), null);
    assert.equal(projectRootForKnowledgeSource({ kind: "unsupported", locator: note }), null);
    assert.equal(projectRootForKnowledgeSource({ kind: "readme", locator: readme }), dirname(resolve(readme)));
    assert.equal(projectRootForKnowledgeSource({ kind: "project_note", locator: note }), dirname(resolve(note)));
    assert.equal(projectRootForKnowledgeSource({ kind: "readme", locator: wrongReadme }), null);
    assert.equal(projectRootForKnowledgeSource({ kind: "readme", locator: join(parent, "missing.md") }), null);
    assert.equal(projectRootForKnowledgeSource({ kind: "project_note", locator: parent }), null);
    assert.equal(projectRootForKnowledgeSource({ kind: "readme", locator: parent }), null);
    assert.equal(projectRootForKnowledgeSource({ kind: "project_note", locator: link }), null);
    assert.equal(projectRootForKnowledgeSource({ kind: "serena", locator: join(parent, "sub", "index.json") }), parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("project Knowledge directory resolution validates scope, aliases, and pinned references", async () => {
  const parent = await mkdtemp(join(tmpdir(), "craft-project-knowledge-path-"));
  const root = join(parent, "project"), other = join(parent, "other");
  const store = await new CraftStore(craftPaths(join(parent, "global"))).open();
  const service = new CraftService(store);
  try {
    await mkdir(root);
    await mkdir(other);
    assert.equal(projectKnowledgeContentDirectory(store, "invalid"), null);
    assert.equal(projectKnowledgeContentDirectory(store, "global"), null);
    assert.equal(projectKnowledgeContentDirectory(store, "project:bad/id"), null);
    assert.equal(projectKnowledgeContentDirectory(store, "project:unbound"), null);
    assert.equal(knowledgeDirectoryForScope(store, "global"), store.paths.knowledgeDir);

    service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: root });
    service.scopeAliasBind({ scope_kind: "project", scope_id: "project:missing", alias_kind: "path", alias: join(parent, "missing-root") });
    const directory = join(store.paths.knowledgeDir, "projects", "demo", "md");
    assert.equal(projectKnowledgeContentDirectory(store, "project:demo"), directory);
    assert.equal(projectKnowledgeContentDirectory(store, "project:project:demo"), directory);
    assert.equal(projectKnowledgeContentDirectory(store, "project:demo", { project_root: root }), directory);
    assert.throws(() => projectKnowledgeContentDirectory(store, "project:demo", { project_root: other }), /not registered/u);
    assert.equal(projectKnowledgeContentDirectory(store, "project:demo", { reference_path: join(directory, "claim.md") }), directory);
    assert.equal(projectKnowledgeContentDirectory(store, "project:demo", { reference_path: directory }), null);
    assert.equal(projectKnowledgeContentDirectory(store, "project:demo", { reference_path: join(root, "outside.md") }), null);
    assert.equal(existsSync(directory), false);
    assert.equal(projectKnowledgeContentDirectory(store, "project:missing"), null);
    assert.throws(() => knowledgeDirectoryForScope(store, "project:unbound"), /no registered project root/u);
    assert.equal(projectKnowledgeContentDirectory(store, "project:demo", { create: true }), directory);
    assert.equal((await lstat(directory)).isDirectory(), true);
    const content = store.contentStore.writeSync({ kind: "knowledge", record_id: "claim-demo", version: 1, scope: "project:demo",
      status: "candidate", sensitivity: "internal", source_id: "test", title: "项目知识测试", body: "项目知识测试正文" });
    assert.equal(dirname(content.path), directory);
    assert.equal(existsSync(join(root, ".craft_data")), false);
    assert.equal(projectKnowledgeContentDirectory(store, "project:demo"), directory);
    assert.equal(knowledgeDirectoryForScope(store, "project:demo", { reference_path: join(root, "legacy.md") }), dirname(directory));
    assert.equal(knowledgeDirectoryForScope(store, "project:demo"), dirname(directory));

    service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: other });
    assert.throws(() => projectKnowledgeContentDirectory(store, "project:demo"), /ambiguous/u);
    assert.equal(projectKnowledgeContentDirectory(store, "project:demo", { project_root: root }), directory);
    assert.equal(projectKnowledgeContentDirectory(store, "project:demo", { reference_path: join(directory, "claim.md") }), directory);
  } finally {
    store.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("project Knowledge directory creation rejects files and symlinked capability roots before writing through them", async () => {
  const parent = await mkdtemp(join(tmpdir(), "craft-project-knowledge-symlink-"));
  const file = join(parent, "project-file"), symlinkRoot = join(parent, "project-symlink"), external = join(parent, "external");
  const store = await new CraftStore(craftPaths(join(parent, "global"))).open();
  const service = new CraftService(store);
  try {
    await writeFile(file, "not a directory");
    await mkdir(symlinkRoot);
    await mkdir(external);
    service.scopeAliasBind({ scope_kind: "project", scope_id: "project:file", alias_kind: "path", alias: file });
    assert.throws(() => projectKnowledgeContentDirectory(store, "project:file"), /directory/u);

    service.scopeAliasBind({ scope_kind: "project", scope_id: "project:link", alias_kind: "path", alias: symlinkRoot });
    const projectDir = join(store.paths.knowledgeDir, "projects", "link");
    await mkdir(dirname(projectDir), { recursive: true });
    await symlink(external, projectDir);
    assert.throws(() => projectKnowledgeContentDirectory(store, "project:link"), /regular directories/u);
    assert.throws(() => projectKnowledgeContentDirectory(store, "project:link", { create: true }), /regular directories/u);
    assert.equal(existsSync(join(external, "md")), false);
  } finally {
    store.close();
    await rm(parent, { recursive: true, force: true });
  }
});
