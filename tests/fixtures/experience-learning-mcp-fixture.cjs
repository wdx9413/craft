const readline = require("node:readline");
let experienceFailuresRemaining = 1;
let knowledgeFailuresRemaining = 1;

readline.createInterface({ input: process.stdin }).on("line", line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "notifications/initialized") return;
  const toolName = request.params?.name;
  const failureMode = process.env.CRAFT_TEST_LEARNING_WORKER_FAILURES;
  const failExperience = toolName === "craft_evaluation_model_ticket_list"
    && (failureMode === "both" || failureMode === "recover_once" && experienceFailuresRemaining-- > 0);
  const failKnowledge = toolName === "craft_knowledge_source_list"
    && (failureMode === "both" || failureMode === "recover_once" && knowledgeFailuresRemaining-- > 0);
  const failKnowledgeSource = toolName === "craft_knowledge_source_ingest" && failureMode === "knowledge_source_failure";
  if (request.method === "tools/call" && (failExperience || failKnowledge || failKnowledgeSource)) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "private fixture error" }] } })}\n`);
    return;
  }
  const serverInfo = process.env.CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_INFO === "missing" ? undefined : {
    name: process.env.CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_NAME ?? "fixture",
    ...(process.env.CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_VERSION === "missing" ? {} : { version: process.env.CRAFT_TEST_LEARNING_WORKER_MCP_SERVER_VERSION ?? "1" }),
  };
  const result = request.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: {}, ...(serverInfo ? { serverInfo } : {}) }
    : request.method === "tools/call" && request.params.name === "fixture_text" ? { content: [{ type: "text", text: "{\"ok\":true}" }] }
      : request.method === "tools/call" && request.params.name === "fixture_worker_environment" ? { structuredContent: { continuous_learning: process.env.CRAFT_CONTINUOUS_LEARNING ?? null } }
      : request.method === "tools/call" && request.params.name === "fixture_invalid_text" ? { content: [{ type: "text", text: "not-json" }] }
        : request.method === "tools/call" && request.params.name === "fixture_non_text" ? { content: [{ type: "image", data: "hidden" }] }
        : request.method === "tools/call" && request.params.name === "fixture_empty" ? { content: [] }
          : request.method === "tools/call" && request.params.name === "fixture_tool_error" ? { isError: true, content: [{ type: "text", text: "fixture tool error" }] }
        : request.method === "tools/call" && request.params.name === "fixture_tool_error_empty" ? { isError: true, content: [] }
        : request.method === "tools/call" && request.params.name === "fixture_tool_error_non_array" ? { isError: true, content: "invalid" }
        : request.method === "tools/call" && request.params.name === "fixture_bad_structured" ? { structuredContent: [] }
        : request.method === "tools/call" && request.params.name === "fixture_bad_content" ? { content: "invalid" }
            : request.method === "tools/call" && request.params.name === "fixture_rpc_error" ? undefined
        : request.method === "tools/call" && request.params.name === "fixture_rpc_error_empty" ? undefined
        : request.method === "tools/call" && request.params.name === "fixture_child_exit" ? undefined
              : request.method === "tools/call" && request.params.name === "craft_experience_learning_evaluation_dispatch_list" ? { isError: false, structuredContent: { dispatches: [], count: 0 }, content: [] }
                : request.method === "tools/call" && request.params.name === "craft_knowledge_source_list" && failureMode === "knowledge_source_failure" ? { isError: false, structuredContent: { sources: [{ id: "fixture-source", status: "active", access: "read_only", trust: "verified" }] }, content: [] }
                : request.method === "tools/call" && request.params.name === "craft_knowledge_source_list" ? { isError: false, structuredContent: { sources: [] }, content: [] }
                : request.method === "tools/call" && request.params.name === "craft_learning_cycle_task_evidence_list" ? { isError: false, structuredContent: { evidence: JSON.parse(process.env.CRAFT_TEST_SESSION_EVIDENCE ?? "[]") }, content: [] }
                : request.method === "tools/call" && request.params.name === "craft_knowledge_claim_list" ? { isError: false, structuredContent: { claims: [] }, content: [] }
                : request.method === "tools/call" ? { isError: false, structuredContent: { tickets: [] }, content: [] }
                : undefined;
  if (request.method === "initialize") {
    process.stdout.write("not-json\n");
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} })}\n`);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "fixture_notification" })}\n`);
  }
  if (request.method === "tools/call" && request.params.name === "fixture_rpc_error") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "fixture rpc error" } })}\n`);
    return;
  }
  if (request.method === "tools/call" && request.params.name === "fixture_rpc_error_empty") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603 } })}\n`);
    return;
  }
  if (request.method === "tools/call" && request.params.name === "fixture_child_exit") { process.exit(7); return; }
  if (request.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    if (request.method === "initialize" && process.env.CRAFT_TEST_LEARNING_WORKER_MCP_EXIT === "after_initialize") setImmediate(() => process.exit(7));
    if (request.method === "tools/call" && process.env.CRAFT_TEST_LEARNING_WORKER_MCP_EXIT === "after_first_call") setImmediate(() => process.exit(7));
  }
});
