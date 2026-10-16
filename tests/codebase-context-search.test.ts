import assert from "node:assert/strict";
import test from "node:test";
import { codeContextCandidates, codeQueryTerms, rankCodeSymbols } from "../capability/craft-codebase/context-search.ts";
import { lspDeclarationKind } from "../capability/craft-codebase/symbol-kind.ts";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";

const symbol = (id: string, name: string, path: string): JsonObject => ({ id, kind: "symbol", name, path, language: "typescript" });

test("Codebase BM25 ranks exact names and camelCase natural-language matches deterministically", () => {
  const nodes = [
    symbol("a", "sessionStore", "src/common/session.ts"),
    symbol("b", "storeSession", "src/features/auth.ts"),
    symbol("c", "session", "src/session.ts"),
    symbol("d", "unrelated", "src/cache.ts"),
  ];
  const exact = rankCodeSymbols(nodes, "session", 4);
  assert.equal(exact[0]!.node.id, "c");
  const natural = rankCodeSymbols(nodes, "session store", 4);
  assert(natural.some(item => item.node.id === "a"));
  assert.deepEqual(natural.map(item => item.node.id), rankCodeSymbols(nodes, "session store", 4).map(item => item.node.id));
  assert.equal(rankCodeSymbols(nodes, "", 4).length, 0);
  assert.throws(() => rankCodeSymbols(nodes, "session", 0), /positive integer/u);
});

test("Codebase favors a matching architecture type for object queries while action queries keep functions ahead", () => {
  const scheduler = [
    { ...symbol("type", "ConversationScheduler", "scheduler/conversation_scheduler.py"), declaration_kind: "class" },
    { ...symbol("action", "start_multiple_conversations", "scheduler/conversation_scheduler.py"), declaration_kind: "function" },
  ];
  assert.equal(rankCodeSymbols(scheduler, "conversation scheduler for multi-turn simulation", 2)[0]!.node.id, "type");
  assert.equal(rankCodeSymbols(scheduler, "start multiple conversations", 2)[0]!.node.id, "action");
  assert.equal(rankCodeSymbols([
    { ...symbol("manager", "UserManager", "src/user-manager.ts"), declaration_kind: "class" },
    { ...symbol("method", "refreshSession", "src/user-manager.ts"), declaration_kind: "method" },
    { ...symbol("unnamed-method", "", "src/user-manager.ts"), declaration_kind: "method", name: null },
  ], "UserManager cache lifecycle", 2)[0]!.node.id, "manager");
  assert.equal(rankCodeSymbols([
    { ...symbol("manager", "UserManager", "src/user-manager.ts"), declaration_kind: "class" },
    { ...symbol("method", "refreshSession", "src/user-manager.ts"), declaration_kind: "method" },
    { ...symbol("unnamed-method", "", "src/user-manager.ts"), declaration_kind: "method", name: null },
  ], "UserManager refreshSession", 2)[0]!.node.id, "method");
  assert.equal(rankCodeSymbols([
    { ...symbol("unrelated-type", "ConversationViewer", "ui/ConversationViewer.jsx"), declaration_kind: "class" },
    { ...symbol("target", "normalizeRow", "ui/ConversationViewer.jsx"), declaration_kind: "function" },
  ], "normalize a row for the conversation viewer", 2)[0]!.node.id, "target");
});

