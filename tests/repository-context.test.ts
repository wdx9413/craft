import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";
import { repositoryRoot, repositoryFiles } from "../capability/craft-codebase/repository-files.ts";
import { basicAnalysis } from "../capability/craft-codebase/basic-analysis.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-repository-context-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  const paths = craftPaths(join(root, "data")); const store = await new CraftStore(paths).open();
  const service = new CraftService(store);
  const write = (path: string, content: string) => writeFileSync(join(repo, path), content);
  return { root, repo, store, service, write, git, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const result = async (server: McpServer, name: string, args: JsonObject) => {
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any;
  assert(!response.error, JSON.stringify(response)); assert(!response.result.isError, JSON.stringify(response));
  return response.result.structuredContent as JsonObject;
};

test("repository auto onboarding reuses across clients, incrementally parses, deletes, opts out and isolates worktrees", async () => {
  const f = await fixture();
  try {
    f.write("a.ts", "export function alpha() { return 1; }"); f.write("b.py", "def beta():\n    return 2\n");
    mkdirSync(join(f.repo, "src"));
    const first = f.service.codebaseRepositoryEnsure({ project_root: join(f.repo, "src") });
    assert.equal(first.status, "ready"); assert.equal(first.reused, false);
    const again = f.service.codebaseRepositoryEnsure({ project_root: f.repo }); assert.equal(again.index_id, first.index_id); assert.equal(again.reused, true);
    const anotherHost = new CraftService(f.store);
    assert.equal(anotherHost.codebaseRepositoryEnsure({ project_root: f.repo }).index_id, first.index_id);
    f.write("a.ts", "export function gamma() { return 3; }");
    const changed = f.service.codebaseRepositoryEnsure({ project_root: f.repo }); assert.notEqual(changed.index_id, first.index_id);
    assert.equal(((changed.summary as JsonObject).diagnostics as JsonObject[])[0]!.reused_files, 1); assert.equal(((changed.summary as JsonObject).diagnostics as JsonObject[])[0]!.analyzed_files, 1);
    const matches = f.service.codebaseSymbolFind({ workspace_id: changed.workspace_id, index_id: changed.index_id, query: "gamma" }); assert.equal((matches.symbols as unknown[]).length, 1);
    assert.throws(() => f.service.codebaseSymbolFind({ workspace_id: first.workspace_id, index_id: first.index_id, query: "alpha" }), /stale/);
    const semantic = f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }); assert.equal(semantic.status, "ready");
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "semantic" }).reused, true);
    f.git("add", "."); f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
    const worktree = join(f.root, "worktree"); f.git("worktree", "add", "--detach", worktree);
    assert.notEqual(f.service.codebaseRepositoryEnsure({ project_root: worktree }).workspace_id, first.workspace_id);
    f.service.codebaseDeactivate({ workspace_id: first.workspace_id }); assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo }).status, "disabled");
    f.service.codebaseActivate({ workspace_id: first.workspace_id, actor: "repository-auto" });
    rmSync(join(f.repo, "a.ts")); rmSync(join(f.repo, "b.py"));
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo }).status, "empty");
    assert.throws(() => f.service.codebaseRepositoryEnsure({ project_root: f.repo, index_depth: "wrong" }), /index_depth/);
  } finally { f.close(); }
});

