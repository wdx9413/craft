import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "../../craft-common/packages/craft-common-store-local/src/store.ts";
import { craftPaths } from "../../craft-common/packages/craft-common-store-local/src/paths.ts";
import { stableDigest } from "craft-common-base/digest";

test("Notes migration CLI previews a snapshot, applies a digest and supports retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "notes-command-"));
  const localScript = join(process.cwd(), "scripts", "notes-storage-migration.ts");
  const loader = join(process.cwd(), "tests", "helpers", "notes-source-loader.mjs");
  try {
    const project = join(root, "project"); mkdirSync(project);
    const projectId = `project:${"e".repeat(64)}`;
    const store = await new CraftStore(craftPaths(root)).open();
    try {
      store.create("scope_alias", "alias", { status: "active", alias_kind: "path", alias: project,
        alias_digest: stableDigest(project), scope: { kind: "project", id: projectId } });
      store.save("craft_note", "note", { subject_type: "directory", subject_key: `local:${project}`, device_id: "local", project_id: projectId, text: "retained" });
      store.save("craft_notes_location", "unknown", { path: "/unassigned" });
    } finally { store.close(); }
    function run(extra: string[]) {
      return spawnSync(process.execPath, ["--experimental-strip-types", "--import", loader, localScript, `--data-root=${root}`, ...extra], { encoding: "utf8" });
    }
    const unknown = run(["--unknown"]);
    assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /Usage/u);
    const digestWithoutApply = run(["--digest=sha256:invalid"]);
    assert.notEqual(digestWithoutApply.status, 0); assert.match(digestWithoutApply.stderr, /only accepted with --apply/u);
    const badRoot = join(root, "bad-root"); mkdirSync(join(badRoot, "db", "craft.db"), { recursive: true });
    const nonFile = spawnSync(process.execPath, ["--experimental-strip-types", "--import", loader, localScript, `--data-root=${badRoot}`], { encoding: "utf8" });
    assert.notEqual(nonFile.status, 0); assert.match(nonFile.stderr, /existing regular database/u);
    const invalid = run(["--apply"]);
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /requires the digest/u);
    const previewResult = run([]); assert.equal(previewResult.status, 0, previewResult.stderr);
    const preview = JSON.parse(previewResult.stdout);
    assert.equal(preview.eligible.length, 1); assert.equal(preview.pending.length, 1);
    const applied = run(["--apply", `--digest=${preview.digest}`]); assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).migrated, 1);
    const retried = run(["--apply", `--digest=${preview.digest}`]); assert.equal(retried.status, 0, retried.stderr);
    assert.equal(JSON.parse(retried.stdout).already_current, 1);
    const reopened = await new CraftStore(craftPaths(root)).open({ skipLegacyPartitionMigration: true });
    try { assert.equal(reopened.get("craft_note", "note").text, "retained"); }
    finally { reopened.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
