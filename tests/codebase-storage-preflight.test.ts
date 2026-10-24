import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { craftPaths, ensureProjectStorageDirectory, projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";
import { CraftStore } from "../common/craft-common-store-local/src/store.ts";
import { WorkspaceState } from "../core/workspace.ts";
import { codebaseStoragePreflight } from "../core/codebase-storage-preflight.ts";
import { migrateCodebaseSnapshots } from "../core/codebase-storage-migration.ts";

test("Codebase preflight pages current, old project and missing Workspace revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-preflight-"));
  const paths = craftPaths(join(root, "data")), project = join(root, "project");
  mkdirSync(project); writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
  const store = await new CraftStore(paths).open();
  try {
    const workspace = new WorkspaceState(store, paths);
    workspace.open({ workspace_id: "repo", name: "repo", root_path: project, include_paths: ["a.ts"] });
    workspace.checkpoint({ workspace_id: "repo", checkpoint_id: "old", label: "old" });
    workspace.checkpoint({ workspace_id: "repo", checkpoint_id: "current", label: "current" });
    workspace.checkpoint({ workspace_id: "repo", checkpoint_id: "steady", label: "steady" });
    const old = join(project, ".craft_data", "codebase", "snapshots", "repo", "old");
    mkdirSync(dirname(old), { recursive: true });
    renameSync(join(projectStorageDirectory(paths, project), "codebase", "snapshots", "repo", "old"), old);
    const row = store.database.prepare("SELECT payload_json FROM records WHERE kind='workspace_checkpoint' AND id='old'").get() as { payload_json: string };
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint' AND id='old'")
      .run(JSON.stringify({ ...JSON.parse(row.payload_json), snapshot_root: old }));
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint' AND id='current'")
      .run(JSON.stringify({ ...JSON.parse((store.database.prepare("SELECT payload_json FROM records WHERE kind='workspace_checkpoint' AND id='current'")
        .get() as { payload_json: string }).payload_json), state_revision: 99 }));
    const seen = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const page = codebaseStoragePreflight(paths, { max_records: 1, ...(cursor ? { cursor } : {}) });
      for (const entry of page.entries) seen.set(entry.id, entry.status);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.equal(seen.get("old"), "legacy_ready");
    assert.equal(seen.get("current"), "missing_workspace");
    assert.equal(seen.get("steady"), "current");
    assert.throws(() => codebaseStoragePreflight(paths, { max_records: 0 }), /max_records/u);
    assert.throws(() => codebaseStoragePreflight(paths, { cursor: "bad!" }), /cursor is invalid/u);
    assert.throws(() => codebaseStoragePreflight(paths, { cursor: Buffer.from("[]").toString("base64url") }), /cursor is invalid/u);
    const ready = codebaseStoragePreflight(paths, { max_records: 10 }).entries.filter(item => item.status === "legacy_ready");
    const migrated = await migrateCodebaseSnapshots(store, ready);
    assert.equal(migrated.migrated, 1);
    assert.deepEqual(migrated.blocked, []);
    assert.equal(existsSync(join(String(migrated.backup_directory), "manifest.json")), true);
    const updated = codebaseStoragePreflight(paths, { max_records: 10 }).entries.find(item => item.id === "old")!;
    assert.equal(updated.status, "current");
    assert.equal(readFileSync(join(String(updated.target_root), "a.ts"), "utf8"), "export const a = 1;\n");
    workspace.checkpoint({ workspace_id: "repo", checkpoint_id: "bad", label: "bad" });
    const globalLegacy = join(paths.runtimeDir, "workspaces", "repo", "snapshots", "bad");
    mkdirSync(dirname(globalLegacy), { recursive: true });
    renameSync(join(projectStorageDirectory(paths, project), "codebase", "snapshots", "repo", "bad"), globalLegacy);
    const badRow = store.database.prepare("SELECT payload_json FROM records WHERE kind='workspace_checkpoint' AND id='bad'").get() as { payload_json: string };
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint' AND id='bad'")
      .run(JSON.stringify({ ...JSON.parse(badRow.payload_json), snapshot_root: globalLegacy }));
    writeFileSync(join(globalLegacy, "a.ts"), "export const a = 2;\n");
    const bad = codebaseStoragePreflight(paths, { max_records: 10 }).entries.find(item => item.id === "bad")!;
    assert.equal(bad.status, "legacy_ready");
    const rejected = await migrateCodebaseSnapshots(store, [bad]);
    assert.equal(rejected.migrated, 0);
    assert.deepEqual(rejected.blocked.map(item => item.reason), ["source_digest_changed"]);
    assert.equal(codebaseStoragePreflight(paths, { max_records: 10 }).entries.find(item => item.id === "bad")?.status, "legacy_ready");
    writeFileSync(join(globalLegacy, "extra.txt"), "unlisted");
    const extra = await migrateCodebaseSnapshots(store, [bad]);
    assert.deepEqual(extra.blocked.map(item => item.reason), ["snapshot_manifest_mismatch"]);
    rmSync(join(globalLegacy, "extra.txt"));
    const resumed = await migrateCodebaseSnapshots(store, [bad], { backup_directory: String(rejected.backup_directory), recover_verified_peer: true });
    assert.equal(resumed.migrated, 1);
    assert.deepEqual(resumed.recovered.map(item => ({ path: item.path, digest: item.digest })),
      [{ path: "a.ts", digest: JSON.parse(badRow.payload_json).entries[0].digest }]);
    assert.equal(resumed.backup_directory, rejected.backup_directory);
    assert.equal(existsSync(join(String(resumed.backup_directory), "recovery-bad-v1.json")), true);
    assert.equal(codebaseStoragePreflight(paths, { max_records: 10 }).entries.find(item => item.id === "bad")?.status, "current");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Codebase preflight fails closed for missing, ambiguous and unsafe historical bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-preflight-blocked-"));
  const paths = craftPaths(join(root, "data")), a = join(root, "a"), b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  const store = await new CraftStore(paths).open();
  try {
    const now = new Date().toISOString();
    const put = (kind: string, id: string, version: number, payload: unknown) => store.database.prepare(
      "INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(kind, id, version, JSON.stringify(payload), now, now);
    put("workspace", "present", 1, { state_revision: 1, root_path: a });
    put("workspace", "ambiguous", 1, { state_revision: 1, root_path: a });
    put("workspace", "ambiguous", 2, { state_revision: 1, root_path: b });
    put("workspace", "removed", 1, { state_revision: 1, root_path: join(root, "gone") });
    const checkpoint = (id: string, workspace_id: string, snapshot_root: string, state_revision = 1) =>
      put("workspace_checkpoint", id, 1, { workspace_id, snapshot_root, state_revision, entries: [] });
    checkpoint("no-workspace", "unknown", join(root, "x"));
    checkpoint("no-root", "removed", join(root, "x"));
    checkpoint("ambiguous", "ambiguous", join(root, "x"));
    checkpoint("outside", "present", join(root, "outside"));
    checkpoint("missing-snapshot", "present", join(a, ".craft_data", "codebase", "snapshots", "present", "missing-snapshot"));
    put("workspace_checkpoint", "invalid", 1, { workspace_id: "present", snapshot_root: "", entries: "bad" });
    const current = join(ensureProjectStorageDirectory(paths, a), "codebase", "snapshots", "present", "current");
    mkdirSync(current, { recursive: true });
    checkpoint("current", "present", current);
    const statuses = Object.fromEntries(codebaseStoragePreflight(paths, { max_records: 20 }).entries.map(item => [item.id, item.status]));
    assert.deepEqual(statuses, { ambiguous: "ambiguous_root", current: "current", invalid: "invalid_checkpoint",
      "missing-snapshot": "missing_snapshot", "no-root": "missing_root", "no-workspace": "missing_workspace", outside: "source_out_of_scope" });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Codebase preflight rejects malformed records, non-directory roots and linked snapshot directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-preflight-malformed-"));
  const paths = craftPaths(join(root, "data")), project = join(root, "project"); mkdirSync(project);
  const store = await new CraftStore(paths).open();
  try {
    const raw = (kind: string, id: string, payload: string) => store.database.prepare(
      "INSERT INTO records(kind,id,version,payload_json,created_at,updated_at) VALUES(?,?,1,?,'now','now')",
    ).run(kind, id, payload);
    raw("workspace", "invalid-json", "{"); raw("workspace", "invalid-shape", "{}");
    const fileRoot = join(root, "file"); writeFileSync(fileRoot, "not a directory");
    raw("workspace", "file-root", JSON.stringify({ state_revision: 1, root_path: fileRoot }));
    raw("workspace", "repo", JSON.stringify({ state_revision: 1, root_path: project }));
    raw("workspace_checkpoint", "invalid-json", "{"); raw("workspace_checkpoint", "invalid-shape", "{}");
    const payload = { workspace_id: "repo", state_revision: 1, entries: [], snapshot_root: "bad\u0000path" };
    raw("workspace_checkpoint", "bad-path", JSON.stringify(payload));
    raw("workspace_checkpoint", "../escape", JSON.stringify(payload));
    raw("workspace_checkpoint", "file-root", JSON.stringify({ ...payload, workspace_id: "file-root" }));
    const snapshot = join(projectStorageDirectory(paths, project), "codebase", "snapshots", "repo", "linked");
    mkdirSync(dirname(snapshot), { recursive: true }); symlinkSync(project, snapshot);
    raw("workspace_checkpoint", "linked", JSON.stringify({ ...payload, snapshot_root: snapshot }));
    const statuses = Object.fromEntries(codebaseStoragePreflight(paths, { max_records: 20 }).entries.map(item => [item.id, item.status]));
    assert.deepEqual(statuses, { "../escape": "invalid_checkpoint", "bad-path": "source_out_of_scope", "file-root": "missing_root",
      "invalid-json": "invalid_checkpoint", "invalid-shape": "invalid_checkpoint", linked: "missing_snapshot" });
    assert.throws(() => codebaseStoragePreflight(paths, { cursor: Buffer.from("{").toString("base64url") }), /cursor is invalid/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Codebase migration recovers a corrupt snapshot only from a digest-matching local Git object", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-git-recovery-"));
  const paths = craftPaths(join(root, "data")), project = join(root, "project");
  mkdirSync(project);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "Craft test", GIT_AUTHOR_EMAIL: "craft@example.invalid",
        GIT_COMMITTER_NAME: "Craft test", GIT_COMMITTER_EMAIL: "craft@example.invalid" } });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
  git("add", "a.ts"); git("commit", "-qm", "snapshot source");
  const store = await new CraftStore(paths).open();
  try {
    const workspace = new WorkspaceState(store, paths);
    workspace.open({ workspace_id: "repo", name: "repo", root_path: project, include_paths: ["a.ts"] });
    workspace.checkpoint({ workspace_id: "repo", checkpoint_id: "git-old", label: "git-old" });
    const old = join(project, ".craft_data", "codebase", "snapshots", "repo", "git-old");
    mkdirSync(dirname(old), { recursive: true });
    renameSync(join(projectStorageDirectory(paths, project), "codebase", "snapshots", "repo", "git-old"), old);
    const row = store.database.prepare("SELECT payload_json FROM records WHERE kind='workspace_checkpoint' AND id='git-old'").get() as { payload_json: string };
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint' AND id='git-old'")
      .run(JSON.stringify({ ...JSON.parse(row.payload_json), snapshot_root: old }));
    writeFileSync(join(old, "a.ts"), "damaged\n");
    const ready = codebaseStoragePreflight(paths, { max_records: 10 }).entries.filter(item => item.status === "legacy_ready");
    const legacyPayload = { ...JSON.parse(row.payload_json), snapshot_root: old };
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint' AND id='git-old'")
      .run(JSON.stringify({ ...legacyPayload, entries: [{ ...legacyPayload.entries[0], digest: "0".repeat(64) }] }));
    const unavailable = await migrateCodebaseSnapshots(store, ready, { recover_verified_peer: true });
    assert.equal(unavailable.blocked[0]!.reason, "verified_source_unavailable");
    store.database.prepare("UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint' AND id='git-old'")
      .run(JSON.stringify(legacyPayload));
    const result = await migrateCodebaseSnapshots(store, ready, { recover_verified_peer: true });
    assert.equal(result.migrated, 1);
    assert.equal(result.recovered.length, 1);
    assert.match(result.recovered[0]!.from_git_commit ?? "", /^[a-f0-9]{40,64}$/u);
    assert.equal(result.recovered[0]!.from_checkpoint_id, null);
    const receipt = JSON.parse(readFileSync(join(String(result.backup_directory), "recovery-git-old-v1.json"), "utf8"));
    assert.equal(receipt.schema, "craft.codebase-recovery.v1");
    assert.deepEqual(receipt.recovered, result.recovered);
    assert.equal(readFileSync(join(String(ready[0]!.target_root), "a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(readFileSync(join(old, "a.ts"), "utf8"), "damaged\n");
    const reset = () => store.database.prepare("UPDATE records SET payload_json=? WHERE kind='workspace_checkpoint' AND id='git-old'")
      .run(JSON.stringify(legacyPayload));
    const options = { recover_verified_peer: true, backup_directory: result.backup_directory! };
    reset();
    assert.equal((await migrateCodebaseSnapshots(store, ready, options)).migrated, 1);
    reset();
    writeFileSync(join(result.backup_directory!, "recovery-git-old-v1.json"), "conflicting receipt\n");
    assert.equal((await migrateCodebaseSnapshots(store, ready, options)).blocked[0]!.reason, "recovery_receipt_conflict");
    writeFileSync(join(result.backup_directory!, "verified-git", result.recovered[0]!.digest), "corrupt backup\n");
    assert.equal((await migrateCodebaseSnapshots(store, ready, options)).blocked[0]!.reason, "verified_git_backup_conflict");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
