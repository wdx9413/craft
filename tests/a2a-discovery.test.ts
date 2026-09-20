import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";

test("A2A discovery stores only untrusted HTTPS Agent Card metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-a2a-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store); const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "Research Agent", url: "https://agents.example.test/a2a", protocolVersion: "1.0", skills: [{ id: "research" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const input = { card_id: "agent", url: "https://agents.example.test" }; const found = await service.a2aAgentCardDiscover(input); const card = found.card as JsonObject; assert.equal(card.trusted, false); assert.equal(card.execution_authority, false); assert.deepEqual(card.skills, ["research"]); assert.equal((await service.a2aAgentCardDiscover(input)).idempotent, true); assert.equal((service.a2aAgentCardGet({ card_id: "agent" }).card as JsonObject).name, "Research Agent"); assert.equal((service.a2aAgentCardList({ limit: 1 }).cards as JsonObject[]).length, 1); await assert.rejects(service.a2aAgentCardDiscover({ url: "http://agents.example.test" }), /HTTPS/); globalThis.fetch = async () => new Response("no", { status: 503 }); await assert.rejects(service.a2aAgentCardDiscover({ card_id: "down", url: "https://down.example.test" }), /HTTP 503/); globalThis.fetch = async () => new Response(JSON.stringify({ name: "Simple", url: "https://simple.example.test", skills: ["search", " "] }), { status: 200 }); assert.deepEqual(((await service.a2aAgentCardDiscover({ card_id: "simple", url: "https://simple.example.test/.well-known/agent-card.json" })).card as JsonObject).skills, ["search"]); await assert.rejects(service.a2aAgentCardDiscover({ card_id: "agent", url: "https://different.example.test" }), /idempotency/); globalThis.fetch = async () => new Response(JSON.stringify({ name: "Bad", url: "http://bad.example.test" }), { status: 200 }); await assert.rejects(service.a2aAgentCardDiscover({ card_id: "bad", url: "https://bad.example.test" }), /endpoint/); globalThis.fetch = async () => new Response(JSON.stringify({ name: "Secret", url: "https://secret.example.test", note: "token=bad" }), { status: 200 }); await assert.rejects(service.a2aAgentCardDiscover({ card_id: "secret", url: "https://secret.example.test" }), /sensitive/);
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "No skills", url: "https://none.example.test" }), { status: 200 }); assert.deepEqual(((await service.a2aAgentCardDiscover({ card_id: "none", url: "https://none.example.test" })).card as JsonObject).skills, []); assert.match(String(((await service.a2aAgentCardDiscover({ url: "https://generated.example.test" })).card as JsonObject).id), /^a2a_agent_card_/); await assert.rejects(service.a2aAgentCardDiscover({ url: " " }), /url/); globalThis.fetch = async () => new Response("[]", { status: 200 }); await assert.rejects(service.a2aAgentCardDiscover({ card_id: "array", url: "https://array.example.test" }), /object/);
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "Research Agent", url: "https://agents.example.test/a2a", protocolVersion: "1.0", skills: [{ id: "research" }] }), { status: 200 }); const mcp = new McpServer(service, "full"); for (const [name, arguments_] of [["craft_a2a_agent_card_discover", input], ["craft_a2a_agent_card_get", { card_id: "agent" }], ["craft_a2a_agent_card_list", {}]] as [string, JsonObject][]) assert.equal(((await mcp.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } }))?.result as JsonObject).isError, false); assert.equal(VERSION, "0.12.34");
    // Discovered cards are untrusted metadata and must never claim verification.
    const discovery = (service.a2aAgentCardList({ limit: 1 }).cards as JsonObject[])[0]!;
    assert.equal(discovery.trusted, false);
    assert.equal(discovery.execution_authority, false);
    assert.equal("signature_verified" in discovery, false);
    // The v1 adapter records the honest signature status through its real path.
    const remote = async () => new Response(JSON.stringify({ name: "Research Agent", url: "https://agents.example.test/a2a", protocolVersion: "1.0" }), { status: 200 });
    const observed = (await service.a2aV1.discover({ endpoint: "https://agents.example.test", observation_id: "obs-honest" }, remote)).observation as JsonObject;
    assert.equal(observed.transport_observed, true);
    assert.equal(observed.signature_verified, false);
    assert.equal(observed.signature_scheme, null);
    assert.equal(observed.card_trust, "self_asserted");
    // The field that claimed a guarantee this adapter never provided is gone.
    assert.equal("verified_transport" in observed, false);
  } finally { globalThis.fetch = original; store.close(); await rm(root, { recursive: true, force: true }); }
});
