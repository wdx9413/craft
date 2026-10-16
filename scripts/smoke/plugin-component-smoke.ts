import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MCP_PREFERRED_PROTOCOL_VERSION } from "../../core/distribution-and-first-run.ts";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";

const root = resolve(import.meta.dirname, "..", "..");
import { RELEASE_PRODUCTS } from "../../core/release-catalog.ts";

const components = RELEASE_PRODUCTS.filter((product) => product.name !== "craft").map((product) => product.name);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs); })])
    .finally(() => clearTimeout(timeout));
}

await assert.rejects(() => withTimeout(new Promise<never>(() => {}), 1, "timeout_fixture"), /timeout_fixture timed out/u);

async function smoke(name: string): Promise<void> {
  const pluginRoot = join(root, "plugins", name);
  const manifest = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8"));
  const server = manifest.mcpServers[name];
  const data = await mkdtemp(join(tmpdir(), `${name}-smoke-`));
  const repo = join(data, "repo");
  if (name === "craft-codebase" || name === "craft-context") {
    await mkdir(repo);
    execFileSync("git", ["-C", repo, "init", "-q"]);
    await writeFile(join(repo, "main.py"), "def value():\n    return 1\n\ndef caller():\n    return value()\n\ndef flow_target(flag, items):\n    if flag:\n        for item in items:\n            if item:\n                return value()\n    return 0\n");
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "agent.ts"), "export function typescriptAgentTarget() { return 1; }\nexport function typescriptAgentEntry() { return typescriptAgentTarget(); }\n");
    await writeFile(join(repo, "src", "JavaAgentFixture.java"), "class JavaAgentFixture { static int javaAgentTarget() { return 1; } static int javaAgentEntry(boolean flag) { int n = 1; if (flag) { n++; } else { n--; } for (int i = 0; i < 2; i++) { n += i; } return javaAgentTarget() + n; } }\n");
    await writeFile(join(repo, "go.mod"), "module example.test/agent-smoke\n\ngo 1.22\n");
    await writeFile(join(repo, "src", "agent.go"), "package agentfixture\n\nfunc goAgentTarget() int { return 1 }\nfunc goAgentEntry() int { return goAgentTarget() }\n");
    await mkdir(join(data, "config"), { recursive: true });
    await writeFile(join(data, "config", "codebase-lsp.json"), JSON.stringify({ schema_version: 1, adapters: [{ language: "go",
      command: process.execPath, args: [join(root, "scripts", "smoke", "fixtures", "go-lsp-fixture.cjs")], analyzer_version: "go-mcp-smoke-1",
      relations: ["calls"], max_documents: 10, relation_symbol_limit: 10 }] }));
  }
  const child = spawn(server.command, server.args, { cwd: pluginRoot, env: { ...process.env, CRAFT_DATA_DIR: data }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    let output = "";
    const pending = new Map<number, { resolve: (response: Record<string, any>) => void; reject: (error: Error) => void }>();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.split(/\r?\n/u);
      output = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const response = JSON.parse(line) as Record<string, any>;
        const id = Number(response.id);
        const waiter = pending.get(id);
        if (waiter) { pending.delete(id); waiter.resolve(response); }
      }
    });
    child.once("error", (error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
    let nextId = 0;
    const request = (method: string, params?: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, any>> => {
      const id = ++nextId;
      const response = new Promise<Record<string, any>>((resolveResponse, reject) => pending.set(id, { resolve: resolveResponse, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      return withTimeout(response, timeoutMs, `${name}:${method}`);
    };
    const expectedDailyTool = name === "craft-codebase" ? "craft_codebase_status" : name === "craft-context" ? "craft_context_open" : ["craft-knowledge", "craft-memory", "craft-experience"].includes(name) ? "craft_component_readiness_get" : "craft_info";
    const callTool = name === "craft-codebase" ? "craft_codebase_repository_ensure" : expectedDailyTool;
    const callArguments = name === "craft-codebase" ? { project_root: repo, index_depth: "semantic" }
      : name === "craft-context" ? { project_root: repo, query: "Codebase MCP full semantic index smoke", index_depth: "semantic", max_items: 1 }
      : expectedDailyTool === "craft_component_readiness_get" ? { component: name.replace("craft-", "") } : {};
    const timeoutMs = name === "craft-context" ? 60_000 : 5_000;
    const initialized = await request("initialize", { protocolVersion: MCP_PREFERRED_PROTOCOL_VERSION }, timeoutMs);
    const listed = await request("tools/list", undefined, timeoutMs);
    const result = await request("tools/call", { name: callTool, arguments: callArguments }, timeoutMs);
    const tools = listed.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean }; inputSchema?: { properties?: Record<string, { type?: string }> } }>;
    assert.equal(initialized.result.serverInfo.version, "0.12.44");
    assert(tools.length > 0);
    assert(tools.some((tool) => tool.name === expectedDailyTool));
    assert(tools.some((tool) => tool.name === callTool));
    if (name === "craft-context") {
      for (const required of ["craft_scope_identity_resolve_project", "craft_knowledge_scenario_list", "craft_memory_capture_observed_fact",
        "craft_experience_scenario_list", "craft_procedure_plan", "craft_codebase_impact_query"]) {
        assert(tools.some(tool => tool.name === required), `complete Context product is missing ${required}`);
      }
      const discover = async (intent: string) => {
        const response = await request("tools/call", { name: "craft_context_tools_discover", arguments: { intent } }, timeoutMs);
        assert.equal(response.error, undefined, `Context ${intent} discovery failed: ${JSON.stringify(response.error)}`);
        assert.equal(response.result?.isError, false, `Context ${intent} discovery failed: ${JSON.stringify(response.result)}`);
        return response.result.structuredContent as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>; schema_estimated_tokens: number };
      };
      const core = await discover("code"), analysis = await discover("code-analysis");
      const names = (profile: typeof core) => profile.tools.filter((tool) => tool.name.startsWith("craft_codebase_")).map((tool) => tool.name).sort();
      assert.deepEqual(names(core), ["craft_codebase_callers_find", "craft_codebase_context_slice", "craft_codebase_impact_query",
        "craft_codebase_relations_find", "craft_codebase_symbol_explore", "craft_codebase_symbol_find", "craft_codebase_symbol_read",
        "craft_codebase_symbols_overview"].sort());
      assert.deepEqual(names(analysis), [...names(core), "craft_codebase_control_flow_query", "craft_codebase_data_flow_query",
        "craft_codebase_definition_find", "craft_codebase_diagnostics_find"].sort());
      assert(core.tools.filter((tool) => tool.name.startsWith("craft_codebase_")).every((tool) => tool.annotations?.readOnlyHint === true));
      assert(core.schema_estimated_tokens < analysis.schema_estimated_tokens, "core Codebase profile should use fewer estimated schema tokens");
    }
    if (name === "craft-codebase" || name === "craft-context") {
      const impactTool = tools.find((tool) => tool.name === "craft_codebase_impact_query");
      assert(impactTool, `${name}: missing bounded Codebase impact tool`);
      assert.equal(impactTool.inputSchema?.properties?.direction?.type, "string", `${name}: impact direction is not exposed to Hosts`);
    }
    assert.equal(result.error, undefined, `${name}: ${JSON.stringify(result.error)}`);
    assert.equal(result.result?.isError, false, `${name}: ${JSON.stringify(result.result)}`);
    if (name === "craft-codebase") {
      const ensured = result.result.structuredContent;
      assert.equal(ensured.status, "ready");
      assert.equal(ensured.summary.analyzer, "multi-language-static");
      const languages = (ensured.summary.diagnostics[0].languages as Array<{ analyzer: string }>).map(language => language.analyzer);
      assert(languages.includes("typescript-checker"), "packaged Codebase MCP must run its TypeScript analyzer");
      assert(languages.includes("python-ast-static"), "packaged Codebase MCP must run its Python analyzer");
      assert(languages.includes("jdk-compiler-tree"), "packaged Codebase MCP must run its Java analyzer");
      assert(languages.includes("lsp-go"), "packaged Codebase MCP must run an explicitly trusted Go LSP adapter");
    }
    if (name === "craft-context") {
      const opened = result.result.structuredContent;
      assert.equal(opened.context_status, "resolved");
      assert.equal(opened.codebase?.status, "ready", JSON.stringify(opened.codebase));
      assert(opened.codebase?.index_id);
      assert(opened.codebase?.checkpoint_id);
      await rm(join(data, "config", "codebase-lsp.json"), { force: true });
      const largeOpen = await request("tools/call", { name: "craft_context_open", arguments: {
        project_root: root, query: "Verify packaged Codebase context on the real multi-language repository", index_depth: "semantic", max_items: 1, max_chars: 1_000,
      } }, timeoutMs);
      assert.equal(largeOpen.error, undefined, `craft-context real-repository open failed: ${JSON.stringify(largeOpen.error)}`);
      assert.equal(largeOpen.result?.isError, false, `craft-context real-repository open failed: ${JSON.stringify(largeOpen.result)}`);
      const largeCodebase = largeOpen.result.structuredContent.codebase;
      assert.equal(largeCodebase.status, "ready", JSON.stringify(largeCodebase));
      assert.equal(largeCodebase.summary.analyzer, "multi-language-static");
      assert(Number(largeCodebase.summary.supported_file_count) >= 700,
        `packaged Context must index the real repository beyond legacy graph budgets: ${JSON.stringify(largeCodebase.summary)}`);
      assert(largeCodebase.checkpoint_id && largeCodebase.index_id, "large Context index must remain checkpoint-bound");
      assert.equal(Object.hasOwn(largeCodebase, "source"), false, "large Context must not return source bodies");
      const expectedWorkerCalls = new Set(["craft_evaluation_model_ticket_list", "craft_experience_learning_evaluation_dispatch_list", "craft_knowledge_source_list"]);
      let observed = new Set<string>();
      for (let attempt = 0; attempt < 100 && observed.size < expectedWorkerCalls.size; attempt++) {
        const store = await new CraftStore(craftPaths(data)).open();
        try { observed = new Set(store.list("trace_event", 10_000, event => expectedWorkerCalls.has(String(event.operation_id))).map(event => String(event.operation_id))); }
        finally { store.close(); }
        if (observed.size < expectedWorkerCalls.size) await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
      }
      assert.deepEqual(observed, expectedWorkerCalls, "packaged Context MCP must run and trace both automatic learning polls");
    }
    if (name === "craft-codebase" || name === "craft-context") {
      const body = result.result.structuredContent;
      const codebase = name === "craft-context" ? body.codebase : body;
      const languages = codebase.summary.diagnostics[0].languages as Array<{ analyzer: string; diagnostics: Record<string, unknown> }>;
      const go = languages.find(language => language.analyzer === "lsp-go")?.diagnostics;
      assert(go, `${name}: packaged Go relation diagnostics are missing`);
      assert.equal(Number(go.relation_candidate_symbol_count) >= 2, true);
      assert.equal(Number(go.relation_query_omitted_count) + Number(go.relation_response_omitted_count)
        + Number(go.relation_collection_omitted_count), go.relation_omitted_count);
    }
    if (name === "craft-codebase" || name === "craft-context") {
      for (const toolName of ["craft_codebase_symbol_explore", "craft_codebase_symbol_read", "craft_codebase_relations_find", "craft_codebase_impact_query", "craft_codebase_control_flow_query"]) {
        const tool = tools.find((candidate) => candidate.name === toolName);
        assert(tool, `${name}: missing ${toolName}`);
        assert.equal(tool.annotations?.readOnlyHint, true, `${name}: ${toolName} must be read-only for Hosts`);
      }
      const ensured = result.result.structuredContent;
      const codebase = name === "craft-context" ? ensured.codebase : ensured;
      const identity = { workspace_id: codebase.workspace_id, index_id: codebase.index_id };
      assert(identity.workspace_id && identity.index_id && codebase.checkpoint_id, `${name}: missing checkpoint-pinned index identity`);
      const explore = await request("tools/call", { name: "craft_codebase_symbol_explore", arguments: { ...identity, query: "caller", relation_kinds: ["calls"], direction: "both" } }, timeoutMs);
      assert.equal(explore.error, undefined, `${name}: ${JSON.stringify(explore.error)}`);
      const payload = explore.result.structuredContent;
      assert(payload, `${name}: missing structured explore payload: ${JSON.stringify(explore)}`);
      const candidates = payload.candidates as Array<{ symbol: { id: string; name: string; source_digest: string }; relations: Array<{ edge: { kind: string }; from: { name: string }; to: { name: string } }> }>;
      assert(Array.isArray(candidates), `${name}: malformed explore payload: ${JSON.stringify(explore)}`);
      const caller = candidates.find((candidate) => candidate.symbol.name === "caller");
      assert(caller, `${name}: symbol exploration did not return caller`);
      assert.equal(explore.result.structuredContent.candidate_only, true);
      assert.equal(explore.result.structuredContent.content_included, false);
      const read = await request("tools/call", { name: "craft_codebase_symbol_read", arguments: { ...identity, node_id: caller.symbol.id } }, timeoutMs);
      assert.equal(read.error, undefined, `${name}: ${JSON.stringify(read.error)}`);
      const source = read.result.structuredContent;
      assert.equal(source.path, "main.py");
      assert.match(source.source, /def caller\(\):/u);
      assert.equal(source.source_digest, caller.symbol.source_digest);
      assert.equal(source.receipt.index_id, identity.index_id);
      assert.equal(source.index.checkpoint_id, codebase.checkpoint_id);
      const flowExplore = await request("tools/call", { name: "craft_codebase_symbol_explore", arguments: { ...identity, query: "flow_target" } }, timeoutMs);
      const flowCandidates = flowExplore.result.structuredContent.candidates as Array<{ symbol: { id: string; name: string } }>;
      const flowSymbol = flowCandidates.find(candidate => candidate.symbol.name === "flow_target");
      assert(flowSymbol, `${name}: Python flow symbol was not indexed by the packaged analyzer`);
      const flow = await request("tools/call", { name: "craft_codebase_control_flow_query", arguments: { ...identity, node_id: flowSymbol.symbol.id } }, timeoutMs);
      assert.equal(flow.error, undefined, `${name}: packaged Python control-flow query failed: ${JSON.stringify(flow.error)}`);
      const flowResult = flow.result.structuredContent;
      assert.equal(flowResult.status, "complete", `${name}: simple Python CFG should be complete`);
      assert.equal(flowResult.source_content_included, false, `${name}: CFG must not return source text`);
      assert((flowResult.edges as Array<{ loop_back?: boolean }>).some(edge => edge.loop_back === true), `${name}: Python CFG must retain the loop back edge`);
      const valueResult = await request("tools/call", { name: "craft_codebase_symbol_explore", arguments: { ...identity, query: "value", relation_kinds: ["calls"], direction: "both" } }, timeoutMs);
      assert.equal(valueResult.error, undefined, `${name}: ${JSON.stringify(valueResult.error)}`);
      const value = valueResult.result.structuredContent.candidates.find((candidate: { symbol: { name: string } }) => candidate.symbol.name === "value");
      assert(value, `${name}: symbol exploration did not return value`);
      const relations = await request("tools/call", { name: "craft_codebase_relations_find", arguments: {
        ...identity, node_id: value.symbol.id, relation_kind: "calls", direction: "incoming", limit: 10,
      } }, timeoutMs);
      assert.equal(relations.error, undefined, `${name}: ${JSON.stringify(relations.error)}`);
      const relationGraph = relations.result.structuredContent;
      assert.equal(relationGraph.candidate_only, true);
      assert.equal(Object.hasOwn(relationGraph, "source"), false);
      assert.equal(relationGraph.receipt.index_id, identity.index_id);
      assert.equal(relationGraph.index.checkpoint_id, codebase.checkpoint_id);
      assert(relationGraph.relations.some((relation: { from: { name: string }; to: { name: string }; edge: { kind: string } }) =>
        relation.from.name === "caller" && relation.to.name === "value" && relation.edge.kind === "calls"));
      const impact = await request("tools/call", { name: "craft_codebase_impact_query", arguments: { ...identity, node_id: value.symbol.id, direction: "incoming", relation_kind: "calls", max_depth: 1, limit: 10 } }, timeoutMs);
      assert.equal(impact.error, undefined, `${name}: ${JSON.stringify(impact.error)}`);
      const graph = impact.result.structuredContent;
      assert.equal(graph.candidate_only, true);
      assert.equal(graph.truncated, false);
      assert.equal(graph.receipt.index_id, identity.index_id);
      assert(graph.nodes.some((node: { name: string }) => node.name === "caller"));
      assert.equal(graph.index.checkpoint_id, codebase.checkpoint_id);
    }
    if (name === "craft-codebase" || name === "craft-context") {
      const opened = result.result.structuredContent;
      const codebase = name === "craft-context" ? opened.codebase : opened;
      const identity = { workspace_id: codebase.workspace_id, index_id: codebase.index_id };
      for (const [query, expectedPath, expectedName, expectedTarget] of [
        ["typescriptAgentEntry", "src/agent.ts", "typescriptAgentEntry", "typescriptAgentTarget"],
        ["javaAgentEntry", "src/JavaAgentFixture.java", "javaAgentEntry", "javaAgentTarget"],
        ["goAgentEntry", "src/agent.go", "goAgentEntry", "goAgentTarget"],
      ]) {
        const response = await request("tools/call", { name: "craft_codebase_symbol_explore", arguments: {
          ...identity, query, relation_kinds: ["calls"], direction: "outgoing",
        } }, timeoutMs);
        assert.equal(response.error, undefined, `${name} ${query}: ${JSON.stringify(response.error)}`);
        const payload = response.result.structuredContent;
        const entry = (payload.candidates as Array<{ symbol: { name: string; path: string }; relations: Array<{ to: { name: string }; edge: { kind: string } }> }>)
          .find(candidate => candidate.symbol.name === expectedName && candidate.symbol.path === expectedPath);
        assert(entry, `${name}: failed to retrieve ${expectedName} from ${expectedPath}`);
        assert(entry.relations.some(relation => relation.edge.kind === "calls" && relation.to.name === expectedTarget),
          `${name}: packaged relation graph omitted ${expectedName} -> ${expectedTarget}; candidate=${JSON.stringify(entry)}; summary=${JSON.stringify(codebase.summary)}`);
        assert.equal(payload.candidate_only, true);
        assert.equal(payload.content_included, false);
      }
      const javaEntryResponse = await request("tools/call", { name: "craft_codebase_symbol_explore", arguments: {
        ...identity, query: "javaAgentEntry", relation_kinds: ["calls"], direction: "outgoing",
      } }, timeoutMs);
      const javaEntrySymbol = (javaEntryResponse.result.structuredContent.candidates as Array<{ symbol: { id: string; name: string; path: string; source_digest: string } }>)
        .find(candidate => candidate.symbol.name === "javaAgentEntry" && candidate.symbol.path === "src/JavaAgentFixture.java")?.symbol;
      assert(javaEntrySymbol, `${name}: packaged Java method was not indexed`);
      const javaFlow = await request("tools/call", { name: "craft_codebase_control_flow_query", arguments: { ...identity, node_id: javaEntrySymbol.id } }, timeoutMs);
      assert.equal(javaFlow.error, undefined, `${name}: packaged Java control-flow query failed: ${JSON.stringify(javaFlow.error)}`);
      const javaFlowResult = javaFlow.result.structuredContent;
      assert.equal(javaFlowResult.source_content_included, false, `${name}: Java CFG must not return source text`);
      assert((javaFlowResult.blocks as Array<{ kind: string }>).some(block => block.kind === "condition"), `${name}: Java CFG must expose its branch`);
      assert((javaFlowResult.edges as Array<{ loop_back?: boolean }>).some(edge => edge.loop_back === true), `${name}: Java CFG must expose its loop back edge`);
      assert.equal(javaFlowResult.source_digest, javaEntrySymbol.source_digest);
    }
    assert(!tools.some((tool) => tool.name === "craft_verified_work_loop_prepare"));
    if (name === "craft-experience") assert(!tools.some((tool) => /^craft_workflow_(?:evolution|dag)_/u.test(tool.name)));
  } finally {
    if (child.exitCode === null) {
      const childExit = once(child, "exit");
      child.stdin.end();
      try { await withTimeout(childExit, 5_000, `${name}:shutdown`); }
      catch {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await childExit;
      }
    }
    await rm(data, { recursive: true, force: true });
  }
}

for (const component of components) await smoke(component);
process.stdout.write("The complete Context plugin completed initialize/tools-list/tools-call smoke tests for all three cognitive capabilities and Codebase.\n");
