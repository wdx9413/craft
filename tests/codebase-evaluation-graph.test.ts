import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectGraphStore } from "../capability/craft-codebase/project-graph-store.ts";
import type { CraftStore, JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { readCodebaseEvaluationSymbolNodes } from "../scripts/eval/codebase-evaluation-graph.ts";

const shardId = "codebase_shard_0123456789abcdef0123456789abcdef";
const nodes: JsonObject[] = [
  { id: "symbol_1", kind: "symbol", name: "target" },
  { id: "file_1", kind: "file", name: "source.ts" },
];

test("evaluation corpus reads project-local graph shards", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-eval-project-graph-"));
  try {
    const graph = new ProjectGraphStore(root, "workspace_1");
    graph.put(shardId, { id: shardId, version: 1, nodes, edges: [] });
    const store = { get: () => { throw new Error("project graph must not use CraftStore"); } } as unknown as Pick<CraftStore, "get">;

    assert.deepEqual(readCodebaseEvaluationSymbolNodes(store, root, "workspace_1", {
      graph_storage: "project-sharded-v5", node_shard_ids: [shardId],
    }), [nodes[0]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("evaluation corpus keeps reading legacy CraftStore graph shards", () => {
  const store = { get: (kind: string, id: string) => {
    assert.equal(kind, "codebase_index_shard");
    assert.equal(id, shardId);
    return { id, version: 1, nodes, edges: [] };
  } } as unknown as Pick<CraftStore, "get">;

  assert.deepEqual(readCodebaseEvaluationSymbolNodes(store, "/unused", "workspace_2", {
    graph_storage: "sharded-v4", node_shard_ids: [shardId],
  }), [nodes[0]]);
});
