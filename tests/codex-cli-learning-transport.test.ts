import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { CodexCliModelTransport, createLearningModelTransport } from "../deploy/experience-learning/codex-cli-transport.ts";
import type { HostExecutionRequest, HostExecutionResult } from "../core/host-driver.ts";
import type { ChatRequest, ModelProviderSpec } from "../core/model-gateway.ts";
import { buildChatRequest } from "../core/model-gateway.ts";

const provider: ModelProviderSpec = { provider: "codex-cli", label: "Codex CLI Host", protocol: "openai-compatible",
  base_url: "https://codex-cli-host.invalid", api_key_env: "CODEX_CLI_AUTH_STORE", chat_path: "/host/exec",
  models: { small: "gpt-6-luna" }, cost_hint: 1, supports_tools: false, host_managed_auth: true };
const request: ChatRequest = { url: "https://codex-cli-host.invalid/host/exec", headers: {},
  body: { model: "gpt-6-luna", messages: [{ role: "system", content: "Return JSON." }, { role: "user", content: "{}" }] },
  prompt_tokens_estimate: 10, context_cache: { mode: "none", eligible: false, prefix_message_count: 0, prefix_digest: null, reason: null } };
const success = (message = "{\"decision\":\"unclassified\"}"): HostExecutionResult => ({
  exitCode: 0, signal: null, stderr: "", timedOut: false, outputLimited: false,
  stdout: [JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } })].join("\n"),
});

test("Codex CLI transport uses fixed model, isolated read-only ephemeral invocation and one call budget", async () => {
  let observed: HostExecutionRequest | undefined;
  const transport = new CodexCliModelTransport(async value => { observed = value; return success(); });
  assert.equal(transport.acquireCall("other"), false);
  assert.equal(transport.acquireCall("codex-cli"), true);
  assert.equal(transport.acquireCall("codex-cli"), false);
  const result = await transport.complete(provider, request);
  assert.equal(result.text, "{\"decision\":\"unclassified\"}");
  assert.deepEqual(result.usage, { input_tokens: 9, output_tokens: 4 });
  assert.equal(result.model, "gpt-6-luna");
  assert.equal(observed?.executable, "codex");
  assert.equal(observed?.cwd, tmpdir());
  assert.equal(observed?.timeoutMs, 120_000);
  assert.equal(observed?.outputLimit, 65_536);
  assert.deepEqual(observed?.argv, ["exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-c", "skills.max_context_tokens=1", "-c", "features.shell_tool=false", "-c", "features.view_image=false", "-c", 'web_search="disabled"', "--model", "gpt-6-luna", "--json", "-"]);
  assert.match(observed?.stdin ?? "", /## system\nReturn JSON\./u);
  assert.match(observed?.stdin ?? "", /## user\n\{\}/u);
});

test("Codex CLI transport supplies a bounded output schema through a private temporary file and removes it", async () => {
  const schema = { type: "object", properties: { decision: { type: "string", enum: ["supported", "needs_evidence", "rejected"] } },
    required: ["decision"], additionalProperties: false };
  let schemaPath = "";
  const transport = new CodexCliModelTransport(async value => {
    const option = value.argv.indexOf("--output-schema");
    assert.notEqual(option, -1);
    schemaPath = value.argv[option + 1]!;
    assert.deepEqual(JSON.parse(await readFile(schemaPath, "utf8")), schema);
    return success();
  });
  const withSchema = { ...request, body: { ...request.body, codex_output_schema: schema } };
  await transport.complete(provider, withSchema);
  assert.match(schemaPath, /craft-learning-schema-[^/]+\/output-schema\.json$/u);
  await assert.rejects(readFile(schemaPath, "utf8"));
});

test("Codex CLI transport removes the temporary schema when Host execution fails", async () => {
  let schemaPath = "";
  const transport = new CodexCliModelTransport(async value => {
    schemaPath = value.argv[value.argv.indexOf("--output-schema") + 1]!;
    throw new Error("Host execution failed");
  });
  await assert.rejects(transport.complete(provider, { ...request, body: { ...request.body, codex_output_schema: { type: "object" } } }), /Host execution failed/u);
  await assert.rejects(readFile(schemaPath, "utf8"));
});

test("Codex CLI transport rejects malformed and oversized output schemas before spawning", async () => {
  let calls = 0;
  const transport = new CodexCliModelTransport(async () => { calls += 1; return success(); });
  for (const schema of ["bad", [], { type: "array" }]) {
    await assert.rejects(transport.complete(provider, { ...request, body: { ...request.body, codex_output_schema: schema } }), /output schema must be an object schema/u);
  }
  await assert.rejects(transport.complete(provider, { ...request, body: { ...request.body,
    codex_output_schema: { type: "object", description: "x".repeat(16_384) } } }), /output schema exceeds its bound/u);
  assert.equal(calls, 0);
});

test("Codex CLI transport returns no usage when CLI omits usage metadata", async () => {
  const raw = JSON.parse(success().stdout.split("\n").at(-1)!) as Record<string, unknown>;
  delete raw.usage;
  const result = await new CodexCliModelTransport(async () => ({ ...success(), stdout: [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }), JSON.stringify(raw),
  ].join("\n") })).complete(provider, request);
  assert.equal(result.usage, null);
});

