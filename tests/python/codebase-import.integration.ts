import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CraftStore, type JsonObject } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";
import { McpServer } from "../../core/mcp.ts";
const root = await mkdtemp(join(tmpdir(), "craft-jedi-import-"));
const store = await new CraftStore(craftPaths(join(root, "data"))).open();
try {
  const repo = join(root, "repo"); await mkdir(repo);
  await writeFile(join(repo, "target.py"), "def target():\n    return 1\n");
  await writeFile(join(repo, "caller.py"), "from target import target as alias\ndef caller():\n    return alias()\n# alias()\ntext='alias()'\n");
  const server = new McpServer(new CraftService(store), "component-codebase");
  let id = 0;
  const call = async (name: string, args: JsonObject) => {
    const response = await server.handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
    const result = response!.result as JsonObject; assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent as JsonObject;
  };
  const opened = await call("craft_codebase_workspace_open", { workspace_id: "python", root_path: repo, include_paths: ["target.py", "caller.py"] });
  const checkpoint = opened.checkpoint as JsonObject;
  const documents = await Promise.all((checkpoint.entries as JsonObject[]).map(async item => ({ path: item.path, content: await readFile(join(String(checkpoint.snapshot_root), String(item.path)), "utf8"), source_digest: item.digest })));
  const input = join(root, "documents.json"); await writeFile(input, JSON.stringify({ documents }));
  const analyzed = spawnSync("uv", ["run", "--offline", resolve("scripts/codebase/analyze-python.py"), input], { encoding: "utf8", env: process.env, timeout: 30000 });
  assert.equal(analyzed.status, 0, analyzed.stderr);
  await call("craft_codebase_activate", { workspace_id: "python" });
  const imported = await call("craft_codebase_analysis_import", { workspace_id: "python", checkpoint_id: checkpoint.id, analysis: JSON.parse(analyzed.stdout) });
  const query = { workspace_id: "python", index_id: (imported.index as JsonObject).id };
  const target = ((await call("craft_codebase_symbol_find", { ...query, query: "target" })).symbols as JsonObject[]).find(node => node.name === "target")!;
  const callers = (await call("craft_codebase_callers_find", { ...query, node_id: target.id })).callers as JsonObject[];
  assert.equal(callers.length, 1); assert.equal((callers[0]!.caller as JsonObject).name, "caller");
  console.log(JSON.stringify({ status: "passed", analyzer: "jedi-static", analyzer_version: "0.19.2", mcp_calls: id, callers: callers.length, fixture: "cross-file-alias-negative-comments-strings", real_host_task: false }));
} finally { store.close(); await rm(root, { recursive: true, force: true }); }
