import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableDigest } from "../core/digest.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { projectExperienceDirectory, projectPathAliasDigest } from "../core/project-experience-directory.ts";

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
    assert.equal(projectExperienceDirectory(f.store, "project:test", f.project), join(realpathSync(f.project), ".craft_data", "experience"));
    assert.equal(projectExperienceDirectory(f.store, "project:test", f.project, true), join(realpathSync(f.project), ".craft_data", "experience"));
    assert.equal(projectExperienceDirectory(f.store, "project:test", f.project, true), join(realpathSync(f.project), ".craft_data", "experience"));
    assert.equal(projectPathAliasDigest(f.store, "project:test", f.project), stableDigest(f.project));
    assert.throws(() => projectExperienceDirectory(f.store, "invalid", f.project), /scope is invalid/u);
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
    assert.throws(() => projectPathAliasDigest(f.store, "project:test"), /ambiguous/u);
    assert.equal(projectExperienceDirectory(f.store, "project:test", undefined, true, stableDigest(f.clone)), join(realpathSync(f.clone), ".craft_data", "experience"));
    const outside = join(f.root, "outside"); mkdirSync(outside);
    rmSync(join(f.clone, ".craft_data"), { recursive: true, force: true });
    symlinkSync(outside, join(f.clone, ".craft_data"));
    assert.throws(() => projectExperienceDirectory(f.store, "project:test", f.clone, true), /regular directories/u);
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
  } finally { f.close(); }
});
