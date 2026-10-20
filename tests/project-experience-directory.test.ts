import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableDigest } from "../core/digest.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { experienceDataDirectory, projectExperienceContentDirectory, projectExperienceDirectory, projectPathAliasDigest } from "../core/project-experience-directory.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-project-experience-"));
  const store = await new CraftStore(craftPaths(join(root, "store"))).open();
  const project = join(root, "project"), clone = join(root, "clone");
  mkdirSync(project); mkdirSync(clone);
  const bind = (id: string, path: string) => store.create("scope_alias", id, { status: "active", scope: { kind: "project", id: "project:test" },
    alias_kind: "path", alias: path, alias_digest: stableDigest(path) });
  return { root, project, clone, store, bind, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("project Experience directory resolves only the registered project .craft_data path", async () => {
  const f = await fixture();
  try {
    f.bind("project", f.project);
    const projectData = join(realpathSync(f.project), ".craft_data", "experience");
    assert.equal(projectExperienceDirectory(f.store, "project:test", f.project), projectData);
    assert.equal(projectExperienceDirectory(f.store, "project:test", f.project, true), projectData);
    assert.equal(projectExperienceContentDirectory(f.store, "project:test", { create: true }), join(projectData, "md"));
    assert.equal(projectExperienceContentDirectory(f.store, "project:project:test"), join(projectData, "md"));
    assert.equal(projectExperienceContentDirectory(f.store, "project:test", { reference_path: join(projectData, "md", "flow.v1.md") }), join(projectData, "md"));
    assert.equal(projectExperienceContentDirectory(f.store, "project:test", { reference_path: join(f.store.paths.experienceContentDir, "legacy.v1.md") }), null);
    assert.equal(projectExperienceContentDirectory(f.store, "global"), null);
    assert.equal(projectExperienceContentDirectory(f.store, "bad"), null);
    assert.equal(projectExperienceContentDirectory(f.store, "project:bad/id"), null);
    assert.equal(experienceDataDirectory(f.store, "global"), f.store.paths.experienceDir);
    assert.equal(experienceDataDirectory(f.store, "project:test"), projectData);
    assert.equal(experienceDataDirectory(f.store, "project:test", true), projectData);
    assert.equal(projectExperienceDirectory(f.store, "project:test", f.project, true), projectData);
    assert.equal(projectPathAliasDigest(f.store, "project:test", f.project), stableDigest(f.project));
    assert.throws(() => projectExperienceDirectory(f.store, "invalid", f.project), /scope is invalid/u);
    assert.equal(experienceDataDirectory(f.store, "tenant:test"), f.store.paths.experienceDir);
    assert.throws(() => experienceDataDirectory(f.store, "project:missing"), /not registered/u);
    assert.equal(experienceDataDirectory(f.store, "bad"), f.store.paths.experienceDir);
    assert.throws(() => projectExperienceDirectory(f.store, "project:missing"), /not registered/u);
    assert.throws(() => projectExperienceDirectory(f.store, "project:test", f.clone), /not registered/u);
    assert.throws(() => projectPathAliasDigest(f.store, "invalid", f.project), /scope is invalid/u);
    assert.throws(() => projectPathAliasDigest(f.store, "project:missing"), /not registered/u);
    const deleted = join(f.root, "deleted");
    f.store.create("scope_alias", "deleted", { status: "active", scope: { kind: "project", id: "project:deleted" },
      alias_kind: "path", alias: deleted, alias_digest: stableDigest(deleted) });
    assert.throws(() => projectExperienceDirectory(f.store, "project:deleted"), /not registered/u);
    assert.throws(() => projectPathAliasDigest(f.store, "project:deleted"), /not registered/u);
  } finally { f.close(); }
});

test("project Experience directory pins a clone and rejects ambiguity and symlinks", async () => {
  const f = await fixture();
  try {
    f.bind("project", f.project); f.bind("clone", f.clone);
    assert.throws(() => projectExperienceDirectory(f.store, "project:test"), /ambiguous/u);
    assert.throws(() => projectExperienceContentDirectory(f.store, "project:test"), /ambiguous/u);
    assert.throws(() => projectPathAliasDigest(f.store, "project:test"), /ambiguous/u);
    const cloneData = join(realpathSync(f.clone), ".craft_data", "experience");
    assert.equal(projectExperienceDirectory(f.store, "project:test", undefined, true, stableDigest(f.clone)), cloneData);
    const outside = join(f.root, "outside"); mkdirSync(outside);
    rmSync(join(f.clone, ".craft_data"), { recursive: true, force: true });
    symlinkSync(outside, join(f.clone, ".craft_data"));
    assert.throws(() => projectExperienceDirectory(f.store, "project:test", f.clone, true), /regular directories/u);
    rmSync(join(f.clone, ".craft_data"), { recursive: true, force: true });
    rmSync(cloneData, { recursive: true, force: true });
    mkdirSync(cloneData, { recursive: true });
    symlinkSync(outside, join(cloneData, "md"));
    assert.throws(() => projectExperienceContentDirectory(f.store, "project:test", { project_root: f.clone, create: true }), /regular directory/u);
  } finally { f.close(); }
});

test("project Experience directory rejects a registered path that is not a directory", async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "project-file");
    writeFileSync(file, "file");
    f.store.create("scope_alias", "file", { status: "active", scope: { kind: "project", id: "project:file" },
      alias_kind: "path", alias: file, alias_digest: stableDigest(file) });
    assert.throws(() => projectExperienceDirectory(f.store, "project:file"), /directory/u);
    f.store.create("scope_alias", "not-a-dir", { status: "active", scope: { kind: "project", id: "project:not-a-dir" },
      alias_kind: "path", alias: f.project, alias_digest: "sha256:invalid" });
    assert.throws(() => projectPathAliasDigest(f.store, "project:not-a-dir"), /not registered/u);
    f.store.create("scope_alias", "missing-experience-dir", { status: "active", scope: { kind: "project", id: "project:missing-dir" },
      alias_kind: "path", alias: join(f.root, "deleted-root"), alias_digest: stableDigest(join(f.root, "deleted-root")) });
    assert.equal(projectExperienceContentDirectory(f.store, "project:missing-dir"), null);
  } finally { f.close(); }
});

test("project Experience content lookup is read-only when Markdown is absent and rejects outside paths", async () => {
  const f = await fixture();
  try {
    f.bind("project", f.project);
    assert.equal(projectExperienceContentDirectory(f.store, "project:test"), null);
    assert.equal(projectExperienceContentDirectory(f.store, "project:test", { reference_path: join(f.root, "outside.md") }), null);
    assert.throws(() => projectExperienceContentDirectory(f.store, "project:test", { project_root: f.clone }), /not registered/u);
  } finally { f.close(); }
});
