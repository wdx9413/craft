import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { craftPaths } from "../src/paths.ts";

test("service facades exercise defaults, compatibility views, and model validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-service-edge-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
    assert.equal((service.studioResourceView() as JsonObject).version, "0.12.31");
    assert.throws(() => service.studioResourceCatalogView({ kind: "unknown", limit: 1 }), /kind must be/);
    assert.deepEqual((service.studioResourceCatalogView({ kind: "memory", limit: 2 }).items as unknown[]), []);
    assert.deepEqual((service.studioResourceCatalogView({ kind: "workflows", limit: 2 }).runs as unknown[]), []);
    assert.deepEqual((service.studioResourceCatalogView({ kind: "plugins", limit: 2 }).items as unknown[]), []);
    assert.deepEqual((service.studioResourceCatalogView({ kind: "skills", limit: 2 }).items as unknown[]), []);

    const memory = service.studioMemorySave({ content: "temporary context", kind: "working" });
    assert.equal((memory.candidate as JsonObject).status, "candidate");
    const claim = service.studioKnowledgeClaimSave({ kind: "fact", content: "bounded fact" });
    assert.equal((claim.claim as JsonObject).status, "candidate");
    const workflow = service.studioWorkflowSave({ name: "placeholder" });
    assert.equal((workflow.workflow as JsonObject).lifecycle, "draft");
    const workflowFromSteps = service.studioWorkflowSave({ name: "steps", steps: [{ id: "s" }] });
    assert.equal((workflowFromSteps.workflow as JsonObject).lifecycle, "draft");
    assert.equal((service.studioWorkflowSave({ name: "bad", nodes: "nope" }).workflow as JsonObject).lifecycle, "draft");

    assert.throws(() => service.modelAdd({ id: "bad", name: "Bad", baseUrl: "ftp://model", model: "m", apiKeyEnv: "KEY" }), /http/);
    assert.throws(() => service.modelAdd({ id: "bad", name: "Bad", baseUrl: "https://model", model: "m", apiKeyEnv: "bad key" }), /environment/);
    const added = service.modelAdd({ id: "demo", name: "Demo", protocol: "anthropic", baseUrl: "https://model///", model: "m", apiKeyEnv: "DEMO_KEY", supportsTools: true });
    assert.equal((added.model as JsonObject).protocol, "anthropic");
    assert.throws(() => service.modelAdd({ id: "demo", name: "Duplicate", baseUrl: "https://model", model: "m", apiKeyEnv: "KEY" }), /already exists/);
    const updated = service.modelUpdate({ id: "demo", name: "Demo 2", protocol: "other", baseUrl: "https://model", model: "m2", apiKeyEnv: "DEMO_KEY", supportsTools: false });
    assert.equal((updated.model as JsonObject).protocol, "openai-compatible");
    assert.throws(() => service.modelUpdate({ id: "missing", name: "x", baseUrl: "https://model", model: "m", apiKeyEnv: "KEY" }), /not found/);
    assert.equal(service.modelDelete({ id: "demo" }).ok, true);
    assert.throws(() => service.modelDelete({ id: "demo" }), /not found/);

    const task = service.taskOpen({ title: "No model", goal: "exercise defaults" }).task as JsonObject;
    assert.equal(task.model_id, null);
    await assert.rejects(service.taskMessageSend({ task_id: task.id, content: "hello" }), /no selected model/);
    const unsupportedClaim = store.create("knowledge_claim", "unsupported-claim", { kind: "fact", content: "unverified", evidence_ids: [], status: "candidate" });
    assert.throws(() => service.knowledgeClaimReview({ claim_id: unsupportedClaim.id, status: "reviewed", reviewer: "r", reason: "r" }), /Evidence/);
    assert.throws(() => service.workflowSave({ name: "invalid", steps: "bad" }), /steps must be an array/);
    assert.equal((service.workflowSave({ name: "empty" }) as JsonObject).lifecycle, "draft");
    assert.equal((await service.launchGate({ payload: null })).blocked, false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
