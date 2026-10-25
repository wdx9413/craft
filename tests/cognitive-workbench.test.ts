import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CognitiveWorkbenchCoordinator } from "../core/application/coordinators/cognitive-workbench.ts";
import { workbenchWorkflowInput } from "../core/application/use-cases/workbench-workflow-input.ts";

test("Workbench cognition delegates governed writes and preserves all legacy input defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-cognitive-workbench-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const registrations: JsonObject[] = []; const evidence: JsonObject[] = [];
  const coordinator = new CognitiveWorkbenchCoordinator({ store, resourceCatalog: (args) => ({ catalog: args }),
    registerSource: (args) => { registrations.push(args); return store.create("knowledge_source", String(args.source_id), {
      ...args, scope: { kind: args.scope_kind, id: args.scope_id },
    }); },
    proposeMemory: (args) => args,
    recordEvidence: (args) => { evidence.push(args); return { id: "evidence" }; }, saveClaim: (args) => args,
  });
  try {
    assert.deepEqual(coordinator.resources({ kind: "memory" }), { catalog: { kind: "memory" } });
    store.create("knowledge_claim", "claim", { scope: "global", status: "candidate" });
    assert.equal(((coordinator.resources().resources as JsonObject).claims as JsonObject[]).length, 1);
    assert.equal(((coordinator.resources({ limit: 1 }).resources as JsonObject).wiki as JsonObject[]).length, 0);
    const memory = coordinator.saveMemory({ content: "bounded proposal" });
    assert.equal(memory.kind, "episodic"); assert.equal(memory.scope_kind, "user"); assert.equal(memory.scope_id, "local");
    assert.equal(memory.source_id, "studio-local-source"); assert.equal(registrations.length, 1);
    coordinator.saveMemory({ kind: "invalid", scope: "project" }); assert.equal(registrations.length, 1);
    const project = coordinator.saveMemory({ source_id: "other", kind: "preference", scope_kind: "project", scope_id: "project" });
    assert.equal(project.kind, "preference"); assert.equal(project.scope_kind, "project"); assert.equal(project.scope_id, "project");
    assert.throws(() => coordinator.saveClaim({}), /scope/u);
    assert.equal(evidence.length, 0, "an invalid scope must not leave orphan Evidence");
    assert.deepEqual(coordinator.saveClaim({ scope: "global" }), { scope: "global", evidence_ids: ["evidence"] });
    assert.deepEqual(coordinator.saveClaim({ evidence_ids: ["known"], scope: "project:p" }), { evidence_ids: ["known"], scope: "project:p" });
    assert.deepEqual(coordinator.saveClaim({ scope: "global", evidence_ids: null }).evidence_ids, [undefined]); assert.equal(evidence.length, 1);
    assert.deepEqual((workbenchWorkflowInput({}).nodes as JsonObject[])[0], { id: "studio-placeholder", type: "action", side_effect: "read_only", action: "noop", depends_on: [] });
    assert.equal((workbenchWorkflowInput({ nodes: [] }).nodes as JsonObject[])[0].id, "studio-placeholder");
    const nodes = [{ id: "provided" }]; assert.equal(workbenchWorkflowInput({ nodes }).nodes, nodes);
    assert.deepEqual(workbenchWorkflowInput({ steps: [{}, { id: "custom", type: "check", side_effect: "local_write", action: "verify", depends_on: ["step-1"] }] }).nodes,
      [{ id: "step-1", type: "action", side_effect: "read_only", depends_on: [] }, { id: "custom", type: "check", side_effect: "local_write", action: "verify", depends_on: ["step-1"] }]);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Workbench Knowledge rolls back its owned Evidence when Claim persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-workbench-knowledge-rollback-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const coordinator = new CognitiveWorkbenchCoordinator({
    store, resourceCatalog: () => ({}), registerSource: () => ({}), proposeMemory: () => ({}),
    recordEvidence: (args) => store.create("evidence", "workbench-rollback-evidence", args),
    saveClaim: () => { throw new Error("claim rejected after evidence staging"); },
  });
  try {
    assert.throws(() => coordinator.saveClaim({ scope: "global" }), /claim rejected/u);
    assert.equal(store.find("evidence", "workbench-rollback-evidence"), null);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
