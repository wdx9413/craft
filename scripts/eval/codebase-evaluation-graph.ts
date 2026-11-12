import type { CraftStore, JsonObject } from 'craft-common-store-local/store';
import { ProjectGraphStore } from '@craft/capability-codebase/project-graph-store';

/** Read the symbol corpus from either project-local or legacy CraftStore graph shards. */
export function readCodebaseEvaluationSymbolNodes(store: Pick<CraftStore, "get" | "paths">, projectRoot: string,
  workspaceId: string, indexRecord: JsonObject): JsonObject[] {
  const nodeShardIds = indexRecord.node_shard_ids as string[];
  const projectGraph = indexRecord.graph_storage === "project-sharded-v5" ? new ProjectGraphStore(projectRoot, workspaceId, store.paths) : null;
  const readShard = projectGraph
    ? (id: string) => projectGraph.read(id)
    : (id: string) => store.get("codebase_index_shard", id);
  return nodeShardIds.flatMap(id => (readShard(id).nodes as JsonObject[]).filter(node => node.kind === "symbol"));
}