test("source discovery honors ignores, excludes, disabled and bounded reads without traversing links", async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo }).status, "empty");
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.root }).status, "skipped");
    assert.throws(() => repositoryRoot(null), /project_root/);
    f.write("a.ts", "export const item = 1"); assert.throws(() => repositoryRoot(join(f.repo, "a.ts")), /directory/);
    f.write(".gitignore", "ignored.ts\n"); f.write("ignored.ts", "secret"); f.write("exclude.py", "def hidden(): pass");
    mkdirSync(join(f.repo, "dist")); f.write("dist/a.ts", "build output");
    symlinkSync(join(f.repo, "a.ts"), join(f.repo, "link.ts"));
    f.write("null.ts", "\0"); f.write("huge.ts", "x".repeat(512 * 1024 + 1));
    f.write(".craft-codebase.json", JSON.stringify({ exclude_paths: ["exclude.py", "other/"] }));
    const files = repositoryFiles(f.repo); assert.deepEqual(files.files.map(file => file.path), ["a.ts"]); assert.equal(files.omitted, 3);
    for (const config of ["null", "[]", '{"enabled":1}', '{"exclude_paths":"a"}', '{"exclude_paths":["../outside"]}', '{"exclude_paths":["/root"]}', '{"exclude_paths":["a\\\\b"]}', '{"exclude_paths":[""]}']) {
      f.write(".craft-codebase.json", config); assert.throws(() => repositoryFiles(f.repo));
    }
    rmSync(join(f.repo, ".craft-codebase.json")); symlinkSync(join(f.repo, "a.ts"), join(f.repo, ".craft-codebase.json")); assert.throws(() => repositoryFiles(f.repo), /regular file/); rmSync(join(f.repo, ".craft-codebase.json"));
    f.write(".craft-codebase.json", '{"enabled":false}'); assert.equal(f.service.codebaseRepositoryEnsure({ project_root: f.repo }).status, "disabled");
    f.write(".craft-codebase.json", '{}'); const before = process.env.CRAFT_CODEBASE_AUTO_INDEX;
    try { process.env.CRAFT_CODEBASE_AUTO_INDEX = "0"; assert.equal(repositoryFiles(f.repo).state, "disabled"); } finally { if (before === undefined) delete process.env.CRAFT_CODEBASE_AUTO_INDEX; else process.env.CRAFT_CODEBASE_AUTO_INDEX = before; }
    for (let i = 0; i < 510; i++) f.write(`file${i}.ts`, "export const a=1;");
    assert.equal(repositoryFiles(f.repo).files.length, 500);
  } finally { f.close(); }
});

test("aggregate MCP resolves bounded scope and code references while standalone surfaces remain isolated", async () => {
  const f = await fixture();
  try {
    f.write("a.ts", "export function alpha() { return 1; }");
    const server = new McpServer(f.service, "component-context-daily");
    const pack = await result(server, "craft_context_open", { project_root: f.repo, query: "alpha" });
    assert.equal(pack.host_execution_authority, false); assert.equal((pack.codebase as JsonObject).status, "ready");
    assert.equal(((pack.codebase as JsonObject).references as unknown[]).length, 1);
    assert.deepEqual((pack.receipt as JsonObject).members, ["experience", "knowledge", "memory"]);
    const tiny = await result(server, "craft_context_open", { project_root: f.repo, query: "alpha", max_chars: 1 });
    assert.equal((tiny.pack_receipt as JsonObject).total_used_chars, 0);
    const standalone = new McpServer(f.service, "component-codebase");
    assert.equal((await result(standalone, "craft_codebase_repository_ensure", { project_root: f.repo })).reused, true);
    assert(!standalone.tools.some(tool => tool.name === "craft_context_open"));
    assert(!new McpServer(f.service, "component-memory-daily").tools.some(tool => tool.name === "craft_codebase_repository_ensure"));
    f.write(".craft-codebase.json", "invalid");
    const degraded = await f.service.contextOpen({ project_root: f.repo, query: "alpha" }); assert.equal((degraded.codebase as JsonObject).status, "unavailable"); assert(degraded.receipt);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "" }), /query/);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "a", index_depth: "invalid" }), /index_depth/);
    await f.service.contextOpen({ project_root: f.repo, query: "a", index_depth: "basic" });
    for (const budget of [0, 1.5]) await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "alpha", max_chars: budget }), /budget/);
    await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "alpha", max_items: 0 }), /budget/);
  } finally { f.close(); }
});

