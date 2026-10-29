import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { craftPaths, type CraftPaths } from "../common/craft-common-store-local/src/paths.ts";
import type { LegacySessionMemoryEntry } from "../core/legacy-session-memory-preflight.ts";
import { quarantineLegacySessionMemory } from "../core/legacy-session-memory-quarantine.ts";

function entry(name: string, status: string): LegacySessionMemoryEntry {
  return { source_digest: `sha256:${createHash("sha256").update(name).digest("hex")}`, status: status as LegacySessionMemoryEntry["status"],
    session_digest: null, host: null, target_directory: null, target_exists: false, file_count: 0, bytes: 0 };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-legacy-session-quarantine-"));
  const paths = craftPaths(join(root, "data")); mkdirSync(paths.root);
  const legacy = join(root, "legacy"); mkdirSync(legacy);
  return { root, paths, legacy };
}

function target(paths: CraftPaths, name: string): string {
  const digest = createHash("sha256").update(name).digest("hex");
  return join(paths.root, "quarantine", "legacy-session-memory", "v1", digest);
}

function staging(paths: CraftPaths, name: string, hostDigest: string, pid: string): string {
  const digest = createHash("sha256").update(name).digest("hex");
  return join(paths.root, "quarantine", "legacy-session-memory", "v1",
    `.${digest}.${hostDigest}.${pid}.00000000-0000-4000-8000-000000000000.tmp`);
}

function patchRename(t: TestContext, after: () => void): () => void {
  const original = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => {
    const result = original(from, to); after(); return result;
  });
  syncBuiltinESMExports();
  return () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
}

function patchCopy(t: TestContext, after: (from: string, to: string) => void): () => void {
  const original = fs.copyFileSync;
  t.mock.method(fs, "copyFileSync", (from: Parameters<typeof fs.copyFileSync>[0], to: Parameters<typeof fs.copyFileSync>[1], mode?: number) => {
    const result = original(from, to, mode); after(String(from), String(to)); return result;
  });
  syncBuiltinESMExports();
  return () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
}

