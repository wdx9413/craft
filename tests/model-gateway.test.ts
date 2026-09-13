import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beginLoop, budgetBand, completeLoop, defineLoopLimits, failLoop, loopSummary, observeStep } from "../src/agent-loop.ts";
import { InternalHostDriver, parseAction } from "../src/internal-host-driver.ts";
import { PROVIDER_CATALOG, buildChatRequest, credentialStatus, createFetchTransport, defineProvider, parseChatResponse,
  providerFromConfig, publicProvider, selectModel, unconfiguredTransport, type ChatRequest, type ChatResult,
  type ModelProviderSpec, type ModelTransport } from "../src/model-gateway.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

const openaiSpec = (): ModelProviderSpec => defineProvider({ provider: "demo", label: "Demo", protocol: "openai-compatible",
  base_url: "https://example.test/v1", api_key_env: "DEMO_API_KEY",
  models: { small: "demo-small", standard: "demo-std", frontier: "demo-frontier" } });
const anthropicSpec = (): ModelProviderSpec => defineProvider({ provider: "demo-anthropic", protocol: "anthropic",
  base_url: "https://example.test/v1", api_key_env: "DEMO_ANTHROPIC_KEY", models: { standard: "demo-claude" } });

test("the provider catalog declares every requested family and no secret material", () => {
  assert.deepEqual(PROVIDER_CATALOG.map((spec) => spec.provider),
    ["deepseek", "volcengine", "qwen", "kimi", "glm", "minimax", "gpt", "claude"]);
  const serialized = JSON.stringify(PROVIDER_CATALOG);
  for (const spec of PROVIDER_CATALOG) {
    assert.match(spec.api_key_env, /^[A-Z_][A-Z0-9_]*$/u);
    assert.ok(Object.keys(spec.models).length > 0);
    assert.ok(spec.base_url.startsWith("https://"));
    // The catalog must describe where a key lives, never what it is.
    assert.ok(!new RegExp(`"${spec.api_key_env}"\\s*:\\s*"(?!env)`).test(serialized));
  }
  assert.equal(PROVIDER_CATALOG.filter((spec) => spec.protocol === "anthropic").length, 1);
});

test("provider declarations fail closed on malformed input", () => {
  const base = { provider: "demo", protocol: "openai-compatible", base_url: "https://example.test/v1",
    api_key_env: "DEMO_API_KEY", models: { standard: "m" } };
  assert.throws(() => defineProvider({ ...base, provider: "Bad Name" }), /Unsupported provider name/);
  assert.throws(() => defineProvider({ ...base, protocol: "grpc" }), /Unsupported provider protocol/);
  assert.throws(() => defineProvider({ ...base, api_key_env: "lower_case" }), /uppercase environment-variable/);
  assert.throws(() => defineProvider({ ...base, models: [] }), /models must be an object/);
  assert.throws(() => defineProvider({ ...base, models: {} }), /at least one model tier/);
  assert.throws(() => defineProvider({ ...base, models: { standard: "  " } }), /models.standard/);
  assert.throws(() => defineProvider({ ...base, supports_tools: "yes" }), /supports_tools must be a boolean/);
  assert.throws(() => defineProvider({ ...base, cost_hint: -1 }), /cost_hint/);
  assert.throws(() => defineProvider({ ...base, base_url: "not a url" }), /valid HTTP\(S\) URL/);
  assert.throws(() => defineProvider({ ...base, base_url: "https://user:pass@example.test/v1" }), /without credentials/);
  assert.throws(() => defineProvider({ ...base, base_url: "https://example.test/v1?x=1" }), /without credentials/);
});

test("defaults fill in the provider label, chat path and tool support", () => {
  const spec = defineProvider({ provider: "demo", protocol: "openai-compatible", base_url: "https://example.test/v1/",
    api_key_env: "DEMO_API_KEY", models: { standard: "m" } });
  assert.equal(spec.label, "demo");
  assert.equal(spec.chat_path, "/chat/completions");
  assert.equal(spec.supports_tools, true);
  assert.equal(spec.cost_hint, 1);
  assert.equal(spec.base_url, "https://example.test/v1");
  assert.equal(anchorAnthropicPath(), "/messages");
  const declared = defineProvider({ provider: "demo", label: "Demo", protocol: "openai-compatible",
    base_url: "https://example.test/v1", api_key_env: "DEMO_API_KEY", chat_path: "/custom", models: { standard: "m" },
    supports_tools: false, cost_hint: 3 });
  assert.equal(declared.chat_path, "/custom");
  assert.equal(declared.supports_tools, false);
  assert.equal(declared.cost_hint, 3);
});
function anchorAnthropicPath(): string {
  return defineProvider({ provider: "demo", protocol: "anthropic", base_url: "https://example.test/v1",
    api_key_env: "DEMO_API_KEY", models: { standard: "m" } }).chat_path;
}

