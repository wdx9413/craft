import assert from "node:assert/strict";
import { mkdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Catalog, parseSkill, pathKey } from "../src/catalog.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftStore } from "../src/store.ts";

test("catalog adds, incrementally scans, searches, updates, and removes sources", async () => {
  const root = join(tmpdir(), `craft-catalog-${process.pid}-${Date.now()}`);
  const library = join(root, "library");
  await mkdir(join(library, "diagnose"), { recursive: true });
  const file = join(library, "diagnose", "SKILL.md");
  await writeFile(file, "---\nname: diagnose\ndescription: Find failures\naliases: incident trace\nversion: 1\n---\nTrace evidence.");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const catalog = new Catalog(store);
  try {
    const source = await catalog.addSource(library);
    assert.equal((source.scan as { added: number }).added, 1);
    assert.equal(catalog.search("failures")[0].name, "diagnose");
    assert.equal(catalog.search("incident trace")[0].name, "diagnose");
    assert.equal(catalog.search("   ").length, 0);
    assert.equal(catalog.get(String(catalog.search("evidence")[0].id)).version, 1);
    assert.equal(((await catalog.scanSource(String(source.id))).scan as { unchanged: number }).unchanged, 1);
    await writeFile(file, "---\nname: diagnose\ndescription: Find production failures\n---\nTrace logs.");
    assert.equal(((await catalog.scan()).sources as unknown[]).length, 1);
    assert.equal(catalog.search("production", 99)[0].name, "diagnose");
    const disabled = catalog.updateSource(String(source.id), false, "Disabled");
    assert.equal(disabled.enabled, false);
    await assert.rejects(() => catalog.scanSource(String(source.id)), /disabled/);
    assert.equal((await catalog.addSource(join(root, "empty"), "Empty", false).catch(async (error) => {
      await mkdir(join(root, "empty")); return catalog.addSource(join(root, "empty"), "Empty", false);
    })).label, "Empty");
    await assert.rejects(() => catalog.addSource(library), /already exists/);
    catalog.updateSource(String(source.id), true);
    await unlink(file);
    assert.equal(((await catalog.scanSource(String(source.id))).scan as { removed: number }).removed, 1);
    await writeFile(file, "body");
    await catalog.scanSource(String(source.id));
    assert.equal(catalog.removeSource(String(source.id)).removed, true);
    assert.throws(() => catalog.removeSource(String(source.id)), /Unknown source/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("skill parser supports defaults, frontmatter, and non-object YAML", () => {
  assert.equal(pathKey("A/B", "win32"), "a/b");
  assert.equal(pathKey("A/B", "linux"), "A/B");
  assert.equal(parseSkill("body", "fallback").name, "fallback");
  assert.equal(parseSkill("---\n- one\n---\nbody", "fallback").body, "body");
  assert.equal(parseSkill("---\nname: x", "fallback").body, "---\nname: x");
  assert.equal(parseSkill("---\r\nname: windows\r\n---\r\nbody", "fallback").name, "windows");
  assert.equal(parseSkill("---\nnull\n---\nbody", "fallback").version, "unversioned");
  assert.equal(parseSkill("---\nname: x\ndescription: details\nversion: 2\n---\nbody", "fallback").description, "details");
  assert.equal(parseSkill("---\nname: 'quoted'\n---\nbody", "fallback").name, "quoted");
});

test("catalog covers aliases, disabled sources, filters, and digest fallback", async () => {
  const root = join(tmpdir(), `craft-catalog-edge-${process.pid}-${Date.now()}`);
  const library = join(root, "library");
  const other = join(root, "other");
  await mkdir(join(library, "a"), { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(join(library, "ignore.txt"), "ignored");
  await writeFile(join(library, "a", "SKILL.md"), "---\nname: alpha\ndescription: red blue\naliases:\n  - urgent outage\n  - 42\n---\nbody");
  await writeFile(join(other, "SKILL.md"), "---\nname: beta\ndescription: red\n---\nbody");
  await symlink(join(library, "a"), join(library, "alias"), "junction");
  await symlink(join(root, "missing"), join(library, "broken"), "junction");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const catalog = new Catalog(store);
  try {
    await assert.rejects(() => catalog.addSource(join(library, "ignore.txt")), /must be a directory/);
    const first = await catalog.addSource(library, undefined, false);
    const second = await catalog.addSource(other, "Other", true);
    assert.equal(catalog.listSources().length, 2);
    catalog.updateSource(String(first.id));
    const firstScan = (await catalog.scan(String(first.id))).scan as { added: number; issues: unknown[] };
    assert.equal(firstScan.added, 1);
    assert.equal(firstScan.issues.length, 1);
    const path = join(library, "a", "SKILL.md");
    const before = store.get("capability", String(catalog.search("alpha")[0].id));
    await utimes(path, new Date(), new Date(Number(before.mtime_ms) + 10_000));
    assert.equal(((await catalog.scanSource(String(first.id))).scan as { unchanged: number }).unchanged, 1);
    catalog.updateSource(String(second.id), false);
    assert.equal(((await catalog.scan()).sources as unknown[]).length, 1);
    const ranked = catalog.search("red blue", 0);
    assert.equal(ranked.length, 1);
    const aliasRanked = catalog.search("urgent outage");
    assert.equal(aliasRanked[0].name, "alpha");
    assert.equal((aliasRanked[0].match as Record<string, unknown>).alias_match, true);
    assert.equal(catalog.search("red", 50).length, 2);
    catalog.removeSource(String(first.id));
    catalog.removeSource(String(second.id));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