test("Codex CLI transport rejects an incompatible provider and non-fixed model", async () => {
  const transport = new CodexCliModelTransport(async () => success());
  await assert.rejects(transport.complete({ ...provider, provider: "qwen" }, request), /incompatible provider/u);
  await assert.rejects(transport.complete(provider, { ...request, body: { ...request.body, model: "other" } }), /must be gpt-6-luna/u);
});

test("Codex CLI transport validates bounded text messages before spawning", async () => {
  let count = 0;
  const transport = new CodexCliModelTransport(async () => { count += 1; return success(); });
  for (const body of [
    {}, { messages: [] }, { messages: ["bad"] }, { messages: [{}] }, { messages: [{ role: "user" }] },
    { messages: [{ role: "tool", content: "x" }] },
  ]) await assert.rejects(transport.complete(provider, { ...request, body: { model: "gpt-6-luna", ...body } }));
  assert.equal(count, 0);
});

test("Codex CLI transport rejects incomplete, malformed, failed, truncated, timed out and cancelled turns", async () => {
  const cases: Array<{ name: string; result: HostExecutionResult }> = [
    { name: "spawn exit", result: { ...success(), exitCode: 1 } },
    { name: "signal", result: { ...success(), signal: "SIGTERM" } },
    { name: "timeout", result: { ...success(), timedOut: true } },
    { name: "cancel", result: { ...success(), cancelled: true } },
    { name: "limited", result: { ...success(), outputLimited: true } },
    { name: "malformed JSON", result: { ...success(), stdout: "not-json" } },
    { name: "non-object JSON", result: { ...success(), stdout: "[]" } },
    { name: "turn failed", result: { ...success(), stdout: `${success().stdout}\n${JSON.stringify({ type: "turn.failed" })}` } },
    { name: "no terminal", result: { ...success(), stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }) } },
    { name: "trailing event", result: { ...success(), stdout: `${success().stdout}\n${JSON.stringify({ type: "other" })}` } },
    { name: "no message", result: { ...success(), stdout: JSON.stringify({ type: "turn.completed" }) } },
    { name: "duplicate terminal", result: { ...success(), stdout: `${success().stdout}\n${JSON.stringify({ type: "turn.completed" })}` } },
  ];
  for (const item of cases) {
    await assert.rejects(new CodexCliModelTransport(async () => item.result).complete(provider, request), /Codex Host/u, item.name);
  }
  await assert.rejects(new CodexCliModelTransport(async () => { throw new Error("ENOENT"); }).complete(provider, request), /ENOENT/u);
});

test("learning transport is opt-in and shares one call budget across Host and API profiles", () => {
  assert.equal(createLearningModelTransport(undefined), undefined);
  const transport = createLearningModelTransport("codex-cli", async () => success());
  assert(transport);
  assert.equal(transport.acquireCall?.("qwen"), true);
  assert.equal(transport.acquireCall?.("codex-cli"), false);
  assert.equal(transport.acquireCall?.("another"), false);
});

