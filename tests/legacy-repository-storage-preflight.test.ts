import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths, ensureProjectStorageDirectory, projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";
import { legacyRepositoryStoragePreflight, legacyRepositoryStorageSummary } from "../core/legacy-repository-storage-preflight.ts";

function fixture(): string { return mkdtempSync(join(tmpdir(), "craft-legacy-repository-storage-")); }

test("preflight discovers a Git-root-bound source and reports file totals by capability", () => {
  const root = fixture(), repo = join(root, "repo"), source = join(repo, ".craft_data");
  try {
    mkdirSync(source, { recursive: true });
    mkdirSync(join(source, "codebase", "snapshots"), { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(source, "settings.json"), "{}\n");
    writeFileSync(join(source, "codebase", "snapshots", "one.json"), "12345");
    writeFileSync(join(repo, "README.md"), "not part of Craft storage");
    writeFileSync(join(repo, ".git", ".craft_data"), "ignored");
    const init = spawnSync("git", ["-C", repo, "init", "--quiet"], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const scan = legacyRepositoryStoragePreflight([root, repo], craftPaths(join(root, "global")));
    const entries = scan.entries;
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { source_root: realpathSync(source), canonical_project_root: realpathSync(repo),
      project_directory: projectStorageDirectory(craftPaths(join(root, "global")), repo), status: "ready",
      file_count: 2, size_bytes: 8, symlink_count: 0, unsafe_entry_count: 0, scan_error_count: 0,
      capabilities: { codebase: { file_count: 1, size_bytes: 5 } } });
    assert.equal(lstatSync(source).isDirectory(), true);
    assert.deepEqual(legacyRepositoryStorageSummary(scan), { roots: 1, file_count: 2, size_bytes: 8, scan_error_count: 0,
      statuses: { ready: 1, unbound: 0, unsafe: 0, incomplete: 0 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight fails closed for unbound roots and inventories links without following them", () => {
  const root = fixture(), parent = join(root, "parent"), source = join(parent, ".craft_data"), external = join(root, "external");
  try {
    mkdirSync(join(source, "memory"), { recursive: true }); mkdirSync(external);
    writeFileSync(join(source, "memory", "memory.db"), "memory");
    writeFileSync(join(external, "secret"), "do not traverse");
    symlinkSync(external, join(source, "memory", "linked"));
    const scan = legacyRepositoryStoragePreflight([parent], craftPaths(join(root, "global")), { resolve_git_root: () => null });
    const entries = scan.entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, "unbound");
    assert.equal(entries[0]?.canonical_project_root, null);
    assert.equal(entries[0]?.project_directory, null);
    assert.deepEqual(entries[0]?.capabilities, { memory: { file_count: 1, size_bytes: 6 } });
    assert.equal(entries[0]?.symlink_count, 1);
    assert.deepEqual(legacyRepositoryStorageSummary(scan).statuses, { ready: 0, unbound: 1, unsafe: 0, incomplete: 0 });
    assert.equal(legacyRepositoryStoragePreflight([parent], craftPaths(join(root, "global"))).entries[0]?.status, "unbound");
    assert.equal(legacyRepositoryStoragePreflight([parent], craftPaths(join(root, "global")), { resolve_git_root: () => { throw new Error("invalid Git root"); } }).entries[0]?.status, "unbound");
    const linkedRepo = join(root, "linked-repo"), linkedRepoStorage = join(linkedRepo, ".craft_data");
    mkdirSync(join(linkedRepoStorage, "memory"), { recursive: true });
    symlinkSync(external, join(linkedRepoStorage, "memory", "linked"));
    const init = spawnSync("git", ["-C", linkedRepo, "init", "--quiet"], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const discovered = legacyRepositoryStoragePreflight([root], craftPaths(join(root, "global")));
    assert.equal(discovered.entries.find(item => item.source_root === realpathSync(linkedRepoStorage))?.status, "unsafe");
    const linkedSource = join(root, "linked-parent"); mkdirSync(linkedSource);
    symlinkSync(source, join(linkedSource, ".craft_data"));
    const linked = legacyRepositoryStoragePreflight([linkedSource], craftPaths(join(root, "global")));
    assert.equal(linked.entries[0]?.status, "unsafe");
    assert.equal(linked.entries[0]?.symlink_count, 1);
    assert.equal(linked.entries[0]?.file_count, 0);
    assert.deepEqual(legacyRepositoryStorageSummary({ entries: [], scan_errors: [] }), { roots: 0, file_count: 0,
      size_bytes: 0, scan_error_count: 0, statuses: { ready: 0, unbound: 0, unsafe: 0, incomplete: 0 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight accepts an exact previously registered project path without Git and never creates mappings", () => {
  const root = fixture(), project = join(root, "workspace"), source = join(project, ".craft_data"), paths = craftPaths(join(root, "global"));
  try {
    mkdirSync(join(source, "knowledge"), { recursive: true });
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(join(source, "knowledge", "fact.md"), "fact");
    const directory = ensureProjectStorageDirectory(paths, project);
    const scan = legacyRepositoryStoragePreflight([project], paths, { resolve_git_root: () => null });
    assert.deepEqual(scan.entries[0], { source_root: realpathSync(source), canonical_project_root: realpathSync(project),
      project_directory: directory, status: "ready", file_count: 1, size_bytes: 4, symlink_count: 0,
      unsafe_entry_count: 0, scan_error_count: 0, capabilities: { knowledge: { file_count: 1, size_bytes: 4 } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight rejects an existing project mapping that does not match the exact source path", () => {
  const root = fixture(), project = join(root, "workspace"), source = join(project, ".craft_data"), paths = craftPaths(join(root, "global"));
  try {
    mkdirSync(source, { recursive: true });
    mkdirSync(paths.root, { recursive: true });
    const directory = ensureProjectStorageDirectory(paths, project);
    writeFileSync(join(directory, "project.json"), JSON.stringify({ schema_version: 1, canonical_root: join(root, "other"),
      path_sha256: "0".repeat(64), directory_name: "workspace--wrong" }));
    const scan = legacyRepositoryStoragePreflight([project], paths, { resolve_git_root: () => null });
    assert.equal(scan.entries[0]?.status, "unbound");
    assert.equal(scan.entries[0]?.canonical_project_root, null);
    assert.equal(scan.entries[0]?.project_directory, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight reports unsafe filesystem entries and rejects unsafe scan roots", () => {
  const root = fixture(), parent = join(root, "parent"), source = join(parent, ".craft_data"), badTarget = join(root, "missing-project");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "file"), "x");
    const fifo = join(source, "unsupported");
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const entries = legacyRepositoryStoragePreflight([parent], craftPaths(join(root, "global")), { resolve_git_root: () => badTarget });
    assert.equal(entries.entries[0]?.status, "unbound");
    assert.equal(entries.entries[0]?.file_count, 1);
    assert.equal(entries.entries[0]?.unsafe_entry_count, 1);
    assert.throws(() => legacyRepositoryStoragePreflight([join(root, "absent")], craftPaths(join(root, "global"))), /ENOENT|regular directory/u);
    const linkedRoot = join(root, "linked-root"); symlinkSync(parent, linkedRoot);
    assert.throws(() => legacyRepositoryStoragePreflight([linkedRoot], craftPaths(join(root, "global"))), /regular directory/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight marks unreadable data partial and preserves per-path scan errors", () => {
  const root = fixture(), repo = join(root, "repo"), source = join(repo, ".craft_data");
    const denied = join(source, "restricted"), unreadable = join(repo, "unreadable");
  try {
    mkdirSync(denied, { recursive: true }); mkdirSync(unreadable);
    writeFileSync(join(denied, "record.json"), "secret");
    const init = spawnSync("git", ["-C", repo, "init", "--quiet"], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const scan = legacyRepositoryStoragePreflight([repo], craftPaths(join(root, "global")), {
      read_directory: directory => {
        if (directory === realpathSync(denied)) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        if (directory === realpathSync(unreadable)) throw new Error("unknown filesystem failure");
        const names = readdirSync(directory);
        if (directory === realpathSync(source)) return [...names, "vanished-in-data"];
        return directory === realpathSync(repo) ? [...names, "vanished-during-scan"] : names;
      },
    });
    assert.equal(scan.entries[0]?.status, "incomplete");
    assert.equal(scan.entries[0]?.scan_error_count, 2);
    assert.equal(scan.scan_errors.length, 4);
    assert.deepEqual(scan.scan_errors.map(item => item.error_code).sort(), ["EACCES", "ENOENT", "ENOENT", "unknown"]);
    assert.deepEqual(legacyRepositoryStorageSummary(scan), { roots: 1, file_count: 0, size_bytes: 0,
      scan_error_count: 4, statuses: { ready: 0, unbound: 0, unsafe: 0, incomplete: 1 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