test("Codebase query normalization expands identifiers and common task-language variants", () => {
  const terms = codeQueryTerms("TypeScript semantic checker analyzer");
  assert(terms.includes("typescript") && terms.includes("type") && terms.includes("script"));
  assert(terms.includes("check") && terms.includes("analyze"));
  assert(codeQueryTerms("delegate authentication checker constructor").includes("new"));
  assert(codeQueryTerms("LSP relation collector").includes("collect"));
  assert(codeQueryTerms("resolve definition by source offset").includes("find"));
  const chineseTask = codeQueryTerms("Python 仓库增量重建怎么规划");
  for (const term of ["repository", "workspace", "incremental", "rebuild", "build", "plan"]) assert(chineseTask.includes(term));
  assert(codeQueryTerms("LSP 关系收集器").includes("collect"));
  assert(codeQueryTerms("查找仓库代码上下文候选").includes("candidate"));
  const conversationTask = codeQueryTerms("如何启动多组并发对话");
  for (const term of ["start", "multiple", "concurrent", "conversation"]) assert(conversationTask.includes(term));
  const simulationTask = codeQueryTerms("启动仿真任务的 HTTP 接口");
  for (const term of ["start", "simulation", "task", "http", "endpoint"]) assert(simulationTask.includes(term));
  assert.equal(rankCodeSymbols([
    { ...symbol("conversation", "start_multiple_conversations", "scheduler/conversation_scheduler.py"), declaration_kind: "method" },
    { ...symbol("distractor", "can_handle", "scheduler/tool_operation_processor.py"), declaration_kind: "method" },
  ], "如何启动多组并发对话", 1)[0]!.node.id, "conversation");
  assert.equal(rankCodeSymbols([
    { ...symbol("simulation", "start_simulation", "service/http_server.py"), declaration_kind: "function" },
    { ...symbol("distractor", "handle_data", "service/data.py"), declaration_kind: "function" },
  ], "启动仿真任务的 HTTP 接口", 1)[0]!.node.id, "simulation");
  const ranked = rankCodeSymbols([
    { ...symbol("target", "analyzeTypeScript", "capability/craft-codebase/typescript-analysis.ts"), declaration_kind: "function" },
    { ...symbol("distractor", "checker", "core/receipt.ts"), declaration_kind: "variable" },
  ], "TypeScript semantic checker analyzer", 2);
  assert.equal(ranked[0]!.node.id, "target");
  const analyzer = rankCodeSymbols([
    { ...symbol("function", "analyzeTypeScript", "src/typescript-analysis.ts"), declaration_kind: "function" },
    { ...symbol("constant", "TYPESCRIPT_ANALYZER_VERSION", "src/typescript-analysis.ts"), declaration_kind: "variable" },
  ], "analyzer", 2);
  assert.equal(analyzer[0]!.node.id, "function");
});

test("Codebase retrieval gives symbol names and paths priority over generic analyzer aliases", () => {
  const nodes = [
    { ...symbol("target", "planPythonIncremental", "capability/craft-codebase/python-incremental.ts"), declaration_kind: "function" },
    ...Array.from({ length: 30 }, (_, index) => symbol(`generic-${index}`, "planWorkspace", `scripts/maintenance-${index}.ts`)),
    symbol("analyzer", "analyzeTypeScript", "capability/craft-codebase/typescript-analysis.ts"),
  ];
  assert.equal(rankCodeSymbols(nodes, "Python 仓库增量重建怎么规划", 1)[0]!.node.id, "target");
  assert.equal(rankCodeSymbols(nodes, "TypeScript semantic checker analyzer", 1)[0]!.node.id, "analyzer");
  assert.equal(rankCodeSymbols([
    { ...symbol("constructor", "NewDelegateAuthChecker", "middleware/authchecker/delegate_auth_checker.go"), declaration_kind: "function" },
    { ...symbol("method", "(*DelegateAuthChecker).Check", "middleware/authchecker/delegate_auth_checker.go"), declaration_kind: "method" },
  ], "delegate authentication checker constructor", 1)[0]!.node.id, "constructor");
});