test("retained quarantine preserves the source until old writers have stopped", () => {
  const f = fixture();
  try {
    const source = join(f.legacy, "retained"); mkdirSync(source);
    writeFileSync(join(source, "memory.md"), "fixture");
    const entries = [entry("retained", "unidentified_session")];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = quarantineLegacySessionMemory(f.paths, f.legacy, entries, { retain_source: true });
      assert.equal(result.quarantined, 1);
      assert.equal(result.blocked.length, 0);
      assert.equal(readFileSync(join(source, "memory.md"), "utf8"), "fixture");
      const parent = dirname(target(f.paths, "retained"));
      const snapshots = readdirSync(parent).filter(name => name.startsWith(`${target(f.paths, "retained").split("/").at(-1)}-`));
      assert.equal(snapshots.length, 1);
      assert.equal(readFileSync(join(parent, snapshots[0]!, "payload", "memory.md"), "utf8"), "fixture");
    }
    writeFileSync(join(source, "memory.md"), "updated fixture");
    const updated = quarantineLegacySessionMemory(f.paths, f.legacy, entries, { retain_source: true });
    assert.equal(updated.quarantined, 1);
    assert.equal(updated.blocked.length, 0);
    const parent = dirname(target(f.paths, "retained"));
    const contents = readdirSync(parent).map(name => readFileSync(join(parent, name, "payload", "memory.md"), "utf8")).sort();
    assert.deepEqual(contents, ["fixture", "updated fixture"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine does not publish when the source changes between snapshots", t => {
  const f = fixture();
  const source = join(f.legacy, "changing"), file = join(source, "memory.md");
  mkdirSync(source); writeFileSync(file, "first");
  const original = fs.readdirSync;
  let sourceReads = 0;
  t.mock.method(fs, "readdirSync", ((path: Parameters<typeof fs.readdirSync>[0], options?: unknown) => {
    if (String(path) === source && ++sourceReads === 2) writeFileSync(file, "second");
    return original(path, options as never);
  }) as typeof fs.readdirSync);
  syncBuiltinESMExports();
  try {
    const result = quarantineLegacySessionMemory(f.paths, f.legacy, [entry("changing", "unidentified_session")], { retain_source: true });
    assert.equal(result.blocked[0]?.reason, "quarantine_source_changed");
    assert.equal(readFileSync(file, "utf8"), "second");
    assert.deepEqual(readdirSync(dirname(target(f.paths, "changing"))), []);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.root, { recursive: true, force: true }); }
});

test("uncertain session Memory is copied, verified, retired, and safely resumed", () => {
  const f = fixture();
  try {
    const unbound = join(f.legacy, "unbound-session-name"); mkdirSync(unbound);
    mkdirSync(join(unbound, "md"));
    writeFileSync(join(unbound, "md", "memory.v1.md"), "private session memory\n");
    const unidentified = join(f.legacy, "unidentified-name"); mkdirSync(unidentified);
    writeFileSync(join(unidentified, "memory.db"), "opaque database bytes");
    const brokenName = "broken-link-name", broken = join(f.legacy, brokenName);
    symlinkSync(join(f.root, "missing-target"), broken);
    const entries = [entry("unbound-session-name", "unbound_host"), entry("unidentified-name", "unidentified_session"), entry(brokenName, "broken_symlink")];

    const result = quarantineLegacySessionMemory(f.paths, f.legacy, entries);
    assert.equal(result.quarantined, 2);
    assert.equal(result.broken_links, 1);
    assert.equal(result.blocked.length, 0);
    assert.equal(existsSync(unbound), false);
    assert.equal(existsSync(unidentified), false);
    assert.throws(() => lstatSync(broken), /ENOENT/u);
    assert.equal(readFileSync(join(target(f.paths, "unbound-session-name"), "payload", "md", "memory.v1.md"), "utf8"), "private session memory\n");
    const manifest = JSON.parse(readFileSync(join(target(f.paths, brokenName), "manifest.json"), "utf8"));
    assert.equal(manifest.status, "broken_symlink");
    assert.equal(manifest.source_name, brokenName);
    assert.equal(manifest.link_target, join(f.root, "missing-target"));

    mkdirSync(unbound); mkdirSync(join(unbound, "md"));
    writeFileSync(join(unbound, "md", "memory.v1.md"), "private session memory\n");
    symlinkSync(join(f.root, "missing-target"), broken);
    const resumed = quarantineLegacySessionMemory(f.paths, f.legacy, [entries[0]!, entries[2]!]);
    assert.equal(resumed.quarantined, 1);
    assert.equal(resumed.broken_links, 1);
    assert.equal(resumed.blocked.length, 0);
    assert.equal(existsSync(unbound), false);
    assert.throws(() => lstatSync(broken), /ENOENT/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine recovers dead-process staging without deleting live or foreign staging", () => {
  const f = fixture();
  try {
    const root = join(f.paths.root, "quarantine", "legacy-session-memory", "v1"); mkdirSync(root, { recursive: true });
    const hostDigest = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
    const recoveredName = "recover-dead-staging", activeName = "preserve-active-staging";
    const recoveredSource = join(f.legacy, recoveredName); mkdirSync(recoveredSource); writeFileSync(join(recoveredSource, "x"), "payload");
    const activeSource = join(f.legacy, activeName); mkdirSync(activeSource); writeFileSync(join(activeSource, "x"), "payload");
    const orphan = staging(f.paths, recoveredName, hostDigest, "99999999"); mkdirSync(orphan); writeFileSync(join(orphan, "partial"), "safe to remove");
    const active = staging(f.paths, activeName, hostDigest, String(process.pid)); mkdirSync(active); writeFileSync(join(active, "partial"), "keep until publisher ends");
    const foreign = staging(f.paths, recoveredName, "000000000000", "99999999"); mkdirSync(foreign);
    const unrelated = join(root, ".unrelated.tmp"); mkdirSync(unrelated);

    const result = quarantineLegacySessionMemory(f.paths, f.legacy,
      [entry(recoveredName, "unbound_host"), entry(activeName, "unbound_host")]);

    assert.equal(result.quarantined, 2);
    assert.equal(result.staging_recovered, 1);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(active), true);
    assert.equal(existsSync(foreign), true);
    assert.equal(existsSync(unrelated), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine refuses symlinked and non-directory orphan staging", () => {
  const f = fixture();
  try {
    const root = join(f.paths.root, "quarantine", "legacy-session-memory", "v1"); mkdirSync(root, { recursive: true });
    const hostDigest = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
    const linkedName = "linked-orphan-staging", fileName = "file-orphan-staging";
    const linkedSource = join(f.legacy, linkedName); mkdirSync(linkedSource); writeFileSync(join(linkedSource, "x"), "source remains");
    const fileSource = join(f.legacy, fileName); mkdirSync(fileSource); writeFileSync(join(fileSource, "x"), "source remains");
    const external = join(f.root, "external-staging-target"); mkdirSync(external);
    symlinkSync(external, staging(f.paths, linkedName, hostDigest, "99999999"));
    writeFileSync(staging(f.paths, fileName, hostDigest, "99999999"), "not a directory");

    const result = quarantineLegacySessionMemory(f.paths, f.legacy,
      [entry(linkedName, "unbound_host"), entry(fileName, "unbound_host")]);

    assert.equal(result.quarantined, 0);
    assert.deepEqual(result.blocked.map(item => item.reason), ["quarantine_staging_unsafe", "quarantine_staging_unsafe"]);
    assert.equal(existsSync(linkedSource), true);
    assert.equal(existsSync(fileSource), true);
    assert.equal(existsSync(external), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine refuses changed, linked, colliding, and unidentified sources", () => {
  const f = fixture();
  try {
    const nested = join(f.legacy, "nested-link"); mkdirSync(nested);
    const external = join(f.root, "external"); writeFileSync(external, "must not follow");
    symlinkSync(external, join(nested, "link"));
    const regularFile = join(f.legacy, "regular-file"); writeFileSync(regularFile, "not a directory");
    const entries = [entry("missing-name", "unbound_host"), entry("nested-link", "unbound_host"),
      entry("regular-file", "unbound_host"), { ...entry("invalid-digest", "unbound_host"), source_digest: "invalid" },
      entry("regular-file", "other_status")];
    const result = quarantineLegacySessionMemory(f.paths, f.legacy, entries);
    assert.equal(result.quarantined, 0);
    assert.equal(result.broken_links, 0);
    assert.deepEqual(result.blocked.map(item => item.reason).sort(), ["source_identity_invalid", "source_identity_missing", "source_tree_unsafe", "source_type_not_quarantinable"]);
    assert.equal(existsSync(external), true);
    assert.equal(existsSync(nested), true);
    assert.equal(existsSync(regularFile), true);

    const conflicted = join(f.legacy, "conflict"); mkdirSync(conflicted); writeFileSync(join(conflicted, "x"), "source");
    const conflictEntry = entry("conflict", "unidentified_session");
    const targetDir = target(f.paths, "conflict"); mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "manifest.json"), "{\n");
    const conflict = quarantineLegacySessionMemory(f.paths, f.legacy, [conflictEntry]);
    assert.equal(conflict.blocked[0]?.reason, "quarantine_target_conflict");
    assert.equal(existsSync(conflicted), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine checks configured file and byte limits and rejects invalid limits", () => {
  const f = fixture();
  try {
    const tooMany = join(f.legacy, "too-many"); mkdirSync(tooMany);
    writeFileSync(join(tooMany, "a"), "a"); writeFileSync(join(tooMany, "b"), "b");
    const countLimited = quarantineLegacySessionMemory(f.paths, f.legacy, [entry("too-many", "unbound_host")], { max_files: 1 });
    assert.equal(countLimited.blocked[0]?.reason, "source_tree_over_limit");
    assert.equal(existsSync(tooMany), true);

    const tooLarge = join(f.legacy, "too-large"); mkdirSync(tooLarge); writeFileSync(join(tooLarge, "body"), "12345");
    const bytesLimited = quarantineLegacySessionMemory(f.paths, f.legacy, [entry("too-large", "unbound_host")], { max_bytes: 4 });
    assert.equal(bytesLimited.blocked[0]?.reason, "source_tree_over_limit");
    assert.equal(existsSync(tooLarge), true);

    assert.throws(() => quarantineLegacySessionMemory(f.paths, f.legacy, [], { max_files: 0 }), /limits/u);
    assert.throws(() => quarantineLegacySessionMemory(f.paths, f.legacy, [], { max_bytes: 512 * 1024 * 1024 + 1 }), /limits/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine fails closed on unsafe roots and records nonstandard filesystem errors", () => {
  const f = fixture();
  try {
    const linkRoot = join(f.root, "legacy-link"); symlinkSync(f.legacy, linkRoot);
    assert.throws(() => quarantineLegacySessionMemory(f.paths, linkRoot, []), /legacy_memory_root_unsafe/u);
    const fileRoot = join(f.root, "legacy-file"); writeFileSync(fileRoot, "x");
    assert.throws(() => quarantineLegacySessionMemory(f.paths, fileRoot, []), /legacy_memory_root_unsafe/u);

    const name = "source"; mkdirSync(join(f.legacy, name)); writeFileSync(join(f.legacy, name, "x"), "x");
    const missingDataRoot = { ...f.paths, root: join(f.root, "missing-data-root") } as CraftPaths;
    const result = quarantineLegacySessionMemory(missingDataRoot, f.legacy, [entry(name, "unbound_host")]);
    assert.equal(result.blocked[0]?.reason, "filesystem_error");
    assert.equal(existsSync(join(f.legacy, name)), true);

    const badProjectRoot = join(f.root, "project-root-file"); writeFileSync(badProjectRoot, "x");
    const projectRootPaths = { ...f.paths, root: badProjectRoot } as CraftPaths;
    const unsafe = quarantineLegacySessionMemory(projectRootPaths, f.legacy, [entry(name, "unbound_host")]);
    assert.equal(unsafe.blocked[0]?.reason, "craft_data_root_unsafe");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine refuses symlinked or non-directory quarantine roots and preserves sources", (t) => {
  const f = fixture();
  try {
    const source = join(f.legacy, "source"); mkdirSync(source); writeFileSync(join(source, "x"), "x");
    const quarantineRoot = join(f.paths.root, "quarantine");
    const external = join(f.root, "external"); mkdirSync(external); symlinkSync(external, quarantineRoot);
    const linked = quarantineLegacySessionMemory(f.paths, f.legacy, [entry("source", "unbound_host")]);
    assert.equal(linked.blocked[0]?.reason, "quarantine_directory_unsafe");
    assert.equal(existsSync(source), true);
    unlinkSync(quarantineRoot);
    writeFileSync(quarantineRoot, "not a directory");
    const regular = quarantineLegacySessionMemory(f.paths, f.legacy, [entry("source", "unbound_host")]);
    assert.equal(regular.blocked[0]?.reason, "quarantine_directory_unsafe");
    assert.equal(existsSync(source), true);

    const deniedRoot = join(f.paths.root, "denied-root"), deniedSource = join(f.legacy, "denied-source");
    mkdirSync(deniedRoot); mkdirSync(deniedSource); writeFileSync(join(deniedSource, "x"), "x");
    const original = fs.lstatSync;
    t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]) === join(deniedRoot, "quarantine")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return original(...args);
    });
    syncBuiltinESMExports();
    const denied = quarantineLegacySessionMemory({ ...f.paths, root: deniedRoot } as CraftPaths, f.legacy,
      [entry("denied-source", "unbound_host")]);
    assert.equal(denied.blocked[0]?.reason, "denied");
    assert.equal(existsSync(deniedSource), true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine rejects unknown filesystem node types without retiring their source", (t) => {
  const f = fixture();
  try {
    const source = join(f.legacy, "unknown-node"); mkdirSync(source);
    const special = join(source, "special"); writeFileSync(special, "placeholder");
    const original = fs.lstatSync;
    t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      const actual = original(...args);
      if (String(args[0]) !== special) return actual;
      const unknown = Object.create(actual!) as fs.Stats;
      unknown.isSymbolicLink = () => false; unknown.isDirectory = () => false; unknown.isFile = () => false;
      return unknown;
    });
    syncBuiltinESMExports();
    const result = quarantineLegacySessionMemory(f.paths, f.legacy, [entry("unknown-node", "unbound_host")]);
    assert.equal(result.blocked[0]?.reason, "source_tree_unsafe");
    assert.equal(existsSync(special), true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine detects target collisions and manifests that do not match the source", () => {
  const f = fixture();
  try {
    const source = join(f.legacy, "collision"); mkdirSync(source); writeFileSync(join(source, "x"), "x");
    const parent = join(f.paths.root, "quarantine", "legacy-session-memory", "v1"); mkdirSync(parent, { recursive: true });
    const targetPath = target(f.paths, "collision"), external = join(f.root, "external-target"); mkdirSync(external);
    symlinkSync(external, targetPath);
    const linked = quarantineLegacySessionMemory(f.paths, f.legacy, [entry("collision", "unbound_host")]);
    assert.equal(linked.blocked[0]?.reason, "quarantine_target_conflict");
    unlinkSync(targetPath);
    writeFileSync(targetPath, "not a directory");
    const regular = quarantineLegacySessionMemory(f.paths, f.legacy, [entry("collision", "unbound_host")]);
    assert.equal(regular.blocked[0]?.reason, "quarantine_target_conflict");
    rmSync(targetPath);
    mkdirSync(targetPath);
    writeFileSync(join(targetPath, "manifest.json"), JSON.stringify({ schema: "other-valid-json" }));
    const mismatchedManifest = quarantineLegacySessionMemory(f.paths, f.legacy, [entry("collision", "unbound_host")]);
    assert.equal(mismatchedManifest.blocked[0]?.reason, "quarantine_target_conflict");
    assert.equal(existsSync(source), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine detects live links and source mutation during publication", (t) => {
  const f = fixture();
  try {
    const liveName = "live-link"; const liveTarget = join(f.root, "live-target"); writeFileSync(liveTarget, "x");
    symlinkSync(liveTarget, join(f.legacy, liveName));
    const live = quarantineLegacySessionMemory(f.paths, f.legacy, [entry(liveName, "broken_symlink")]);
    assert.equal(live.blocked[0]?.reason, "source_link_is_live");
    assert.equal(existsSync(join(f.legacy, liveName)), true);

    const fileName = "directory-becomes-file", source = join(f.legacy, fileName); mkdirSync(source); writeFileSync(join(source, "x"), "before");
    const restore = patchRename(t, () => { rmSync(source, { recursive: true }); writeFileSync(source, "changed type"); });
    try {
      const changed = quarantineLegacySessionMemory(f.paths, f.legacy, [entry(fileName, "unbound_host")]);
      assert.equal(changed.blocked[0]?.reason, "source_changed_before_retire");
      assert.equal(readFileSync(source, "utf8"), "changed type");
    } finally { restore(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine detects changed source digest and changed or revived links", (t) => {
  const f = fixture();
  try {
    const directoryName = "changed-content", directory = join(f.legacy, directoryName); mkdirSync(directory); writeFileSync(join(directory, "x"), "before");
    const restoreDirectory = patchRename(t, () => writeFileSync(join(directory, "x"), "after"));
    try {
      const changed = quarantineLegacySessionMemory(f.paths, f.legacy, [entry(directoryName, "unbound_host")]);
      assert.equal(changed.blocked[0]?.reason, "source_changed_before_retire");
    } finally { restoreDirectory(); }

    const changedLinkName = "changed-link", changedLink = join(f.legacy, changedLinkName), firstTarget = join(f.root, "first-missing");
    symlinkSync(firstTarget, changedLink);
    const restoreChanged = patchRename(t, () => { unlinkSync(changedLink); symlinkSync(join(f.root, "second-missing"), changedLink); });
    try {
      const changed = quarantineLegacySessionMemory(f.paths, f.legacy, [entry(changedLinkName, "broken_symlink")]);
      assert.equal(changed.blocked[0]?.reason, "source_link_changed", JSON.stringify(changed));
    } finally { restoreChanged(); }

    const revivedName = "revived-link", revivedLink = join(f.legacy, revivedName), revivedTarget = join(f.root, "revived-target");
    symlinkSync(revivedTarget, revivedLink);
    const restoreRevived = patchRename(t, () => writeFileSync(revivedTarget, "now exists"));
    try {
      const revived = quarantineLegacySessionMemory(f.paths, f.legacy, [entry(revivedName, "broken_symlink")]);
      assert.equal(revived.blocked[0]?.reason, "source_link_became_live");
    } finally { restoreRevived(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine cleans staging after publish failures and rejects a tampered published copy", (t) => {
  const f = fixture();
  try {
    const name = "rename-failure", source = join(f.legacy, name); mkdirSync(source); writeFileSync(join(source, "x"), "x");
    const original = fs.renameSync;
    t.mock.method(fs, "renameSync", () => { throw new Error("permission denied"); }); syncBuiltinESMExports();
    let failed: ReturnType<typeof quarantineLegacySessionMemory>;
    try { failed = quarantineLegacySessionMemory(f.paths, f.legacy, [entry(name, "unbound_host")]); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(failed!.blocked[0]?.reason, "filesystem_error");
    assert.equal(existsSync(source), true);
    const staging = readdirSync(join(f.paths.root, "quarantine", "legacy-session-memory", "v1")).filter(item => item.endsWith(".tmp"));
    assert.equal(staging.length, 0);
    assert.equal(fs.renameSync, original);

    const tamperedName = "tampered", tampered = join(f.legacy, tamperedName); mkdirSync(tampered); writeFileSync(join(tampered, "x"), "original");
    const restore = patchRename(t, () => writeFileSync(join(target(f.paths, tamperedName), "payload", "x"), "tampered"));
    try {
      const result = quarantineLegacySessionMemory(f.paths, f.legacy, [entry(tamperedName, "unbound_host")]);
      assert.equal(result.blocked[0]?.reason, "quarantine_verify_failed");
      assert.equal(existsSync(tampered), true);
    } finally { restore(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("quarantine detects copy digest and source or staged-tree mutation before publication", (t) => {
  const f = fixture();
  try {
    const copiedName = "copy-tampered", copiedSource = join(f.legacy, copiedName); mkdirSync(copiedSource); writeFileSync(join(copiedSource, "x"), "a");
    let restore = patchCopy(t, (_from, to) => writeFileSync(to, "b"));
    try {
      const copied = quarantineLegacySessionMemory(f.paths, f.legacy, [entry(copiedName, "unbound_host")]);
      assert.equal(copied.blocked[0]?.reason, "quarantine_copy_digest_mismatch");
      assert.equal(existsSync(copiedSource), true);
    } finally { restore(); }

    const changedName = "source-mutated", changedSource = join(f.legacy, changedName); mkdirSync(changedSource); writeFileSync(join(changedSource, "x"), "before");
    restore = patchCopy(t, (from) => writeFileSync(from, "after"));
    try {
      const changed = quarantineLegacySessionMemory(f.paths, f.legacy, [entry(changedName, "unbound_host")]);
      assert.equal(changed.blocked[0]?.reason, "quarantine_source_changed");
      assert.equal(existsSync(changedSource), true);
    } finally { restore(); }

    const stagedName = "staged-extra", stagedSource = join(f.legacy, stagedName); mkdirSync(stagedSource); writeFileSync(join(stagedSource, "x"), "same");
    restore = patchCopy(t, (_from, to) => writeFileSync(join(dirname(to), "unlisted"), "extra"));
    try {
      const staged = quarantineLegacySessionMemory(f.paths, f.legacy, [entry(stagedName, "unbound_host")]);
      assert.equal(staged.blocked[0]?.reason, "quarantine_source_changed");
      assert.equal(existsSync(stagedSource), true);
    } finally { restore(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
