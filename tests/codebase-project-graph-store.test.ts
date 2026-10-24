import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectGraphStore } from "../capability/craft-codebase/project-graph-store.ts";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { craftPaths, projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";

const record = (id: string, name = "alpha"): JsonObject => ({ id, version: 1, graph_digest: "digest", nodes: [{ name }], edges: [] });

test("project graph records are immutable, digestible and isolated under the project Codebase directory", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-graph-store-"));
  try {
    const project = join(root, "project"), data = join(root, "data");
    mkdirSync(project); mkdirSync(data);
    const paths = craftPaths(data);
    const store = new ProjectGraphStore(project, "workspace_1", paths);
    const shardId = "codebase_shard_0123456789abcdef0123456789abcdef";
    const routeId = "codebase_edge_route_abcdef0123456789abcdef0123456789";
    const shard = record(shardId);
    store.put(shardId, shard);
    store.put(routeId, record(routeId, "beta"));
    store.put(shardId, shard);

    assert.deepEqual(store.read(shardId), shard);
    assert.equal(store.recordsDigest([shardId, routeId, shardId]), store.recordsDigest([routeId, shardId]));
    assert.equal(store.directory, join(projectStorageDirectory(paths, project), "codebase", "indexes", "workspace_1", "graph_records"));
    assert.equal(existsSync(join(store.directory, `${shardId}.json`)), true);
    assert.equal(existsSync(join(project, ".craft_data")), false);
    assert.throws(() => store.put(shardId, record(shardId, "changed")), /integrity failure/u);
    assert.throws(() => store.put("wrong_id", record("wrong_id")), /Invalid Codebase graph record/u);
    assert.throws(() => store.put(shardId, record(routeId)), /Invalid Codebase graph record/u);
    assert.throws(() => store.read("missing"), /Invalid Codebase graph record id/u);
    assert.throws(() => store.read("codebase_shard_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    assert.equal(readFileSync(join(store.directory, `${shardId}.json`), "utf8").endsWith("\n"), true);
    const fingerprint = store.recordsFingerprint([shardId, routeId, shardId]);
    assert.equal(fingerprint, store.recordsFingerprint([routeId, shardId]));
    const shardPath = join(store.directory, `${shardId}.json`);
    writeFileSync(shardPath, `${JSON.stringify(record(shardId, "bravo"))}\n`);
    const future = new Date(Date.now() + 5_000);
    utimesSync(shardPath, future, future);
    assert.notEqual(store.recordsFingerprint([shardId]), fingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project graph store rejects unsafe roots, directories, links and malformed records", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-graph-unsafe-"));
  try {
    const project = join(root, "project"), data = join(root, "data");
    mkdirSync(project); mkdirSync(data);
    const paths = craftPaths(data);
    const fileRoot = join(root, "file-root"); writeFileSync(fileRoot, "x");
    assert.throws(() => new ProjectGraphStore(fileRoot, "workspace", paths), /root must be a directory/u);
    assert.throws(() => new ProjectGraphStore(project, "../workspace", paths), /workspace id/u);

    const blockedProject = join(root, "blocked-project"); mkdirSync(blockedProject);
    const blockedRecords = join(projectStorageDirectory(paths, blockedProject), "codebase", "indexes", "workspace_file", "graph_records");
    mkdirSync(dirname(blockedRecords), { recursive: true }); writeFileSync(blockedRecords, "not a directory");
    assert.throws(() => new ProjectGraphStore(blockedProject, "workspace_file", paths), /graph path is unsafe/u);

    const external = join(root, "external"); mkdirSync(external);
    const linkedRoot = join(root, "linked-root"); symlinkSync(external, linkedRoot);
    assert.equal(new ProjectGraphStore(linkedRoot, "workspace", paths).directory,
      new ProjectGraphStore(external, "workspace", paths).directory);

    const linkedDataRoot = join(root, "linked-data-root"); mkdirSync(linkedDataRoot);
    symlinkSync(external, join(linkedDataRoot, "projects"));
    assert.throws(() => new ProjectGraphStore(project, "workspace", craftPaths(linkedDataRoot)), /regular directories/u);

    const store = new ProjectGraphStore(project, "workspace_2", paths);
    const id = "codebase_shard_0123456789abcdef0123456789abcdef";
    const path = join(store.directory, `${id}.json`);
    writeFileSync(path, "[]");
    assert.throws(() => store.read(id), /record is invalid/u);
    rmSync(path);
    writeFileSync(path, JSON.stringify({ id: "different" }));
    assert.throws(() => store.read(id), /record is invalid/u);
    rmSync(path);
    symlinkSync(join(external, "missing.json"), path);
    assert.throws(() => store.read(id), /record is unsafe/u);
    assert.throws(() => store.recordsDigest([id]), /record is unsafe/u);
    assert.throws(() => store.recordsFingerprint([id]), /record is unsafe/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