test("Codebase ranks explicitly named methods and constructors ahead of related containers", () => {
  const java = [
    { ...symbol("class", "DataWorkflowServiceImpl", "src/DataWorkflowServiceImpl.java"), declaration_kind: "class" },
    { ...symbol("method", "dataDetail", "src/DataWorkflowServiceImpl.java"), declaration_kind: "method" },
    { ...symbol("interface", "DataWorkflowService", "src/DataWorkflowService.java"), declaration_kind: "interface" },
  ];
  assert.equal(rankCodeSymbols(java, "DataWorkflowServiceImpl dataDetail workflow detail lookup by key and version", 3)[0]!.node.id, "method");
  assert.equal(rankCodeSymbols(java, "DataWorkflowServiceImpl dataDetail 工作流详情按 key 和版本查询", 3)[0]!.node.id, "method");
  assert.equal(rankCodeSymbols(java, "DataWorkflowServiceImpl", 3)[0]!.node.id, "class");

  const workspace = [
    { ...symbol("handler", "createWorkspaceHandlers", "core/application/actions/workspace-handlers.ts"), declaration_kind: "function" },
    { ...symbol("wrapper", "workspaceCheckpoint", "core/application/craft-service.ts"), declaration_kind: "method" },
    { ...symbol("target", "checkpoint", "core/workspace.ts"), declaration_kind: "method" },
  ];
  assert.equal(rankCodeSymbols(workspace, "workspace create immutable checkpoint", 3)[0]!.node.id, "target");

  const analyzer = [
    { ...symbol("generic", "analyze", "capability/craft-codebase/analyzers/analyze-python.py"), declaration_kind: "function" },
    { ...symbol("target", "analyzePythonCheckpoint", "capability/craft-codebase/python-analysis.ts"), declaration_kind: "function" },
  ];
  assert.equal(rankCodeSymbols(analyzer, "Python analyzer analyze checkpoint", 2)[0]!.node.id, "target");

  const modulePath = [
    { ...symbol("generic", "path", "capability/craft-knowledge/local-candidate-import.ts"), declaration_kind: "function" },
    { ...symbol("target", "_module_path", "capability/craft-codebase/analyzers/analyze-python.py"), declaration_kind: "function" },
  ];
  assert.equal(rankCodeSymbols(modulePath, "Python import module path resolution", 2)[0]!.node.id, "target");

  const go = [
    { ...symbol("method", "(*DelegateAuthChecker).Check", "middleware/authchecker/delegate_auth_checker.go"), declaration_kind: "method" },
    { ...symbol("constructor", "NewDelegateAuthChecker", "middleware/authchecker/delegate_auth_checker.go"), declaration_kind: "function" },
    { ...symbol("distractor", "NewDelegateFileChecker", "logic/taskcenterlogic/filechecker/delegate_file_checker.go"), declaration_kind: "function" },
  ];
  assert.equal(rankCodeSymbols(go, "delegate authentication checker constructor", 3)[0]!.node.id, "constructor");
});

test("task verb matches disambiguate JavaScript functions from broader path and agent terms", () => {
  const normalize = [
    { ...symbol("group", "groupConversations", "eval_platform_frontend/src/pages/ConversationViewer.jsx"), declaration_kind: "function" },
    symbol("state", "[conversations, setConversations]", "eval_platform_frontend/src/pages/ConversationViewer.jsx"),
    { ...symbol("target", "normalizeRow", "eval_platform_frontend/src/pages/ConversationViewer.jsx"), declaration_kind: "function" },
    { ...symbol("component", "ConversationViewer", "eval_platform_frontend/src/pages/ConversationViewer.jsx"), declaration_kind: "function" },
  ];
  assert.equal(rankCodeSymbols(normalize, "normalize a row for the conversation viewer", 4)[0]!.node.id, "target");

  const dialogue = [
    { ...symbol("user-agent", "StandardUserAgent", "scheduler/user_agent.py"), declaration_kind: "class" },
    { ...symbol("parser", "_parse_user_agent_llm_json", "scheduler/user_agent.py"), declaration_kind: "function" },
    { ...symbol("target", "buildSimulatedDialogue", "eval_platform_frontend/src/pages/ConversationViewer.jsx"), declaration_kind: "function" },
  ];
  const terms = codeQueryTerms("combine user and agent turns into simulated dialogue");
  assert(terms.includes("build") && terms.includes("simulation") && terms.includes("conversation"));
  assert.equal(rankCodeSymbols(dialogue, "combine user and agent turns into simulated dialogue", 3)[0]!.node.id, "target");
});

