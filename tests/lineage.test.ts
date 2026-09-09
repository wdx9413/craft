import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture(name: string) {
  const root = join(tmpdir(), `craft-lineage-${name}-${process.pid}-${Date.now()}`); const project = join(root, "project"); await mkdir(project, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  const task = store.create("task", "task", { title: name, goal: "Trace every result", status: "active" });
  service.workspaceOpen({ workspace_id: "ws", name: "Workspace", root_path: project, include_paths: ["."] });
  const source = service.artifactRegister({ artifact_id: "source", kind: "dataset", name: "Source", uri: "craft://source" });
  const proof = service.evidenceRecord({ evidence_id: "proof", source_type: "program", claim: "Source transformed" });
  const workflow = service.workflowSave({ workflow_id: "transform", name: "Transform" });
  const brief = service.workObjectPut({ workspace_id: "ws", object_id: "brief", object_type: "document", name: "Brief", data: { title: "A" } }).object as JsonObject;
  const deck = service.workObjectPut({ workspace_id: "ws", object_id: "deck", object_type: "slides", name: "Deck", data: { slides: 3 } }).object as JsonObject;
  return { root, project, store, service, task, source, proof, workflow, brief, deck };
}

const ref = (record: JsonObject, kind: string, locator?: string): JsonObject => ({ kind, id: record.id, version: record.version, ...(locator ? { locator } : {}) });

test("object-level lineage is immutable, exact-versioned, traversable, and stale-aware", async () => {
  const f = await fixture("graph"); const mcp = new McpServer(f.service, "full");
  try {
    const first = await mcp.handlers.craft_lineage_record({ lineage_id: "source-to-brief", workspace_id: "ws", task_id: f.task.id,
      output: ref(f.brief, "work_object", "/title"), sources: [ref(f.source, "artifact")], transform: ref(f.workflow, "workflow"),
      actor_type: "workflow", evidence_ids: [f.proof.id], summary: "Built brief from source" });
    assert.equal((first.lineage as JsonObject).immutable, true);
    const second = await mcp.handlers.craft_lineage_record({ workspace_id: "ws", task_id: f.task.id,
      output: ref(f.deck, "work_object"), sources: [ref(f.brief, "work_object", "/title")], actor_type: "model",
      evidence_ids: [f.proof.id], summary: "Designed deck from brief" });
    assert.equal(second.idempotent, false);
    const repeated = f.service.lineageRecord({ lineage_id: "different-ignored", workspace_id: "ws", task_id: f.task.id,
      output: ref(f.deck, "work_object"), sources: [ref(f.brief, "work_object", "/title")], actor_type: "model",
      evidence_ids: [f.proof.id], summary: "Designed deck from brief" });
    assert.equal(repeated.idempotent, true); assert.equal((repeated.lineage as JsonObject).id, (second.lineage as JsonObject).id);
    const upstream = await mcp.handlers.craft_lineage_trace({ workspace_id: "ws", entity: ref(f.deck, "work_object") });
    assert.equal((upstream.edges as JsonObject[]).length, 2); assert.equal(upstream.truncated, false);
    const downstream = f.service.lineageTrace({ workspace_id: "ws", entity: ref(f.source, "artifact"), direction: "downstream", max_depth: 1 });
    assert.equal((downstream.edges as JsonObject[]).length, 1); assert.equal(downstream.truncated, true);
    const valid = await mcp.handlers.craft_lineage_verify({ lineage_id: "source-to-brief" });
    assert.equal(valid.valid, true);
    assert.equal(f.service.lineageVerify({ lineage_id: (second.lineage as JsonObject).id }).valid, true);

    const workspace = f.store.get("workspace", "ws");
    f.service.workObjectPut({ workspace_id: "ws", object_id: "brief", name: "Brief v2", data: { title: "B" }, expected_state_revision: workspace.state_revision });
    f.service.workflowSave({ workflow_id: "transform", name: "Transform v2" });
    const stale = f.service.lineageVerify({ lineage_id: "source-to-brief" });
    assert.equal(stale.valid, false); assert.equal((stale.issues as JsonObject[]).filter((item) => item.issue === "newer_version_exists").length, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("lineage rejects ambiguous scope, cycles, conflicting derivations, weak evidence, and malformed traversal", async () => {
  const f = await fixture("errors");
  const base = { workspace_id: "ws", output: ref(f.brief, "work_object"), sources: [ref(f.source, "artifact")],
    actor_type: "program", evidence_ids: [f.proof.id], summary: "derive" };
  try {
    assert.throws(() => f.service.lineageRecord({ ...base, output: [] }), /must be an object/);
    assert.throws(() => f.service.lineageRecord({ ...base, output: { kind: "unknown", id: "x", version: 1 } }), /unsupported/);
    assert.throws(() => f.service.lineageRecord({ ...base, output: { kind: "artifact", id: "source" } }), /version/);
    assert.throws(() => f.service.lineageRecord({ ...base, output: { ...ref(f.brief, "work_object"), locator: "x".repeat(513) } }), /too long/);
    assert.throws(() => f.service.lineageRecord({ ...base, sources: "bad" }), /array/);
    assert.throws(() => f.service.lineageRecord({ ...base, sources: [] }), /unique source/);
    assert.throws(() => f.service.lineageRecord({ ...base, sources: [ref(f.source, "artifact"), ref(f.source, "artifact")] }), /unique source/);
    assert.throws(() => f.service.lineageRecord({ ...base, output: ref(f.brief, "work_object"), sources: [ref(f.brief, "work_object")] }), /itself/);
    assert.throws(() => f.service.lineageRecord({ ...base, evidence_ids: [] }), /unique Evidence/);
    assert.throws(() => f.service.lineageRecord({ ...base, evidence_ids: [f.proof.id, f.proof.id] }), /unique Evidence/);
    assert.throws(() => f.service.lineageRecord({ ...base, actor_type: 3 }), /actor_type/);
    assert.throws(() => f.service.lineageRecord({ ...base, actor_type: "unknown" }), /actor_type/);
    const otherRoot = join(f.root, "other"); await mkdir(otherRoot); f.service.workspaceOpen({ workspace_id: "other", name: "Other", root_path: otherRoot, include_paths: ["."] });
    const other = f.service.workObjectPut({ workspace_id: "other", object_id: "other-object", object_type: "doc", name: "Other" }).object as JsonObject;
    assert.throws(() => f.service.lineageRecord({ ...base, sources: [ref(other, "work_object")] }), /another workspace/);
    const task2 = f.store.create("task", "task2", { title: "Other", goal: "Other", status: "active" });
    const policy2 = f.service.speculativePolicySave({ policy_id: "task2-policy", task_id: task2.id, name: "P", event_key: "e", operation: "index",
      budget_id: (f.service.budgetOpen({ budget_id: "b2", owner_type: "task", owner_id: task2.id, limits: {} }).account as JsonObject).id, estimated_resources: {} }).policy as JsonObject;
    assert.throws(() => f.service.lineageRecord({ ...base, task_id: f.task.id, sources: [ref(policy2, "speculative_policy")] }), /unsupported/);
    const trial2 = f.service.trialStart({ task_id: task2.id, subject_type: "speculative_policy", subject_id: policy2.id, subject_version: 1 });
    assert.throws(() => f.service.lineageRecord({ ...base, task_id: f.task.id, sources: [ref(trial2, "trial")] }), /another task/);

    f.service.lineageRecord({ workspace_id: "ws", output: ref(f.proof, "evidence"), sources: [{ ...ref(f.source, "artifact"), locator: null }],
      transform: ref(f.workflow, "workflow"), actor_type: "agent", evidence_ids: [f.proof.id], summary: "Agent extraction" });
    f.service.lineageRecord(base);
    assert.throws(() => f.service.lineageRecord({ ...base, sources: [ref(f.deck, "work_object")] }), /different derivation/);
    f.service.lineageRecord({ workspace_id: "ws", output: ref(f.deck, "work_object"), sources: [ref(f.brief, "work_object")],
      actor_type: "human", evidence_ids: [f.proof.id], summary: "deck" });
    const branch = f.store.create("work_object", "branch", { workspace_id: "ws", object_type: "note", name: "Branch", data: {}, depends_on: [], source_paths: [] });
    const final = f.store.create("work_object", "final", { workspace_id: "ws", object_type: "report", name: "Final", data: {}, depends_on: [], source_paths: [] });
    f.service.lineageRecord({ workspace_id: "ws", output: ref(branch, "work_object"), sources: [ref(f.source, "artifact")],
      actor_type: "program", evidence_ids: [f.proof.id], summary: "branch" });
    f.service.lineageRecord({ workspace_id: "ws", output: ref(final, "work_object"), sources: [ref(f.deck, "work_object"), ref(branch, "work_object")],
      actor_type: "program", evidence_ids: [f.proof.id], summary: "merge" });
    assert.throws(() => f.service.lineageRecord({ workspace_id: "ws", output: ref(f.source, "artifact"), sources: [ref(f.deck, "work_object")],
      actor_type: "external_system", evidence_ids: [f.proof.id], summary: "cycle" }), /cycle/);
    assert.throws(() => f.service.lineageRecord({ workspace_id: "ws", output: ref(f.source, "artifact"), sources: [ref(final, "work_object")],
      actor_type: "external_system", evidence_ids: [f.proof.id], summary: "diamond cycle" }), /cycle/);
    assert.throws(() => f.service.lineageTrace({ workspace_id: "ws", entity: ref(f.deck, "work_object"), direction: "sideways" }), /direction/);
    assert.throws(() => f.service.lineageTrace({ workspace_id: "ws", entity: ref(f.deck, "work_object"), max_depth: 21 }), /between/);
    assert.equal((f.service.lineageTrace({ workspace_id: "ws", entity: ref(f.deck, "work_object"), direction: "upstream", max_depth: 20 }).edges as JsonObject[]).length, 2);

    f.store.save("artifact", "source", { ...f.source, name: "Source v2" });
    f.store.remove("evidence", "proof");
    const briefLineage = f.store.list("lineage_edge", 10_000).find((item) => String(item.output_key).startsWith("work_object:brief:v1:")) as JsonObject;
    const broken = f.service.lineageVerify({ lineage_id: briefLineage.id });
    assert.equal(broken.valid, false); assert.deepEqual(new Set((broken.issues as JsonObject[]).map((item) => item.issue)), new Set(["newer_version_exists", "missing"]));
    f.store.remove("work_object", "brief");
    assert.equal((f.service.lineageVerify({ lineage_id: briefLineage.id }).issues as JsonObject[]).some((item) => item.issue === "missing_exact_version"), true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
