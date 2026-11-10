import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { saveSettingsSync } from "../core/settings.ts";
import type { ModelTransport } from "../core/model-gateway.ts";

function transportReturning(text: string): ModelTransport {
  return { complete: async () => ({ text, model: "fake-pilot", usage: { input_tokens: 1, output_tokens: 1 } }) };
}

async function fixture(transport: ModelTransport) {
  const root = await mkdtemp(join(tmpdir(), "craft-pilot-model-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  saveSettingsSync({ models: [{ id: "pilot-model", name: "Pilot", protocol: "openai-compatible",
    baseUrl: "https://pilot.test/v1", model: "pilot-1", apiKeyEnv: "PILOT_KEY", supportsTools: false }] }, store.paths);
  // modelTransport is the ninth constructor argument.
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, transport);
  const session = (service.pilotSessionOpen({ input: "split me" }) as JsonObject).session as JsonObject;
  return { root, store, service, sessionId: String(session.id) };
}

test("the pilot model split goes through intake validation and creates ordinary tasks", async () => {
  const f = await fixture(transportReturning('```json\n{"tasks":[{"title":"A","goal":"do a","executor_template":"craft-internal","reason":"local","confidence":0.8},{"title":"B","goal":"do b"}]}\n```'));
  try {
    const result = await f.service.pilotTurnWithModel({ session_id: f.sessionId, input: "do a and b", model_id: "pilot-model" }) as JsonObject;
    assert.equal(result.status, "created");
    assert.equal(result.tasks_created, 2);
    assert.equal(result.model, "fake-pilot");
    const routes = (f.service.pilotSessionGet({ session_id: f.sessionId }) as JsonObject).routes as JsonObject[];
    assert.equal(routes.length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("model questions block the turn without creating tasks", async () => {
  const f = await fixture(transportReturning('{"tasks":[],"questions":["用哪个工作区？"]}'));
  try {
    const result = await f.service.pilotTurnWithModel({ session_id: f.sessionId, input: "ambiguous", model_id: "pilot-model" }) as JsonObject;
    assert.equal(result.status, "blocked");
    assert.equal(result.tasks_created, 0);
    assert.equal(f.store.list("task", 10).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("model output that is not a usable JSON split is refused", async () => {
  const f = await fixture(transportReturning("I cannot help with that."));
  try {
    await assert.rejects(() => f.service.pilotTurnWithModel({ session_id: f.sessionId, input: "x", model_id: "pilot-model" }), /JSON object/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an unconfigured pilot model is refused before any model call", async () => {
  let called = 0;
  const transport: ModelTransport = { complete: async () => { called += 1; return { text: "{}", model: "x", usage: { input_tokens: 0, output_tokens: 0 } }; } };
  const f = await fixture(transport);
  try {
    await assert.rejects(() => f.service.pilotTurnWithModel({ session_id: f.sessionId, input: "x", model_id: "missing" }), /not configured/);
    assert.equal(called, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