test("task retrieval favors core business terms over generic test and API names, with bilingual plural matching", () => {
  const conversations = [
    { ...symbol("target", "start_multiple_conversations", "scheduler/conversation_scheduler.py"), declaration_kind: "function" },
    { ...symbol("test-a", "test_run_conversation_calls_start_and_end", "tests/test_conversation_scheduler.py"), declaration_kind: "function" },
    { ...symbol("test-b", "test_start_conversation_stores_chat_session_id", "tests/test_gui_h5_channel_adapter.py"), declaration_kind: "function" },
  ];
  assert.equal(rankCodeSymbols(conversations, "如何启动多组并发对话", 3)[0]!.node.id, "target");
  const simulation = [
    { ...symbol("target", "start_simulation", "service/http_server.py"), declaration_kind: "function" },
    { ...symbol("get-api", "api_get_simulation_task", "service/eval_platform_server.py"), declaration_kind: "function" },
    { ...symbol("api", "api_start_sql_task", "service/sql_task_server.py"), declaration_kind: "function" },
    { ...symbol("test", "test_start_simulation_task_api", "tests/test_simulation_api.py"), declaration_kind: "function" },
  ];
  assert.equal(rankCodeSymbols(simulation, "启动仿真任务的 HTTP 接口", 4)[0]!.node.id, "target");
  assert.equal(rankCodeSymbols(simulation, "test simulation API", 3)[0]!.node.id, "test");
  const execution = [
    { ...symbol("target", "run_task", "service/http_server.py"), declaration_kind: "function" },
    { ...symbol("distractor", "create_simulation_task", "service/eval_platform_core.py"), declaration_kind: "function" },
  ];
  assert.equal(rankCodeSymbols(execution, "execute a queued simulation task", 2)[0]!.node.id, "target");
});

test("Codebase symbol search preserves identifier fragments and context expansion adds graph neighbours", () => {
  const nodes = [
    symbol("caller", "buildRepositoryIndex", "src/build.ts"),
    symbol("target", "ensureRepository", "src/repository.ts"),
    symbol("other", "networkRequest", "src/network.ts"),
  ];
  const fragment = rankCodeSymbols(nodes, "ensureRepo", 5);
  assert.equal(fragment[0]!.node.id, "target");
  assert(rankCodeSymbols(nodes, "re", 5).some(item => item.node.id === "target"));
  const result = codeContextCandidates({ nodes, edges: [{ id: "e", kind: "calls", from_node_id: "caller", to_node_id: "target" }] }, "repository", 3);
  const selected = result.symbols as JsonObject[];
  assert(selected.some(item => item.id === "caller" || item.id === "target"));
  assert((result.repo_map as JsonObject).edges instanceof Array);
  assert.equal(result.candidate_only, true);
});

test("Codebase context retrieval handles file-only graphs and validates result bounds", () => {
  const files = [{ id: "f", kind: "file", name: "main", path: "main.py", language: "python" }];
  assert.deepEqual((codeContextCandidates({ nodes: files, edges: [] }, "missing", 1).symbols as unknown[]), []);
  assert.deepEqual((codeContextCandidates({ nodes: files }, "代码", 1).query_aliases as string[]), ["code", "codebase"]);
  const duplicateIds = [symbol("same", "session", "a.ts"), symbol("same", "target", "b.ts"), { name: "missing-id" }];
  assert.equal(rankCodeSymbols(duplicateIds, "session", 5).length, 1);
  const missingName = rankCodeSymbols([{ id: "missing-name", kind: "symbol", path: "src/session.ts", language: "typescript" }], "session", 1);
  assert.equal(missingName[0]!.node.id, "missing-name");
  assert.deepEqual(rankCodeSymbols([{ id: "missing-name", kind: "symbol", path: "src/session.ts", language: "typescript" }], "se", 1), []);
  const tied = rankCodeSymbols([symbol("z", "session", "same.ts"), symbol("a", "session", "same.ts")], "session", 2);
  assert.deepEqual(tied.map(item => item.node.id), ["a", "z"]);
  assert.equal(rankCodeSymbols([symbol("short", "x", "x.ts")], "x", 1)[0]!.node.id, "short");
  assert.throws(() => codeContextCandidates({ nodes: files, edges: [] }, "query", 0), /between 1 and 1000/u);
});

