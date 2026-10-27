import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, renameSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ensureProjectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";
import { EvolutionCandidateWorkspace } from "../core/evolution-candidate-workspace.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { payload } from "../core/digest.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-evolution-candidate-")), dataRoot = join(root, "data"), projectRoot = join(root, "project");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "main.txt"), "baseline\n");
  await writeFile(join(projectRoot, "src", "second.txt"), "second\n");
  const store = await new CraftStore(craftPaths(dataRoot)).open(), service = new CraftService(store);
  const task = store.create("task", "task", { title: "Candidate task" });
  const identity = service.scopeIdentityResolveProject({ project_root: projectRoot }).identity as JsonObject;
  const scope = identity.canonical_scope as JsonObject;
  service.workspaceOpen({ workspace_id: "workspace", name: "Candidate test", root_path: projectRoot, include_paths: ["src"] });
  const checkpoint = service.workspaceCheckpoint({ workspace_id: "workspace", checkpoint_id: "checkpoint", label: "baseline" }).checkpoint as JsonObject;
  const manager = new EvolutionCandidateWorkspace(store, store.paths);
  const args = { workspace_id: "workspace", checkpoint_id: String(checkpoint.id), checkpoint_version: Number(checkpoint.version), candidate_id: "candidate" };
  return { root, dataRoot, projectRoot, store, service, manager, task, projectScopeId: scope.id, checkpoint, args,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Candidate workspace is an atomic Craft-data copy pinned to the checkpoint and leaves the project untouched", async () => {
  const f = await fixture();
  try {
    const created = f.manager.create(f.args), candidatePath = String(created.path);
    assert.equal(created.status, "ready"); assert.equal(created.idempotent, false);
    assert.equal(candidatePath.startsWith(join(f.dataRoot, "projects")), true);
    assert.equal(await readFile(join(candidatePath, "src", "main.txt"), "utf8"), "baseline\n");
    await writeFile(join(candidatePath, "src", "main.txt"), "candidate edit\n");
    assert.equal(await readFile(join(f.projectRoot, "src", "main.txt"), "utf8"), "baseline\n");
    const retried = f.manager.create(f.args);
    assert.equal(retried.idempotent, true); assert.equal(retried.path, candidatePath);
    assert.equal((f.manager.get(f.args).manifest as JsonObject).source_digest, (created.manifest as JsonObject).source_digest);
    const otherCandidate = f.manager.create({ ...f.args, candidate_id: "candidate-two" });
    assert.equal(otherCandidate.idempotent, false);
  } finally { await f.close(); }
});

test("Candidate workspace rejects invalid identities, stale bindings, unsafe roots and malformed entries", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.manager.create({ ...f.args, candidate_id: "../escape" }), /candidate_id is invalid/u);
    assert.throws(() => f.manager.create({ ...f.args, workspace_id: "../escape" }), /workspace_id is invalid/u);
    assert.throws(() => f.manager.create({ ...f.args, checkpoint_id: "../escape" }), /checkpoint_id is invalid/u);
    const workspace = f.store.get("workspace", "workspace");
    f.store.save("workspace", "workspace", { ...payload(workspace), latest_checkpoint_id: "newer" });
    assert.throws(() => f.manager.create(f.args), /latest checkpoint/u);
    f.store.save("workspace", "workspace", { ...payload(workspace) });

    const original = f.store.get("workspace_checkpoint", "checkpoint");
    const altered = (fields: JsonObject) => f.store.save("workspace_checkpoint", "checkpoint", { ...payload(original), ...fields });
    let checkpoint = altered({ snapshot_root: join(f.projectRoot, "src") });
    assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: checkpoint.version }), /outside its project Codebase storage/u);
    checkpoint = altered({ entries: "invalid" });
    assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: checkpoint.version }), /entries are invalid/u);
    checkpoint = altered({ entries: [{ path: "../outside", digest: "0".repeat(64) }] });
    assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: checkpoint.version }), /path must be relative/u);
    checkpoint = altered({ entries: [{ path: "src/main.txt", digest: "invalid" }] });
    assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: checkpoint.version }), /entry digest is invalid/u);
    checkpoint = altered({ entries: [{ path: "src/main.txt", digest: null }] });
    assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: checkpoint.version }), /entry digest is invalid/u);
    checkpoint = altered({ entries: [{ path: "src/main.txt", digest: "0".repeat(64) }] });
    assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: checkpoint.version }), /digest verification/u);
  } finally { await f.close(); }
});