test("basic symbols cap declarations and retain only digest-linked structural facts", async () => {
  const f = await fixture();
  try {
    const files = [{ path: "a.ts", digest: "fixture", language: "ts", content: Array.from({ length: 22 }, (_, i) => `const a${i}=1;`).join("\n") }];
    const first = basicAnalysis(f.store, "demo", files); assert.equal((first.nodes as unknown[]).length, 16);
    assert.equal((first.diagnostics as JsonObject[])[0]!.omitted_symbols, 7);
    assert.equal((basicAnalysis(f.store, "demo", files).diagnostics as JsonObject[])[0]!.reused_files, 1);
    assert(!JSON.stringify(f.store.list("codebase_file_analysis")).includes("const a0"));
    const huge = Array.from({ length: 500 }, (_, i) => ({ path: `nested/${"p".repeat(200)}/file${i}.ts`, digest: String(i), language: "ts", content: Array.from({ length: 16 }, (_, n) => `const ${"a".repeat(180)}${n}=1;`).join("\n") + `const ${"b".repeat(201)}=1;` }));
    const bounded = basicAnalysis(f.store, "large", huge); assert(JSON.stringify(bounded).length < 2_000_000); assert(Number((bounded.diagnostics as JsonObject[])[0]!.omitted_symbols) > 500);
  } finally { f.close(); }
});

test("aggregate deduplicates repeated facts and keeps contributor failures explicit; strict standalone resolution still fails", async () => {
  const f = await fixture();
  try {
    const { ContextResolutionKernel } = await import("../core/context-resolution.ts");
    const facts = { member: "knowledge" as const, contribute: async () => ({ member: "knowledge" as const, receipt_id: "fixture", omitted_count: 0,
      items: [{ claim_id: "one", content: "alpha testing" }, { claim_id: "two", content: "alpha testing" }] }) };
    const procedures = { member: "experience" as const, contribute: async () => ({ member: "experience" as const, receipt_id: "procedures", omitted_count: 0, items: [{ procedure_id: "one", content: "alpha", steps: ["a"] }, { procedure_id: "two", content: "alpha", steps: ["b"] }] }) };
    const procedureResult = await new ContextResolutionKernel(f.store, [procedures]).resolve({ query: "alpha", scope_kind: "project", scope_id: "demo", deduplicate: true }); assert.equal((procedureResult.receipt as JsonObject).total_items, 2);
    const broken = { member: "experience" as const, contribute: async () => { throw new Error("fixture private upstream message"); } };
    const resolver = new ContextResolutionKernel(f.store, [facts, broken]);
    const args = { query: "alpha", scope_kind: "project", scope_id: "demo" };
    await assert.rejects(resolver.resolve(args), /fixture private/);
    const partial = await resolver.resolve({ ...args, allow_partial: true, deduplicate: true });
    const receipt = partial.receipt as JsonObject; assert.equal(receipt.partial, true); assert.equal(receipt.total_items, 1); assert.equal(receipt.deduplicated_count, 1);
    assert(!JSON.stringify(partial).includes("private upstream"));
    f.write("a.ts", "export function alpha() {}\nexport function beta() {}");
    const pack = await f.service.contextOpen({ project_root: f.repo, query: "review alpha beta alpha", max_items: 1, members: ["knowledge"] });
    assert.equal(((pack.codebase as JsonObject).references as JsonObject[]).length, 1);
    await f.service.contextOpen({ project_root: f.repo, query: "代码审查" });
    f.service.knowledgeMemoryInstallBuiltins();
    const scope = ((f.service.scopeIdentityResolveProject({ project_root: f.repo }).identity as JsonObject).canonical_scope as JsonObject);
    f.store.create("knowledge_claim", "fact", { status: "reviewed", source_id: "builtin.evidence-wiki", scope: `${scope.kind}:${scope.id}`, content: "alpha", evidence_ids: [] });
    const onlyFact = await f.service.contextOpen({ project_root: f.repo, query: "alpha", max_items: 1 });
    assert.equal((onlyFact.pack_receipt as JsonObject).total_items, 1); assert.equal(((onlyFact.codebase as JsonObject).references as unknown[]).length, 0);
  } finally { f.close(); }
});
