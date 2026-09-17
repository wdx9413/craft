import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assetDigest, assetRef, defineAsset, routeAssets, type AssetEnvelope } from "../src/assets.ts";
import { McpServer } from "../src/mcp.ts";
import { compareAcrossModels, defineTrials } from "../src/model-independence.ts";
import { defineProvider, type ChatRequest, type ChatResult, type ModelProviderSpec, type ModelTransport } from "../src/model-gateway.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { parseAction } from "../src/internal-host-driver.ts";

const spec = (): ModelProviderSpec => defineProvider({ provider: "demo", label: "Demo", protocol: "openai-compatible",
  base_url: "https://example.test/v1", api_key_env: "DEMO_API_KEY", models: { standard: "demo-std" } });
const fakeTransport: ModelTransport = { complete: async (_s: ModelProviderSpec, _r: ChatRequest): Promise<ChatResult> =>
  ({ text: "ok", model: "fake", usage: { input_tokens: 1, output_tokens: 1 } }) };

const asset = (over: JsonObject = {}): AssetEnvelope => defineAsset({
  kind: "capability", id: "cap.alpha", source: "test", trust: "verified", health: "healthy",
  effect_scope: "read_only", cost_profile: { tokens: 10, latency_ms: 5 }, tags: ["research"],
  stability: { core_invariants: ["returns_sources"] }, ...over,
});

test("an asset envelope is content addressed and validated", () => {
  const built = asset();
  assert.equal(built.digest, assetDigest(built as never));
  assert.equal(assetRef(built), "capability:cap.alpha@1");
  assert.equal(defineAsset({ kind: "workflow", id: "wf.one", source: "s", stability: { core_invariants: ["i"] } }).trust, "unverified");
  assert.throws(() => defineAsset({ kind: "nope", id: "x", source: "s", stability: { core_invariants: ["i"] } }), /Unsupported kind/);
  assert.throws(() => defineAsset({ kind: "capability", id: "bad id", source: "s", stability: { core_invariants: ["i"] } }), /Unsupported asset id/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", version: 0, source: "s", stability: { core_invariants: ["i"] } }), /positive integer/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s", stability: [] }), /stability must be an object/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s", stability: {} }), /core_invariants must not be empty/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s",
    stability: { core_invariants: ["a"], model_sensitive: ["a"] } }), /cannot be both core and model-sensitive/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s", stability: { core_invariants: ["a", "a"] } }), /must not repeat/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s", cost_profile: [], stability: { core_invariants: ["a"] } }), /cost_profile must be an object/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s", cost_profile: { tokens: -1 }, stability: { core_invariants: ["a"] } }), /cost_profile.tokens/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s", tags: "nope", stability: { core_invariants: ["a"] } }), /tags must be an array/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s", trust: "maybe", stability: { core_invariants: ["a"] } }), /Unsupported trust/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s", health: "maybe", stability: { core_invariants: ["a"] } }), /Unsupported health/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s", effect_scope: "maybe", stability: { core_invariants: ["a"] } }), /Unsupported effect_scope/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "  ", stability: { core_invariants: ["a"] } }), /source must not be empty/);
  const named = defineAsset({ kind: "capability", id: "x", source: "s", label: "L", policy: "p", version: 3,
    stability: { core_invariants: ["a"], model_sensitive: ["b"] } });
  assert.equal(named.policy, "p");
  assert.equal(named.version, 3);
  assert.deepEqual(named.stability.model_sensitive, ["b"]);
});

test("an asset envelope rejects missing optional blocks", () => {
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s" }), /core_invariants must not be empty/);
  assert.throws(() => defineAsset({ kind: "capability", id: "x", source: "s", stability: { core_invariants: [] } }), /core_invariants must not be empty/);
  const implicit = defineAsset({ kind: "capability", id: "x", source: "s", cost_profile: undefined,
    stability: { core_invariants: ["i"] } });
  assert.deepEqual(implicit.cost_profile, { tokens: 0, latency_ms: 0 });
  assert.equal(implicit.health, "unknown");
});