test("Candidate workspace rejects duplicate, non-regular and symlink checkpoint files", async () => {
  const f = await fixture();
  try {
    const original = f.store.get("workspace_checkpoint", "checkpoint"), entry = (original.entries as JsonObject[])[0]!;
    let checkpoint = f.store.save("workspace_checkpoint", "checkpoint", { ...payload(original), entries: [entry, entry] });
    assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: checkpoint.version }), /duplicate paths/u);
    checkpoint = f.store.save("workspace_checkpoint", "checkpoint", { ...payload(original), entries: [{ ...entry, size_bytes: Number(entry.size_bytes) + 1 }] });
    assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: checkpoint.version }), /digest verification/u);
    const source = join(String(original.snapshot_root), "src", "main.txt"), moved = `${source}.saved`;
    await rename(source, moved); await symlink(join(f.projectRoot, "src", "main.txt"), source);
    try { assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: Number(original.version) }), /non-regular file/u); }
    finally { await rm(source, { force: true }); await rename(moved, source); }
  } finally { await f.close(); }
});

test("Candidate workspace refuses destination and manifest tampering on create and read", async () => {
  const f = await fixture();
  try {
    const projectDirectory = ensureProjectStorageDirectory(f.store.paths, f.projectRoot);
    const parent = join(projectDirectory, "evolution", "candidates"); await mkdir(parent, { recursive: true });
    const unsafeId = "unsafe", unsafeDirectory = join(parent, unsafeId);
    await symlink(f.projectRoot, unsafeDirectory);
    assert.throws(() => f.manager.create({ ...f.args, candidate_id: unsafeId }), /destination is unsafe/u);
    await rm(unsafeDirectory);

    const created = f.manager.create(f.args), candidateDirectory = join(parent, "candidate"), manifestPath = join(candidateDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as JsonObject;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, candidate_id: "tampered" }));
    assert.throws(() => f.manager.create(f.args), /idempotency conflict/u);
    assert.throws(() => f.manager.get(f.args), /binding is stale or corrupt/u);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, source_digest: "0".repeat(64) }));
    assert.throws(() => f.manager.get(f.args), /idempotency conflict/u);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, schema: "unknown" }));
    assert.throws(() => f.manager.get(f.args), /idempotency conflict/u);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const workspacePath = String(created.path), moved = `${workspacePath}.saved`;
    await rename(workspacePath, moved); await symlink(f.projectRoot, workspacePath);
    try {
      assert.throws(() => f.manager.create(f.args), /workspace directory is unsafe/u);
      assert.throws(() => f.manager.get(f.args), /workspace directory is unsafe/u);
    } finally { await rm(workspacePath); await rename(moved, workspacePath); }
  } finally { await f.close(); }
});

