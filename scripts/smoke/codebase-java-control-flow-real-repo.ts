import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

const projectRoot = resolve(process.argv[2] ?? "/Users/didi/Documents/project/d-forge");
const targetPath = process.argv[3] ?? "d-forge-config-server/src/main/java/com/xiaoju/uemc/dforgeconfig/service/impl/DataWorkflowServiceImpl.java";
const targetName = process.argv[4] ?? "linkDatasetDependency";
const temporaryRoot = mkdtempSync(join(tmpdir(), "craft-java-flow-repo-"));
const store = await new CraftStore(craftPaths(join(temporaryRoot, "data"))).open();
try {
  const service = new CraftService(store);
  const ensured = service.codebaseRepositoryEnsure({ project_root: projectRoot, index_depth: "semantic" });
  assert.equal(ensured.status, "ready", "real repository semantic index should be ready");
  const candidates = service.codebaseSymbolFind({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: targetName, limit: 100 });
  const symbol = (candidates.symbols as JsonObject[]).find(item => item.name === targetName && item.path === targetPath && item.language === "java");
  assert(symbol, `expected Java symbol ${targetPath}:${targetName} in the real checkpoint`);
  const flow = service.codebaseControlFlowQuery({ workspace_id: ensured.workspace_id, index_id: ensured.index_id, node_id: symbol.id });
  assert(["complete", "partial"].includes(String(flow.status)), "flow query must report a bounded analysis status");
  assert.equal(flow.source_digest, symbol.source_digest, "flow receipt must pin the symbol checkpoint source digest");
  assert.equal(flow.source_content_included, false, "flow query must not return source text");
  assert(Array.isArray(flow.blocks) && flow.blocks.length > 5, "real Java method should produce a nontrivial CFG");
  assert(Array.isArray(flow.edges) && flow.edges.length > 0, "real Java CFG should contain edges");
  assert(Array.isArray(flow.partial_reasons), "unsupported constructs must have an explicit partial reason list");
  assert((flow.blocks as JsonObject[]).some(block => block.kind === "condition"), "real Java CFG should expose a branch");
  assert((flow.blocks as JsonObject[]).some(block => block.kind === "loop_condition"), "real Java CFG should expose a loop");
  assert((flow.edges as JsonObject[]).some(edge => edge.loop_back === true), "real Java CFG should expose a loop back edge");
  assert.equal(Object.hasOwn(flow, "source"), false);
  console.log(JSON.stringify({ project_root: projectRoot, workspace_id: ensured.workspace_id, index_id: ensured.index_id,
    checkpoint_id: ensured.checkpoint_id, symbol_id: symbol.id, path: targetPath, name: targetName,
    source_digest: flow.source_digest, query_receipt_id: ((flow.receipt as JsonObject | undefined)?.id ?? null),
    status: flow.status, partial_reasons: flow.partial_reasons,
    block_count: (flow.blocks as unknown[]).length, edge_count: (flow.edges as unknown[]).length }, null, 2));
} finally {
  store.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