test("routing breaks a cost tie deterministically by reference", () => {
  const signals = { tier: "small" as const, risk: "low" as const, allowed_effects: ["read_only" as const],
    budget_tokens: 1_000, domain: null, required_tags: [] };
  const zeta = asset({ id: "cap.zeta", cost_profile: { tokens: 7, latency_ms: 7 } });
  const alpha = asset({ id: "cap.alpha2", cost_profile: { tokens: 7, latency_ms: 7 } });
  const decision = routeAssets(signals, [zeta, alpha]);
  assert.deepEqual(decision.selected.map((item) => item.id), ["cap.alpha2", "cap.zeta"]);
});

test("routing gates on trust, health, effect and invariants", () => {
  const signals = { tier: "standard" as const, risk: "low" as const, allowed_effects: ["read_only" as const],
    budget_tokens: 1_000, domain: null, required_tags: [] };
  const candidate = asset({ id: "cap.candidate", trust: "candidate" });
  const blocked = asset({ id: "cap.blocked", health: "blocked" });
  const writer = asset({ id: "cap.writer", effect_scope: "local_write" });
  const decision = routeAssets(signals, [asset({ id: "cap.alpha" }), candidate, blocked, writer]);
  assert.deepEqual(decision.selected.map((item) => item.id), ["cap.alpha"]);
  assert.equal(decision.rejected.length, 3);
  assert.ok(decision.rejected.some((item) => /trust is candidate/.test(item.reason)));
  assert.ok(decision.rejected.some((item) => /health is blocked/.test(item.reason)));
  assert.ok(decision.rejected.some((item) => /exceeds the task's allowed effects/.test(item.reason)));
  assert.match(decision.reason, /selected 1 of 4/);
  assert.equal(decision.baseline, null);
});

test("routing honours domain tags, budget and the risk ceiling", () => {
  const signals = { tier: "standard" as const, risk: "low" as const, allowed_effects: ["read_only" as const],
    budget_tokens: 100, domain: "research", required_tags: [] };
  const other = asset({ id: "cap.other", tags: ["sales"], cost_profile: { tokens: 1, latency_ms: 1 } });
  const cheap = asset({ id: "cap.cheap", tags: ["research"], cost_profile: { tokens: 5, latency_ms: 90 } });
  const fast = asset({ id: "cap.fast", tags: ["research"], cost_profile: { tokens: 5, latency_ms: 1 } });
  const rest = asset({ id: "cap.rest", tags: ["research"], cost_profile: { tokens: 5, latency_ms: 2 } });
  const extra = asset({ id: "cap.extra", tags: ["research"], cost_profile: { tokens: 5, latency_ms: 3 } });
  const tooCostly = asset({ id: "cap.huge", tags: ["research"], cost_profile: { tokens: 10_000, latency_ms: 1 } });
  const decision = routeAssets(signals, [other, cheap, fast, rest, extra, tooCostly]);
  // Cheapest first, then fastest: `fast` precedes `cheap` in the tie-break.
  assert.deepEqual(decision.selected.map((item) => item.id), ["cap.fast", "cap.rest", "cap.extra"]);
  assert.ok(decision.rejected.some((item) => /tagged for another domain/.test(item.reason)));
  assert.ok(decision.rejected.some((item) => /costs 10000 tokens with \d+ remaining/.test(item.reason)));
  assert.ok(decision.rejected.some((item) => /over the 3-asset limit/.test(item.reason)));

  const highRisk = routeAssets({ ...signals, risk: "high", required_tags: [] }, [fast, rest, extra]);
  assert.equal(highRisk.selected.length, 1);
  assert.ok(highRisk.rejected.some((item) => /over the 1-asset limit for high risk/.test(item.reason)));

  // Everything eligible but unaffordable: nothing is selected and the cheapest
  // candidate is handed back so the caller can raise the budget deliberately.
  const broke = routeAssets({ ...signals, budget_tokens: 1, required_tags: [] }, [fast]);
  assert.deepEqual(broke.selected, []);
  assert.equal(assetRef(broke.baseline as AssetEnvelope), "capability:cap.fast@1");
  assert.ok(broke.rejected.some((item) => /baseline kept/.test(item.reason)));
});

test("routing reports a required tag that matches nothing as a mismatch", () => {
  const signals = { tier: "small" as const, risk: "low" as const, allowed_effects: ["read_only" as const],
    budget_tokens: null, domain: null, required_tags: ["absent"] };
  const decision = routeAssets(signals, [asset()]);
  assert.deepEqual(decision.selected, []);
  assert.ok(decision.rejected.some((item) => /missing a required tag/.test(item.reason)));
  assert.equal(decision.baseline, null);

  const empty = routeAssets({ ...signals, required_tags: [] }, []);
  assert.deepEqual(empty.selected, []);
  assert.equal(empty.baseline, null);
  assert.match(empty.reason, /no assets were declared/);

  const noneMatch = routeAssets({ ...signals, required_tags: [] },
    [asset({ id: "cap.x", trust: "candidate" })]);
  assert.match(noneMatch.reason, /no declared asset satisfied/);
});

test("routing rejects malformed signals", () => {
  const good = { tier: "small" as const, risk: "low" as const, allowed_effects: ["read_only" as const],
    budget_tokens: null, domain: null, required_tags: [] };
  assert.throws(() => routeAssets(null as never, []), /must be an object/);
  assert.throws(() => routeAssets({ ...good, tier: "huge" } as never, []), /Unsupported task tier/);
  assert.throws(() => routeAssets({ ...good, risk: "huge" } as never, []), /Unsupported task risk/);
  assert.throws(() => routeAssets({ ...good, allowed_effects: [] } as never, []), /must declare allowed effects/);
  assert.throws(() => routeAssets({ ...good, allowed_effects: ["teleport"] } as never, []), /Unsupported allowed effect/);
  assert.throws(() => routeAssets({ ...good, budget_tokens: -1 } as never, []), /budget_tokens/);
  assert.throws(() => routeAssets({ ...good, required_tags: "x" } as never, []), /required_tags must be an array/);
});

test("cross-model comparison only verifies invariants that held everywhere", () => {
  const verified = compareAcrossModels([
    { model: "a", asset_ref: "capability:x@1", verdict: "passed", observed_invariants: ["i1", "i2"] },
    { model: "b", asset_ref: "capability:x@1", verdict: "passed", observed_invariants: ["i1", "i2"] },
  ], ["i1", "i2"]);
  assert.equal(verified.conclusion, "verified");
  assert.deepEqual(verified.models, ["a", "b"]);
  assert.deepEqual(verified.core_stable, ["i1", "i2"]);

  const split = compareAcrossModels([
    { model: "a", asset_ref: "capability:x@1", verdict: "passed", observed_invariants: ["i1", "i2"] },
    { model: "b", asset_ref: "capability:x@1", verdict: "passed", observed_invariants: ["i1"] },
  ], ["i1", "i2"]);
  assert.equal(split.conclusion, "verified");
  assert.deepEqual(split.core_stable, ["i1"]);
  assert.deepEqual(split.model_sensitive, ["i2"]);

  const single = compareAcrossModels([{ model: "a", asset_ref: "capability:x@1", verdict: "passed", observed_invariants: ["i1"] }], ["i1"]);
  assert.equal(single.conclusion, "inconclusive");
  assert.match(single.reason, /only one model/);

  const rejected = compareAcrossModels([
    { model: "a", asset_ref: "capability:x@1", verdict: "failed", observed_invariants: [] },
    { model: "b", asset_ref: "capability:x@1", verdict: "passed", observed_invariants: ["i1"] },
  ], ["i1", "i2"]);
  assert.equal(rejected.conclusion, "rejected");
  assert.equal(rejected.per_invariant.find((item) => item.invariant === "i2")?.stable, false);

  const unmet = compareAcrossModels([
    { model: "a", asset_ref: "capability:x@1", verdict: "passed", observed_invariants: ["i1"] },
    { model: "b", asset_ref: "capability:x@1", verdict: "passed", observed_invariants: ["i1"] },
  ], ["i1", "i3"]);
  assert.equal(unmet.conclusion, "inconclusive");
  assert.deepEqual(unmet.unmet, ["i3"]);
});

test("trial declaration fails closed", () => {
  assert.throws(() => defineTrials("nope"), /must be an array/);
  assert.throws(() => defineTrials([null]), /must be an object/);
  assert.throws(() => defineTrials([{ asset_ref: "a", verdict: "passed" }]), /needs a model/);
  assert.throws(() => defineTrials([{ model: "m", verdict: "passed" }]), /needs an asset_ref/);
  assert.throws(() => defineTrials([{ model: "m", asset_ref: "a", verdict: "maybe" }]), /unsupported verdict/);
  assert.throws(() => defineTrials([{ model: "m", asset_ref: "a", verdict: "passed", tokens: -1 }]), /non-negative integer/);
  assert.throws(() => defineTrials([{ model: "m", asset_ref: "a", verdict: "passed", observed_invariants: "x" }]), /must be an array/);
  assert.throws(() => defineTrials([{ model: "m", asset_ref: "a", verdict: "passed", observed_invariants: [" "] }]), /non-empty strings/);
  assert.throws(() => defineTrials([{ model: "m", asset_ref: "a", verdict: "passed", observed_invariants: ["x", "x"] }]), /must not repeat/);
  assert.deepEqual(defineTrials([{ model: "m", asset_ref: "a", verdict: "passed", tokens: 3 }])[0].tokens, 3);
  assert.throws(() => compareAcrossModels([], ["i"]), /at least one trial/);
  assert.throws(() => compareAcrossModels([{ model: "m", asset_ref: "a", verdict: "passed", observed_invariants: [] }], []), /invariants must not be empty/);
  assert.throws(() => compareAcrossModels([
    { model: "m", asset_ref: "a", verdict: "passed", observed_invariants: [] },
    { model: "m", asset_ref: "b", verdict: "passed", observed_invariants: [] },
  ], ["i"]), /mix subjects/);
});

test("the new capability surfaces are reachable over MCP and stay read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), `craft-capability-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, [], [spec()], fakeTransport);
  const server = new McpServer(service, "full");
  const call = async (name: string, args: JsonObject): Promise<JsonObject> => {
    const response = await server.handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
    const result = response?.result as JsonObject;
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent as JsonObject;
  };
  try {
    const providers = await call("craft_model_provider_list", {});
    assert.equal(providers.count, 1);
    assert.equal((providers.providers as JsonObject[])[0].provider, "demo");
    assert.equal((providers.providers as JsonObject[])[0].configured, false);

    const described = await call("craft_model_provider_get", { provider: "demo", tier: "frontier" });
    assert.equal((described.selection as JsonObject).model, "demo-std");
    assert.equal(described.transport_installed, true);
    const plain = await call("craft_model_provider_get", { provider: "demo" });
    assert.equal("selection" in plain, false);
    const unknown = await server.handle({ id: 2, method: "tools/call", params: { name: "craft_model_provider_get", arguments: { provider: "nope" } } });
    assert.equal(((unknown?.result as JsonObject).isError), true);

    const plan = await call("craft_agent_loop_plan", { limits: { max_steps: 4 } });
    assert.equal((plan.limits as JsonObject).max_steps, 4);
    assert.equal(plan.band, "green");
    assert.ok((plan.guards as string[]).includes("no_progress"));
    const defaultPlan = await call("craft_agent_loop_plan", {});
    assert.equal((defaultPlan.limits as JsonObject).max_steps, 30);

    const routed = await call("craft_asset_route", { signals: { tier: "standard", risk: "low",
      allowed_effects: ["read_only"], budget_tokens: 100, domain: null, required_tags: [] },
      assets: [{ kind: "capability", id: "cap.alpha", source: "test", trust: "verified", health: "healthy",
        effect_scope: "read_only", stability: { core_invariants: ["i"] } }] });
    assert.equal((routed.selected as JsonObject[]).length, 1);
    assert.equal((routed.selected as JsonObject[])[0].ref, "capability:cap.alpha@1");
    const missingAssets = await server.handle({ id: 3, method: "tools/call", params: { name: "craft_asset_route",
      arguments: { signals: { tier: "small", risk: "low", allowed_effects: ["read_only"], budget_tokens: null, domain: null, required_tags: [] } } } });
    assert.equal(((missingAssets?.result as JsonObject).isError), true);

    // Nothing affordable: the route hands the caller a baseline instead of a guess.
    const broke = await call("craft_asset_route", { signals: { tier: "small", risk: "low",
      allowed_effects: ["read_only"], budget_tokens: 1, domain: null, required_tags: [] },
      assets: [{ kind: "capability", id: "cap.pricey", source: "test", trust: "verified", health: "healthy",
        effect_scope: "read_only", cost_profile: { tokens: 500, latency_ms: 1 }, stability: { core_invariants: ["i"] } }] });
    assert.deepEqual(broke.selected, []);
    assert.equal(broke.baseline, "capability:cap.pricey@1");

    const independence = await call("craft_model_independence_compare", { invariants: ["i1"],
      trials: [{ model: "a", asset_ref: "capability:x@1", verdict: "passed", observed_invariants: ["i1"] },
        { model: "b", asset_ref: "capability:x@1", verdict: "passed", observed_invariants: ["i1"] }] });
    assert.equal(independence.conclusion, "verified");
    const missingInvariants = await server.handle({ id: 4, method: "tools/call", params: { name: "craft_model_independence_compare",
      arguments: { trials: [{ model: "a", asset_ref: "x", verdict: "passed", observed_invariants: [] }] } } });
    assert.equal(((missingInvariants?.result as JsonObject).isError), true);

    // The internal host is registered as a third driver alongside Codex and Claude.
    assert.ok(service.hostProfiles.some((profile) => profile.host === "codex-cli"));
    assert.equal(service.internalHost.host, "internal");
    assert.equal((await call("craft_host_profile_list", {})).profiles instanceof Array, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("the facade runs the internal host end to end with a permitted action", async () => {
  const root = await mkdtemp(join(tmpdir(), `craft-internal-e2e-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  const replies = ['{"action":"knowledge_search","args":{"query":"alpha"}}', "final answer"];
  let index = 0;
  const transport: ModelTransport = { complete: async (): Promise<ChatResult> => {
    const text = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return { text, model: "fake", usage: { input_tokens: 1, output_tokens: 1 } };
  } };
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, [], [spec()], transport);
  try {
    const task = store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    const driver = service.hostDriver("internal");
    assert.ok(driver);
    const prepared = driver.prepare({ task_id: task.id, prompt: "inspect" }) as JsonObject;
    const executed = await driver.execute({ dispatch_id: (prepared.dispatch as JsonObject).id, prompt: "inspect" }) as JsonObject;
    const receipt = executed.receipt as JsonObject;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.final_message, "final answer");
    // One loop step ran, and it ran through the facade's whitelist.
    assert.equal((receipt.loop as JsonObject).steps, 1);
    assert.equal((receipt.loop as JsonObject).last_action, "knowledge_search");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("the internal host action whitelist is enforced by the facade", async () => {
  const root = await mkdtemp(join(tmpdir(), `craft-whitelist-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, [], [spec()]);
  const invoke = (service as unknown as { invokeInternalAction: (a: string, b: JsonObject) => Promise<JsonObject> }).invokeInternalAction.bind(service);
  try {
    const task = service.taskOpen({ title: "t", goal: "g" }).task as JsonObject;
    // Every permitted action is read-and-record only; widening the list is an explicit edit.
    await invoke("capability_search", { query: "nothing" });
    await invoke("task_checkpoint", { task_id: String(task.id), summary: "point" });
    await invoke("evidence_record", { source_type: "program", confidence: "confirmed", claim: "ok" });
    await invoke("artifact_register", { artifact_id: "a1", kind: "note", name: "n", uri: "craft://a1" });
    await assert.rejects(invoke("capability_delete", {}), /not permitted/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an unknown operation with a named operation reports it in full", async () => {
  const root = await mkdtemp(join(tmpdir(), `craft-syscall-named-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  const server = new McpServer(new CraftService(store), "syscall");
  try {
    const response = await server.handle({ id: 9, method: "tools/call", params: { name: "craft_update",
      arguments: { resource: "task", operation: "nonexistent" } } });
    const result = response?.result as JsonObject;
    assert.equal(result.isError, true);
    assert.match((result.content as JsonObject[])[0].text as string, /Unknown Craft operation: task\.nonexistent/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("internal host action parser and optional bindings fail closed", () => {
  assert.equal(parseAction("plain text"), null);
  assert.equal(parseAction("{bad"), null);
  assert.equal(parseAction("[]"), null);
  assert.equal(parseAction("{\"action\":\"\"}"), null);
  assert.equal(parseAction("{\"action\":\"read\",\"args\":[]}"), null);
  assert.deepEqual(parseAction("{\"action\":\" read \"}"), { action: "read", args: {} });
});