test("Candidate workspace freezes only changes under the configured allowlist", async () => {
  const f = await fixture();
  try {
    const created = f.manager.create(f.args), candidateRoot = String(created.path);
    assert.deepEqual(f.manager.validateChanges({ ...f.args, allowed_paths: [] }).changed_paths, []);
    await writeFile(join(candidateRoot, "src", "main.txt"), "candidate\n");
    await writeFile(join(candidateRoot, "src", "new.txt"), "new\n");
    const validated = f.manager.validateChanges({ ...f.args, allowed_paths: ["src"] });
    assert.deepEqual(validated.changed_paths, ["src/main.txt", "src/new.txt"]);
    assert.match(String(validated.candidate_digest), /^sha256:/u);
    assert.deepEqual(f.manager.validateChanges({ ...f.args, allowed_paths: ["src/main.txt", "src/new.txt"] }).changed_paths, validated.changed_paths);
    assert.throws(() => f.manager.validateChanges({ ...f.args, allowed_paths: ["src", "src"] }), /must be unique/u);
    assert.throws(() => f.manager.validateChanges({ ...f.args, allowed_paths: ["../outside"] }), /path must be relative/u);
    assert.throws(() => f.manager.validateChanges({ ...f.args, allowed_paths: "src" }), /at most 100/u);
    assert.throws(() => f.manager.validateChanges({ ...f.args, allowed_paths: Array.from({ length: 101 }, (_, index) => `src/${index}`) }), /at most 100/u);
    await rm(join(candidateRoot, "src", "main.txt"));
    const afterDelete = f.manager.validateChanges({ ...f.args, allowed_paths: ["src"] });
    assert.deepEqual(afterDelete.changed_paths, ["src/main.txt", "src/new.txt"]);
    assert.throws(() => f.manager.validateChanges({ ...f.args, allowed_paths: ["src/main.txt"] }), /outside allowed_paths/u);
    await symlink(join(f.projectRoot, "src", "main.txt"), join(candidateRoot, "src", "link.txt"));
    assert.throws(() => f.manager.validateChanges({ ...f.args, allowed_paths: ["src"] }), /contains a symlink/u);
    await rm(join(candidateRoot, "src", "link.txt"));
    execFileSync("mkfifo", [join(candidateRoot, "src", "pipe")]);
    assert.throws(() => f.manager.validateChanges({ ...f.args, allowed_paths: ["src"] }), /non-regular entry/u);
  } finally { await f.close(); }
});

test("Candidate workspace bounds the number of files it inspects", async () => {
  const f = await fixture();
  try {
    const created = f.manager.create(f.args), candidateRoot = String(created.path), directory = join(candidateRoot, "many");
    await mkdir(directory);
    for (let index = 0; index <= 10_000; index++) await writeFile(join(directory, String(index)), "x");
    assert.throws(() => f.manager.validateChanges({ ...f.args, allowed_paths: ["many"] }), /exceeds the file limit/u);
  } finally { await f.close(); }
});

test("Candidate workspace rejects unsafe parent paths and cleans a failed atomic stage", async () => {
  const f = await fixture();
  try {
    const projectDirectory = ensureProjectStorageDirectory(f.store.paths, f.projectRoot);
    const evolution = join(projectDirectory, "evolution"), candidates = join(evolution, "candidates");
    await symlink(f.projectRoot, evolution);
    assert.throws(() => f.manager.create(f.args), /path is unsafe/u);
    await rm(evolution);
    await mkdir(evolution);
    await symlink(f.projectRoot, candidates);
    assert.throws(() => f.manager.create(f.args), /path is unsafe/u);
    await rm(candidates);

    const failing = new EvolutionCandidateWorkspace(f.store, f.store.paths, () => { throw new Error("copy failed"); });
    assert.throws(() => failing.create(f.args), /copy failed/u);
    assert.deepEqual(await readdir(candidates), []);

    const checkpoint = f.store.get("workspace_checkpoint", "checkpoint"), twoEntries = checkpoint.entries as JsonObject[];
    const symlinkInjecting = new EvolutionCandidateWorkspace(f.store, f.store.paths, (source, target) => {
      copyFileSync(source, target);
      const candidateSourceDir = dirname(target);
      if (target.endsWith("main.txt")) {
        const movedSourceDir = `${candidateSourceDir}.saved`;
        renameSync(candidateSourceDir, movedSourceDir);
        symlinkSync(join(f.projectRoot, "src"), candidateSourceDir);
      }
    });
    assert.throws(() => symlinkInjecting.create({ ...f.args, candidate_id: "symlink-stage" }), /unsafe directory/u);
    assert.deepEqual(await readdir(candidates), []);
    assert.equal(twoEntries.length, 2);
  } finally { await f.close(); }
});

