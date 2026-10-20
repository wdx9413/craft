import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { externalMarketplaceProducts } from "../core/release-catalog.ts";
import { exchange } from "../adapters/deepseek-harness/mcp-client.ts";
const root = resolve(import.meta.dirname, "..");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("the compact Context Agent product negotiates through Codex, Claude and portable manifests", async () => {
  assert.deepEqual(externalMarketplaceProducts().map(product => product.name), ["craft-context", "craft-datasec"]);
  const data = mkdtempSync(join(tmpdir(), "craft-products-wire-"));
  try {
    for (const product of externalMarketplaceProducts().filter(product => product.surface !== "standalone-hooks")) {
      const directory = join(root, "plugins", product.name); const selected = product.name.slice(6);
      const native = json(join(directory, ".mcp.json")).mcpServers[product.name];
      const claude = json(join(directory, ".claude-plugin/plugin.json")).mcpServers[product.name];
      const portable = json(join(directory, "mcp.json")).mcpServers[product.name];
      for (const [host, config] of [["codex", native], ["claude", claude], ["portable", portable]] as const) {
        const args = config.args.map((arg: string, i: number) => i ? arg : arg.replace('${PLUGIN_ROOT}', directory).replace('${CLAUDE_PLUGIN_ROOT}', directory));
        if (host === "codex") args[0] = join(directory, args[0]);
        const launch = { command: config.command, args, env: { ...process.env, CRAFT_DATA_DIR: data, CRAFT_CONTINUOUS_LEARNING: "0" } };
        const list = await exchange(launch, "tools/list");
        assert.equal(new Set(list.tools.map((t: { name: string }) => t.name)).size, list.tools.length);
        assert(list.tools.length <= 90, `Context Agent exposes ${list.tools.length} tools; Host limit is 90`);
        const info = ["context", "codebase"].includes(selected);
        const name = info ? "craft_info" : "craft_component_readiness_get";
        assert(list.tools.some((tool: { name: string }) => tool.name === name));
        assert.equal((await exchange(launch, "tools/call", { name, arguments: info ? {} : { component: selected } })).isError, false);
        if (selected === "context") {
          for (const name of ["craft_context_open", "craft_context_tools_discover", "craft_knowledge_search", "craft_memory_capture_observed_fact", "craft_run", "craft_codebase_impact_query"])
            assert(list.tools.some((tool: { name: string }) => tool.name === name), `Context Agent must expose ${name}`);
          for (const name of ["craft_knowledge_claim_save", "craft_memory_ledger_transition", "craft_procedure_host_control"])
            assert(!list.tools.some((tool: { name: string }) => tool.name === name), `Context Agent must route ${name} on demand`);
          for (const member of ["knowledge", "memory", "experience", "codebase"]) assert(readFileSync(join(directory, "skills/craft-context/references", `craft-${member}`, "SKILL.md"), "utf8").length);
        }
      }
    }
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("marketplace publishes one context plugin and keeps shared repository indexing deterministic", async () => {
  assert.deepEqual(externalMarketplaceProducts().map(product => product.name), ["craft-context", "craft-datasec"]);
  assert.equal(existsSync(join(root, "plugins", "craft-context", "dsh")), false, "DSH payloads are not part of the marketplace package");
  const temporary = mkdtempSync(join(tmpdir(), "craft-context-package-"));
  const repository = join(temporary, "repo"); mkdirSync(repository); execFileSync("git", ["-C", repository, "init", "-q"]); writeFileSync(join(repository, "a.ts"), "export function alpha() {}\n");
  try {
    const launch = { command: process.execPath, args: [join(root, "plugins/craft-context/dist/plugin/craft-mcp.cjs"), "--product", "context"], env: { ...process.env, CRAFT_DATA_DIR: join(temporary, "data"), CRAFT_CONTINUOUS_LEARNING: "0" } };
    const first = await exchange(launch, "tools/call", { name: "craft_context_open", arguments: { project_root: repository, query: "alpha" } });
    const second = await exchange(launch, "tools/call", { name: "craft_context_open", arguments: { project_root: repository, query: "alpha" } });
    assert.equal(first.structuredContent.codebase.index_id, second.structuredContent.codebase.index_id);
    const cold = { ...launch, env: { ...launch.env, CRAFT_DATA_DIR: join(temporary, "fresh-data") } };
    const coldFirst = await exchange(cold, "tools/call", { name: "craft_context_open", arguments: { project_root: repository, query: "alpha" } });
    const coldSecond = await exchange(cold, "tools/call", { name: "craft_context_open", arguments: { project_root: repository, query: "alpha" } });
    assert.equal(coldFirst.structuredContent.codebase.index_id, coldSecond.structuredContent.codebase.index_id);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