test("tier selection degrades downward and refuses an unusable provider", () => {
  assert.deepEqual(selectModel(openaiSpec(), "frontier"), { tier: "frontier", model: "demo-frontier", downgraded: false });
  assert.deepEqual(selectModel(anthropicSpec(), "frontier"), { tier: "standard", model: "demo-claude", downgraded: true });
  assert.throws(() => selectModel(openaiSpec(), "huge" as never), /Unsupported model tier/);
  const empty = { ...openaiSpec(), models: {} } as ModelProviderSpec;
  assert.throws(() => selectModel(empty, "small"), /no usable model tier/);
});

test("credential status reports the variable name and never the value", () => {
  const spec = openaiSpec();
  assert.deepEqual(credentialStatus(spec, {}), { provider: "demo", api_key_env: "DEMO_API_KEY", configured: false });
  assert.equal(credentialStatus(spec, { DEMO_API_KEY: "secret-value" }).configured, true);
  const view = publicProvider(spec, { DEMO_API_KEY: "secret-value" });
  assert.equal(view.configured, true);
  assert.equal(JSON.stringify(view).includes("secret-value"), false);
});

test("request rendering matches each wire format", () => {
  const openai = buildChatRequest(openaiSpec(), { model: "demo-std", temperature: 0,
    messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] });
  assert.equal(openai.url, "https://example.test/v1/chat/completions");
  assert.equal(openai.headers.authorization, "Bearer $DEMO_API_KEY");
  assert.deepEqual(openai.body.messages, [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);
  assert.equal(openai.body.temperature, 0);
  assert.ok(openai.prompt_tokens_estimate >= 1);

  const anthropic = buildChatRequest(anthropicSpec(), { model: "demo-claude", max_tokens: 128,
    messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object" } } }] });
  assert.equal(anthropic.url, "https://example.test/v1/messages");
  assert.equal(anthropic.headers["anthropic-version"], "2023-06-01");
  assert.equal(anthropic.body.system, "be brief");
  assert.deepEqual(anthropic.body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(anthropic.body.max_tokens, 128);
  assert.equal((anthropic.body.tools as JsonObject[])[0]!.name, "lookup");

  const noSystem = buildChatRequest(anthropicSpec(), { model: "demo-claude", messages: [{ role: "user", content: "hi" }] });
  assert.equal(noSystem.body.max_tokens, 4_096);
  assert.equal("system" in noSystem.body, false);
});

test("request rendering rejects malformed conversations", () => {
  const spec = openaiSpec();
  const build = (messages: unknown[]): ChatRequest => buildChatRequest(spec, { model: "m", messages: messages as never });
  assert.throws(() => build([]), /at least one message/);
  assert.throws(() => build([null]), /must be an object/);
  assert.deepEqual(buildChatRequest(spec, { model: "m", messages: [{ role: "tool", content: "x", tool_call_id: "call" }] }).body.messages, [{ role: "tool", content: "x", tool_call_id: "call" }]);
  assert.throws(() => build([{ role: "user", content: 1 }]), /content must be a string/);
});

test("response parsing normalizes both wire formats and fails closed", () => {
  const openai = parseChatResponse(openaiSpec(), { model: "demo-std", choices: [{ message: { content: "hello" } }],
    usage: { prompt_tokens: 3, completion_tokens: 4 } });
  assert.deepEqual(openai, { text: "hello", model: "demo-std", usage: { input_tokens: 3, output_tokens: 4 } });
  const openaiTool = parseChatResponse(openaiSpec(), { model: "demo-std", choices: [{ message: { content: null, tool_calls: [{ id: "call", function: { name: "search", arguments: { q: "x" } } }] } }] });
  assert.equal(openaiTool.tool_calls?.[0]?.function.name, "search");
  assert.equal(parseChatResponse(openaiSpec(), { choices: [{ message: { content: "x" } }] }).usage, null);

  const anthropic = parseChatResponse(anthropicSpec(), { model: "demo-claude",
    content: [{ type: "text", text: "a" }, { type: "thinking", text: "b" }, { type: "text", text: "c" }],
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 9 } });
  assert.equal(anthropic.text, "ac");
  assert.deepEqual(anthropic.usage, { input_tokens: 1, output_tokens: 2 });
  const anthropicTool = parseChatResponse(anthropicSpec(), { content: [{ type: "text", text: "go" }, { type: "tool_use", id: "a", name: "lookup", input: { q: "x" } }] });
  assert.equal(anthropicTool.tool_calls?.[0]?.function.name, "lookup");

  assert.throws(() => parseChatResponse(openaiSpec(), "nope"), /must be an object/);
  assert.throws(() => parseChatResponse(openaiSpec(), { choices: [] }), /no message content/);
  assert.throws(() => parseChatResponse(anthropicSpec(), { content: [] }), /no text block/);
});

test("provider declarations and responses tolerate every optional omission", () => {
  // No `models` key at all, so the empty default must produce a clear failure.
  assert.throws(() => defineProvider({ provider: "demo", protocol: "openai-compatible",
    base_url: "https://example.test/v1", api_key_env: "DEMO_API_KEY" }), /at least one model tier/);

  // Anthropic payloads may omit the content array, the model, text, and usage.
  assert.throws(() => parseChatResponse(anthropicSpec(), {}), /no text block/);
  assert.throws(() => parseChatResponse(anthropicSpec(), { content: [{ type: "text" }] }), /no text block/);
  const sparse = parseChatResponse(anthropicSpec(), { content: [{ type: "text", text: "hi" }] });
  assert.equal(sparse.model, null);
  assert.equal(sparse.usage, null);
  const partialUsage = parseChatResponse(anthropicSpec(), { content: [{ type: "text", text: "hi" }], usage: {} });
  assert.deepEqual(partialUsage.usage, { input_tokens: 0, output_tokens: 0 });

  // OpenAI-compatible payloads may omit choices or usage fields.
  assert.throws(() => parseChatResponse(openaiSpec(), {}), /no message content/);
  const sparseOpenai = parseChatResponse(openaiSpec(), { choices: [{ message: { content: "hi" } }], usage: {} });
  assert.equal(sparseOpenai.model, null);
  assert.deepEqual(sparseOpenai.usage, { input_tokens: 0, output_tokens: 0 });
});

test("a loop step may omit its token cost", () => {
  const limits = defineLoopLimits({ max_tokens: 100 });
  const step = observeStep(beginLoop(0), limits, { action: "a", progress_digest: "x", now: 1 });
  assert.equal(step.state.tokens_used, 0);
  assert.equal(step.halted, false);
});

test("the default transport refuses instead of pretending to run", async () => {
  await assert.rejects(unconfiguredTransport.complete(openaiSpec(), buildChatRequest(openaiSpec(), { model: "m",
    messages: [{ role: "user", content: "hi" }] })), /set DEMO_API_KEY/);
});

test("the built-in fetch transport authenticates, parses, retries, and fails closed", async () => {
  const openai = openaiSpec();
  assert.ok(createFetchTransport());
  const requests: Array<{ url: string; authorization: string | null }> = [];
  let calls = 0;
  const transport = createFetchTransport({ env: { DEMO_API_KEY: "secret" }, maxAttempts: 2, timeoutMs: 100,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") }); calls += 1;
      if (calls === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ model: "demo-std", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }), { status: 200 });
    } });
  const result = await transport.complete(openai, buildChatRequest(openai, { model: "demo-std", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(result.text, "ok"); assert.equal(calls, 2); assert.equal(requests[0].authorization, "Bearer secret");
  assert.equal(requests[1].url, "https://example.test/v1/chat/completions");

  const anthropic = anthropicSpec();
  let seenHeaders: Headers | undefined;
  const anthropicTransport = createFetchTransport({ env: { DEMO_ANTHROPIC_KEY: "a-secret" }, maxAttempts: 1,
    fetchImpl: async (_url, init) => { seenHeaders = new Headers(init?.headers); return new Response(JSON.stringify({ content: [{ type: "text", text: "hello" }] }), { status: 200 }); } });
  assert.equal((await anthropicTransport.complete(anthropic, buildChatRequest(anthropic, { model: "demo-claude", messages: [{ role: "user", content: "hi" }] }))).text, "hello");
  assert.equal(seenHeaders?.get("x-api-key"), "a-secret"); assert.equal(seenHeaders?.get("anthropic-version"), "2023-06-01");

  await assert.rejects(createFetchTransport({ env: {}, maxAttempts: 1 }).complete(openai, buildChatRequest(openai, { model: "m", messages: [{ role: "user", content: "x" }] })), /set DEMO_API_KEY/);
  await assert.rejects(createFetchTransport({ env: { DEMO_API_KEY: "x" }, maxAttempts: 1,
    fetchImpl: async () => new Response("no", { status: 400 }) }).complete(openai, buildChatRequest(openai, { model: "m", messages: [{ role: "user", content: "x" }] })), /HTTP 400/);
  await assert.rejects(createFetchTransport({ env: { DEMO_API_KEY: "x" }, maxAttempts: 1,
    fetchImpl: async () => new Response(null, { status: 400 }) }).complete(openai, buildChatRequest(openai, { model: "m", messages: [{ role: "user", content: "x" }] })), /HTTP 400$/);
  await assert.rejects(createFetchTransport({ env: { DEMO_API_KEY: "x" }, maxAttempts: 1,
    fetchImpl: async () => new Response("not-json", { status: 200 }) }).complete(openai, buildChatRequest(openai, { model: "m", messages: [{ role: "user", content: "x" }] })), /valid JSON/);
  await assert.rejects(createFetchTransport({ env: { DEMO_API_KEY: "x" }, maxAttempts: 1, maxResponseBytes: 1_024,
    fetchImpl: async () => new Response("x".repeat(2_000), { status: 200 }) }).complete(openai, buildChatRequest(openai, { model: "m", messages: [{ role: "user", content: "x" }] })), /exceeded/);
  let abortedCalls = 0;
  const retryAfterAbort = createFetchTransport({ env: { DEMO_API_KEY: "x" }, maxAttempts: 2,
    fetchImpl: async () => { abortedCalls += 1; if (abortedCalls === 1) throw new DOMException("timeout", "AbortError"); return new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }), { status: 200 }); } });
  assert.equal((await retryAfterAbort.complete(openai, buildChatRequest(openai, { model: "m", messages: [{ role: "user", content: "x" }] }))).text, "recovered");
  let retryAfterCalls = 0;
  const retryAfterTransport = createFetchTransport({ env: { DEMO_API_KEY: "x" }, maxAttempts: 2,
    fetchImpl: async () => { retryAfterCalls += 1; return retryAfterCalls === 1
      ? new Response("busy", { status: 429, headers: { "retry-after": "0.001" } })
      : new Response(JSON.stringify({ choices: [{ message: { content: "after" } }] }), { status: 200 }); } });
  assert.equal((await retryAfterTransport.complete(openai, buildChatRequest(openai, { model: "m", messages: [{ role: "user", content: "x" }] }))).text, "after");
  let invalidRetryAfterCalls = 0;
  const invalidRetryAfterTransport = createFetchTransport({ env: { DEMO_API_KEY: "x" }, maxAttempts: 2,
    fetchImpl: async () => { invalidRetryAfterCalls += 1; return invalidRetryAfterCalls === 1
      ? new Response("busy", { status: 503, headers: { "retry-after": "later" } })
      : new Response(JSON.stringify({ choices: [{ message: { content: "fallback" } }] }), { status: 200 }); } });
  assert.equal((await invalidRetryAfterTransport.complete(openai, buildChatRequest(openai, { model: "m", messages: [{ role: "user", content: "x" }] }))).text, "fallback");
  let rudeCalls = 0;
  const rudeRetry = createFetchTransport({ env: { DEMO_API_KEY: "x" }, maxAttempts: 2,
    fetchImpl: async () => { rudeCalls += 1; if (rudeCalls === 1) throw "temporary"; return new Response(JSON.stringify({ choices: [{ message: { content: "rude-recovered" } }] }), { status: 200 }); } });
  assert.equal((await rudeRetry.complete(openai, buildChatRequest(openai, { model: "m", messages: [{ role: "user", content: "x" }] }))).text, "rude-recovered");
  assert.throws(() => createFetchTransport({ timeoutMs: 99 }), /timeoutMs/);
  assert.throws(() => createFetchTransport({ maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => createFetchTransport({ maxResponseBytes: 1 }), /maxResponseBytes/);
});

test("provider config is normalized without storing a secret", () => {
  const spec = providerFromConfig({ protocol: "openai-compatible", name: "My Local Model", baseUrl: "http://localhost:9000/v1/", model: "local", apiKeyEnv: "LOCAL_KEY" });
  assert.equal(spec.provider, "my-local-model"); assert.equal(spec.base_url, "http://localhost:9000/v1"); assert.equal(spec.api_key_env, "LOCAL_KEY");
  const fallback = providerFromConfig({ protocol: "anthropic", name: "  ", baseUrl: "https://example.test/v1", model: "claude" });
  assert.equal(fallback.provider, "custom"); assert.equal(fallback.api_key_env, "CRAFT_API_KEY");
});

test("loop limits are bounded and defaults are explicit", () => {
  const limits = defineLoopLimits();
  assert.deepEqual(limits, { max_steps: 30, max_tokens: 200_000, max_wall_clock_ms: 1_800_000, no_progress_limit: 5 });
  assert.equal(defineLoopLimits({ max_steps: 3 }).max_steps, 3);
  assert.throws(() => defineLoopLimits({ max_steps: 0 }), /max_steps/);
  assert.throws(() => defineLoopLimits({ max_tokens: 0 }), /max_tokens/);
  assert.throws(() => defineLoopLimits({ max_wall_clock_ms: 10 }), /max_wall_clock_ms/);
  assert.throws(() => defineLoopLimits({ no_progress_limit: 0 }), /no_progress_limit/);
});

test("budget bands compress, downgrade and fuse before the ceiling", () => {
  const limits = defineLoopLimits({ max_tokens: 100 });
  const at = (used: number) => budgetBand({ ...beginLoop(0), tokens_used: used }, limits);
  assert.equal(at(0), "green");
  assert.equal(at(49), "green");
  assert.equal(at(60), "yellow");
  assert.equal(at(85), "red");
  assert.equal(at(96), "fuse");
});

test("each circuit breaker fires with its own reason", () => {
  const limits = defineLoopLimits({ max_steps: 2, max_tokens: 100, max_wall_clock_ms: 1_000, no_progress_limit: 2 });
  let state = beginLoop(0);

  const first = observeStep(state, limits, { action: "search", args: { q: 1 }, progress_digest: "p1", tokens: 1, now: 10 });
  assert.equal(first.halted, false);
  state = first.state;
  assert.equal(state.steps, 1);

  // A repeated identical action is a loop signal, not a retry.
  const repeated = observeStep(state, limits, { action: "search", args: { q: 1 }, progress_digest: "p2", tokens: 1, now: 20 });
  assert.equal(repeated.halt_reason, "repeated_action");

  // An unchanged progress digest needs `no_progress_limit` consecutive steps, and
  // the step ceiling must not fire first or this would measure the wrong guard.
  const patient = defineLoopLimits({ max_steps: 10, max_tokens: 100, max_wall_clock_ms: 1_000, no_progress_limit: 2 });
  const stalled = observeStep(beginLoop(0), patient, { action: "a", progress_digest: "same", tokens: 0, now: 1 });
  assert.equal(stalled.halted, false);
  const stalled2 = observeStep(stalled.state, patient, { action: "b", progress_digest: "same", tokens: 0, now: 2 });
  assert.equal(stalled2.halted, false);
  const stalled3 = observeStep(stalled2.state, patient, { action: "c", progress_digest: "same", tokens: 0, now: 3 });
  assert.equal(stalled3.halt_reason, "no_progress");

  const step1 = observeStep(beginLoop(0), limits, { action: "a", progress_digest: "x", tokens: 0, now: 1 });
  const step2 = observeStep(step1.state, limits, { action: "b", progress_digest: "y", tokens: 0, now: 2 });
  const step3 = observeStep(step2.state, limits, { action: "c", progress_digest: "z", tokens: 0, now: 3 });
  assert.equal(step3.halt_reason, "step_limit");

  const tokenLimited = observeStep(beginLoop(0), limits, { action: "a", progress_digest: "x", tokens: 101, now: 1 });
  assert.equal(tokenLimited.halt_reason, "token_limit");

  const wallClock = observeStep(beginLoop(0), limits, { action: "a", progress_digest: "x", tokens: 0, now: 5_000 });
  assert.equal(wallClock.halt_reason, "wall_clock");

  const fuse = observeStep(beginLoop(0), limits, { action: "a", progress_digest: "x", tokens: 99, now: 1 });
  assert.equal(fuse.halt_reason, "budget_fuse");
  assert.equal(fuse.band, "fuse");

  // A step that lands in the fuse band stops the loop even though no ceiling was
  // crossed: the guard is about affordability, not about hitting zero.
  const bulk = observeStep(beginLoop(0), defineLoopLimits({ max_tokens: 10_000, max_steps: 1 }), { action: "a", progress_digest: "x", tokens: 9_800, now: 1 });
  assert.equal(bulk.halted, true);
  assert.equal(bulk.halt_reason, "budget_fuse");
  assert.equal(bulk.band, "fuse");
});

test("a halted loop refuses further steps and validates observations", () => {
  const limits = defineLoopLimits({ max_tokens: 100 });
  const halted = observeStep(beginLoop(0), limits, { action: "a", progress_digest: "x", tokens: 101, now: 1 });
  assert.equal(halted.state.status, "halted");
  const again = observeStep(halted.state, limits, { action: "b", progress_digest: "y", tokens: 0, now: 2 });
  assert.equal(again.halted, true);
  assert.equal(again.halt_reason, "token_limit");
  assert.throws(() => completeLoop(halted.state, "x"), /already halted/);
  assert.throws(() => observeStep(beginLoop(0), limits, { action: "a", progress_digest: "x", tokens: -1, now: 1 }), /non-negative integer/);
});

test("loop completion and failure demand an explicit verdict", () => {
  const state = beginLoop(0);
  const completed = completeLoop(state, "task_verified");
  assert.equal(completed.status, "completed");
  assert.throws(() => completeLoop(completed, "again"), /already completed/);
  assert.throws(() => completeLoop(beginLoop(0), "  "), /must not be empty/);
  const failed = failLoop(beginLoop(0), "transport_error");
  assert.equal(failed.status, "failed");
  assert.throws(() => failLoop(failed, "again"), /already failed/);
  assert.throws(() => failLoop(beginLoop(0), ""), /must not be empty/);
  const summary = loopSummary(completed, defineLoopLimits());
  assert.equal(summary.verdict, "task_verified");
  assert.equal(summary.band, "green");
});

test("only a bare action object counts as a model action", () => {
  assert.deepEqual(parseAction('{"action":"capability_search","args":{"query":"x"}}'),
    { action: "capability_search", args: { query: "x" } });
  assert.deepEqual(parseAction('{"action":"ping"}'), { action: "ping", args: {} });
  assert.equal(parseAction("just prose"), null);
  assert.equal(parseAction("{not json}"), null);
  assert.equal(parseAction('["action"]'), null);
  assert.equal(parseAction('{"args":{}}'), null);
  assert.equal(parseAction('{"action":"  "}'), null);
  assert.equal(parseAction('{"action":"x","args":[]}'), null);
  assert.equal(parseAction('{"action":"x","args":null}'), null);
  assert.equal(parseAction('{"action":"x","args":3}'), null);
});

async function store(): Promise<{ root: string; store: CraftStore }> {
  const root = await mkdtemp(join(tmpdir(), `craft-internal-${process.pid}-`));
  const opened = await new CraftStore(craftPaths(root)).open();
  return { root, store: opened };
}

function transportOf(replies: string[]): ModelTransport {
  let index = 0;
  return { complete: async (_spec: ModelProviderSpec, _request: ChatRequest): Promise<ChatResult> => {
    const text = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return { text, model: "fake", usage: { input_tokens: 1, output_tokens: 1 } };
  } };
}

test("the internal host refuses to exist without a provider", async () => {
  const f = await store();
  try {
    assert.throws(() => new InternalHostDriver(f.store, { providers: [] }), /at least one declared provider/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the internal host prepares idempotently and validates its provider", async () => {
  const f = await store();
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
  const driver = new InternalHostDriver(f.store, { providers: [openaiSpec(), anthropicSpec()], transport: transportOf(["done"]) });
  assert.equal((driver as unknown as { receiptKind(): string }).receiptKind(), "internal_receipt");
  assert.equal((driver as unknown as { provider(name?: string): { provider: string } }).provider().provider, "demo");
    const prepared = driver.prepare({ task_id: task.id, prompt: "go", provider: "demo" }) as JsonObject;
    assert.equal((prepared.dispatch as JsonObject).model, "demo-std");
    assert.equal((prepared.credential as JsonObject).configured, false);
    assert.equal(prepared.idempotent, false);

    const replay = driver.prepare({ task_id: task.id, prompt: "go", provider: "demo", dispatch_id: (prepared.dispatch as JsonObject).id }) as JsonObject;
    assert.equal(replay.idempotent, true);
    assert.throws(() => driver.prepare({ task_id: task.id, prompt: "different",
      provider: "demo", dispatch_id: (prepared.dispatch as JsonObject).id }), /idempotency conflict/);
    assert.throws(() => driver.prepare({ task_id: task.id, prompt: "go", provider: "nope" }), /Unknown model provider/);
    assert.throws(() => driver.prepare({ task_id: "ghost", prompt: "go" }), /Unknown task/);

    // Omitting the provider falls back to the first declaration.
    const defaulted = driver.prepare({ task_id: task.id, prompt: "go", dispatch_id: "d_default" }) as JsonObject;
    assert.equal((defaulted.dispatch as JsonObject).provider, "demo");
    assert.equal((defaulted.dispatch as JsonObject).downgraded, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the internal host completes on a final message and records a receipt", async () => {
  const f = await store();
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    const driver = new InternalHostDriver(f.store, { providers: [openaiSpec()], transport: transportOf(["all done"]) });
    const prepared = driver.prepare({ task_id: task.id, prompt: "go" }) as JsonObject;
    const executed = await driver.execute({ dispatch_id: (prepared.dispatch as JsonObject).id, prompt: "go" }) as JsonObject;
    const receipt = executed.receipt as JsonObject;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.final_message, "all done");
    assert.equal((receipt.loop as JsonObject).status, "completed");
    assert.equal((receipt.loop as JsonObject).verdict, "model_final_message");
    assert.ok(String(receipt.uri).startsWith("file:"));

    const replay = await driver.execute({ dispatch_id: (prepared.dispatch as JsonObject).id, prompt: "go" }) as JsonObject;
    assert.equal(replay.idempotent, true);
    await assert.rejects(driver.execute({ dispatch_id: (prepared.dispatch as JsonObject).id, prompt: "wrong" }), /does not match the prepared digest/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the internal host invokes a whitelisted action and stops on a repeated one", async () => {
  const f = await store();
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    const replies = ['{"action":"capability_search","args":{"query":"a"}}',
      '{"action":"capability_search","args":{"query":"a"}}'];
    const driver = new InternalHostDriver(f.store, { providers: [openaiSpec()], transport: transportOf(replies),
      invokeAction: (action) => ({ ok: true, action }) });
    const prepared = driver.prepare({ task_id: task.id, prompt: "go", limits: { no_progress_limit: 9, max_steps: 9 } }) as JsonObject;
    const executed = await driver.execute({ dispatch_id: (prepared.dispatch as JsonObject).id, prompt: "go" }) as JsonObject;
    const loop = (executed.receipt as JsonObject).loop as JsonObject;
    assert.equal(loop.status, "halted");
    assert.equal(loop.halt_reason, "repeated_action");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the internal host fails closed when the transport or dispatch misbehaves", async () => {
  const f = await store();
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    const failing: ModelTransport = { complete: async () => { throw new Error("network down"); } };
    const driver = new InternalHostDriver(f.store, { providers: [openaiSpec()], transport: failing });
    const prepared = driver.prepare({ task_id: task.id, prompt: "go" }) as JsonObject;
    const executed = await driver.execute({ dispatch_id: (prepared.dispatch as JsonObject).id, prompt: "go" }) as JsonObject;
    const receipt = executed.receipt as JsonObject;
    assert.equal(receipt.status, "failed");
    assert.match(String(receipt.failure), /network down/);

    // A dispatch that is not prepared must refuse to run.
    const second = driver.prepare({ task_id: task.id, prompt: "go", dispatch_id: "d2" }) as JsonObject;
    f.store.save(driver.dispatchKind, "d2", { ...(second.dispatch as JsonObject), status: "running" });
    await assert.rejects(driver.execute({ dispatch_id: "d2", prompt: "go" }), /requires an explicit resume flag/);
    const resumed = await driver.execute({ dispatch_id: "d2", prompt: "go", resume: true }) as JsonObject;
    assert.equal(resumed.idempotent, false);
    assert.equal((resumed.dispatch as JsonObject).resumed_from, "running");

    // Any state outside the prepared/running execution boundary fails closed.
    const third = driver.prepare({ task_id: task.id, prompt: "go", dispatch_id: "d4" }) as JsonObject;
    f.store.save(driver.dispatchKind, "d4", { ...(third.dispatch as JsonObject), status: "paused" });
    await assert.rejects(driver.execute({ dispatch_id: "d4", prompt: "go" }), /is not executable/);

    // The unconfigured transport surfaces the provider's environment variable.
    const offline = new InternalHostDriver(f.store, { providers: [openaiSpec()] });
    offline.prepare({ task_id: task.id, prompt: "go", dispatch_id: "d3" });
    const offlineRun = await offline.execute({ dispatch_id: "d3", prompt: "go" }) as JsonObject;
    assert.match(String((offlineRun.receipt as JsonObject).failure), /DEMO_API_KEY/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a non-string action field is not an action", () => {
  assert.equal(parseAction('{"action":1}'), null);
});

test("the internal host validates its arguments and streams observations", async () => {
  const f = await store();
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    const driver = new InternalHostDriver(f.store, { providers: [openaiSpec()], transport: transportOf(["done"]) });
    assert.throws(() => driver.prepare({ task_id: task.id, prompt: "   " }), /prompt must not be empty/);
    assert.throws(() => driver.prepare({ task_id: "  ", prompt: "go" }), /task_id must not be empty/);

    const prepared = driver.prepare({ task_id: task.id, prompt: "go", dispatch_id: "obs" }) as JsonObject;
    const events: Array<{ bytes: number }> = [];
    const executed = await driver.execute({ dispatch_id: (prepared.dispatch as JsonObject).id, prompt: "go" },
      { observe: (event) => events.push({ bytes: event.bytes }) }) as JsonObject;
    assert.equal(events.length, 1);
    assert.ok(events[0].bytes >= 1);
    assert.ok((executed.receipt as JsonObject).status === "completed", JSON.stringify(executed.receipt));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the internal host executes normalized provider Tool Calls", async () => {
  const f = await store();
  try {
    const task = f.store.create("task", `task_tool_${process.pid}`, { title: "t", goal: "g" }); let turn = 0;
    const driver = new InternalHostDriver(f.store, { providers: [openaiSpec()], transport: { complete: async () => turn++ === 0
      ? { text: "", model: "demo", usage: { input_tokens: 1, output_tokens: 1 }, tool_calls: [{ id: "call", type: "function", function: { name: "ping", arguments: "{}" } }] }
      : { text: "done", model: "demo", usage: { input_tokens: 1, output_tokens: 1 } } }, invokeAction: (action) => ({ action, ok: true }) });
    driver.prepare({ task_id: task.id, prompt: "go", dispatch_id: "tool-call" });
    const executed = await driver.execute({ dispatch_id: "tool-call", prompt: "go" }) as JsonObject;
    assert.ok((executed.receipt as JsonObject).status === "completed", JSON.stringify(executed.receipt));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the internal host cancels and reports a non-Error transport failure", async () => {
  const f = await store();
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });

    // An abort that is already requested stops the loop instead of honouring the action.
    const actioning = new InternalHostDriver(f.store, { providers: [openaiSpec()],
      transport: transportOf(['{"action":"anything"}']), invokeAction: () => ({ ok: true }) });
    actioning.prepare({ task_id: task.id, prompt: "go", dispatch_id: "abort" });
    const controller = new AbortController();
    controller.abort();
    const aborted = await actioning.execute({ dispatch_id: "abort", prompt: "go" }, { signal: controller.signal }) as JsonObject;
    assert.equal((aborted.receipt as JsonObject).status, "failed");
    assert.equal(((aborted.receipt as JsonObject).loop as JsonObject).verdict, "cancelled");

    // A transport that rejects with a string must still produce a receipt.
    const rude = new InternalHostDriver(f.store, { providers: [openaiSpec()],
      transport: { complete: async () => { throw "rude failure"; } } as never });
    rude.prepare({ task_id: task.id, prompt: "go", dispatch_id: "rude" });
    const rudeRun = await rude.execute({ dispatch_id: "rude", prompt: "go" }) as JsonObject;
    assert.equal(((rudeRun.receipt as JsonObject).loop as JsonObject).halt_reason, null);
    assert.equal((rudeRun.receipt as JsonObject).failure, "Internal host failed");

    // A completion without usage still runs and simply costs nothing to account.
    const noUsage: ModelTransport = { complete: async () => ({ text: "plain", model: null, usage: null }) };
    const lean = new InternalHostDriver(f.store, { providers: [openaiSpec()], transport: noUsage });
    lean.prepare({ task_id: task.id, prompt: "go", dispatch_id: "lean" });
    const leanRun = await lean.execute({ dispatch_id: "lean", prompt: "go" }) as JsonObject;
    assert.equal(((leanRun.receipt as JsonObject).loop as JsonObject).tokens_used, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("the internal host redacts credentials from a final message", async () => {
  const f = await store();
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    const driver = new InternalHostDriver(f.store, { providers: [openaiSpec()],
      transport: transportOf(["api_key: super-secret-token"]) });
    driver.prepare({ task_id: task.id, prompt: "go", dispatch_id: "d1" });
    const executed = await driver.execute({ dispatch_id: "d1", prompt: "go" }) as JsonObject;
    assert.equal((executed.receipt as JsonObject).final_message, "[redacted]");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
