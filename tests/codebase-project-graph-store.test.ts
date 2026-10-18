import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectGraphStore } from "../capability/craft-codebase/project-graph-store.ts";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";

const record = (id: string, name = "alpha"): JsonObject => ({ id, version: 1, graph_digest: "digest", nodes: [{ name }], edges: [] });

test("project graph records are immutable, digestible and isolated under the project Codebase directory", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-graph-store-"));
  try {
    const store = new ProjectGraphStore(root, "workspace_1");
    const shardId = "codebase_shard_0123456789abcdef0123456789abcdef";
    const routeId = "codebase_edge_route_abcdef0123456789abcdef0123456789";
    const shard = record(shardId);
    store.put(shardId, shard);
    store.put(routeId, record(routeId, "beta"));
    store.put(shardId, shard);

    assert.deepEqual(store.read(shardId), shard);
    assert.equal(store.recordsDigest([shardId, routeId, shardId]), store.recordsDigest([routeId, shardId]));
    assert.match(store.directory, /\.craft_data\/codebase\/indexes\/workspace_1\/graph_records$/u);
    assert.equal(existsSync(join(root, ".craft_data", "codebase", "indexes", "workspace_1", "graph_records", `${shardId}.json`)), true);
    assert.throws(() => store.put(shardId, record(shardId, "changed")), /integrity failure/u);
    assert.throws(() => store.put("wrong_id", record("wrong_id")), /Invalid Codebase graph record/u);
    assert.throws(() => store.put(shardId, record(routeId)), /Invalid Codebase graph record/u);
    assert.throws(() => store.read("missing"), /Invalid Codebase graph record id/u);
    assert.throws(() => store.read("codebase_shard_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    assert.equal(readFileSync(join(store.directory, `${shardId}.json`), "utf8").endsWith("\n"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project graph store rejects unsafe roots, directories, links and malformed records", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-graph-unsafe-"));
  try {
    const fileRoot = join(root, "file-root"); writeFileSync(fileRoot, "x");
    assert.throws(() => new ProjectGraphStore(fileRoot, "workspace"), /root is unsafe/u);
    assert.throws(() => new ProjectGraphStore(root, "../workspace"), /workspace id/u);

    const external = join(root, "external"); mkdirSync(external);
    const linkedRoot = join(root, "linked-root"); symlinkSync(external, linkedRoot);
    assert.throws(() => new ProjectGraphStore(linkedRoot, "workspace"), /root is unsafe/u);

    const linkedDataRoot = join(root, "linked-data-root"); mkdirSync(linkedDataRoot);
    symlinkSync(external, join(linkedDataRoot, ".craft_data"));
    assert.throws(() => new ProjectGraphStore(linkedDataRoot, "workspace"), /path is unsafe/u);

    const store = new ProjectGraphStore(root, "workspace_2");
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});