test("Codebase ranking tolerates partial adapter metadata and orders equal-score relations stably", () => {
  const partialNodes = [
    { name: "search", path: "missing-id.ts" },
    { id: "duplicate", name: "search", path: "first.ts" },
    { id: "duplicate", name: "search", path: "second.ts" },
    { id: "nameless", path: "search.ts", kind: "symbol" },
    { id: "pathless", name: "searchName", language: "ts" },
  ] as JsonObject[];
  const partial = rankCodeSymbols(partialNodes, "search", 10);
  assert(partial.some(item => item.node.id === "nameless"));
  assert(partial.some(item => item.node.id === "pathless"));
  assert.equal(partial.filter(item => item.node.id === "duplicate").length, 1);

  const nodes = [
    symbol("seed-low", "searchHelper", "src/seed-low.ts"),
    symbol("seed-high", "search", "src/seed-high.ts"),
    symbol("neighbor-b", "unmatchedB", "same.ts"),
    symbol("neighbor-a", "unmatchedA", "same.ts"),
  ];
  const edges = [
    { from_node_id: "seed-low", to_node_id: "neighbor-a" },
    { from_node_id: "seed-high", to_node_id: "neighbor-a" },
    { from_node_id: "seed-high", to_node_id: "neighbor-b" },
  ];
  const result = codeContextCandidates({ nodes, edges }, "search", 4);
  const selected = result.symbols as JsonObject[];
  assert(selected.some(item => item.id === "neighbor-a" && item.selection_reason === "dependency_neighbour"));
  assert(selected.some(item => item.id === "neighbor-b" && item.selection_reason === "dependency_neighbour"));
});

test("Codebase retrieval evaluation measures MRR and Recall@3 on a fixed bilingual query set", () => {
  const corpus = [
    symbol("login", "loginUser", "src/auth/login.ts"),
    symbol("session", "refreshUserSession", "src/auth/session.ts"),
    symbol("policy", "checkAccessPolicy", "src/access/policy.ts"),
    symbol("receipt", "resolveContextReceipt", "src/context/receipt.ts"),
    symbol("cache", "invalidateCache", "src/cache/invalidate.ts"),
    symbol("incremental", "planPythonIncremental", "src/python-incremental.ts"),
    symbol("analyzer", "analyzeTypeScript", "src/typescript-analysis.ts"),
  ];
  const cases = [
    { query: "用户登录", relevant: "login" },
    { query: "权限策略", relevant: "policy" },
    { query: "context receipt", relevant: "receipt" },
    { query: "cache invalidation", relevant: "cache" },
    { query: "Python 仓库增量重建怎么规划", relevant: "incremental" },
    { query: "TypeScript 语义检查器如何分析", relevant: "analyzer" },
  ];
  const ranks = cases.map(testCase => rankCodeSymbols(corpus, testCase.query, 5).findIndex(hit => hit.node.id === testCase.relevant) + 1);
  const mrr = ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length;
  const recallAt3 = ranks.filter(rank => rank > 0 && rank <= 3).length / ranks.length;
  assert.equal(mrr, 1);
  assert.equal(recallAt3, 1);
});

test("LSP symbol kinds normalize valid declarations and reject missing or unsupported values", () => {
  assert.equal(lspDeclarationKind(12), "function");
  assert.equal(lspDeclarationKind(5), "class");
  assert.equal(lspDeclarationKind(0), undefined);
  assert.equal(lspDeclarationKind(27), undefined);
  assert.equal(lspDeclarationKind("12"), undefined);
});
