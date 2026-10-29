import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseLegacyRepositoryMigrationArgs, runLegacyRepositoryStorageMigration } from "../core/legacy-repository-storage-migration-command.ts";

test("legacy repository migration command parses explicit apply and scan roots", () => {
  assert.deepEqual(parseLegacyRepositoryMigrationArgs(["--data-root=/tmp/craft-data", "/repo/a", "--apply", "/repo/b"]),
    { apply: true, data_root: "/tmp/craft-data", scan_roots: ["/repo/a", "/repo/b"] });
  assert.deepEqual(parseLegacyRepositoryMigrationArgs(["/repo"]), { apply: false, scan_roots: ["/repo"] });
  assert.throws(() => parseLegacyRepositoryMigrationArgs([]), /scan root/u);
  assert.throws(() => parseLegacyRepositoryMigrationArgs(["--apply", "--apply", "/repo"]), /Duplicate/u);
  assert.throws(() => parseLegacyRepositoryMigrationArgs(["--data-root=", "/repo"]), /Invalid/u);
  assert.throws(() => parseLegacyRepositoryMigrationArgs(["--data-root=/a", "--data-root=/b", "/repo"]), /duplicate/u);
  assert.throws(() => parseLegacyRepositoryMigrationArgs(["--unknown", "/repo"]), /Unsupported/u);
});

test("legacy repository migration command dry-runs, applies ready projects, and reports unbound roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-legacy-repo-command-"));
  const project = join(root, "project"), unbound = join(root, "unbound");
  mkdirSync(project); mkdirSync(unbound);
  const git = spawnSync("git", ["init", "-q", project], { encoding: "utf8" }); assert.equal(git.status, 0, git.stderr);
  mkdirSync(join(project, ".craft_data", "memory"), { recursive: true });
  writeFileSync(join(project, ".craft_data", "memory", "memory.md"), "# Project Memory\n");
  mkdirSync(join(unbound, ".craft_data"), { recursive: true });
  writeFileSync(join(unbound, ".craft_data", "unknown.txt"), "unbound");
  const dataRoot = join(root, "global-data");
  try {
    const dryRun = await runLegacyRepositoryStorageMigration([`--data-root=${dataRoot}`, root]);
    assert.equal(dryRun.exit_code, 0);
    const preview = JSON.parse(dryRun.output) as { mode: string; roots: number; statuses: Record<string, number>;
      scan_errors: unknown[]; migratable: number; blocked: Array<{ status: string }> };
    assert.equal(preview.mode, "dry_run");
    assert.equal((preview as unknown as { migration_semantics: string }).migration_semantics, "archive_copy_only");
    assert.equal((preview as unknown as { runtime_data_integrated: boolean }).runtime_data_integrated, false);
    assert.equal(preview.roots, 2);
    assert.deepEqual(preview.statuses, { ready: 1, unbound: 1 });
    assert.equal(preview.scan_errors.length, 0);
    assert.equal(preview.migratable, 1);
    assert.deepEqual(preview.blocked.map(item => item.status), ["unbound"]);
    assert.equal(readFileSync(join(project, ".craft_data", "memory", "memory.md"), "utf8"), "# Project Memory\n");
    const applied = await runLegacyRepositoryStorageMigration([`--data-root=${dataRoot}`, "--apply", root]);
    assert.equal(applied.exit_code, 2);
    const report = JSON.parse(applied.output) as { migrated: number; blocked: Array<{ status: string }> };
    assert.equal(report.migrated, 1);
    assert.deepEqual(report.blocked.map(item => item.status), ["unbound"]);
    assert.equal(readFileSync(join(project, ".craft_data", "memory", "memory.md"), "utf8"), "# Project Memory\n");
    const rerun = await runLegacyRepositoryStorageMigration([`--data-root=${dataRoot}`, "--apply", project]);
    assert.equal(rerun.exit_code, 0);
    assert.equal((JSON.parse(rerun.output) as { results: Array<{ status: string }> }).results[0]!.status, "already_migrated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy repository migration command reports unsafe roots without applying them", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-legacy-repo-unsafe-"));
  const project = join(root, "project"); mkdirSync(project);
  const git = spawnSync("git", ["init", "-q", project], { encoding: "utf8" }); assert.equal(git.status, 0, git.stderr);
  const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "fact.md"), "fact");
  symlinkSync(outside, join(project, ".craft_data"));
  try {
    const dryRun = await runLegacyRepositoryStorageMigration([project]);
    assert.equal(dryRun.exit_code, 0);
    const preview = JSON.parse(dryRun.output) as { roots: number; statuses: Record<string, number>; scan_errors: unknown[];
      migratable: number; blocked: Array<{ status: string }> };
    assert.equal(preview.roots, 1);
    assert.deepEqual(preview.statuses, { unsafe: 1 });
    assert.equal(preview.scan_errors.length, 0);
    assert.equal(preview.migratable, 0);
    assert.deepEqual(preview.blocked.map(item => item.status), ["unsafe"]);
    const applied = await runLegacyRepositoryStorageMigration(["--apply", project]);
    assert.equal(applied.exit_code, 2);
    assert.equal((JSON.parse(applied.output) as { migrated: number }).migrated, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy repository migration command returns partial status when inventory reports scan errors", async () => {
  const result = await runLegacyRepositoryStorageMigration(["--apply", "/repo"], {
    preflight: () => ({ entries: [], scan_errors: [{ path: "/repo/locked", error_code: "EACCES" }] }),
  });
  assert.equal(result.exit_code, 2);
  assert.deepEqual(JSON.parse(result.output), { mode: "apply", migration_semantics: "archive_copy_only", source_retired: false, runtime_data_integrated: false, migrated: 0, results: [], blocked: [],
    scan_errors: [{ path: "/repo/locked", error_code: "EACCES" }] });
  const dryRun = await runLegacyRepositoryStorageMigration(["/repo"], {
    preflight: () => ({ entries: [], scan_errors: [{ path: "/repo/locked", error_code: "EACCES" }] }),
  });
  assert.equal(dryRun.exit_code, 2);
  assert.deepEqual((JSON.parse(dryRun.output) as { scan_errors: unknown[] }).scan_errors, [{ path: "/repo/locked", error_code: "EACCES" }]);
});
