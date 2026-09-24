import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

test("service facades exercise defaults, compatibility views, and model validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-service-edge-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  try {
  assert.equal((service.workbenchResourceView() as JsonObject).version, "0.12.37");
    assert.throws(() => service.workbenchResourceCatalogView({ kind: "unknown", limit: 1 }), /kind must be/);
    assert.deepEqual((service.workbenchResourceCatalogView({ kind: "memory", limit: 2 }).items as unknown[]), []);
    assert.deepEqual((service.workbenchResourceCatalogView({ kind: "workflows", limit: 2 }).runs as unknown[]), []);
    assert.deepEqual((service.workbenchResourceCatalogView({ kind: "plugins", limit: 2 }).items as unknown[]), []);
    assert.deepEqual((service.workbenchResourceCatalogView({ kind: "skills", limit: 2 }).items as unknown[]), []);

    const memory = service.workbenchMemorySave({ content: "temporary context", kind: "working" });
    assert.equal((memory.candidate as JsonObject).status, "candidate");
    const claim = service.workbenchKnowledgeClaimSave({ kind: "fact", content: "bounded fact" });
    assert.equal((claim.claim as JsonObject).status, "candidate");
    const reviewSource = service.knowledgeSourceRegister({ source_id: "studio-review-source", kind: "custom", label: "studio review", scope_kind: "project", scope_id: "studio", locator: "offline://studio", content_digest: "sha256:studio", trust: "bounded", access: "read_only" }).source as JsonObject;
    const explicitEvidence = store.create("evidence", "studio-evidence", { source_id: reviewSource.id, source_type: "human", confidence: "bounded", claim: "checked" });
    assert.equal((service.workbenchKnowledgeClaimSave({ kind: "fact", content: "evidence bound", evidence_ids: [explicitEvidence.id] }).claim as JsonObject).status, "candidate");
    const workflow = service.workbenchWorkflowSave({ name: "placeholder" });
    assert.equal((workflow.workflow as JsonObject).lifecycle, "draft");
    const workflowFromSteps = service.workbenchWorkflowSave({ name: "steps", steps: [{ id: "s" }] });
    assert.equal((workflowFromSteps.workflow as JsonObject).lifecycle, "draft");
    assert.equal((service.workbenchWorkflowSave({ name: "bad", nodes: "nope" }).workflow as JsonObject).lifecycle, "draft");
    assert.equal((service.workbenchWorkflowSave({ name: "nodes", nodes: [{ id: "n", type: "action", side_effect: "read_only", depends_on: [] }] }).workflow as JsonObject).lifecycle, "draft");

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
    const expiring = store.create("knowledge_claim", "expiring", { kind: "fact", content: "old", evidence_ids: [explicitEvidence.id], status: "reviewed", valid_until: "2000-01-01T00:00:00.000Z" });
    assert.equal((service.knowledgeExpirySweep({ now: "2030-01-01T00:00:00.000Z" }).expired as JsonObject[]).some((item) => item.id === expiring.id), true);
    assert.throws(() => service.knowledgeExpirySweep({ now: "invalid" }), /ISO/);
    const conflict = store.create("knowledge_claim", "conflict-claim", { source_id: reviewSource.id, kind: "fact", content: "conflict", evidence_ids: [explicitEvidence.id], status: "candidate" });
    assert.equal((service.knowledgeConflictResolve({ claim_id: conflict.id, decision: "reviewed", reviewer: "reviewer", reason: "checked" }).claim as JsonObject).status, "reviewed");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