test("Codex learning input is bounded before execution without truncating evidence", async () => {
  let executions = 0;
  const executor = async () => { executions++; return success(); };
  for (const max_input_tokens of [0, -1, 1.5, 32_769, Number.NaN]) {
    assert.throws(() => new CodexCliModelTransport(executor, { max_input_tokens }), /max_input_tokens/u);
  }
  const transport = new CodexCliModelTransport(executor, { max_input_tokens: 50 });
  await assert.rejects(transport.complete(provider, { ...request, body: { ...request.body,
    messages: [{ role: "user", content: "必须保留的证据。".repeat(100) }] } }),
    (error: NodeJS.ErrnoException) => error.code === "ERR_CODEX_INPUT_BUDGET_EXCEEDED");
  assert.equal(executions, 0);
  await transport.complete(provider, request);
  assert.equal(executions, 1);
});

test("Codex model-only tasks reject tool activity even when a final answer follows", async () => {
  for (const type of ["command_execution", "mcp_tool_call", "web_search", "file_change", "unknown_tool"]) {
    const event = JSON.stringify({ type: "item.started", item: { type } });
    await assert.rejects(new CodexCliModelTransport(async () => ({ ...success(), stdout: event + "\n" + success().stdout })).complete(provider, request),
      (error: NodeJS.ErrnoException) => error.code === "ERR_CODEX_HOST_RESPONSE_INVALID");
  }
  const event = JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "internal reasoning" } });
  assert.equal((await new CodexCliModelTransport(async () => ({ ...success(), stdout: event + "\n" + success().stdout })).complete(provider, request)).model, "gpt-6-luna");
});

test("learning transport routes Codex Host and API profiles through their correct transports", async t => {
  const oldKey = process.env.CRAFT_CODEX_LEARNING_TRANSPORT_TEST_KEY;
  process.env.CRAFT_CODEX_LEARNING_TRANSPORT_TEST_KEY = "test-only";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "api-result" } }] }), { status: 200 }));
  try {
    const transport = createLearningModelTransport("codex-cli", async () => success());
    assert(transport);
    const apiProvider: ModelProviderSpec = { provider: "test-api", label: "test", protocol: "openai-compatible", base_url: "https://api.invalid/v1",
      api_key_env: "CRAFT_CODEX_LEARNING_TRANSPORT_TEST_KEY", chat_path: "/chat/completions", models: { standard: "test-model" }, cost_hint: 1, supports_tools: false };
    const apiRequest = buildChatRequest(apiProvider, { model: "test-model", messages: [{ role: "user", content: "hello" }] });
    assert.equal(transport.acquireCall?.("test-api"), true);
    assert.equal((await transport.complete(apiProvider, apiRequest)).text, "api-result");

    const hostTransport = createLearningModelTransport("codex-cli", async () => success());
    assert(hostTransport);
    assert.equal(hostTransport.acquireCall?.("codex-cli"), true);
    assert.equal((await hostTransport.complete(provider, request)).text, "{\"decision\":\"unclassified\"}");
    assert(new CodexCliModelTransport());
  } finally {
    if (oldKey === undefined) delete process.env.CRAFT_CODEX_LEARNING_TRANSPORT_TEST_KEY;
    else process.env.CRAFT_CODEX_LEARNING_TRANSPORT_TEST_KEY = oldKey;
  }
});


test("Codex catalog omission notice is accepted while configuration and other errors remain fatal", async () => {
  const notice = "Exceeded skills context budget. All skill descriptions were removed and 94 additional skills were not included in the model-visible skills list.";
  const withItem = (item: unknown, type = "item.completed") => ({ ...success(), stdout: JSON.stringify({ type, item }) + "\n" + success().stdout });
  const result = await new CodexCliModelTransport(async () => withItem({ type: "error", message: notice })).complete(provider, request);
  assert.equal(result.model, "gpt-6-luna");
  assert.deepEqual(result.usage, { input_tokens: 9, output_tokens: 4 });
  for (const item of [{ type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." },
    { type: "error", message: notice + " Extra error." }, { type: "error", message: "Model request failed" },
    { type: "error" }, { type: "error", message: null }, { type: "unknown_tool", message: notice }]) {
    await assert.rejects(new CodexCliModelTransport(async () => withItem(item)).complete(provider, request),
      (error: NodeJS.ErrnoException) => error.code === "ERR_CODEX_HOST_RESPONSE_INVALID");
  }
  await assert.rejects(new CodexCliModelTransport(async () => withItem({ type: "error", message: notice }, "item.started")).complete(provider, request));
});