test("Candidate workspace rejects empty and symlinked nested snapshot paths and unsafe manifests", async () => {
  const f = await fixture();
  try {
    const original = f.store.get("workspace_checkpoint", "checkpoint");
    const setEntries = (entries: unknown[]) => f.store.save("workspace_checkpoint", "checkpoint", { ...payload(original), entries });
    let checkpoint = setEntries([{ path: ".", digest: "0".repeat(64) }]);
    assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: checkpoint.version }), /must name a file/u);

    const sourceRoot = String(original.snapshot_root), sourceDirectory = join(sourceRoot, "src"), moved = `${sourceDirectory}.saved`;
    await rename(sourceDirectory, moved); await symlink(join(f.projectRoot, "src"), sourceDirectory);
    try {
      assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: Number(original.version) }), /unsafe directory/u);
    } finally { await rm(sourceDirectory); await rename(moved, sourceDirectory); }

    const movedRoot = `${sourceRoot}.saved`;
    await rename(sourceRoot, movedRoot); await symlink(movedRoot, sourceRoot);
    try { assert.throws(() => f.manager.create({ ...f.args, checkpoint_version: Number(original.version) }), /checkpoint path is unsafe/u); }
    finally { await rm(sourceRoot); await rename(movedRoot, sourceRoot); }

    const created = f.manager.create(f.args), manifestPath = join(join(ensureProjectStorageDirectory(f.store.paths, f.projectRoot), "evolution", "candidates", "candidate"), "manifest.json");
    const backup = `${manifestPath}.saved`; await rename(manifestPath, backup); await symlink(join(f.projectRoot, "src", "main.txt"), manifestPath);
    try {
      assert.throws(() => f.manager.create(f.args), /manifest is unsafe/u);
      assert.throws(() => f.manager.get(f.args), /manifest is unsafe/u);
    } finally { await rm(manifestPath); await rename(backup, manifestPath); }
    assert.equal(created.status, "ready");
    const destination = join(ensureProjectStorageDirectory(f.store.paths, f.projectRoot), "evolution", "candidates", "candidate");
    const workspacePath = join(destination, "workspace"), savedWorkspace = `${workspacePath}.saved`;
    await rename(workspacePath, savedWorkspace); await symlink(f.projectRoot, workspacePath);
    try { assert.throws(() => f.manager.get(f.args), /directory is unsafe/u); }
    finally { await rm(workspacePath); await rename(savedWorkspace, workspacePath); }

    const savedDestination = `${destination}.saved`;
    await rename(destination, savedDestination); await symlink(f.projectRoot, destination);
    try { assert.throws(() => f.manager.get(f.args), /destination is unsafe/u); }
    finally { await rm(destination); await rename(savedDestination, destination); }

    const withoutSize = f.store.save("workspace_checkpoint", "checkpoint", { ...payload(original), entries: (original.entries as JsonObject[]).map(({ size_bytes: _size, ...entry }) => entry) });
    const noSizeCandidate = f.manager.create({ ...f.args, candidate_id: "without-size", checkpoint_version: withoutSize.version });
    assert.equal((noSizeCandidate.manifest as JsonObject[])[0]?.size_bytes, undefined);
    assert.equal(f.manager.get({ ...f.args, candidate_id: "without-size", checkpoint_version: withoutSize.version }).status, "ready");

    let malformed = f.store.save("workspace_checkpoint", "checkpoint", { ...payload(withoutSize), entries: "invalid" });
    const noSizeManifest = join(ensureProjectStorageDirectory(f.store.paths, f.projectRoot), "evolution", "candidates", "without-size", "manifest.json");
    let manifestValue = JSON.parse(await readFile(noSizeManifest, "utf8")) as JsonObject;
    await writeFile(noSizeManifest, JSON.stringify({ ...manifestValue, checkpoint_version: malformed.version }));
    assert.throws(() => f.manager.get({ ...f.args, candidate_id: "without-size", checkpoint_version: malformed.version }), /entries are invalid/u);
    malformed = f.store.save("workspace_checkpoint", "checkpoint", { ...payload(malformed), entries: [{ path: "src/main.txt", digest: null }] });
    manifestValue = JSON.parse(await readFile(noSizeManifest, "utf8")) as JsonObject;
    await writeFile(noSizeManifest, JSON.stringify({ ...manifestValue, checkpoint_version: malformed.version }));
    assert.throws(() => f.manager.get({ ...f.args, candidate_id: "without-size", checkpoint_version: malformed.version }), /entry digest is invalid/u);
  } finally { await f.close(); }
});
